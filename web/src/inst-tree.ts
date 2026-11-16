export interface TreeAccount {
  id: string;
  institution: string;
  count: number;
}

export interface TreeNode {
  institution: string;
  count: number;
  accounts: TreeAccount[];
}

/** Groups the accounts under their institution; the count of an institution comes from its facet when there is one. */
export function buildTree(institutions: Array<{ name: string; count: number }>, accounts: TreeAccount[]): TreeNode[] {
  const byName = new Map<string, TreeNode>();
  for (const i of institutions) byName.set(i.name, { institution: i.name, count: i.count, accounts: [] });
  for (const a of accounts) {
    const node = byName.get(a.institution) ?? { institution: a.institution, count: 0, accounts: [] };
    if (!byName.has(a.institution)) {
      byName.set(a.institution, node);
      node.count = a.count;
    }
    node.accounts.push(a);
  }
  return [...byName.values()].sort((x, y) => y.count - x.count || x.institution.localeCompare(y.institution));
}

export type CheckState = 'on' | 'off' | 'some';

/** An institution is on when it is chosen as a whole, partly on when only some of its accounts are. */
export function nodeState(node: TreeNode, institutions: string[], accountIds: string[]): CheckState {
  if (institutions.includes(node.institution)) return 'on';
  return node.accounts.some((a) => accountIds.includes(a.id)) ? 'some' : 'off';
}

/** Ticking an institution chooses it as a whole and drops its single accounts; unticking drops both. */
export function toggleInstitution(node: TreeNode, institutions: string[], accountIds: string[]): { institution: string[]; accountId: string[] } {
  const own = new Set(node.accounts.map((a) => a.id));
  const rest = accountIds.filter((id) => !own.has(id));
  const on = institutions.includes(node.institution);
  const state = nodeState(node, institutions, accountIds);
  if (on || state === 'some') return { institution: institutions.filter((i) => i !== node.institution), accountId: rest };
  return { institution: [...institutions, node.institution], accountId: rest };
}

/**
 * Ticking one account of a chosen institution would be a no-op, so the institution is replaced by its other accounts instead.
 * When every account ends up ticked, the choice collapses to the institution.
 */
export function toggleAccount(node: TreeNode, id: string, institutions: string[], accountIds: string[]): { institution: string[]; accountId: string[] } {
  if (institutions.includes(node.institution)) {
    return { institution: institutions.filter((i) => i !== node.institution), accountId: [...accountIds, ...node.accounts.filter((a) => a.id !== id).map((a) => a.id)] };
  }
  const next = accountIds.includes(id) ? accountIds.filter((x) => x !== id) : [...accountIds, id];
  if (node.accounts.length > 1 && node.accounts.every((a) => next.includes(a.id))) {
    const own = new Set(node.accounts.map((a) => a.id));
    return { institution: [...institutions, node.institution], accountId: next.filter((x) => !own.has(x)) };
  }
  return { institution: institutions, accountId: next };
}

/** An account counts as ticked when it or its institution is chosen. */
export const accountOn = (node: TreeNode, id: string, institutions: string[], accountIds: string[]): boolean => institutions.includes(node.institution) || accountIds.includes(id);

/** Few accounts: open from the start. A node with something chosen inside is open too. */
export const startsOpen = (node: TreeNode, state: CheckState): boolean => node.accounts.length <= 3 || state === 'some';
