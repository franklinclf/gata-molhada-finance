import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.ts';
import { AuthService } from '../../src/auth/service.ts';
import { base32Decode, generateTotpSecret, hotp, totpCounter } from '../../src/auth/totp.ts';
import { handle, type AppDeps, type AppRequest } from '../../src/http/app.ts';
import type { RouteResult } from '../../src/http/router.ts';
import { billCheck, billGapOf } from '../../src/api/bill-check.ts';
import type { ApplyResult, BillPreview, ImageOnly } from '../../src/api/bill-import.ts';
import { publishedSourceBills } from '../../src/api/cycles.ts';
import { PDF_SOURCE } from '../../src/core/sources.ts';
import type { Parties } from '../../src/core/parties.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { activeSourceIds } from '../../src/sync/adapters.ts';
import { buildPdf } from '../pdf/fixture-pdf.ts';
import { bradesco, bradescard, pad, pdfOf } from '../pdf/statements.ts';
import { card, tx } from '../support/builders.ts';

// Every merchant, card number and amount here is invented.

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const PASSWORD = 'a long test password';
const NOW = new Date('2026-04-10T12:00:00Z');
const T = NOW.toISOString();

const onBill = (billId: string): Parties => ({ operation: null, mcc: null, payer: null, receiver: null, billId });

/** A store with one Pluggy card (final 6203) whose March bill (R$ 170,50) lists only one of its charges, and a signed-in session. */
function setup() {
  const secret = generateTotpSecret();
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, { passwordHash: hashPassword(PASSWORD), totpSecret: secret, recoveryHashes: [] }, () => NOW);
  const deps: AppDeps = { store, version: 't', now: () => NOW, auth, secureCookies: true };
  const code = hotp(base32Decode(secret), totpCounter(NOW.getTime()));
  const login = handle({ method: 'POST', pathname: '/api/auth/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, code }) }, deps);
  const cookie = (login.headers['Set-Cookie'] ?? '').split(';')[0]!;
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T);
  store.upsertSourceAccounts('pluggy', [card({ externalId: 'pl-card', institution: 'Cartoes', name: 'Cartao Exemplo', last4: '6203' })], T);
  store.upsertSourceTransactions('pluggy', [
    // An older charge, so the card's history starts before the March bill and Conferir judges it.
    tx({ externalId: 'pl-old', accountExternalId: 'pl-card', occurredAt: '2026-01-20T03:00:00.000Z', amount: -5000, description: 'COMPRA ANTIGA', descriptionRaw: null }),
    // The statement prints this one on 20/02 as "MERCADO EXEMPLO"; Pluggy has another day and another text.
    tx({ externalId: 'pl-merc', accountExternalId: 'pl-card', occurredAt: '2026-02-25T03:00:00.000Z', amount: -12050, description: 'MERC EXEMPLO SP', descriptionRaw: null, parties: onBill('pl-bill-03') }),
  ], T);
  store.upsertSourceBills('pluggy', [{ externalId: 'pl-bill-03', accountExternalId: 'pl-card', dueDate: '2026-03-17', closingDate: '2026-03-03', total: 17050, minimumPayment: null }], T);
  runReconciliation(store, { now: () => NOW });
  const cardId = store.listCanonicalAccounts()[0]!.id;
  return { store, deps, cookie, cardId };
}

/** The statement for that bill: the market charge, an installment and a refund Pluggy does not have, and the payment of the previous bill. */
const MARCH = (rows = [
  { date: '18/02', desc: 'PAGAMENTO RECEBIDO - OBRIGADO', amount: '500,00', credit: true },
  { date: '20/02', desc: pad('MERCADO EXEMPLO', 'CIDADE UM'), amount: '120,50' },
  { date: '25/01', desc: `${'LOJA FICTICIA'.padEnd(24)}${'CIDADE DOIS'.padEnd(14)}(02/03)`, amount: '80,00' },
  { date: '10/02', desc: pad('ESTORNO LOJA', 'CIDADE TRES'), amount: '30,00', credit: true },
], total = '170,50', debits = '200,50') => pdfOf(bradescard({ total, previous: '500,00', credits: '530,00', debits, rows }));

const upload = (bytes: Uint8Array, cookie: string, type = 'application/pdf'): AppRequest => ({ method: 'POST', pathname: '/api/bill-files', search: 'name=fatura%20mar%C3%A7o.pdf', headers: { 'content-type': type, cookie }, body: '', bytes });
const post = (pathname: string, payload: unknown, cookie: string): AppRequest => ({ method: 'POST', pathname, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(payload) });
const call = (deps: AppDeps, request: AppRequest): { status: number; body: any } => {
  const r: RouteResult = handle(request, deps);
  return { status: r.status, body: r.body === null ? null : JSON.parse(r.body) };
};

test('a statement is previewed without writing, then applied: the shared charge joins Pluggy and the rest fills the bill', () => {
  const { store, deps, cookie, cardId } = setup();
  const before = store.listCanonicalTransactions({ includeExcluded: true });
  const merc = before.find((t) => t.amount === -12050)!;
  assert.deepEqual(billGapOf(store, NOW, cardId, '2026-03'), { billTotal: 17050, ours: 12050, gap: -5000 });
  assert.ok(billCheck(store, NOW).items.some((i) => i.cycleKey === '2026-03'));

  const preview = call(deps, upload(MARCH(), cookie));
  assert.equal(preview.status, 200);
  const p = preview.body as BillPreview;
  assert.equal(p.readable, true);
  assert.equal(p.issuer, 'bradescard');
  assert.equal(p.dueDate, '2026-03-17');
  assert.equal(p.total, 17050);
  assert.deepEqual(p.cards, [{ final: '6203', lines: 3, bill: true, targetId: cardId }]);
  assert.equal(p.lineCount, 3);
  assert.deepEqual(p.skipped, { payments: 1, inAnalysis: 0 });
  assert.deepEqual(p.counts, { already_there: 1, new: 2, possible_duplicate: 0, outside: 0 });
  assert.deepEqual(p.lines.map((l) => [l.description, l.match, l.matchId]), [['MERCADO EXEMPLO', 'already_there', merc.id], ['LOJA FICTICIA', 'new', null], ['ESTORNO LOJA', 'new', null]]);
  assert.deepEqual(p.otherBill, { total: 17050, closingDate: '2026-03-03' });
  assert.equal(p.gap?.gap, -5000);
  assert.equal(p.ready, true);
  // Nothing was written by the preview.
  assert.equal(store.listSourceIds().includes(PDF_SOURCE), false);
  assert.deepEqual(store.listCanonicalTransactions({ includeExcluded: true }), before);

  const applied = call(deps, post('/api/bill-files/apply', { fileHash: p.fileHash, accountId: cardId }, cookie));
  assert.equal(applied.status, 200);
  const a = applied.body as ApplyResult;
  assert.equal(a.lines, 3);
  assert.deepEqual(a.gaps, [{ accountId: cardId, cycleKey: '2026-03', before: { billTotal: 17050, ours: 12050, gap: -5000 }, after: { billTotal: 17050, ours: 17050, gap: 0 } }]);

  const after = store.listCanonicalTransactions({ includeExcluded: true });
  // The shared charge is one row, with Pluggy's day, amount and text; the two lines Pluggy lacks are added once each.
  assert.equal(after.length, before.length + 2);
  const joined = after.filter((t) => t.amount === -12050);
  assert.equal(joined.length, 1);
  assert.deepEqual([joined[0]!.id, joined[0]!.description, joined[0]!.occurredAt, joined[0]!.state, joined[0]!.sourceIds], [merc.id, 'MERC EXEMPLO SP', '2026-02-25T03:00:00.000Z', 'confirmed', ['pluggy', 'pdf']]);
  assert.equal(store.listTransactionLinks(merc.id).find((l) => l.sourceId === PDF_SOURCE)?.matchPass, 5);
  const added = after.filter((t) => t.sourceIds.join() === PDF_SOURCE);
  assert.deepEqual(added.map((t) => [t.description, t.amount, t.state, t.installment]).sort(), [['ESTORNO LOJA', 3000, 'single_source', null], ['LOJA FICTICIA', -8000, 'single_source', { number: 2, total: 3 }]]);
  // Conferir: the bill closes and is counted once, Pluggy's bill wins over the PDF copy of it.
  assert.equal(billCheck(store, NOW).items.some((i) => i.cycleKey === '2026-03'), false);
  assert.equal(publishedSourceBills(store).filter((b) => b.dueDate === '2026-03-17').map((b) => b.sourceId).join(), 'pluggy');
  // The PDF card is in the Pluggy card, not a card of its own, and owes nothing on its own.
  const accounts = store.listCanonicalAccounts();
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0]!.refs.map((r) => `${r.sourceId}:${r.role}`).sort(), ['pdf:member', 'pluggy:member']);
  assert.equal(accounts[0]!.balance, 30000);
  // Only the lines, the bill and the hash are kept.
  const raw = JSON.stringify([store.listSourceTransactions(PDF_SOURCE), store.listSourceAccounts(PDF_SOURCE), store.listBillImports()]);
  assert.ok(!raw.includes('TITULAR') && !raw.includes('CIDADE UM') && !raw.includes('fatura'));
});

test('applying the same statement again changes nothing, and a corrected one replaces its lines', () => {
  const { store, deps, cookie, cardId } = setup();
  const first = call(deps, upload(MARCH(), cookie)).body as BillPreview;
  call(deps, post('/api/bill-files/apply', { fileHash: first.fileHash }, cookie));
  const ids = store.listSourceTransactions(PDF_SOURCE).map((t) => t.externalId).sort();
  const rows = store.listCanonicalTransactions({ includeExcluded: true });
  // The owner's choice on a line the statement brought survives a new upload, because the ids do not change.
  const refund = rows.find((t) => t.description === 'ESTORNO LOJA')!;
  store.setCategoryOverride(refund.id, 'Compras', T);

  const again = call(deps, upload(MARCH(), cookie)).body as BillPreview;
  assert.equal(again.fileHash, first.fileHash);
  assert.equal(again.previous?.sameFile, true);
  assert.equal(call(deps, post('/api/bill-files/apply', { fileHash: again.fileHash }, cookie)).status, 200);
  assert.deepEqual(store.listSourceTransactions(PDF_SOURCE).map((t) => t.externalId).sort(), ids);
  assert.deepEqual(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => t.id).sort(), rows.map((t) => t.id).sort());
  assert.equal(store.listCategoryOverrides().get(refund.id), 'Compras');
  assert.deepEqual(store.listBillImports().map((i) => i.status), ['applied', 'replaced']);

  // The bank reissues the statement without the refund: the old line goes, nothing is left behind.
  const fixed = call(deps, upload(MARCH([
    { date: '18/02', desc: 'PAGAMENTO RECEBIDO - OBRIGADO', amount: '500,00', credit: true },
    { date: '20/02', desc: pad('MERCADO EXEMPLO', 'CIDADE UM'), amount: '120,50' },
    { date: '25/01', desc: `${'LOJA FICTICIA'.padEnd(24)}${'CIDADE DOIS'.padEnd(14)}(02/03)`, amount: '80,00' },
  ], '200,50', '200,50'), cookie)).body as BillPreview;
  assert.notEqual(fixed.fileHash, first.fileHash);
  assert.equal(fixed.previous?.sameFile, false);
  call(deps, post('/api/bill-files/apply', { fileHash: fixed.fileHash }, cookie));
  assert.deepEqual(store.listSourceTransactions(PDF_SOURCE).map((t) => t.description).sort(), ['LOJA FICTICIA', 'MERCADO EXEMPLO']);
  assert.equal(store.listCanonicalTransactions({ includeExcluded: true }).some((t) => t.description === 'ESTORNO LOJA'), false);
  assert.equal(store.listSourceBills(PDF_SOURCE).length, 1);
  assert.equal(store.listBillImports().filter((i) => i.status === 'applied').length, 1);
  assert.equal(billGapOf(store, NOW, cardId, '2026-03')?.gap, 3000);
});

test('a typed-in transaction the statement brings is listed, removed on request, and put back by undo', () => {
  const { store, deps, cookie, cardId } = setup();
  store.saveManualTransaction({ accountId: cardId, day: '2026-02-11', amount: 3000, description: 'Estorno digitado', category: null, notes: null }, T);
  runReconciliation(store, { now: () => NOW });
  assert.equal(billGapOf(store, NOW, cardId, '2026-03')?.gap, -8000);

  const p = call(deps, upload(MARCH(), cookie)).body as BillPreview;
  const manual = store.listManualTransactions()[0]!;
  assert.deepEqual(p.manualCandidates, [{ id: `man_${manual.id}`, accountId: cardId, day: '2026-02-11', amount: 3000, description: 'Estorno digitado' }]);
  assert.deepEqual(p.lines.find((l) => l.description === 'ESTORNO LOJA')?.match, 'possible_duplicate');
  // A typed-in transaction the preview did not offer cannot be removed.
  assert.equal(call(deps, post('/api/bill-files/apply', { fileHash: p.fileHash, removeManual: ['man_999'] }, cookie)).status, 409);

  const a = call(deps, post('/api/bill-files/apply', { fileHash: p.fileHash, removeManual: [`man_${manual.id}`] }, cookie)).body as ApplyResult;
  assert.equal(a.removedManual, 1);
  assert.equal(a.gaps[0]?.after?.gap, 0);
  assert.equal(store.listManualTransactions().length, 0);

  const list = call(deps, { method: 'GET', pathname: '/api/bill-files', headers: { cookie }, body: '' }).body.items;
  assert.deepEqual(list.map((i: { status: string; lineCount: number; removedManual: number; cardFinals: string[] }) => [i.status, i.lineCount, i.removedManual, i.cardFinals]), [['applied', 3, 1, ['6203']]]);
  const undone = call(deps, { method: 'DELETE', pathname: `/api/bill-files/${a.importId}`, headers: { cookie }, body: '' });
  assert.deepEqual(undone, { status: 200, body: { removed: 3, restoredManual: 1 } });
  assert.equal(store.listSourceTransactions(PDF_SOURCE).length, 0);
  assert.equal(store.listSourceBills(PDF_SOURCE).length, 0);
  assert.equal(store.listSourceAccounts(PDF_SOURCE).length, 0);
  assert.deepEqual(store.listManualTransactions().map((m) => [m.day, m.amount, m.description]), [['2026-02-11', 3000, 'Estorno digitado']]);
  assert.equal(billGapOf(store, NOW, cardId, '2026-03')?.gap, -8000);
  assert.equal(call(deps, { method: 'DELETE', pathname: `/api/bill-files/${a.importId}`, headers: { cookie }, body: '' }).status, 409);
});

test('a Bradesco statement with two cards goes to the one Pluggy card that lists both, and every line joins', () => {
  const { store, deps, cookie } = setup();
  store.upsertSourceAccounts('pluggy', [card({ externalId: 'pl-visa', institution: 'Bradesco Exemplo', name: 'Visa Exemplo', last4: '8850' })], T);
  store.upsertSourceTransactions('pluggy', [
    tx({ externalId: 'pl-v1', accountExternalId: 'pl-visa', occurredAt: '2026-02-21T03:00:00.000Z', amount: -4500, description: 'MERCADO TESTE', descriptionRaw: null, parties: onBill('pl-visa-03') }),
    tx({ externalId: 'pl-v2', accountExternalId: 'pl-visa', occurredAt: '2026-02-27T03:00:00.000Z', amount: -5000, description: 'FARMACIA EXEMPLO', descriptionRaw: null, parties: onBill('pl-visa-03') }),
  ], T);
  store.upsertSourceBills('pluggy', [{ externalId: 'pl-visa-03', accountExternalId: 'pl-visa', dueDate: '2026-03-20', closingDate: '2026-03-06', total: 9500, minimumPayment: null }], T);
  runReconciliation(store, { now: () => NOW });
  const visa = store.listCanonicalAccounts().find((a) => a.last4 === '8850')!;
  const rows = store.listCanonicalTransactions({ includeExcluded: true }).length;
  const bytes = pdfOf(bradesco({
    total: '95,00', previous: '0,00', credits: '0,00', debits: '95,00', head: [],
    sections: [
      { final: '8850', subtotal: '45,00', rows: [{ date: '21/02', desc: 'MERCADO TESTE', city: 'SAO PAULO', amount: '45,00' }] },
      { final: '5188', subtotal: '50,00', rows: [{ date: '27/02', desc: 'FARMACIA EXEMPLO', city: 'CURITIBA', amount: '50,00' }] },
    ],
  }));
  const p = call(deps, upload(bytes, cookie)).body as BillPreview;
  assert.deepEqual(p.cards.map((c) => [c.final, c.lines, c.bill, c.targetId]), [['8850', 1, true, visa.id], ['5188', 1, false, visa.id]]);
  assert.deepEqual(p.counts, { already_there: 2, new: 0, possible_duplicate: 0, outside: 0 });
  call(deps, post('/api/bill-files/apply', { fileHash: p.fileHash }, cookie));
  assert.equal(store.listCanonicalTransactions({ includeExcluded: true }).length, rows);
  const after = store.listCanonicalAccounts().find((a) => a.id === visa.id)!;
  assert.deepEqual(after.refs.filter((r) => r.sourceId === PDF_SOURCE).map((r) => [r.externalId, r.role]).sort(), [['pdf_bradesco_5188', 'member'], ['pdf_bradesco_8850', 'member']]);
  assert.equal(store.listCanonicalAccounts().length, 2);
});

test('a card picked for a section that Pluggy lists apart is kept, and a pick that is not a card is refused', () => {
  const { store, deps, cookie, cardId } = setup();
  const p = call(deps, upload(MARCH(), cookie)).body as BillPreview;
  assert.equal(call(deps, post('/api/bill-files/preview', { fileHash: p.fileHash, accountId: 'acc_nope' }, cookie)).status, 400);
  const again = call(deps, post('/api/bill-files/preview', { fileHash: p.fileHash, targets: { '6203': cardId } }, cookie));
  assert.equal(again.status, 200);
  assert.equal((again.body as BillPreview).cards[0]?.targetId, cardId);
  assert.equal(call(deps, post('/api/bill-files/apply', { fileHash: 'f'.repeat(64) }, cookie)).status, 410);
  assert.equal(store.listSourceIds().includes(PDF_SOURCE), false);
});

test('hostile or unreadable files get a readable answer and nothing is stored', () => {
  const { store, deps, cookie } = setup();
  const reply = (bytes: Uint8Array) => call(deps, upload(bytes, cookie));
  assert.deepEqual(reply(new TextEncoder().encode('MZ not a pdf at all')), { status: 422, body: { error: 'unreadable_pdf', message: 'O arquivo não é um PDF.' } });
  assert.match(reply(buildPdf([{ runs: [{ x: 1, y: 1, text: 'segredo' }] }], { encrypt: true })).body.message, /senha/);
  assert.match(reply(new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF')).body.message, /danificado|não/);
  const other = reply(pdfOf([(() => { const page = bradescard({ total: '1,00', previous: '0,00', credits: '0,00', debits: '1,00', rows: [] })[0]!; page.runs.splice(0, page.runs.length, { x: 40, y: 700, text: 'Extrato de conta corrente, nada de fatura aqui', size: 9 }, { x: 40, y: 680, text: 'Saldo do dia 12/05 de 1.000,00', size: 9 }); return page; })()]));
  assert.deepEqual([other.status, other.body.error], [422, 'unknown_layout']);
  const image = reply(buildPdf([{ images: [{ width: 30, height: 40, data: new Uint8Array(30 * 40 * 3) }] }]));
  assert.equal(image.status, 200);
  const io = image.body as ImageOnly;
  assert.deepEqual([io.readable, io.reason, io.images], [false, 'no_text', [{ page: 1, width: 30, height: 40, colorSpace: 'rgb', filter: 'none' }]]);
  assert.equal(call(deps, post('/api/bill-files/vision', { fileHash: io.fileHash }, cookie)).status, 501);
  assert.equal(reply(new Uint8Array(6 * 1024 * 1024 + 1)).status, 413);
  assert.equal(reply(new Uint8Array()).status, 400);
  // The upload takes a PDF body only, and no other route takes one.
  assert.equal(call(deps, upload(MARCH(), cookie, 'application/json')).status, 415);
  assert.equal(call(deps, { ...post('/api/bill-files/apply', {}, cookie), headers: { 'content-type': 'application/pdf', cookie } }).status, 415);
  assert.equal(call(deps, upload(MARCH(), '')).status, 401);
  assert.equal(store.listSourceIds().includes(PDF_SOURCE), false);
});

test('the PDF source is never retired, so it cannot be purged by mistake', () => {
  const { store, deps, cookie } = setup();
  const p = call(deps, upload(MARCH(), cookie)).body as BillPreview;
  call(deps, post('/api/bill-files/apply', { fileHash: p.fileHash }, cookie));
  assert.deepEqual(activeSourceIds([]), [PDF_SOURCE]);
  // With no adapter at all, Pluggy retires and the PDF source stays.
  assert.deepEqual(store.retireSourcesExcept(activeSourceIds([])), ['pluggy']);
  assert.throws(() => store.purgeSource(PDF_SOURCE, true), /still active/);
});
