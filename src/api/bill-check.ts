import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import { addDays, cyclesFor, isCardPayment, type Cycle } from './cycles.ts';
import { effectiveTransactions, type EffectiveTransaction } from './scope.ts';
import type { Store } from '../store/store.ts';

/** How far from a closing day a charge can sit and still plausibly belong to the neighbouring bill. */
const EDGE_DAYS = 6;
const MAX_MOVES = 3;
const TOLERANCE: Cents = 1;

export interface BillMove {
  transactionId: string;
  day: string;
  amount: Cents;
  description: string;
  /** Due month (YYYY-MM) of the bill the charge should be moved to. */
  toCycleKey: string;
}

export interface BillCheckItem {
  accountId: string;
  institution: string;
  last4: string | null;
  cycleKey: string;
  from: string;
  to: string;
  dueDate: string;
  /** What the issuer published for the bill, and what the app adds up for the cycle (charges minus credits). */
  billTotal: Cents;
  ours: Cents;
  /** ours - billTotal: positive when the app counts more than the bill. */
  gap: Cents;
  suggestion:
    | { kind: 'move'; moves: BillMove[] }
    /** The bill is larger and no charge near a closing explains it: something the bank never sent. */
    | { kind: 'missing'; amount: Cents }
    /** The app counts more than the bill and no charge near a closing explains it. */
    | { kind: 'extra'; amount: Cents };
}

export interface BillCheckView {
  generatedAt: string;
  items: BillCheckItem[];
  /** Pending entries set aside as stale, in case one of them is real. */
  setAside: Array<{ id: string; day: string; amount: Cents; description: string; institution: string; last4: string | null }>;
}

interface Candidate {
  t: EffectiveTransaction;
  value: Cents;
}

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/**
 * Smallest group (up to MAX_MOVES) whose values add up to `target`. When several groups of that size do, the one closest
 * to the closing day (`anchor`) wins, because that is where bank and card disagree about the day; a tie gives up.
 */
function exactGroup(candidates: Candidate[], target: Cents, anchor: string): Candidate[] | null {
  if (target <= 0) return null;
  const distance = (group: Candidate[]) => group.reduce((s, c) => s + Math.abs(dayNumber(localDay(c.t.occurredAt)) - dayNumber(anchor)), 0);
  for (let size = 1; size <= MAX_MOVES; size++) {
    const found: Candidate[][] = [];
    const walk = (from: number, left: number, sum: number, chosen: Candidate[]) => {
      if (left === 0) {
        if (sum === target) found.push([...chosen]);
        return;
      }
      for (let i = from; i < candidates.length; i++) walk(i + 1, left - 1, sum + candidates[i]!.value, [...chosen, candidates[i]!]);
    };
    walk(0, size, 0, []);
    if (found.length === 0) continue;
    const ranked = found.map((g) => ({ g, d: distance(g) })).sort((a, b) => a.d - b.d);
    return ranked.length > 1 && ranked[0]!.d === ranked[1]!.d ? null : ranked[0]!.g;
  }
  return null;
}

/**
 * Closed bills whose published total differs from what the app adds up, with the likeliest reason. A charge near the
 * closing day that moves to the neighbouring bill and fixes both is offered as a move. What no move explains is a
 * charge the bank never sent (missing) or a charge the bank does not bill (extra).
 */
export function billCheck(store: Store, now: Date): BillCheckView {
  const all = effectiveTransactions(store, { includeHidden: true, includeExcluded: true });
  const live = all.filter((t) => !t.excluded);
  const today = localDay(now.toISOString());
  const items: BillCheckItem[] = [];

  for (const account of store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card')) {
    const cycles = cyclesFor(store, account, live, today);
    const own = live.filter((t) => t.accountId === account.id && !isCardPayment(t) && t.amount < 0);
    const membership = (c: Cycle) => own.filter((t) => (t.billCycle ? t.billCycle === c.key : localDay(t.occurredAt) >= c.from && localDay(t.occurredAt) <= c.to));
    // Gaps already explained by a move suggested for an earlier cycle, so the same fix is not offered twice.
    const delta = new Map<string, Cents>();
    const taken = new Set<string>();

    cycles.forEach((cycle, i) => {
      if (cycle.billTotal === null || cycle.status === 'open' || cycle.status === 'unknown' || cycle.status === 'empty') return;
      if (cycle.dueDate < addDays(today, -400)) return;
      const ours = cycle.charges - cycle.credits + (delta.get(cycle.key) ?? 0);
      const gap = ours - cycle.billTotal;
      if (Math.abs(gap) <= TOLERANCE) return;
      const previous = cycles[i - 1];
      const next = cycles[i + 1];
      const near = (list: EffectiveTransaction[], from: string, to: string): Candidate[] =>
        list.filter((t) => !t.billCycle && !taken.has(t.id) && localDay(t.occurredAt) >= from && localDay(t.occurredAt) <= to).map((t) => ({ t, value: -t.amount }));

      let suggestion: BillCheckItem['suggestion'] | null = null;
      const record = (picked: Candidate[], toCycle: Cycle, fromCycleKey: string) => {
        for (const p of picked) taken.add(p.t.id);
        const sum = picked.reduce((s, p) => s + p.value, 0);
        delta.set(fromCycleKey, (delta.get(fromCycleKey) ?? 0) - sum);
        delta.set(toCycle.key, (delta.get(toCycle.key) ?? 0) + sum);
        suggestion = { kind: 'move', moves: picked.map((p) => ({ transactionId: p.t.id, day: localDay(p.t.occurredAt), amount: p.t.amount, description: p.t.description, toCycleKey: toCycle.key })) };
      };
      // A neighbour with no published bill says nothing either way. One with a bill can take a charge only if it is short by
      // that much, and give one only if it has that much to spare; anything else would trade one gap for another.
      const spare = (c: Cycle | undefined): Cents | null => (c && c.billTotal !== null && c.status !== 'unknown' && c.status !== 'open' ? c.charges - c.credits + (delta.get(c.key) ?? 0) - c.billTotal : null);
      const canTake = (c: Cycle | undefined, amount: Cents) => c !== undefined && (spare(c) === null || spare(c)! <= -amount + TOLERANCE);
      const canGive = (c: Cycle | undefined, amount: Cents) => c !== undefined && (spare(c) === null || spare(c)! >= amount - TOLERANCE);
      if (gap > 0) {
        // We count more than the bill: the last days of this cycle may belong to the next bill, the first days to the previous one.
        const tail = canTake(next, gap) ? exactGroup(near(membership(cycle), addDays(cycle.to, -EDGE_DAYS), cycle.to), gap, cycle.to) : null;
        const head = canTake(previous, gap) ? exactGroup(near(membership(cycle), cycle.from, addDays(cycle.from, EDGE_DAYS)), gap, cycle.from) : null;
        if (tail && next) record(tail, next, cycle.key);
        else if (head && previous) record(head, previous, cycle.key);
      } else {
        // The bill is larger: the first days of the next cycle, or the last days of the previous one, may belong here.
        const pullFromNext = canGive(next, -gap) && next ? exactGroup(near(membership(next), next.from, addDays(next.from, EDGE_DAYS + 1)), -gap, next.from) : null;
        const pullFromPrevious = canGive(previous, -gap) && previous ? exactGroup(near(membership(previous), addDays(previous.to, -EDGE_DAYS), previous.to), -gap, previous.to) : null;
        if (pullFromNext && next) record(pullFromNext, cycle, next.key);
        else if (pullFromPrevious && previous) record(pullFromPrevious, cycle, previous.key);
      }
      items.push({
        accountId: account.id,
        institution: account.institution,
        last4: account.last4,
        cycleKey: cycle.key,
        from: cycle.from,
        to: cycle.to,
        dueDate: cycle.dueDate,
        billTotal: cycle.billTotal,
        ours: cycle.charges - cycle.credits,
        gap: cycle.charges - cycle.credits - cycle.billTotal,
        suggestion: suggestion ?? (gap < 0 ? { kind: 'missing', amount: -gap } : { kind: 'extra', amount: gap }),
      });
    });
  }

  const accountOf = new Map(store.listCanonicalAccounts().map((a) => [a.id, a]));
  const setAside = all
    .filter((t) => t.excluded && t.state === 'stale_pending')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount, description: t.description, institution: accountOf.get(t.accountId)?.institution ?? '', last4: accountOf.get(t.accountId)?.last4 ?? null }));

  items.sort((a, b) => b.dueDate.localeCompare(a.dueDate) || a.institution.localeCompare(b.institution));
  return { generatedAt: now.toISOString(), items, setAside };
}
