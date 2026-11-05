import { useState } from 'preact/hooks';
import { api } from './api.ts';
import type { Cycle } from './api.ts';
import { Select } from './Select.tsx';

const toCents = (text: string): number | null => {
  const clean = text.trim().replace(/^R\$\s*/, '').replace(/\./g, '').replace(',', '.');
  if (clean === '' || !/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
};
const toText = (cents: number | null): string => (cents === null ? '' : (cents / 100).toFixed(2).replace('.', ','));

/** Changes one closed card bill: total, closing day, due day, and whether it is paid. What is left alone keeps following the issuer and the app. */
export function BillEditor({ accountId, cycle, onDone }: { accountId: string; cycle: Cycle; onDone: () => void }) {
  const [total, setTotal] = useState(toText(cycle.billTotal));
  const [closing, setClosing] = useState(cycle.to);
  const [due, setDue] = useState(cycle.dueDate);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cents = toCents(total);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() =>
      api.editBill(accountId, cycle.key, {
        // Only what was changed is sent; a field left as it was keeps following the issuer.
        ...(cents !== null && cents !== cycle.billTotal ? { total: cents } : {}),
        ...(closing !== cycle.to ? { closingDate: closing } : {}),
        ...(due !== cycle.dueDate ? { dueDate: due } : {}),
        ...(status !== '' ? { status: status === 'auto' ? null : (status as 'paid' | 'unpaid') } : {}),
      }),
    );
  const changed = (cents !== null && cents !== cycle.billTotal) || closing !== cycle.to || due !== cycle.dueDate || status !== '';
  return (
    <div class="bill-editor">
      <div class="correct">
        <div class="field">
          <span class="muted">Total da fatura (R$)</span>
          <input inputMode="decimal" aria-label="Total da fatura" value={total} onInput={(e) => setTotal((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <span class="muted">Fechamento</span>
          <input type="date" aria-label="Fechamento" value={closing} onInput={(e) => setClosing((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <span class="muted">Vencimento</span>
          <input type="date" aria-label="Vencimento" value={due} onInput={(e) => setDue((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <span class="muted">Pagamento{cycle.edited?.status ? ' (definido por você)' : ''}</span>
          <Select
            ariaLabel="Pagamento da fatura"
            value={status}
            onChange={setStatus}
            emptyLabel="Como está"
            options={[{ value: 'paid', label: 'Paga' }, { value: 'unpaid', label: 'Não paga' }, { value: 'auto', label: 'Deixar o app decidir' }]}
          />
        </div>
      </div>
      <div class="links">
        <button class="primary small" disabled={busy || !changed || (total.trim() !== '' && cents === null)} onClick={() => void save()}>
          Salvar
        </button>
        {cycle.edited && (
          <button class="link" disabled={busy} onClick={() => void run(() => api.editBill(accountId, cycle.key, { reset: true }))}>
            Desfazer minhas edições
          </button>
        )}
      </div>
      {error && <div class="error" role="alert">{error}</div>}
    </div>
  );
}
