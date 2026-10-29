import { useState } from 'preact/hooks';
import { api } from './api.ts';
import { CategorySelect } from './CategorySelect.tsx';
import { Select } from './Select.tsx';
import { localDay } from './format.ts';
import { useLoad } from './hooks.ts';

export interface ManualDraft {
  id?: string;
  accountId: string;
  day: string;
  /** Cents with the sign of cash flow. */
  amount: number;
  description: string;
  category: string;
}

const toCents = (text: string): number | null => {
  const n = Number(text.trim().replace(/\./g, '').replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/** Form to type in a transaction no source reports, or to fix one typed before. */
export function ManualForm({ initial, now, onSaved, onCancel }: { initial?: ManualDraft; now: Date; onSaved: (id: string) => void; onCancel: () => void }) {
  const accounts = useLoad(() => api.accounts(), []);
  const categories = useLoad(() => api.categories(), []);
  const today = localDay(now.toISOString());
  const [accountId, setAccountId] = useState(initial?.accountId ?? '');
  const [day, setDay] = useState(initial?.day ?? today);
  const [income, setIncome] = useState(initial ? initial.amount > 0 : false);
  const [amount, setAmount] = useState(initial ? String(Math.abs(initial.amount) / 100).replace('.', ',') : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = accounts.data?.items ?? [];
  const chosen = accountId || items[0]?.id || '';
  const cents = toCents(amount);
  const submit = async () => {
    if (cents === null) return;
    setBusy(true);
    setMessage(null);
    const signed = income ? cents : -cents;
    try {
      if (initial?.id) {
        await api.updateManual(initial.id, { accountId: chosen, day, amount: signed, description, category });
        onSaved(initial.id);
      } else {
        const made = await api.createManual({ accountId: chosen, day, amount: signed, description, ...(category.trim() ? { category } : {}), ...(notes.trim() ? { notes } : {}) });
        onSaved(made.id);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel manual-form">
      <h2>{initial?.id ? 'Editar transação' : 'Nova transação'}</h2>
      <div class="muted">Para o que nenhuma fonte traz: uma cobrança que o banco não manda, um pagamento em dinheiro. Ela entra nos totais e nas faturas como as outras e a sincronização não mexe nela.</div>
      <Select ariaLabel="Conta ou cartão" value={chosen} onChange={setAccountId} options={items.map((a) => ({ value: a.id, label: `${a.name}${a.last4 ? ` •••• ${a.last4}` : ''}`, group: a.institution }))} />
      <div class="tabs">
        <button type="button" class={!income ? 'tab on' : 'tab'} onClick={() => setIncome(false)}>
          Gasto
        </button>
        <button type="button" class={income ? 'tab on' : 'tab'} onClick={() => setIncome(true)}>
          Entrada ou estorno
        </button>
      </div>
      <div class="recat">
        <input type="date" aria-label="Data" value={day} max={today} min="2026-01-01" onInput={(e) => setDay((e.currentTarget as HTMLInputElement).value)} />
        <input inputMode="decimal" aria-label="Valor em reais" placeholder="Valor" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <input class="search" aria-label="Descrição" placeholder="Descrição" maxLength={200} value={description} onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)} />
      <CategorySelect value={category} onChange={setCategory} categories={categories.data?.items} placeholder="Categoria (opcional)" emptyLabel="Sem categoria" />
      {!initial?.id && <input class="search" aria-label="Observação" placeholder="Observação (opcional)" maxLength={1000} value={notes} onInput={(e) => setNotes((e.currentTarget as HTMLInputElement).value)} />}
      {message && <div class="error">{message}</div>}
      <div class="links">
        <button class="primary small" type="button" disabled={busy || cents === null || description.trim() === '' || chosen === '' || day === ''} onClick={() => void submit()}>
          Salvar
        </button>
        <button class="link" type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </section>
  );
}
