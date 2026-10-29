import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { categorizePending } from '../../src/ai/categorizer.ts';
import { ChatError, chat, fetchKeyUsage, type AiClient } from '../../src/ai/openrouter.ts';
import { monthSpend, refreshKeyUsage } from '../../src/ai/spend.ts';
import { aiView } from '../../src/api/ai.ts';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');

const account: CanonicalAccount = {
  id: 'a1', institution: 'Bank', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(),
  creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [],
};
const tx: CanonicalTransaction = { id: 't1', accountId: 'a1', occurredAt: '2026-10-20T15:00:00Z', amount: -1000, description: 'LOJA 02 CENTRO', descriptionRaw: null, status: 'posted', installment: null, category: null, state: 'confirmed', sourceIds: ['pluggy'], excluded: false };

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.replaceCanonicalAccounts([account], [], NOW.toISOString());
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.replaceCanonicalTransactions([tx], [{ sourceId: 'pluggy', externalId: 'e-t1', transactionId: 't1', matchPass: 0 }], NOW.toISOString());
  return store;
}

const answer = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test('an answer with no content throws an error that carries what it cost', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = answer({ choices: [{ message: { content: '' } }], usage: { cost: 0.0042 } });
  try {
    await assert.rejects(chat('k', { model: 'm', system: 's', user: 'u' }), (e: unknown) => e instanceof ChatError && e.costUsd === 0.0042);
  } finally {
    globalThis.fetch = original;
  }
});

test('a paid call that gave nothing usable still counts against the budget', async () => {
  const store = seeded();
  const client: AiClient = async () => {
    throw new ChatError('empty answer', 0.01);
  };
  const result = await categorizePending(store, { client, models: ['m1', 'm2'], now: () => NOW, monthlyBudgetUsd: 1 });
  assert.equal(result.stoppedBy, 'error');
  // Both models were tried and each one was billed.
  assert.equal(store.aiSpent('2026-10'), 0.02);
});

test('an error that was never billed records nothing', async () => {
  const store = seeded();
  const client: AiClient = async () => {
    throw new Error('HTTP 500');
  };
  await categorizePending(store, { client, models: ['m1'], now: () => NOW, monthlyBudgetUsd: 1 });
  assert.equal(store.aiSpent('2026-10'), 0);
});

test('the key total from OpenRouter is read and kept, and the budget uses the larger number', async () => {
  const store = seeded();
  store.recordAiUsage({ kind: 'categorize', model: 'm', items: 1, costUsd: 0.03, at: NOW.toISOString() });
  assert.deepEqual(monthSpend(store, '2026-10'), { recorded: 0.03, keyTotal: null, keyFetchedAt: null, spent: 0.03 });
  assert.equal(await refreshKeyUsage(store, 'k', NOW, answer({ data: { usage_monthly: 0.6, usage_daily: 0.02 } })), true);
  const spend = monthSpend(store, '2026-10');
  assert.equal(spend.keyTotal, 0.6);
  assert.equal(spend.spent, 0.6);
  const view = aiView(store, NOW);
  assert.equal(view.spentThisMonth, 0.6);
  assert.equal(view.recordedThisMonth, 0.03);
  assert.equal(view.keyThisMonth?.usd, 0.6);
});

test('a reading from another month is ignored, and a failed read keeps the last value', async () => {
  const store = seeded();
  await refreshKeyUsage(store, 'k', NOW, answer({ data: { usage_monthly: 0.6 } }));
  assert.equal(monthSpend(store, '2026-11').keyTotal, null);
  assert.equal(await refreshKeyUsage(store, 'k', NOW, answer({ error: 'nope' }, 401)), false);
  assert.equal(monthSpend(store, '2026-10').keyTotal, 0.6);
  await assert.rejects(fetchKeyUsage('k', answer({ data: {} })));
});

test('the budget stops the categorizer when the key total alone passes it', async () => {
  const store = seeded();
  await refreshKeyUsage(store, 'k', NOW, answer({ data: { usage_monthly: 5 } }));
  let calls = 0;
  const client: AiClient = async () => {
    calls++;
    return { content: '{"results":[]}', promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1 };
  };
  const result = await categorizePending(store, { client, models: ['m1'], now: () => NOW, monthlyBudgetUsd: 2 });
  assert.equal(result.stoppedBy, 'budget');
  assert.equal(calls, 0);
});
