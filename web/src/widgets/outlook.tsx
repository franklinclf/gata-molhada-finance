import { api, type OutlookView } from '../api.ts';
import { brl, dayMonth } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

type Event = OutlookView['timeline'][number];

/** The headline: what is left in the account at the end of the month, and what it means. */
function freeNote(data: OutlookView, hidden: boolean): string {
  if (data.free.value < 0) return 'O saldo não cobre o que vence até o fim do mês.';
  if (data.free.perDay !== null) return `${brl(data.free.perDay, hidden)} por dia, nos ${data.daysLeft} ${data.daysLeft === 1 ? 'dia' : 'dias'} que faltam`;
  return 'Nada sobra depois do que vence até o fim do mês.';
}

/** The sums behind the free amount, each one saying where it comes from. */
export function OutlookFacts({ data, hidden }: { data: OutlookView; hidden: boolean }) {
  return (
    <dl class="facts inline" title={data.free.explain}>
      <dt>Saldo nas contas hoje</dt>
      <dd>{brl(data.balance, hidden)}</dd>
      <dt title={data.expectedIn.explain}>{data.expectedIn.source === 'none' ? 'Entradas esperadas (sem renda para estimar)' : 'Entradas que ainda chegam no mês'}</dt>
      <dd>{data.expectedIn.source === 'none' ? '—' : `+ ${brl(data.expectedIn.total, hidden)}`}</dd>
      <dt title={data.dueOut.explain}>Faturas que vencem até o fim do mês</dt>
      <dd>− {brl(data.dueOut.bills, hidden)}</dd>
      {data.dueOut.recurring > 0 && (
        <>
          <dt title={data.dueOut.explain}>Contas fixas que faltam no mês</dt>
          <dd>− {brl(data.dueOut.recurring, hidden)}</dd>
        </>
      )}
      <dt>
        <strong>Livre para gastar</strong>
      </dt>
      <dd>
        <strong class={data.free.value < 0 ? 'bad-text' : ''}>{brl(data.free.value, hidden)}</strong>
      </dd>
    </dl>
  );
}

function rowLabel(e: Event): string {
  return e.direction === 'in' ? 'entrada' : e.kind === 'bill' ? 'fatura' : 'conta';
}

/** Dated list of what comes next, with the balance projected after each one. A payment the balance does not cover is marked. */
export function OutlookTimeline({ data, hidden, limit, detail = false }: { data: OutlookView; hidden: boolean; limit: number; detail?: boolean }) {
  const items = data.timeline.slice(0, limit);
  if (items.length === 0) return <div class="empty">Nenhum vencimento esperado nos próximos dias.</div>;
  return (
    <ul class="rows outlook-rows">
      {items.map((e, i) => (
        <li key={`${e.day}-${e.name}-${i}`} class={e.covered ? 'outlook-row' : 'outlook-row short'}>
          <span class="muted outlook-day">{dayMonth(e.day)}</span>
          <span class="grow clip outlook-name">
            {e.name}
            {e.late && <span class="badge bad">{e.direction === 'out' ? 'vencida' : 'atrasada'}</span>}
            {!e.covered && <span class="badge bad">não cobre</span>}
            {e.estimate && <span class="badge">estimado</span>}
            {e.afterMonth && <span class="badge">próximo mês</span>}
            {detail && <small class="muted outlook-origin">{e.origin}</small>}
          </span>
          <span class="outlook-amount">
            <strong class={e.direction === 'in' ? 'good-text' : ''}>
              {e.direction === 'in' ? '+' : '−'}
              {brl(e.amount, hidden)}
            </strong>
            <small class={e.covered ? 'muted' : 'bad-text'} title={`Saldo projetado depois de ${rowLabel(e)}`}>
              {e.covered ? `saldo ${brl(e.balanceAfter, hidden)}` : `faltam ${brl(e.shortfall, hidden)}`}
            </small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How much of the monthly income is already taken by installments, subscriptions and fixed bills. */
export function OutlookCommitted({ data, hidden }: { data: OutlookView; hidden: boolean }) {
  const c = data.committed;
  return (
    <div class="outlook-committed">
      <h3 class="outlook-sub">Renda comprometida</h3>
      {c.share === null ? (
        <div class="muted">{c.income.explain} Os compromissos somam {brl(c.total, hidden)} por mês.</div>
      ) : (
        <div class="muted">
          {Math.round(c.share * 100)}% de {brl(c.income.amount ?? 0, hidden)} {c.income.source === 'registered' ? '(renda cadastrada)' : '(estimada pelas suas entradas)'}
        </div>
      )}
      <dl class="facts inline" title={c.explain}>
        <dt>Parcelas do mês ({c.installmentCount})</dt>
        <dd>{brl(c.installments, hidden)}</dd>
        <dt>Assinaturas ({c.subscriptionCount})</dt>
        <dd>{brl(c.subscriptions, hidden)}</dd>
        <dt>Fixos que se repetem ({c.fixedCount})</dt>
        <dd>{brl(c.fixed, hidden)}</dd>
      </dl>
    </div>
  );
}

/** The month so far: how much can be spent until it ends, what falls due next, and the balance along the way. */
export function OutlookWidget({ now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.outlook(), [], 120_000);
  const upcoming = data?.timeline.filter((e) => e.direction === 'out') ?? [];
  return (
    <Widget
      title="Mês em curso"
      to={{ page: 'accounts' }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data && (
          <>
            <div class="muted">Livre para gastar até {dayMonth(data.monthEnd)}</div>
            <div class={data.free.value < 0 ? 'big bad-text' : 'big'}>{brl(data.free.value, hidden)}</div>
            <div class="muted">{freeNote(data, hidden)}</div>
          </>
        )
      }
    >
      {data && size !== 'sm' && (
        <>
          {size === 'lg' && <OutlookFacts data={data} hidden={hidden} />}
          {data.afterMonth.count > 0 && (
            <div class="note">
              Mais {brl(data.afterMonth.total, hidden)} em {data.afterMonth.count === 1 ? 'fatura vence' : 'faturas vencem'} a partir de {dayMonth(data.afterMonth.firstDay ?? data.monthEnd)}, depois do fim do mês.
            </div>
          )}
          <h3 class="outlook-sub">Próximos vencimentos</h3>
          <OutlookTimeline data={{ ...data, timeline: size === 'lg' ? data.timeline : upcoming }} hidden={hidden} limit={size === 'lg' ? 10 : 4} detail={size === 'lg'} />
          {size === 'lg' && <OutlookCommitted data={data} hidden={hidden} />}
        </>
      )}
    </Widget>
  );
}
