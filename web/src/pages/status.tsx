import { useState } from 'preact/hooks';
import { ButtonLink } from '../ds.tsx';
import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago, isStale, maskMoney } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { Loading } from '../ui.tsx';

function alertText(event: string, code: string | null): string {
  if (event === 'item/waiting_user_input') return 'o banco pede um código ou uma confirmação.';
  if (event === 'item/waiting_user_action') return 'autorize o acesso no app do banco.';
  if (code === 'USER_AUTHORIZATION_PENDING' || code === 'USER_AUTHORIZATION_NOT_GRANTED') return 'a autorização no banco está pendente ou foi negada.';
  if (code === 'INVALID_CREDENTIALS' || code === 'ACCOUNT_LOCKED') return 'o banco recusou o acesso, reconecte.';
  return 'a última leitura deu erro' + (code ? ` (${code})` : '') + '.';
}

export function StatusPage({ now, hidden, embedded = false }: { now: Date; hidden: boolean; embedded?: boolean }) {
  const fresh = useLoad(() => api.freshness(), [], 60_000);
  const findings = useLoad(() => api.findings(), []);
  const ai = useLoad(() => api.ai(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setMessage(null);
    try {
      await work();
      findings.reload();
      ai.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível concluir.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="page-body">
      {embedded ? <h2>Fontes e conferência</h2> : <h1 class="page-title">Fontes e conferência</h1>}
      {fresh.data && fresh.data.health.length > 0 && (
        <section class="panel health" role="alert">
          <h2>Algo nos dados não fecha</h2>
          <ul class="rows">
            {fresh.data.health.map((h) => (
              <li key={h.id}>{h.message}</li>
            ))}
          </ul>
        </section>
      )}
      {fresh.data && fresh.data.connectionAlerts.length > 0 && (
        <section class="panel health" role="alert">
          <h2>Uma conexão precisa de você</h2>
          <ul class="rows">
            {fresh.data.connectionAlerts.map((a) => (
              <li key={a.institution}>
                <span class="grow">
                  {a.institution}: {alertText(a.event, a.code)} <span class="muted">({ago(a.at, now)})</span>
                </span>
                <ButtonLink size="sm" href="https://meu.pluggy.ai" target="_blank" rel="noreferrer noopener">
                  Abrir o Meu Pluggy
                </ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section class="panel">
        <div class="panel-head">
          <h2>Última leitura de cada banco</h2>
          <a class="primary small" href="https://meu.pluggy.ai/connections" target="_blank" rel="noreferrer noopener">
            Abrir o Meu Pluggy
          </a>
        </div>
        {!fresh.data ? (
          <Loading error={fresh.error} />
        ) : (
          <ul class="rows">
            {fresh.data.sources.map((s) => (
              <li key={`${s.sourceId}${s.institution}`}>
                <span class="grow">
                  {s.institution} <span class="muted">({s.sourceId})</span>
                  {s.nextSyncAt && <div class="muted small">Próxima leitura automática: {s.nextSyncAt.slice(0, 16).replace('T', ' ')} UTC{s.consentExpiresAt ? ` · consentimento até ${s.consentExpiresAt.slice(0, 10)}` : ''}</div>}
                </span>
                {s.quotaExhausted && <span class="badge bad">limite do banco atingido</span>}
                <span class={isStale(s.lastUpdatedAt, now) ? 'bad-text' : 'muted'}>{ago(s.lastUpdatedAt, now)}</span>
                <ButtonLink size="sm" href={s.link} target="_blank" rel="noreferrer noopener" title="Abre a conexão no Meu Pluggy, onde dá para atualizar agora">
                  Atualizar
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
        <div class="note">As horas são de quando o Meu Pluggy leu cada banco, o que ele faz sozinho uma vez por dia; o app não consegue pedir uma leitura nova, então "Atualizar" abre a conexão no Meu Pluggy. Com o aviso do Meu Pluggy (webhook) ligado, os dados novos entram em segundos e o app confere por garantia a cada 30 minutos. Sem ele, a conferência é a cada 2 minutos. Nos dois casos nada é pedido aos bancos.</div>
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
                  <div>{maskMoney(f.summary, hidden)}</div>
                  <div class="muted">
                    aberta {ago(f.openedAt, now)}
                    {ai.data?.matches.opinions[f.id] && (
                      <span class={`badge ${ai.data.matches.opinions[f.id]!.verdict === 'yes' ? 'info' : 'muted'}`} data-tip="Opinião do modelo; ele só junta sozinho quando tem certeza e o código confirma os fatos">
                        {' '}
                        IA: {ai.data.matches.opinions[f.id]!.verdict === 'yes' ? 'parece a mesma' : 'parece diferente'} ({ai.data.matches.opinions[f.id]!.confidence === 'high' ? 'certeza' : ai.data.matches.opinions[f.id]!.confidence === 'medium' ? 'provável' : 'incerta'})
                      </span>
                    )}
                  </div>
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
      {ai.data && ai.data.matches.counts.joined > 0 && (
        <section class="panel">
          <h2>Juntadas pela IA ({ai.data.matches.counts.joined})</h2>
          <div class="muted">A IA só junta dois registros quando tem certeza e o código confirma que são da mesma conta, de fontes diferentes, com o mesmo valor e a poucos dias de distância. Se ela errou, separe: o par não é juntado de novo.</div>
          <ul class="rows tall">
            {ai.data.matches.joined.map((m) => (
              <li key={m.findingId}>
                <div class="grow">
                  <div class="clip">
                    {m.a} <span class="muted">+</span> {m.b}
                  </div>
                  <div class="muted">{ago(m.decidedAt, now)} · {m.model}</div>
                </div>
                {m.transactionId && (
                  <div class="links" data-no-nav>
                    <button class="link" onClick={() => patchParams({ tx: m.transactionId })}>
                      Ver
                    </button>
                    <button class="icon small" disabled={busy === m.findingId} onClick={() => void act(m.findingId, () => api.separate(m.transactionId!))}>
                      Separar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
