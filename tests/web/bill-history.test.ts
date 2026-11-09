import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidNotes, SETTLE_LABEL, SETTLE_VALUE, statusCell, totalCell } from '../../web/src/bill-history.ts';
import { placeTip } from '../../web/src/tooltip.ts';

type Row = Parameters<typeof statusCell>[0];
const base: Row = { status: 'paid', billTotal: 50000, charges: 50000, credits: 0, paid: 50000, outstanding: 0, overpaid: 0, latePaid: null, adjusted: null, edited: null };
const words = (c: Row) => statusCell(c, false).notes.map((n) => n.text);

test('bill history: a cell says a few words and leaves the long explanation to the tooltip', () => {
  const manual = statusCell({ ...base, adjusted: { amount: 4200, by: 'manual' } }, false);
  assert.match(manual.notes[0]!.text!, /^R\$\s?42,00 não cobrado$/);
  assert.match(manual.notes[0]!.tip!, /você marcou como quitada/);
  assert.deepEqual(manual.actions.map((a) => SETTLE_LABEL[a]), ['Desfazer']);

  const rolled = statusCell({ ...base, status: 'rolled', adjusted: { amount: 4200, by: 'auto' } }, false);
  assert.match(rolled.notes[0]!.text!, /^sobra R\$\s?42,00$/);
  assert.match(rolled.notes[0]!.tip!, /rolou para a fatura seguinte/);
  assert.deepEqual(rolled.actions.map((a) => [SETTLE_LABEL[a], SETTLE_VALUE[a]]), [['Marcar como quitada', true], ['Ainda devo', false]]);
  for (const note of [...manual.notes, ...rolled.notes]) assert.ok(note.text!.length <= 24, `short enough for a narrow column: ${note.text}`);
});

test('bill history: an unpaid bill says what is missing and offers to call it settled; a paid one says nothing more', () => {
  const unpaid = statusCell({ ...base, status: 'unpaid', paid: 0, outstanding: 50000 }, false);
  assert.match(unpaid.notes[0]!.text!, /^falta R\$\s?500,00$/);
  assert.deepEqual(unpaid.actions, ['settle']);
  assert.deepEqual(statusCell(base, false), { notes: [], actions: [] });
  assert.deepEqual(words({ ...base, status: 'unknown', paid: 0 }), [null], 'the badge already says it: only the "i" with why');
  assert.deepEqual(words({ ...base, edited: { total: true, closing: false, due: false, status: false } }), ['editada']);
});

test('bill history: amounts are masked when values are hidden', () => {
  const unpaid = statusCell({ ...base, status: 'unpaid', paid: 0, outstanding: 50000 }, true);
  assert.doesNotMatch(unpaid.notes[0]!.text!, /\d/);
  assert.doesNotMatch(paidNotes({ ...base, overpaid: 1000, latePaid: { amount: 2000, day: '2026-10-20' } }, true).map((n) => `${n.text} ${n.tip}`).join(' '), /R\$\s?\d/);
});

test('bill history: paid twice or late, and a month with no published bill, read short with the reason in the tooltip', () => {
  const notes = paidNotes({ ...base, overpaid: 1000, latePaid: { amount: 2000, day: '2026-10-20' } }, false);
  assert.deepEqual(notes.map((n) => [n.text?.replace(/\s/g, ' '), n.bad ?? false]), [['a mais R$ 10,00', true], ['com atraso', false]]);
  assert.match(notes[1]!.tip!, /20\/10/);
  assert.equal(totalCell(base, false).tip, null);
  const open = totalCell({ ...base, status: 'open', billTotal: null, charges: 1200, credits: 200 }, false);
  assert.match(open.text!, /^R\$\s?10,00 lançado$/);
  assert.match(open.tip!, /ainda aberta/);
});

test('a tooltip opens under what it explains, stays in the window, and goes above when there is no room below', () => {
  const view = { width: 400, height: 800 };
  assert.deepEqual(placeTip({ left: 100, top: 200, bottom: 220 }, { width: 200, height: 80 }, view), { left: 100, top: 226 });
  assert.deepEqual(placeTip({ left: 350, top: 200, bottom: 220 }, { width: 200, height: 80 }, view), { left: 192, top: 226 }, 'moved left to stay inside');
  assert.deepEqual(placeTip({ left: 10, top: 760, bottom: 780 }, { width: 200, height: 80 }, view), { left: 10, top: 674 }, 'above, near the bottom of the window');
  assert.equal(placeTip({ left: 0, top: 0, bottom: 20 }, { width: 500, height: 80 }, view).left, 8, 'wider than the window: kept at the edge');
});
