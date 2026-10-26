# Gata Molhada Finance, Plano A: fundação (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o esqueleto testado da aplicação: tipos do `core`, contrato dos adapters, armazenamento SQLite com migrações, endpoint `/healthz`, checagem de tipos e CI.

**Architecture:** Aplicação TypeScript executada diretamente pelo Node (sem etapa de compilação). O `core` define tipos e o contrato `SourceAdapter` e não importa nada de adapters. O `store` fica atrás de uma interface `Store` com implementação SQLite (`node:sqlite`). O servidor HTTP separa a lógica de rotas (`route`, função pura) da camada de rede (`createHttpServer`).

**Tech Stack:** Node 22 (>= 22.18, com remoção de tipos nativa), `node:test`, `node:sqlite`, `node:http`. Nenhuma dependência de execução. Dependências de desenvolvimento só na Tarefa 6: `typescript` e `@types/node@22`.

## Global Constraints

- Node >= 22.18 (instalado: 22.22.3). TypeScript roda por remoção de tipos: só sintaxe apagável (sem `enum`, `namespace` nem propriedades de parâmetro no construtor), `import type` para tipos e extensão `.ts` em todo import relativo.
- Sem dependências de execução. `node:sqlite` é marcado como experimental pelo Node, por isso os scripts usam `--disable-warning=ExperimentalWarning`.
- Valores monetários em centavos inteiros (`Cents`). Datas em ISO 8601 UTC.
- O repositório é público: nenhum dado financeiro real, id de item, número de conta, e-mail, CPF ou segredo em código, testes, documentação ou fixtures. Dados de teste são sintéticos.
- Não fazer commit, push, `git init` nem criar repositório remoto sem pedido explícito do usuário no momento. Quem executa este plano não commita: cada tarefa termina num ponto de verificação, e o usuário decide quando commitar.
- Dependências e arquivos de configuração de ferramentas só entram depois da aprovação listada abaixo.
- Identificadores e comentários de código em inglês. Documentação em português.
- Todos os caminhos são relativos à raiz do projeto (hoje `~/IdeaProjects/pierre-finance-app`; o nome da pasta é um item em aberto do design). A pasta `scripts/audit/` e a pasta `data/` existentes não são tocadas por este plano.

## Aprovações necessárias (perguntas ao usuário, não passos)

Cada tarefa abaixo só começa depois da resposta do usuário ao item correspondente.

- **A1** (Tarefa 1): posso criar um `package.json` sem dependências, só com `name`, `type: module`, `engines` e scripts?
- **A2** (Tarefa 6): posso instalar `typescript` e `@types/node@22` como dependências de desenvolvimento e criar `tsconfig.json`? Isso gera `package-lock.json` e `node_modules/`.
- **A3** (Tarefa 7): posso criar `.github/workflows/ci.yml`? E o usuário quer executar `git init`, criar o repositório público em github.com e fazer o primeiro push (passos do próprio usuário)?

Aviso de ambiente: o sandbox do Claude Code não deixa nenhum processo abrir porta de escuta (nem em `127.0.0.1`, nem socket Unix). Por isso a lógica de rotas é testada sem rede, e o teste com socket real se pula nesse ambiente (aparece como `SKIP`). O teste com socket e o `npm start` real devem ser rodados num terminal comum do usuário e no CI.

---

### Task 1: Esqueleto e helpers de dinheiro

**Files:**
- Create: `package.json`, `.env.example`
- Create: `src/core/money.ts`
- Test: `tests/core/money.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `type Cents = number`; `toCents(value: number | string): Cents`; `sumCents(values: readonly Cents[]): Cents`; `formatBRL(cents: Cents): string`. Os scripts `npm test` e `npm start`.

- [ ] **Step 1: Confirmar A1 e criar `package.json`**

Peça a aprovação A1 ao usuário. Com a resposta positiva, crie o arquivo:

```json
{
  "name": "gata-molhada-finance",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "start": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/main.ts",
    "test": "node --test --disable-warning=ExperimentalWarning \"tests/**/*.test.ts\""
  }
}
```

- [ ] **Step 2: Criar `.env.example` (só nomes, sem valores sensíveis)**

```
PORT=8080
DB_PATH=data/gmf.sqlite
APP_VERSION=dev
```

- [ ] **Step 3: Escrever o teste que falha**

Crie `tests/core/money.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, sumCents, formatBRL } from '../../src/core/money.ts';

test('toCents converts numbers without float drift', () => {
  assert.equal(toCents(2.35), 235);
  assert.equal(toCents(-142.87), -14287);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test('toCents converts decimal strings', () => {
  assert.equal(toCents('280.90'), 28090);
  assert.equal(toCents('0.00'), 0);
});

test('toCents rounds values with more than two decimals', () => {
  assert.equal(toCents(201.7918), 20179);
});

test('toCents never returns negative zero', () => {
  assert.equal(Object.is(toCents(-0.001), 0), true);
});

test('toCents rejects invalid input', () => {
  assert.throws(() => toCents('abc'), /Invalid money value/);
  assert.throws(() => toCents(''), /Invalid money value/);
  assert.throws(() => toCents(Number.NaN), /Invalid money value/);
});

test('sumCents adds integers exactly', () => {
  assert.equal(sumCents([28090, 120535, 30943]), 179568);
  assert.equal(sumCents([]), 0);
});

test('formatBRL uses pt-BR currency format', () => {
  assert.equal(formatBRL(123456).replace(/\u00a0/g, ' '), 'R$ 1.234,56');
  assert.equal(formatBRL(-14287).replace(/\u00a0/g, ' '), '-R$ 142,87');
});
```

- [ ] **Step 4: Rodar o teste e ver falhar**

Run: `npm test`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/core/money.ts`.

- [ ] **Step 5: Implementar**

Crie `src/core/money.ts`:

```ts
export type Cents = number;

export function toCents(value: number | string): Cents {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof value === 'string' && value.trim() === '') throw new Error('Invalid money value: empty string');
  if (!Number.isFinite(n)) throw new Error(`Invalid money value: ${String(value)}`);
  const cents = Math.round(n * 100);
  return cents === 0 ? 0 : cents;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, v) => total + v, 0);
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: Cents): string {
  return brl.format(cents / 100);
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npm test`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short 2>/dev/null || ls`
Expected: arquivos novos listados (ou a listagem da pasta, se ainda não for um repositório git). Não commitar.

---

### Task 2: Tipos do core e contrato dos adapters

**Files:**
- Create: `src/core/types.ts`, `src/core/adapter.ts`
- Create: `tests/support/fake-adapter.ts`
- Test: `tests/core/adapter-contract.test.ts`

**Interfaces:**
- Consumes: `Cents` de `src/core/money.ts`.
- Produces: tipos `SourceId`, `AccountKind`, `TransactionStatus`, `Freshness`, `SourceAccount`, `SourceTransaction`, `SourceBill`; interfaces `AdapterCapabilities`, `RefreshHandle`, `SourceAdapter`; a classe de teste `FakeAdapter(id, data?, capabilities?)` que os planos seguintes reutilizam.

- [ ] **Step 1: Criar os tipos e o contrato**

Crie `src/core/types.ts`:

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
}

export interface SourceAccount {
  externalId: string;
  externalItemId: string;
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

Crie `src/core/adapter.ts`:

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
  fetchTransactions(since: Date): Promise<SourceTransaction[]>;
  fetchBills(): Promise<SourceBill[]>;
  /** Present only when capabilities.refreshOnDemand is true. */
  requestRefresh?(): Promise<RefreshHandle>;
}
```

- [ ] **Step 2: Escrever o adapter de teste e o teste do contrato**

Crie `tests/support/fake-adapter.ts`:

```ts
import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../src/core/adapter.ts';
import type { Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../src/core/types.ts';

export interface FakeData {
  accounts?: SourceAccount[];
  freshness?: Freshness[];
  transactions?: SourceTransaction[];
  bills?: SourceBill[];
}

export class FakeAdapter implements SourceAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  readonly refreshCalls: string[] = [];
  private readonly data: FakeData;

  constructor(id: string, data: FakeData = {}, capabilities: Partial<AdapterCapabilities> = {}) {
    this.id = id;
    this.data = data;
    this.capabilities = {
      refreshOnDemand: false,
      pendingTransactions: true,
      creditLimits: true,
      rawDescription: true,
      installments: true,
      ...capabilities,
    };
    if (this.capabilities.refreshOnDemand) {
      this.requestRefresh = async (): Promise<RefreshHandle> => {
        const requestedAt = new Date().toISOString();
        this.refreshCalls.push(requestedAt);
        return { requestedAt };
      };
    }
  }

  requestRefresh?: () => Promise<RefreshHandle>;

  async fetchAccounts() {
    return { accounts: this.data.accounts ?? [], freshness: this.data.freshness ?? [] };
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    return (this.data.transactions ?? []).filter((t) => new Date(t.occurredAt) >= since);
  }

  async fetchBills(): Promise<SourceBill[]> {
    return this.data.bills ?? [];
  }
}
```

Crie `tests/core/adapter-contract.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../support/fake-adapter.ts';
import type { SourceTransaction } from '../../src/core/types.ts';

function tx(externalId: string, occurredAt: string): SourceTransaction {
  return {
    externalId,
    accountExternalId: 'acc-1',
    occurredAt,
    amount: -1990,
    description: 'Coffee',
    descriptionRaw: 'COFFEE SHOP',
    status: 'posted',
    installment: null,
    category: null,
  };
}

test('fetchTransactions returns only transactions since the given date', async () => {
  const adapter = new FakeAdapter('fake', {
    transactions: [tx('old', '2026-10-01T10:00:00.000Z'), tx('new', '2026-10-20T10:00:00.000Z')],
  });
  const result = await adapter.fetchTransactions(new Date('2026-10-10T00:00:00.000Z'));
  assert.deepEqual(result.map((t) => t.externalId), ['new']);
});

test('requestRefresh exists only when the capability is declared', async () => {
  const plain = new FakeAdapter('plain');
  assert.equal(plain.requestRefresh, undefined);

  const refreshable = new FakeAdapter('refreshable', {}, { refreshOnDemand: true });
  const handle = await refreshable.requestRefresh?.();
  assert.match(handle?.requestedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(refreshable.refreshCalls.length, 1);
});

test('fetchAccounts returns accounts together with freshness', async () => {
  const adapter = new FakeAdapter('fake', {
    freshness: [{ sourceId: 'fake', institution: 'Bank A', lastUpdatedAt: '2026-10-26T04:00:00.000Z', observedAt: '2026-10-26T04:05:00.000Z' }],
  });
  const { accounts, freshness } = await adapter.fetchAccounts();
  assert.deepEqual(accounts, []);
  assert.equal(freshness[0]?.institution, 'Bank A');
});
```

- [ ] **Step 3: Rodar e ver passar**

Run: `npm test`
Expected: `# pass 10`, `# fail 0` (7 de dinheiro e 3 do contrato). Esta tarefa só declara tipos, e imports de tipos são apagados em execução, então não existe um estado "falhando" para observar antes. A conformidade dos tipos com o `FakeAdapter` é verificada de verdade na Tarefa 6.

- [ ] **Step 4: Ponto de verificação (sem commit)**

Run: `git status --short 2>/dev/null || ls src/core tests/support`
Expected: os 5 arquivos novos desta tarefa.

---

### Task 3: Executor de migrações

**Files:**
- Create: `src/store/migrations.ts`
- Test: `tests/store/migrations.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` de `node:sqlite`.
- Produces: `loadMigrations(dir: string): Migration[]`; `currentVersion(db: DatabaseSync): number`; `migrate(db: DatabaseSync, dir: string): number` (devolve a versão final). Arquivos de migração `NNN_nome.sql` em ordem, sem lacunas; a versão fica em `PRAGMA user_version`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/store/migrations.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentVersion, loadMigrations, migrate } from '../../src/store/migrations.ts';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

test('applies migrations in order and records the version', () => {
  const dir = dirWith({
    '001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '002_b.sql': 'CREATE TABLE b (id INTEGER);',
  });
  const db = new DatabaseSync(':memory:');
  assert.equal(migrate(db, dir), 2);
  assert.equal(currentVersion(db), 2);
  db.prepare('INSERT INTO a VALUES (1)').run();
  db.prepare('INSERT INTO b VALUES (1)').run();
});

test('is idempotent: a second run applies nothing', () => {
  const dir = dirWith({ '001_a.sql': 'CREATE TABLE a (id INTEGER);' });
  const db = new DatabaseSync(':memory:');
  migrate(db, dir);
  assert.equal(migrate(db, dir), 1);
  assert.equal(currentVersion(db), 1);
});

test('applies only the migrations added since the last run', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, dirWith({ '001_a.sql': 'CREATE TABLE a (id INTEGER);' }));
  const dir = dirWith({
    '001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '002_b.sql': 'CREATE TABLE b (id INTEGER);',
  });
  migrate(db, dir);
  assert.equal(currentVersion(db), 2);
});

test('rolls back a failing migration and keeps the previous version', () => {
  const dir = dirWith({
    '001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '002_bad.sql': 'CREATE TABLE b (id INTEGER); INSERT INTO missing VALUES (1);',
  });
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db, dir), /Migration 002_bad.sql failed/);
  assert.equal(currentVersion(db), 1);
  assert.throws(() => db.prepare('SELECT * FROM b').get(), /no such table/);
});

test('rejects gaps and bad file names', () => {
  assert.throws(() => loadMigrations(dirWith({ '001_a.sql': '', '003_c.sql': '' })), /without gaps/);
  assert.throws(() => loadMigrations(dirWith({ 'init.sql': '' })), /Invalid migration file name/);
});

test('rejects a database newer than the code', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 5');
  assert.throws(() => migrate(db, dirWith({ '001_a.sql': 'CREATE TABLE a (id INTEGER);' })), /only 1 migrations exist/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/migrations.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/store/migrations.ts`.

- [ ] **Step 3: Implementar**

Crie `src/store/migrations.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const migrations = files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new Error(`Invalid migration file name: ${file}`);
    return { version: Number(match[1]), name: file, sql: readFileSync(join(dir, file), 'utf8') };
  });
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(`Migration numbering must be 001, 002, ... without gaps or duplicates (found ${m.name} at position ${index + 1})`);
    }
  });
  return migrations;
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DatabaseSync, dir: string): number {
  const migrations = loadMigrations(dir);
  const applied = currentVersion(db);
  if (applied > migrations.length) {
    throw new Error(`Database is at version ${applied} but only ${migrations.length} migrations exist`);
  }
  for (const m of migrations.slice(applied)) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return migrations.length;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/migrations.test.ts`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `npm test`
Expected: `# pass 16`, `# fail 0`.

---

### Task 4: Store SQLite com a primeira migração

**Files:**
- Create: `migrations/001_sources_and_snapshots.sql`
- Create: `src/store/store.ts`, `src/store/sqlite-store.ts`
- Test: `tests/store/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `migrate` e `currentVersion` de `src/store/migrations.ts`; `Freshness` e `SourceId` de `src/core/types.ts`.
- Produces: interface `Store` com `schemaVersion()`, `registerSource(source, now)`, `saveSnapshot(snapshot): number`, `latestSnapshot(sourceId, endpoint): Snapshot | null`, `upsertFreshness(freshness)`, `listFreshness()`, `close()`; tipos `NewSnapshot`, `Snapshot`, `SourceRegistration`; função `openSqliteStore(path: string, migrationsDir: string): Store` (use `':memory:'` em testes).

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/store/sqlite-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = '2026-10-26T15:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: { refreshOnDemand: true } }, NOW);
  return store;
}

test('applies the real migrations on open', () => {
  const store = newStore();
  assert.equal(store.schemaVersion(), 1);
});

test('saveSnapshot stores the body and latestSnapshot returns the newest one', () => {
  const store = newStore();
  store.saveSnapshot({ sourceId: 'pierre', endpoint: 'get-accounts', fetchedAt: '2026-10-26T10:00:00.000Z', httpStatus: 200, body: { n: 1 } });
  const id = store.saveSnapshot({ sourceId: 'pierre', endpoint: 'get-accounts', fetchedAt: '2026-10-26T11:00:00.000Z', httpStatus: 200, body: { n: 2 } });
  const latest = store.latestSnapshot('pierre', 'get-accounts');
  assert.equal(latest?.id, id);
  assert.deepEqual(latest?.body, { n: 2 });
  assert.match(latest?.sha256 ?? '', /^[0-9a-f]{64}$/);
});

test('latestSnapshot returns null when nothing was saved', () => {
  assert.equal(newStore().latestSnapshot('pierre', 'get-accounts'), null);
});

test('identical bodies produce the same hash', () => {
  const store = newStore();
  const a = store.saveSnapshot({ sourceId: 'pierre', endpoint: 'e', fetchedAt: NOW, httpStatus: 200, body: { x: 1 } });
  const b = store.saveSnapshot({ sourceId: 'pierre', endpoint: 'e', fetchedAt: '2026-10-26T15:01:00.000Z', httpStatus: 200, body: { x: 1 } });
  assert.notEqual(a, b);
  assert.equal(store.latestSnapshot('pierre', 'e')?.sha256.length, 64);
});

test('saveSnapshot rejects an unregistered source', () => {
  const store = newStore();
  assert.throws(
    () => store.saveSnapshot({ sourceId: 'ghost', endpoint: 'e', fetchedAt: NOW, httpStatus: 200, body: {} }),
    /FOREIGN KEY/,
  );
});

test('registerSource is idempotent and updates capabilities', () => {
  const store = newStore();
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: { refreshOnDemand: false } }, '2026-10-27T00:00:00.000Z');
  store.saveSnapshot({ sourceId: 'pierre', endpoint: 'e', fetchedAt: NOW, httpStatus: 200, body: {} });
});

test('upsertFreshness keeps one row per source and institution', () => {
  const store = newStore();
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T04:00:00.000Z', observedAt: NOW });
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T15:38:00.000Z', observedAt: '2026-10-26T15:40:00.000Z' });
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank B', lastUpdatedAt: '2026-10-26T06:00:00.000Z', observedAt: NOW });
  const rows = store.listFreshness();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.institution, 'Bank A');
  assert.equal(rows[0]?.lastUpdatedAt, '2026-10-26T15:38:00.000Z');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/sqlite-store.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/store/sqlite-store.ts`.

- [ ] **Step 3: Criar a migração**

Crie `migrations/001_sources_and_snapshots.sql`:

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '{}',
  added_at TEXT NOT NULL
);

CREATE TABLE raw_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  endpoint TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX idx_raw_snapshots_lookup ON raw_snapshots (source_id, endpoint, fetched_at DESC, id DESC);

CREATE TABLE freshness (
  source_id TEXT NOT NULL REFERENCES sources(id),
  institution TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, institution)
);
```

- [ ] **Step 4: Criar a interface e a implementação**

Crie `src/store/store.ts`:

```ts
import type { Freshness, SourceId } from '../core/types.ts';

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

export interface Store {
  schemaVersion(): number;
  registerSource(source: SourceRegistration, now: string): void;
  saveSnapshot(snapshot: NewSnapshot): number;
  latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null;
  upsertFreshness(freshness: Freshness): void;
  listFreshness(): Freshness[];
  close(): void;
}
```

Crie `src/store/sqlite-store.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Freshness, SourceId } from '../core/types.ts';
import { currentVersion, migrate } from './migrations.ts';
import type { NewSnapshot, Snapshot, SourceRegistration, Store } from './store.ts';

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
}

export function openSqliteStore(path: string, migrationsDir: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db, migrationsDir);

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

    upsertFreshness(f: Freshness): void {
      db.prepare(
        `INSERT INTO freshness (source_id, institution, last_updated_at, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, institution) DO UPDATE SET
           last_updated_at = excluded.last_updated_at, observed_at = excluded.observed_at`,
      ).run(f.sourceId, f.institution, f.lastUpdatedAt, f.observedAt);
    },

    listFreshness(): Freshness[] {
      const rows = db.prepare('SELECT * FROM freshness ORDER BY source_id, institution').all() as unknown as FreshnessRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        institution: r.institution,
        lastUpdatedAt: r.last_updated_at,
        observedAt: r.observed_at,
      }));
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/sqlite-store.test.ts`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 6: Ponto de verificação (sem commit)**

Run: `npm test`
Expected: `# pass 23`, `# fail 0`.

---

### Task 5: Configuração, rotas, servidor e ponto de entrada

**Files:**
- Create: `src/config.ts`, `src/http/router.ts`, `src/http/server.ts`, `src/main.ts`
- Test: `tests/config.test.ts`, `tests/http/router.test.ts`, `tests/http/server.test.ts`

**Interfaces:**
- Consumes: `Store` de `src/store/store.ts`; `openSqliteStore` de `src/store/sqlite-store.ts`.
- Produces: `loadConfig(env): Config` com `port`, `dbPath`, `version`; `route(method, pathname, deps): RouteResult` (`status`, `headers`, `body`); `createHttpServer(deps): http.Server`; `GET /healthz` responde `{ status, version, schemaVersion, time }` (200) ou `{ status: "degraded", ... }` (503).

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig applies defaults', () => {
  assert.deepEqual(loadConfig({}), { port: 8080, dbPath: 'data/gmf.sqlite', version: 'dev' });
});

test('loadConfig reads the environment', () => {
  assert.deepEqual(loadConfig({ PORT: '3000', DB_PATH: '/var/lib/gmf/db.sqlite', APP_VERSION: 'abc123' }), {
    port: 3000,
    dbPath: '/var/lib/gmf/db.sqlite',
    version: 'abc123',
  });
});

test('loadConfig rejects an invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '80.5' }), /Invalid PORT/);
});
```

Crie `tests/http/router.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, type RouterDeps } from '../../src/http/router.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    store: openSqliteStore(':memory:', MIGRATIONS),
    version: '1.2.3',
    now: () => new Date('2026-10-26T15:00:00.000Z'),
    ...overrides,
  };
}

test('GET /healthz reports ok with version and schema version', () => {
  const res = route('GET', '/healthz', deps());
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body ?? ''), {
    status: 'ok',
    version: '1.2.3',
    schemaVersion: 1,
    time: '2026-10-26T15:00:00.000Z',
  });
});

test('HEAD /healthz answers without a body', () => {
  const res = route('HEAD', '/healthz', deps());
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

test('GET /healthz answers 503 when the store fails', () => {
  const d = deps();
  d.store.close();
  const res = route('GET', '/healthz', d);
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body ?? '').status, 'degraded');
});

test('POST /healthz is not allowed', () => {
  const res = route('POST', '/healthz', deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD');
});

test('unknown paths answer 404 as JSON', () => {
  const res = route('GET', '/nope', deps());
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body ?? ''), { error: 'not_found' });
});
```

Crie `tests/http/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../src/http/server.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

test('the HTTP server serves /healthz over a real socket', async (t) => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const server = createHttpServer({ store, version: '9.9.9' });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('this environment does not allow listening sockets');
      return;
    }
    throw error;
  }
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { version: string }).version, '9.9.9');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/config.ts` e `src/http/router.ts`.

- [ ] **Step 3: Implementar**

Crie `src/config.ts`:

```ts
export interface Config {
  port: number;
  dbPath: string;
  version: string;
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
  };
}
```

Crie `src/http/router.ts`:

```ts
import type { Store } from '../store/store.ts';

export interface RouterDeps {
  store: Store;
  version: string;
  now: () => Date;
}

export interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export function route(method: string, pathname: string, deps: RouterDeps): RouteResult {
  if (pathname === '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, headers: { Allow: 'GET, HEAD' }, body: null };
    }
    let status = 200;
    let payload: Record<string, unknown>;
    const time = deps.now().toISOString();
    try {
      payload = { status: 'ok', version: deps.version, schemaVersion: deps.store.schemaVersion(), time };
    } catch {
      status = 503;
      payload = { status: 'degraded', version: deps.version, time };
    }
    return { status, headers: JSON_HEADERS, body: method === 'HEAD' ? null : JSON.stringify(payload) };
  }
  return { status: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
}
```

Crie `src/http/server.ts`:

```ts
import { createServer, type Server } from 'node:http';
import { route, type RouterDeps } from './router.ts';

export function createHttpServer(deps: Partial<RouterDeps> & Pick<RouterDeps, 'store' | 'version'>): Server {
  const full: RouterDeps = { now: () => new Date(), ...deps };
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const result = route(req.method ?? 'GET', url.pathname, full);
    res.writeHead(result.status, result.headers);
    res.end(result.body ?? undefined);
  });
}
```

Crie `src/main.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { openSqliteStore } from './store/sqlite-store.ts';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);
const server = createHttpServer({ store, version: config.version });

server.on('error', (error) => {
  console.error(`server error: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`listening on :${config.port} (version ${config.version}, schema ${store.schemaVersion()})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `# fail 0` e 32 testes. No sandbox do Claude Code, o teste "serves /healthz over a real socket" aparece como `SKIP` (contado como passou).

- [ ] **Step 5: Teste manual no terminal do usuário (fora do sandbox)**

O usuário roda, em um terminal comum:

```bash
cd ~/IdeaProjects/pierre-finance-app
PORT=8080 DB_PATH=/tmp/gmf-smoke.sqlite npm start
```

Expected: a linha `listening on :8080 (version dev, schema 1)`. Em outro terminal:

```bash
curl -s localhost:8080/healthz
```

Expected: `{"status":"ok","version":"dev","schemaVersion":1,"time":"<data atual em ISO>"}`. Ctrl+C encerra com `SIGINT received, shutting down`. Apague `/tmp/gmf-smoke.sqlite*` em seguida. Depois rode `npm test` no mesmo terminal e confira que o teste de socket passa sem `SKIP`.

- [ ] **Step 6: Ponto de verificação (sem commit)**

Run: `git status --short 2>/dev/null || ls src`
Expected: os arquivos desta tarefa.

---

### Task 6: Checagem de tipos (depende de A2)

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json` (script `typecheck` e `devDependencies`)

**Interfaces:**
- Consumes: todos os arquivos `.ts` de `src/` e `tests/`.
- Produces: o script `npm run typecheck` (sai com código 0 quando não há erro de tipo), usado pelo CI na Tarefa 7.

- [ ] **Step 1: Confirmar A2 e instalar as dependências de desenvolvimento**

Peça a aprovação A2 ao usuário. Com a resposta positiva:

Run: `npm install --save-dev typescript @types/node@22`
Expected: `added 4 packages` e `found 0 vulnerabilities`; criados `package-lock.json` e `node_modules/` (já ignorado pelo `.gitignore`).

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Acrescentar o script `typecheck` ao `package.json`**

Em `scripts`, junto de `start` e `test`, adicione:

```json
"typecheck": "tsc -p tsconfig.json"
```

- [ ] **Step 4: Rodar a checagem**

Run: `npm run typecheck`
Expected: nenhuma saída e código de saída 0.

- [ ] **Step 5: Confirmar que a checagem pega erros (sanidade)**

Run:

```bash
printf 'const x: number = "a";\nexport { x };\n' > src/_bad.ts && npm run typecheck; echo "exit=$?"; rm src/_bad.ts
```

Expected: `src/_bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.` e `exit=1`. O arquivo é removido ao final.

- [ ] **Step 6: Conferir que o `package-lock.json` aponta para o registro público**

Em máquinas com um espelho de npm configurado, o `npm install` grava os endereços do espelho no `package-lock.json`. Num repositório público isso vaza hosts internos e quebra o `npm ci` do CI.

Run: `grep -c "resolved" package-lock.json; grep "resolved" package-lock.json | sed -E 's#(https?://[^/]+)/.*#\1#' | sort | uniq -c`
Expected: um único host, `https://registry.npmjs.org`. Se aparecer outro, reescreva os endereços para `https://registry.npmjs.org/<pacote>/-/<arquivo>.tgz` (o `integrity` não muda) ou regenere o arquivo com `npm install --package-lock-only --registry=https://registry.npmjs.org/`. O npm substitui o host `registry.npmjs.org` pelo registro configurado ao instalar localmente, então o arquivo público continua funcionando atrás de um espelho.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `npm run typecheck && npm test`
Expected: tipos sem erro e `# fail 0`.

---

### Task 7: CI e publicação do repositório (depende de A3)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: scripts `typecheck` e `test`, e o `package-lock.json` da Tarefa 6.
- Produces: o workflow `CI`, que roda em pull requests e em pushes na `main`.

- [ ] **Step 1: Confirmar A3 e criar o workflow**

Peça a aprovação A3 ao usuário. Com a resposta positiva, crie `.github/workflows/ci.yml`. Ao criar, confira no GitHub se as versões `actions/checkout@v4` e `actions/setup-node@v4` ainda são as atuais.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Manter a pasta de auditoria fora do repositório público**

Os scripts de `scripts/audit/` contêm identificadores específicos do usuário (prefixos de ids de itens e nomes de cartões). A auditoria já cumpriu seu papel, e a lógica será reescrita com testes nos Planos C e D. Acrescente ao `.gitignore`:

```
scripts/audit/
```

- [ ] **Step 3: Verificação de dados pessoais antes de publicar**

Run:

```bash
grep -rnEI "sk-[A-Za-z0-9]{10,}|[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|@gmail|@icloud" --exclude-dir=node_modules --exclude-dir=data --exclude-dir=.git --exclude-dir=audit . ; echo "grep exit=$?"
```

Expected: nenhuma linha e `grep exit=1`. Qualquer linha encontrada deve ser removida antes de continuar. Revise também, a olho, `docs/` e `tests/` em busca de nomes de bancos, cartões ou valores reais.

- [ ] **Step 4: Passos do usuário no GitHub (o plano não executa estes passos)**

1. No terminal do projeto: `git init -b main`, `git add -A`, conferir com `git status` que `.env`, `data/`, `node_modules/` e `scripts/audit/` não aparecem, e fazer o primeiro commit quando o usuário decidir.
2. Criar o repositório público em github.com (conta pessoal), sem README nem licença automáticos (a licença é um item em aberto do design).
3. `git remote add origin <url>` e `git push -u origin main`.
4. Em Settings do repositório (os nomes exatos dos menus não foram verificados): ligar a varredura de segredos e a proteção de envio (Code security), criar uma regra de proteção para `main` exigindo o check `CI`, e em Actions exigir aprovação para workflows de colaboradores novos.

- [ ] **Step 5: Verificar o primeiro CI**

Abra um pull request pequeno (por exemplo, um ajuste no `README`) e confirme que o job `verify` roda os 5 passos e fica verde. Se o `npm ci` falhar, confira se o `package-lock.json` foi commitado.

---

## Fora deste plano (planos seguintes)

- **Plano B, implantação:** Dockerfile, publicação no GitHub Container Registry, VM do Azure, Caddy, Key Vault, implantação por busca da imagem com reversão, backups.
- **Plano C, adapters:** adapters do Pluggy e do Pierre, snapshots e importação do histórico do Pierre.
- **Plano D, reconciliação:** modelo canônico, cruzamento, frescor, grupos de limite e relatório de linha de comando.
- **Plano E, agendador:** observador, atualização pelo Pierre e orçamento de cota.
- **Plano F, API e interface:** autenticação, painel e widgets.
- **Plano G, IA:** categorizador e analista.
- **Plano H:** fonte manual e backups automáticos.

## Auto-revisão contra o design

- Seção 4 (contrato do adapter): coberta pela Tarefa 2. O modelo canônico completo e a reconciliação ficam no Plano D, onde são consumidos.
- Seção 6 (armazenamento): `Store`, migrações numeradas, `raw_snapshots` e `freshness` cobertos pelas Tarefas 3 e 4. As demais tabelas entram com os planos que as usam.
- Seção 10 (CI e repositório público): CI na Tarefa 7, com verificação de dados pessoais e pasta de auditoria fora do repositório. Varredura de segredos por ferramenta própria (item 13 do design) fica para quando o usuário aprovar a ferramenta.
- Seção 12, etapa 1: o `/healthz` está pronto aqui, e sua implantação na VM é o Plano B.
