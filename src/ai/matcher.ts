import { localDay, localMonth } from '../core/time.ts';
import { counterpartyHashes, effectiveTransactions, type EffectiveTransaction } from '../api/scope.ts';
import type { AiMatch, Store } from '../store/store.ts';
import { parseJson, type AiClient } from './openrouter.ts';
import { PAIR_SCHEMA, PAIR_SYSTEM, pairPayload, type Pair } from './pair-prompt.ts';
import { monthSpend, recordFailedCost } from './spend.ts';

export interface MatcherOptions {
  client: AiClient;
  models: string[];
  now: () => Date;
  monthlyBudgetUsd: number;
  /** Rebuilds the canonical transactions after joins, so totals and lists reflect them. */
  rebuild: () => void;
  batchSize?: number;
  maxPairs?: number;
}

export interface MatcherResult {
  asked: number;
  joined: number;
  dismissed: number;
  suggested: number;
  dropped: number;
  costUsd: number;
  stoppedBy: 'budget' | 'error' | null;
}

const WINDOW_DAYS = 5;
const DAY = 86_400_000;

/** How many records of the other source could be this one: same account, same amount, a few days around. */
function counterparts(t: EffectiveTransaction, all: EffectiveTransaction[]): number {
  return all.filter(
    (o) => o.id !== t.id && o.accountId === t.accountId && o.state === 'single_source' && o.amount === t.amount && o.sourceIds[0] !== t.sourceIds[0] && Math.abs(new Date(o.occurredAt).getTime() - new Date(t.occurredAt).getTime()) <= WINDOW_DAYS * DAY,
  ).length;
}

/**
 * Asks the model about the pairs the automatic matching left open. The code, not the model, decides what may happen:
 * two records are joined only when the model is sure they are the same AND the facts check out again right now
 * (same account, different sources, same amount, a few days apart, nothing set aside) AND neither record has another
 * candidate. A joined pair can be separated by the user and is then never joined again. A clear "no" is dismissed;
 * everything else stays a suggestion, with the model's opinion shown next to it.
 */
export async function matchPending(store: Store, options: MatcherOptions): Promise<MatcherResult> {
  const result: MatcherResult = { asked: 0, joined: 0, dismissed: 0, suggested: 0, dropped: 0, costUsd: 0, stoppedBy: null };
  const decided = store.listAiMatches();
  const all = effectiveTransactions(store, { includeHidden: true });
  const byId = new Map(all.map((t) => [t.id, t]));
  const accounts = new Map(store.listCanonicalAccounts().map((a) => [a.id, a]));
  const documents = counterpartyHashes(store);
  const sameDocument = (a: string, b: string): 'yes' | 'no' | 'unknown' => (documents.has(a) && documents.has(b) ? (documents.get(a) === documents.get(b) ? 'yes' : 'no') : 'unknown');

  interface Candidate { findingId: string; a: EffectiveTransaction; b: EffectiveTransaction; pair: Pair }
  const todo: Candidate[] = [];
  for (const f of store.listFindings()) {
    if (f.kind !== 'possible_match' || decided.has(f.id)) continue;
    const a = byId.get(f.transactionId);
    const b = byId.get(String(f.details.otherTransactionId));
    const account = a ? accounts.get(a.accountId) : undefined;
    if (!a || !b || !account) continue;
    const record = (t: EffectiveTransaction) => ({ source: t.sourceIds[0] ?? '', text: t.description, date: localDay(t.occurredAt), status: t.status, category: t.sourceCategory, operation: t.operation, merchantCode: t.mcc });
    todo.push({
      findingId: f.id,
      a,
      b,
      pair: {
        a: record(a),
        b: record(b),
        daysApart: Math.round(Math.abs(new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()) / DAY),
        accountKind: account.kind === 'credit_card' ? 'card' : 'bank',
        direction: a.amount < 0 ? 'out' : 'in',
        sameCounterpartyDocument: sameDocument(a.id, b.id),
      },
    });
  }
  const queue = todo.slice(0, options.maxPairs ?? 40);
  const month = localMonth(options.now().toISOString());
  const size = options.batchSize ?? 20;
  let changed = false;

  for (let start = 0; start < queue.length; start += size) {
    if (monthSpend(store, month).spent >= options.monthlyBudgetUsd) {
      result.stoppedBy = 'budget';
      break;
    }
    const batch = queue.slice(start, start + size);
    let answers: Array<{ i?: unknown; same?: unknown; confidence?: unknown }> | null = null;
    let usedModel = '';
    for (const model of options.models) {
      try {
        const reply = await options.client({ model, system: PAIR_SYSTEM, user: pairPayload(batch.map((c) => c.pair)), schema: PAIR_SCHEMA, reasoning: true, maxTokens: 6000 });
        store.recordAiUsage({ kind: 'match', model, items: batch.length, costUsd: reply.costUsd, at: options.now().toISOString() });
        result.costUsd += reply.costUsd;
        answers = parseJson<{ results?: Array<{ i?: unknown; same?: unknown; confidence?: unknown }> }>(reply.content).results ?? [];
        usedModel = model;
        break;
      } catch (error) {
        recordFailedCost(store, { kind: 'match', model, items: batch.length, at: options.now().toISOString() }, error);
        // Try the next model.
      }
    }
    if (answers === null) {
      result.stoppedBy = 'error';
      break;
    }
    result.asked += batch.length;

    for (const answer of answers) {
      const c = typeof answer.i === 'number' ? batch[answer.i] : undefined;
      const same = answer.same;
      const confidence = answer.confidence;
      if (!c || (same !== 'yes' && same !== 'no') || (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low')) {
        result.dropped++;
        continue;
      }
      const first = store.listTransactionLinks(c.a.id)[0];
      if (!first) continue;
      const stillValid = c.a.accountId === c.b.accountId && c.a.amount === c.b.amount && c.a.state === 'single_source' && c.b.state === 'single_source' && c.pair.daysApart <= WINDOW_DAYS && counterparts(c.a, all) <= 1 && counterparts(c.b, all) <= 1 && c.pair.sameCounterpartyDocument !== 'no';
      let action: AiMatch['action'] = 'suggested';
      if (same === 'yes' && confidence === 'high' && stillValid && store.addManualLink(c.a.id, c.b.id, options.now().toISOString(), 'ai')) {
        action = 'joined';
        changed = true;
        result.joined++;
      } else if (same === 'no' && confidence === 'high') {
        store.dismissFinding(c.findingId, options.now().toISOString());
        action = 'dismissed';
        changed = true;
        result.dismissed++;
      } else result.suggested++;
      store.saveAiMatch({ findingId: c.findingId, verdict: same, confidence, action, model: usedModel, sampleA: c.a.description, sampleB: c.b.description, sourceA: first.sourceId, externalA: first.externalId, decidedAt: options.now().toISOString() });
    }
  }
  if (changed) options.rebuild();
  return result;
}
