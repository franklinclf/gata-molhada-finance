import { useState } from 'preact/hooks';
import { api } from './api.ts';
import type { RecurringItem } from './api.ts';
import { brl, dayMonth, parseBrl } from './format.ts';
import { useLoad } from './hooks.ts';
import { invalidateData } from './invalidate.ts';
import { draftOf, IncomeForm, readDraft, type Draft } from './IncomePanel.tsx';
import { recurringWhen } from './pages/page-logic.ts';

const rowId = (r: RecurringItem): string => `${r.key}|${r.dayOfMonth}`;
const centsText = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');

/** The registered income that stands for a detected credit: about the same amount, within 5 days of the same day (the rule the outlook uses). */
function registeredFor(r: RecurringItem, items: Array<{ id: number; name: string; amount: number; dayOfMonth: number; nonBusinessRule: 'previous' | 'next' | 'keep' }>) {
  return items.find((i) => Math.abs(i.amount - r.amount) <= r.amount * 0.1 && Math.abs(i.dayOfMonth - r.dayOfMonth) <= 5) ?? null;
}

interface Removed {
  key: string;
  name: string;
  /** The mark to put back; null when the item was only ignored. */
  label: 'subscription' | 'recurring' | null;
}

/**
 * The bills and incomes that repeat. Each row opens its editor right below it: an expense can be renamed, given another expected
 * amount and day, or taken out of the list ("Não é recorrente", with "Desfazer"); an income is edited through the registered income,
 * the same form as in Contas. Items taken out stay one tap away under "Fora da lista".
 */
export function RecurringList({ items, today, hidden, onChanged }: { items: RecurringItem[]; today: string; hidden: boolean; onChanged: () => void }) {
  const income = useLoad(() => api.income(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showOut, setShowOut] = useState(false);

  const done = () => {
    setOpen(null);
    income.reload();
    onChanged();
    invalidateData();
  };
  const run = async (work: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await work();
      done();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    }
  };
  // An item the owner marked only leaves the list when the mark says so; ignoring it would be overridden by the mark.
  const remove = (r: RecurringItem) =>
    run(async () => {
      if (r.manual) await api.markRecurring(r.key, 'none');
      else await api.ignoreRecurring(r.key, true);
      setRemoved({ key: r.key, name: r.name, label: r.manual ? (r.label === 'subscription' ? 'subscription' : 'recurring') : null });
    });
  const restore = async (key: string, label: 'subscription' | 'recurring' | null) => {
    await run(async () => {
      if (label) await api.markRecurring(key, label);
      else await api.ignoreRecurring(key, false);
      setRemoved(null);
    });
  };

  return (
    <>
      {removed && (
        <div class="note">
          “{removed.name}” saiu da lista. <button class="link" onClick={() => void restore(removed.key, removed.label)}>Desfazer</button>
        </div>
      )}
      {message && <div class="error">{message}</div>}
      {items.length === 0 ? (
        <div class="empty">Nenhuma ainda.</div>
      ) : (
        <ul class="rows tall">
          {items.map((r) => {
            const id = rowId(r);
            return (
              <li key={id} class="recurring-row">
                <div class="grow">
                  <div class="clip">
                    {r.name} {r.label === 'subscription' && <span class="badge info">assinatura</span>} {r.manual && <span class="badge muted">marcada por você</span>} {r.edited && <span class="badge muted">ajustada por você</span>} {r.kind === 'variable' && <span class="badge muted">valor varia</span>} {r.account === 'card' && <span class="badge muted">no cartão</span>} {r.late && <span class="badge bad">atrasado</span>} {r.stale && <span class="badge muted">parou de cobrar</span>} {!r.regular && !r.stale && <span class="badge muted">sem periodicidade clara</span>}
                  </div>
                  <div class="muted">{r.regular && !r.stale ? recurringWhen(r, today) : `${r.occurrences} ${r.occurrences === 1 ? 'vez' : 'vezes'} · última ${dayMonth(r.lastDay)}`}</div>
                </div>
                <strong class={r.direction === 'in' ? 'good-text' : ''}>
                  {r.direction === 'in' ? '+' : '−'}
                  {brl(r.amount, hidden)}
                </strong>
                <button class="small" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
                  {open === id ? 'Fechar' : 'Editar'}
                </button>
                {open === id && (
                  <div class="recurring-edit">
                    {r.direction === 'out' ? (
                      <ExpenseEditor item={r} onSave={(edit) => run(() => api.overrideRecurring(r.key, edit))} onRemove={() => remove(r)} onCancel={() => setOpen(null)} onError={setMessage} />
                    ) : (
                      <IncomeEditor item={r} registered={income.data ? registeredFor(r, income.data.items) : null} ready={income.data !== undefined} onRun={run} onRemove={() => remove(r)} onCancel={() => setOpen(null)} onError={setMessage} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button class="link" aria-expanded={showOut} onClick={() => setShowOut(!showOut)}>
        {showOut ? 'Esconder os que saíram da lista' : 'Ver os que saíram da lista'}
      </button>
      {showOut && <IgnoredList hidden={hidden} onRestore={(key) => restore(key, null)} />}
    </>
  );
}

/** Name shown, expected amount and day of an expense. A field left as the app detected it is not saved as a correction. */
function ExpenseEditor({ item, onSave, onRemove, onCancel, onError }: { item: RecurringItem; onSave: (edit: { name: string | null; amount: number | null; dayOfMonth: number | null }) => void; onRemove: () => void; onCancel: () => void; onError: (m: string | null) => void }) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(centsText(item.amount));
  const [day, setDay] = useState(String(item.dayOfMonth));
  return (
    <form
      class="recat income-form"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = parseBrl(amount);
        if (cents === null) return onError('Digite um valor maior que zero.');
        const dayNumber = Number(day);
        if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) return onError('Digite o dia do mês, de 1 a 31.');
        if (name.trim() === '') return onError('Digite um nome.');
        onError(null);
        onSave({ name: name.trim(), amount: cents, dayOfMonth: dayNumber });
      }}
    >
      <input aria-label="Nome na lista" value={name} maxLength={60} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      <input aria-label="Valor esperado" inputMode="decimal" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
      <input aria-label="Dia do mês" type="number" min="1" max="31" value={day} onInput={(e) => setDay((e.currentTarget as HTMLInputElement).value)} />
      <button class="primary" disabled={name.trim() === ''}>Salvar</button>
      <button type="button" class="link" onClick={onCancel}>Cancelar</button>
      {item.edited && (
        <button type="button" class="link" title="Volta ao nome, valor e dia que o app achou nas transações" onClick={() => onSave({ name: null, amount: null, dayOfMonth: null })}>
          Usar o que o app achou
        </button>
      )}
      <button type="button" class="link" title="Sai desta lista e do calendário" onClick={onRemove}>Não é recorrente</button>
    </form>
  );
}

/** An income is edited through the registered income: the one that stands for this credit, or a new one filled with what the app saw. */
function IncomeEditor({ item, registered, ready, onRun, onRemove, onCancel, onError }: { item: RecurringItem; registered: ReturnType<typeof registeredFor>; ready: boolean; onRun: (work: () => Promise<unknown>) => Promise<void>; onRemove: () => void; onCancel: () => void; onError: (m: string | null) => void }) {
  const [form, setForm] = useState<Draft>(() => draftOf(registered ? { ...registered } : { name: item.name, amount: item.amount, dayOfMonth: item.dayOfMonth }));
  if (!ready) return <div class="muted">Carregando…</div>;
  return (
    <>
      <div class="muted">{registered ? 'Esta entrada está cadastrada como renda fixa; a previsão usa o que está abaixo.' : 'Esta entrada ainda não está cadastrada como renda fixa. Salvar cadastra com o dia e o valor abaixo.'}</div>
      <IncomeForm
        form={form}
        setForm={setForm}
        onCancel={onCancel}
        onSubmit={() => {
          const read = readDraft(form);
          if ('error' in read) return onError(read.error);
          onError(null);
          void onRun(() => api.saveIncome(registered?.id ?? null, read.value));
        }}
      >
        {registered && (
          <button type="button" class="link" onClick={() => window.confirm(`Remover a renda “${registered.name}”? A previsão deixa de contar esse valor.`) && void onRun(() => api.deleteIncome(registered.id))}>
            Remover renda cadastrada
          </button>
        )}
        <button type="button" class="link" title="Sai desta lista e do calendário" onClick={onRemove}>Não é recorrente</button>
      </IncomeForm>
    </>
  );
}

/** What was taken out of the list with "Não é recorrente", with a way back after the "Desfazer" notice is gone. */
function IgnoredList({ hidden, onRestore }: { hidden: boolean; onRestore: (key: string) => Promise<void> }) {
  const list = useLoad(() => api.ignoredRecurring(), []);
  if (!list.data) return <div class="muted">Carregando…</div>;
  if (list.data.items.length === 0) return <div class="empty">Nada foi tirado da lista.</div>;
  return (
    <ul class="rows">
      {list.data.items.map((r) => (
        <li key={rowId(r)}>
          <span class="grow clip">{r.name} <span class="muted">todo dia {r.dayOfMonth}</span></span>
          <strong>{brl(r.amount, hidden)}</strong>
          <button class="link" onClick={() => void onRestore(r.key).then(() => list.reload())}>Voltar para a lista</button>
        </li>
      ))}
    </ul>
  );
}
