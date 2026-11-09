import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { namedTitle } from '../../src/core/title.ts';
import { categorizePending } from '../../src/ai/categorizer.ts';
import type { AiClient } from '../../src/ai/openrouter.ts';
import { explore, type ExplorerQuery } from '../../src/api/explorer.ts';
import { transactionsCsv } from '../../src/api/export.ts';
import { estimatedTransactions, installments } from '../../src/api/installments.ts';
import { cleanTransactionName, setTransactionName } from '../../src/api/mutations.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { effectiveTransactions, ruleKey } from '../../src/api/scope.ts';
import { spending } from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

// Invented data: an invented card, shops and amounts.
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

const card: CanonicalAccount = {
  id: 'c1', institution: 'Banco Exemplo', kind: 'credit_card', name: 'Cartão', last4: '0000', balance: 0, balanceSourceId: 'pierre', balanceAsOf: '2026-10-27T14:00:00Z',
  creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'ext-c1', role: 'member' }],
};

function tx(id: string, day: string, amount: number, description: string, installment: { number: number; total: number } | null = null, category: string | null = 'Compras'): CanonicalTransaction {
  return { id, accountId: 'c1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false };
}

const links = (list: CanonicalTransaction[], suffix = '') => list.map((t) => ({ sourceId: 'pierre', externalId: `e-${t.id.replace(suffix, '')}`, transactionId: t.id, matchPass: 0 }));

// Bills close on the 8th and are due on the 15th; July to October are published, so the open bill is the one due in November.
function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pierre', ['2026-07', '2026-08', '2026-09', '2026-10'].map((m, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-c1', dueDate: `${m}-15`, closingDate: `${m}-08`, total: 50000, minimumPayment: null })), NOW.toISOString());
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  const all = [tx('start', '2026-06-01', -100, 'CAFE PONTO'), ...list];
  store.replaceCanonicalTransactions(all, links(all), NOW.toISOString());
  return store;
}

const series = (description: string, total: number, amount: number, charges: Array<[number, string]>) => charges.map(([n, day]) => tx(`${description.split(' ')[0]}-${n}`, day, -amount, description, { number: n, total }));
const query = (extra: Partial<ExplorerQuery> = {}): ExplorerQuery => ({ kind: 'all', sort: 'date_asc', limit: 500, offset: 0, ...extra });
const byId = (store: ReturnType<typeof seeded>) => new Map(effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).map((t) => [t.id, t]));

test('the counter goes at the end of the name: n/total, or the number alone when the count is not known', () => {
  assert.equal(namedTitle('Notebook novo', { number: 1, total: 5 }), 'Notebook novo 1/5');
  assert.equal(namedTitle('Notebook novo', { number: 5, total: 5 }), 'Notebook novo 5/5');
  assert.equal(namedTitle('Notebook novo', { number: 3, total: null }), 'Notebook novo (parcela 3)');
  assert.equal(namedTitle('Notebook novo', { number: 3, total: 0 }), 'Notebook novo (parcela 3)');
  assert.equal(namedTitle('Notebook novo', { number: 7, total: 5 }), 'Notebook novo (parcela 7)', 'a count below the number is not a count');
  assert.equal(namedTitle('Presente', null), 'Presente', 'a plain transaction shows its name as it is');
});

test('a name typed in is cleaned and checked: spaces collapse, blank removes it, too long or not text is refused', () => {
  assert.deepEqual(cleanTransactionName('  Notebook   novo '), { ok: true, name: 'Notebook novo' });
  assert.deepEqual(cleanTransactionName('   '), { ok: true, name: null });
  assert.deepEqual(cleanTransactionName(''), { ok: true, name: null });
  assert.deepEqual(cleanTransactionName(null), { ok: true, name: null });
  assert.deepEqual(cleanTransactionName('a'.repeat(60)), { ok: true, name: 'a'.repeat(60) });
  for (const bad of ['a'.repeat(61), 42, undefined, ['x'], 'tab\u0007bell']) assert.equal(cleanTransactionName(bad).ok, false, String(bad));
});

test('the name of a plain transaction is stored on its source record, shown as it is, and survives a rebuild', () => {
  const list = [tx('gift', '2026-10-20', -12990, 'LOJA ESTRELA*CENTRO')];
  const store = seeded(list);
  assert.deepEqual(setTransactionName(store, 'gift', ' Presente da Ana ', NOW), { ok: true, changed: 1 });
  assert.deepEqual(store.recordChoice('pierre', 'e-gift'), { category: null, ignored: false, name: 'Presente da Ana' });
  const named = byId(store).get('gift')!;
  assert.deepEqual([named.title, named.customName, named.description], ['Presente da Ana', 'Presente da Ana', 'LOJA ESTRELA*CENTRO']);
  // A rebuild gives the canonical transaction a new id; the name follows its record.
  const rebuilt = [tx('start-v2', '2026-06-01', -100, 'CAFE PONTO'), tx('gift-v2', '2026-10-20', -12990, 'LOJA ESTRELA*CENTRO')];
  store.replaceCanonicalTransactions(rebuilt, links(rebuilt, '-v2'), NOW.toISOString());
  assert.equal(byId(store).get('gift-v2')?.title, 'Presente da Ana');
  // Blank text removes it, and the standard name comes back.
  assert.deepEqual(setTransactionName(store, 'gift-v2', '   ', NOW), { ok: true, changed: 1 });
  assert.deepEqual([byId(store).get('gift-v2')?.customName, store.listTransactionNames().size], [null, 0]);
});

test('the mutation refuses what it cannot name, and the route answers with how many transactions got the name', () => {
  const store = seeded([tx('gift', '2026-10-20', -12990, 'LOJA ESTRELA*CENTRO')]);
  assert.deepEqual(setTransactionName(store, 'nope', 'Algo', NOW), { ok: false, status: 404, error: 'not_found' });
  assert.equal(setTransactionName(store, 'gift', 'x'.repeat(61), NOW).ok, false);
  assert.equal(setTransactionName(store, 'gift', 7, NOW).ok, false);
  assert.equal(byId(store).get('gift')?.customName, null, 'a refused name changes nothing');
  const call = (id: string, body: string) => apiRoute('PUT', `/api/transactions/${id}/name`, new URLSearchParams(), store, NOW, body);
  assert.deepEqual(call('gift', '{"name":"Presente"}'), { status: 200, body: { ok: true, changed: 1 } });
  assert.equal(call('gift', '{}')?.status, 400);
  assert.equal(call('gift', '{"name":12}')?.status, 400);
  assert.equal(call('ghost', '{"name":"x"}')?.status, 404);
  assert.equal(apiRoute('GET', '/api/transactions/gift/name', new URLSearchParams(), store, NOW, '')?.status, 405);
  assert.equal(call('gift', '{"name":null}')?.status, 200);
  assert.equal(byId(store).get('gift')?.customName, null);
});

test('a name given on one installment is the name of the whole purchase, with the counter, also on the planned ones', () => {
  // 5 x 400,00: 1, 3 and 4 were charged; 2 was billed in August and never listed, 5 is still to come.
  const store = seeded(series('LOJA ELETRO', 5, 40000, [[1, '2026-07-02'], [3, '2026-09-02'], [4, '2026-10-12']]));
  assert.deepEqual(setTransactionName(store, 'LOJA-3', 'Notebook novo', NOW), { ok: true, changed: 3 });
  const rows = byId(store);
  assert.deepEqual(['LOJA-1', 'LOJA-3', 'LOJA-4'].map((id) => [rows.get(id)?.title, rows.get(id)?.description]), [
    ['Notebook novo 1/5', 'LOJA ELETRO'],
    ['Notebook novo 3/5', 'LOJA ELETRO'],
    ['Notebook novo 4/5', 'LOJA ELETRO'],
  ]);
  // The installments the bank bills but never listed, and the one to come.
  assert.deepEqual(estimatedTransactions(store, NOW).map((t) => [t.title, t.description, t.customName]), [
    ['Notebook novo 2/5', 'LOJA ELETRO 2/5', 'Notebook novo'],
    ['Notebook novo 5/5', 'LOJA ELETRO 5/5', 'Notebook novo'],
  ]);
  // The plan keeps the bank text and shows the name.
  const [purchase] = installments(store, NOW).purchases;
  assert.deepEqual([purchase?.description, purchase?.customName], ['LOJA ELETRO', 'Notebook novo']);
  // Clearing it on another installment clears the whole purchase.
  assert.deepEqual(setTransactionName(store, 'LOJA-1', null, NOW), { ok: true, changed: 3 });
  assert.deepEqual([...byId(store).values()].filter((t) => t.customName !== null), []);
  assert.equal(installments(store, NOW).purchases[0]?.customName, null);
});

test('an estimated installment can name its purchase, and the route takes its id', () => {
  const store = seeded(series('LOJA ELETRO', 5, 40000, [[1, '2026-07-02'], [3, '2026-09-02'], [4, '2026-10-12']]));
  const future = estimatedTransactions(store, NOW).find((t) => t.installment?.number === 5)!;
  const answer = apiRoute('PUT', `/api/transactions/${future.id}/name`, new URLSearchParams(), store, NOW, '{"name":"Notebook novo"}');
  assert.deepEqual(answer, { status: 200, body: { ok: true, changed: 3 } });
  assert.equal(byId(store).get('LOJA-1')?.title, 'Notebook novo 1/5');
  assert.equal(apiRoute('PUT', '/api/transactions/est_ip_000000000000_9/name', new URLSearchParams(), store, NOW, '{"name":"x"}')?.status, 404);
});

test('the name stays on the purchase when the bank changes the text halfway and when a new installment arrives', () => {
  const first = [...series('PARCELAMENTO DE COMPRA', 4, 25000, [[1, '2026-07-02'], [2, '2026-08-02']])];
  const store = seeded(first);
  setTransactionName(store, 'PARCELAMENTO-2', 'Bicicleta', NOW);
  // The next installment arrives with the store name added to the text (and a new record), after the name was given.
  const later = [tx('start', '2026-06-01', -100, 'CAFE PONTO'), ...first, tx('PARCELAMENTO-3', '2026-09-02', -25000, 'PARCELAMENTO DE COMPRA LOJA BIKE', { number: 3, total: 4 })];
  store.replaceCanonicalTransactions(later, links(later), NOW.toISOString());
  const rows = byId(store);
  assert.deepEqual([rows.get('PARCELAMENTO-3')?.title, rows.get('PARCELAMENTO-3')?.description], ['Bicicleta 3/4', 'PARCELAMENTO DE COMPRA LOJA BIKE']);
  assert.equal(store.recordChoice('pierre', 'e-PARCELAMENTO-3').name, null, 'the new record holds no name of its own: it shows the purchase name');
  // Another purchase with the same text but another amount is not touched.
  const other = [...later, tx('other-1', '2026-09-03', -9900, 'PARCELAMENTO DE COMPRA', { number: 1, total: 2 })];
  store.replaceCanonicalTransactions(other, links(other), NOW.toISOString());
  assert.equal(byId(store).get('other-1')?.customName, null);
  assert.equal(estimatedTransactions(store, NOW).find((t) => t.installment?.total === 4)?.title, 'Bicicleta 4/4');
});

test('the search finds a named transaction by its name and by the bank text, and the merchant grouping keeps the bank text', () => {
  const store = seeded([tx('p1', '2026-10-10', -1800, 'PADARIA CENTRAL'), tx('p2', '2026-10-11', -2200, 'PADARIA CENTRAL'), tx('gift', '2026-10-20', -12990, 'LOJA ESTRELA*CENTRO')]);
  setTransactionName(store, 'p1', 'Café com a equipe', NOW);
  const ids = (q: string) => explore(store, query({ q }), NOW).items.map((t) => t.id);
  assert.deepEqual(ids('café com'), ['p1']);
  assert.deepEqual(ids('padaria'), ['p1', 'p2']);
  assert.deepEqual(ids('equipe'), ['p1']);
  // Gastos by merchant groups by the shop the bank names, not by the owner's name.
  const groups = spending(store, { from: '2026-10-01', to: '2026-10-31' }, 'merchant', NOW).groups;
  assert.deepEqual(groups.map((g) => [g.name, g.count]), [['Loja Estrela Centro', 1], ['Padaria Central', 2]]);
});

test('rules and the AI read the bank text: a name changes no rule key, no rule match and nothing the model is asked', async () => {
  const store = seeded([tx('p1', '2026-10-10', -1800, 'PADARIA CENTRAL', null, null), tx('m1', '2026-10-12', -5400, 'MERCADO BOM PRECO', null, null), tx('x1', '2026-10-14', -700, 'IFD*LANCHE RAPIDO', null, null), tx('n1', '2026-10-15', -15000, 'POSTO AVENIDA', null, null)]);
  setTransactionName(store, 'p1', 'Café da manhã', NOW);
  setTransactionName(store, 'm1', 'Feira da semana', NOW);
  setTransactionName(store, 'x1', 'Lanche com a equipe', NOW);
  setTransactionName(store, 'n1', 'Gasolina do carro', NOW);
  const at = NOW.toISOString();
  store.setCategoryRule(ruleKey('PADARIA CENTRAL'), 'Alimentação', at);
  store.saveRule({ name: 'Mercado', priority: 10, active: true, conditions: { match: 'all', items: [{ field: 'description', operator: 'contains', value: 'MERCADO' }] }, actions: { category: 'Supermercado' } }, at);
  store.saveRule({ name: 'Pelo nome', priority: 20, active: true, conditions: { match: 'any', items: [{ field: 'description', operator: 'contains', value: 'gasolina' }, { field: 'merchant', operator: 'contains', value: 'gasolina' }] }, actions: { category: 'Transporte' } }, at);
  const rows = byId(store);
  assert.equal(ruleKey(rows.get('p1')!.description), ruleKey('PADARIA CENTRAL'));
  assert.deepEqual([rows.get('p1')?.category, rows.get('p1')?.categoryOrigin], ['Alimentação', 'rule']);
  assert.deepEqual([rows.get('m1')?.category, rows.get('m1')?.categoryOrigin], ['Supermercado', 'rule']);
  assert.deepEqual([rows.get('n1')?.category, rows.get('n1')?.categoryOrigin], [null, 'source'], 'a rule on the text of the name does not match');
  const asked: string[] = [];
  const client: AiClient = async (options) => {
    const items = JSON.parse(options.user) as Array<{ i: number; text: string }>;
    asked.push(...items.map((a) => a.text), options.user);
    return { content: JSON.stringify({ results: items.map((a) => ({ i: a.i, category: 'Delivery de comida', confidence: 'high' })) }), promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 1 };
  };
  await categorizePending(store, { client, models: ['m1'], now: () => NOW, monthlyBudgetUsd: 1 });
  assert.ok(asked.includes('IFD*LANCHE RAPIDO'), 'the model is asked about the bank text');
  assert.ok(!asked.some((a) => a.includes('Lanche com a equipe')), 'the model never sees the name');
  assert.equal(byId(store).get('x1')?.title, 'Lanche com a equipe');
});

test('the export shows the name in Nome and keeps the bank text in its own column', () => {
  const store = seeded([...series('LOJA ELETRO', 5, 40000, [[1, '2026-07-02'], [3, '2026-09-02'], [4, '2026-10-12']]), tx('gift', '2026-10-20', -12990, 'LOJA ESTRELA*CENTRO')]);
  setTransactionName(store, 'LOJA-4', 'Notebook novo', NOW);
  setTransactionName(store, 'gift', 'Presente; da Ana', NOW);
  const csv = transactionsCsv(explore(store, query({ from: '2026-10-01', to: '2026-10-31' }), NOW).items, (iso) => iso.slice(0, 10));
  const lines = csv.split('\r\n');
  assert.match(lines[0]!, /;Nome;Descrição do banco;/);
  assert.ok(lines.some((l) => l.includes(';Notebook novo 4/5;LOJA ELETRO;')), csv);
  assert.ok(lines.some((l) => l.includes(';"Presente; da Ana";LOJA ESTRELA*CENTRO;')), csv);
});
