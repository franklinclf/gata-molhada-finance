import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago, isStale } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { Loading } from '../ui.tsx';

export function StatusPage({ now }: { now: Date }) {
  const fresh = useLoad(() => api.freshness(), [], 60_000);
  const findings = useLoad(() => api.findings(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setMessage(null);
    try {
      await work();
      findings.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível concluir.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="page-body">
      <h1 class="page-title">Fontes e conferência</h1>
      <section class="panel">
        <h2>Última sincronização de cada banco</h2>
        {!fresh.data ? (
          <Loading error={fresh.error} />
        ) : (
          <ul class="rows">
            {fresh.data.sources.map((s) => (
              <li key={`${s.sourceId}${s.institution}`}>
                <span class="grow">
                  {s.institution} <span class="muted">({s.sourceId})</span>
                </span>
                {s.quotaExhausted && <span class="badge bad">limite do banco atingido</span>}
                <span class={isStale(s.lastUpdatedAt, now) ? 'bad-text' : 'muted'}>{ago(s.lastUpdatedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="panel">
        <h2>Leituras do mês por banco</h2>
        {fresh.data && (
          <>
            <ul class="rows">
              {fresh.data.quota.map((q) => (
                <li key={q.institutionKey}>
                  <div class="grow">
                    <div>{q.institution}</div>
                    <Meter fraction={q.used / q.limit} />
                  </div>
                  <span class={q.level === 'ok' ? 'muted' : 'bad-text'}>
                    {q.used}/{q.limit}
                  </span>
                </li>
              ))}
            </ul>
            <div class="note">Conta cada horário de sincronização distinto visto em qualquer fonte; o uso real nos bancos pode ser maior.</div>
          </>
        )}
      </section>
      <section class="panel">
        <h2>Para conferir ({findings.data?.items.length ?? 0})</h2>
        <div class="muted">
          Uma fonte não ter uma transação é normal e não aparece aqui. Aqui ficam só os pares que parecem ser a mesma transação com data ou descrição diferente. Se for a mesma, junte; se não for, descarte.
        </div>
        {!findings.data ? (
          <Loading error={findings.error} />
        ) : findings.data.items.length === 0 ? (
          <div class="empty">Nada para conferir.</div>
        ) : (
          <ul class="rows tall">
            {findings.data.items.map((f) => (
              <li key={f.id} class="suggestion">
                <div class="grow">
                  <div>{f.summary}</div>
                  <div class="muted">aberta {ago(f.openedAt, now)}</div>
                </div>
                <div class="links" data-no-nav>
                  <button class="link" onClick={() => patchParams({ tx: f.transactionId })}>
                    Ver
                  </button>
                  <button class="primary small" disabled={busy === f.id} onClick={() => void act(f.id, () => api.join(f.transactionId, String(f.details.otherTransactionId)))}>
                    É a mesma
                  </button>
                  <button class="icon small" disabled={busy === f.id} onClick={() => void act(f.id, () => api.dismiss(f.id))}>
                    Não é
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && <div class="error">{message}</div>}
      </section>
    </div>
  );
}
