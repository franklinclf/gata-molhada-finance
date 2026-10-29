import { useState } from 'preact/hooks';
import { api, ApiError } from '../api.ts';
import type { CategoryRow, RuleConditions, RulePreview, RuleRow } from '../api.ts';
import { CategorySelect } from '../CategorySelect.tsx';
import { Select } from '../Select.tsx';
import { brl, dayMonth } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Loading } from '../ui.tsx';

type Leaf = { field: string; operator: string; value: string | number };
type Group = { match: 'all' | 'any'; leaves: Leaf[] };
type Item = Leaf | Group;

const isGroup = (item: Item): item is Group => 'leaves' in item;

const TEXT_OPS: Array<[string, string]> = [['contains', 'contém'], ['not_contains', 'não contém'], ['equals', 'é igual a'], ['not_equals', 'é diferente de'], ['starts_with', 'começa com'], ['ends_with', 'termina com'], ['regex', 'expressão regular']];
const NUMBER_OPS: Array<[string, string]> = [['equals', 'é igual a'], ['not_equals', 'é diferente de'], ['gt', 'maior que'], ['gte', 'maior ou igual a'], ['lt', 'menor que'], ['lte', 'menor ou igual a']];
const ENUM_OPS: Array<[string, string]> = [['equals', 'é'], ['not_equals', 'não é']];

const FIELDS: Array<{ id: string; label: string; kind: 'text' | 'number' | 'date' | 'enum'; options?: Array<[string, string]> }> = [
  { id: 'description', label: 'Descrição', kind: 'text' },
  { id: 'merchant', label: 'Estabelecimento (nome limpo)', kind: 'text' },
  { id: 'counterparty', label: 'Pessoa ou empresa do Pix', kind: 'text' },
  { id: 'sourceLabel', label: 'Categoria da fonte', kind: 'text' },
  { id: 'institution', label: 'Instituição', kind: 'text' },
  { id: 'operation', label: 'Operação (PIX, TED, BOLETO)', kind: 'text' },
  { id: 'mcc', label: 'Código MCC', kind: 'text' },
  { id: 'amount', label: 'Valor (saída é negativo)', kind: 'number' },
  { id: 'date', label: 'Data', kind: 'date' },
  { id: 'direction', label: 'Direção', kind: 'enum', options: [['out', 'Saída'], ['in', 'Entrada']] },
  { id: 'status', label: 'Status', kind: 'enum', options: [['posted', 'Lançada'], ['pending', 'Pendente']] },
  { id: 'role', label: 'Papel', kind: 'enum', options: [['none', 'Nenhum'], ['card_payment', 'Pagamento de fatura'], ['own_transfer', 'Entre contas suas'], ['investment', 'Investimento']] },
];
const fieldOf = (id: string) => FIELDS.find((f) => f.id === id) ?? FIELDS[0]!;
const opsFor = (field: string) => (fieldOf(field).kind === 'text' ? TEXT_OPS : fieldOf(field).kind === 'enum' ? ENUM_OPS : NUMBER_OPS);
const opLabel = (field: string, op: string) => opsFor(field).find(([id]) => id === op)?.[1] ?? op;

const emptyLeaf = (): Leaf => ({ field: 'description', operator: 'contains', value: '' });

/** Reais typed by the owner ("-12,50") to cents. */
function toCents(text: string): number | null {
  const clean = text.trim().replace(/\./g, '').replace(',', '.');
  const n = Number(clean);
  return clean !== '' && Number.isFinite(n) ? Math.round(n * 100) : null;
}

function valueText(leaf: Leaf): string {
  if (leaf.field === 'amount') return brl(Number(leaf.value));
  if (leaf.field === 'date') return dayMonth(String(leaf.value)) + '/' + String(leaf.value).slice(0, 4);
  const options = fieldOf(leaf.field).options;
  return options?.find(([id]) => id === leaf.value)?.[1] ?? `“${leaf.value}”`;
}

function describe(conditions: RuleConditions): string {
  const leafText = (l: Leaf) => `${fieldOf(l.field).label.split(' (')[0]} ${opLabel(l.field, l.operator)} ${valueText(l)}`;
  const joiner = conditions.match === 'all' ? ' e ' : ' ou ';
  return (conditions.items as Item[]).map((i) => (isGroup(i) ? `(${i.leaves.map(leafText).join(i.match === 'all' ? ' e ' : ' ou ')})` : leafText(i))).join(joiner);
}

function LeafEditor({ leaf, onChange, onRemove, accounts }: { leaf: Leaf; onChange: (leaf: Leaf) => void; onRemove: () => void; accounts: Array<{ id: string; label: string }> }) {
  const field = fieldOf(leaf.field);
  const [amountText, setAmountText] = useState(leaf.field === 'amount' && leaf.value !== '' ? String(Number(leaf.value) / 100).replace('.', ',') : '');
  return (
    <div class="rule-leaf">
      <Select
        ariaLabel="Campo"
        value={leaf.field}
        options={FIELDS.map((f) => ({ value: f.id, label: f.label }))}
        onChange={(next) => {
          const kind = fieldOf(next).kind;
          onChange({ field: next, operator: kind === 'text' ? 'contains' : 'equals', value: kind === 'enum' ? (fieldOf(next).options?.[0]?.[0] ?? '') : '' });
          setAmountText('');
        }}
      />
      <Select ariaLabel="Condição" value={leaf.operator} options={opsFor(leaf.field).map(([id, label]) => ({ value: id, label }))} onChange={(operator) => onChange({ ...leaf, operator })} />
      {field.kind === 'enum' ? (
        <Select ariaLabel="Valor" value={String(leaf.value)} options={field.options!.map(([id, label]) => ({ value: id, label }))} onChange={(value) => onChange({ ...leaf, value })} />
      ) : field.kind === 'date' ? (
        <input type="date" aria-label="Valor" value={String(leaf.value)} onInput={(e) => onChange({ ...leaf, value: (e.currentTarget as HTMLInputElement).value })} />
      ) : field.kind === 'number' ? (
        <input
          inputMode="decimal"
          aria-label="Valor em reais"
          placeholder="-50,00"
          value={amountText}
          onInput={(e) => {
            const text = (e.currentTarget as HTMLInputElement).value;
            setAmountText(text);
            onChange({ ...leaf, value: toCents(text) ?? '' });
          }}
        />
      ) : (
        <input aria-label="Valor" list={leaf.field === 'account' ? 'rule-accounts' : undefined} placeholder={leaf.operator === 'regex' ? 'ex.: ^uber( eats)?' : 'texto'} value={String(leaf.value)} maxLength={200} onInput={(e) => onChange({ ...leaf, value: (e.currentTarget as HTMLInputElement).value })} />
      )}
      <button class="link" type="button" onClick={onRemove} aria-label="Remover condição">
        Remover
      </button>
      {accounts.length > 0 && <datalist id="rule-accounts">{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</datalist>}
    </div>
  );
}

interface Draft {
  id?: number;
  name: string;
  active: boolean;
  match: 'all' | 'any';
  items: Item[];
  category: string;
}

const newDraft = (): Draft => ({ name: '', active: true, match: 'all', items: [emptyLeaf()], category: '' });

function RuleEditor({ draft, setDraft, categories, onSaved, onCancel, hidden }: { draft: Draft; setDraft: (d: Draft) => void; categories: CategoryRow[]; onSaved: () => void; onCancel: () => void; hidden: boolean }) {
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conditions = (): RuleConditions => ({ match: draft.match, items: draft.items as RuleConditions['items'] });
  const setItem = (i: number, item: Item) => setDraft({ ...draft, items: draft.items.map((x, at) => (at === i ? item : x)) });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof ApiError || e instanceof Error ? e.message : 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel rule-editor">
      <h2>{draft.id === undefined ? 'Nova regra' : 'Editar regra'}</h2>
      <input class="search" aria-label="Nome da regra" placeholder="Nome da regra" maxLength={80} value={draft.name} onInput={(e) => setDraft({ ...draft, name: (e.currentTarget as HTMLInputElement).value })} />
      <div class="rule-match">
        Quando
        <Select ariaLabel="Combinar" value={draft.match} options={[{ value: 'all', label: 'todas as condições' }, { value: 'any', label: 'qualquer condição' }]} onChange={(match) => setDraft({ ...draft, match: match as 'all' | 'any' })} />
        for verdadeira:
      </div>
      {draft.items.map((item, i) =>
        isGroup(item) ? (
          <div class="rule-group" key={i}>
            <div class="rule-match">
              Grupo: <Select ariaLabel="Combinar grupo" value={item.match} options={[{ value: 'any', label: 'qualquer uma destas' }, { value: 'all', label: 'todas estas' }]} onChange={(match) => setItem(i, { ...item, match: match as 'all' | 'any' })} />
              <button class="link" type="button" onClick={() => setDraft({ ...draft, items: draft.items.filter((_, at) => at !== i) })}>
                Remover grupo
              </button>
            </div>
            {item.leaves.map((leaf, j) => (
              <LeafEditor key={j} leaf={leaf} accounts={[]} onChange={(l) => setItem(i, { ...item, leaves: item.leaves.map((x, at) => (at === j ? l : x)) })} onRemove={() => (item.leaves.length > 1 ? setItem(i, { ...item, leaves: item.leaves.filter((_, at) => at !== j) }) : setDraft({ ...draft, items: draft.items.filter((_, at) => at !== i) }))} />
            ))}
            <button class="link" type="button" onClick={() => setItem(i, { ...item, leaves: [...item.leaves, emptyLeaf()] })}>
              + condição no grupo
            </button>
          </div>
        ) : (
          <LeafEditor key={i} leaf={item} accounts={[]} onChange={(l) => setItem(i, l)} onRemove={() => setDraft({ ...draft, items: draft.items.length > 1 ? draft.items.filter((_, at) => at !== i) : [emptyLeaf()] })} />
        ),
      )}
      <div class="links">
        <button class="link" type="button" onClick={() => setDraft({ ...draft, items: [...draft.items, emptyLeaf()] })}>
          + condição
        </button>
        <button class="link" type="button" onClick={() => setDraft({ ...draft, items: [...draft.items, { match: 'any', leaves: [emptyLeaf(), emptyLeaf()] }] })}>
          + grupo (ou)
        </button>
      </div>
      <div class="rule-match">
        Então a categoria é
        <CategorySelect value={draft.category} categories={categories} onChange={(category) => setDraft({ ...draft, category })} placeholder="Escolher categoria" />
      </div>
      <label class="switch">
        <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: (e.currentTarget as HTMLInputElement).checked })} /> Regra ativa
      </label>
      {message && <div class="error">{message}</div>}
      <div class="links">
        <button class="icon small" type="button" disabled={busy} onClick={() => void run(async () => setPreview(await api.previewRule(conditions(), draft.category)))}>
          Ver o que mudaria
        </button>
        <button class="primary small" type="button" disabled={busy || draft.name.trim() === '' || draft.category.trim() === ''} onClick={() => void run(async () => { await api.saveRule({ id: draft.id, name: draft.name, active: draft.active, conditions: conditions(), actions: { category: draft.category } }); onSaved(); })}>
          Salvar
        </button>
        <button class="link" type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
      {preview && (
        <div class="rule-preview">
          <div>
            {preview.matched} transações combinam; {preview.willChange} mudariam de categoria.
          </div>
          <ul class="rows">
            {preview.sample.map((t) => (
              <li key={t.id}>
                <span class="grow clip">{t.description}</span>
                <span class="muted">{dayMonth(t.date)}</span>
                <span>{brl(t.amount, hidden)}</span>
                <span class="muted">{t.category ?? 'Sem categoria'} → {t.newCategory || '?'}</span>
              </li>
            ))}
          </ul>
          {preview.matched > preview.sample.length && <div class="note">Mostrando as {preview.sample.length} mais recentes.</div>}
        </div>
      )}
    </section>
  );
}

export function RulesTab({ hidden }: { hidden: boolean }) {
  const rules = useLoad(() => api.rules(), []);
  const suggestions = useLoad(() => api.ruleSuggestions(), []);
  const categories = useLoad(() => api.categories(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await work();
      rules.reload();
      suggestions.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível concluir.');
    }
  };
  if (!rules.data) return <Loading error={rules.error} />;
  const items = rules.data.items;
  const move = (i: number, by: number) => {
    const ids = items.map((r) => r.id);
    const [moved] = ids.splice(i, 1);
    ids.splice(i + by, 0, moved!);
    void run(() => api.reorderRules(ids));
  };
  const download = async () => {
    const file = await api.exportRules();
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'regras.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const upload = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setMessage('Esse arquivo não é um JSON válido.');
      return;
    }
    const send = async (overwrite: boolean) => {
      const report = await api.importRules(parsed, overwrite);
      setMessage(`${report.imported} regras importadas${report.skipped.length > 0 ? `; ${report.skipped.length} ignoradas (${report.skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})` : ''}.`);
      rules.reload();
    };
    try {
      await send(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && window.confirm('Já existem regras. Substituir todas pelas do arquivo?')) await run(() => send(true));
      else if (!(e instanceof ApiError && e.status === 409)) setMessage(e instanceof Error ? e.message : 'Não foi possível importar.');
    }
  };
  return (
    <>
      <p class="muted">
        Uma regra define a categoria de todas as transações que combinam com as condições. A de número menor (mais acima) vale primeiro, e a primeira que combina ganha. Sua escolha numa transação e a regra “aplicar a todas com a mesma descrição” valem mais que estas. Pagamentos de fatura e transferências entre contas suas continuam fora dos gastos, a não ser que a regra use uma dessas categorias.
      </p>
      <div class="links">
        <button class="primary small" onClick={() => setDraft(newDraft())}>
          Nova regra
        </button>
        <button class="icon small" onClick={() => void run(download)} disabled={items.length === 0}>
          Exportar
        </button>
        <label class="icon small file-pick">
          Importar
          <input type="file" accept="application/json,.json" hidden onChange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; (e.currentTarget as HTMLInputElement).value = ''; if (f) void upload(f); }} />
        </label>
      </div>
      {message && <div class="note">{message}</div>}
      {suggestions.data && suggestions.data.items.length > 0 && !draft && (
        <section class="panel">
          <h2>Regras sugeridas</h2>
          <div class="muted">Estabelecimentos em que quase todas as transações têm a mesma categoria. Uma regra mantém assim, acerta as que destoam e já cobre o próximo texto que o banco inventar para o mesmo lugar. Achadas contando, sem usar IA.</div>
          <ul class="rows tall">
            {suggestions.data.items.map((s) => (
              <li key={s.merchant} class="suggestion">
                <div class="grow">
                  <div class="clip">
                    {s.merchant} → {s.category}
                  </div>
                  <div class="muted">
                    {s.count} transações, {s.descriptions} {s.descriptions === 1 ? 'texto' : 'textos'} diferentes
                    {s.differing > 0 ? ` · ${s.differing} em outra categoria` : ''}
                  </div>
                </div>
                <div class="links" data-no-nav>
                  <button class="primary small" onClick={() => void run(() => api.acceptRuleSuggestion(s.merchant, s.category))}>
                    Criar regra
                  </button>
                  <button class="link" onClick={() => void run(() => api.dismissRuleSuggestion(s.merchant))}>
                    Dispensar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {draft && <RuleEditor draft={draft} setDraft={setDraft} categories={categories.data?.items ?? []} hidden={hidden} onCancel={() => setDraft(null)} onSaved={() => { setDraft(null); rules.reload(); }} />}
      <section class="panel">
        <h2>Regras ({items.length})</h2>
        {items.length === 0 ? (
          <div class="empty">Nenhuma regra ainda. Crie uma, por exemplo “descrição contém uber” vai para Transporte por aplicativo.</div>
        ) : (
          <ul class="rows tall">
            {items.map((r: RuleRow, i) => (
              <li key={r.id} class="suggestion">
                <div class="grow">
                  <div class="clip">
                    {i + 1}. {r.name} {!r.active && <span class="badge muted">desligada</span>}
                  </div>
                  <div class="muted">
                    {describe(r.conditions)} → {r.actions.category} · {r.matches} transações
                  </div>
                </div>
                <div class="links" data-no-nav>
                  <button class="link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir">
                    Subir
                  </button>
                  <button class="link" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Descer">
                    Descer
                  </button>
                  <button class="link" onClick={() => void run(() => api.setRuleActive(r.id, !r.active))}>
                    {r.active ? 'Desligar' : 'Ligar'}
                  </button>
                  <button class="link" onClick={() => setDraft({ id: r.id, name: r.name, active: r.active, match: r.conditions.match, items: structuredClone(r.conditions.items) as Item[], category: r.actions.category })}>
                    Editar
                  </button>
                  <button class="link" onClick={() => window.confirm(`Excluir a regra “${r.name}”?`) && void run(() => api.deleteRuleById(r.id))}>
                    Excluir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
