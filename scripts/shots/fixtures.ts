import { fileURLToPath } from 'node:url';
import { apiRoute } from '../../src/api/routes.ts';
import { monthRange } from '../../src/api/views.ts';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { createGoal } from '../../src/api/goals.ts';
import { addAsset } from '../../src/api/networth.ts';
import { setBudget } from '../../src/api/budgets.ts';
import { createRule } from '../../src/api/rules.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { addDays, addMonthsToDay } from '../../src/api/cycles.ts';
import { localDay } from '../../src/core/time.ts';
import { saveIncome } from '../../src/api/income.ts';

/**
 * Invented but realistic data, so the screens can be looked at without the real database or a running server.
 * Deterministic: the same call gives the same data. Nothing here comes from a real account.
 */
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!;

const SHOPS: Array<[string, string, number, number]> = [
  ['EXTRA HIPER-1365', 'Groceries', 4000, 26000],
  ['PAO DE ACUCAR 0452', 'Groceries', 3000, 18000],
  ['Uber UBER *TRIP HELP.U SA', 'Taxi and ride-hailing', 900, 3500],
  ['DL*UberRides', 'Taxi and ride-hailing', 700, 2800],
  ['IFD*PIZZARIA DO ZE', 'Food delivery', 3500, 9000],
  ['RAPPI*Rappi Brasil Int Sa', 'Food delivery', 2200, 7000],
  ['DROGASIL 1203', 'Pharmacy', 1500, 14000],
  ['AMAZON BR SA', 'Shopping', 2500, 19000],
  ['SHOPEE *MillsUtensilio', 'Shopping', 1500, 9000],
  ['RESTAURANTE SABOR CASEIRO', 'Eating out', 4500, 12000],
  ['POSTO SHELL AV BRASIL', 'Compras', 9000, 20000],
  ['SMART FIT ACADEMIA', 'Gyms and fitness centers', 11990, 11990],
];

export interface Fixtures {
  now: string;
  responses: Record<string, unknown>;
  /** A due month (YYYY-MM) of a closed bill, for photographing a past cycle. */
  pastCycle: string | null;
}

/**
 * `default` is a typical month. `empty` is a new install with nothing connected. `dense` adds more cards and accounts,
 * long names and large values, to find text that overflows and lists that get cut.
 */
export type FixtureVariant = 'default' | 'empty' | 'dense';

export function buildFixtures(now = new Date(), variant: FixtureVariant = 'default'): Fixtures {
  if (variant === 'empty') return emptyFixtures(now);
  seed = 7;
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const at = now.toISOString();
  const today = localDay(at);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, at);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, at);

  const base = (over: Partial<CanonicalAccount>): CanonicalAccount => ({
    id: 'x', institution: 'Banco Alfa', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: new Date(now.getTime() - 40 * 60_000).toISOString(),
    creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [], ...over,
  });
  const dense = variant === 'dense';
  const accounts: CanonicalAccount[] = [
    base({ id: 'chk1', institution: 'Banco Alfa', name: 'Conta corrente', balance: 421035 }),
    base({ id: 'sav1', institution: 'Banco Beta', kind: 'savings', name: 'Poupança', balance: 250000, balanceAsOf: new Date(now.getTime() - 26 * 3_600_000).toISOString() }),
    base({ id: 'chk2', institution: 'Banco Beta', name: 'Conta corrente', balance: 189000 }),
    base({ id: 'wallet', institution: 'Carteira Pay', name: 'Conta digital', balance: 33210 }),
    base({ id: 'cardA', institution: 'Banco Alfa', kind: 'credit_card', name: 'Gold', last4: '1111', balance: 336581, creditLimit: 1840000, availableLimit: 1503419, limitGroupId: 'lgA', refs: [{ sourceId: 'pluggy', externalId: 'ext-cardA', role: 'member' }] }),
    base({ id: 'cardA2', institution: 'Banco Alfa', kind: 'credit_card', name: 'Platinum', last4: '2222', balance: 336581, creditLimit: 1840000, availableLimit: 1503419, limitGroupId: 'lgA', refs: [{ sourceId: 'pluggy', externalId: 'ext-cardA2', role: 'member' }] }),
    base({ id: 'cardB', institution: 'Banco Beta', kind: 'credit_card', name: 'Click', last4: '0101', balance: 28090, creditLimit: 518500, availableLimit: 490410, refs: [{ sourceId: 'pluggy', externalId: 'ext-cardB', role: 'member' }] }),
    base({ id: 'cardC', institution: 'Carteira Pay', kind: 'credit_card', name: 'Roxo', last4: '0202', balance: 120535, creditLimit: 840000, availableLimit: 719465, refs: [{ sourceId: 'pluggy', externalId: 'ext-cardC', role: 'member' }] }),
    ...(dense
      ? [
          base({ id: 'chk3', institution: 'Cooperativa de Crédito Regional do Vale do Rio Grande', name: 'Conta corrente conjunta com nome bem comprido', balance: 123456789 }),
          base({ id: 'inv1', institution: 'Corretora Gama Investimentos', kind: 'savings', name: 'Renda fixa com liquidez diária', balance: 98765432 }),
          base({ id: 'cardD', institution: 'Cooperativa de Crédito Regional do Vale do Rio Grande', kind: 'credit_card', name: 'Black Infinite Pontos Mais', last4: '9001', balance: 4567890, creditLimit: 9000000, availableLimit: 4432110, dueDate: null, refs: [{ sourceId: 'pluggy', externalId: 'ext-cardD', role: 'member' }] }),
          base({ id: 'cardE', institution: 'Banco Delta', kind: 'credit_card', name: 'Virtual', last4: '3003', balance: 0, creditLimit: 150000, availableLimit: 150000, refs: [{ sourceId: 'pluggy', externalId: 'ext-cardE', role: 'member' }] }),
        ]
      : []),
  ];
  store.replaceCanonicalAccounts(accounts, [{ id: 'lgA', institution: 'Banco Alfa', creditLimit: 1840000, memberIds: ['cardA', 'cardA2'] }], at);

  const list: CanonicalTransaction[] = [];
  let n = 0;
  const cardIds = new Set(accounts.filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const add = (accountId: string, day: string, amount: number, description: string, category: string | null, extra: Partial<CanonicalTransaction> = {}) => {
    // A bank account has nothing dated after today; only a card can hold a future installment.
    if (!cardIds.has(accountId) && day > today) return;
    list.push({ id: `t${++n}`, accountId, occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: description, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy', 'pluggy'], excluded: false, ...extra });
  };

  const cards = dense ? ['cardA', 'cardA2', 'cardB', 'cardC', 'cardD'] : ['cardA', 'cardA2', 'cardB', 'cardC'];
  for (let back = 0; back < 180; back++) {
    const day = addDays(today, -back);
    if (rand() < 0.8) {
      const [text, label, min, max] = pick(SHOPS);
      add(pick(cards), day, -Math.round(min + rand() * (max - min)), text, label);
    }
    if (rand() < 0.25) add('chk1', day, -Math.round(1500 + rand() * 9000), pick(['PIX ENVIADO JOAO PEREIRA', 'Transferência enviada|Maria Souza']), 'Transfers');
    if (dense && rand() < 0.6) add('cardD', day, -Math.round(20000 + rand() * 400000), pick(['MERCADOLIVRE*VENDEDOR COM UM NOME MUITO GRANDE LTDA', 'PAG*RESTAURANTE E CHOPERIA DO CENTRO HISTORICO', 'COMPANHIA AEREA INTERNACIONAL PASSAGENS']), pick(['Shopping', 'Eating out', 'Travel']));
  }
  for (let m = 0; m < 6; m++) {
    const first = addMonthsToDay(`${today.slice(0, 7)}-05`, -m);
    add('chk1', first, 650000, 'SALARIO EMPRESA XYZ S.A.', 'Salary');
    add('chk1', addDays(first, 4), -150000, 'ALUGUEL APT 302 PIX', 'Aluguel do mês');
    add('chk1', addDays(first, 6), -21050, 'ENEL DISTRIBUICAO', 'Housing');
    add('chk1', addDays(first, 8), -50000, 'Transferência mesma titularidade', 'Same person transfer');
    add('chk2', addDays(first, 8), 50000, 'Transferência mesma titularidade', 'Same person transfer');
    add('chk1', addDays(first, 10), -28570, 'Aplicação APL APLIC AUT MAIS', 'Automatic investment');
    for (const card of cards) {
      add(card, addDays(first, 3), -3990, 'NETFLIX.COM', 'Video streaming');
      add(card === 'cardA2' ? 'cardA' : card, addDays(first, 2), -2390, 'EBN*SPOTIFY CU', 'Music streaming');
    }
  }
  for (let k = 0; k < 4; k++) add('cardA', addDays(today, -35 * k - 3), -28305, 'EXTRAFARMA C*pagu', 'Pharmacy', { installment: { number: 3 - k >= 1 ? 3 - k : 1, total: 3 } });
  for (let k = 0; k < 3; k++) add('cardC', addDays(today, -31 * k - 5), -16982, 'Shopping do Nu', 'Shopping', { installment: { number: 9 - k, total: 10 } });
  add('cardC', addDays(today, -3), -99900, 'Jim.Com* Instituto Au 5/6', 'Healthcare', { installment: { number: 5, total: 6 } });
  add('chk1', addDays(today, -2), -9000, 'PIX ENVIADO', 'Transfers', { sourceIds: ['pluggy'], state: 'single_source' });
  add('chk1', addDays(today, -1), -9000, 'Transferência enviada pelo Pix', 'Transfers', { sourceIds: ['pluggy'], state: 'single_source' });
  add('cardB', addDays(today, -14), -7200, 'LOJA SEM ROTULO', null, { status: 'pending', sourceIds: ['pluggy'], state: 'stale_pending', excluded: true });
  // Bills: six per card, closing on the 8th and due on the 15th. Each bill already due was paid in full on the due day,
  // as a credit on the card and a debit on the checking account, the way Meu Pluggy reports both legs.
  const bills: Array<{ externalId: string; accountExternalId: string; dueDate: string; closingDate: string; total: number; minimumPayment: null }> = [];
  for (const [i, card] of cards.entries()) {
    for (let m = 6; m >= 0; m--) {
      const due = addMonthsToDay(`${today.slice(0, 7)}-15`, -m + (today.slice(8) > '15' ? 1 : 0));
      const total = Math.round(60000 + rand() * 140000);
      // A bank publishes a bill only after it closes.
      if (addDays(due, -7) <= today) bills.push({ externalId: `bill-${i}-${m}`, accountExternalId: `ext-${card}`, dueDate: due, closingDate: addDays(due, -7), total, minimumPayment: null });
    }
  }
  for (const bill of bills) {
    if (bill.dueDate > today) continue;
    const card = bill.accountExternalId.replace('ext-', '');
    add(card, bill.dueDate, bill.total, 'Pagamento recebido', 'Credit card payment');
    add('chk1', bill.dueDate, -bill.total, 'PAGAMENTO FATURA CARTAO', 'Credit card payment');
  }
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, at);
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), at);

  store.upsertSourceBills('pluggy', bills, at);

  for (const [institution, minutes] of [['Banco Alfa', 40], ['Banco Beta', 1500], ['Carteira Pay', 95]] as const) {
    store.upsertFreshness({ sourceId: 'pluggy', institution, lastUpdatedAt: new Date(now.getTime() - (minutes + 25) * 60_000).toISOString(), observedAt: at });
  }
  store.syncFindings(
    [{ id: 'fd1', kind: 'possible_match', severity: 'info', accountId: 'chk1', transactionId: list[list.length - 3]!.id, summary: 'Banco Alfa / Conta corrente: R$ 90,00 "PIX ENVIADO" in pierre on 2026-10-26 may be the same as "Transferência enviada pelo Pix" in pluggy on 2026-10-27', details: { otherTransactionId: list[list.length - 2]!.id, sources: ['pluggy', 'pluggy'] } }],
    at,
  );
  store.addCustomCategory('Viagem 2027', at);
  const thisMonth = now.toISOString().slice(0, 7);
  setBudget(store, { scope: 'category', name: 'Supermercado', month: thisMonth, amount: 120000, recurring: true }, now);
  setBudget(store, { scope: 'category', name: 'Compras online', month: thisMonth, amount: 30000, recurring: true }, now);
  setBudget(store, { scope: 'group', name: 'Lazer', month: thisMonth, amount: 40000, recurring: true }, now);
  addAsset(store, { name: 'Tesouro Direto', kind: 'asset', value: 1850000, day: addDays(today, -40) }, now);
  addAsset(store, { name: 'Financiamento do carro', kind: 'liability', value: 2400000, day: addDays(today, -40) }, now);
  createGoal(store, { name: 'Reserva de emergência', target: 3000000, track: 'manual', saved: 1200000, targetDay: addDays(today, 240) }, now);
  createGoal(store, { name: 'Viagem de fim de ano', target: 800000, track: 'manual', saved: 150000, targetDay: addDays(today, 60) }, now);
  const chat = store.createChatConversation('O que mudou nos meus gastos?', at);
  store.addChatMessage({ conversationId: chat, role: 'user', content: 'O que mudou nos meus gastos em relação ao mês passado?', steps: null, model: null, costUsd: null, createdAt: at });
  store.addChatMessage({ conversationId: chat, role: 'assistant', content: 'Os gastos de outubro estão 12% acima de setembro. A maior alta foi em Restaurantes e bares (R$ 480 a mais), seguida de Supermercado (R$ 210 a mais). Moradia e assinaturas ficaram iguais.', steps: [{ tool: 'trend', args: { months: 3 }, summary: 'categorias: 14' }, { tool: 'spending', args: { by: 'category' }, summary: 'grupos: 12' }], model: 'anthropic/claude-sonnet-5.5', costUsd: 0.004, createdAt: at });
  createRule(store, { name: 'Uber', conditions: { match: 'all', items: [{ field: 'merchant', operator: 'equals', value: 'Uber' }] }, actions: { category: 'Transporte por aplicativo' } }, now);
  createRule(store, { name: 'Compras grandes no cartão', conditions: { match: 'all', items: [{ field: 'direction', operator: 'equals', value: 'out' }, { match: 'any', leaves: [{ field: 'description', operator: 'contains', value: 'amazon' }, { field: 'description', operator: 'contains', value: 'shopee' }] }, { field: 'amount', operator: 'lt', value: -10000 }] }, actions: { category: 'Compras online' } }, now);
  store.setCategoryRule('padaria bom pao', 'Supermercado', at);
  for (const [key, category, status, confidence] of [
    ['loja sem rotulo', 'Casa e utilidades', 'suggested', 'medium'],
    ['clube do livro', 'Educação', 'suggested', 'medium'],
    ['ifd pizzaria do ze', 'Delivery de comida', 'applied', 'high'],
    ['amazon br sa', 'Compras online', 'applied', 'high'],
  ] as const) store.saveAiCategory({ matchKey: key, sample: key.toUpperCase(), category, confidence, status, model: 'm', taxonomy: 't', decidedAt: at });

  saveIncome(store, null, { name: 'Salário', amount: 650000, dayOfMonth: 5 }, now);
  if (dense) saveIncome(store, null, { name: 'Aluguel recebido do apartamento da praia', amount: 180000, dayOfMonth: 10 }, now);
  const call = (path: string, query = '', method = 'GET', body = '') => apiRoute(method, path, new URLSearchParams(query), store, now, body)?.body;
  const cardsView = call('/api/cards') as { cycles: string[] };
  const pastCycle = cardsView.cycles[1] ?? null;
  const range = monthRange(now);
  const before = previousMonth(range.from);
  const detailId = list.find((t) => t.installment && t.accountId === 'cardA')!.id;
  const responses: Record<string, unknown> = {
    '/api/auth/session': { authenticated: true, strength: 'password' },
    '/api/auth/methods': { password: true, passkeys: true },
    '/api/auth/security': { strength: 'password', passkeysAvailable: true, passkeys: [{ id: 'p1', name: 'Mac (Chrome)', createdAt: at, lastUsedAt: at, transports: ['internal'] }], devices: [{ id: 'd1', name: 'Mac (Chrome)', createdAt: at, lastUsedAt: at, expiresAt: addDays(today, 30), current: true }] },
    '/api/layout': call('/api/layout'),
    '/api/balances': call('/api/balances'),
    '/api/cards': cardsView,
    ...(pastCycle ? { [`/api/cards?cycle=${pastCycle}`]: call('/api/cards', `cycle=${pastCycle}`) } : {}),
    '/api/income': call('/api/income'),
    '/api/version': { version: 'dev', startedAt: at, canDeploy: true },
    '/api/reset': { available: true, running: false, mode: null, step: null, startedAt: null, finishedAt: null, result: null },
    '/api/rules/suggestions': call('/api/rules/suggestions'),
    '/api/budgets/suggestions': call('/api/budgets/suggestions'),
    '/api/cards/bills': call('/api/cards/bills'),
    '/api/cards/forecast': call('/api/cards/forecast'),
    '/api/installments': call('/api/installments'),
    '/api/cashflow': call('/api/cashflow', `from=${range.from}&to=${range.to}`),
    [`/api/cashflow?from=${before.from}&to=${before.to}`]: call('/api/cashflow', `from=${before.from}&to=${before.to}`),
    '/api/spending': call('/api/spending', `from=${range.from}&to=${range.to}`),
    '/api/transactions': call('/api/transactions', 'limit=50'),
    '/api/freshness': call('/api/freshness'),
    '/api/bill-check': call('/api/bill-check'),
    '/api/rules': call('/api/rules'),
    '/api/budgets': call('/api/budgets'),
    '/api/networth': call('/api/networth'),
    '/api/goals': call('/api/goals'),
    '/api/chat/status': { available: true },
    '/api/chat/conversations': call('/api/chat/conversations'),
    '/api/chat/conversations/1': call('/api/chat/conversations/1'),
    '/api/calendar': call('/api/calendar'),
    '/api/spending/compare': call('/api/spending/compare'),
    '/api/outlook': call('/api/outlook'),
    '/api/spending/trend': call('/api/spending/trend', 'months=6'),
    '/api/findings': call('/api/findings'),
    '/api/categories': call('/api/categories'),
    '/api/accounts': call('/api/accounts'),
    '/api/ai': call('/api/ai'),
    '/api/ai/decisions': call('/api/ai/decisions', 'status=applied'),
    '/api/cycles': call('/api/cycles', 'accountId=cardA'),
    detail: call(`/api/transactions/${detailId}`),
    candidates: { items: [] },
  };
  return { now: at, responses, pastCycle };
}

/** The whole month before the one `from` opens: the cash flow widget asks for it to show the comparison block. */
function previousMonth(from: string): { from: string; to: string } {
  const [year, month] = from.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) - 1;
  const start = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
  return { from: start, to: addDays(from, -1) };
}

/** A new install: logged in, nothing connected yet. Every list is empty. */
function emptyFixtures(now: Date): Fixtures {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const at = now.toISOString();
  const range = monthRange(now);
  const before = previousMonth(range.from);
  const call = (path: string, query = '') => apiRoute('GET', path, new URLSearchParams(query), store, now, '')?.body;
  const paths = ['/api/layout', '/api/balances', '/api/cards', '/api/cards/bills', '/api/cards/forecast', '/api/installments', '/api/freshness', '/api/bill-check', '/api/rules', '/api/budgets', '/api/networth', '/api/goals', '/api/chat/conversations', '/api/calendar', '/api/findings', '/api/categories', '/api/accounts', '/api/ai', '/api/income', '/api/rules/suggestions', '/api/budgets/suggestions'];
  const responses: Record<string, unknown> = Object.fromEntries(paths.map((p) => [p, call(p)]));
  Object.assign(responses, {
    '/api/auth/session': { authenticated: true, strength: 'password' },
    '/api/auth/methods': { password: true, passkeys: false },
    '/api/auth/security': { strength: 'password', passkeysAvailable: false, passkeys: [], devices: [] },
    '/api/cashflow': call('/api/cashflow', `from=${range.from}&to=${range.to}`),
    [`/api/cashflow?from=${before.from}&to=${before.to}`]: call('/api/cashflow', `from=${before.from}&to=${before.to}`),
    '/api/spending': call('/api/spending', `from=${range.from}&to=${range.to}`),
    '/api/spending/trend': call('/api/spending/trend', 'months=6'),
    '/api/transactions': call('/api/transactions', 'limit=50'),
    '/api/ai/decisions': call('/api/ai/decisions', 'status=applied'),
    '/api/chat/status': { available: false },
    '/api/version': { version: 'dev', startedAt: at, canDeploy: false },
    '/api/reset': { available: false },
    detail: null,
    candidates: { items: [] },
  });
  return { now: at, responses, pastCycle: null };
}
