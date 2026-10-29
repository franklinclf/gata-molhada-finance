/** What a rule can look at, as plain values. Built from a transaction by the caller. */
export interface RuleSubject {
  description: string;
  /** The shop or person with gateway prefixes, store numbers and company suffixes removed. */
  merchant: string;
  counterparty: string;
  /** Every label the sources put on it, joined. */
  sourceLabel: string;
  institution: string;
  account: string;
  operation: string;
  mcc: string;
  status: 'pending' | 'posted';
  direction: 'in' | 'out';
  /** Signed cents: money out is negative. */
  amount: number;
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** card_payment, own_transfer, investment or empty. */
  role: string;
}

export const TEXT_FIELDS = ['description', 'merchant', 'counterparty', 'sourceLabel', 'institution', 'account', 'operation', 'mcc'] as const;
export const NUMBER_FIELDS = ['amount', 'date'] as const;
export const ENUM_FIELDS = { status: ['pending', 'posted'], direction: ['in', 'out'], role: ['card_payment', 'own_transfer', 'investment', 'none'] } as const;
export type RuleField = (typeof TEXT_FIELDS)[number] | (typeof NUMBER_FIELDS)[number] | keyof typeof ENUM_FIELDS;

export const TEXT_OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'regex'] as const;
export const NUMBER_OPERATORS = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'] as const;
export const ENUM_OPERATORS = ['equals', 'not_equals'] as const;
export type RuleOperator = (typeof TEXT_OPERATORS)[number] | (typeof NUMBER_OPERATORS)[number];

export interface Leaf {
  field: RuleField;
  operator: RuleOperator;
  /** Text, or cents for amount, or a YYYY-MM-DD day for date. */
  value: string | number;
}

export interface Group {
  match: 'all' | 'any';
  leaves: Leaf[];
}

export interface RuleConditions {
  match: 'all' | 'any';
  /** Leaves and groups of leaves. Groups cannot hold groups, so a rule reads "A and (B or C)" and no deeper. */
  items: Array<Leaf | Group>;
}

export interface RuleActions {
  category: string;
}

export interface Rule {
  id: number;
  name: string;
  /** Lower runs first. The first rule that sets a category wins. */
  priority: number;
  active: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
}

const MAX_REGEX_LENGTH = 120;
const MAX_ITEMS = 20;
const MAX_VALUE_LENGTH = 200;

/** Lowercase without accents, so ITAÚ and itau compare equal. */
const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const stripAccents = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export const isGroup = (item: Leaf | Group): item is Group => 'leaves' in item;

const fieldKind = (field: string): 'text' | 'number' | 'enum' | null =>
  (TEXT_FIELDS as readonly string[]).includes(field) ? 'text' : (NUMBER_FIELDS as readonly string[]).includes(field) ? 'number' : field in ENUM_FIELDS ? 'enum' : null;

/** A regex that cannot match nothing, is not huge, and does not stack quantifiers (the usual cause of runaway matching). */
export function compileRegex(pattern: string): RegExp | string {
  if (pattern.length > MAX_REGEX_LENGTH) return `regex is longer than ${MAX_REGEX_LENGTH} characters`;
  if (/(\+|\*|\{\d*,?\d*\})\s*\)\s*(\+|\*|\{)/.test(pattern)) return 'regex repeats a repeated group';
  let regex: RegExp;
  try {
    regex = new RegExp(stripAccents(pattern), 'i');
  } catch {
    return 'regex does not compile';
  }
  return regex.test('') ? 'regex matches empty text, which means every transaction' : regex;
}

function leafError(leaf: unknown): string | null {
  if (typeof leaf !== 'object' || leaf === null) return 'condition must be an object';
  const { field, operator, value } = leaf as Record<string, unknown>;
  if (typeof field !== 'string' || typeof operator !== 'string') return 'condition needs field and operator';
  const kind = fieldKind(field);
  if (kind === null) return `unknown field ${field}`;
  const allowed: readonly string[] = kind === 'text' ? TEXT_OPERATORS : kind === 'number' ? NUMBER_OPERATORS : ENUM_OPERATORS;
  if (!allowed.includes(operator)) return `${operator} does not work with ${field}`;
  if (kind === 'number') {
    if (field === 'amount') return typeof value === 'number' && Number.isInteger(value) ? null : 'amount must be a whole number of cents';
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'date must look like 2026-10-28';
  }
  if (typeof value !== 'string' || value.trim() === '') return 'a condition value cannot be empty';
  if (value.length > MAX_VALUE_LENGTH) return `a condition value is longer than ${MAX_VALUE_LENGTH} characters`;
  if (kind === 'enum') return (ENUM_FIELDS[field as keyof typeof ENUM_FIELDS] as readonly string[]).includes(value) ? null : `${value} is not a valid ${field}`;
  if (operator === 'regex') {
    const compiled = compileRegex(value);
    return typeof compiled === 'string' ? compiled : null;
  }
  return null;
}

/** Null when the conditions are usable, otherwise what is wrong. */
export function conditionsError(conditions: unknown): string | null {
  if (typeof conditions !== 'object' || conditions === null) return 'conditions must be an object';
  const { match, items } = conditions as Record<string, unknown>;
  if (match !== 'all' && match !== 'any') return 'match must be all or any';
  if (!Array.isArray(items) || items.length === 0) return 'add at least one condition';
  if (items.length > MAX_ITEMS) return `a rule can have at most ${MAX_ITEMS} conditions`;
  for (const item of items) {
    if (typeof item === 'object' && item !== null && 'leaves' in item) {
      const group = item as Record<string, unknown>;
      if (group.match !== 'all' && group.match !== 'any') return 'group match must be all or any';
      if (!Array.isArray(group.leaves) || group.leaves.length === 0) return 'a group cannot be empty';
      if (group.leaves.length > MAX_ITEMS) return `a group can have at most ${MAX_ITEMS} conditions`;
      for (const leaf of group.leaves) {
        if (typeof leaf === 'object' && leaf !== null && 'leaves' in leaf) return 'a group cannot hold another group';
        const error = leafError(leaf);
        if (error) return error;
      }
    } else {
      const error = leafError(item);
      if (error) return error;
    }
  }
  return null;
}

function text(subject: RuleSubject, field: (typeof TEXT_FIELDS)[number]): string {
  return subject[field];
}

function compareNumber(actual: number | string, operator: string, expected: number | string): boolean {
  switch (operator) {
    case 'equals': return actual === expected;
    case 'not_equals': return actual !== expected;
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    default: return false;
  }
}

function leafMatches(subject: RuleSubject, leaf: Leaf, regexes: Map<string, RegExp | null>): boolean {
  const kind = fieldKind(leaf.field);
  if (kind === 'number') return compareNumber(leaf.field === 'amount' ? subject.amount : subject.date, leaf.operator, leaf.value);
  const wanted = String(leaf.value);
  // A blank value never matches: an empty text is inside every text.
  if (kind === 'enum') {
    if (wanted.trim() === '') return false;
    const actual = leaf.field === 'role' ? subject.role || 'none' : String(subject[leaf.field as 'status' | 'direction']);
    return leaf.operator === 'equals' ? actual === wanted : actual !== wanted;
  }
  if (kind !== 'text' || wanted.trim() === '') return false;
  const actual = text(subject, leaf.field as (typeof TEXT_FIELDS)[number]);
  if (leaf.operator === 'regex') {
    let regex = regexes.get(wanted);
    if (regex === undefined) {
      const compiled = compileRegex(wanted);
      regex = typeof compiled === 'string' ? null : compiled;
      regexes.set(wanted, regex);
    }
    return regex !== null && regex.test(stripAccents(actual));
  }
  const a = fold(actual);
  const w = fold(wanted);
  switch (leaf.operator) {
    case 'contains': return a.includes(w);
    case 'not_contains': return !a.includes(w);
    case 'equals': return a === w;
    case 'not_equals': return a !== w;
    case 'starts_with': return a.startsWith(w);
    case 'ends_with': return a.endsWith(w);
    default: return false;
  }
}

/** True when the subject satisfies the conditions. An invalid or empty set of conditions matches nothing. */
export function matches(subject: RuleSubject, conditions: RuleConditions, regexes: Map<string, RegExp | null> = new Map()): boolean {
  if (conditionsError(conditions) !== null) return false;
  const results = conditions.items.map((item) =>
    isGroup(item) ? (item.match === 'all' ? item.leaves.every((l) => leafMatches(subject, l, regexes)) : item.leaves.some((l) => leafMatches(subject, l, regexes))) : leafMatches(subject, item, regexes),
  );
  return conditions.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

/** The category the first matching active rule gives, going by priority and then id. Null when none does. */
export function categoryFromRules(subject: RuleSubject, rules: readonly Rule[], regexes: Map<string, RegExp | null> = new Map()): { category: string; rule: Rule } | null {
  for (const rule of rules) {
    if (!rule.active || rule.actions.category === '') continue;
    if (matches(subject, rule.conditions, regexes)) return { category: rule.actions.category, rule };
  }
  return null;
}

export const sortRules = (rules: readonly Rule[]): Rule[] => [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
