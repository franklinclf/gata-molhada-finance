import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { aiView } from '../../src/api/ai.ts';
import { separateTransaction } from '../../src/api/mutations.ts';
import { loadAiConfig, runCategorizerOnce } from '../../src/ai/job.ts';
import { matchPending } from '../../src/ai/matcher.ts';
import type { AiClient } from '../../src/ai/openrouter.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, tx } from '../support/builders.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');
const LATER = new Date('2026-10-26T18:00:00.000Z');

function seeded(pairs: Array<{ a: string; b: string; amount: number; gap?: number }>) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const at = NOW.toISOString();
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, at);
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1' })], at);
  store.upsertSourceAccounts('pluggy', [account({ externalId: 'g1' })], at);
  pairs.forEach((p, i) => {
    const day = 10 + i * 6;
    store.upsertSourceTransactions('pierre', [tx({ externalId: `a${i}`, accountExternalId: 'p1', occurredAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`, amount: p.amount, descriptionRaw: p.a, description: p.a })], at);
    store.upsertSourceTransactions('pluggy', [tx({ externalId: `b${i}`, accountExternalId: 'g1', occurredAt: `2026-10-${String(day + (p.gap ?? 3)).padStart(2, '0')}T12:00:00.000Z`, amount: p.amount, descriptionRaw: p.b, description: p.b })], at);
  });
  runReconciliation(store, { now: () => NOW });
  return store;
}

const verdicts = (table: Record<string, ['yes' | 'no', string]>): { client: AiClient; payloads: string[] } => {
  const payloads: string[] = [];
  const client: AiClient = async (o) => {
    payloads.push(o.user);
    const asked = JSON.parse(o.user) as Array<{ i: number; a: { text: string } }>;
    const results = asked.map((q) => {
      const [same, confidence] = table[q.a.text] ?? ['no', 'low'];
      return { i: q.i, same, confidence };
    });
    return { content: JSON.stringify({ results }), promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 1 };
  };
  return { client, payloads };
};

const run = (store: ReturnType<typeof seeded>, client: AiClient, extra: Partial<Parameters<typeof matchPending>[1]> = {}) =>
  matchPending(store, { client, models: ['m1', 'm2'], now: () => LATER, monthlyBudgetUsd: 1, rebuild: () => void runReconciliation(store, { now: () => LATER }), ...extra });

test('a sure "same" is joined by the AI, kept apart from the user joins, and visible with a way back', async () => {
  const store = seeded([{ a: 'IFD*PIZZARIA DO ZE', b: 'Ifood Pizzaria do Ze', amount: -5490 }]);
  assert.equal(store.listFindings().length, 1);
  const result = await run(store, verdicts({ 'IFD*PIZZARIA DO ZE': ['yes', 'high'] }).client);
  assert.deepEqual([result.asked, result.joined, result.dismissed, result.suggested], [1, 1, 0, 0]);
  assert.equal(store.listCanonicalTransactions().filter((t) => t.sourceIds.length === 2 && t.amount === -5490).length, 1);
  assert.deepEqual(store.listFindings(), []);
  const joined = store.listCanonicalTransactions().find((t) => t.sourceIds.length === 2 && t.amount === -5490)!;
  assert.equal(store.manualLinkMadeBy(joined.id), 'ai');
  const view = aiView(store, LATER).matches;
  assert.deepEqual([view.counts.joined, view.joined[0]?.transactionId, view.joined[0]?.confidence], [1, joined.id, 'high']);
});

test('the user separating an AI join is remembered: the AI does not join the pair again', async () => {
  const store = seeded([{ a: 'IFD*PIZZARIA DO ZE', b: 'Ifood Pizzaria do Ze', amount: -5490 }]);
  const { client } = verdicts({ 'IFD*PIZZARIA DO ZE': ['yes', 'high'] });
  await run(store, client);
  const joined = store.listCanonicalTransactions().find((t) => t.sourceIds.length === 2)!;
  assert.deepEqual(separateTransaction(store, joined.id, LATER), { ok: true });
  assert.equal(store.listCanonicalTransactions().filter((t) => t.amount === -5490).length, 2);
  assert.equal(aiView(store, LATER).matches.counts.undone, 1);
  const again = await run(store, client);
  assert.equal(again.asked, 0);
  assert.equal(store.listCanonicalTransactions().filter((t) => t.amount === -5490).length, 2);
  assert.equal(aiView(store, LATER).matches.opinions[store.listFindings()[0]!.id]?.verdict, 'yes');
});

test('less than sure stays a suggestion with the opinion attached, a sure "no" is dismissed', async () => {
  const store = seeded([
    { a: 'PIX ENVIADO', b: 'Transferência enviada', amount: -1000 },
    { a: 'CINEMARK', b: 'DROGASIL', amount: -2000 },
  ]);
  const result = await run(store, verdicts({ 'PIX ENVIADO': ['yes', 'medium'], CINEMARK: ['no', 'high'] }).client);
  assert.deepEqual([result.joined, result.dismissed, result.suggested], [0, 1, 1]);
  const open = store.listFindings();
  assert.equal(open.length, 1);
  assert.deepEqual(aiView(store, LATER).matches.opinions[open[0]!.id], { verdict: 'yes', confidence: 'medium' });
});

test('the code refuses a join the model is sure of when a record has two possible partners', async () => {
  const store = seeded([{ a: 'LOJA X', b: 'Loja X Ltda', amount: -3000 }]);
  store.upsertSourceTransactions('pluggy', [tx({ externalId: 'extra', accountExternalId: 'g1', occurredAt: '2026-10-12T12:00:00.000Z', amount: -3000, descriptionRaw: 'OUTRA LOJA', description: 'OUTRA LOJA' })], NOW.toISOString());
  runReconciliation(store, { now: () => LATER });
  assert.equal(store.listFindings().length, 1);
  const result = await run(store, verdicts({ 'LOJA X': ['yes', 'high'] }).client);
  assert.deepEqual([result.joined, result.suggested], [0, 1]);
});

test('only texts, dates and statuses go to the model: no amounts, accounts or institutions', async () => {
  const store = seeded([{ a: 'IFD*PIZZARIA DO ZE', b: 'Ifood Pizzaria do Ze', amount: -5490 }]);
  const { client, payloads } = verdicts({});
  await run(store, client);
  const sent = payloads.join('');
  assert.equal(/5490|54,90|54\.9|amount/i.test(sent), false);
  assert.equal(/Bank A|acc_/.test(sent), false);
  assert.match(sent, /IFD\*PIZZARIA DO ZE/);
});

test('bad answers are dropped, a failing model hands over to the next, and the budget stops the run', async () => {
  const store = seeded([{ a: 'AAA', b: 'AAB', amount: -100 }]);
  const bad: AiClient = async () => ({ content: JSON.stringify({ results: [{ i: 0, same: 'maybe', confidence: 'high' }, { i: 5, same: 'yes', confidence: 'high' }] }), promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 });
  assert.equal((await run(store, bad)).dropped, 2);
  assert.equal(store.listAiMatches().size, 0);

  const seen: string[] = [];
  const flaky: AiClient = async (o) => {
    seen.push(o.model);
    if (o.model === 'm1') throw new Error('down');
    return { content: JSON.stringify({ results: [{ i: 0, same: 'yes', confidence: 'medium' }] }), promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 };
  };
  const ok = await run(store, flaky);
  assert.deepEqual([seen, ok.suggested, store.listAiMatches().values().next().value?.model], [['m1', 'm2'], 1, 'm2']);

  const poor = seeded([{ a: 'AAA', b: 'AAB', amount: -100 }]);
  poor.recordAiUsage({ kind: 'x', model: 'm', items: 1, costUsd: 5, at: LATER.toISOString() });
  assert.equal((await run(poor, verdicts({}).client)).stoppedBy, 'budget');
});

test('the job runs the categorizer and then the matcher, and says what it did', async () => {
  const store = seeded([{ a: 'IFD*PIZZARIA DO ZE', b: 'Ifood Pizzaria do Ze', amount: -5490 }]);
  const client: AiClient = async (o) => {
    const asked = JSON.parse(o.user) as Array<{ i: number; text?: string; a?: { text: string } }>;
    const results = asked.map((q) => (q.a ? { i: q.i, same: 'yes', confidence: 'high' } : { i: q.i, category: 'Delivery de comida', confidence: 'high' }));
    return { content: JSON.stringify({ results }), promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 1 };
  };
  await runCategorizerOnce(store, loadAiConfig({ AI_ENABLED: 'on', OPENROUTER_API_KEY: 'k' }), () => LATER, client);
  assert.match(aiView(store, LATER).job.lastResult ?? '', /pairs: asked 1, joined 1/);
});
