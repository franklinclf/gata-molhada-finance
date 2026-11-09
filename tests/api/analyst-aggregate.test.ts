import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { RefBook, toolByName } from '../../src/ai/analyst-tools.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');

const acc = (id: string, overrides: Partial<CanonicalAccount>): CanonicalAccount => ({
  id, institution: 'Banco A', kind: 'checking', name: 'Conta', last4: '1111', balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(),
  creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [], ...overrides,
});
const tx = (id: string, accountId: string, day: string, amount: number, description: string, category: string): CanonicalTransaction => ({
  id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy'], excluded: false,
});

/** Built by hand so every expected number below can be added up on paper. */
function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.replaceCanonicalAccounts([acc('chk', {}), acc('card', { institution: 'Banco B', kind: 'credit_card', name: 'Cartão', last4: '2222' })], [], NOW.toISOString());
  const list = [
    tx('a', 'chk', '2026-10-02', -10000, 'Mercado Central', 'Supermercado'),
    tx('b', 'chk', '2026-10-09', -25000, 'Mercado Central', 'Supermercado'),
    tx('c', 'card', '2026-10-10', -4000, 'Cantina Bela', 'Restaurantes e bares'),
    tx('d', 'card', '2026-10-16', -6000, 'Cantina Bela', 'Restaurantes e bares'),
    tx('e', 'chk', '2026-10-05', -120000, 'Aluguel Apto', 'Aluguel'),
    tx('f', 'chk', '2026-09-20', -30000, 'MERCADO CENTRAL 12', 'Supermercado'),
    tx('g', 'chk', '2026-10-05', 500000, 'Salario Empresa', 'Renda'),
  ];
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), NOW.toISOString());
  return store;
}

const run = (store: ReturnType<typeof seeded>, name: string, args: Record<string, unknown>, ctx?: { refs: RefBook }) => toolByName.get(name)!.run(store, NOW, args, ctx) as Record<string, any>;
const wide = { from: '2026-09-01', to: '2026-10-28' };

test('aggregate by month and category adds up each group and the whole, and months come in order', () => {
  const out = run(seeded(), 'aggregate', { ...wide, groupBy: ['month', 'category'] });
  assert.deepEqual(out.agrupadoPor, ['month', 'category']);
  assert.deepEqual(out.grupos.map((g: any) => [g.chave, g.soma, g.quantidade, g.media, g.maior]), [
    [['2026-09', 'Supermercado'], 300, 1, 300, 300],
    [['2026-10', 'Aluguel'], 1200, 1, 1200, 1200],
    [['2026-10', 'Restaurantes e bares'], 100, 2, 50, 60],
    [['2026-10', 'Supermercado'], 350, 2, 175, 250],
  ]);
  assert.equal(out.somaTotal, 1950, 'the total is the sum of every row, not only the groups shown');
  assert.equal(out.quantidadeTotal, 6);
});

test('aggregate by group, by merchant and by weekday, ordered by the chosen metric', () => {
  const store = seeded();
  const groups = run(store, 'aggregate', { from: '2026-10-01', to: '2026-10-28', groupBy: 'group' });
  assert.deepEqual(groups.grupos.map((g: any) => [g.chave[0], g.soma]), [['Casa', 1200], ['Alimentação', 450]]);

  const merchants = run(store, 'aggregate', { ...wide, groupBy: ['merchant'], metric: 'count' });
  assert.deepEqual(merchants.grupos.map((g: any) => [g.chave[0], g.quantidade]), [['Mercado Central', 3], ['Cantina Bela', 2], ['Aluguel Apto', 1]]);
  assert.equal(merchants.ordenadoPor, 'count');

  const days = run(store, 'aggregate', { ...wide, groupBy: ['weekday'], metric: 'sum' });
  assert.deepEqual(days.grupos.map((g: any) => [g.chave[0], g.soma]), [['segunda', 1200], ['sexta', 410], ['domingo', 300], ['sábado', 40]]);
});

test('aggregate keeps the filters of transactions: accounts, categories, text, amounts, kind', () => {
  const store = seeded();
  const card = run(store, 'aggregate', { ...wide, groupBy: ['account'], accounts: ['Banco B 2222'] });
  assert.deepEqual(card.grupos.map((g: any) => [g.chave[0], g.soma]), [['Banco B 2222', 100]]);
  const named = run(store, 'aggregate', { ...wide, groupBy: ['institution'], accounts: ['conta'] });
  assert.deepEqual(named.grupos.map((g: any) => g.chave[0]), ['Banco A']);
  const two = run(store, 'aggregate', { ...wide, groupBy: ['category'], categories: ['Aluguel', 'Supermercado'] });
  assert.deepEqual(two.grupos.map((g: any) => g.chave[0]), ['Aluguel', 'Supermercado']);
  const text = run(store, 'aggregate', { ...wide, groupBy: ['category'], q: 'cantina' });
  assert.equal(text.somaTotal, 100);
  const big = run(store, 'aggregate', { ...wide, groupBy: ['category'], min: 200 });
  assert.deepEqual(big.grupos.map((g: any) => [g.chave[0], g.soma]), [['Aluguel', 1200], ['Supermercado', 550]]);
  const income = run(store, 'aggregate', { ...wide, groupBy: ['category'], kind: 'income' });
  assert.deepEqual(income.grupos.map((g: any) => [g.chave[0], g.soma]), [['Renda', 5000]]);
  const all = run(store, 'aggregate', { ...wide, groupBy: ['month'], kind: 'all' });
  assert.deepEqual(all.grupos.map((g: any) => [g.chave[0], g.soma]), [['2026-09', -300], ['2026-10', 5000 - 1200 - 350 - 100]], 'with both kinds money out keeps its minus sign');
});

test('aggregate is bounded and refuses bad groupings', () => {
  const store = seeded();
  const one = run(store, 'aggregate', { ...wide, groupBy: ['merchant'], limit: 1 });
  assert.equal(one.grupos.length, 1);
  assert.match(one.observacao, /mostrando 1 de 3 grupos/);
  assert.equal(run(store, 'aggregate', { ...wide, groupBy: ['merchant'], limit: 500 }).grupos.length, 3, 'capped at 30 groups, here only 3 exist');
  for (const groupBy of [[], ['color'], ['category', 'month', 'account'], ['category', 'category'], undefined]) assert.throws(() => run(store, 'aggregate', { ...wide, groupBy }), /groupBy must be/);
  assert.throws(() => run(store, 'aggregate', { ...wide, groupBy: ['category'], accounts: ['Banco Z'] }), /no account is called/);
  assert.throws(() => run(store, 'aggregate', { from: '2026-10-28', to: '2026-10-01', groupBy: ['category'] }), /from must not be after to/);
});

test('transactions rows carry a ref only inside a run, and the same transaction keeps its ref', () => {
  const store = seeded();
  const alone = run(store, 'transactions', { from: '2026-10-01', to: '2026-10-28', q: 'cantina' });
  assert.ok(alone.transacoes.every((t: any) => t.ref === undefined));
  const ctx = { refs: new RefBook() };
  const first = run(store, 'transactions', { from: '2026-10-01', to: '2026-10-28', q: 'cantina' }, ctx);
  assert.deepEqual(first.transacoes.map((t: any) => t.ref), ['t1', 't2']);
  const again = run(store, 'transactions', { from: '2026-10-01', to: '2026-10-28', q: 'cantina', accounts: ['Cartão'] }, ctx);
  assert.deepEqual(again.transacoes.map((t: any) => t.ref), ['t1', 't2']);
  assert.equal(ctx.refs.get('t1', 't') !== undefined, true);
  assert.equal(ctx.refs.get('t9', 't'), undefined);
  assert.equal(new RefBook().get('t1', 't'), undefined, 'a handle from another run finds nothing');
});

test('suggestions, categories, accounts, rules and income give names the write tools accept', () => {
  const store = seeded();
  const s = run(store, 'suggestions', {});
  assert.deepEqual(s.regras.map((r: any) => [r.estabelecimento, r.categoria, r.transacoes, r.divergentes]), [['Mercado Central', 'Supermercado', 3, 0]]);
  assert.deepEqual(s.orcamentos.linhas.map((l: any) => [l.categoria, l.sugerido]), [['Supermercado', 100]]);
  assert.deepEqual(s.possiveisDuplicatas, []);
  assert.deepEqual(s.categoriasSugeridasPelaIA, []);
  assert.deepEqual(s.rendasSemCadastro, []);
  assert.deepEqual(Object.keys(run(store, 'suggestions', { kind: 'rules' })), ['regras']);

  const cats = run(store, 'categories', {}).categorias.map((c: any) => c.nome);
  assert.ok(cats.includes('Supermercado') && cats.includes('Pagamento de fatura') && cats.includes('Investimentos'));
  assert.deepEqual(run(store, 'accounts', {}).contas.map((c: any) => [c.conta, c.tipo, c.final]), [['Banco A 1111', 'conta corrente', '1111'], ['Banco B 2222', 'cartão de crédito', '2222']]);
  assert.deepEqual(run(store, 'rules', {}).regras, []);
  assert.deepEqual(run(store, 'income_items', {}).rendas, []);
});

test('aggregate of expenses is net of card refunds, like spending, and counts only the purchases', () => {
  const store = seeded();
  const list = [
    tx('p', 'card', '2026-10-20', -10000, 'Loja Verde', 'Vestuário e acessórios'),
    tx('r', 'card', '2026-10-22', 4000, 'Loja Verde', 'Vestuário e acessórios'),
  ];
  const now = NOW.toISOString();
  const all = [
    ...store.listCanonicalTransactions(),
    ...list,
  ];
  store.replaceCanonicalTransactions(all, all.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), now);
  const only = { from: '2026-10-20', to: '2026-10-28', category: 'Vestuário e acessórios' };
  const out = run(store, 'aggregate', { ...only, groupBy: 'category' });
  const spent = run(store, 'spending', { from: only.from, to: only.to, by: 'category' });
  assert.deepEqual(out.grupos.map((g: any) => [g.chave, g.soma, g.quantidade, g.media, g.maior]), [[['Vestuário e acessórios'], 60, 1, 60, 100]]);
  assert.equal(out.somaTotal, 60);
  assert.equal(out.quantidadeTotal, 1);
  assert.equal(spent.grupos.find((g: any) => g.nome === 'Vestuário e acessórios').valor, out.somaTotal, 'same figure as the spending tool');
  assert.match(out.observacao, /estornos/);
  // Asking for every kind keeps the signed rows as they are.
  const signed = run(store, 'aggregate', { ...only, groupBy: 'category', kind: 'all' });
  assert.equal(signed.somaTotal, -60);
});
