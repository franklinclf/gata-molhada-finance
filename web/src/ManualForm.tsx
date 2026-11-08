import { useEffect, useState } from 'preact/hooks';
import { api } from './api.ts';
import { CategorySelect } from './CategorySelect.tsx';
import { Select } from './Select.tsx';
import { localDay, parseBrl } from './format.ts';
import { accountName, productName } from './names.ts';
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

const toCents = (text: string): number | null => parseBrl(text);

/** Where the account last used is remembered on this device, so the next entry starts on it. */
const LAST_ACCOUNT_KEY = 'gmf.manual.account';
const lastAccount = (): string => {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY) ?? '';
  } catch {
    return '';
  }
};
const rememberAccount = (id: string): void => {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, id);
  } catch {
    // Storage can be blocked; the form then starts on the first account as before.
  }
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
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const items = accounts.data?.items ?? [];
  const remembered = lastAccount();
  const chosen = accountId || (items.some((a) => a.id === remembered) ? remembered : items[0]?.id) || '';
  const cents = toCents(amount);
  // The category other transactions with this text carry most often, looked up once typing pauses.
  useEffect(() => {
    setSuggestion(null);
    const text = description.trim();
    if (text.length < 3) return;
    let current = true;
    const timer = setTimeout(() => {
      api.explore(new URLSearchParams({ q: text, limit: '1' })).then(
        (r) => current && setSuggestion(r.facets.categories.find((c) => c.name !== '' && c.name !== 'Sem categoria')?.name ?? null),
        () => undefined,
      );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [description]);
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
        rememberAccount(chosen);
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
      <Select ariaLabel="Conta ou cartão" value={chosen} onChange={setAccountId} options={items.map((a) => ({ value: a.id, label: `${a.kind === 'credit_card' ? productName(a.institution, a.name) || 'Cartão' : accountName(a.institution, a.name, a.kind)}${a.last4 ? ` •••• ${a.last4}` : ''}`, group: a.institution }))} />
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
      <CategorySelect value={category} onChange={setCategory} categories={categories.data?.items} suggested={suggestion ? [suggestion] : undefined} placeholder="Categoria (opcional)" emptyLabel="Sem categoria" />
      {suggestion && suggestion !== category && (
        <button class="link" type="button" onClick={() => setCategory(suggestion)}>
          Outras transações com esta descrição estão em “{suggestion}”. Usar essa categoria
        </button>
      )}
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
