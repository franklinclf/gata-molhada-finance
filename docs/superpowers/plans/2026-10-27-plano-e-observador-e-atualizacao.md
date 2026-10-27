# Gata Molhada Finance, Plano E: observador, atualização manual e cota (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manter os dados atualizados sem gastar a cota de leituras dos bancos: um observador que consulta de tempos em tempos quando cada fonte sincronizou cada banco e lê os dados novos, uma atualização manual pelo Pierre com travas, e um relatório da cota usada no mês.

**Architecture:** Os adapters ganham `fetchFreshness`, uma leitura leve e sem registro de snapshot. O `Store` passa a contar cada horário de sincronização distinto como uma leitura de banco no mês e a registrar as atualizações manuais. `Observer` verifica cada fonte no seu intervalo e, quando há horário novo, lê a fonte e reconstrói os dados canônicos. `requestManualRefresh` aplica a política de cota e espaçamento, pede a atualização uma única vez e espera cada banco informar um horário novo. Tudo recebe relógio e espera por injeção, então os testes não usam tempo real nem rede.

**Tech Stack:** Node 22 (`node:sqlite`, `node:test`, `fetch`), TypeScript por remoção de tipos. Nenhuma dependência nova.

## Global Constraints

- Node >= 22.18, TypeScript por remoção de tipos: só sintaxe apagável (sem `enum`, `namespace` nem propriedades de parâmetro no construtor), `import type` para tipos e extensão `.ts` em todo import relativo.
- Sem dependências novas. Datas em ISO 8601 UTC; o mês da cota é o mês no Brasil (UTC-3), porque o limite dos bancos renova no dia 1.
- Repositório público: testes e fixtures só têm dados sintéticos e nomes neutros.
- O pedido de atualização manual (`POST manual-update`) é enviado uma vez e nunca repetido: cada atualização consome leituras dos bancos.
- A verificação do observador não toca os bancos e não grava snapshots brutos.
- Quem executa este plano não faz commit nem push sem pedido explícito do usuário. A `main` é protegida: o trabalho vai em branch.
- Identificadores e comentários em inglês. Documentação em português.
- Raiz do projeto: `~/IdeaProjects/pierre-finance-app`. Todos os caminhos são relativos a ela.

## Aprovações e decisões (perguntas ao usuário, não passos)

- **E-A** (Tarefa 6): posso acrescentar os scripts `refresh`, `watch` e `quota` ao `package.json` e o campo `observer` à configuração? Nenhuma dependência é instalada.
- **E-B** (Tarefa 7): posso rodar `npm run watch -- --once` e `npm run quota` com o banco real? Eles fazem leituras leves nas duas fontes e gravam em `data/gmf.sqlite`, sem gastar cota dos bancos.
- **E-C** (Tarefa 7, opcional): posso rodar uma única `npm run refresh`? Ela pede ao Pierre que sincronize todos os bancos e consome leituras da cota de cada um.
- **E-D** (fora do plano): ligar `OBSERVER=on` na VM exige antes gravar `PIERRE-API-KEY`, `PLUGGY-CLIENT-ID`, `PLUGGY-CLIENT-SECRET` e `PLUGGY-ITEMS` no Key Vault e listá-los em `deploy/secrets.list`. Fica como passo à parte.

Decisões de design deste plano (revisáveis antes de executar):

1. **Contagem de cota.** Cada horário de sincronização distinto que uma fonte informa para uma instituição conta como uma leitura de banco, e o total do mês soma as duas fontes, porque as duas leem os mesmos bancos. É uma estimativa, e o relatório diz isso. Um horário visto pela primeira vez, mesmo que seja o de uma execução antiga, também conta.
2. **Limites.** 240 leituras de transações por mês por instituição (valor da documentação do Pluggy). Aviso a partir de 70% e bloqueio da atualização manual a partir de 90%. Uma fonte que informa o erro 423 (limite de leituras do banco atingido) marca a instituição como esgotada, o que também bloqueia.
3. **Atualização manual.** Bloqueada se: outra atualização está em andamento (um pedido sem término com menos de 5 minutos), a última foi há menos de 15 minutos, alguma instituição está esgotada ou com 90% usados. `--force` pula o espaçamento e a cota, mas nunca a trava de "em andamento". Depois do pedido, lê os horários a cada 5 segundos por até 3 minutos e registra o resultado como `completed`, `timeout` ou `failed`. A atualização do Pierre sincroniza todos os bancos de uma vez, sem filtro.
4. **Observador.** Pierre a cada 5 minutos, Pluggy a cada 2 minutos. Um horário novo dispara a leitura da fonte (contas, transações dos últimos 14 dias e faturas) e a reconstrução dos dados canônicos. A primeira verificação de uma instituição sem registro conta como mudança e faz uma leitura inicial. Se a leitura falha, ela é repetida na verificação seguinte mesmo sem horário novo. Falhas de rede dobram a espera, até 30 minutos.
5. **Integração.** O observador roda dentro do servidor só quando `OBSERVER` vale `on`, `1` ou `true`. Fica desligado por padrão.
6. **Limite conhecido.** O observador só detecta mudanças pelo horário de sincronização. Uma transação nova que chegue sem mudar esse horário só aparece na próxima leitura completa.

---

### Task 1: Núcleo compartilhado e armazenamento de cota e atualizações

**Files:**
- Create: `src/core/names.ts`, `src/core/time.ts`, `migrations/005_quota_and_refresh.sql`
- Replace: `src/reconcile/names.ts`, `src/reconcile/transactions.ts`, `src/core/types.ts`, `src/core/adapter.ts`, `src/store/store.ts`, `src/store/sqlite-store.ts`
- Modify: `tests/store/sqlite-store.test.ts`, `tests/http/router.test.ts`
- Test: `tests/store/quota-and-refresh.test.ts`

**Interfaces:**
- Consumes: os tipos e o `Store` do Plano D2.
- Produces: `normalizeName` e `institutionKey` em `src/core/names.ts` (reexportados por `src/reconcile/names.ts`); `localDay` e `localMonth` em `src/core/time.ts` (`localDay` continua exportado por `src/reconcile/transactions.ts`); `Freshness.quotaExhausted?: boolean`; `SourceAdapter.fetchFreshness?(): Promise<Freshness[]>`; no `Store`, `upsertFreshness(f): { changed, previous }` (conta uma leitura de banco por horário distinto), `quotaUsage(month): Array<{ institutionKey, events }>`, `startRefresh`, `finishRefresh`, `lastRefresh`; tipos `RefreshStatus` e `RefreshLogEntry`. A versão do esquema passa a 5.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/store/quota-and-refresh.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { Freshness } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = '2026-10-26T16:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, NOW);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, NOW);
  return store;
}

const fresh = (sourceId: string, institution: string, lastUpdatedAt: string, extra: Partial<Freshness> = {}): Freshness => ({
  sourceId,
  institution,
  lastUpdatedAt,
  observedAt: NOW,
  ...extra,
});

test('upsertFreshness reports whether the last-synced time changed', () => {
  const store = newStore();
  assert.deepEqual(store.upsertFreshness(fresh('pierre', 'Bank A', '2026-10-26T10:00:00.000Z')), { changed: true, previous: null });
  assert.deepEqual(store.upsertFreshness(fresh('pierre', 'Bank A', '2026-10-26T10:00:00.000Z')), { changed: false, previous: '2026-10-26T10:00:00.000Z' });
  assert.deepEqual(store.upsertFreshness(fresh('pierre', 'Bank A', '2026-10-26T14:00:00.000Z')), { changed: true, previous: '2026-10-26T10:00:00.000Z' });
});

test('each distinct last-synced time counts once as a bank read', () => {
  const store = newStore();
  for (const t of ['2026-10-26T10:00:00.000Z', '2026-10-26T10:00:00.000Z', '2026-10-26T14:00:00.000Z']) {
    store.upsertFreshness(fresh('pierre', 'Bank A', t));
  }
  assert.deepEqual(store.quotaUsage('2026-10'), [{ institutionKey: 'bank a', events: 2 }]);
});

test('reads by both sources count toward the same institution', () => {
  const store = newStore();
  store.upsertFreshness(fresh('pierre', 'Crédito Útil', '2026-10-26T10:00:00.000Z'));
  store.upsertFreshness(fresh('pluggy', 'CREDITO UTIL', '2026-10-26T09:00:00.000Z'));
  store.upsertFreshness(fresh('pluggy', 'Bank B', '2026-10-26T09:00:00.000Z'));
  assert.deepEqual(store.quotaUsage('2026-10'), [
    { institutionKey: 'bank b', events: 1 },
    { institutionKey: 'credito util', events: 2 },
  ]);
});

test('a read is attributed to the Brazilian month it happened in', () => {
  const store = newStore();
  store.upsertFreshness(fresh('pierre', 'Bank A', '2026-11-01T01:30:00.000Z'));
  assert.deepEqual(store.quotaUsage('2026-10'), [{ institutionKey: 'bank a', events: 1 }]);
  assert.deepEqual(store.quotaUsage('2026-11'), []);
});

test('the exhausted flag is stored and listed only when set', () => {
  const store = newStore();
  store.upsertFreshness(fresh('pluggy', 'Bank A', '2026-10-26T10:00:00.000Z', { quotaExhausted: true }));
  store.upsertFreshness(fresh('pluggy', 'Bank B', '2026-10-26T10:00:00.000Z'));
  const rows = store.listFreshness();
  assert.equal(rows.find((r) => r.institution === 'Bank A')?.quotaExhausted, true);
  assert.equal('quotaExhausted' in (rows.find((r) => r.institution === 'Bank B') ?? {}), false);
  store.upsertFreshness(fresh('pluggy', 'Bank A', '2026-10-27T10:00:00.000Z'));
  assert.equal('quotaExhausted' in (store.listFreshness().find((r) => r.institution === 'Bank A') ?? {}), false);
});

test('a refresh is logged from request to finish', () => {
  const store = newStore();
  assert.equal(store.lastRefresh('pierre'), null);
  const id = store.startRefresh('pierre', '2026-10-26T15:00:00.000Z');
  assert.deepEqual(store.lastRefresh('pierre'), { id, sourceId: 'pierre', requestedAt: '2026-10-26T15:00:00.000Z', finishedAt: null, status: 'requested', detail: {} });
  store.finishRefresh(id, '2026-10-26T15:01:00.000Z', 'completed', { updated: 5 });
  const last = store.lastRefresh('pierre');
  assert.equal(last?.status, 'completed');
  assert.equal(last?.finishedAt, '2026-10-26T15:01:00.000Z');
  assert.deepEqual(last?.detail, { updated: 5 });
});

test('lastRefresh returns the newest entry of that source only', () => {
  const store = newStore();
  store.startRefresh('pierre', '2026-10-26T10:00:00.000Z');
  const second = store.startRefresh('pierre', '2026-10-26T12:00:00.000Z');
  store.startRefresh('pluggy', '2026-10-26T13:00:00.000Z');
  assert.equal(store.lastRefresh('pierre')?.id, second);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/quota-and-refresh.test.ts`
Expected: FAIL com `store.quotaUsage is not a function` (o primeiro teste que chama os métodos novos).

- [ ] **Step 3: Criar os ajudantes do núcleo e a migração**

Crie `src/core/names.ts`:

```ts
/** Lowercase, accent-free, single-spaced text, used to compare names written differently by two sources. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function institutionKey(institution: string): string {
  return normalizeName(institution);
}
```

Crie `src/core/time.ts`:

```ts
const BRAZIL_OFFSET_MS = 3 * 3_600_000;

/** Calendar day in Brazil (UTC-3, no daylight saving), which is how purchases are dated on statements. */
export function localDay(instant: string): string {
  return new Date(new Date(instant).getTime() - BRAZIL_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar month (YYYY-MM) in Brazil. Bank request limits renew on the first day of each month. */
export function localMonth(instant: string): string {
  return localDay(instant).slice(0, 7);
}
```

Substitua o conteúdo de `src/reconcile/names.ts`:

```ts
export { institutionKey, normalizeName } from '../core/names.ts';
```

Crie `migrations/005_quota_and_refresh.sql`:

```sql
-- Every distinct "last synced" time a source reports for an institution is one bank read.
-- Both sources read the same banks, so the monthly bank limit is shared between them.

ALTER TABLE freshness ADD COLUMN quota_exhausted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE quota_events (
  source_id TEXT NOT NULL REFERENCES sources(id),
  institution_key TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  month TEXT NOT NULL,
  PRIMARY KEY (source_id, institution_key, last_updated_at)
);

CREATE INDEX idx_quota_events_month ON quota_events (month, institution_key);

CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
```

- [ ] **Step 4: Substituir tipos, contrato do adapter, transações e Store**

Substitua o conteúdo de `src/core/types.ts`:

```ts
import type { Cents } from './money.ts';

export type SourceId = string;
export type AccountKind = 'checking' | 'savings' | 'credit_card';
export type TransactionStatus = 'pending' | 'posted';

export interface Freshness {
  sourceId: SourceId;
  /** Institution as the source names it, for example the bank or card issuer. */
  institution: string;
  /** When the source last synced this institution with the bank (ISO 8601 UTC). */
  lastUpdatedAt: string;
  /** When our observer saw that value (ISO 8601 UTC). */
  observedAt: string;
  /** True when the source reports that the bank refused further reads this month. Omitted otherwise. */
  quotaExhausted?: boolean;
}

export interface SourceAccount {
  externalId: string;
  externalItemId: string | null;
  institution: string;
  kind: AccountKind;
  name: string;
  last4: string | null;
  balance: Cents;
  creditLimit: Cents | null;
  availableLimit: Cents | null;
  minimumPayment: Cents | null;
  dueDate: string | null;
}

export interface SourceTransaction {
  externalId: string;
  accountExternalId: string;
  /** Instant the source reports for the transaction (ISO 8601 UTC). */
  occurredAt: string;
  amount: Cents;
  description: string;
  descriptionRaw: string | null;
  status: TransactionStatus;
  installment: { number: number; total: number } | null;
  category: string | null;
}

export interface SourceBill {
  externalId: string;
  accountExternalId: string;
  dueDate: string;
  closingDate: string | null;
  total: Cents;
  minimumPayment: Cents | null;
}
```

Substitua o conteúdo de `src/core/adapter.ts`:

```ts
import type { Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction } from './types.ts';

export interface AdapterCapabilities {
  refreshOnDemand: boolean;
  pendingTransactions: boolean;
  creditLimits: boolean;
  rawDescription: boolean;
  installments: boolean;
}

export interface RefreshHandle {
  requestedAt: string;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly capabilities: AdapterCapabilities;
  fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }>;
  /** A cheap read of when each institution was last synced, safe to poll often. Does not touch the banks. */
  fetchFreshness?(): Promise<Freshness[]>;
  fetchTransactions(since: Date): Promise<SourceTransaction[]>;
  fetchBills(): Promise<SourceBill[]>;
  /** Present only when capabilities.refreshOnDemand is true. */
  requestRefresh?(): Promise<RefreshHandle>;
  /** Returns and clears notes about records the adapter skipped, for the sync report. */
  drainWarnings?(): string[];
}
```

Substitua o conteúdo de `src/reconcile/transactions.ts` (a única mudança é importar `localDay` de `src/core/time.ts` e reexportá-lo):

```ts
import { createHash } from 'node:crypto';
import type {
  CanonicalAccount,
  CanonicalTransaction,
  Finding,
  FindingKind,
  FindingSeverity,
  TransactionLink,
  TransactionState,
} from '../core/canonical.ts';
import { formatBRL } from '../core/money.ts';
import type { Freshness, SourceId, SourceTransaction, TransactionStatus } from '../core/types.ts';
import { localDay } from '../core/time.ts';
import { institutionKey, normalizeName } from './names.ts';

export { localDay };

export interface TransactionSource {
  sourceId: SourceId;
  /** A lower number wins when two sources describe the same transaction. */
  priority: number;
  transactions: SourceTransaction[];
  freshness: Freshness[];
}

export interface TransactionInput {
  accounts: CanonicalAccount[];
  sources: TransactionSource[];
  now: Date;
  /**
   * Pending entries seen by only one source and older than this many days are set aside. A card purchase stays
   * pending until its statement closes, so cards get a longer limit. Defaults to 7 for bank accounts, 30 for cards.
   */
  staleDays?: { bank?: number; card?: number };
}

export interface TransactionStats {
  groups: number;
  byState: Record<TransactionState, number>;
  /** How many records were joined to an earlier source's record by each pass (index = pass number). */
  byPass: number[];
}

export interface TransactionReconciliation {
  transactions: CanonicalTransaction[];
  links: TransactionLink[];
  findings: Finding[];
  stats: TransactionStats;
}

interface Record_ {
  sourceId: SourceId;
  priority: number;
  tx: SourceTransaction;
  pass: number;
}

interface Group {
  records: Record_[];
}

const FUZZY_WINDOW_MS = 36 * 3_600_000;
const DAY_MS = 86_400_000;
const INSTALLMENT_SUFFIX = /\d{1,2}\s*\/\s*\d{1,2}\s*$/;

const descOf = (tx: SourceTransaction) => normalizeName(tx.descriptionRaw ?? tx.description);
const time = (tx: SourceTransaction) => new Date(tx.occurredAt).getTime();
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function primaryOf(group: Group): Record_ {
  return [...group.records].sort((a, b) => a.priority - b.priority)[0] as Record_;
}

type Predicate = (candidate: SourceTransaction, incoming: SourceTransaction) => boolean;

const PASSES: Array<{ pass: number; matches: Predicate; nearest?: boolean }> = [
  { pass: 1, matches: (g, t) => g.occurredAt === t.occurredAt && g.amount === t.amount && descOf(g) === descOf(t) },
  { pass: 2, matches: (g, t) => localDay(g.occurredAt) === localDay(t.occurredAt) && g.amount === t.amount && descOf(g) === descOf(t) },
  {
    // Installment purchases are dated by purchase in one source and by charge in the other.
    pass: 3,
    matches: (g, t) => {
      if (g.amount !== t.amount || descOf(g) !== descOf(t)) return false;
      const looksInstallment = (x: SourceTransaction) => x.installment !== null || INSTALLMENT_SUFFIX.test(x.descriptionRaw ?? x.description);
      if (!looksInstallment(g) && !looksInstallment(t)) return false;
      return g.installment === null || t.installment === null || g.installment.number === t.installment.number;
    },
  },
  {
    pass: 4,
    matches: (g, t) => g.amount === t.amount && Math.abs(time(g) - time(t)) <= FUZZY_WINDOW_MS,
    nearest: true,
  },
];

function joinSource(groups: Group[], source: TransactionSource, txs: SourceTransaction[]): void {
  let pending = [...txs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.externalId.localeCompare(b.externalId));
  const open = (g: Group) => !g.records.some((r) => r.sourceId === source.sourceId);

  for (const { pass, matches, nearest } of PASSES) {
    const rest: SourceTransaction[] = [];
    for (const tx of pending) {
      let best: Group | null = null;
      let bestGap = Infinity;
      for (const g of groups) {
        if (!open(g) || !matches(primaryOf(g).tx, tx)) continue;
        const gap = Math.abs(time(primaryOf(g).tx) - time(tx));
        if (!nearest) {
          best = g;
          break;
        }
        if (gap < bestGap) {
          best = g;
          bestGap = gap;
        }
      }
      if (best) best.records.push({ sourceId: source.sourceId, priority: source.priority, tx, pass });
      else rest.push(tx);
    }
    pending = rest;
  }
  for (const tx of pending) groups.push({ records: [{ sourceId: source.sourceId, priority: source.priority, tx, pass: 0 }] });
}

function freshnessOf(source: TransactionSource | undefined, institution: string): string | null {
  const wanted = institutionKey(institution);
  return source?.freshness.find((f) => institutionKey(f.institution) === wanted)?.lastUpdatedAt ?? null;
}

export function reconcileTransactions(input: TransactionInput): TransactionReconciliation {
  const staleDaysFor = (kind: CanonicalAccount['kind']) =>
    kind === 'credit_card' ? (input.staleDays?.card ?? 30) : (input.staleDays?.bank ?? 7);
  const sources = [...input.sources].sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const coverageStart = new Map<SourceId, string | null>(
    sources.map((s) => [s.sourceId, s.transactions.reduce<string | null>((min, t) => (min === null || t.occurredAt < min ? t.occurredAt : min), null)]),
  );

  const transactions: CanonicalTransaction[] = [];
  const links: TransactionLink[] = [];
  const findings: Finding[] = [];
  const stats: TransactionStats = {
    groups: 0,
    byState: { confirmed: 0, single_source: 0, conflict: 0, stale_pending: 0 },
    byPass: [0, 0, 0, 0, 0],
  };

  const addFinding = (kind: FindingKind, severity: FindingSeverity, account: CanonicalAccount, transactionId: string, summary: string, details: Record<string, unknown>) => {
    findings.push({ id: `fd_${hash(`${kind}|${transactionId}`)}`, kind, severity, accountId: account.id, transactionId, summary, details });
  };

  for (const account of [...input.accounts].sort((a, b) => a.id.localeCompare(b.id))) {
    const memberRefs = account.refs.filter((r) => r.role === 'member');
    const present = sources.filter((s) => memberRefs.some((r) => r.sourceId === s.sourceId));
    if (present.length === 0) continue;

    const groups: Group[] = [];
    for (const source of present) {
      const externalIds = new Set(memberRefs.filter((r) => r.sourceId === source.sourceId).map((r) => r.externalId));
      const txs = source.transactions.filter((t) => externalIds.has(t.accountExternalId));
      if (groups.length === 0) {
        for (const tx of txs) groups.push({ records: [{ sourceId: source.sourceId, priority: source.priority, tx, pass: 0 }] });
      } else {
        joinSource(groups, source, txs);
      }
    }

    const keyed = groups.map((group) => {
      const primary = primaryOf(group).tx;
      return { group, primary, key: `${account.id}|${localDay(primary.occurredAt)}|${primary.amount}|${descOf(primary)}` };
    });
    keyed.sort((a, b) => a.key.localeCompare(b.key) || a.primary.occurredAt.localeCompare(b.primary.occurredAt) || a.primary.externalId.localeCompare(b.primary.externalId));
    const seen = new Map<string, number>();

    for (const { group, primary, key } of keyed) {
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      const id = `tx_${hash(`${key}|${ordinal}`)}`;
      const records = [...group.records].sort((a, b) => a.priority - b.priority);
      const statuses = new Set(records.map((r) => r.tx.status));
      const status: TransactionStatus = statuses.has('posted') ? 'posted' : 'pending';
      const sourceIds = records.map((r) => r.sourceId);
      const firstNonNull = <T>(read: (t: SourceTransaction) => T | null): T | null => {
        for (const r of records) {
          const v = read(r.tx);
          if (v !== null) return v;
        }
        return null;
      };

      let state: TransactionState;
      if (records.length > 1) state = statuses.size > 1 ? 'conflict' : 'confirmed';
      else if (status === 'pending' && input.now.getTime() - time(primary) > staleDaysFor(account.kind) * DAY_MS) state = 'stale_pending';
      else state = 'single_source';

      transactions.push({
        id,
        accountId: account.id,
        occurredAt: primary.occurredAt,
        amount: primary.amount,
        description: primary.description,
        descriptionRaw: firstNonNull((t) => t.descriptionRaw),
        status,
        installment: firstNonNull((t) => t.installment),
        category: firstNonNull((t) => t.category),
        state,
        sourceIds,
        excluded: state === 'stale_pending',
      });
      stats.groups++;
      stats.byState[state]++;
      for (const r of records) {
        links.push({ sourceId: r.sourceId, externalId: r.tx.externalId, transactionId: id, matchPass: r.pass });
        stats.byPass[r.pass] = (stats.byPass[r.pass] ?? 0) + 1;
      }

      const label = `${account.institution} / ${account.name}: ${formatBRL(primary.amount)} on ${localDay(primary.occurredAt)} "${primary.descriptionRaw ?? primary.description}"`;
      const base = { occurredAt: primary.occurredAt, amount: primary.amount, sources: sourceIds };

      if (state === 'stale_pending') {
        addFinding('stale_pending', 'warning', account, id, `${label} is still pending after ${staleDaysFor(account.kind)} days and only ${sourceIds[0]} reports it`, base);
      } else if (state === 'conflict') {
        const lagging = records.find((r) => r.tx.status === 'pending') as Record_;
        const postedSource = records.find((r) => r.tx.status === 'posted') as Record_;
        const laggingAt = freshnessOf(byId.get(lagging.sourceId), account.institution);
        const postedAt = freshnessOf(byId.get(postedSource.sourceId), account.institution);
        const explained = laggingAt !== null && postedAt !== null && laggingAt < postedAt;
        addFinding('status_conflict', explained ? 'info' : 'warning', account, id,
          `${label} is pending in ${lagging.sourceId} and posted in ${postedSource.sourceId}${explained ? ` (${lagging.sourceId} synced earlier)` : ''}`,
          { ...base, pendingIn: lagging.sourceId, postedIn: postedSource.sourceId });
      } else if (state === 'single_source') {
        for (const other of present) {
          if (sourceIds.includes(other.sourceId)) continue;
          const start = coverageStart.get(other.sourceId) ?? null;
          if (start !== null && primary.occurredAt < start) continue;
          const syncedAt = freshnessOf(other, account.institution);
          if (syncedAt !== null && syncedAt < primary.occurredAt) {
            addFinding('not_yet_synced', 'info', account, id, `${label} is not in ${other.sourceId} yet (last sync ${syncedAt})`, { ...base, missingIn: other.sourceId, lastSyncAt: syncedAt });
          } else {
            addFinding('missing_in_source', 'warning', account, id, `${label} is in ${sourceIds[0]} but missing in ${other.sourceId}`, { ...base, missingIn: other.sourceId, lastSyncAt: syncedAt });
          }
        }
      }
    }
  }

  transactions.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { transactions, links, findings, stats };
}
```

Substitua o conteúdo de `src/store/store.ts`:

```ts
import type { CanonicalAccount, CanonicalTransaction, Finding, LimitGroup, TransactionLink } from '../core/canonical.ts';
import type { Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction } from '../core/types.ts';

export interface NewSnapshot {
  sourceId: SourceId;
  endpoint: string;
  fetchedAt: string;
  httpStatus: number;
  body: unknown;
}

export interface Snapshot extends NewSnapshot {
  id: number;
  sha256: string;
}

export interface SourceRegistration {
  id: SourceId;
  kind: string;
  capabilities: Record<string, boolean>;
}

export interface Seen {
  sourceId: SourceId;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type StoredSourceAccount = SourceAccount & Seen;
export type StoredSourceTransaction = SourceTransaction & Seen;
export type StoredSourceBill = SourceBill & Seen;

export interface StoredFinding extends Finding {
  openedAt: string;
  lastSeenAt: string;
  /** Set when the problem stopped showing up in a later reconciliation. */
  resolvedAt: string | null;
}

export type RefreshStatus = 'requested' | 'completed' | 'timeout' | 'failed';

export interface RefreshLogEntry {
  id: number;
  sourceId: SourceId;
  requestedAt: string;
  finishedAt: string | null;
  status: RefreshStatus;
  detail: Record<string, unknown>;
}

export interface Store {
  schemaVersion(): number;
  registerSource(source: SourceRegistration, now: string): void;
  saveSnapshot(snapshot: NewSnapshot): number;
  latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null;
  /**
   * Saves what a source reports for an institution. `changed` is true when the last-synced time differs from
   * the one saved before (or none was saved). Each distinct time is also counted as one bank read for the month.
   */
  upsertFreshness(freshness: Freshness): { changed: boolean; previous: string | null };
  /** Bank reads seen in a month (YYYY-MM), per institution key, summed over all sources. */
  quotaUsage(month: string): Array<{ institutionKey: string; events: number }>;
  startRefresh(sourceId: SourceId, requestedAt: string): number;
  finishRefresh(id: number, finishedAt: string, status: RefreshStatus, detail: Record<string, unknown>): void;
  lastRefresh(sourceId: SourceId): RefreshLogEntry | null;
  listFreshness(): Freshness[];
  /** Inserts new records and refreshes existing ones; first_seen_at is kept, last_seen_at becomes seenAt. */
  upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void;
  upsertSourceTransactions(sourceId: SourceId, transactions: SourceTransaction[], seenAt: string): void;
  upsertSourceBills(sourceId: SourceId, bills: SourceBill[], seenAt: string): void;
  listSourceAccounts(sourceId: SourceId): StoredSourceAccount[];
  listSourceTransactions(sourceId: SourceId): StoredSourceTransaction[];
  listSourceBills(sourceId: SourceId): StoredSourceBill[];
  /** Replaces all canonical accounts, limit groups and source references in one transaction. */
  replaceCanonicalAccounts(accounts: CanonicalAccount[], groups: LimitGroup[], builtAt: string): void;
  listCanonicalAccounts(): CanonicalAccount[];
  listLimitGroups(): LimitGroup[];
  /** Replaces all canonical transactions and their source links in one transaction. */
  replaceCanonicalTransactions(transactions: CanonicalTransaction[], links: TransactionLink[], builtAt: string): void;
  listCanonicalTransactions(options?: { accountId?: string; includeExcluded?: boolean }): CanonicalTransaction[];
  /** Upserts the current findings, keeps their opening time, and marks the ones no longer present as resolved. */
  syncFindings(findings: Finding[], now: string): void;
  listFindings(options?: { includeResolved?: boolean }): StoredFinding[];
  close(): void;
}
```

Substitua o conteúdo de `src/store/sqlite-store.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountRef, CanonicalAccount, CanonicalTransaction, Finding, LimitGroup, TransactionLink, TransactionState } from '../core/canonical.ts';
import type { AccountKind, Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction, TransactionStatus } from '../core/types.ts';
import { institutionKey } from '../core/names.ts';
import { localMonth } from '../core/time.ts';
import { currentVersion, migrate } from './migrations.ts';
import type {
  NewSnapshot,
  Snapshot,
  SourceRegistration,
  Store,
  StoredSourceAccount,
  StoredSourceBill,
  RefreshLogEntry,
  RefreshStatus,
  StoredFinding,
  StoredSourceTransaction,
} from './store.ts';

interface SnapshotRow {
  id: number;
  source_id: string;
  endpoint: string;
  fetched_at: string;
  http_status: number;
  sha256: string;
  body: string;
}

interface FreshnessRow {
  source_id: string;
  institution: string;
  last_updated_at: string;
  observed_at: string;
  quota_exhausted: number;
}

interface RefreshRow {
  id: number;
  source_id: string;
  requested_at: string;
  finished_at: string | null;
  status: string;
  detail: string;
}

interface SourceAccountRow {
  source_id: string;
  external_id: string;
  external_item_id: string | null;
  institution: string;
  kind: string;
  name: string;
  last4: string | null;
  balance: number;
  credit_limit: number | null;
  available_limit: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface SourceTransactionRow {
  source_id: string;
  external_id: string;
  account_external_id: string;
  occurred_at: string;
  amount: number;
  description: string;
  description_raw: string | null;
  status: string;
  installment_number: number | null;
  installment_total: number | null;
  category: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface SourceBillRow {
  source_id: string;
  external_id: string;
  account_external_id: string;
  due_date: string;
  closing_date: string | null;
  total: number;
  minimum_payment: number | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface CanonicalAccountRow {
  id: string;
  institution: string;
  kind: string;
  name: string;
  last4: string | null;
  balance: number;
  balance_source_id: string | null;
  balance_as_of: string | null;
  credit_limit: number | null;
  available_limit: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  limit_group_id: string | null;
}

interface RefRow {
  source_id: string;
  external_id: string;
  account_id: string;
  role: string;
}

interface LimitGroupRow {
  id: string;
  institution: string;
  credit_limit: number;
}

interface TransactionRow {
  id: string;
  account_id: string;
  occurred_at: string;
  amount: number;
  description: string;
  description_raw: string | null;
  status: string;
  installment_number: number | null;
  installment_total: number | null;
  category: string | null;
  state: string;
  excluded: number;
}

interface FindingRow {
  id: string;
  kind: string;
  severity: string;
  account_id: string | null;
  transaction_id: string | null;
  summary: string;
  details: string;
  opened_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export function openSqliteStore(path: string, migrationsDir: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db, migrationsDir);

  function inTransaction(work: () => void): void {
    db.exec('BEGIN');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    schemaVersion: () => currentVersion(db),

    registerSource(source: SourceRegistration, now: string): void {
      db.prepare(
        `INSERT INTO sources (id, kind, active, capabilities, added_at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, capabilities = excluded.capabilities`,
      ).run(source.id, source.kind, JSON.stringify(source.capabilities), now);
    },

    saveSnapshot(snapshot: NewSnapshot): number {
      const body = JSON.stringify(snapshot.body);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const result = db
        .prepare(
          `INSERT INTO raw_snapshots (source_id, endpoint, fetched_at, http_status, sha256, body)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(snapshot.sourceId, snapshot.endpoint, snapshot.fetchedAt, snapshot.httpStatus, sha256, body);
      return Number(result.lastInsertRowid);
    },

    latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null {
      const row = db
        .prepare(
          `SELECT * FROM raw_snapshots WHERE source_id = ? AND endpoint = ?
           ORDER BY fetched_at DESC, id DESC LIMIT 1`,
        )
        .get(sourceId, endpoint) as SnapshotRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.source_id,
        endpoint: row.endpoint,
        fetchedAt: row.fetched_at,
        httpStatus: row.http_status,
        sha256: row.sha256,
        body: JSON.parse(row.body),
      };
    },

    upsertFreshness(f: Freshness): { changed: boolean; previous: string | null } {
      const row = db.prepare('SELECT last_updated_at FROM freshness WHERE source_id = ? AND institution = ?').get(f.sourceId, f.institution) as { last_updated_at: string } | undefined;
      const previous = row?.last_updated_at ?? null;
      inTransaction(() => {
        db.prepare(
          `INSERT INTO freshness (source_id, institution, last_updated_at, observed_at, quota_exhausted) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source_id, institution) DO UPDATE SET
             last_updated_at = excluded.last_updated_at, observed_at = excluded.observed_at, quota_exhausted = excluded.quota_exhausted`,
        ).run(f.sourceId, f.institution, f.lastUpdatedAt, f.observedAt, f.quotaExhausted ? 1 : 0);
        db.prepare(
          `INSERT OR IGNORE INTO quota_events (source_id, institution_key, last_updated_at, observed_at, month) VALUES (?, ?, ?, ?, ?)`,
        ).run(f.sourceId, institutionKey(f.institution), f.lastUpdatedAt, f.observedAt, localMonth(f.lastUpdatedAt));
      });
      return { changed: previous !== f.lastUpdatedAt, previous };
    },

    quotaUsage(month: string): Array<{ institutionKey: string; events: number }> {
      const rows = db.prepare('SELECT institution_key, COUNT(*) AS events FROM quota_events WHERE month = ? GROUP BY institution_key ORDER BY institution_key').all(month) as unknown as Array<{ institution_key: string; events: number }>;
      return rows.map((r) => ({ institutionKey: r.institution_key, events: r.events }));
    },

    startRefresh(sourceId: SourceId, requestedAt: string): number {
      const result = db.prepare("INSERT INTO refresh_log (source_id, requested_at, status) VALUES (?, ?, 'requested')").run(sourceId, requestedAt);
      return Number(result.lastInsertRowid);
    },

    finishRefresh(id: number, finishedAt: string, status: RefreshStatus, detail: Record<string, unknown>): void {
      db.prepare('UPDATE refresh_log SET finished_at = ?, status = ?, detail = ? WHERE id = ?').run(finishedAt, status, JSON.stringify(detail), id);
    },

    lastRefresh(sourceId: SourceId): RefreshLogEntry | null {
      const r = db.prepare('SELECT * FROM refresh_log WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as RefreshRow | undefined;
      if (!r) return null;
      return {
        id: r.id,
        sourceId: r.source_id,
        requestedAt: r.requested_at,
        finishedAt: r.finished_at,
        status: r.status as RefreshStatus,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
      };
    },

    listFreshness(): Freshness[] {
      const rows = db.prepare('SELECT * FROM freshness ORDER BY source_id, institution').all() as unknown as FreshnessRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        institution: r.institution,
        lastUpdatedAt: r.last_updated_at,
        observedAt: r.observed_at,
        ...(r.quota_exhausted === 1 ? { quotaExhausted: true } : {}),
      }));
    },

    upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void {
      const statement = db.prepare(
        `INSERT INTO source_accounts (source_id, external_id, external_item_id, institution, kind, name, last4, balance,
           credit_limit, available_limit, minimum_payment, due_date, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           external_item_id = excluded.external_item_id, institution = excluded.institution, kind = excluded.kind,
           name = excluded.name, last4 = excluded.last4, balance = excluded.balance, credit_limit = excluded.credit_limit,
           available_limit = excluded.available_limit, minimum_payment = excluded.minimum_payment,
           due_date = excluded.due_date, last_seen_at = excluded.last_seen_at`,
      );
      inTransaction(() => {
        for (const a of accounts) {
          statement.run(sourceId, a.externalId, a.externalItemId, a.institution, a.kind, a.name, a.last4, a.balance,
            a.creditLimit, a.availableLimit, a.minimumPayment, a.dueDate, seenAt, seenAt);
        }
      });
    },

    upsertSourceTransactions(sourceId: SourceId, transactions: SourceTransaction[], seenAt: string): void {
      const statement = db.prepare(
        `INSERT INTO source_transactions (source_id, external_id, account_external_id, occurred_at, amount, description,
           description_raw, status, installment_number, installment_total, category, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           account_external_id = excluded.account_external_id, occurred_at = excluded.occurred_at,
           amount = excluded.amount, description = excluded.description, description_raw = excluded.description_raw,
           status = excluded.status, installment_number = excluded.installment_number,
           installment_total = excluded.installment_total, category = excluded.category,
           last_seen_at = excluded.last_seen_at`,
      );
      inTransaction(() => {
        for (const t of transactions) {
          statement.run(sourceId, t.externalId, t.accountExternalId, t.occurredAt, t.amount, t.description,
            t.descriptionRaw, t.status, t.installment?.number ?? null, t.installment?.total ?? null, t.category,
            seenAt, seenAt);
        }
      });
    },

    upsertSourceBills(sourceId: SourceId, bills: SourceBill[], seenAt: string): void {
      const statement = db.prepare(
        `INSERT INTO source_bills (source_id, external_id, account_external_id, due_date, closing_date, total,
           minimum_payment, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           account_external_id = excluded.account_external_id, due_date = excluded.due_date,
           closing_date = excluded.closing_date, total = excluded.total, minimum_payment = excluded.minimum_payment,
           last_seen_at = excluded.last_seen_at`,
      );
      inTransaction(() => {
        for (const b of bills) {
          statement.run(sourceId, b.externalId, b.accountExternalId, b.dueDate, b.closingDate, b.total,
            b.minimumPayment, seenAt, seenAt);
        }
      });
    },

    listSourceAccounts(sourceId: SourceId): StoredSourceAccount[] {
      const rows = db.prepare('SELECT * FROM source_accounts WHERE source_id = ? ORDER BY external_id').all(sourceId) as unknown as SourceAccountRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        externalId: r.external_id,
        externalItemId: r.external_item_id,
        institution: r.institution,
        kind: r.kind as AccountKind,
        name: r.name,
        last4: r.last4,
        balance: r.balance,
        creditLimit: r.credit_limit,
        availableLimit: r.available_limit,
        minimumPayment: r.minimum_payment,
        dueDate: r.due_date,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    listSourceTransactions(sourceId: SourceId): StoredSourceTransaction[] {
      const rows = db.prepare('SELECT * FROM source_transactions WHERE source_id = ? ORDER BY occurred_at, external_id').all(sourceId) as unknown as SourceTransactionRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        externalId: r.external_id,
        accountExternalId: r.account_external_id,
        occurredAt: r.occurred_at,
        amount: r.amount,
        description: r.description,
        descriptionRaw: r.description_raw,
        status: r.status as TransactionStatus,
        installment: r.installment_number !== null && r.installment_total !== null
          ? { number: r.installment_number, total: r.installment_total }
          : null,
        category: r.category,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    listSourceBills(sourceId: SourceId): StoredSourceBill[] {
      const rows = db.prepare('SELECT * FROM source_bills WHERE source_id = ? ORDER BY due_date, external_id').all(sourceId) as unknown as SourceBillRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        externalId: r.external_id,
        accountExternalId: r.account_external_id,
        dueDate: r.due_date,
        closingDate: r.closing_date,
        total: r.total,
        minimumPayment: r.minimum_payment,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    replaceCanonicalAccounts(accounts: CanonicalAccount[], groups: LimitGroup[], builtAt: string): void {
      inTransaction(() => {
        db.exec('DELETE FROM account_source_refs');
        db.exec('DELETE FROM accounts');
        db.exec('DELETE FROM limit_groups');
        const insertGroup = db.prepare('INSERT INTO limit_groups (id, institution, credit_limit) VALUES (?, ?, ?)');
        for (const g of groups) insertGroup.run(g.id, g.institution, g.creditLimit);
        const insertAccount = db.prepare(
          `INSERT INTO accounts (id, institution, kind, name, last4, balance, balance_source_id, balance_as_of,
             credit_limit, available_limit, minimum_payment, due_date, limit_group_id, built_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertRef = db.prepare('INSERT INTO account_source_refs (source_id, external_id, account_id, role) VALUES (?, ?, ?, ?)');
        for (const a of accounts) {
          insertAccount.run(a.id, a.institution, a.kind, a.name, a.last4, a.balance, a.balanceSourceId, a.balanceAsOf,
            a.creditLimit, a.availableLimit, a.minimumPayment, a.dueDate, a.limitGroupId, builtAt);
          for (const r of a.refs) insertRef.run(r.sourceId, r.externalId, a.id, r.role);
        }
      });
    },

    listCanonicalAccounts(): CanonicalAccount[] {
      const rows = db.prepare('SELECT * FROM accounts ORDER BY institution, kind, name').all() as unknown as CanonicalAccountRow[];
      const refRows = db.prepare("SELECT * FROM account_source_refs ORDER BY account_id, CASE role WHEN 'member' THEN 0 ELSE 1 END, source_id, external_id").all() as unknown as RefRow[];
      const refsByAccount = new Map<string, AccountRef[]>();
      for (const r of refRows) {
        const list = refsByAccount.get(r.account_id) ?? [];
        list.push({ sourceId: r.source_id, externalId: r.external_id, role: r.role as AccountRef['role'] });
        refsByAccount.set(r.account_id, list);
      }
      return rows.map((r) => ({
        id: r.id,
        institution: r.institution,
        kind: r.kind as AccountKind,
        name: r.name,
        last4: r.last4,
        balance: r.balance,
        balanceSourceId: r.balance_source_id,
        balanceAsOf: r.balance_as_of,
        creditLimit: r.credit_limit,
        availableLimit: r.available_limit,
        minimumPayment: r.minimum_payment,
        dueDate: r.due_date,
        limitGroupId: r.limit_group_id,
        refs: refsByAccount.get(r.id) ?? [],
      }));
    },

    listLimitGroups(): LimitGroup[] {
      const rows = db.prepare('SELECT * FROM limit_groups ORDER BY id').all() as unknown as LimitGroupRow[];
      const members = db.prepare('SELECT id, limit_group_id FROM accounts WHERE limit_group_id IS NOT NULL ORDER BY id').all() as unknown as Array<{ id: string; limit_group_id: string }>;
      return rows.map((g) => ({
        id: g.id,
        institution: g.institution,
        creditLimit: g.credit_limit,
        memberIds: members.filter((m) => m.limit_group_id === g.id).map((m) => m.id),
      }));
    },

    replaceCanonicalTransactions(transactions: CanonicalTransaction[], links: TransactionLink[], builtAt: string): void {
      inTransaction(() => {
        db.exec('DELETE FROM transaction_links');
        db.exec('DELETE FROM transactions');
        const insertTx = db.prepare(
          `INSERT INTO transactions (id, account_id, occurred_at, amount, description, description_raw, status,
             installment_number, installment_total, category, state, excluded, built_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of transactions) {
          insertTx.run(t.id, t.accountId, t.occurredAt, t.amount, t.description, t.descriptionRaw, t.status,
            t.installment?.number ?? null, t.installment?.total ?? null, t.category, t.state, t.excluded ? 1 : 0, builtAt);
        }
        const insertLink = db.prepare('INSERT INTO transaction_links (source_id, external_id, transaction_id, match_pass) VALUES (?, ?, ?, ?)');
        for (const l of links) insertLink.run(l.sourceId, l.externalId, l.transactionId, l.matchPass);
      });
    },

    listCanonicalTransactions(options: { accountId?: string; includeExcluded?: boolean } = {}): CanonicalTransaction[] {
      const where: string[] = [];
      const params: string[] = [];
      if (options.accountId !== undefined) {
        where.push('account_id = ?');
        params.push(options.accountId);
      }
      if (!options.includeExcluded) where.push('excluded = 0');
      const sql = `SELECT * FROM transactions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC, id`;
      const rows = db.prepare(sql).all(...params) as unknown as TransactionRow[];
      const linkRows = db.prepare('SELECT source_id, transaction_id FROM transaction_links ORDER BY match_pass, source_id').all() as unknown as Array<{ source_id: string; transaction_id: string }>;
      const sourcesByTx = new Map<string, string[]>();
      for (const l of linkRows) sourcesByTx.set(l.transaction_id, [...(sourcesByTx.get(l.transaction_id) ?? []), l.source_id]);
      return rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        occurredAt: r.occurred_at,
        amount: r.amount,
        description: r.description,
        descriptionRaw: r.description_raw,
        status: r.status as TransactionStatus,
        installment: r.installment_number !== null && r.installment_total !== null ? { number: r.installment_number, total: r.installment_total } : null,
        category: r.category,
        state: r.state as TransactionState,
        sourceIds: sourcesByTx.get(r.id) ?? [],
        excluded: r.excluded === 1,
      }));
    },

    syncFindings(findings: Finding[], now: string): void {
      inTransaction(() => {
        const upsert = db.prepare(
          `INSERT INTO reconciliation_findings (id, kind, severity, account_id, transaction_id, summary, details, opened_at, last_seen_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (id) DO UPDATE SET
             severity = excluded.severity, summary = excluded.summary, details = excluded.details,
             last_seen_at = excluded.last_seen_at,
             opened_at = CASE WHEN reconciliation_findings.resolved_at IS NULL THEN reconciliation_findings.opened_at ELSE excluded.opened_at END,
             resolved_at = NULL`,
        );
        for (const f of findings) upsert.run(f.id, f.kind, f.severity, f.accountId, f.transactionId, f.summary, JSON.stringify(f.details), now, now);
        db.prepare('UPDATE reconciliation_findings SET resolved_at = ? WHERE resolved_at IS NULL AND last_seen_at <> ?').run(now, now);
      });
    },

    listFindings(options: { includeResolved?: boolean } = {}): StoredFinding[] {
      const sql = `SELECT * FROM reconciliation_findings${options.includeResolved ? '' : ' WHERE resolved_at IS NULL'} ORDER BY severity DESC, kind, id`;
      const rows = db.prepare(sql).all() as unknown as FindingRow[];
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as Finding['kind'],
        severity: r.severity as Finding['severity'],
        accountId: r.account_id ?? '',
        transactionId: r.transaction_id ?? '',
        summary: r.summary,
        details: JSON.parse(r.details) as Record<string, unknown>,
        openedAt: r.opened_at,
        lastSeenAt: r.last_seen_at,
        resolvedAt: r.resolved_at,
      }));
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Atualizar a versão do esquema nos testes existentes**

Em `tests/store/sqlite-store.test.ts`, no teste `applies the real migrations on open`, troque `assert.equal(store.schemaVersion(), 4);` por `assert.equal(store.schemaVersion(), 5);`.

Em `tests/http/router.test.ts`, no teste `GET /healthz reports ok with version and schema version`, troque `schemaVersion: 4,` por `schemaVersion: 5,`.

- [ ] **Step 6: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 175 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os arquivos novos e modificados desta tarefa.

---

### Task 2: Leitura leve de horários de sincronização nos adapters

**Files:**
- Replace: `src/adapters/pierre/adapter.ts`, `src/adapters/pluggy/adapter.ts`, `tests/adapters/pierre/adapter.test.ts`, `tests/adapters/pluggy/adapter.test.ts`

**Interfaces:**
- Consumes: `Freshness` com `quotaExhausted`.
- Produces: `PierreAdapter.fetchFreshness()` (uma única chamada a `get-accounts`, sem snapshot, contas manuais ficam de fora) e `PluggyAdapter.fetchFreshness()` (uma chamada por item, sem snapshot; marca `quotaExhausted: true` quando o item termina em `PARTIAL_SUCCESS` com aviso de código `423`).

- [ ] **Step 1: Substituir os testes dos adapters**

Substitua o conteúdo de `tests/adapters/pierre/adapter.test.ts` (acrescenta um teste):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PierreAdapter } from '../../../src/adapters/pierre/adapter.ts';
import { SourceFormatError, SourceHttpError } from '../../../src/core/http.ts';
import { FakeHttp, ok, type FakeRoute } from '../../support/fake-http.ts';
import {
  pierreBankAccount,
  pierreBankCredit,
  pierreBill,
  pierreCardAccount,
  pierreCardPurchase,
  pierreWalletAccount,
} from '../../fixtures/pierre.ts';

const NOW = () => new Date('2026-10-26T15:00:00.000Z');

function routes(overrides: FakeRoute[] = []): FakeRoute[] {
  return [
    ...overrides,
    { method: 'GET', match: '/get-accounts', respond: () => ok({ success: true, data: [pierreBankAccount, pierreCardAccount, pierreWalletAccount] }) },
    { method: 'GET', match: /\/get-transactions\?/, respond: () => ok({ success: true, data: [pierreBankCredit, pierreCardPurchase] }) },
    { method: 'GET', match: '/get-bills', respond: () => ok({ success: true, data: [pierreBill] }) },
    { method: 'POST', match: '/manual-update', respond: () => ok({ success: true, message: 'Manual sync initiated' }) },
  ];
}

function build(overrides: FakeRoute[] = []) {
  const http = new FakeHttp(routes(overrides));
  const snapshots: Array<{ endpoint: string; httpStatus: number; body: unknown }> = [];
  const adapter = new PierreAdapter({ apiKey: 'sk-test-key' }, { http, sink: (s) => snapshots.push(s), now: NOW });
  return { http, snapshots, adapter };
}

test('fetchAccounts returns accounts with card limits learned from transactions', async () => {
  const { adapter } = build();
  const { accounts } = await adapter.fetchAccounts();
  const card = accounts.find((a) => a.externalId === 'p-acc-card');
  assert.equal(card?.creditLimit, 500000);
  assert.equal(card?.availableLimit, 467950);
  assert.equal(accounts.length, 3);
});

test('freshness has one entry per connector and skips manual accounts', async () => {
  const { adapter } = build();
  const { freshness } = await adapter.fetchAccounts();
  assert.deepEqual(freshness, [
    { sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T13:34:07.676Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
});

test('sends the bearer key and reads the credit window of 90 days', async () => {
  const { http, adapter } = build();
  await adapter.fetchAccounts();
  assert.ok(http.calls.every((c) => c.options?.headers?.Authorization === 'Bearer sk-test-key'));
  assert.equal(http.callsTo('GET', 'startDate=2026-07-28&endDate=2026-10-26').length, 1);
});

test('fetchTransactions asks for raw posted and pending transactions since the date', async () => {
  const { http, adapter } = build();
  const txs = await adapter.fetchTransactions(new Date('2026-09-01T00:00:00.000Z'));
  assert.deepEqual(txs.map((t) => t.externalId), ['p-tx-1', 'p-tx-2']);
  const call = http.callsTo('GET', 'get-transactions')[0];
  assert.match(call?.url ?? '', /startDate=2026-09-01&endDate=2026-10-26&format=raw&includeStatus=POSTED,PENDING$/);
});

test('fetchBills normalizes the bills', async () => {
  const { adapter } = build();
  const bills = await adapter.fetchBills();
  assert.equal(bills[0]?.total, 32050);
});

test('stores every raw response in the sink, without the api key', async () => {
  const { snapshots, adapter } = build();
  await adapter.fetchAccounts();
  await adapter.fetchBills();
  assert.deepEqual(snapshots.map((s) => s.endpoint.split('?')[0]), ['get-accounts', 'get-transactions', 'get-bills']);
  assert.equal(JSON.stringify(snapshots).includes('sk-test-key'), false);
});

test('requestRefresh posts once and reports when it was requested', async () => {
  const { http, adapter } = build();
  const handle = await adapter.requestRefresh();
  assert.equal(handle.requestedAt, '2026-10-26T15:00:00.000Z');
  assert.equal(http.callsTo('POST', 'manual-update').length, 1);
});

test('requestRefresh fails on a rejected request and on an unexpected answer', async () => {
  const rejected = build([{ method: 'POST', match: '/manual-update', respond: () => ({ status: 400, body: { error: 'no accounts' } }) }]);
  await assert.rejects(rejected.adapter.requestRefresh(), (e: Error) => e instanceof SourceHttpError);

  const odd = build([{ method: 'POST', match: '/manual-update', respond: () => ok({ success: false }) }]);
  await assert.rejects(odd.adapter.requestRefresh(), SourceFormatError);
});

test('an authentication error surfaces as SourceHttpError with the status', async () => {
  const { adapter } = build([
    { method: 'GET', match: '/get-accounts', respond: () => ({ status: 401, body: { type: 'invalid_api_key' } }) },
  ]);
  await assert.rejects(adapter.fetchAccounts(), (e: Error) => e instanceof SourceHttpError && (e as SourceHttpError).status === 401);
});

test('skips accounts and transactions of unsupported types and reports them', async () => {
  const odd = { ...pierreBankAccount, id: 'p-acc-odd', type: 'INVESTMENT', subtype: 'FUND' };
  const oddTx = { ...pierreBankCredit, id: 'p-tx-odd', account_type: 'INVESTMENT', account_subtype: 'FUND' };
  const { adapter } = build([
    { method: 'GET', match: '/get-accounts', respond: () => ok({ data: [pierreBankAccount, odd] }) },
    { method: 'GET', match: /\/get-transactions\?/, respond: () => ok({ data: [pierreBankCredit, oddTx] }) },
  ]);
  const { accounts } = await adapter.fetchAccounts();
  const txs = await adapter.fetchTransactions(new Date('2026-09-01T00:00:00.000Z'));
  assert.deepEqual(accounts.map((a) => a.externalId), ['p-acc-bank']);
  assert.deepEqual(txs.map((t) => t.externalId), ['p-tx-1']);
  assert.equal(adapter.drainWarnings().length, 2);
});

test('fetchFreshness reads only the account list and records nothing', async () => {
  const { http, snapshots, adapter } = build();
  const freshness = await adapter.fetchFreshness();
  assert.deepEqual(freshness, [
    { sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T13:34:07.676Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
  assert.equal(http.calls.length, 1);
  assert.equal(http.callsTo('GET', 'get-accounts').length, 1);
  assert.deepEqual(snapshots, []);
});
```

Substitua o conteúdo de `tests/adapters/pluggy/adapter.test.ts` (acrescenta três testes):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluggyAdapter } from '../../../src/adapters/pluggy/adapter.ts';
import { SourceHttpError } from '../../../src/core/http.ts';
import { FakeHttp, ok, type FakeRoute } from '../../support/fake-http.ts';
import {
  pluggyBankAccount,
  pluggyBankCredit,
  pluggyBill,
  pluggyCardAccount,
  pluggyCardPurchase,
  pluggyItem,
} from '../../fixtures/pluggy.ts';

const NOW = () => new Date('2026-10-26T15:00:00.000Z');
const CONFIG = { clientId: 'cid', clientSecret: 'super-secret', items: [{ label: 'Bank A', itemId: 'item-1' }] };

function baseRoutes(overrides: FakeRoute[] = []): FakeRoute[] {
  return [
    ...overrides,
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: 'key-1' }) },
    { method: 'GET', match: '/items/item-1', respond: () => ok(pluggyItem) },
    { method: 'GET', match: /\/accounts\?itemId=item-1$/, respond: () => ok({ results: [pluggyBankAccount, pluggyCardAccount] }) },
    {
      method: 'GET',
      match: /\/v2\/transactions\?accountId=acc-bank-1/,
      respond: () => ok({ results: [pluggyBankCredit], next: null }),
    },
    {
      method: 'GET',
      match: /\/v2\/transactions\?accountId=acc-card-1/,
      respond: () => ok({ results: [pluggyCardPurchase], next: null }),
    },
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=1$/, respond: () => ok({ page: 1, totalPages: 1, results: [pluggyBill] }) },
  ];
}

function build(routes: FakeRoute[] = baseRoutes()) {
  const http = new FakeHttp(routes);
  const snapshots: Array<{ endpoint: string; httpStatus: number; body: unknown }> = [];
  const adapter = new PluggyAdapter(CONFIG, { http, sink: (s) => snapshots.push(s), now: NOW });
  return { http, snapshots, adapter };
}

test('fetchAccounts returns normalized accounts and one freshness entry per item', async () => {
  const { adapter } = build();
  const { accounts, freshness } = await adapter.fetchAccounts();
  assert.deepEqual(accounts.map((a) => [a.externalId, a.kind, a.institution]), [
    ['acc-bank-1', 'checking', 'Bank A'],
    ['acc-card-1', 'credit_card', 'Bank A'],
  ]);
  assert.deepEqual(freshness, [
    { sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:53:55.112Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
});

test('authenticates once and sends the key on every data call', async () => {
  const { http, adapter } = build();
  await adapter.fetchAccounts();
  await adapter.fetchTransactions(new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(http.callsTo('POST', '/auth').length, 1);
  const dataCalls = http.calls.filter((c) => c.method === 'GET');
  assert.ok(dataCalls.length > 0);
  assert.ok(dataCalls.every((c) => c.options?.headers?.['X-API-KEY'] === 'key-1'));
  assert.deepEqual(http.callsTo('POST', '/auth')[0]?.options?.body, { clientId: 'cid', clientSecret: 'super-secret' });
});

test('never passes credentials or the api key to the snapshot sink', async () => {
  const { snapshots, adapter } = build();
  await adapter.fetchAccounts();
  await adapter.fetchTransactions(new Date('2026-08-01T00:00:00.000Z'));
  await adapter.fetchBills();
  assert.ok(snapshots.length >= 5);
  const text = JSON.stringify(snapshots);
  assert.equal(text.includes('super-secret'), false);
  assert.equal(text.includes('key-1'), false);
  assert.ok(snapshots.some((s) => s.endpoint === '/items/item-1'));
});

test('fetchTransactions uses the date window and the account kind for the sign', async () => {
  const { http, adapter } = build();
  const txs = await adapter.fetchTransactions(new Date('2026-08-01T10:00:00.000Z'));
  assert.ok(http.callsTo('GET', 'dateFrom=2026-08-01&dateTo=2026-10-26').length === 2);
  const byId = Object.fromEntries(txs.map((t) => [t.externalId, t]));
  assert.equal(byId['tx-1']?.amount, 15000);
  assert.equal(byId['tx-2']?.amount, -9990);
});

test('fetchTransactions follows the cursor across pages', async () => {
  const routes = baseRoutes([
    {
      method: 'GET',
      match: /\/v2\/transactions\?after=abc$/,
      respond: () => ok({ results: [{ ...pluggyBankCredit, id: 'tx-1b' }], next: null }),
    },
    {
      method: 'GET',
      match: /\/v2\/transactions\?accountId=acc-bank-1/,
      respond: () => ok({ results: [pluggyBankCredit], next: '?after=abc' }),
    },
  ]);
  const { adapter } = build(routes);
  const txs = await adapter.fetchTransactions(new Date('2026-08-01T00:00:00.000Z'));
  assert.deepEqual(txs.filter((t) => t.accountExternalId === 'acc-bank-1').map((t) => t.externalId), ['tx-1', 'tx-1b']);
});

test('re-authenticates once when the cached key is rejected', async () => {
  let accountCalls = 0;
  let authCalls = 0;
  const routes: FakeRoute[] = [
    ...baseRoutes().filter((r) => !(r.method === 'POST' && r.match === '/auth') && !String(r.match).includes('accounts')),
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: `key-${++authCalls}` }) },
    {
      method: 'GET',
      match: /\/accounts\?itemId=item-1$/,
      respond: (_url, options) => {
        accountCalls++;
        return options?.headers?.['X-API-KEY'] === 'key-1' && accountCalls === 2
          ? { status: 403, body: { message: 'expired' } }
          : ok({ results: [pluggyBankAccount] });
      },
    },
  ];
  const { adapter } = build(routes);
  await adapter.fetchAccounts();
  await adapter.fetchAccounts();
  assert.equal(authCalls, 2);
});

test('raises SourceHttpError for a failing endpoint', async () => {
  const routes = baseRoutes([{ method: 'GET', match: '/items/item-1', respond: () => ({ status: 500, body: { message: 'boom' } }) }]);
  const { adapter } = build(routes);
  await assert.rejects(adapter.fetchAccounts(), (e: Error) => e instanceof SourceHttpError && (e as SourceHttpError).status === 500);
});

test('skips unsupported account types and reports them once', async () => {
  const routes = baseRoutes([
    {
      method: 'GET',
      match: /\/accounts\?itemId=item-1$/,
      respond: () => ok({ results: [pluggyBankAccount, { ...pluggyBankAccount, id: 'acc-x', type: 'INVESTMENT', subtype: 'FUND' }] }),
    },
  ]);
  const { adapter } = build(routes);
  const { accounts } = await adapter.fetchAccounts();
  assert.deepEqual(accounts.map((a) => a.externalId), ['acc-bank-1']);
  const warnings = adapter.drainWarnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /Bank A: skipped an account/);
  assert.deepEqual(adapter.drainWarnings(), []);
});

test('fetchBills reads only credit card accounts and all pages', async () => {
  const routes = baseRoutes([
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=2$/, respond: () => ok({ page: 2, totalPages: 2, results: [{ ...pluggyBill, id: 'bill-2' }] }) },
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=1$/, respond: () => ok({ page: 1, totalPages: 2, results: [pluggyBill] }) },
  ]);
  const { http, adapter } = build(routes);
  const bills = await adapter.fetchBills();
  assert.deepEqual(bills.map((b) => b.externalId), ['bill-1', 'bill-2']);
  assert.equal(http.callsTo('GET', 'acc-bank-1').filter((c) => c.url.includes('/bills')).length, 0);
});

test('fetchFreshness reads only the items and records nothing', async () => {
  const { http, snapshots, adapter } = build();
  const freshness = await adapter.fetchFreshness();
  assert.deepEqual(freshness, [
    { sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:53:55.112Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
  assert.equal(http.calls.filter((c) => c.method === 'GET').length, 1);
  assert.deepEqual(snapshots, []);
});

test('fetchFreshness flags an item whose bank read limit was reached', async () => {
  const limited = {
    ...pluggyItem,
    status: 'PARTIAL_SUCCESS',
    statusDetail: { accounts: { isUpdated: false, warnings: [{ code: '423', message: 'Open Finance monthly rate limit reached' }] } },
  };
  const { adapter } = build(baseRoutes([{ method: 'GET', match: '/items/item-1', respond: () => ok(limited) }]));
  const [entry] = await adapter.fetchFreshness();
  assert.equal(entry?.quotaExhausted, true);
});

test('a partial success without the 423 warning is not a quota problem', async () => {
  const other = { ...pluggyItem, status: 'PARTIAL_SUCCESS', statusDetail: { accounts: { warnings: [{ code: '500', message: 'other' }] } } };
  const { adapter } = build(baseRoutes([{ method: 'GET', match: '/items/item-1', respond: () => ok(other) }]));
  const [entry] = await adapter.fetchFreshness();
  assert.equal('quotaExhausted' in (entry ?? {}), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/adapters/pierre/adapter.test.ts tests/adapters/pluggy/adapter.test.ts`
Expected: FAIL com `adapter.fetchFreshness is not a function`.

- [ ] **Step 3: Implementar**

Substitua o conteúdo de `src/adapters/pierre/adapter.ts`:

```ts
import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../core/adapter.ts';
import { SourceFormatError, SourceHttpError, type HttpClient, type SnapshotSink } from '../../core/http.ts';
import type { Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { asRecord, optString, reqIsoInstant, UnsupportedAccountError } from '../shape.ts';
import { dataArray, extractCardCredit, normalizeAccount, normalizeBill, normalizeTransaction } from './normalize.ts';

export interface PierreConfig {
  apiKey: string;
}

export interface PierreDeps {
  http: HttpClient;
  sink: SnapshotSink;
  now?: () => Date;
  baseUrl?: string;
}

/** Days of recent transactions read to learn each card's current limit. */
const CREDIT_LOOKBACK_DAYS = 90;

export class PierreAdapter implements SourceAdapter {
  readonly id = 'pierre';
  readonly capabilities: AdapterCapabilities = {
    refreshOnDemand: true,
    pendingTransactions: true,
    creditLimits: true,
    rawDescription: true,
    installments: true,
  };

  private readonly config: PierreConfig;
  private readonly http: HttpClient;
  private readonly sink: SnapshotSink;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private warnings: string[] = [];

  constructor(config: PierreConfig, deps: PierreDeps) {
    this.config = config;
    this.http = deps.http;
    this.sink = deps.sink;
    this.now = deps.now ?? (() => new Date());
    this.baseUrl = deps.baseUrl ?? 'https://www.pierre.finance/tools/api';
  }

  drainWarnings(): string[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  async fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }> {
    const rawAccounts = dataArray(await this.get('get-accounts'), 'pierre.accounts');
    const since = new Date(this.now().getTime() - CREDIT_LOOKBACK_DAYS * 86_400_000);
    const credit = extractCardCredit(await this.rawTransactions(since));

    const accounts: SourceAccount[] = [];
    for (const raw of rawAccounts) {
      try {
        accounts.push(normalizeAccount(raw, credit.get(optString(asRecord(raw, 'pierre.account'), 'id') ?? '')));
      } catch (error) {
        if (!(error instanceof UnsupportedAccountError)) throw error;
        this.warnings.push(`skipped an account (${error.message})`);
      }
    }
    return { accounts, freshness: this.freshnessFrom(rawAccounts) };
  }

  /** One light read of the account list. Manual accounts have no connector and are left out. */
  async fetchFreshness(): Promise<Freshness[]> {
    return this.freshnessFrom(dataArray(await this.get('get-accounts', false), 'pierre.accounts'));
  }

  private freshnessFrom(rawAccounts: unknown[]): Freshness[] {
    const observedAt = this.now().toISOString();
    const byConnector = new Map<string, Freshness>();
    for (const raw of rawAccounts) {
      const record = asRecord(raw, 'pierre.account');
      const connector = optString(record, 'connectorName');
      if (connector === null || byConnector.has(connector)) continue;
      byConnector.set(connector, {
        sourceId: this.id,
        institution: connector,
        lastUpdatedAt: reqIsoInstant(record, 'itemLastUpdatedAt', 'pierre.account'),
        observedAt,
      });
    }
    return [...byConnector.values()];
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    const out: SourceTransaction[] = [];
    for (const raw of await this.rawTransactions(since)) {
      try {
        out.push(normalizeTransaction(raw));
      } catch (error) {
        if (!(error instanceof UnsupportedAccountError)) throw error;
        this.warnings.push(`skipped a transaction (${error.message})`);
      }
    }
    return out;
  }

  async fetchBills(): Promise<SourceBill[]> {
    return dataArray(await this.get('get-bills'), 'pierre.bills').map(normalizeBill);
  }

  /** Starts a sync of every connected bank. It is sent once and never retried, because it uses bank request quota. */
  async requestRefresh(): Promise<RefreshHandle> {
    const url = `${this.baseUrl}/manual-update`;
    const response = await this.http.request('POST', url, { headers: this.headers() });
    this.sink({ endpoint: 'manual-update', httpStatus: response.status, body: response.body });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
    if (asRecord(response.body, 'pierre.manual-update').success !== true) {
      throw new SourceFormatError('pierre.manual-update.success: expected true');
    }
    return { requestedAt: this.now().toISOString() };
  }

  private rawTransactions(since: Date): Promise<unknown[]> {
    const start = since.toISOString().slice(0, 10);
    const end = this.now().toISOString().slice(0, 10);
    return this.get(`get-transactions?startDate=${start}&endDate=${end}&format=raw&includeStatus=POSTED,PENDING`).then(
      (body) => dataArray(body, 'pierre.transactions'),
    );
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  private async get(path: string, record = true): Promise<unknown> {
    const url = `${this.baseUrl}/${path}`;
    const response = await this.http.request('GET', url, { headers: this.headers() });
    if (record) this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
    return response.body;
  }
}
```

Substitua o conteúdo de `src/adapters/pluggy/adapter.ts`:

```ts
import type { AdapterCapabilities, SourceAdapter } from '../../core/adapter.ts';
import {
  SourceFormatError,
  SourceHttpError,
  type HttpClient,
  type SnapshotSink,
} from '../../core/http.ts';
import type { AccountKind, Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { asArray, asRecord, optString, reqIsoInstant, reqNumber, UnsupportedAccountError } from '../shape.ts';
import { normalizeAccount, normalizeBill, normalizeTransaction } from './normalize.ts';

export interface PluggyItemConfig {
  /** Name the user gives the connection, for example the bank. MeuPluggy items hide the real name. */
  label: string;
  itemId: string;
}

export interface PluggyConfig {
  clientId: string;
  clientSecret: string;
  items: PluggyItemConfig[];
}

export interface PluggyDeps {
  http: HttpClient;
  sink: SnapshotSink;
  now?: () => Date;
  baseUrl?: string;
}

const MAX_PAGES = 200;

/**
 * The bank network limits reads per month. When the limit is hit, the item ends as PARTIAL_SUCCESS and a
 * product in statusDetail carries a warning with code 423.
 */
function hasQuotaWarning(item: Record<string, unknown>): boolean {
  if (item.status !== 'PARTIAL_SUCCESS' || typeof item.statusDetail !== 'object' || item.statusDetail === null) return false;
  return Object.values(item.statusDetail as Record<string, unknown>).some((product) => {
    const warnings = typeof product === 'object' && product !== null ? (product as Record<string, unknown>).warnings : null;
    return Array.isArray(warnings) && warnings.some((w) => typeof w === 'object' && w !== null && String((w as Record<string, unknown>).code) === '423');
  });
}

export class PluggyAdapter implements SourceAdapter {
  readonly id = 'pluggy';
  readonly capabilities: AdapterCapabilities = {
    refreshOnDemand: false,
    pendingTransactions: true,
    creditLimits: true,
    rawDescription: true,
    installments: true,
  };

  private readonly config: PluggyConfig;
  private readonly http: HttpClient;
  private readonly sink: SnapshotSink;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private apiKey: string | null = null;
  private readonly kinds = new Map<string, AccountKind>();
  private warnings: string[] = [];

  constructor(config: PluggyConfig, deps: PluggyDeps) {
    this.config = config;
    this.http = deps.http;
    this.sink = deps.sink;
    this.now = deps.now ?? (() => new Date());
    this.baseUrl = deps.baseUrl ?? 'https://api.pluggy.ai';
  }

  drainWarnings(): string[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  async fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }> {
    const accounts: SourceAccount[] = [];
    const freshness: Freshness[] = [];
    const observedAt = this.now().toISOString();

    for (const item of this.config.items) {
      freshness.push(this.freshnessOf(item, asRecord(await this.get(`/items/${item.itemId}`), 'pluggy.item'), observedAt));

      const list = asRecord(await this.get(`/accounts?itemId=${item.itemId}`), 'pluggy.accounts');
      for (const raw of asArray(list.results, 'pluggy.accounts.results')) {
        try {
          const account = normalizeAccount(raw, item.label);
          this.kinds.set(account.externalId, account.kind);
          accounts.push(account);
        } catch (error) {
          if (!(error instanceof UnsupportedAccountError)) throw error;
          this.warnings.push(`${item.label}: skipped an account (${error.message})`);
        }
      }
    }
    return { accounts, freshness };
  }

  /** Reads only the items, which is cheap and does not touch the banks. */
  async fetchFreshness(): Promise<Freshness[]> {
    const observedAt = this.now().toISOString();
    const out: Freshness[] = [];
    for (const item of this.config.items) {
      out.push(this.freshnessOf(item, asRecord(await this.get(`/items/${item.itemId}`, false), 'pluggy.item'), observedAt));
    }
    return out;
  }

  private freshnessOf(item: PluggyItemConfig, body: Record<string, unknown>, observedAt: string): Freshness {
    return {
      sourceId: this.id,
      institution: item.label,
      lastUpdatedAt: reqIsoInstant(body, 'lastUpdatedAt', 'pluggy.item'),
      observedAt,
      ...(hasQuotaWarning(body) ? { quotaExhausted: true } : {}),
    };
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    if (this.kinds.size === 0) await this.fetchAccounts();
    const from = since.toISOString().slice(0, 10);
    const to = this.now().toISOString().slice(0, 10);
    const out: SourceTransaction[] = [];

    for (const [accountId, kind] of this.kinds) {
      let path = `/v2/transactions?accountId=${accountId}&dateFrom=${from}&dateTo=${to}`;
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new SourceFormatError(`pluggy.transactions: more than ${MAX_PAGES} pages for one account`);
        const body = asRecord(await this.get(path), 'pluggy.transactions');
        for (const raw of asArray(body.results, 'pluggy.transactions.results')) {
          out.push(normalizeTransaction(raw, kind));
        }
        const next = optString(body, 'next');
        if (next === null) break;
        path = `/v2/transactions${next}`;
      }
    }
    return out;
  }

  async fetchBills(): Promise<SourceBill[]> {
    if (this.kinds.size === 0) await this.fetchAccounts();
    const out: SourceBill[] = [];

    for (const [accountId, kind] of this.kinds) {
      if (kind !== 'credit_card') continue;
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new SourceFormatError(`pluggy.bills: more than ${MAX_PAGES} pages for one account`);
        const body = asRecord(await this.get(`/bills?accountId=${accountId}&page=${page}`), 'pluggy.bills');
        for (const raw of asArray(body.results, 'pluggy.bills.results')) {
          out.push(normalizeBill(raw, accountId));
        }
        if (page >= reqNumber(body, 'totalPages', 'pluggy.bills')) break;
      }
    }
    return out;
  }

  /** The key exchange is never sent to the sink, so credentials stay out of the snapshots. */
  private async authenticate(): Promise<string> {
    const response = await this.http.request('POST', `${this.baseUrl}/auth`, {
      body: { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
    });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, `${this.baseUrl}/auth`);
    const body = asRecord(response.body, 'pluggy.auth');
    const key = optString(body, 'apiKey');
    if (key === null) throw new SourceFormatError('pluggy.auth.apiKey: expected a non-empty string');
    this.apiKey = key;
    return key;
  }

  private async get(path: string, record = true): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let usedCachedKey = this.apiKey !== null;
    let key = this.apiKey ?? (await this.authenticate());
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.http.request('GET', url, { headers: { 'X-API-KEY': key } });
      if ((response.status === 401 || response.status === 403) && usedCachedKey) {
        usedCachedKey = false;
        key = await this.authenticate();
        continue;
      }
      if (record) this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
      if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
      return response.body;
    }
    throw new SourceHttpError(403, url);
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 179 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 4 arquivos modificados desta tarefa.

---

### Task 3: Política de cota e relatório

**Files:**
- Create: `src/scheduler/budget.ts`, `src/scheduler/quota.ts`
- Test: `tests/scheduler/budget.test.ts`, `tests/scheduler/quota.test.ts`

**Interfaces:**
- Consumes: `Store.quotaUsage`, `Store.listFreshness`, `RefreshLogEntry`, `institutionKey`, `localMonth`.
- Produces: `MONTHLY_LIMIT` (240); `assessBudget(inputs, options?)` com níveis `ok`, `warn` e `blocked`; `canRequestRefresh({ now, lastRefresh, budget, force?, minIntervalMs?, runningMs? }): { allowed, reasons }`; `quotaReport(store, now, options?): InstitutionBudget[]`; `formatQuotaReport(rows): string[]`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/scheduler/budget.test.ts`:

```ts
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
```

Crie `tests/scheduler/quota.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { formatQuotaReport, quotaReport } from '../../src/scheduler/quota.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  const at = NOW.toISOString();
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T10:00:00.000Z', observedAt: at });
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:00:00.000Z', observedAt: at });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-26T09:00:00.000Z', observedAt: at });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank B', lastUpdatedAt: '2026-10-26T09:00:00.000Z', observedAt: at, quotaExhausted: true });
  return store;
}

test('reports reads per institution for the current month, from both sources', () => {
  const rows = quotaReport(seeded(), NOW);
  assert.deepEqual(rows.map((r) => [r.institution, r.used, r.level, r.exhausted]), [
    ['Bank A', 3, 'ok', false],
    ['Bank B', 1, 'blocked', true],
  ]);
});

test('ignores reads from other months', () => {
  const store = seeded();
  assert.equal(quotaReport(store, new Date('2026-11-15T12:00:00.000Z')).every((r) => r.used === 0), true);
});

test('formats a readable table with a caveat', () => {
  const lines = formatQuotaReport(quotaReport(seeded(), NOW));
  assert.equal(lines[0], 'Institution   Reads   Share   Status');
  assert.ok(lines[1]?.startsWith('Bank A        3/240   1%      ok'));
  assert.ok(lines[2]?.endsWith('limit reached'));
  assert.match(lines.at(-1) ?? '', /real bank usage may be higher/);
  assert.deepEqual(formatQuotaReport([]), ['No bank reads recorded this month.']);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/scheduler/budget.test.ts tests/scheduler/quota.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/scheduler/budget.ts`.

- [ ] **Step 3: Implementar**

Crie `src/scheduler/budget.ts`:

```ts
import type { RefreshLogEntry } from '../store/store.ts';

/** Reads the bank network allows per month for one institution and product (transactions). */
export const MONTHLY_LIMIT = 240;

export type BudgetLevel = 'ok' | 'warn' | 'blocked';

export interface BudgetOptions {
  monthlyLimit?: number;
  /** Fraction of the limit at which a warning starts. Defaults to 0.7. */
  warnAt?: number;
  /** Fraction of the limit at which manual refreshes are blocked. Defaults to 0.9. */
  blockAt?: number;
}

export interface InstitutionBudget {
  institutionKey: string;
  institution: string;
  used: number;
  limit: number;
  level: BudgetLevel;
  /** The source reported that the bank refused further reads this month. */
  exhausted: boolean;
}

export interface BudgetInput {
  institutionKey: string;
  institution: string;
  used: number;
  exhausted: boolean;
}

export function assessBudget(inputs: BudgetInput[], options: BudgetOptions = {}): InstitutionBudget[] {
  const limit = options.monthlyLimit ?? MONTHLY_LIMIT;
  const warnAt = options.warnAt ?? 0.7;
  const blockAt = options.blockAt ?? 0.9;
  return inputs.map((i) => {
    const ratio = i.used / limit;
    const level: BudgetLevel = i.exhausted || ratio >= blockAt ? 'blocked' : ratio >= warnAt ? 'warn' : 'ok';
    return { ...i, limit, level };
  });
}

export interface RefreshPolicyInput {
  now: Date;
  lastRefresh: RefreshLogEntry | null;
  budget: InstitutionBudget[];
  /** Skip the spacing and budget checks. A refresh that is still running always blocks. */
  force?: boolean;
  /** Minimum gap between two refresh requests. Defaults to 15 minutes. */
  minIntervalMs?: number;
  /** How long a refresh without a finish time is considered still running. Defaults to 5 minutes. */
  runningMs?: number;
}

export interface RefreshDecision {
  allowed: boolean;
  reasons: string[];
}

export function canRequestRefresh(input: RefreshPolicyInput): RefreshDecision {
  const minIntervalMs = input.minIntervalMs ?? 15 * 60_000;
  const runningMs = input.runningMs ?? 5 * 60_000;
  const reasons: string[] = [];
  const last = input.lastRefresh;

  if (last !== null) {
    const age = input.now.getTime() - new Date(last.requestedAt).getTime();
    if (last.status === 'requested' && age < runningMs) {
      return { allowed: false, reasons: [`another refresh is still running (requested at ${last.requestedAt})`] };
    }
    if (!input.force && age < minIntervalMs) {
      reasons.push(`the last refresh was ${Math.floor(age / 60_000)} minutes ago (minimum ${Math.round(minIntervalMs / 60_000)})`);
    }
  }

  if (!input.force) {
    const exhausted = input.budget.filter((b) => b.exhausted).map((b) => b.institution);
    if (exhausted.length > 0) reasons.push(`the bank read limit was reached for ${exhausted.join(', ')}`);
    const nearly = input.budget.filter((b) => b.level === 'blocked' && !b.exhausted).map((b) => `${b.institution} (${b.used} of ${b.limit})`);
    if (nearly.length > 0) reasons.push(`almost all bank reads of the month are used for ${nearly.join(', ')}`);
  }
  return { allowed: reasons.length === 0, reasons };
}
```

Crie `src/scheduler/quota.ts`:

```ts
import { institutionKey } from '../core/names.ts';
import { localMonth } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { assessBudget, type BudgetOptions, type InstitutionBudget } from './budget.ts';

/** Bank reads used this month per institution, with the display name taken from the freshness records. */
export function quotaReport(store: Store, now: Date, options: BudgetOptions = {}): InstitutionBudget[] {
  const month = localMonth(now.toISOString());
  const used = new Map(store.quotaUsage(month).map((u) => [u.institutionKey, u.events]));
  const names = new Map<string, string>();
  const exhausted = new Set<string>();
  for (const f of store.listFreshness()) {
    const key = institutionKey(f.institution);
    if (!names.has(key)) names.set(key, f.institution);
    if (f.quotaExhausted) exhausted.add(key);
  }
  const keys = new Set([...used.keys(), ...names.keys()]);
  return assessBudget(
    [...keys].sort().map((key) => ({ institutionKey: key, institution: names.get(key) ?? key, used: used.get(key) ?? 0, exhausted: exhausted.has(key) })),
    options,
  );
}

export function formatQuotaReport(rows: InstitutionBudget[]): string[] {
  if (rows.length === 0) return ['No bank reads recorded this month.'];
  const lines = ['Institution   Reads   Share   Status'];
  for (const r of rows) {
    const share = `${Math.round((r.used / r.limit) * 100)}%`;
    const status = r.exhausted ? 'limit reached' : r.level === 'blocked' ? 'refresh blocked' : r.level === 'warn' ? 'warning' : 'ok';
    lines.push(`${r.institution.padEnd(13)} ${`${r.used}/${r.limit}`.padEnd(7)} ${share.padEnd(7)} ${status}`);
  }
  lines.push('Counts every distinct sync time seen from either source; the real bank usage may be higher.');
  return lines;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 192 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 4 arquivos novos desta tarefa.

---

### Task 4: Atualização manual

**Files:**
- Create: `src/scheduler/refresh.ts`, `tests/support/scripted-adapter.ts`
- Test: `tests/scheduler/refresh.test.ts`

**Interfaces:**
- Consumes: `canRequestRefresh`, `quotaReport`, `Store`, `SourceAdapter.requestRefresh` e `fetchFreshness`.
- Produces: `requestManualRefresh({ store, adapter, now?, sleep?, force?, waitMs?, pollMs?, onProgress? }): Promise<RefreshOutcome>` com `{ institutions: [{ institution, updated, seconds }], timedOut }`; `RefreshBlockedError` com `reasons`; o dublê de teste `ScriptedAdapter(id, script)` e `syncTime(...)`.

- [ ] **Step 1: Escrever o dublê e o teste que falha**

Crie `tests/support/scripted-adapter.ts`:

```ts
import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../src/core/adapter.ts';
import type { Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../src/core/types.ts';

export interface Script {
  /** Answers of consecutive fetchFreshness calls; the last one repeats. An Error is thrown instead of returned. */
  reads?: Array<Freshness[] | Error>;
  refreshOnDemand?: boolean;
  refreshError?: Error;
  accounts?: SourceAccount[];
  transactions?: SourceTransaction[];
  bills?: SourceBill[];
  /** Makes fetchTransactions fail this many times before it works. */
  failTransactions?: number;
}

/** Adapter whose answers are scripted, to test code that polls and syncs. */
export class ScriptedAdapter implements SourceAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  refreshCalls = 0;
  freshnessCalls = 0;
  transactionCalls: Date[] = [];
  requestRefresh?: () => Promise<RefreshHandle>;
  private readonly script: Script;

  constructor(id: string, script: Script = {}) {
    this.id = id;
    this.script = script;
    this.capabilities = {
      refreshOnDemand: script.refreshOnDemand ?? false,
      pendingTransactions: true,
      creditLimits: true,
      rawDescription: true,
      installments: true,
    };
    if (script.refreshOnDemand) {
      this.requestRefresh = async () => {
        this.refreshCalls++;
        if (script.refreshError) throw script.refreshError;
        return { requestedAt: new Date().toISOString() };
      };
    }
  }

  async fetchFreshness(): Promise<Freshness[]> {
    const reads = this.script.reads ?? [[]];
    const next = reads[Math.min(this.freshnessCalls++, reads.length - 1)] as Freshness[] | Error;
    if (next instanceof Error) throw next;
    return next;
  }

  async fetchAccounts() {
    return { accounts: this.script.accounts ?? [], freshness: [] };
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    this.transactionCalls.push(since);
    if ((this.script.failTransactions ?? 0) >= this.transactionCalls.length) throw new Error('transactions are down');
    return this.script.transactions ?? [];
  }

  async fetchBills(): Promise<SourceBill[]> {
    return this.script.bills ?? [];
  }
}

export const syncTime = (sourceId: string, institution: string, lastUpdatedAt: string, extra: Partial<Freshness> = {}): Freshness => ({
  sourceId,
  institution,
  lastUpdatedAt,
  observedAt: lastUpdatedAt,
  ...extra,
});
```

Crie `tests/scheduler/refresh.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RefreshBlockedError, requestManualRefresh } from '../../src/scheduler/refresh.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { ScriptedAdapter, syncTime } from '../support/scripted-adapter.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T0 = new Date('2026-10-26T16:00:00.000Z').getTime();
const old = (inst: string) => syncTime('pierre', inst, '2026-10-26T10:00:00.000Z');
const fresh = (inst: string) => syncTime('pierre', inst, '2026-10-26T16:00:30.000Z');

function setup(reads: ConstructorParameters<typeof ScriptedAdapter>[1] = {}) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapter = new ScriptedAdapter('pierre', { refreshOnDemand: true, ...reads });
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, new Date(T0).toISOString());
  const clock = { t: T0 };
  const sleeps: number[] = [];
  const progress: string[] = [];
  const common = {
    store,
    adapter,
    now: () => new Date(clock.t),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    onProgress: (m: string) => progress.push(m),
  };
  return { store, adapter, clock, sleeps, progress, common };
}

test('requests the refresh once and reports when each institution updated', async () => {
  const { adapter, store, common, progress } = setup({
    reads: [[old('Bank A'), old('Bank B')], [fresh('Bank A'), old('Bank B')], [fresh('Bank A'), fresh('Bank B')]],
  });
  const outcome = await requestManualRefresh(common);
  assert.equal(adapter.refreshCalls, 1);
  assert.deepEqual(outcome.institutions, [
    { institution: 'Bank A', updated: true, seconds: 5 },
    { institution: 'Bank B', updated: true, seconds: 10 },
  ]);
  assert.deepEqual(outcome.timedOut, []);
  assert.equal(store.lastRefresh('pierre')?.status, 'completed');
  assert.deepEqual(progress, ['refresh requested for 2 institutions', 'Bank A updated after 5s', 'Bank B updated after 10s']);
});

test('stops waiting when every institution has updated', async () => {
  const { common, sleeps } = setup({ reads: [[old('Bank A')], [fresh('Bank A')]] });
  await requestManualRefresh(common);
  assert.deepEqual(sleeps, [5000]);
});

test('gives up after the wait time and names the institutions that did not update', async () => {
  const { store, common, sleeps } = setup({ reads: [[old('Bank A'), old('Bank B')], [fresh('Bank A'), old('Bank B')]] });
  const outcome = await requestManualRefresh({ ...common, waitMs: 20_000, pollMs: 5_000 });
  assert.deepEqual(outcome.timedOut, ['Bank B']);
  assert.equal(outcome.institutions.find((i) => i.institution === 'Bank A')?.updated, true);
  assert.equal(sleeps.length, 4);
  assert.equal(store.lastRefresh('pierre')?.status, 'timeout');
});

test('does not request a refresh when the policy blocks it', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')]] });
  store.finishRefresh(store.startRefresh('pierre', new Date(T0 - 5 * 60_000).toISOString()), new Date(T0 - 4 * 60_000).toISOString(), 'completed', {});
  await assert.rejects(requestManualRefresh(common), (e: Error) => e instanceof RefreshBlockedError && /5 minutes ago/.test(e.message));
  assert.equal(adapter.refreshCalls, 0);
  assert.equal(adapter.freshnessCalls, 0);
});

test('force skips the spacing check', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')], [fresh('Bank A')]] });
  store.finishRefresh(store.startRefresh('pierre', new Date(T0 - 5 * 60_000).toISOString()), new Date(T0 - 4 * 60_000).toISOString(), 'completed', {});
  await requestManualRefresh({ ...common, force: true });
  assert.equal(adapter.refreshCalls, 1);
});

test('is blocked when an institution has used almost all of its monthly reads', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')]] });
  for (let i = 0; i < 220; i++) {
    store.upsertFreshness(syncTime('pierre', 'Bank A', new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 3_600_000).toISOString()));
  }
  await assert.rejects(requestManualRefresh(common), (e: Error) => e instanceof RefreshBlockedError && /Bank A \(\d+ of 240\)/.test(e.message));
  assert.equal(adapter.refreshCalls, 0);
});

test('logs a failed request and does not repeat it', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')]], refreshError: new Error('HTTP 400 from manual-update') });
  await assert.rejects(requestManualRefresh(common), /HTTP 400/);
  assert.equal(adapter.refreshCalls, 1);
  const last = store.lastRefresh('pierre');
  assert.equal(last?.status, 'failed');
  assert.deepEqual(last?.detail, { error: 'HTTP 400 from manual-update' });
});

test('keeps waiting when a read of the sync times fails', async () => {
  const { common, progress } = setup({ reads: [[old('Bank A')], new Error('network reset'), [fresh('Bank A')]] });
  const outcome = await requestManualRefresh(common);
  assert.deepEqual(outcome.timedOut, []);
  assert.ok(progress.some((m) => /could not read the sync times/.test(m) && /network reset/.test(m)));
});

test('each new sync time counts as a bank read', async () => {
  const { store, common } = setup({ reads: [[old('Bank A')], [fresh('Bank A')]] });
  await requestManualRefresh(common);
  assert.deepEqual(store.quotaUsage('2026-10'), [{ institutionKey: 'bank a', events: 2 }]);
});

test('refuses a source that cannot refresh on demand', async () => {
  const { store } = setup();
  await assert.rejects(requestManualRefresh({ store, adapter: new ScriptedAdapter('pluggy') }), /cannot refresh on demand/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/scheduler/refresh.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/scheduler/refresh.ts`.

- [ ] **Step 3: Implementar**

Crie `src/scheduler/refresh.ts`:

```ts
import type { SourceAdapter } from '../core/adapter.ts';
import { institutionKey } from '../core/names.ts';
import type { Store } from '../store/store.ts';
import { canRequestRefresh } from './budget.ts';
import { quotaReport } from './quota.ts';

export class RefreshBlockedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Refresh blocked: ${reasons.join('; ')}`);
    this.name = 'RefreshBlockedError';
    this.reasons = reasons;
  }
}

export interface RefreshDeps {
  store: Store;
  adapter: SourceAdapter;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Skip the spacing and budget checks. A refresh already running still blocks. */
  force?: boolean;
  /** How long to wait for every institution to report a new sync time. Defaults to 3 minutes. */
  waitMs?: number;
  /** Pause between two reads of the sync times. Defaults to 5 seconds. */
  pollMs?: number;
  onProgress?: (message: string) => void;
}

export interface InstitutionOutcome {
  institution: string;
  updated: boolean;
  seconds: number | null;
}

export interface RefreshOutcome {
  institutions: InstitutionOutcome[];
  /** Institutions that did not report a new sync time in time. Their old data stays in use. */
  timedOut: string[];
}

/**
 * Asks the source to sync every bank now and waits until each institution reports a newer sync time.
 * The request is sent once and never repeated, because every refresh uses bank read quota.
 */
export async function requestManualRefresh(deps: RefreshDeps): Promise<RefreshOutcome> {
  const { store, adapter } = deps;
  if (!adapter.capabilities.refreshOnDemand || !adapter.requestRefresh || !adapter.fetchFreshness) {
    throw new Error(`${adapter.id} cannot refresh on demand`);
  }
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitMs ?? 180_000;
  const pollMs = deps.pollMs ?? 5_000;
  const progress = deps.onProgress ?? (() => {});

  const decision = canRequestRefresh({ now: now(), lastRefresh: store.lastRefresh(adapter.id), budget: quotaReport(store, now()), force: deps.force });
  if (!decision.allowed) throw new RefreshBlockedError(decision.reasons);

  const before = await adapter.fetchFreshness();
  for (const f of before) store.upsertFreshness(f);
  const baseline = new Map(before.map((f) => [institutionKey(f.institution), { name: f.institution, at: f.lastUpdatedAt }]));

  const logId = store.startRefresh(adapter.id, now().toISOString());
  const startedAt = now().getTime();
  try {
    await adapter.requestRefresh();
  } catch (error) {
    store.finishRefresh(logId, now().toISOString(), 'failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  progress(`refresh requested for ${baseline.size} institutions`);

  const done = new Map<string, number>();
  while (done.size < baseline.size && now().getTime() - startedAt < waitMs) {
    await sleep(pollMs);
    let current;
    try {
      current = await adapter.fetchFreshness();
    } catch (error) {
      progress(`could not read the sync times, trying again (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    for (const f of current) {
      store.upsertFreshness(f);
      const key = institutionKey(f.institution);
      const base = baseline.get(key);
      if (base && f.lastUpdatedAt !== base.at && !done.has(key)) {
        const seconds = Math.round((now().getTime() - startedAt) / 1000);
        done.set(key, seconds);
        progress(`${f.institution} updated after ${seconds}s`);
      }
    }
  }

  const institutions: InstitutionOutcome[] = [...baseline].map(([key, base]) => ({
    institution: base.name,
    updated: done.has(key),
    seconds: done.get(key) ?? null,
  }));
  const timedOut = institutions.filter((i) => !i.updated).map((i) => i.institution);
  store.finishRefresh(logId, now().toISOString(), timedOut.length > 0 ? 'timeout' : 'completed', { institutions, timedOut });
  return { institutions, timedOut };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 202 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 3 arquivos novos desta tarefa.

---

### Task 5: Observador

**Files:**
- Create: `src/scheduler/observer.ts`
- Test: `tests/scheduler/observer.test.ts`

**Interfaces:**
- Consumes: `syncSource` de `src/sync/sync.ts`, `ScriptedAdapter`.
- Produces: `class Observer` com `new Observer({ store, sources, reconcile, now?, sleep?, onEvent?, lookbackDays?, maxBackoffMs? })`, `tick(source)` e `run(signal)`; tipos `ObserverEvent` (`checked`, `changed`, `synced`, `error`) e `ObservedSource { adapter, intervalMs }`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/scheduler/observer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Observer, type ObserverEvent } from '../../src/scheduler/observer.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { ScriptedAdapter, syncTime } from '../support/scripted-adapter.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T0 = new Date('2026-10-26T16:00:00.000Z').getTime();
const at = (sourceId: string, minutes: number) => syncTime(sourceId, 'Bank A', new Date(T0 - minutes * 60_000).toISOString());

function setup(adapters: ScriptedAdapter[], intervals: number[] = adapters.map(() => 300_000), abortAfterMs?: number) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const a of adapters) store.registerSource({ id: a.id, kind: 'aggregator', capabilities: {} }, new Date(T0).toISOString());
  const clock = { t: T0 };
  const controller = new AbortController();
  const events: ObserverEvent[] = [];
  let reconciles = 0;
  const observer = new Observer({
    store,
    sources: adapters.map((adapter, i) => ({ adapter, intervalMs: intervals[i] as number })),
    reconcile: () => {
      reconciles++;
    },
    now: () => new Date(clock.t),
    onEvent: (e) => events.push(e),
    // Time passes only when the observer sleeps, so the run loop is deterministic.
    sleep: async (ms) => {
      clock.t += ms;
      if (abortAfterMs !== undefined && clock.t >= T0 + abortAfterMs) controller.abort();
    },
  });
  return { store, observer, clock, controller, events, reconciles: () => reconciles, sources: adapters.map((adapter, i) => ({ adapter, intervalMs: intervals[i] as number })) };
}

test('the first check records the sync times and reads the source', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const { observer, events, reconciles, sources, store } = setup([adapter]);
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['changed', 'synced']);
  assert.equal(reconciles(), 1);
  assert.equal(adapter.transactionCalls.length, 1);
  assert.equal(store.listFreshness().length, 1);
});

test('a check that finds nothing new does not read the source', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const { observer, events, reconciles, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['checked']);
  assert.equal(adapter.transactionCalls.length, 1);
  assert.equal(reconciles(), 1);
});

test('newer sync times trigger a read of the last 14 days and a rebuild', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)], [at('pierre', 1)]] });
  const { observer, events, reconciles, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['changed', 'synced']);
  assert.equal(adapter.transactionCalls.length, 2);
  assert.equal(adapter.transactionCalls[1]?.toISOString(), new Date(T0 - 14 * 86_400_000).toISOString());
  assert.equal(reconciles(), 2);
  const changed = events[0];
  assert.deepEqual(changed?.type === 'changed' ? changed.institutions : [], ['Bank A']);
});

test('a read that failed is retried at the next check even if nothing new was reported', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]], failTransactions: 1 });
  const { observer, events, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  const first = events.find((e) => e.type === 'synced');
  assert.equal(first?.type === 'synced' ? first.result.errors.length : 0, 1);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['synced']);
  assert.equal(adapter.transactionCalls.length, 2);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['checked']);
});

test('errors are reported, back off, and clear after a success', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [new Error('offline'), new Error('offline'), [at('pierre', 1)]] });
  const { observer, events, clock, sources } = setup([adapter], [300_000]);
  await observer.tick(sources[0]!);
  await observer.tick(sources[0]!);
  const waits = events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.retryInMs : 0));
  assert.deepEqual(waits, [600_000, 1_200_000]);
  clock.t += 1_200_000;
  await observer.tick(sources[0]!);
  assert.equal(events.at(-1)?.type, 'synced');
});

test('the wait after errors never exceeds the maximum', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [new Error('offline')] });
  const { observer, events, sources } = setup([adapter], [300_000]);
  for (let i = 0; i < 8; i++) await observer.tick(sources[0]!);
  const last = events.at(-1);
  assert.equal(last?.type === 'error' ? last.retryInMs : 0, 1_800_000);
});

test('a source without a freshness check is skipped', async () => {
  const adapter = new ScriptedAdapter('plain');
  Object.defineProperty(adapter, 'fetchFreshness', { value: undefined });
  const { observer, events, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  assert.deepEqual(events, []);
});

test('run checks each source at its own interval until aborted', async () => {
  const slow = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const fast = new ScriptedAdapter('pluggy', { reads: [[at('pluggy', 30)]] });
  const { observer, controller } = setup([slow, fast], [300_000, 120_000], 600_000);
  await observer.run(controller.signal);
  // The loop stops when the clock reaches 10 minutes, before checking again at that instant.
  assert.equal(slow.freshnessCalls, 2);
  assert.equal(fast.freshnessCalls, 5);
});

test('run stops at once when the signal is already aborted', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const { observer, controller } = setup([adapter]);
  controller.abort();
  await observer.run(controller.signal);
  assert.equal(adapter.freshnessCalls, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/scheduler/observer.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/scheduler/observer.ts`.

- [ ] **Step 3: Implementar**

Crie `src/scheduler/observer.ts`:

```ts
import type { SourceAdapter } from '../core/adapter.ts';
import type { SourceId } from '../core/types.ts';
import type { Store } from '../store/store.ts';
import { syncSource, type SyncResult } from '../sync/sync.ts';

export type ObserverEvent =
  | { type: 'checked'; sourceId: SourceId }
  | { type: 'changed'; sourceId: SourceId; institutions: string[] }
  | { type: 'synced'; sourceId: SourceId; result: SyncResult }
  | { type: 'error'; sourceId: SourceId; message: string; retryInMs: number };

export interface ObservedSource {
  adapter: SourceAdapter;
  intervalMs: number;
}

export interface ObserverDeps {
  store: Store;
  sources: ObservedSource[];
  /** Runs after a source was synced, to rebuild the canonical data. */
  reconcile: () => void;
  now?: () => Date;
  /** Resolves after `ms`, or earlier when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: ObserverEvent) => void;
  /** Days of transactions to re-read when a source reports new data. Defaults to 14. */
  lookbackDays?: number;
  /** Longest wait after repeated failures. Defaults to 30 minutes. */
  maxBackoffMs?: number;
}

interface SourceState {
  failures: number;
  nextDueAt: number;
  /** A change was seen but the sync that should follow it did not finish. */
  needsSync: boolean;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Watches when each source last synced each bank. That check is cheap and does not touch the banks.
 * When a source reports newer data, the observer reads it and rebuilds the canonical data.
 */
export class Observer {
  private readonly deps: ObserverDeps;
  private readonly now: () => Date;
  private readonly states = new Map<SourceId, SourceState>();

  constructor(deps: ObserverDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    for (const s of deps.sources) this.states.set(s.adapter.id, { failures: 0, nextDueAt: 0, needsSync: false });
  }

  private emit(event: ObserverEvent): void {
    this.deps.onEvent?.(event);
  }

  /** One check of one source. Failures are reported as events and delay the next check. */
  async tick(source: ObservedSource): Promise<void> {
    const { adapter, intervalMs } = source;
    const state = this.states.get(adapter.id) as SourceState;
    if (!adapter.fetchFreshness) return;
    try {
      const freshness = await adapter.fetchFreshness();
      const changed = freshness.filter((f) => this.deps.store.upsertFreshness(f).changed);
      if (changed.length === 0 && !state.needsSync) {
        this.emit({ type: 'checked', sourceId: adapter.id });
      } else {
        if (changed.length > 0) this.emit({ type: 'changed', sourceId: adapter.id, institutions: changed.map((c) => c.institution) });
        state.needsSync = true;
        const since = new Date(this.now().getTime() - (this.deps.lookbackDays ?? 14) * 86_400_000);
        const result = await syncSource(adapter, { store: this.deps.store, now: this.now }, since);
        this.deps.reconcile();
        this.emit({ type: 'synced', sourceId: adapter.id, result });
        state.needsSync = result.errors.length > 0;
      }
      state.failures = 0;
      state.nextDueAt = this.now().getTime() + intervalMs;
    } catch (error) {
      state.failures++;
      const retryInMs = Math.min(intervalMs * 2 ** state.failures, this.deps.maxBackoffMs ?? 30 * 60_000);
      state.nextDueAt = this.now().getTime() + retryInMs;
      this.emit({ type: 'error', sourceId: adapter.id, message: error instanceof Error ? error.message : String(error), retryInMs });
    }
  }

  /** Checks every source when it is due, until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    while (!signal.aborted) {
      for (const source of this.deps.sources) {
        const state = this.states.get(source.adapter.id) as SourceState;
        if (!signal.aborted && state.nextDueAt <= this.now().getTime()) await this.tick(source);
      }
      const next = Math.min(...[...this.states.values()].map((s) => s.nextDueAt));
      await sleep(Math.max(0, next - this.now().getTime()), signal);
    }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 211 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 2 arquivos novos desta tarefa.

---

### Task 6: Comandos, configuração e integração com o servidor (depende de E-A)

**Files:**
- Create: `src/scheduler/defaults.ts`, `src/scheduler/events.ts`, `src/scheduler/refresh-args.ts`, `src/scheduler/reconcile-after-sync.ts`, `src/scheduler/refresh-cli.ts`, `src/scheduler/watch-cli.ts`, `src/scheduler/quota-cli.ts`
- Replace: `src/config.ts`, `src/main.ts`, `tests/config.test.ts`
- Modify: `package.json` (scripts `refresh`, `watch`, `quota`)
- Test: `tests/scheduler/events.test.ts`

**Interfaces:**
- Consumes: `Observer`, `requestManualRefresh`, `quotaReport`, `buildAdapters`, `runReconciliation`.
- Produces: `observedSources(adapters)` e `POLL_INTERVAL_MS`; `formatObserverEvent(event, verbose?)`; `parseRefreshArgs(argv)`; `reconcileAfterSync(store)`; os comandos `npm run refresh [-- --force]` (saída 0 com sucesso, 1 se bloqueada, com falha ou com banco que não atualizou, 2 com argumento inválido), `npm run watch [-- --once] [-- --verbose]` e `npm run quota`; `Config.observer`; o servidor inicia o observador quando `OBSERVER` vale `on`, `1` ou `true`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/scheduler/events.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedSources, POLL_INTERVAL_MS } from '../../src/scheduler/defaults.ts';
import { formatObserverEvent } from '../../src/scheduler/events.ts';
import { parseRefreshArgs } from '../../src/scheduler/refresh-args.ts';
import { ScriptedAdapter } from '../support/scripted-adapter.ts';

test('checked events are quiet unless verbose', () => {
  assert.equal(formatObserverEvent({ type: 'checked', sourceId: 'pierre' }), null);
  assert.equal(formatObserverEvent({ type: 'checked', sourceId: 'pierre' }, true), 'pierre: no new data');
});

test('formats changes, reads and errors in one line each', () => {
  assert.equal(formatObserverEvent({ type: 'changed', sourceId: 'pluggy', institutions: ['Bank A', 'Bank B'] }), 'pluggy: new data from Bank A, Bank B');
  const ok = { sourceId: 'pierre', accounts: 11, transactions: 468, bills: 37, freshness: 5, warnings: [], errors: [] };
  assert.equal(formatObserverEvent({ type: 'synced', sourceId: 'pierre', result: ok }), 'pierre: read 11 accounts, 468 transactions, 37 bills');
  assert.match(formatObserverEvent({ type: 'synced', sourceId: 'pierre', result: { ...ok, errors: ['bills: HTTP 500'] } }) ?? '', /1 failed step\(s\): bills: HTTP 500/);
  assert.equal(formatObserverEvent({ type: 'error', sourceId: 'pierre', message: 'offline', retryInMs: 600_000 }), 'pierre: offline (next try in 10 min)');
});

test('each source is checked at its own interval, and sources without a check are left out', () => {
  const pierre = new ScriptedAdapter('pierre');
  const other = new ScriptedAdapter('other');
  const plain = new ScriptedAdapter('plain');
  Object.defineProperty(plain, 'fetchFreshness', { value: undefined });
  const sources = observedSources([pierre, other, plain]);
  assert.deepEqual(sources.map((s) => [s.adapter.id, s.intervalMs]), [['pierre', POLL_INTERVAL_MS.pierre], ['other', 300_000]]);
  assert.equal(POLL_INTERVAL_MS.pluggy, 120_000);
});

test('parseRefreshArgs accepts --force and rejects anything else', () => {
  assert.deepEqual(parseRefreshArgs([]), { force: false });
  assert.deepEqual(parseRefreshArgs(['--force']), { force: true });
  assert.throws(() => parseRefreshArgs(['--now']), /Unknown argument: --now/);
});
```

Substitua o conteúdo de `tests/config.test.ts` (acrescenta o campo `observer` e um teste):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig applies defaults', () => {
  assert.deepEqual(loadConfig({}), { port: 8080, dbPath: 'data/gmf.sqlite', version: 'dev', observer: false });
});

test('loadConfig reads the environment', () => {
  assert.deepEqual(loadConfig({ PORT: '3000', DB_PATH: '/var/lib/gmf/db.sqlite', APP_VERSION: 'abc123' }), {
    port: 3000,
    dbPath: '/var/lib/gmf/db.sqlite',
    version: 'abc123',
    observer: false,
  });
});

test('loadConfig rejects an invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '80.5' }), /Invalid PORT/);
});

test('loadConfig turns the observer on only for on, 1 or true', () => {
  for (const value of ['on', '1', 'true', 'TRUE', ' On ']) assert.equal(loadConfig({ OBSERVER: value }).observer, true, value);
  for (const value of ['', 'off', '0', 'false', 'yes']) assert.equal(loadConfig({ OBSERVER: value }).observer, false, value);
  assert.equal(loadConfig({}).observer, false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/scheduler/events.test.ts tests/config.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/scheduler/defaults.ts` e falhas em `config.test.ts` por causa do campo `observer`.

- [ ] **Step 3: Implementar a configuração e os módulos**

Substitua o conteúdo de `src/config.ts`:

```ts
export interface Config {
  port: number;
  dbPath: string;
  version: string;
  /** Run the observer that keeps the data fresh. Off unless OBSERVER is on, 1 or true. */
  observer: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawPort = env.PORT ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  return {
    port,
    dbPath: env.DB_PATH ?? 'data/gmf.sqlite',
    version: env.APP_VERSION ?? 'dev',
    observer: ['on', '1', 'true'].includes((env.OBSERVER ?? '').trim().toLowerCase()),
  };
}
```

Crie `src/scheduler/defaults.ts`:

```ts
import type { SourceAdapter } from '../core/adapter.ts';
import type { ObservedSource } from './observer.ts';

/** How often each source is checked. The Pluggy items are a cheap read, and Pierre's account list is a little heavier. */
export const POLL_INTERVAL_MS: Record<string, number> = {
  pierre: 5 * 60_000,
  pluggy: 2 * 60_000,
};

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

export function observedSources(adapters: SourceAdapter[]): ObservedSource[] {
  return adapters
    .filter((adapter) => adapter.fetchFreshness !== undefined)
    .map((adapter) => ({ adapter, intervalMs: POLL_INTERVAL_MS[adapter.id] ?? DEFAULT_POLL_INTERVAL_MS }));
}
```

Crie `src/scheduler/events.ts`:

```ts
import type { ObserverEvent } from './observer.ts';

/** One readable line per observer event. `checked` events are quiet unless `verbose` is set. */
export function formatObserverEvent(event: ObserverEvent, verbose = false): string | null {
  switch (event.type) {
    case 'checked':
      return verbose ? `${event.sourceId}: no new data` : null;
    case 'changed':
      return `${event.sourceId}: new data from ${event.institutions.join(', ')}`;
    case 'synced': {
      const r = event.result;
      const problems = r.errors.length > 0 ? `, ${r.errors.length} failed step(s): ${r.errors.join('; ')}` : '';
      return `${event.sourceId}: read ${r.accounts} accounts, ${r.transactions} transactions, ${r.bills} bills${problems}`;
    }
    case 'error':
      return `${event.sourceId}: ${event.message} (next try in ${Math.round(event.retryInMs / 60_000)} min)`;
  }
}
```

Crie `src/scheduler/refresh-args.ts`:

```ts
export interface RefreshArgs {
  force: boolean;
}

export function parseRefreshArgs(argv: string[]): RefreshArgs {
  const args: RefreshArgs = { force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}
```

Crie `src/scheduler/reconcile-after-sync.ts`:

```ts
import type { Store } from '../store/store.ts';
import { runReconciliation } from '../reconcile/run.ts';

/** What the observer runs after reading new data: rebuild accounts, transactions and findings. */
export function reconcileAfterSync(store: Store): void {
  runReconciliation(store);
}
```

- [ ] **Step 4: Criar os comandos e integrar o servidor**

Crie `src/scheduler/refresh-cli.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { fetchHttpClient, retryingClient } from '../core/http.ts';
import { runReconciliation } from '../reconcile/run.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { buildAdapters } from '../sync/adapters.ts';
import { loadAdapterEnv } from '../sync/config.ts';
import { syncSource } from '../sync/sync.ts';
import { quotaReport, formatQuotaReport } from './quota.ts';
import { parseRefreshArgs } from './refresh-args.ts';
import { RefreshBlockedError, requestManualRefresh } from './refresh.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
let args;
try {
  args = parseRefreshArgs(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
try {
  const adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) });
  const adapter = adapters.find((a) => a.capabilities.refreshOnDemand);
  if (!adapter) {
    console.error('No source can refresh on demand. Set PIERRE_API_KEY.');
    process.exitCode = 1;
  } else {
    try {
      const outcome = await requestManualRefresh({ store, adapter, force: args.force, onProgress: (m) => console.log(m) });
      const result = await syncSource(adapter, { store }, new Date(Date.now() - 14 * 86_400_000));
      runReconciliation(store);
      console.log(`read ${result.accounts} accounts, ${result.transactions} transactions, ${result.bills} bills`);
      for (const e of result.errors) console.error(`  error: ${e}`);
      if (outcome.timedOut.length > 0) {
        console.error(`did not update in time: ${outcome.timedOut.join(', ')} (their previous data stays in use)`);
      }
      if (outcome.timedOut.length > 0 || result.errors.length > 0) process.exitCode = 1;
    } catch (error) {
      if (error instanceof RefreshBlockedError) {
        console.error('Refresh not started:');
        for (const reason of error.reasons) console.error(`  - ${reason}`);
        console.error('Use --force to skip the spacing and budget checks.');
      } else {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exitCode = 1;
    }
    console.log('');
    for (const line of formatQuotaReport(quotaReport(store, new Date()))) console.log(line);
  }
} finally {
  store.close();
}
```

Crie `src/scheduler/watch-cli.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { fetchHttpClient, retryingClient } from '../core/http.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { reconcileAfterSync } from './reconcile-after-sync.ts';
import { buildAdapters } from '../sync/adapters.ts';
import { loadAdapterEnv } from '../sync/config.ts';
import { observedSources } from './defaults.ts';
import { formatObserverEvent } from './events.ts';
import { Observer } from './observer.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const once = process.argv.includes('--once');
const verbose = process.argv.includes('--verbose') || once;
const unknown = process.argv.slice(2).filter((a) => !['--once', '--verbose'].includes(a));
if (unknown.length > 0) {
  console.error(`error: Unknown argument: ${unknown.join(' ')}`);
  process.exit(2);
}

const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
let exitCode = 0;
try {
  const adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) });
  const sources = observedSources(adapters);
  if (sources.length === 0) {
    console.error('No source to watch. Set PIERRE_API_KEY and/or the PLUGGY_* variables.');
    exitCode = 1;
  } else {
    const observer = new Observer({
      store,
      sources,
      reconcile: () => reconcileAfterSync(store),
      onEvent: (event) => {
        if (event.type === 'error') exitCode = 1;
        const line = formatObserverEvent(event, verbose);
        if (line) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
      },
    });
    if (once) {
      for (const source of sources) await observer.tick(source);
    } else {
      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      process.on('SIGTERM', () => controller.abort());
      console.log(`Watching ${sources.map((s) => `${s.adapter.id} every ${Math.round(s.intervalMs / 60_000)} min`).join(', ')}. Ctrl+C stops.`);
      await observer.run(controller.signal);
    }
  }
} finally {
  store.close();
}
process.exitCode = exitCode;
```

Crie `src/scheduler/quota-cli.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { formatQuotaReport, quotaReport } from './quota.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
try {
  for (const line of formatQuotaReport(quotaReport(store, new Date()))) console.log(line);
} finally {
  store.close();
}
```

Substitua o conteúdo de `src/main.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { fetchHttpClient, retryingClient } from './core/http.ts';
import { observedSources } from './scheduler/defaults.ts';
import { formatObserverEvent } from './scheduler/events.ts';
import { Observer } from './scheduler/observer.ts';
import { reconcileAfterSync } from './scheduler/reconcile-after-sync.ts';
import { openSqliteStore } from './store/sqlite-store.ts';
import { buildAdapters } from './sync/adapters.ts';
import { loadAdapterEnv } from './sync/config.ts';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);
const server = createHttpServer({ store, version: config.version });

const observerStop = new AbortController();
if (config.observer) {
  const sources = observedSources(buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) }));
  if (sources.length === 0) {
    console.warn('OBSERVER is on but no source is configured, so nothing will be watched');
  } else {
    const observer = new Observer({
      store,
      sources,
      reconcile: () => reconcileAfterSync(store),
      onEvent: (event) => {
        const line = formatObserverEvent(event);
        if (line) console.log(line);
      },
    });
    void observer.run(observerStop.signal);
    console.log(`observer on: ${sources.map((s) => s.adapter.id).join(', ')}`);
  }
}

server.on('error', (error) => {
  console.error(`server error: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`listening on :${config.port} (version ${config.version}, schema ${store.schemaVersion()})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  observerStop.abort();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

Em `package.json`, em `scripts`, depois de `reconcile`, acrescente:

```json
"refresh": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/scheduler/refresh-cli.ts",
"watch": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/scheduler/watch-cli.ts",
"quota": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/scheduler/quota-cli.ts"
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 216 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 6: Testar os comandos sem fontes configuradas**

Run:

```bash
env -i PATH="$PATH" DB_PATH=/tmp/gmf-e2.sqlite node --disable-warning=ExperimentalWarning src/scheduler/watch-cli.ts; echo "exit=$?"
env -i PATH="$PATH" DB_PATH=/tmp/gmf-e2.sqlite node --disable-warning=ExperimentalWarning src/scheduler/refresh-cli.ts; echo "exit=$?"
env -i PATH="$PATH" DB_PATH=/tmp/gmf-e2.sqlite node --disable-warning=ExperimentalWarning src/scheduler/refresh-cli.ts --bogus; echo "exit=$?"
env -i PATH="$PATH" DB_PATH=/tmp/gmf-e2.sqlite node --disable-warning=ExperimentalWarning src/scheduler/quota-cli.ts; echo "exit=$?"
rm -f /tmp/gmf-e2.sqlite /tmp/gmf-e2.sqlite-wal /tmp/gmf-e2.sqlite-shm
```

Expected, em ordem: `No source to watch. Set PIERRE_API_KEY and/or the PLUGGY_* variables.` com `exit=1`; `No source can refresh on demand. Set PIERRE_API_KEY.` com `exit=1`; `error: Unknown argument: --bogus` com `exit=2`; `No bank reads recorded this month.` com `exit=0`.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os arquivos novos e modificados desta tarefa.

---

### Task 7: Aceitação com os dados reais (depende de E-B e, para o passo 4, de E-C)

**Files:** nenhum arquivo do repositório.

**Interfaces:**
- Consumes: `data/gmf.sqlite` com as duas fontes sincronizadas e as chaves no `.env`.
- Produces: contagem de cota do mês e uma verificação do observador.

- [ ] **Step 1: Ver a cota antes**

Run: `npm run quota`
Expected: uma linha por instituição com `0/240` ou o que já tiver sido contado, e a nota de que a contagem é uma estimativa.

- [ ] **Step 2: Fazer uma verificação do observador**

Run: `npm run watch -- --once`
No sandbox do Claude Code, prefixe com `NODE_USE_ENV_PROXY=1`.
Expected: uma linha por fonte. `no new data` quando o horário não mudou desde a última leitura; `new data from ...` seguida de `read N accounts, ...` quando mudou (o observador lê a fonte e reconstrói os dados canônicos). Sem erros.

- [ ] **Step 3: Ver a cota depois**

Run: `npm run quota`
Expected: as contagens subiram 1 por instituição e por horário novo visto nas duas fontes; nenhuma instituição acima de 70%.

- [ ] **Step 4: Atualização manual (opcional, consome cota)**

Run: `npm run refresh`
No sandbox, prefixe com `NODE_USE_ENV_PROXY=1`.
Expected: `refresh requested for 5 institutions`, uma linha `<banco> updated after Ns` por banco (em geral de 30 a 65 segundos), depois `read N accounts, ...` e a tabela de cota com uma leitura a mais por banco. Uma segunda execução em menos de 15 minutos deve ser recusada com a razão `the last refresh was N minutes ago (minimum 15)` e `exit=1`.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `data/` não aparece, porque está no `.gitignore`.

---

## Fora deste plano

- Ligar o observador na VM (E-D): exige as chaves das fontes no Key Vault.
- Atualizações agendadas do Pierre: o design prevê que só entrem se a cadência medida pelo observador mostrar necessidade; os eventos de horário novo ficam registrados em `quota_events` para essa análise.
- Mostrar a idade do dado e o botão de atualizar na interface: Plano F.
- Compactação dos snapshots brutos: nenhum dos novos fluxos grava snapshots, então a retenção continua pendente só para as leituras completas.

## Auto-revisão contra o design

- Seção 5, observador, ingestão incremental, atualização manual com três travas, orçamento com 70% e 90%, aviso 423 e saúde das fontes: Tarefas 1 a 6. A ligação a uma atualização agendada do Pierre ficou fora, como previsto.
- Seção 5, "não gasta cota de banco": a verificação do observador usa só `fetchFreshness`, que lê a lista de contas do Pierre e os itens do Pluggy e não grava snapshot (Tarefa 2).
- Seção 6, tabelas `freshness`, `refresh_log` e `quota_events`: Tarefa 1.
- Seção 11 (erros): falhas de leitura repetidas na verificação seguinte, espera crescente, atualização nunca repetida (Tarefas 4 e 5).
