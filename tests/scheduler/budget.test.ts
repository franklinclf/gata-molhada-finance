import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessBudget, canRequestRefresh, type InstitutionBudget } from '../../src/scheduler/budget.ts';
import type { RefreshLogEntry } from '../../src/store/store.ts';

const NOW = new Date('2026-10-26T16:00:00.000Z');
const input = (used: number, exhausted = false, name = 'Bank A') => ({ institutionKey: name.toLowerCase(), institution: name, used, exhausted });

test('levels follow the 70% and 90% thresholds of the monthly limit', () => {
  const levels = assessBudget([input(100), input(168), input(215), input(216), input(240)]).map((b) => b.level);
  assert.deepEqual(levels, ['ok', 'warn', 'warn', 'blocked', 'blocked']);
});

test('an exhausted institution is blocked whatever its count', () => {
  assert.equal(assessBudget([input(3, true)])[0]?.level, 'blocked');
});

test('thresholds and limit can be changed', () => {
  const [b] = assessBudget([input(5)], { monthlyLimit: 10, warnAt: 0.4, blockAt: 0.5 });
  assert.equal(b?.level, 'blocked');
  assert.equal(b?.limit, 10);
});

const entry = (overrides: Partial<RefreshLogEntry> = {}): RefreshLogEntry => ({
  id: 1,
  sourceId: 'pierre',
  requestedAt: '2026-10-26T10:00:00.000Z',
  finishedAt: '2026-10-26T10:01:00.000Z',
  status: 'completed',
  detail: {},
  ...overrides,
});

const budget = (...items: ReturnType<typeof input>[]): InstitutionBudget[] => assessBudget(items);

test('allows a refresh when nothing stands in the way', () => {
  assert.deepEqual(canRequestRefresh({ now: NOW, lastRefresh: entry(), budget: budget(input(10)) }), { allowed: true, reasons: [] });
  assert.equal(canRequestRefresh({ now: NOW, lastRefresh: null, budget: [] }).allowed, true);
});

test('blocks a refresh that follows another too closely', () => {
  const decision = canRequestRefresh({ now: NOW, lastRefresh: entry({ requestedAt: '2026-10-26T15:50:00.000Z' }), budget: [] });
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons[0] ?? '', /10 minutes ago \(minimum 15\)/);
});

test('blocks while another refresh is still running, even when forced', () => {
  const running = entry({ requestedAt: '2026-10-26T15:58:00.000Z', finishedAt: null, status: 'requested' });
  const decision = canRequestRefresh({ now: NOW, lastRefresh: running, budget: [], force: true });
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons[0] ?? '', /still running/);
});

test('an old unfinished refresh no longer counts as running', () => {
  const stale = entry({ requestedAt: '2026-10-26T15:00:00.000Z', finishedAt: null, status: 'requested' });
  assert.equal(canRequestRefresh({ now: NOW, lastRefresh: stale, budget: [] }).allowed, true);
});

test('blocks when an institution is nearly out of reads, and explains which', () => {
  const decision = canRequestRefresh({ now: NOW, lastRefresh: null, budget: budget(input(220, false, 'Bank A'), input(10, false, 'Bank B')) });
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons[0] ?? '', /Bank A \(220 of 240\)/);
  assert.equal(decision.reasons[0]?.includes('Bank B'), false);
});

test('blocks when the bank refused further reads', () => {
  const decision = canRequestRefresh({ now: NOW, lastRefresh: null, budget: budget(input(50, true, 'Bank A')) });
  assert.match(decision.reasons[0] ?? '', /read limit was reached for Bank A/);
});

test('force skips the spacing and the budget checks', () => {
  const recent = entry({ requestedAt: '2026-10-26T15:55:00.000Z' });
  assert.equal(canRequestRefresh({ now: NOW, lastRefresh: recent, budget: budget(input(239, true)), force: true }).allowed, true);
});
