import { createHash } from 'node:crypto';
import { formatBRL } from '../core/money.ts';
import type { AccountKind, SourceAccount, SourceId } from '../core/types.ts';
import { institutionKey, normalizeName } from './names.ts';
import type { AccountRef, CanonicalAccount, LimitGroup } from '../core/canonical.ts';
import type { AccountReconciliation, AccountTotals, SourceView } from './types.ts';

interface Member {
  sourceId: SourceId;
  priority: number;
  account: SourceAccount;
}

interface Cluster {
  kind: AccountKind;
  institutionKey: string;
  members: Member[];
  duplicates: Array<{ sourceId: SourceId; account: SourceAccount }>;
  strong: Set<string>;
  loose: Set<string>;
}

interface Keys {
  strong: Set<string>;
  loose: Set<string>;
}

const KIND_ORDER: Record<AccountKind, number> = { checking: 0, savings: 1, credit_card: 2 };

function hashId(prefix: string, text: string): string {
  return `${prefix}_${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/** Transaction fingerprints per account, used to tell which accounts of two sources are the same one. */
function keysByAccount(view: SourceView): Map<string, Keys> {
  const out = new Map<string, Keys>();
  for (const t of view.transactions) {
    const entry = out.get(t.accountExternalId) ?? { strong: new Set<string>(), loose: new Set<string>() };
    entry.strong.add(`${t.occurredAt}|${t.amount}|${normalizeName(t.descriptionRaw ?? t.description)}`);
    entry.loose.add(`${t.occurredAt.slice(0, 10)}|${t.amount}`);
    out.set(t.accountExternalId, entry);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const key of small) if (large.has(key)) count++;
  return count;
}

function score(cluster: Cluster, keys: Keys | undefined): number {
  if (!keys) return 0;
  return overlap(cluster.strong, keys.strong) * 10 + overlap(cluster.loose, keys.loose);
}

/** Copies of one card that a source lists more than once (same kind, last digits and name) form a group. */
function groupDuplicates(accounts: SourceAccount[]): SourceAccount[][] {
  const groups = new Map<string, SourceAccount[]>();
  for (const account of accounts) {
    const key = account.last4 ? `${account.kind}|${account.last4}|${normalizeName(account.name)}` : `single|${account.externalId}`;
    groups.set(key, [...(groups.get(key) ?? []), account]);
  }
  return [...groups.values()].sort((a, b) => {
    const left = a[0] as SourceAccount;
    const right = b[0] as SourceAccount;
    return (
      institutionKey(left.institution).localeCompare(institutionKey(right.institution)) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.name.localeCompare(right.name) ||
      left.externalId.localeCompare(right.externalId)
    );
  });
}

function freshnessOf(view: SourceView, institution: string): string | null {
  const wanted = institutionKey(institution);
  return view.freshness.find((f) => institutionKey(f.institution) === wanted)?.lastUpdatedAt ?? null;
}

interface Placement {
  cluster: Cluster;
  member: SourceAccount;
}

function bestPlacement(clusters: Cluster[], group: SourceAccount[], sourceId: SourceId, keys: Map<string, Keys>): Placement | null {
  let best: { placement: Placement; score: number; sameInstitution: boolean } | null = null;
  const twins = group.length > 1;

  for (const cluster of clusters) {
    if (cluster.members.some((m) => m.sourceId === sourceId)) continue;
    for (const member of group) {
      if (member.kind !== cluster.kind) continue;
      const sameInstitution = institutionKey(member.institution) === cluster.institutionKey;
      const s = score(cluster, keys.get(member.externalId));
      if (!sameInstitution && !(twins && s > 0)) continue;
      if (s === 0) continue;
      const better =
        best === null || s > best.score || (s === best.score && sameInstitution && !best.sameInstitution);
      if (better) best = { placement: { cluster, member }, score: s, sameInstitution };
    }
  }
  if (best) return best.placement;

  // No shared transactions (for example an empty savings account): fall back to institution, kind and name.
  for (const cluster of clusters) {
    if (cluster.members.some((m) => m.sourceId === sourceId)) continue;
    const primaryName = normalizeName((cluster.members[0] as Member).account.name);
    for (const member of group) {
      if (member.kind === cluster.kind && institutionKey(member.institution) === cluster.institutionKey && normalizeName(member.name) === primaryName) {
        return { cluster, member };
      }
    }
  }
  return null;
}

function addMember(cluster: Cluster, view: SourceView, member: SourceAccount, group: SourceAccount[], keys: Map<string, Keys>): void {
  cluster.members.push({ sourceId: view.sourceId, priority: view.priority, account: member });
  for (const other of group) {
    if (other !== member) cluster.duplicates.push({ sourceId: view.sourceId, account: other });
  }
  for (const copy of group) {
    const k = keys.get(copy.externalId);
    if (!k) continue;
    for (const s of k.strong) cluster.strong.add(s);
    for (const l of k.loose) cluster.loose.add(l);
  }
}

function pickRepresentative(view: SourceView, group: SourceAccount[]): SourceAccount {
  const ranked = [...group].sort((a, b) => {
    const fa = freshnessOf(view, a.institution) ?? '';
    const fb = freshnessOf(view, b.institution) ?? '';
    return fb.localeCompare(fa) || a.externalId.localeCompare(b.externalId);
  });
  return ranked[0] as SourceAccount;
}

export function reconcileAccounts(views: SourceView[]): AccountReconciliation {
  const ordered = [...views].sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));
  const clusters: Cluster[] = [];

  for (const view of ordered) {
    const keys = keysByAccount(view);
    for (const group of groupDuplicates(view.accounts)) {
      const placement = bestPlacement(clusters, group, view.sourceId, keys);
      if (placement) {
        addMember(placement.cluster, view, placement.member, group, keys);
        continue;
      }
      const representative = pickRepresentative(view, group);
      const cluster: Cluster = {
        kind: representative.kind,
        institutionKey: institutionKey(representative.institution),
        members: [],
        duplicates: [],
        strong: new Set(),
        loose: new Set(),
      };
      addMember(cluster, view, representative, group, keys);
      clusters.push(cluster);
    }
  }

  const viewById = new Map(ordered.map((v) => [v.sourceId, v]));
  const notes: string[] = [];
  const usedIds = new Set<string>();
  const accounts: CanonicalAccount[] = [];

  for (const cluster of clusters) {
    const primary = cluster.members[0] as Member;
    const label = `${primary.account.institution} / ${primary.account.name}`;

    const withFreshness = cluster.members.map((m) => ({
      member: m,
      asOf: freshnessOf(viewById.get(m.sourceId) as SourceView, m.account.institution),
    }));
    const ranked = [...withFreshness].sort(
      (a, b) => (b.asOf ?? '').localeCompare(a.asOf ?? '') || a.member.priority - b.member.priority,
    );
    const chosen = ranked[0] as (typeof ranked)[number];

    const pick = <T>(read: (a: SourceAccount) => T | null): T | null => {
      const first = read(chosen.member.account);
      if (first !== null) return first;
      for (const m of cluster.members) {
        const value = read(m.account);
        if (value !== null) return value;
      }
      return null;
    };

    const baseKey = `${cluster.kind}|${cluster.institutionKey}|${normalizeName(primary.account.name)}`;
    const key = usedIds.has(hashId('acc', baseKey)) ? `${baseKey}|${primary.sourceId}:${primary.account.externalId}` : baseKey;
    const id = hashId('acc', key);
    usedIds.add(id);

    const refs: AccountRef[] = [
      ...cluster.members.map((m) => ({ sourceId: m.sourceId, externalId: m.account.externalId, role: 'member' as const })),
      ...cluster.duplicates.map((d) => ({ sourceId: d.sourceId, externalId: d.account.externalId, role: 'duplicate' as const })),
    ];

    accounts.push({
      id,
      institution: primary.account.institution,
      kind: cluster.kind,
      name: primary.account.name,
      last4: pick((a) => a.last4),
      balance: chosen.member.account.balance,
      balanceSourceId: chosen.member.sourceId,
      balanceAsOf: chosen.asOf,
      creditLimit: pick((a) => a.creditLimit),
      availableLimit: pick((a) => a.availableLimit),
      minimumPayment: pick((a) => a.minimumPayment),
      dueDate: pick((a) => a.dueDate),
      limitGroupId: null,
      refs,
    });

    for (const d of cluster.duplicates) {
      notes.push(`${label}: ignored a duplicate copy in ${d.sourceId} (listed under ${d.account.institution})`);
    }
    if (cluster.institutionKey !== 'manual' && cluster.members.length < ordered.length) {
      const present = new Set(cluster.members.map((m) => m.sourceId));
      const missing = ordered.filter((v) => !present.has(v.sourceId)).map((v) => v.sourceId);
      notes.push(`${label}: not found in ${missing.join(', ')}`);
    }
    const balances = new Set(cluster.members.map((m) => m.account.balance));
    if (balances.size > 1) {
      const detail = withFreshness
        .map((w) => `${w.member.sourceId} ${formatBRL(w.member.account.balance)} (as of ${w.asOf ?? 'unknown'})`)
        .join(' vs ');
      notes.push(`${label}: balances differ, ${detail}; using ${chosen.member.sourceId}`);
    }
  }

  const groups = buildLimitGroups(accounts);
  accounts.sort(
    (a, b) =>
      a.institution.localeCompare(b.institution) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
  return { accounts, groups, notes };
}

/**
 * Cards of one institution that report the same limit and the same available amount, with
 * something already used, share one limit. Unused cards are left alone, because two separate
 * cards with equal limits would look identical.
 */
function buildLimitGroups(accounts: CanonicalAccount[]): LimitGroup[] {
  const byKey = new Map<string, CanonicalAccount[]>();
  for (const a of accounts) {
    if (a.kind !== 'credit_card' || a.creditLimit === null || a.availableLimit === null) continue;
    if (a.creditLimit - a.availableLimit <= 0) continue;
    const key = `${institutionKey(a.institution)}|${a.creditLimit}|${a.availableLimit}`;
    byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }
  const groups: LimitGroup[] = [];
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    const memberIds = members.map((m) => m.id).sort();
    const id = hashId('lg', memberIds.join('|'));
    for (const m of members) m.limitGroupId = id;
    groups.push({ id, institution: (members[0] as CanonicalAccount).institution, creditLimit: (members[0] as CanonicalAccount).creditLimit as number, memberIds });
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}

export function summarizeAccounts(accounts: CanonicalAccount[]): AccountTotals {
  const totals: AccountTotals = { bankBalance: 0, cardOwed: 0, creditLimit: 0, creditUsed: 0, creditAvailable: 0 };
  const seenGroups = new Set<string>();

  for (const a of accounts) {
    if (a.kind !== 'credit_card') {
      totals.bankBalance += a.balance;
      continue;
    }
    if (a.limitGroupId !== null) {
      if (seenGroups.has(a.limitGroupId)) continue;
      seenGroups.add(a.limitGroupId);
    }
    totals.cardOwed += a.balance;
    if (a.creditLimit === null) continue;
    totals.creditLimit += a.creditLimit;
    const available = a.availableLimit ?? a.creditLimit - a.balance;
    totals.creditAvailable += available;
    totals.creditUsed += a.creditLimit - available;
  }
  return totals;
}
