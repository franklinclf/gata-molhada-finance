import { fileURLToPath } from 'node:url';
import { apiRoute } from '../../src/api/routes.ts';
import { monthRange } from '../../src/api/views.ts';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { createRule } from '../../src/api/rules.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { addDays, addMonthsToDay } from '../../src/api/cycles.ts';
import { localDay } from '../../src/core/time.ts';

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
}

export function buildFixtures(now = new Date()): Fixtures {
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
  const accounts: CanonicalAccount[] = [
    base({ id: 'chk1', institution: 'Banco Alfa', name: 'Conta corrente', balance: 421035 }),
    base({ id: 'sav1', institution: 'Banco Beta', kind: 'savings', name: 'Poupança', balance: 250000, balanceAsOf: new Date(now.getTime() - 26 * 3_600_000).toISOString() }),
    base({ id: 'chk2', institution: 'Banco Beta', name: 'Conta corrente', balance: 189000 }),
    base({ id: 'wallet', institution: 'Carteira Pay', name: 'Conta digital', balance: 33210 }),
    base({ id: 'cardA', institution: 'Banco Alfa', kind: 'credit_card', name: 'Gold', last4: '1111', balance: 336581, creditLimit: 1840000, availableLimit: 1503419, limitGroupId: 'lgA', refs: [{ sourceId: 'pluggy', externalId: 'ext-cardA', role: 'member' }] }),
    base({ id: 'cardA2', institution: 'Banco Alfa', kind: 'credit_card', name: 'Platinum', last4: '2222', balance: 336581, creditLimit: 1840000, availableLimit: 1503419, limitGroupId: 'lgA', refs: [{ sourceId: 'pluggy', externalId: 'ext-cardA2', role: 'member' }] }),
    base({ id: 'cardB', institution: 'Banco Beta', kind: 'credit_card', name: 'Click', last4: '0576', balance: 28090, creditLimit: 518500, availableLimit: 490410, refs: [{ sourceId: 'pluggy', externalId: 'ext-cardB', role: 'member' }] }),
    base({ id: 'cardC', institution: 'Carteira Pay', kind: 'credit_card', name: 'Roxo', last4: '4527', balance: 120535, creditLimit: 840000, availableLimit: 719465, refs: [{ sourceId: 'pluggy', externalId: 'ext-cardC', role: 'member' }] }),
  ];
  store.replaceCanonicalAccounts(accounts, [{ id: 'lgA', institution: 'Banco Alfa', creditLimit: 1840000, memberIds: ['cardA', 'cardA2'] }], at);

  const list: CanonicalTransaction[] = [];
  let n = 0;
  const add = (accountId: string, day: string, amount: number, description: string, category: string | null, extra: Partial<CanonicalTransaction> = {}) => {
    list.push({ id: `t${++n}`, accountId, occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: description, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy', 'pluggy'], excluded: false, ...extra });
  };

  const cards = ['cardA', 'cardA2', 'cardB', 'cardC'];
  for (let back = 0; back < 180; back++) {
    const day = addDays(today, -back);
    if (rand() < 0.8) {
      const [text, label, min, max] = pick(SHOPS);
      add(pick(cards), day, -Math.round(min + rand() * (max - min)), text, label);
    }
    if (rand() < 0.25) add('chk1', day, -Math.round(1500 + rand() * 9000), pick(['PIX ENVIADO JOAO PEREIRA', 'Transferência enviada|Maria Souza']), 'Transfers');
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
      add('chk1', addDays(first, 10), -Math.round(50000 + rand() * 60000), `PAGAMENTO FATURA ${card}`, 'Credit card payment', { description: 'GASTOS CARTAO DE CREDITO - DOCTO: 3990288' });
    }
  }
  for (let k = 0; k < 4; k++) add('cardA', addDays(today, -35 * k - 3), -28305, 'EXTRAFARMA C*pagu', 'Pharmacy', { installment: { number: 3 - k >= 1 ? 3 - k : 1, total: 3 } });
  for (let k = 0; k < 3; k++) add('cardC', addDays(today, -31 * k - 5), -16982, 'Shopping do Nu', 'Shopping', { installment: { number: 9 - k, total: 10 } });
  add('cardC', addDays(today, -3), -99900, 'Jim.Com* Instituto Au 5/6', 'Healthcare', { installment: { number: 5, total: 6 } });
  add('chk1', addDays(today, -2), -9000, 'PIX ENVIADO', 'Transfers', { sourceIds: ['pluggy'], state: 'single_source' });
  add('chk1', addDays(today, -1), -9000, 'Transferência enviada pelo Pix', 'Transfers', { sourceIds: ['pluggy'], state: 'single_source' });
  add('cardB', addDays(today, -14), -7200, 'LOJA SEM ROTULO', null, { status: 'pending', sourceIds: ['pluggy'], state: 'stale_pending', excluded: true });
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, at);
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), at);

  // Bills: six per card, closing on the 8th and due on the 15th, each one paid.
  const bills: Array<{ externalId: string; accountExternalId: string; dueDate: string; closingDate: string; total: number; minimumPayment: null }> = [];
  for (const [i, card] of cards.entries()) {
    for (let m = 6; m >= 0; m--) {
      const due = addMonthsToDay(`${today.slice(0, 7)}-15`, -m + (today.slice(8) > '15' ? 1 : 0));
      bills.push({ externalId: `bill-${i}-${m}`, accountExternalId: `ext-${card}`, dueDate: due, closingDate: addDays(due, -7), total: Math.round(60000 + rand() * 140000), minimumPayment: null });
    }
  }
  store.upsertSourceBills('pluggy', bills, at);

  for (const [institution, minutes] of [['Banco Alfa', 40], ['Banco Beta', 1500], ['Carteira Pay', 95]] as const) {
    store.upsertFreshness({ sourceId: 'pluggy', institution, lastUpdatedAt: new Date(now.getTime() - (minutes + 25) * 60_000).toISOString(), observedAt: at });
  }
  store.syncFindings(
    [{ id: 'fd1', kind: 'possible_match', severity: 'info', accountId: 'chk1', transactionId: list[list.length - 3]!.id, summary: 'Banco Alfa / Conta corrente: R$ 90,00 "PIX ENVIADO" in pierre on 2026-10-26 may be the same as "Transferência enviada pelo Pix" in pluggy on 2026-10-27', details: { otherTransactionId: list[list.length - 2]!.id, sources: ['pluggy', 'pluggy'] } }],
    at,
  );
  store.addCustomCategory('Viagem 2027', at);
  createRule(store, { name: 'Uber', conditions: { match: 'all', items: [{ field: 'merchant', operator: 'equals', value: 'Uber' }] }, actions: { category: 'Transporte por aplicativo' } }, now);
  createRule(store, { name: 'Compras grandes no cartão', conditions: { match: 'all', items: [{ field: 'direction', operator: 'equals', value: 'out' }, { match: 'any', leaves: [{ field: 'description', operator: 'contains', value: 'amazon' }, { field: 'description', operator: 'contains', value: 'shopee' }] }, { field: 'amount', operator: 'lt', value: -10000 }] }, actions: { category: 'Compras online' } }, now);
  store.setCategoryRule('padaria bom pao', 'Supermercado', at);
  for (const [key, category, status, confidence] of [
    ['loja sem rotulo', 'Casa e utilidades', 'suggested', 'medium'],
    ['clube do livro', 'Educação', 'suggested', 'medium'],
    ['ifd pizzaria do ze', 'Delivery de comida', 'applied', 'high'],
    ['amazon br sa', 'Compras online', 'applied', 'high'],
  ] as const) store.saveAiCategory({ matchKey: key, sample: key.toUpperCase(), category, confidence, status, model: 'm', taxonomy: 't', decidedAt: at });

  const call = (path: string, query = '', method = 'GET', body = '') => apiRoute(method, path, new URLSearchParams(query), store, now, body)?.body;
  const range = monthRange(now);
  const detailId = list.find((t) => t.installment && t.accountId === 'cardA')!.id;
  const responses: Record<string, unknown> = {
    '/api/auth/session': { authenticated: true, strength: 'password' },
    '/api/auth/methods': { password: true, passkeys: true },
    '/api/auth/security': { strength: 'password', passkeysAvailable: true, passkeys: [{ id: 'p1', name: 'Mac (Chrome)', createdAt: at, lastUsedAt: at, transports: ['internal'] }], devices: [{ id: 'd1', name: 'Mac (Chrome)', createdAt: at, lastUsedAt: at, expiresAt: addDays(today, 30), current: true }] },
    '/api/layout': call('/api/layout'),
    '/api/balances': call('/api/balances'),
    '/api/cards': call('/api/cards'),
    '/api/cards/bills': call('/api/cards/bills'),
    '/api/cards/forecast': call('/api/cards/forecast'),
    '/api/installments': call('/api/installments'),
    '/api/cashflow': call('/api/cashflow', `from=${range.from}&to=${range.to}`),
    '/api/spending': call('/api/spending', `from=${range.from}&to=${range.to}`),
    '/api/transactions': call('/api/transactions', 'limit=50'),
    '/api/freshness': call('/api/freshness'),
    '/api/rules': call('/api/rules'),
    '/api/refresh': { available: true, running: false, result: null, timedOut: [] },
    '/api/findings': call('/api/findings'),
    '/api/categories': call('/api/categories'),
    '/api/accounts': call('/api/accounts'),
    '/api/ai': call('/api/ai'),
    '/api/ai/decisions': call('/api/ai/decisions', 'status=applied'),
    '/api/cycles': call('/api/cycles', 'accountId=cardA'),
    detail: call(`/api/transactions/${detailId}`),
    candidates: { items: [] },
  };
  return { now: at, responses };
}
