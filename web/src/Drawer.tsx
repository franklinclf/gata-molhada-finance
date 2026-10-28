import { useState } from 'preact/hooks';
import { api } from './api.ts';
import { brl, dayMonth, localDay, monthName } from './format.ts';
import { useLoad } from './hooks.ts';
import { navigate, patchParams } from './router.ts';
import { Loading, STATE_LABEL, StatusBadge } from './ui.tsx';

function Mapping({ id, hidden, d, onChange }: { id: string; hidden: boolean; d: NonNullable<ReturnType<typeof useLoad<import('./api.ts').TransactionDetail>>['data']>; onChange: (closes: boolean) => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useLoad(() => (picking ? api.candidates(id) : Promise.resolve(null)), [picking, id]);
  // Joining or separating rebuilds the transaction under a new id, so the panel closes instead of showing a stale one.
  const run = async (work: () => Promise<unknown>, closes = false) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setPicking(false);
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
      <h3>Mapeamento entre as fontes</h3>
      <div class="muted">
        {d.transaction.sourceIds.length > 1 ? `Vista no ${d.transaction.sourceIds.join(' e no ')}.` : `Só o ${d.transaction.sourceIds[0]} tem esta transação. Isso é normal e não afeta os totais.`}
      </div>
      <div class="links">
        {d.joinedByHand && (
          <button class="link" disabled={busy} onClick={() => void run(() => api.separate(id), true)}>
            Separar o que juntei
          </button>
        )}
        {d.transaction.sourceIds.length === 1 && !ignored && (
          <button class="link" disabled={busy} onClick={() => setPicking(!picking)}>
            {picking ? 'Cancelar' : 'Juntar com outra transação'}
          </button>
        )}
        <button class="link" disabled={busy} onClick={() => void run(() => api.setIgnored(id, !ignored))}>
          {ignored ? 'Voltar a considerar nos totais' : 'Ignorar (tirar dos totais)'}
        </button>
      </div>
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
                      {dayMonth(localDay(c.occurredAt))} · {c.sourceIds.join(', ')} · {c.daysApart === 0 ? 'mesmo dia' : `${c.daysApart} dia(s) de diferença`}
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

const ORIGIN: Record<string, string> = { source: 'definida pela fonte', override: 'escolhida por você', rule: 'regra para esta descrição', ai: 'sugerida pela IA' };

/** Side panel with everything known about one transaction, and the controls to recategorize it. */
export function TransactionDrawer({ id, hidden }: { id: string; hidden: boolean }) {
  const detail = useLoad(() => api.detail(id), [id]);
  const categories = useLoad(() => api.categories(), []);
  const [draft, setDraft] = useState('');
  const [similar, setSimilar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const close = () => patchParams({ tx: null });
  const d = detail.data;

  async function save(category: string | null) {
    setSaving(true);
    setMessage(null);
    try {
      await api.setCategory(id, category, similar);
      detail.reload();
      categories.reload();
      setDraft('');
      setMessage(category === null ? 'Voltou à categoria da fonte.' : 'Categoria salva.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

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
            <h2>{d.transaction.description}</h2>
            <div class={d.transaction.amount >= 0 ? 'big good-text' : 'big'}>{brl(d.transaction.amount, hidden)}</div>
            <dl class="facts">
              <dt>Data</dt>
              <dd>{dayMonth(localDay(d.transaction.occurredAt))}/{localDay(d.transaction.occurredAt).slice(0, 4)}</dd>
              <dt>Conta</dt>
              <dd>
                {d.account.institution} · {d.account.name}
                {d.account.last4 ? ` •••• ${d.account.last4}` : ''}
              </dd>
              <dt>Status</dt>
              <dd>{d.transaction.status === 'pending' ? 'Pendente' : 'Lançada'}</dd>
              <dt>Fontes</dt>
              <dd>{STATE_LABEL[d.transaction.state] ?? d.transaction.state}</dd>
              {d.transaction.installment && (
                <>
                  <dt>Parcela</dt>
                  <dd>
                    {d.transaction.installment.number} de {d.transaction.installment.total}
                  </dd>
                </>
              )}
              {d.cycle && (
                <>
                  <dt>Fatura</dt>
                  <dd>
                    Vence {dayMonth(d.cycle.dueDate)}/{d.cycle.dueDate.slice(0, 4)} <StatusBadge status={d.cycle.status} />
                  </dd>
                </>
              )}
              {d.transaction.excluded && (
                <>
                  <dt>Aviso</dt>
                  <dd class="bad-text">Fica fora dos totais (pendente antiga que só uma fonte vê).</dd>
                </>
              )}
            </dl>

            <h3>Categoria</h3>
            <div>
              <strong>{d.transaction.category ?? 'Sem categoria'}</strong> <span class="muted">({ORIGIN[d.transaction.categoryOrigin]})</span>
              {d.transaction.categoryOrigin !== 'source' && d.transaction.sourceCategory !== null && <div class="muted">A fonte diz: {d.transaction.sourceCategory}</div>}
            </div>
            <div class="recat">
              <input
                list="category-options"
                placeholder="Escolha ou digite uma categoria nova"
                value={draft}
                onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
                maxLength={60}
              />
              <datalist id="category-options">
                {(categories.data?.items ?? []).map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
              <button class="primary" disabled={saving || draft.trim() === ''} onClick={() => void save(draft)}>
                Salvar
              </button>
            </div>
            <label class="check">
              <input type="checkbox" checked={similar} onChange={(e) => setSimilar((e.currentTarget as HTMLInputElement).checked)} />
              Aplicar a todas com a descrição “{d.transaction.description}” ({d.merchant.count})
            </label>
            {d.transaction.categoryOrigin !== 'source' && (
              <button class="link" disabled={saving} onClick={() => void save(null)}>
                Voltar à categoria da fonte
              </button>
            )}
            {d.rule && <div class="muted">Regra ativa: {d.rule.category}</div>}
            {message && <div class="note" role="status">{message}</div>}

            {d.installments.length > 1 && (
              <>
                <h3>Parcelas desta compra</h3>
                <ul class="rows">
                  {d.installments.map((i) => (
                    <li key={i.id}>
                      <span class="grow">
                        {i.number} de {i.total} · {dayMonth(i.day)}/{i.day.slice(0, 4)}
                      </span>
                      <button class="link" onClick={() => patchParams({ tx: i.id })}>
                        {brl(i.amount, hidden)}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Neste estabelecimento</h3>
            <div class="muted">
              {d.merchant.count} transações · {brl(d.merchant.total, hidden)} no total
              {d.merchant.firstDay ? ` · de ${dayMonth(d.merchant.firstDay)}/${d.merchant.firstDay.slice(0, 4)} a ${dayMonth(d.merchant.lastDay!)}/${d.merchant.lastDay!.slice(0, 4)}` : ''}
            </div>
            <ul class="rows">
              {d.merchant.recent.map((r) => (
                <li key={r.id}>
                  <span class="grow">
                    {dayMonth(r.day)}/{r.day.slice(0, 4)} · {r.category ?? 'Sem categoria'}
                  </span>
                  <button class="link" onClick={() => patchParams({ tx: r.id })}>
                    {brl(r.amount, hidden)}
                  </button>
                </li>
              ))}
            </ul>
            <button
              class="link"
              onClick={() => {
                patchParams({ tx: null });
                navigate('transactions', { q: d.transaction.description });
              }}
            >
              Ver todas deste estabelecimento
            </button>

            <Mapping id={id} hidden={hidden} d={d} onChange={(closes) => (closes ? patchParams({ tx: null }) : detail.reload())} />

            <h3>O que cada fonte reporta</h3>
            {d.sources.map((s) => (
              <div class="source" key={`${s.sourceId}${s.externalId}`}>
                <strong>{s.sourceId}</strong>
                {s.record ? (
                  <dl class="facts">
                    <dt>Descrição</dt>
                    <dd>{s.record.description}</dd>
                    {s.record.descriptionRaw && s.record.descriptionRaw !== s.record.description && (
                      <>
                        <dt>Original</dt>
                        <dd>{s.record.descriptionRaw}</dd>
                      </>
                    )}
                    <dt>Categoria</dt>
                    <dd>{s.record.category ?? 'Sem categoria'}</dd>
                    <dt>Status</dt>
                    <dd>{s.record.status === 'pending' ? 'Pendente' : 'Lançada'}</dd>
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
