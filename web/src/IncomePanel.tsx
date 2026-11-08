import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from './api.ts';
import { brl, monthName, parseBrl } from './format.ts';
import type { NonBusinessRule } from '../../src/core/business-days.ts';
import { useLoad } from './hooks.ts';
import { invalidateData } from './invalidate.ts';
import { Select } from './Select.tsx';

interface Draft {
  id: number | null;
  name: string;
  amount: string;
  day: string;
  rule: NonBusinessRule;
}

/** What a payment day that is a weekend or holiday does: the choice in the form and the short word in the list. */
const RULES: Array<{ value: NonBusinessRule; label: string; short: string }> = [
  { value: 'previous', label: 'Antecipa para o dia útil anterior', short: 'antecipa' },
  { value: 'next', label: 'Adia para o próximo dia útil', short: 'adia' },
  { value: 'keep', label: 'Mantém o dia', short: 'mantém o dia' },
];
const blank = (): Draft => ({ id: null, name: '', amount: '', day: '', rule: 'previous' });

/**
 * The fixed income the owner registers (one entry per payment day, so a salary paid on the 11th and the 25th is two entries).
 * Shared by Contas, where the money outlook is, and Cartões, which adds the table of what is left each month after the bills.
 */
export function IncomePanel({ months, hidden, focus = false }: { months?: Array<{ key: string; income: number; bills: number }>; hidden: boolean; /** Scrolls here and opens the form when nothing is registered yet. */ focus?: boolean }) {
  const list = useLoad(() => api.income(), []);
  const [form, setForm] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The entry just saved, so a second payment day of the same income takes one click.
  const [last, setLast] = useState<{ name: string; amount: string; rule: NonBusinessRule } | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const items = list.data?.items ?? [];
  useEffect(() => {
    if (!focus || focused.current || !list.data) return;
    focused.current = true;
    top.current?.scrollIntoView({ block: 'start' });
    if (list.data.items.length === 0) setForm(blank());
  }, [focus, list.data]);
  const run = async (work: () => Promise<unknown>, saved?: { name: string; amount: string; rule: NonBusinessRule }) => {
    setMessage(null);
    try {
      await work();
      setForm(null);
      setLast(saved ?? null);
      list.reload();
      // The outlook, the forecast and the widgets all count the income, so they reload too.
      invalidateData();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    }
  };
  return (
    <div class="panel" ref={top}>
      <div class="panel-head">
        <h3>Renda fixa e o que sobra</h3>
        <button class="chip" onClick={() => setForm(blank())}>+ Nova renda</button>
      </div>
      <div class="muted">Cadastre o que entra todo mês (salário, aluguel recebido). A previsão desconta as faturas já conhecidas e mostra quanto sobra para gastar fora do cartão. Se o salário cai em dois dias do mês, cadastre uma renda para cada dia, cada uma com o valor daquele pagamento. Cadastre o dia em que o pagamento é feito: se ele cai em fim de semana ou feriado, a previsão usa o dia útil que você escolher abaixo. Se um crédito de valor parecido já chegou perto dessa data (até 6 dias antes ou 3 depois), a renda não é somada de novo.</div>
      {items.length > 0 && (
        <ul class="rows">
          {items.map((i) => (
            <li key={i.id}>
              <span class="grow clip">{i.name} <span class="muted" title="Se o dia cair em fim de semana ou feriado">dia {i.dayOfMonth} · {RULES.find((r) => r.value === i.nonBusinessRule)?.short}</span></span>
              <strong>{brl(i.amount, hidden)}</strong>
              <button class="link" onClick={() => setForm({ id: i.id, name: i.name, amount: String(i.amount / 100).replace('.', ','), day: String(i.dayOfMonth), rule: i.nonBusinessRule })}>Editar</button>
              <button class="link" onClick={() => window.confirm(`Remover a renda “${i.name}”? A previsão deixa de contar esse valor.`) && void run(() => api.deleteIncome(i.id))}>Remover</button>
            </li>
          ))}
        </ul>
      )}
      {last && !form && (
        <div class="note">
          Renda salva.{' '}
          <button class="link" onClick={() => setForm({ ...blank(), name: last.name, amount: last.amount, rule: last.rule })}>
            Cadastrar o mesmo valor em outro dia
          </button>
        </div>
      )}
      {form && (
        <form
          class="recat income-form"
          onSubmit={(e) => {
            e.preventDefault();
            const amount = parseBrl(form.amount);
            if (amount === null) return setMessage('Digite um valor maior que zero.');
            const day = Number(form.day);
            if (!Number.isInteger(day) || day < 1 || day > 31) return setMessage('Digite o dia do mês, de 1 a 31.');
            const name = form.name.trim();
            void run(() => api.saveIncome(form.id, { name, amount, dayOfMonth: day, nonBusinessRule: form.rule, fromMonth: null, untilMonth: null }), form.id === null ? { name, amount: form.amount, rule: form.rule } : undefined);
          }}
        >
          <input aria-label="Nome da renda" placeholder="Nome (ex.: Salário)" value={form.name} maxLength={60} onInput={(e) => setForm({ ...form, name: (e.currentTarget as HTMLInputElement).value })} />
          <input aria-label="Valor" inputMode="decimal" placeholder="Valor" value={form.amount} onInput={(e) => setForm({ ...form, amount: (e.currentTarget as HTMLInputElement).value })} />
          <input aria-label="Dia do mês" type="number" min="1" max="31" placeholder="Dia (1 a 31)" value={form.day} onInput={(e) => setForm({ ...form, day: (e.currentTarget as HTMLInputElement).value })} />
          <div class="income-rule">
            <span class="muted">Se cair em fim de semana ou feriado:</span>
            <Select ariaLabel="Se cair em fim de semana ou feriado" value={form.rule} onChange={(rule) => setForm({ ...form, rule: rule as NonBusinessRule })} options={RULES.map((r) => ({ value: r.value, label: r.label }))} />
          </div>
          <button class="primary" disabled={form.name.trim() === ''}>Salvar</button>
          <button type="button" class="link" onClick={() => setForm(null)}>Cancelar</button>
        </form>
      )}
      {message && <div class="error">{message}</div>}
      {months && items.length > 0 && (
        <table class="table">
          <thead>
            <tr><th>Mês</th><th>Renda</th><th>Faturas previstas</th><th>Sobra</th></tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.key}>
                <td>{monthName(m.key)}</td>
                <td>{brl(m.income, hidden)}</td>
                <td>{brl(m.bills, hidden)}</td>
                <td><strong class={m.income - m.bills < 0 ? 'bad-text' : 'good-text'}>{brl(m.income - m.bills, hidden)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
