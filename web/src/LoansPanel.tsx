import { useState } from 'preact/hooks';
import { api } from './api.ts';
import type { InstallmentStatus, LoanView } from './api.ts';
import { brl, dayMonth, localDay, parseBrl } from './format.ts';
import { useLoad } from './hooks.ts';
import { invalidateData } from './invalidate.ts';
import { accountLabel } from './names.ts';
import { Select } from './Select.tsx';

const STATUS: Record<InstallmentStatus, { label: string; badge: string }> = {
  paid: { label: 'paga', badge: 'badge good' },
  due: { label: 'vence', badge: 'badge warn' },
  late: { label: 'atrasada', badge: 'badge bad' },
  future: { label: 'a vencer', badge: 'badge muted' },
};

interface Draft {
  name: string;
  accountId: string;
  principal: string;
  total: string;
  installments: string;
  firstDue: string;
  takenOn: string;
}

const blank = (today: string): Draft => ({ name: '', accountId: '', principal: '', total: '', installments: '', firstDue: '', takenOn: today });

/** The installment the form shows as a hint: the total split in whole cents, the first ones taking the extra cent. */
const installmentHint = (total: number, count: number): string => {
  const base = Math.floor(total / count);
  return total % count === 0 ? brl(base) : `${brl(base + 1)} (as últimas ${brl(base)})`;
};

/**
 * Personal loans paid in monthly debits. The bank gives no loan data, so the owner registers the loan and the app matches each
 * installment to a debit on the account and the cash to a credit. Neither counts as income or spending: the cash that was spent is
 * counted where it went, and the interest is inside the installments.
 */
export function LoansPanel({ hidden, now }: { hidden: boolean; now: Date }) {
  const loans = useLoad(() => api.loans(), []);
  const accounts = useLoad(() => api.accounts(), []);
  const [form, setForm] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const today = localDay(now.toISOString());
  const bank = (accounts.data?.items ?? []).filter((a) => a.kind !== 'credit_card');
  const items = loans.data?.items ?? [];
  const nameOf = (l: LoanView) => {
    const a = bank.find((x) => x.id === l.accountId);
    return a ? accountLabel(a) : l.accountName;
  };

  const principal = form ? parseBrl(form.principal) : null;
  const total = form ? parseBrl(form.total) : null;
  const count = form ? Number(form.installments) : NaN;
  const countOk = Number.isInteger(count) && count >= 1 && count <= 120;
  const chosen = form ? form.accountId || bank[0]?.id || '' : '';
  const ready = form !== null && form.name.trim() !== '' && chosen !== '' && principal !== null && total !== null && total >= principal && countOk && form.firstDue !== '' && form.takenOn !== '';

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setForm(null);
      loans.reload();
      // The installments and the cash received leave spending and income, so every screen reloads.
      invalidateData();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (!form || !ready) return;
    void run(() => api.createLoan({ name: form.name.trim(), accountId: chosen, principal: principal!, total: total!, installments: count, firstDue: form.firstDue, takenOn: form.takenOn }));
  };
  const set = (patch: Partial<Draft>) => form && setForm({ ...form, ...patch });
  const input = (e: Event) => (e.currentTarget as HTMLInputElement).value;

  return (
    <div class="panel">
      <div class="panel-head">
        <h3>Empréstimos</h3>
        <button class="chip" onClick={() => setForm(blank(today))}>+ Novo empréstimo</button>
      </div>
      <div class="muted">Cadastre um empréstimo pago em débitos mensais na conta. O app reconhece o dinheiro que entrou e cada parcela debitada, e nenhum dos dois conta como receita ou gasto: o juros já está dentro das parcelas. As parcelas que faltam aparecem no Mês em curso e no Calendário.</div>
      {items.length === 0 && !form && <div class="empty">Nenhum empréstimo cadastrado.</div>}
      {items.length > 0 && (
        <ul class="rows tall">
          {items.map((l) => (
            <li key={l.id} class="recurring-row">
              <div class="grow">
                <div class="clip">
                  {l.name} <span class="muted">{nameOf(l)}</span> {l.next?.late && <span class="badge bad">atrasado</span>}
                </div>
                <div class="muted">
                  {l.paidCount} de {l.installments} pagas · {l.next ? `próxima ${dayMonth(l.next.day)}, ${brl(l.next.amount, hidden)}` : 'quitado'} · falta {brl(l.remaining, hidden)} · juros {brl(l.interest, hidden)}
                </div>
                <div class="muted">{l.proceeds ? `Dinheiro recebido em ${dayMonth(l.proceeds.day)}` : 'Dinheiro recebido ainda não identificado na conta'}</div>
              </div>
              <button class="small" aria-expanded={openId === l.id} onClick={() => setOpenId(openId === l.id ? null : l.id)}>
                {openId === l.id ? 'Fechar' : 'Parcelas'}
              </button>
              <button class="link" onClick={() => window.confirm(`Remover o empréstimo “${l.name}”? Os débitos e o dinheiro recebido voltam a contar como gasto e receita.`) && void run(() => api.deleteLoan(l.id))}>
                Remover
              </button>
              {openId === l.id && (
                <ul class="rows recurring-edit">
                  {l.schedule.map((s) => (
                    <li key={s.number}>
                      <span class="grow">
                        {s.number}/{l.installments} · {dayMonth(s.day)}
                      </span>
                      <span>{brl(s.amount, hidden)}</span>
                      <span class={STATUS[s.status].badge}>{STATUS[s.status].label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {form && (
        <form
          class="loan-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div class="loan-grid">
            <label class="field wide">
              <span class="muted">Nome</span>
              <input aria-label="Nome do empréstimo" placeholder="Ex.: Reforma" value={form.name} maxLength={60} onInput={(e) => set({ name: input(e) })} />
            </label>
            <div class="field wide">
              <span class="muted">Conta onde o dinheiro entrou e as parcelas saem</span>
              <Select ariaLabel="Conta onde o dinheiro entrou e as parcelas saem" value={chosen} onChange={(accountId) => set({ accountId })} options={bank.map((a) => ({ value: a.id, label: accountLabel(a), group: a.institution }))} />
            </div>
            <label class="field">
              <span class="muted">Valor recebido</span>
              <input aria-label="Valor recebido" inputMode="decimal" placeholder="3000,00" value={form.principal} onInput={(e) => set({ principal: input(e) })} />
            </label>
            <label class="field">
              <span class="muted">Total a pagar</span>
              <input aria-label="Total a pagar" inputMode="decimal" placeholder="3250,00" value={form.total} onInput={(e) => set({ total: input(e) })} />
            </label>
            <label class="field">
              <span class="muted">Parcelas</span>
              <input aria-label="Número de parcelas" type="number" min="1" max="120" placeholder="6" value={form.installments} onInput={(e) => set({ installments: input(e) })} />
            </label>
            <label class="field">
              <span class="muted">Primeiro vencimento</span>
              <input type="date" aria-label="Primeiro vencimento" value={form.firstDue} onInput={(e) => set({ firstDue: input(e) })} />
            </label>
            <label class="field">
              <span class="muted">Dia em que o dinheiro entrou</span>
              <input type="date" aria-label="Dia em que o dinheiro entrou" value={form.takenOn} max={today} min="2026-01-01" onInput={(e) => set({ takenOn: input(e) })} />
            </label>
          </div>
          {(total !== null && countOk) || (principal !== null && total !== null && total >= principal) ? (
            <div class="muted loan-hints">
              {total !== null && countOk && <span>Parcela de {installmentHint(total, count)}.</span>}
              {principal !== null && total !== null && total >= principal && <span> Juros dentro das parcelas: {brl(total - principal)}.</span>}
            </div>
          ) : null}
          {principal !== null && total !== null && total < principal && <div class="error">O total a pagar não pode ser menor que o valor recebido.</div>}
          {message && <div class="error">{message}</div>}
          <div class="loan-actions">
            <button type="button" class="link" onClick={() => setForm(null)}>Cancelar</button>
            <button class="primary" disabled={busy || !ready}>Salvar</button>
          </div>
        </form>
      )}
      {message && !form && <div class="error">{message}</div>}
    </div>
  );
}
