import { useState } from 'preact/hooks';
import { api, ApiError } from '../api.ts';
import type { BudgetLine, SuggestionLine } from '../api.ts';
import { Meter } from '../charts.tsx';
import { CategorySelect } from '../CategorySelect.tsx';
import { Select } from '../Select.tsx';
import { brl, monthName, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams, type Route } from '../router.ts';
import { Go, Loading } from '../ui.tsx';

const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

const toCents = (text: string): number | null => {
  const n = Number(text.trim().replace(/\./g, '').replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const reais = (cents: number): string => String(cents / 100).replace('.', ',');

function Line({ line, month, hidden, onChanged, onError }: { line: BudgetLine; month: string; hidden: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.budget !== null ? reais(line.budget) : '');
  const [recurring, setRecurring] = useState(line.budget === null ? true : line.recurring);
  const save = async (amount: number | null) => {
    try {
      await api.setBudget(line.scope, line.name, month, amount, recurring);
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    }
  };
  const over = line.used !== null && line.used > 1;
  const params = line.scope === 'category' ? { category: line.name, from: `${month}-01`, kind: 'expense', spendingOnly: 'true' } : undefined;
  return (
    <li class="budget-line">
      <div class="budget-head">
        {params ? (
          <Go class="grow clip" page="transactions" params={{ ...params, to: `${month}-31` }}>
            {line.name}
          </Go>
        ) : (
          <span class="grow clip">
            {line.name} <span class="badge muted">grupo</span>
          </span>
        )}
        <strong class={over ? 'bad-text' : ''}>{brl(line.actual, hidden)}</strong>
        <span class="muted">de {line.budget !== null ? brl(line.budget, hidden) : 'sem orçamento'}</span>
        <button class="link" onClick={() => setEditing(!editing)}>
          {line.budget === null ? 'Definir' : 'Editar'}
        </button>
      </div>
      {line.budget !== null && (
        <>
          <Meter fraction={line.used ?? 0} tip={`${percent(line.used ?? 0)} usado`} />
          <div class="muted budget-note">
            {percent(line.used ?? 0)} usado
            {line.pace > line.budget && line.actual <= line.budget ? ` · no ritmo de ${brl(line.pace, hidden)} até o fim do mês` : ''}
            {over ? ` · ${brl(line.actual - line.budget, hidden)} acima do limite` : ''}
            {line.source === 'recurring' ? ' · vale dos meses anteriores' : ''}
            {line.previous > 0 ? ` · mês passado ${brl(line.previous, hidden)}` : ''}
          </div>
        </>
      )}
      {editing && (
        <div class="recat">
          <input inputMode="decimal" aria-label={`Limite de ${line.name}`} placeholder="Limite em reais" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
          <label class="switch">
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring((e.currentTarget as HTMLInputElement).checked)} /> Repetir nos meses seguintes
          </label>
          <button class="primary small" disabled={toCents(text) === null} onClick={() => void save(toCents(text))}>
            Salvar
          </button>
          {line.budget !== null && line.source === 'month' && (
            <button class="icon small" onClick={() => void save(null)}>
              Remover
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Suggestions({ month, onDone, hidden }: { month: string; onDone: () => void; hidden: boolean }) {
  const [months, setMonths] = useState(3);
  const { data, error } = useLoad(() => api.budgetSuggestions(month, months), [month, months]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const items: SuggestionLine[] = data.items.filter((i) => !i.hasBudget);
  const amountOf = (i: SuggestionLine) => picked[i.name] ?? reais(i.amount);
  const chosen = items.filter((i) => picked[i.name] !== undefined);
  return (
    <section class="panel">
      <h2>Sugestão pela média</h2>
      <div class="tabs">
        {[3, 6, 12].map((n) => (
          <button key={n} class={months === n ? 'tab on' : 'tab'} onClick={() => setMonths(n)}>
            {n} meses
          </button>
        ))}
      </div>
      <div class="muted">Média dos meses fechados antes de {monthName(month)}, arredondada para R$ 10. O mês em andamento não entra. Marque os que quiser e ajuste o valor.</div>
      {items.length === 0 ? (
        <div class="empty">Nada para sugerir: ou não há meses fechados com gastos, ou tudo já tem orçamento.</div>
      ) : (
        <ul class="rows">
          {items.map((i) => (
            <li key={i.name}>
              <input type="checkbox" aria-label={`Incluir ${i.name}`} checked={picked[i.name] !== undefined} onChange={(e) => setPicked((p) => { const next = { ...p }; if ((e.currentTarget as HTMLInputElement).checked) next[i.name] = reais(i.amount); else delete next[i.name]; return next; })} />
              <span class="grow clip">{i.name}</span>
              <span class="muted">{i.months} {i.months === 1 ? 'mês' : 'meses'}</span>
              <input class="amount-input" inputMode="decimal" aria-label={`Valor para ${i.name}`} value={amountOf(i)} disabled={picked[i.name] === undefined} onInput={(e) => setPicked((p) => ({ ...p, [i.name]: (e.currentTarget as HTMLInputElement).value }))} />
              <span class="muted">{hidden ? '' : brl(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {message && <div class="error">{message}</div>}
      <div class="links">
        <button
          class="primary small"
          disabled={chosen.length === 0 || chosen.some((i) => toCents(amountOf(i)) === null)}
          onClick={async () => {
            try {
              await api.createBudgets(month, chosen.map((i) => ({ name: i.name, amount: toCents(amountOf(i))! })));
              onDone();
            } catch (e) {
              setMessage(e instanceof ApiError || e instanceof Error ? e.message : 'Não foi possível criar.');
            }
          }}
        >
          Criar {chosen.length > 0 ? chosen.length : ''} {chosen.length === 1 ? 'orçamento' : 'orçamentos'}
        </button>
        <button class="link" onClick={onDone}>
          Fechar
        </button>
      </div>
    </section>
  );
}

function NewBudget({ month, onSaved, onError }: { month: string; onSaved: () => void; onError: (m: string) => void }) {
  const categories = useLoad(() => api.categories(), []);
  const [scope, setScope] = useState<'category' | 'group'>('category');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const options = scope === 'category' ? (categories.data?.items.map((c) => c.name) ?? []) : [...new Set((categories.data?.items ?? []).map((c) => c.parent).filter((g): g is string => g !== null))];
  return (
    <div class="recat">
      <Select ariaLabel="Tipo" value={scope} options={[{ value: 'category', label: 'Categoria' }, { value: 'group', label: 'Grupo' }]} onChange={(next) => { setScope(next as 'category' | 'group'); setName(''); }} />
      {scope === 'category' ? <CategorySelect value={name} onChange={setName} categories={categories.data?.items} creatable={false} placeholder="Escolher categoria" /> : <Select ariaLabel="Grupo" value={name} onChange={setName} options={options.map((o) => ({ value: o, label: o }))} placeholder="Escolher grupo" />}
      <input inputMode="decimal" aria-label="Limite em reais" placeholder="Limite" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
      <button
        class="primary small"
        disabled={name.trim() === '' || toCents(amount) === null}
        onClick={async () => {
          try {
            await api.setBudget(scope, name.trim(), month, toCents(amount), true);
            setName('');
            setAmount('');
            onSaved();
          } catch (e) {
            onError(e instanceof Error ? e.message : 'Não foi possível salvar.');
          }
        }}
      >
        Adicionar
      </button>
    </div>
  );
}

export function BudgetsPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const current = new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
  const month = route.params.get('month') ?? current;
  const { data, error, loading, reload } = useLoad(() => api.budgets(month), [month]);
  const [panel, setPanel] = useState<null | 'suggest' | 'copy'>(null);
  const [adjust, setAdjust] = useState('0');
  const [overwrite, setOverwrite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const go = (m: string) => patchParams({ month: m === current ? null : m });
  const copy = async () => {
    try {
      const r = await api.copyBudgets(addMonths(month, -1), month, Number(adjust.replace(',', '.')) || 0, overwrite);
      setMessage(`${r.copied} copiados, ${r.skipped} mantidos como estavam.`);
      setPanel(null);
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível copiar.');
    }
  };
  return (
    <div class="page-body">
      <h1 class="page-title">Orçamento</h1>
      <div class="period">
        <button class="icon small" onClick={() => go(addMonths(month, -1))} aria-label="Mês anterior">
          ‹
        </button>
        <strong>{monthName(month)}</strong>
        <button class="icon small" onClick={() => go(addMonths(month, 1))} aria-label="Próximo mês">
          ›
        </button>
        {month !== current && (
          <button class="link" onClick={() => go(current)}>
            Mês atual
          </button>
        )}
      </div>
      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <div class="panel">
            <div class="big">{brl(data.totals.actual, hidden)}</div>
            <div class="muted">gastos nas categorias com orçamento, de {brl(data.totals.budget, hidden)}{data.totals.over > 0 ? ` · ${data.totals.over} acima do limite` : ''}</div>
            <Meter fraction={data.totals.budget > 0 ? data.totals.actual / data.totals.budget : 0} />
            {data.elapsedDays > 0 && data.elapsedDays < data.totalDays && data.totals.budget > 0 && (
              <div class="muted">
                Dia {data.elapsedDays} de {data.totalDays}. No ritmo atual, o mês fecha em {brl(data.totals.pace, hidden)}.
              </div>
            )}
            <div class="links">
              <button class="icon small" onClick={() => setPanel(panel === 'suggest' ? null : 'suggest')}>
                Sugerir pela média
              </button>
              <button class="icon small" onClick={() => setPanel(panel === 'copy' ? null : 'copy')}>
                Copiar do mês anterior
              </button>
            </div>
            {panel === 'copy' && (
              <div class="recat">
                <span class="muted">Ajuste em %</span>
                <input inputMode="decimal" aria-label="Ajuste em porcentagem" value={adjust} onInput={(e) => setAdjust((e.currentTarget as HTMLInputElement).value)} />
                <label class="switch">
                  <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite((e.currentTarget as HTMLInputElement).checked)} /> Substituir os que já existem
                </label>
                <button class="primary small" onClick={() => void copy()}>
                  Copiar
                </button>
              </div>
            )}
            {message && <div class="note">{message}</div>}
          </div>
          {panel === 'suggest' && <Suggestions month={month} hidden={hidden} onDone={() => { setPanel(null); reload(); }} />}
          <section class="panel">
            <h2>Categorias</h2>
            {data.lines.length === 0 ? (
              <div class="empty">Sem gastos nem orçamentos neste mês.</div>
            ) : (
              <ul class="rows tall">
                {data.lines.map((l) => (
                  <Line key={`${l.scope}${l.name}${l.budget}`} line={l} month={month} hidden={hidden} onChanged={reload} onError={setMessage} />
                ))}
              </ul>
            )}
            <NewBudget month={month} onSaved={reload} onError={setMessage} />
            <div class="note">Um grupo e uma categoria dentro dele não podem ter orçamento ao mesmo tempo.</div>
          </section>
        </>
      ) : null}
    </div>
  );
}
