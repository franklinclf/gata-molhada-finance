import { useEffect, useState } from 'preact/hooks';
import { Button, ButtonLink } from '../ds.tsx';
import { api, type FreshnessView } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago, localDay, maskMoney } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { invalidateData } from '../invalidate.ts';
import { patchParams } from '../router.ts';
import { Loading } from '../ui.tsx';
import { whenAhead } from './page-logic.ts';

type Source = FreshnessView['sources'][number];

/** How long the page follows Meu Pluggy after the owner opens it to refresh. */
const WATCH_MS = 10 * 60_000;

/** A refresh the owner started at Meu Pluggy: which banks, and when each was last read before it. */
type Watch = { institutions: string[]; before: Record<string, string>; until: number; popups: Array<{ institutions: string[]; window: Window }> };

/** One connection to open: its link and the banks it covers. */
type Target = { link: string; institutions: string[] };

/**
 * Opens Meu Pluggy in a small window. It must happen in the click itself, or the browser blocks it. The window gets no
 * handle back to the app, but the app keeps one to close it when the data arrives. Null when the browser refused.
 * Each one has its own name and place, so several can be open at once without covering each other.
 */
function openMeuPluggy(link: string, index: number): Window | null {
  const popup = window.open('about:blank', `meupluggy-${index}`, `popup,width=520,height=820,left=${40 + index * 70},top=${40 + index * 30}`);
  if (!popup) return null;
  popup.opener = null;
  popup.location.href = link;
  return popup;
}

/** The connections behind these sources, one entry per link (several banks can share one). */
function targetsOf(sources: Source[]): Target[] {
  const byLink = new Map<string, string[]>();
  for (const src of sources) byLink.set(src.link, [...(byLink.get(src.link) ?? []), src.institution]);
  return [...byLink].map(([link, institutions]) => ({ link, institutions }));
}

function alertText(event: string, code: string | null, message: string | null): string {
  // The message of this alert is the id of the new item.
  if (event === 'item/created') return `há uma conexão nova, que o app não lê porque não está em PLUGGY_ITEMS. Inclua o id ${message ?? ''} lá.`;
  if (event === 'item/deleted') return 'a conexão foi apagada no Meu Pluggy e os dados dela pararam de chegar. Conecte de novo e troque o id em PLUGGY_ITEMS.';
  if (event === 'item/waiting_user_input') return 'o banco pede um código ou uma confirmação.';
  if (event === 'item/waiting_user_action') return 'autorize o acesso no app do banco.';
  if (code === 'USER_AUTHORIZATION_PENDING' || code === 'USER_AUTHORIZATION_NOT_GRANTED') return 'a autorização no banco está pendente ou foi negada.';
  if (code === 'INVALID_CREDENTIALS' || code === 'ACCOUNT_LOCKED') return 'o banco recusou o acesso, reconecte.';
  return 'a última leitura deu erro' + (code ? ` (${code})` : '') + '.';
}

export function StatusPage({ now, hidden, embedded = false }: { now: Date; hidden: boolean; embedded?: boolean }) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // Windows the browser would not open together with the first one: each needs a click of its own.
  const [blockedTargets, setBlockedTargets] = useState<Target[]>([]);
  // While a refresh is followed, the read is checked every few seconds instead of every minute.
  const fresh = useLoad(() => api.freshness(), [], watch ? 4_000 : 60_000);
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
  const refreshed = (src: Source): boolean => watch !== null && Date.parse(src.lastUpdatedAt) > Date.parse(watch.before[src.institution] ?? '') && !src.syncing;
  /** Opens the connections at Meu Pluggy, where the owner taps Atualizar, and follows them until the new data is in. */
  const startRefresh = (event: MouseEvent, targets: Target[]) => {
    const popups = targets.flatMap((t, i) => {
      const w = openMeuPluggy(t.link, i);
      return w ? [{ institutions: t.institutions, window: w }] : [];
    });
    // Without a window of its own, the link opens as a normal tab and the page still follows.
    if (popups.length > 0) event.preventDefault();
    const institutions = targets.flatMap((t) => t.institutions);
    setWatch({ institutions, before: Object.fromEntries((fresh.data?.sources ?? []).map((src) => [src.institution, src.lastUpdatedAt])), until: Date.now() + WATCH_MS, popups });
    // A browser lets one click open one window; the others wait for their own click, in the buttons below the list.
    const opened = new Set(popups.map((p) => p.institutions.join('|')));
    const waiting = popups.length > 0 ? targets.filter((t) => !opened.has(t.institutions.join('|'))) : [];
    setBlockedTargets(waiting);
    setRefreshNote(waiting.length > 0 ? 'O navegador abre uma janela por clique. Abra as outras nos botões abaixo, ou permita pop-ups para este site.' : null);
    api.watchSources().catch(() => setRefreshNote('O app não conseguiu conferir com mais frequência agora. Os dados novos entram pelo aviso do Meu Pluggy ou na conferência seguinte.'));
  };
  /** Opens one of the windows the browser held back, and adds it to the ones that are followed and closed. */
  const openWaiting = (target: Target) => {
    const window = openMeuPluggy(target.link, watch?.popups.length ?? 0);
    if (!window) return;
    setBlockedTargets((list) => list.filter((t) => t !== target));
    setWatch((w) => (w ? { ...w, popups: [...w.popups, { institutions: target.institutions, window }] } : w));
  };
  useEffect(() => {
    if (!watch || !fresh.data) return;
    const watched = fresh.data.sources.filter((src) => watch.institutions.includes(src.institution));
    const done = watched.filter(refreshed).map((src) => src.institution);
    const finished = watched.length > 0 && done.length === watched.length;
    // Each window closes as soon as the banks it covers are read; the rest close when all are, or when the time is up.
    for (const p of watch.popups) if (finished || p.institutions.every((i) => done.includes(i))) p.window.close();
    if (!finished && Date.now() < watch.until) return;
    for (const p of watch.popups) p.window.close();
    // A window the browser refuses to close from here (Meu Pluggy can cut the link between the two) stays for the owner to close.
    const stuck = watch.popups.some((p) => !p.window.closed);
    setWatch(null);
    setBlockedTargets([]);
    if (done.length > 0) invalidateData();
    setRefreshNote(
      finished
        ? `Pronto: ${done.join(', ')} ${done.length === 1 ? 'foi lido' : 'foram lidos'} agora, e os números já estão atualizados.${stuck ? ' O navegador não deixou fechar a janela do Meu Pluggy: feche você.' : ''}`
        : `${done.length > 0 ? `Lido agora: ${done.join(', ')}. ` : ''}O Meu Pluggy não terminou ${done.length > 0 ? 'os outros ' : ''}em 10 minutos. Quando terminar, o aviso dele traz os dados, e o app confere de novo a cada 30 minutos.`,
    );
  }, [fresh.data, watch]);
  const rowState = (src: Source): string | null => (!watch?.institutions.includes(src.institution) ? null : src.syncing ? 'lendo os dados' : refreshed(src) ? 'lido agora' : 'esperando o Meu Pluggy');
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
              <li key={`${a.institution}${a.at}`}>
                <span class="grow">
                  {a.institution}: {alertText(a.event, a.code, a.message)} <span class="muted">({ago(a.at, now)})</span>
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
          <ButtonLink variant="primary" size="sm" href="https://meu.pluggy.ai/connections" target="_blank" rel="noreferrer noopener" onClick={(e) => startRefresh(e, targetsOf(fresh.data?.sources ?? []))}>
            Atualizar todos
          </ButtonLink>
        </div>
        {!fresh.data ? (
          <Loading error={fresh.error} />
        ) : (
          <ul class="rows">
            {fresh.data.sources.map((s) => (
              <li key={`${s.sourceId}${s.institution}`} class="source-row">
                <span class="grow">
                  {s.institution} <span class="muted">({s.sourceId})</span>
                  {s.nextSyncAt && <div class="muted small source-next">Próxima leitura automática: {whenAhead(s.nextSyncAt, now)}{s.consentExpiresAt ? ` · consentimento até ${localDay(s.consentExpiresAt).split('-').reverse().join('/')}` : ''}</div>}
                </span>
                {s.quotaExhausted && <span class="badge bad">limite do banco atingido</span>}
                {rowState(s) && <span class={rowState(s) === 'lido agora' ? 'badge good' : 'badge'}>{rowState(s)}</span>}
                <span class={s.late ? 'bad-text' : 'muted'}>{ago(s.lastUpdatedAt, now)}</span>
                <ButtonLink size="sm" href={s.link} target="_blank" rel="noreferrer noopener" title="Abre a conexão no Meu Pluggy numa janela pequena; toque em Atualizar lá e o app acompanha" onClick={(e) => startRefresh(e, [{ link: s.link, institutions: [s.institution] }])}>
                  Atualizar
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
        {refreshNote && <div class="note" role="status">{refreshNote}</div>}
        {watch && blockedTargets.length > 0 && (
          <div class="actions">
            {blockedTargets.map((t) => (
              <Button key={t.link + t.institutions.join()} size="sm" onClick={() => openWaiting(t)}>
                Abrir {t.institutions.length > 2 ? `${t.institutions.slice(0, 2).join(', ')}…` : t.institutions.join(', ')}
              </Button>
            ))}
          </div>
        )}
        <div class="note">As horas são de quando o Meu Pluggy leu cada banco, o que ele faz sozinho uma vez por dia. O Pluggy não deixa outro app pedir essa leitura, só o próprio Meu Pluggy. Por isso "Atualizar" abre a conexão no Meu Pluggy numa janela pequena: toque em Atualizar lá, e o app acompanha, lê os dados assim que o banco responder e fecha a janela. Fora disso, o aviso do Meu Pluggy (webhook) traz os dados novos em segundos, e o app confere por garantia a cada 30 minutos.</div>
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
