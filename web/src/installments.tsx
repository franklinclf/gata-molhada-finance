import { useState } from 'preact/hooks';
import type { InstallmentPurchase, InstallmentSlot } from './api.ts';
import { Bars } from './charts.tsx';
import { brl, monthName } from './format.ts';
import { Go } from './ui.tsx';

export const SLOT_LABEL: Record<InstallmentSlot['status'], string> = {
  paid: 'paga',
  billed: 'fatura fechada, a pagar',
  open: 'no ciclo em aberto',
  future: 'ainda não cobrada',
};

export const SLOT_COLOR: Record<InstallmentSlot['status'], string> = {
  paid: 'var(--good)',
  billed: 'var(--warn)',
  open: 'var(--accent)',
  future: 'var(--track)',
};

/** One square per installment, coloured by what has happened to it. */
export function SlotStrip({ p, hidden }: { p: InstallmentPurchase; hidden: boolean }) {
  return (
    <div class="strip" role="img" aria-label={`${p.paid} pagas de ${p.total}`}>
      {p.slots.map((s) => (
        <span
          key={s.number}
          class={s.inferred ? 'slot inferred' : 'slot'}
          style={{ background: SLOT_COLOR[s.status] }}
          data-tip={`Parcela ${s.number} de ${p.total}\nFatura com venc. ${monthName(s.cycle)}\n${SLOT_LABEL[s.status]}${s.inferred ? ' (mês estimado)' : ''}\n${hidden ? '••••' : brl(p.amount)}`}
        />
      ))}
    </div>
  );
}

export function PurchaseRow({ p, hidden, detailed = false }: { p: InstallmentPurchase; hidden: boolean; detailed?: boolean }) {
  const [open, setOpen] = useState(false);
  const next = p.slots.find((s) => s.status !== 'paid');
  return (
    <li class="purchase">
      <button class="row-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div class="grow">
          <div class="clip">{p.description}</div>
          <SlotStrip p={p} hidden={hidden} />
          <div class="muted clip">
            {p.card} · {p.finished ? `quitada (${p.total}x)` : `${p.paid} de ${p.total} pagas${next ? ` · próxima na fatura de ${monthName(next.cycle)}` : ''}`}
          </div>
        </div>
        <div class="right">
          <strong>{brl(p.amount, hidden)}</strong>
          <span class="muted">{p.finished ? '' : `restam ${brl(p.remaining, hidden)}`}</span>
        </div>
      </button>
      {(open || detailed) && (
        <div class="scroll-x">
          <table class="table">
            <thead>
              <tr>
                <th>Parcela</th>
                <th>Fatura (venc.)</th>
                <th>Situação</th>
                <th>Data da compra/cobrança</th>
              </tr>
            </thead>
            <tbody>
              {p.slots.map((s) => (
                <tr key={s.number}>
                  <td>
                    {s.number}/{p.total}
                  </td>
                  <td>
                    <Go page="cards" params={{ cycle: s.cycle }}>
                      {monthName(s.cycle)}
                    </Go>
                  </td>
                  <td>
                    <span class="dot-status" style={{ background: SLOT_COLOR[s.status] }} /> {SLOT_LABEL[s.status]}
                    {s.inferred ? ' · estimada' : ''}
                  </td>
                  <td>{s.day ? s.day.split('-').reverse().join('/') : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

/** What the installments weigh on each bill, month by month. The colour is the least settled status in the month. */
export function MonthBars({ months, hidden, selected, onSelect, height = 110 }: { months: Array<{ cycle: string; paid: number; billed: number; open: number; future: number; count: number }>; hidden: boolean; selected?: string | null; onSelect?: (cycle: string) => void; height?: number }) {
  return (
    <Bars
      hidden={hidden}
      height={height}
      selected={selected ?? undefined}
      onSelect={onSelect}
      data={months.map((m) => {
        const status: InstallmentSlot['status'] = m.billed > 0 ? 'billed' : m.open > 0 ? 'open' : m.future > 0 ? 'future' : 'paid';
        const total = m.paid + m.billed + m.open + m.future;
        return {
          key: m.cycle,
          label: monthName(m.cycle).slice(0, 3),
          value: total,
          color: status === 'future' ? 'var(--muted)' : SLOT_COLOR[status],
          tip: `Fatura com venc. ${monthName(m.cycle)} · ${m.count} parcela(s)\n${hidden ? '••••' : brl(total)}\n${m.paid > 0 ? `pagas ${hidden ? '••••' : brl(m.paid)}\n` : ''}${m.billed > 0 ? `a pagar ${hidden ? '••••' : brl(m.billed)}\n` : ''}${m.open > 0 ? `no ciclo aberto ${hidden ? '••••' : brl(m.open)}\n` : ''}${m.future > 0 ? `ainda não cobradas ${hidden ? '••••' : brl(m.future)}` : ''}`.trim(),
        };
      })}
    />
  );
}
