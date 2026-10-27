import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago, isStale } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { Loading } from '../ui.tsx';
import { KIND_LABEL } from '../widgets/findings.tsx';

export function StatusPage({ now }: { now: Date }) {
  const fresh = useLoad(() => api.freshness(), [], 60_000);
  const findings = useLoad(() => api.findings(), []);
  return (
    <div class="page-body">
      <h1 class="page-title">Fontes e divergências</h1>
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
        <h2>Divergências entre as fontes ({findings.data?.items.length ?? 0})</h2>
        {!findings.data ? (
          <Loading error={findings.error} />
        ) : findings.data.items.length === 0 ? (
          <div class="empty">As fontes concordam entre si.</div>
        ) : (
          <ul class="rows tall tx-list">
            {findings.data.items.map((f) => (
              <li key={f.id} class="tx" onClick={() => patchParams({ tx: f.transactionId })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && patchParams({ tx: f.transactionId })}>
                <span class={f.severity === 'warning' ? 'swatch warn' : 'swatch'} />
                <div class="grow">
                  <div>{f.summary}</div>
                  <div class="muted">
                    {KIND_LABEL[f.kind] ?? f.kind} · aberta {ago(f.openedAt, now)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
