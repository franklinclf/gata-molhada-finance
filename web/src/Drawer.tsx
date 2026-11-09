import { useState } from 'preact/hooks';
import { Button } from './ds.tsx';
import { api } from './api.ts';
import { ApiError } from './api.ts';
import type { CategoryRow, TransactionDetail } from './api.ts';
import { brl, dayMonth, foreignMoney, localDay, monthName } from './format.ts';
import { accountName, cardName, inSource, sourceLabel, theSource } from './names.ts';
import { useLoad } from './hooks.ts';
import { navigate, patchParams } from './router.ts';
import { CopyButton } from './copy.tsx';
import { CategorySelect } from './CategorySelect.tsx';
import { partyRuleApplies, partyRuleConditions, partyRuleName } from './party-rule.ts';
import { ManualForm } from './ManualForm.tsx';
import { Select } from './Select.tsx';
import { Loading, StatusBadge } from './ui.tsx';
import { SLOT_LABEL } from './installments.tsx';
import type { ComponentChildren } from 'preact';

type Detail = TransactionDetail;

/** Runs a change, shows the one error place if it fails, and leaves the reload to the app (every change reloads what is on screen). */
function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, failure = 'Não foi possível salvar.'): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}
type Act = ReturnType<typeof useAction>;

/** A labelled control, the same in every section of the drawer. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="field">
      <span class="muted">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </div>
  );
}

const RECURRENCE_LABEL: Record<string, string> = { subscription: 'assinatura', recurring: 'conta recorrente', none: 'não recorrente' };
const ORIGIN: Record<string, string> = { source: 'da fonte', override: 'escolhida por você', rule: 'regra para esta descrição', ai: 'sugerida pela IA' };


/** Installment of a card purchase, when the source does not say. */
function InstallmentField({ id, d, act }: { id: string; d: Detail; act: Act }) {
  const [number, setNumber] = useState(String(d.transaction.installment?.number ?? ''));
  const [total, setTotal] = useState(String(d.transaction.installment?.total ?? ''));
  const changed = number !== String(d.transaction.installment?.number ?? '') || total !== String(d.transaction.installment?.total ?? '');
  return (
    <Field label={`Parcela${d.installmentByUser ? ' (informada por você)' : ''}`} hint={d.transaction.installment ? undefined : 'Se for parcelada, informe: o app passa a contar as próximas faturas.'}>
      <div class="inline-inputs">
        <input inputMode="numeric" placeholder="Atual" aria-label="Número da parcela" value={number} onInput={(e) => setNumber((e.currentTarget as HTMLInputElement).value)} />
        <span class="muted">de</span>
        <input inputMode="numeric" placeholder="Total" aria-label="Total de parcelas" value={total} onInput={(e) => setTotal((e.currentTarget as HTMLInputElement).value)} />
        {changed && number !== '' && total !== '' && (
          <button class="primary small" disabled={act.busy} onClick={() => void act.run(() => api.setInstallment(id, Number(number), Number(total)))}>
            Salvar
          </button>
        )}
        {d.installmentByUser && !changed && (
          <button class="link" disabled={act.busy} onClick={() => void act.run(() => api.setInstallment(id, null, null))}>
            Remover
          </button>
        )}
      </div>
    </Field>
  );
}

/** Longest name the server takes (`MAX_TRANSACTION_NAME`). */
const MAX_NAME = 60;

/**
 * The owner's own name for the transaction, shown in the lists in place of the standard one. The bank text stays as it is, and
 * rules and the AI go on reading it. On an installment the name is the purchase's, and the app adds the counter.
 */
function NameField({ id, current, installment, act }: { id: string; current: string | null; installment: { number: number; total: number } | null; act: Act }) {
  const [value, setValue] = useState(current ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const typed = value.replace(/\s+/g, ' ').trim();
  const canSave = typed !== '' && typed !== (current ?? '');
  const save = async (name: string | null) => {
    setSaved(null);
    if (!(await act.run(() => api.setName(id, name)))) return;
    if (name === null) {
      setValue('');
      setSaved('Nome removido. Volta o nome padrão.');
    } else {
      setValue(name);
      setSaved(installment ? 'Nome salvo em todas as parcelas desta compra.' : 'Nome salvo.');
    }
  };
  const hint = installment ? `Vale para todas as parcelas; o contador (${installment.number}/${installment.total}) é automático.` : 'Aparece nas listas no lugar do nome padrão. O texto do banco continua guardado e é o que as regras usam.';
  return (
    <Field label="Nome personalizado" hint={saved ?? hint}>
      <div class="inline-inputs">
        <input
          class="wide"
          maxLength={MAX_NAME}
          placeholder={installment ? 'Ex.: Notebook novo' : 'Ex.: Presente de aniversário'}
          aria-label="Nome personalizado"
          value={value}
          onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && canSave && void save(typed)}
        />
        {canSave && (
          <button class="primary small" disabled={act.busy} onClick={() => void save(typed)}>
            Salvar
          </button>
        )}
        {current !== null && (
          <button class="link" disabled={act.busy} onClick={() => void save(null)}>
            Limpar
          </button>
        )}
      </div>
    </Field>
  );
}

/** Fewer characters than this in a merchant key make "Assinatura ou recorrente" ask before it marks every charge with that key. */
const MIN_RECURRING_KEY = 4;

/** Everything the owner can fix about this one transaction, as one grid of the same kind of control. */
function Corrections({ id, d, manual, act }: { id: string; d: Detail; manual: boolean; act: Act }) {
  const r = d.recurrence;
  const detected = r.detected ? (r.detectedLabel === 'subscription' ? 'o app detectou assinatura' : 'o app detectou conta recorrente') : 'o app não detectou';
  const cycleLabel = (c: { key: string; from: string; to: string; dueDate: string }) => `Vence ${dayMonth(c.dueDate)}/${c.dueDate.slice(0, 4)} (${dayMonth(c.from)} a ${dayMonth(c.to)})`;
  const card = d.account.kind === 'credit_card';
  const rev = d.reversal;
  const credit = d.transaction.amount > 0;
  // A very short key ("99") also matches charges that have nothing to do with this one.
  const shortKey = r.name.length < MIN_RECURRING_KEY;
  const markRecurring = (value: string) => {
    if (value !== '' && value !== 'none' && shortKey && !window.confirm(`A chave desta cobrança tem só ${r.name.length} ${r.name.length === 1 ? 'caractere' : 'caracteres'} (“${r.name}”) e vale para toda cobrança com esse nome, mesmo de outro estabelecimento. Marcar mesmo assim?`)) return;
    void act.run(() => api.markRecurring(r.key, value === '' ? null : (value as 'subscription' | 'recurring' | 'none')));
  };
  return (
    <div class="dsec">
      <h3>Corrigir</h3>
      <div class="correct">
        {!manual && <NameField key={id} id={id} current={d.transaction.customName} installment={d.transaction.installment} act={act} />}
        {!manual && (
          <Field label={`Status${d.statusByUser ? ' (definido por você)' : ''}`} hint={d.statusByUser ? undefined : d.statusByBill ? 'A fonte ainda diz pendente, mas a fatura desta compra já fechou.' : `A fonte diz: ${d.transaction.status === 'pending' ? 'pendente' : 'lançada'}.`}>
            <Select
              ariaLabel="Status da transação"
              value={d.statusByUser ? d.transaction.status : ''}
              emptyLabel="Como a fonte diz"
              options={[{ value: 'pending', label: 'Pendente' }, { value: 'posted', label: 'Lançada' }]}
              onChange={(value) => void act.run(() => api.setStatus(id, value === '' ? null : (value as 'pending' | 'posted')))}
            />
          </Field>
        )}
        {!manual && d.cycleOptions.length > 0 && (
          <Field label={`Fatura${d.cycleByUser ? ' (movida por você)' : d.cycleByBank ? ' (definida pelo banco)' : ''}`}>
            <Select
              ariaLabel="Fatura da compra"
              value={d.cycleByUser && d.cycle ? d.cycle.key : ''}
              emptyLabel={d.cycleByBank ? 'Como o banco diz' : 'Pela data da compra'}
              options={d.cycleOptions.map((c) => ({ value: c.key, label: cycleLabel(c) }))}
              onChange={(value) => void act.run(() => api.setCycle(id, value === '' ? null : value))}
            />
          </Field>
        )}
        <Field label="Assinatura ou recorrente" hint={`${detected.charAt(0).toUpperCase()}${detected.slice(1)}. Vale para todas as cobranças de “${d.transaction.customName !== null ? d.transaction.description : d.transaction.title}” (chave “${r.name}”).${shortKey ? ' A chave é curta e pode pegar cobranças de outros lugares.' : ''}`}>
          <Select
            ariaLabel="Recorrência"
            value={r.label ?? ''}
            emptyLabel="Automático"
            options={[{ value: 'subscription', label: 'Assinatura (streaming, app, plano)' }, { value: 'recurring', label: 'Conta recorrente (aluguel, internet)' }, { value: 'none', label: 'Não é recorrente' }]}
            onChange={markRecurring}
          />
        </Field>
        {!manual && (rev || d.reversalCandidates.length > 0) && (
          <Field label={credit ? 'Este crédito é estorno de' : 'Esta compra foi estornada por'} hint={rev ? `${rev.byUser ? 'Definido por você' : 'O app achou sozinho'}${rev.partial ? ' · estorno parcial' : ''}` : undefined}>
            <Select
              ariaLabel="Estorno"
              value={rev?.other?.id ?? ''}
              emptyLabel={rev ? 'Não é estorno' : 'Nenhum'}
              options={[...(rev?.other && !d.reversalCandidates.some((c) => c.id === rev.other!.id) ? [rev.other] : []), ...d.reversalCandidates].map((c) => ({ value: c.id, label: `${dayMonth(c.day)} · ${c.title} · ${brl(c.amount)}` }))}
              onChange={(value) => void act.run(() => api.setReversal(id, value === '' ? null : value))}
            />
          </Field>
        )}
        {!manual && card && d.transaction.amount < 0 && <InstallmentField key={`${d.transaction.installment?.number}/${d.transaction.installment?.total}`} id={id} d={d} act={act} />}
      </div>
    </div>
  );
}

/** Categories already given to this description, most common first, apart from the one it has now. */
function suggestionsFor(d: Detail): string[] {
  const seen = new Map<string, number>();
  for (const r of d.merchant.recent) if (r.category !== null && r.category !== d.transaction.category) seen.set(r.category, (seen.get(r.category) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** The category, set in one step: pick or create, and it is saved. */
function CategorySection({ id, d, manual, act }: { id: string; d: Detail; manual: boolean; act: Act }) {
  const categories = useLoad(() => api.categories(), []);
  const [similar, setSimilar] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The category just saved for this transaction alone, while others share its description: offered once more as a rule for all of them.
  const [followUp, setFollowUp] = useState<string | null>(null);
  const t = d.transaction;
  // The count includes this transaction unless it is left out of the totals.
  const others = Math.max(0, d.merchant.count - (t.excluded ? 0 : 1));
  const save = async (category: string | null, apply = false) => {
    setSaved(null);
    setFollowUp(null);
    if (await act.run(() => api.setCategory(id, category, apply))) {
      setSimilar(false);
      if (category === null) setSaved(d.rule !== null ? 'Voltou à regra desta descrição, que continua valendo para as outras. Para tirar a regra, use “Remover a regra”.' : 'Voltou à categoria da fonte.');
      else if (apply) setSaved(`Categoria salva também nas ${others} com a mesma descrição e nas próximas.`);
      else {
        setSaved('Categoria salva só nesta transação.');
        if (others > 0) setFollowUp(category);
      }
    }
  };
  const pick = (category: string) => {
    if (category.trim() === '') return;
    // Choosing the category it already has would only turn the source's word into the owner's, with nothing changed.
    if (category === t.category && !similar) {
      setSaved('Já está nesta categoria.');
      setFollowUp(others > 0 && d.rule?.category !== category ? category : null);
      return;
    }
    void save(category, similar);
  };
  const removeRule = async () => {
    setSaved(null);
    setFollowUp(null);
    if (await act.run(() => api.deleteRule(d.merchant.key))) setSaved('Regra removida. A categoria voltou à da fonte.');
  };
  const ask = async () => {
    setAiNote(null);
    await act.run(async () => {
      const r = await api.runAi({ scope: 'transaction', transactionId: id });
      const why = { rule: 'Uma regra ou escolha sua já decide a categoria.', role: 'O tipo desta transação vem de fatos da fonte, sem IA.', person: 'Pix para pessoa é transferência, sem IA.', unknown: 'Descrição não encontrada.' };
      if (r.entry) setAiNote(`IA: ${r.entry.category} (confiança ${{ high: 'alta', medium: 'média', low: 'baixa' }[r.entry.confidence]}). ${r.entry.status === 'applied' ? 'Aplicada.' : r.entry.status === 'suggested' ? 'Aceite em Ajustes, aba IA.' : 'Fraca demais para aplicar.'}`);
      else setAiNote(r.skipped ? why[r.skipped] : r.stoppedBy === 'budget' ? 'O orçamento de IA do mês acabou.' : 'A IA não respondeu. Tente de novo.');
    }, 'Não foi possível perguntar à IA.');
  };
  // A typed-in transaction has no source, so "da fonte" says nothing about it.
  const origin = manual && t.categoryOrigin === 'source' ? null : ORIGIN[t.categoryOrigin];
  return (
    <div class="dsec">
      <h3>Categoria</h3>
      <div class="row-head">
        <span>
          <strong>{t.category ?? 'Sem categoria'}</strong> {origin && <span class="muted">· {origin}</span>}
        </span>
        <Button size="sm" disabled={act.busy} onClick={() => void ask()} title="Pergunta de novo à IA sobre a descrição desta transação">
          Perguntar à IA
        </Button>
      </div>
      {t.categoryOrigin !== 'source' && t.sourceCategory !== null && <div class="hint">A fonte diz: {t.sourceCategory}</div>}
      {aiNote && <div class="hint" role="status">{aiNote}</div>}
      {saved && <div class="hint" role="status">{saved}</div>}
      <CategorySelect value="" onChange={pick} categories={categories.data?.items} suggested={suggestionsFor(d)} placeholder="Trocar a categoria..." />
      {followUp !== null && others > 0 && (
        <div class="actions">
          <Button size="sm" disabled={act.busy} onClick={() => void save(followUp, true)} title="Cria uma regra para esta descrição: vale para as que já existem e para as próximas">
            Aplicar também às {others} com a mesma descrição
          </Button>
        </div>
      )}
      {/* While the follow-up button is shown the choice is already made, so a box to tick before choosing would do nothing. */}
      {others > 0 && followUp === null && (
        <label class="check">
          <input type="checkbox" checked={similar} onChange={(e) => setSimilar((e.currentTarget as HTMLInputElement).checked)} />
          Ao escolher, aplicar também às {others} com a descrição “{t.description}”
        </label>
      )}
      {partyRuleApplies(t) && <PartyRule key={t.counterparty!.name} d={d} categories={categories.data?.items} act={act} onSaved={setSaved} />}
      {t.categoryOrigin === 'rule' && d.rule !== null && (
        <button class="link" disabled={act.busy} onClick={() => void removeRule()} title="Apaga a regra desta descrição; vale para todas as que a usam">
          Remover a regra desta descrição (afeta as {d.merchant.count}, com esta)
        </button>
      )}
      {t.categoryOrigin === 'rule' && d.rule === null && (
        <button
          class="link"
          onClick={() => {
            patchParams({ tx: null });
            navigate('settings', { tab: 'rules' });
          }}
        >
          Vem de uma regra criada em Ajustes. Abrir a aba Regras
        </button>
      )}
      {t.categoryOrigin === 'override' && (
        <button class="link" disabled={act.busy} onClick={() => void save(null)}>
          {d.rule !== null ? 'Voltar à regra desta descrição' : 'Voltar à categoria da fonte'}
        </button>
      )}
    </div>
  );
}

/** A rule on the person or company of a Pix or TED: the bank text carries the name, so "same description" would catch one transaction only. */
function PartyRule({ d, categories, act, onSaved }: { d: Detail; categories: readonly CategoryRow[] | undefined; act: Act; onSaved: (message: string) => void }) {
  const t = d.transaction;
  const name = t.counterparty!.name!.trim();
  const direction = t.amount < 0 ? 'out' : 'in';
  const preview = useLoad(() => api.previewRule(partyRuleConditions(name, direction), ''), [name, direction], undefined, 'party-rule-preview');
  const count = preview.data?.matched;
  const create = async (category: string) => {
    if (category.trim() === '') return;
    const ok = await act.run(async () => {
      try {
        await api.saveRule({ name: partyRuleName(name, direction), active: true, conditions: partyRuleConditions(name, direction), actions: { category } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) throw new Error(`Já existe uma regra “${partyRuleName(name, direction)}”. Edite-a em Ajustes, aba Regras.`);
        throw e;
      }
    });
    if (ok) onSaved(`Regra criada: as transferências ${direction === 'out' ? 'para' : 'de'} ${name} vão para “${category}”, as que já existem e as próximas. Uma escolha sua para uma transação sozinha continua valendo.`);
  };
  return (
    <Field label={`Criar regra para todas as transferências ${direction === 'out' ? 'para' : 'de'} ${name}${count === undefined ? '' : ` (${count})`}`} hint="Vale para o nome, qualquer que seja o texto do banco.">
      <CategorySelect value="" onChange={(category) => void create(category)} categories={categories} ariaLabel="Categoria da regra" placeholder="Escolher a categoria da regra..." />
    </Field>
  );
}

function Mapping({ id, hidden, d, onChange }: { id: string; hidden: boolean; d: Detail; onChange: (closes: boolean) => void }) {
  const [picking, setPicking] = useState(false);
  const [dupes, setDupes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useLoad(() => (picking ? api.candidates(id) : Promise.resolve(null)), [picking, id]);
  const duplicates = useLoad(() => (dupes ? api.duplicates(id) : Promise.resolve(null)), [dupes, id]);
  // Joining or separating rebuilds the transaction under a new id, so the panel closes instead of showing a stale one.
  const run = async (work: () => Promise<unknown>, closes = false) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setPicking(false);
      setDupes(false);
      onChange(closes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  };
  const ignored = d.transaction.state === 'ignored';
  return (
    <>
      <div class="muted">
        {d.transaction.sourceIds.length > 1 ? `Vista ${d.transaction.sourceIds.map(inSource).join(' e ')}.` : `Só ${theSource(d.transaction.sourceIds[0] ?? '')} tem esta transação. Isso é normal e não afeta os totais.`}
      </div>
      <div class="links">
        {d.joinedByHand && (
          <button class="link" disabled={busy} onClick={() => void run(() => api.separate(id), true)}>
            {d.joinedBy === 'ai' ? 'A IA juntou estes dois. Separar (ela errou)' : 'Separar o que juntei'}
          </button>
        )}
        {d.transaction.sourceIds.length === 1 && !ignored && (
          <button class="link" disabled={busy} onClick={() => setPicking(!picking)}>
            {picking ? 'Cancelar' : 'Juntar com outra transação'}
          </button>
        )}
        {!ignored && (
          <button class="link" disabled={busy} onClick={() => setDupes(!dupes)}>
            {dupes ? 'Cancelar' : 'É cópia de outra transação'}
          </button>
        )}
        <button class="link" disabled={busy} onClick={() => void run(() => api.setIgnored(id, !ignored))}>
          {ignored ? 'Voltar a considerar nos totais' : 'Ignorar (tirar dos totais)'}
        </button>
      </div>
      {dupes && (
        <div class="candidates">
          {!duplicates.data ? (
            <Loading error={duplicates.error} />
          ) : duplicates.data.items.length === 0 ? (
            <div class="muted">Nenhuma outra transação desta conta com o mesmo valor em até 5 dias.</div>
          ) : (
            <>
              <div class="muted">Escolha a original. Esta transação sai dos totais e a escolhida continua.</div>
              <ul class="rows">
                {duplicates.data.items.map((c) => (
                  <li key={c.id}>
                    <div class="grow">
                      <div class="clip">{c.description}</div>
                      <div class="muted">
                        {dayMonth(localDay(c.occurredAt))} · {c.status === 'pending' ? 'pendente' : 'lançada'} · {c.daysApart === 0 ? 'mesmo dia' : `${c.daysApart} dia(s) de diferença`}
                      </div>
                    </div>
                    <strong>{brl(c.amount, hidden)}</strong>
                    <button class="primary small" disabled={busy} onClick={() => void run(() => api.setIgnored(id, true))}>
                      Esta é a cópia
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {picking && (
        <div class="candidates">
          {!candidates.data ? (
            <Loading error={candidates.error} />
          ) : candidates.data.items.length === 0 ? (
            <div class="muted">Nenhuma transação de outra fonte, nesta conta, em até 10 dias.</div>
          ) : (
            <ul class="rows">
              {candidates.data.items.map((c) => (
                <li key={c.id}>
                  <div class="grow">
                    <div class="clip">{c.description}</div>
                    <div class="muted">
                      {dayMonth(localDay(c.occurredAt))} · {c.sourceIds.map(sourceLabel).join(', ')} · {c.daysApart === 0 ? 'mesmo dia' : `${c.daysApart} dia(s) de diferença`}
                      {c.amount === d.transaction.amount ? ' · mesmo valor' : ''}
                    </div>
                  </div>
                  <strong>{brl(c.amount, hidden)}</strong>
                  <button class="primary small" disabled={busy} onClick={() => void run(() => api.join(id, c.id), true)}>
                    Juntar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div class="error">{error}</div>}
    </>
  );
}


function Chips({ d, manual }: { d: Detail; manual: boolean }) {
  const t = d.transaction;
  return (
    <div class="chips">
      <span class={`badge ${t.status === 'pending' ? 'warn' : 'muted'}`}>{t.status === 'pending' ? 'Pendente' : 'Lançada'}</span>
      {t.installment && <span class="badge">Parcela {t.installment.number}/{t.installment.total}</span>}
      {d.cycle && (
        <span class="badge">
          Fatura {dayMonth(d.cycle.dueDate)} <StatusBadge status={d.cycle.status} />
        </span>
      )}
      {d.reversal && <span class="badge good">{d.reversal.side === 'charge' ? (d.reversal.partial ? 'Estorno parcial' : 'Estornada') : 'Estorno'}</span>}
      {d.recurrence.label && d.recurrence.label !== 'none' && <span class="badge info">{RECURRENCE_LABEL[d.recurrence.label]}</span>}
      {manual && <span class="badge">Digitada por você</span>}
      {t.state === 'ignored' && <span class="badge bad">Ignorada</span>}
      {t.excluded && t.state !== 'ignored' && <span class="badge bad" data-tip="Pendente antiga que só uma fonte vê">Fora dos totais</span>}
      {t.state === 'conflict' && <span class="badge warn">Fontes discordam</span>}
    </div>
  );
}

/**
 * Everything else with this description. It asks the same search the "see all" link opens, so the count and the total are those of the list
 * the link leads to (the installment number is left out of the search, because every installment of a purchase is the same shop).
 */
function SameDescription({ d, hidden }: { d: Detail; hidden: boolean }) {
  const text = d.transaction.description.replace(/\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, '').trim();
  const found = useLoad(() => api.explore(new URLSearchParams({ q: text, limit: '6' })), [text]);
  const r = found.data;
  return (
    <details>
      <summary>Neste estabelecimento ({r ? `${r.total} · ${brl(r.sums.net, hidden)}` : '…'})</summary>
      {r && r.items.length > 0 && <div class="hint">Última em {dayMonth(localDay(r.items[0]!.occurredAt))}/{localDay(r.items[0]!.occurredAt).slice(0, 4)}</div>}
      <ul class="rows">
        {r?.items.map((t) => (
          <li key={t.id}>
            <span class="grow">
              {dayMonth(localDay(t.occurredAt))}/{localDay(t.occurredAt).slice(0, 4)} · {t.category ?? 'Sem categoria'}
            </span>
            <button class="link" onClick={() => patchParams({ tx: t.id })}>
              {brl(t.amount, hidden)}
            </button>
          </li>
        ))}
      </ul>
      <button
        class="link"
        onClick={() => {
          patchParams({ tx: null });
          navigate('transactions', { q: text });
        }}
      >
        Ver todas deste estabelecimento
      </button>
    </details>
  );
}

/** Side panel with what is known about one transaction and the few things the owner may want to change. */
/** An installment the bank bills but never listed: shown as a transaction for analyses. Only the name of its purchase can be changed here. */
function EstimatedDrawer({ id, hidden }: { id: string; hidden: boolean }) {
  const detail = useLoad(() => api.estimatedDetail(id), [id]);
  const act = useAction();
  const close = () => patchParams({ tx: null });
  const d = detail.data;
  return (
    <div class="overlay" onClick={close}>
      <div class="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Detalhes da parcela estimada">
        <div class="sheet-handle" aria-hidden="true" />
        <button class="x close" onClick={close} aria-label="Fechar">
          ×
        </button>
        {!d ? (
          <Loading error={detail.error} />
        ) : (
          <>
            <div>
              <h2>{d.transaction.customName !== null ? d.transaction.title : d.transaction.description}</h2>
              <div class="muted">Parcela estimada{d.transaction.customName !== null ? ` · Banco: ${d.transaction.description}` : ''}</div>
            </div>
            <div class="big">{brl(d.transaction.amount, hidden)}</div>
            <div class="chips">
              <span class="badge info">estimada</span>
              {d.transaction.status === 'pending' && <span class="badge">fatura que ainda não chegou</span>}
            </div>
            <p>
              O banco cobra esta parcela na fatura, mas não a listou como transação. O app a calcula contando os meses a partir das parcelas desta compra que ele viu. A parcela já está no total da fatura; aqui ela aparece só para que as análises por transação não a deixem de fora. Se o banco passar a listá-la, esta linha deixa de existir. Por ser uma estimativa, não dá para mudar a categoria nem ignorar. O nome personalizado vale para a compra toda.
            </p>
            {act.error && <div class="error" role="alert">{act.error}</div>}
            <NameField key={id} id={id} current={d.purchase.customName} installment={d.transaction.installment} act={act} />
            <dl class="facts">
              <dt>Compra</dt>
              <dd>
                {d.purchase.customName ?? d.purchase.description}
                {d.purchase.customName !== null && <span class="hint"> · banco: {d.purchase.description}</span>}
              </dd>
              <dt>Parcela</dt>
              <dd>
                {d.number} de {d.purchase.total} · {brl(d.purchase.amount, hidden)} cada
              </dd>
              <dt>Data estimada</dt>
              <dd>
                {dayMonth(localDay(d.transaction.occurredAt))}/{localDay(d.transaction.occurredAt).slice(0, 4)}
              </dd>
              <dt>Cartão</dt>
              <dd>
                {cardName(d.account.institution, d.account.name)}
                {d.account.last4 ? ` •••• ${d.account.last4}` : ''}
              </dd>
              <dt>Categoria</dt>
              <dd>{d.transaction.category ?? 'Sem categoria'} (a das parcelas listadas da compra)</dd>
              {d.cycle && (
                <>
                  <dt>Fatura</dt>
                  <dd>
                    vence em {dayMonth(d.cycle.dueDate)}/{d.cycle.dueDate.slice(0, 4)}
                  </dd>
                </>
              )}
            </dl>
            <details open>
              <summary>Parcelas desta compra ({d.purchase.slots.length})</summary>
              <ul class="rows">
                {d.purchase.slots.map((s) => (
                  <li key={s.number} class={s.number === d.number ? 'on' : ''}>
                    <span class="grow">
                      {s.number} de {d.purchase.total} · fatura de {monthName(s.cycle)}
                    </span>
                    <span class="muted">{s.inferred ? 'estimada' : 'listada'} · {SLOT_LABEL[s.status]}</span>
                  </li>
                ))}
              </ul>
            </details>
            {d.cycle && (
              <button
                class="link"
                onClick={() => {
                  patchParams({ tx: null });
                  navigate('transactions', { accountId: d.account.id, cycle: d.cycle!.key });
                }}
              >
                Ver a fatura de {monthName(d.cycle.key)} deste cartão
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function TransactionDrawer({ id, hidden }: { id: string; hidden: boolean }) {
  return id.startsWith('est_') ? <EstimatedDrawer id={id} hidden={hidden} /> : <RecordDrawer id={id} hidden={hidden} />;
}

function RecordDrawer({ id, hidden }: { id: string; hidden: boolean }) {
  const detail = useLoad(() => api.detail(id), [id]);
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const close = () => patchParams({ tx: null });
  const d = detail.data;
  const manual = /^man_\d+$/.test(id);

  return (
    <div class="overlay" onClick={close}>
      <div class="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Detalhes da transação">
        <div class="sheet-handle" aria-hidden="true" />
        <button class="x close" onClick={close} aria-label="Fechar">
          ×
        </button>
        {!d ? (
          <Loading error={detail.error} />
        ) : (
          <>
            <div>
              <h2>
                {d.transaction.title}
                <CopyButton value={d.transaction.description} label="Copiar descrição" />
              </h2>
              {!manual && d.transaction.title !== d.transaction.description && <div class="muted clip">Banco: {d.transaction.description}</div>}
            </div>
            <div class={`big ${d.transaction.amount >= 0 ? 'good-text' : ''}${d.reversal?.side === 'charge' && !d.reversal.partial ? ' struck' : ''}`}>
              {brl(d.transaction.amount, hidden)}
              {!hidden && <CopyButton value={(Math.abs(d.transaction.amount) / 100).toFixed(2).replace('.', ',')} label="Copiar valor" />}
            </div>
            <Chips d={d} manual={manual} />
            <dl class="facts">
              <dt>Data</dt>
              <dd>{dayMonth(localDay(d.transaction.occurredAt))}/{localDay(d.transaction.occurredAt).slice(0, 4)}</dd>
              <dt>Conta</dt>
              <dd>
                {d.account.kind === 'credit_card' ? cardName(d.account.institution, d.account.name) : `${d.account.institution} · ${accountName(d.account.institution, d.account.name, d.account.kind)}`}
                {d.account.last4 ? ` •••• ${d.account.last4}` : ''}
                {d.account.last4 && <CopyButton value={d.account.last4} label="Copiar final do cartão" />}
              </dd>
              {d.transaction.counterparty && (
                <>
                  <dt>{d.transaction.amount < 0 ? 'Para' : 'De'}</dt>
                  <dd>
                    {d.transaction.counterparty.name ?? 'Nome não informado'}
                    {d.transaction.counterparty.last4 ? ` · doc. final ${d.transaction.counterparty.last4}` : ''}
                    {d.transaction.counterparty.isOwner ? ' · você mesmo' : ''}
                  </dd>
                </>
              )}
              {d.transaction.foreign && (
                <>
                  <dt>Valor original</dt>
                  <dd>
                    {hidden ? '••••' : foreignMoney(d.transaction.foreign.amount, d.transaction.foreign.currency)}
                    <span class="hint"> {d.transaction.foreign.converted ? '· cobrado em reais pelo banco' : '· sem conversão'}</span>
                  </dd>
                </>
              )}
            </dl>
            {act.error && <div class="error" role="alert">{act.error}</div>}

            <CategorySection key={id} id={id} d={d} manual={manual} act={act} />
            <Corrections id={id} d={d} manual={manual} act={act} />

            {manual && (
              <div class="dsec">
                <h3>Digitada por você</h3>
                {editing ? (
                  <ManualForm
                    now={new Date()}
                    initial={{ id, accountId: d.account.id, day: localDay(d.transaction.occurredAt), amount: d.transaction.amount, description: d.transaction.description, category: d.transaction.category ?? '' }}
                    onSaved={() => setEditing(false)}
                    onCancel={() => setEditing(false)}
                  />
                ) : (
                  <div class="links">
                    <button class="link" onClick={() => setEditing(true)}>
                      Editar
                    </button>
                    <button class="link" onClick={() => window.confirm('Excluir esta transação?') && void act.run(() => api.deleteManual(id).then(() => patchParams({ tx: null })), 'Não foi possível excluir.')}>
                      Excluir
                    </button>
                  </div>
                )}
              </div>
            )}

            {d.installments.length > 1 && (
              <details>
                <summary>Parcelas desta compra ({d.installments.length})</summary>
                <ul class="rows">
                  {d.installments.map((i) => (
                    <li key={i.id} class={i.id === id ? 'on' : ''}>
                      <span class="grow">
                        {i.number} de {i.total} · {dayMonth(i.day)}/{i.day.slice(0, 4)}
                      </span>
                      <button class="link" onClick={() => patchParams({ tx: i.id })}>
                        {brl(i.amount, hidden)}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <SameDescription d={d} hidden={hidden} />

            {!manual && (
              <details>
                <summary>Fontes e vínculos ({d.transaction.sourceIds.map(sourceLabel).join(', ')})</summary>
                <Mapping id={id} hidden={hidden} d={d} onChange={(closes) => closes && patchParams({ tx: null })} />
                {d.sources.map((s) => (
                  <div class="source" key={`${s.sourceId}${s.externalId}`}>
                    <strong>{sourceLabel(s.sourceId)}</strong>
                    {s.record ? (
                      <dl class="facts">
                        {s.record.descriptionRaw && s.record.descriptionRaw !== s.record.description && (
                          <>
                            <dt>Original</dt>
                            <dd>
                              {s.record.descriptionRaw}
                              <CopyButton value={s.record.descriptionRaw} label="Copiar texto original" />
                            </dd>
                          </>
                        )}
                        <dt>Categoria</dt>
                        <dd>{s.record.category ?? 'Sem categoria'}</dd>
                        <dt>Valor</dt>
                        <dd>{brl(s.record.amount, hidden)}</dd>
                        <dt>Vista desde</dt>
                        <dd>{s.record.firstSeenAt.slice(0, 10)}</dd>
                      </dl>
                    ) : (
                      <div class="muted">Registro não está mais nos dados da fonte.</div>
                    )}
                  </div>
                ))}
                {d.findings.length > 0 && (
                  <>
                    <h3>Divergências</h3>
                    <ul class="rows">
                      {d.findings.map((f) => (
                        <li key={f.id}>{f.summary}</li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            )}

            {d.cycle && (
              <button
                class="link"
                onClick={() => {
                  patchParams({ tx: null });
                  navigate('transactions', { accountId: d.account.id, cycle: d.cycle!.key });
                }}
              >
                Ver a fatura de {monthName(d.cycle.key)} deste cartão
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
