import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.ts';
import { AuthService } from '../../src/auth/service.ts';
import { base32Decode, generateTotpSecret, hotp, totpCounter } from '../../src/auth/totp.ts';
import { handle, type AppDeps, type AppRequest } from '../../src/http/app.ts';
import type { AccountApplyResult, AccountPreview } from '../../src/api/account-import.ts';
import type { ApplyResult, BillPreview } from '../../src/api/bill-import.ts';
import { PDF_SOURCE } from '../../src/core/sources.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, card, tx } from '../support/builders.ts';
import { pdfOf } from '../pdf/statements.ts';
import { itau, nubank, pay99, type PayRow } from '../pdf/statements-banks.ts';

// Every name, id and amount here is invented.

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const PASSWORD = 'a long test password';
const NOW = new Date('2026-11-10T12:00:00Z');
const T = NOW.toISOString();

function setup() {
  const secret = generateTotpSecret();
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, { passwordHash: hashPassword(PASSWORD), totpSecret: secret, recoveryHashes: [] }, () => NOW);
  const deps: AppDeps = { store, version: 't', now: () => NOW, auth, secureCookies: true };
  const code = hotp(base32Decode(secret), totpCounter(NOW.getTime()));
  const login = handle({ method: 'POST', pathname: '/api/auth/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, code }) }, deps);
  const cookie = (login.headers['Set-Cookie'] ?? '').split(';')[0]!;
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T);
  return { store, deps, cookie };
}

const upload = (bytes: Uint8Array, cookie: string): AppRequest => ({ method: 'POST', pathname: '/api/bill-files', search: 'name=extrato.pdf', headers: { 'content-type': 'application/pdf', cookie }, body: '', bytes });
const send = (method: string, pathname: string, payload: unknown, cookie: string): AppRequest => ({ method, pathname, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(payload) });
const call = (deps: AppDeps, request: AppRequest): { status: number; body: any } => {
  const r = handle(request, deps);
  return { status: r.status, body: r.body === null ? null : JSON.parse(r.body) };
};

const ROWS: PayRow[] = [
  { id: '20261109001433434810333388922744', type: 'Lucro', amount: '3,11', when: '09/11/2026 04:06:46' },
  { id: '20261108001433434810333378066896', type: 'Corridas', amount: '-6,28', when: '07/11/2026 19:46:16' },
  { id: '20261108001433434810333378066485', type: 'Corridas', amount: '6,28', when: '07/11/2026 19:45:32' },
  { id: '20261102001433434810333333827707', type: '', amount: '-312,40', when: '02/11/2026 12:19:34', pix: 'enviado' },
  { id: '20261102001433434810333333969416', type: '', amount: '250,00', when: '02/11/2026 12:18:18', pix: 'recebido' },
  { id: '20251231001433434810333333333334', type: 'Lucro', amount: '1,50', when: '31/12/2025 05:00:00' },
];

/** Pluggy's own records of the same account: a few seconds apart from the statement's times, with other texts, and one it alone has. */
function pluggyAccount(store: ReturnType<typeof setup>['store']) {
  store.upsertSourceAccounts('pluggy', [account({ externalId: 'pl-99', institution: '99Pay', name: 'Conta 99Pay', balance: 5000 })], T);
  store.upsertSourceTransactions('pluggy', [
    tx({ externalId: 'p1', accountExternalId: 'pl-99', occurredAt: '2026-11-09T07:06:50.000Z', amount: 311, description: 'Rendimento', descriptionRaw: null }),
    tx({ externalId: 'p2', accountExternalId: 'pl-99', occurredAt: '2026-11-07T22:46:20.000Z', amount: -628, description: 'Corrida', descriptionRaw: null }),
    tx({ externalId: 'p3', accountExternalId: 'pl-99', occurredAt: '2026-11-07T22:45:35.000Z', amount: 628, description: 'Corrida estornada', descriptionRaw: null }),
    tx({ externalId: 'p4', accountExternalId: 'pl-99', occurredAt: '2026-11-02T15:18:20.000Z', amount: 25000, description: 'Pix recebido', descriptionRaw: null }),
    tx({ externalId: 'p5', accountExternalId: 'pl-99', occurredAt: '2026-11-05T12:00:00.000Z', amount: -4321, description: 'So o Pluggy tem', descriptionRaw: null }),
  ], T);
  runReconciliation(store, { now: () => NOW });
  return store.listCanonicalAccounts().find((a) => a.institution === '99Pay')!.id;
}

test('a 99Pay statement joins Pluggy one to one (a charge and its reversal stay two), adds what is missing, and re-applies and undoes cleanly', () => {
  const { store, deps, cookie } = setup();
  const accountId = pluggyAccount(store);
  const before = store.listCanonicalTransactions({ includeExcluded: true });
  assert.equal(before.length, 5);

  const up = call(deps, upload(pdfOf(pay99(ROWS)), cookie));
  assert.equal(up.status, 200);
  const p = up.body as AccountPreview;
  assert.equal(p.statementKind, 'account');
  assert.equal(p.targetId, accountId);
  assert.equal(p.ready, true);
  assert.equal(p.lineCount, 6);
  assert.deepEqual(p.counts, { already_there: 4, new: 1, possible_duplicate: 0, outside: 1 });
  assert.deepEqual(p.lines.map((l) => [l.amount, l.match]), [[311, 'already_there'], [-628, 'already_there'], [628, 'already_there'], [-31240, 'new'], [25000, 'already_there'], [150, 'outside']]);
  assert.equal(p.lines[3]!.description, 'Pagamento com Pix enviado');
  assert.equal(store.listSourceIds().includes(PDF_SOURCE), false);

  const applied = call(deps, send('POST', '/api/bill-files/apply', { fileHash: p.fileHash }, cookie));
  assert.equal(applied.status, 200);
  assert.equal((applied.body as AccountApplyResult).lines, 6);
  const after = store.listCanonicalTransactions({ includeExcluded: true });
  assert.equal(after.length, 6);
  assert.equal(after.filter((t) => t.amount === 628).length, 1);
  assert.equal(after.filter((t) => t.amount === -628).length, 1);
  assert.deepEqual(after.filter((t) => t.sourceIds.length === 2).map((t) => t.amount).sort((a, b) => a - b), [-628, 311, 628, 25000]);
  assert.equal(store.listCanonicalAccounts().length, 1);
  assert.deepEqual(store.listBillImports().map((i) => [i.issuer, i.status, i.lineCount, i.cardFinals]), [['99pay', 'applied', 6, []]]);
  assert.equal(store.listSourceBills(PDF_SOURCE).length, 0);
  const raw = JSON.stringify([store.listSourceTransactions(PDF_SOURCE), store.listSourceAccounts(PDF_SOURCE), store.listBillImports()]);
  assert.ok(!raw.includes('FICTICIA') && !raw.includes('100000001'));

  // Again: same records, same canonical rows.
  const ids = store.listSourceTransactions(PDF_SOURCE).map((t) => t.externalId).sort();
  const rows = after.map((t) => t.id).sort();
  const again = call(deps, upload(pdfOf(pay99(ROWS)), cookie)).body as AccountPreview;
  assert.equal(again.previous?.sameFile, true);
  assert.equal(call(deps, send('POST', '/api/bill-files/apply', { fileHash: again.fileHash }, cookie)).status, 200);
  assert.deepEqual(store.listSourceTransactions(PDF_SOURCE).map((t) => t.externalId).sort(), ids);
  assert.deepEqual(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => t.id).sort(), rows);
  assert.deepEqual(store.listBillImports().map((i) => i.status), ['applied', 'replaced']);

  // A corrected extract of the same period replaces the lines (the Pix sent is gone).
  const fixed = call(deps, upload(pdfOf(pay99(ROWS.filter((r) => r.pix !== 'enviado'))), cookie)).body as AccountPreview;
  assert.equal(fixed.previous?.sameFile, false);
  call(deps, send('POST', '/api/bill-files/apply', { fileHash: fixed.fileHash }, cookie));
  assert.equal(store.listSourceTransactions(PDF_SOURCE).length, 5);
  assert.equal(store.listCanonicalTransactions({ includeExcluded: true }).length, 5);

  // Undo returns to what Pluggy alone had.
  const importId = store.listBillImports().find((i) => i.status === 'applied')!.id;
  assert.equal(call(deps, send('DELETE', `/api/bill-files/${importId}`, {}, cookie)).status, 200);
  assert.deepEqual(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => t.id).sort(), before.map((t) => t.id).sort());
  assert.equal(store.listSourceTransactions(PDF_SOURCE).length, 0);
  assert.equal(store.listCanonicalAccounts().length, 1);
});

test('a 99Pay statement needs a payment account: without one the preview is not ready, and a card is refused as target', () => {
  const { store, deps, cookie } = setup();
  store.upsertSourceAccounts('pluggy', [card({ externalId: 'pl-card', institution: 'Cartoes', name: 'Cartao Exemplo', last4: '1111' })], T);
  runReconciliation(store, { now: () => NOW });
  const p = call(deps, upload(pdfOf(pay99(ROWS)), cookie)).body as AccountPreview;
  assert.equal(p.ready, false);
  assert.deepEqual(p.accounts, []);
  const cardId = store.listCanonicalAccounts()[0]!.id;
  assert.equal(call(deps, send('POST', '/api/bill-files/preview', { fileHash: p.fileHash, accountId: cardId }, cookie)).status, 400);
  assert.equal(call(deps, send('POST', '/api/bill-files/apply', { fileHash: p.fileHash }, cookie)).status, 400);
});

test('Nubank and Itaú statements go through the same upload, preview and apply as the other cards', () => {
  const { store, deps, cookie } = setup();
  store.upsertSourceAccounts('pluggy', [card({ externalId: 'pl-nu', institution: 'Nubank', name: 'Cartao Nu', last4: '1111' }), card({ externalId: 'pl-it', institution: 'Itau', name: 'Cartao It', last4: '4321' })], T);
  store.upsertSourceTransactions('pluggy', [tx({ externalId: 'old', accountExternalId: 'pl-nu', occurredAt: '2026-01-20T12:00:00.000Z', amount: -100, description: 'ANTIGA', descriptionRaw: null })], T);
  runReconciliation(store, { now: () => NOW });
  const nu = nubank({
    due: '21 AGO 2026', emission: '14 AGO 2026', previous: '0,00', payment: '0,00', purchases: '300,00', total: '300,00',
    sections: [{ name: 'Pessoa Ficticia', total: '300,00', rows: [{ date: '16 JUL', card: '1111', desc: 'Mercado Beta', amount: 'R$ 100,00' }, { date: '17 JUL', card: '1111', desc: 'Loja Alfa - Parcela 2/3', amount: 'R$ 200,00' }] }],
    payments: [],
  });
  const p = call(deps, upload(pdfOf(nu), cookie)).body as BillPreview;
  assert.equal(p.statementKind, 'card');
  assert.equal(p.issuer, 'nubank');
  assert.deepEqual(p.cards.map((c) => [c.final, c.lines, c.bill]), [['1111', 2, true]]);
  assert.equal(p.ready, true);
  const a = call(deps, send('POST', '/api/bill-files/apply', { fileHash: p.fileHash }, cookie));
  assert.equal(a.status, 200);
  assert.equal((a.body as ApplyResult).lines, 2);
  const it = call(deps, upload(pdfOf(itau({ due: '15/11/2026', emission: '08/11/2026', previous: '0,00', paid: '0,00', financed: '0,00', current: '50,00', total: '50,00', payments: [], purchases: [{ date: '11/10', desc: 'APP BETA', amount: '50,00' }] })), cookie)).body as BillPreview;
  assert.equal(it.issuer, 'itau');
  assert.equal(it.lineCount, 1);
  assert.deepEqual(it.cards.map((c) => c.final), ['4321']);
});
