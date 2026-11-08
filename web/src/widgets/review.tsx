import { api } from '../api.ts';
import { billsToCheck } from '../bill-check.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** Things waiting for a decision: AI suggestions, possible duplicates, bills that do not close and rules the app proposes. */
export function ReviewWidget({ now }: WidgetProps) {
  const ai = useLoad(() => api.ai(), [], 120_000);
  const findings = useLoad(() => api.findings(), [], 120_000);
  const rules = useLoad(() => api.ruleSuggestions(), [], 300_000);
  const bills = useLoad(() => api.billCheck(), [], 120_000);
  const rows: Array<[string, number, string, Record<string, string> | undefined, string]> = [
    ['Sugestões da IA para decidir', ai.data?.suggestions.length ?? 0, 'settings', { tab: 'ai' }, 'sugestão'],
    ['Possíveis duplicatas entre fontes', findings.data?.items.length ?? 0, 'status', undefined, 'par'],
    ['Faturas que não fecham', bills.data ? billsToCheck(bills.data) : 0, 'cards', { tab: 'check' }, 'fatura'],
    ['Regras sugeridas', rules.data?.items.length ?? 0, 'settings', { tab: 'rules' }, 'regra'],
  ];
  const total = rows.reduce((s, r) => s + r[1], 0);
  return (
    <Widget title="Para revisar" now={now} loading={!ai.data && ai.loading} error={ai.error ?? findings.error ?? rules.error ?? bills.error} empty={ai.data && findings.data && rules.data && bills.data && total === 0 ? 'Nada esperando por você' : undefined} head={<><div class="big">{total}</div><div class="muted">{total === 0 ? 'Nada esperando por você' : 'itens esperando por você'}</div></>}>
      <ul class="rows">
        {rows.map(([label, n, page, params]) => (
          <li key={label}>
            <Go class="grow clip" page={page} params={params}>
              {label}
            </Go>
            <strong class={n > 0 ? '' : 'muted'}>{n}</strong>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
