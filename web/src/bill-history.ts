import type { Cycle } from '../../src/api/cycles.ts';
import { brl, dayMonth } from './format.ts';

/** A short text for a narrow table cell, with the long explanation that goes in its Info tooltip (null when the text says it all). */
export interface CellNote {
  /** Null when the badge next to it already says it: only the "i" with the explanation is shown. */
  text: string | null;
  tip: string | null;
  bad?: boolean;
}

/** What the owner can do about a bill from its row: call it settled, say it is still owed, or take back calling it settled. */
export type SettleAction = 'settle' | 'still-owe' | 'undo';

type HistoryCycle = Pick<Cycle, 'status' | 'billTotal' | 'charges' | 'credits' | 'paid' | 'outstanding' | 'overpaid' | 'latePaid' | 'adjusted' | 'edited'>;

/** The Fatura cell: the published total, or, with no bill published, the sum of what was posted and why it is not a bill. */
export function totalCell(c: HistoryCycle, hidden: boolean): CellNote {
  if (c.billTotal !== null) return { text: brl(c.billTotal, hidden), tip: null };
  return {
    text: `${brl(c.charges - c.credits, hidden)} lançado`,
    tip: c.status === 'open' ? 'Fatura ainda aberta: é a soma das compras lançadas até agora.' : 'O banco não publicou o total desta fatura: é a soma das compras lançadas no período.',
  };
}

/** Short lines under the amount paid: paid twice or more than the bill, and paid late. */
export function paidNotes(c: HistoryCycle, hidden: boolean): CellNote[] {
  const notes: CellNote[] = [];
  if (c.overpaid > 0) notes.push({ text: `a mais ${brl(c.overpaid, hidden)}`, tip: 'Os pagamentos desta janela passam do total da fatura. Pode ser pagamento em dobro, ou o pagamento atrasado de uma fatura anterior.', bad: true });
  if (c.latePaid) notes.push({ text: 'com atraso', tip: `${brl(c.latePaid.amount, hidden)} pagos com atraso em ${dayMonth(c.latePaid.day)}, depois do fechamento da fatura seguinte.` });
  return notes;
}

/** The Situação cell next to the status badge: a few words, the explanation for the tooltip, and the buttons the row offers. */
export function statusCell(c: HistoryCycle, hidden: boolean): { notes: CellNote[]; actions: SettleAction[] } {
  const notes: CellNote[] = [];
  let actions: SettleAction[] = [];
  if (c.adjusted?.by === 'auto') {
    notes.push({ text: `sobra ${brl(c.adjusted.amount, hidden)}`, tip: `${brl(c.adjusted.amount, hidden)} desta fatura não foi pago e provavelmente rolou para a fatura seguinte (o banco soma o que sobrou no próximo extrato, com juros), que foi paga por inteiro. Não conto de novo como devido.` });
    actions = ['settle', 'still-owe'];
  } else if (c.adjusted) {
    notes.push({ text: `${brl(c.adjusted.amount, hidden)} não cobrado`, tip: `${brl(c.adjusted.amount, hidden)} da fatura não foi cobrado: você marcou como quitada, então ela conta como paga.` });
    actions = ['undo'];
  } else if (c.outstanding > 0) {
    notes.push({ text: `falta ${brl(c.outstanding, hidden)}`, tip: null });
    actions = ['settle'];
  }
  if (c.status === 'unknown' && c.billTotal !== null) notes.push({ text: null, tip: 'Este cartão não tem lançamentos suficientes antes desta fatura para saber se foi paga. Se foi, marque em Editar.' });
  if (c.edited) notes.push({ text: 'editada', tip: 'Você mudou esta fatura em Editar (total, datas ou se foi paga).' });
  return { notes, actions };
}

export const SETTLE_LABEL: Record<SettleAction, string> = { settle: 'Marcar como quitada', 'still-owe': 'Ainda devo', undo: 'Desfazer' };

/** What each button saves: true calls the bill settled, false says it is still owed, null takes the owner's word back. */
export const SETTLE_VALUE: Record<SettleAction, boolean | null> = { settle: true, 'still-owe': false, undo: null };
