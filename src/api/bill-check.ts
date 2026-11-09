import type { Cents } from '../core/money.ts';
import { addDays, dayNumber } from '../core/dates.ts';
import { normalizeName } from '../core/names.ts';
import { DATA_START, localDay } from '../core/time.ts';
import { addMonthsToDay, cyclesFor, isCardPayment, type Cycle } from './cycles.ts';
import type { MutationResult } from './mutations.ts';
import { effectiveTransactions, visibleAccounts, type EffectiveTransaction } from './scope.ts';
import { installments } from './installments.ts';
import type { Store } from '../store/store.ts';

/** How far from a closing day a charge can sit and still plausibly belong to the neighbouring bill. */
const EDGE_DAYS = 6;
const MAX_MOVES = 3;
const TOLERANCE: Cents = 1;
/** A gap this close to an installment (or two) is read as that installment: banks round the cents of each one differently. */
const INSTALLMENT_TOLERANCE: Cents = 5;
/** A paid bill due this long ago is history. */
const OLD_BILL_DAYS = 45;
/** The owner's "this bill is known to be off" answers, as `accountId|cycleKey`. */
const DISMISSED_KEY = 'bill_check_dismissed';

/** The name the owner gave a transaction, as the lists show it, only when there is one. */
const ownName = (t: Pick<EffectiveTransaction, 'customName' | 'title'>): { name?: string } => (t.customName !== null ? { name: t.title } : {});

export interface BillMove {
  transactionId: string;
  day: string;
  amount: Cents;
  description: string;
  /** The name the owner gave it (with the counter on an installment), when it has one. `description` stays the bank text. */
  name?: string;
  /** Due month (YYYY-MM) of the bill the charge should be moved to. */
  toCycleKey: string;
}

export interface UnlistedInstallment {
  purchaseId: string;
  description: string;
  /** The name the owner gave the purchase, when it has one. */
  name?: string;
  number: number;
  total: number;
  amount: Cents;
  /** Due month (YYYY-MM) of the bill the app counted it in. */
  cycleKey: string;
}

/** A record the owner ignored that the bank still bills. */
export interface IgnoredCharge {
  transactionId: string;
  day: string;
  amount: Cents;
  description: string;
  /** The name the owner gave it (with the counter on an installment), when it has one. `description` stays the bank text. */
  name?: string;
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
    /**
     * The bill is larger and no charge near a closing explains it: something the bank never sent. `unlisted` is set when the
     * amount matches one or two installments the bank never listed that the app placed in a neighbouring bill.
     */
    | { kind: 'missing'; amount: Cents; unlisted?: UnlistedInstallment[] }
    /** The app counts more than the bill and no charge near a closing explains it. */
    | { kind: 'extra'; amount: Cents }
    /** The gap is exactly what the owner ignored in this cycle: putting these records back makes the bill close. */
    | { kind: 'ignored'; amount: Cents; records: IgnoredCharge[] };
  /** The app has no purchase at all in this cycle, only credits or installments it inferred. */
  noPurchases: boolean;
  /** The bill is paid and was due more than OLD_BILL_DAYS ago, and no ignored record explains it: history the screen keeps folded. */
  old: boolean;
}

/**
 * Consecutive bills of one card for which the bank sent no purchases at all, though it published the totals. They are one
 * problem (the connection stopped returning purchases), so they are one entry instead of one alarm per month.
 */
export interface BillCheckRun {
  accountId: string;
  institution: string;
  last4: string | null;
  /** Due months (YYYY-MM) of the oldest and the newest bill of the run. */
  fromKey: string;
  toKey: string;
  billTotal: Cents;
  ours: Cents;
  gap: Cents;
  /** Newest first. */
  bills: BillCheckItem[];
}

export interface DuplicatePayment {
  accountId: string;
  institution: string;
  last4: string | null;
  amount: Cents;
  /** The records that look like one payment, oldest first. Ignoring all but one is the fix. */
  members: Array<{ id: string; day: string; title: string; description: string; status: string; name?: string }>;
}

export interface BillCheckView {
  generatedAt: string;
  /** Bills that do not close, newest first. The bills of a run and the ones the owner dismissed are not here. */
  items: BillCheckItem[];
  /** Runs of two or more consecutive bills of one card with no purchases from the bank, newest first. */
  runs: BillCheckRun[];
  /** Bills the owner dismissed, newest first. They can be put back. */
  dismissed: BillCheckItem[];
  /** Card bill payments listed more than once (the pending and the posted copy, or two texts for one payment). */
  duplicatePayments: DuplicatePayment[];
  /** Pending entries set aside as stale, in case one of them is real. */
  setAside: Array<{ id: string; day: string; amount: Cents; description: string; institution: string; last4: string | null; name?: string }>;
}

interface Candidate {
  t: EffectiveTransaction;
  value: Cents;
}

/** Installments of a card the bank has not listed yet but bills in the cycle: they count in what the app adds up for it. */
function plannedInstallments(plan: ReturnType<typeof installments>, accountId: string, key: string): Cents {
  return plan.purchases.filter((p) => p.accountId === accountId).reduce((s, p) => s + p.slots.filter((x) => x.cycle === key && x.inferred && x.status !== 'future').length * p.amount, 0);
}

export interface BillGap {
  billTotal: Cents;
  ours: Cents;
  /** ours - billTotal, as in Conferir. */
  gap: Cents;
}

/**
 * Conferir's numbers for one bill of one card: the published total, what the app adds up for the cycle and the gap
 * (before any suggested move). Null when the bill has no published total, is still open, or Conferir does not judge it.
 */
export function billGapOf(store: Store, now: Date, accountId: string, cycleKey: string): BillGap | null {
  const account = store.listCanonicalAccounts().find((a) => a.id === accountId && a.kind === 'credit_card');
  if (!account) return null;
  const live = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).filter((t) => !t.excluded);
  const cycle = cyclesFor(store, account, live, localDay(now.toISOString())).find((c) => c.key === cycleKey);
  if (!cycle || cycle.billTotal === null || cycle.status === 'open' || cycle.status === 'unknown' || cycle.status === 'empty' || cycle.from < DATA_START) return null;
  const ours = cycle.charges - cycle.credits + plannedInstallments(installments(store, now), accountId, cycleKey);
  return { billTotal: cycle.billTotal, ours, gap: ours - cycle.billTotal };
}

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
  // Installments the bank has not listed yet but will bill: they explain part of what a bill has over the charges.
  const plan = installments(store, now);
  const plannedIn = (accountId: string, key: string) => plannedInstallments(plan, accountId, key);
  // Installments the bank never listed that the app counted in a closed bill next to this one: a gap equal to one of them points at it.
  const unlistedFor = (accountId: string, key: string, amount: Cents): UnlistedInstallment[] => {
    const near = new Set([-1, 0, 1].map((n) => addMonthsToDay(`${key}-01`, n).slice(0, 7)));
    const slots = plan.purchases
      .filter((p) => p.accountId === accountId)
      .flatMap((p) => p.slots.filter((x) => x.inferred && (x.status === 'paid' || x.status === 'billed') && x.cycle !== key && near.has(x.cycle)).map((x) => ({ purchaseId: p.id, description: p.description, ...(p.customName !== null ? { name: p.customName } : {}), number: x.number, total: p.total, amount: p.amount, cycleKey: x.cycle })));
    const hit = (value: Cents) => Math.abs(value - amount) <= INSTALLMENT_TOLERANCE;
    const single = slots.filter((x) => hit(x.amount));
    if (single.length > 0) return single.slice(0, 3);
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) if (hit(slots[i]!.amount + slots[j]!.amount)) return [slots[i]!, slots[j]!];
    return [];
  };
  const items: BillCheckItem[] = [];
  const runs: BillCheckRun[] = [];
  const dismissedItems: BillCheckItem[] = [];
  const dismissedKeys = dismissedBills(store);
  // What the owner ignored, by card: a bill that does not close may be short by exactly that.
  const ignoredBy = new Map<string, EffectiveTransaction[]>();
  for (const t of all) if (t.excluded && t.state === 'ignored' && !isCardPayment(t)) ignoredBy.set(t.accountId, [...(ignoredBy.get(t.accountId) ?? []), t]);
  // Hidden cards stay out of Faturas, so they stay out of this check too.
  const visible = visibleAccounts(store);
  const visibleIds = new Set(visible.map((a) => a.id));
  const cardAccounts = visible.filter((a) => a.kind === 'credit_card');

  for (const account of cardAccounts) {
    const cycles = cyclesFor(store, account, live, today);
    const own = live.filter((t) => t.accountId === account.id && !isCardPayment(t) && t.amount < 0);
    const within = (list: EffectiveTransaction[], c: Cycle) => list.filter((t) => (t.billCycle ? t.billCycle === c.key : localDay(t.occurredAt) >= c.from && localDay(t.occurredAt) <= c.to));
    const membership = (c: Cycle) => within(own, c);
    const ignored = ignoredBy.get(account.id) ?? [];
    const entries: Array<{ item: BillCheckItem; index: number }> = [];
    // Gaps already explained by a move suggested for an earlier cycle, so the same fix is not offered twice.
    const delta = new Map<string, Cents>();
    const taken = new Set<string>();

    cycles.forEach((cycle, i) => {
      if (cycle.billTotal === null || cycle.status === 'open' || cycle.status === 'unknown' || cycle.status === 'empty') return;
      if (cycle.dueDate < addDays(today, -400)) return;
      const ours = cycle.charges - cycle.credits + plannedIn(account.id, cycle.key) + (delta.get(cycle.key) ?? 0);
      const gap = ours - cycle.billTotal;
      if (Math.abs(gap) <= TOLERANCE) return;
      // Records the owner ignored that the bank still bills: putting back a charge (bill larger) or a credit (bill smaller) closes the gap.
      const restored = exactGroup(within(ignored, cycle).map((t) => ({ t, value: gap < 0 ? -t.amount : t.amount })).filter((c) => c.value > 0), Math.abs(gap), cycle.to);
      // The purchases from before DATA_START were deleted, so a cycle that starts earlier is only partly in the data and its total can not be judged.
      if (cycle.from < DATA_START && !restored) return;
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
        suggestion = { kind: 'move', moves: picked.map((p) => ({ transactionId: p.t.id, day: localDay(p.t.occurredAt), amount: p.t.amount, description: p.t.description, ...ownName(p.t), toCycleKey: toCycle.key })) };
      };
      // A neighbour with no published bill says nothing either way. One with a bill can take a charge only if it is short by
      // that much, and give one only if it has that much to spare; anything else would trade one gap for another.
      const spare = (c: Cycle | undefined): Cents | null => (c && c.billTotal !== null && c.status !== 'unknown' && c.status !== 'open' ? c.charges - c.credits + plannedIn(account.id, c.key) + (delta.get(c.key) ?? 0) - c.billTotal : null);
      const canTake = (c: Cycle | undefined, amount: Cents) => c !== undefined && (spare(c) === null || spare(c)! <= -amount + TOLERANCE);
      const canGive = (c: Cycle | undefined, amount: Cents) => c !== undefined && (spare(c) === null || spare(c)! >= amount - TOLERANCE);
      if (restored) {
        suggestion = { kind: 'ignored', amount: Math.abs(gap), records: restored.map((r) => ({ transactionId: r.t.id, day: localDay(r.t.occurredAt), amount: r.t.amount, description: r.t.description, ...ownName(r.t) })) };
      } else if (gap > 0) {
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
      let found: BillCheckItem['suggestion'] = suggestion ?? (gap < 0 ? { kind: 'missing', amount: -gap } : { kind: 'extra', amount: gap });
      if (found.kind === 'missing') {
        const unlisted = unlistedFor(account.id, cycle.key, found.amount);
        if (unlisted.length > 0) found = { ...found, unlisted };
      }
      entries.push({ index: i, item: {
        accountId: account.id,
        institution: account.institution,
        last4: account.last4,
        cycleKey: cycle.key,
        from: cycle.from,
        to: cycle.to,
        dueDate: cycle.dueDate,
        billTotal: cycle.billTotal,
        ours: cycle.charges - cycle.credits + plannedIn(account.id, cycle.key),
        gap: cycle.charges - cycle.credits + plannedIn(account.id, cycle.key) - cycle.billTotal,
        suggestion: found,
        noPurchases: cycle.charges === 0,
        // An ignored record to put back is worth seeing at any age.
        old: !restored && (cycle.status === 'paid' || cycle.status === 'rolled') && cycle.dueDate < addDays(today, -OLD_BILL_DAYS),
      } });
    });

    const kept = entries.filter((e) => !dismissedKeys.has(`${account.id}|${e.item.cycleKey}`)).sort((a, b) => a.index - b.index);
    dismissedItems.push(...entries.filter((e) => dismissedKeys.has(`${account.id}|${e.item.cycleKey}`)).map((e) => e.item));
    // Bills for which the bank sent no purchases, one after the other, are one problem: the next run of them is one entry.
    const noPurchases = (e: (typeof kept)[number]) => e.item.noPurchases && e.item.suggestion.kind === 'missing' && !e.item.suggestion.unlisted;
    for (let k = 0; k < kept.length; ) {
      let end = k;
      if (noPurchases(kept[k]!)) while (end + 1 < kept.length && noPurchases(kept[end + 1]!) && kept[end + 1]!.index === kept[end]!.index + 1) end++;
      const group = kept.slice(k, end + 1).map((e) => e.item);
      if (group.length < 2) items.push(...group);
      else runs.push({ accountId: account.id, institution: account.institution, last4: account.last4, fromKey: group[0]!.cycleKey, toKey: group[group.length - 1]!.cycleKey, billTotal: group.reduce((s, g) => s + g.billTotal, 0), ours: group.reduce((s, g) => s + g.ours, 0), gap: group.reduce((s, g) => s + g.gap, 0), bills: group.reverse() });
      k = end + 1;
    }
  }

  const accountOf = new Map(store.listCanonicalAccounts().map((a) => [a.id, a]));
  const setAside = all
    .filter((t) => t.excluded && t.state === 'stale_pending' && visibleIds.has(t.accountId))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount, description: t.description, institution: accountOf.get(t.accountId)?.institution ?? '', last4: accountOf.get(t.accountId)?.last4 ?? null, ...ownName(t) }));

  const newest = (a: BillCheckItem, b: BillCheckItem) => b.dueDate.localeCompare(a.dueDate) || a.institution.localeCompare(b.institution);
  items.sort(newest);
  dismissedItems.sort(newest);
  runs.sort((a, b) => b.toKey.localeCompare(a.toKey) || a.institution.localeCompare(b.institution));

  // The same card payment listed twice: equal amounts within three days that differ in text or status.
  const duplicatePayments: DuplicatePayment[] = [];
  for (const account of cardAccounts) {
    const payments = live.filter((t) => t.accountId === account.id && isCardPayment(t) && t.amount > 0).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const used = new Set<string>();
    for (const first of payments) {
      if (used.has(first.id)) continue;
      const group = payments.filter((o) => !used.has(o.id) && o.amount === first.amount && Math.abs(dayNumber(localDay(o.occurredAt)) - dayNumber(localDay(first.occurredAt))) <= 3);
      const looksRepeated = group.length > 1 && group.some((o) => o.status !== first.status || normalizeName(o.description) !== normalizeName(first.description));
      for (const o of group) used.add(o.id);
      if (!looksRepeated) continue;
      duplicatePayments.push({ accountId: account.id, institution: account.institution, last4: account.last4, amount: first.amount, members: group.map((o) => ({ id: o.id, day: localDay(o.occurredAt), title: o.title, description: o.description, status: o.status, ...ownName(o) })) });
    }
  }
  duplicatePayments.sort((a, b) => b.members[0]!.day.localeCompare(a.members[0]!.day));
  return { generatedAt: now.toISOString(), items, runs, dismissed: dismissedItems, duplicatePayments, setAside };
}

function dismissedBills(store: Store): Set<string> {
  try {
    const raw = store.getSetting(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** "I know this bill is off": it leaves the check until the owner puts it back. Kept as `accountId|cycleKey`, so a new sync does not bring it back. */
export function setBillCheckDismissed(store: Store, bills: unknown, dismissed: unknown, now: Date): MutationResult {
  if (typeof dismissed !== 'boolean') return { ok: false, status: 400, error: 'dismissed must be true or false' };
  if (!Array.isArray(bills) || bills.length === 0 || bills.length > 100) return { ok: false, status: 400, error: 'bills must be a list of 1 to 100 { accountId, cycleKey }' };
  const cards = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const keys: string[] = [];
  for (const b of bills as Array<{ accountId?: unknown; cycleKey?: unknown }>) {
    if (typeof b?.accountId !== 'string' || typeof b.cycleKey !== 'string' || !/^\d{4}-\d{2}$/.test(b.cycleKey)) return { ok: false, status: 400, error: 'each bill needs accountId and cycleKey (YYYY-MM)' };
    if (!cards.has(b.accountId)) return { ok: false, status: 404, error: 'not_found' };
    keys.push(`${b.accountId}|${b.cycleKey}`);
  }
  const set = dismissedBills(store);
  for (const key of keys) {
    if (dismissed) set.add(key);
    else set.delete(key);
  }
  store.setSetting(DISMISSED_KEY, JSON.stringify([...set].slice(-500)), now.toISOString());
  return { ok: true };
}
