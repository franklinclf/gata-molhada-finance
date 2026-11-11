import { api } from '../api.ts';
import { billsToCheck } from '../bill-check.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import { COLUMN_HEIGHT } from '../grid.ts';
import type { WidgetProps } from './index.ts';

/** Things waiting for a decision: AI suggestions, possible duplicates, bills that do not close and rules the app proposes. */
export function ReviewWidget({ now, size, pixels }: WidgetProps) {
  const column = size === 'sm' && pixels !== undefined && pixels.height >= COLUMN_HEIGHT;
  const ai = useLoad(() => api.ai(), [], 120_000);
  const findings = useLoad(() => api.findings(), [], 120_000);
  const rules = useLoad(() => api.ruleSuggestions(), [], 300_000);
  const bills = useLoad(() => api.billCheck(), [], 120_000);
  const rows: Array<[string, number, string, Record<string, string> | undefined, string, string]> = [
    ['Sugestões da IA para decidir', ai.data?.suggestions.length ?? 0, 'settings', { tab: 'ai' }, 'sugestão', 'Sugestões'],
    ['Possíveis duplicatas entre fontes', findings.data?.items.length ?? 0, 'status', undefined, 'par', 'Duplicatas'],
    ['Faturas que não fecham', bills.data ? billsToCheck(bills.data) : 0, 'cards', { tab: 'check' }, 'fatura', 'Faturas'],
    ['Regras sugeridas', rules.data?.items.length ?? 0, 'settings', { tab: 'rules' }, 'regra', 'Regras'],
  ];
  const total = rows.reduce((s, r) => s + r[1], 0);
  return (
    <Widget title="Para revisar" column={column} now={now} loading={!ai.data && ai.loading} error={ai.error ?? findings.error ?? rules.error ?? bills.error} empty={ai.data && findings.data && rules.data && bills.data && total === 0 ? 'Nada esperando por você' : undefined} head={<><div class="big count">{total} <small>{total === 1 ? 'item' : 'itens'}</small></div></>}>
      <ul class="rows">
        {rows.map(([label, n, page, params, , short]) => (
          <li key={label} class={column ? 'stack' : undefined}>
            <div class={column ? 'row-line' : 'grow row-line'}>
              <Go class="grow clip" page={page} params={params} data-tip={label}>
                {column ? short : label}
              </Go>
              <strong class={n > 0 ? '' : 'muted'}>{n}</strong>
            </div>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
