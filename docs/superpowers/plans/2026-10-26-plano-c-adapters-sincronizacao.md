# Gata Molhada Finance, Plano C: adapters e sincronização (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ler contas, transações e faturas do Pierre e do Pluggy (MeuPluggy), normalizá-las para os tipos do `core`, e gravar tudo, junto com a resposta original de cada chamada, no SQLite, com um comando `npm run sync`.

**Architecture:** Cada fonte tem um adapter que implementa `SourceAdapter` e depende apenas de uma interface `HttpClient` e de um `SnapshotSink`, o que permite testar sem rede. Normalizadores são funções puras que validam o formato e convertem valores para centavos e para o sinal de fluxo de caixa. Um serviço `syncSource` grava os registros normalizados em tabelas `source_*` (um registro por fonte, sem mesclar) e a resposta bruta em `raw_snapshots`. A mesclagem entre fontes é o Plano D.

**Tech Stack:** Node 22 (`fetch`, `node:sqlite`, `node:test`), TypeScript por remoção de tipos. Nenhuma dependência nova.

## Global Constraints

- Node >= 22.18, TypeScript por remoção de tipos: só sintaxe apagável (sem `enum`, `namespace` nem propriedades de parâmetro no construtor), `import type` para tipos e extensão `.ts` em todo import relativo.
- Sem dependências de execução nem de desenvolvimento novas. Valores monetários em centavos inteiros. Datas em ISO 8601 UTC; datas sem hora no formato `YYYY-MM-DD`.
- Sinal de fluxo de caixa em todo valor de transação normalizado: dinheiro que sai é negativo. Contas correntes já vêm assim nas duas fontes (crédito positivo, débito negativo). Em cartões as duas fontes informam compra positiva e pagamento negativo, então o sinal é invertido. Verificado nos dados reais da auditoria.
- Credenciais e chaves de API nunca entram em `raw_snapshots`, em mensagens de erro, em testes nem em fixtures. A troca de credenciais do Pluggy (`POST /auth`) nunca é enviada ao `SnapshotSink`.
- Repositório público: fixtures e testes só têm dados sintéticos. Nenhum nome de banco, id de item, número de conta ou valor real em arquivos versionados.
- Leituras (`GET`) têm até 3 tentativas com espera crescente; `POST manual-update` nunca é repetido.
- Quem executa este plano não faz commit nem push sem pedido explícito do usuário. Cada tarefa termina num ponto de verificação. A `main` é protegida: o usuário decide como enviar o trabalho (branch e pull request).
- Identificadores e comentários em inglês. Documentação em português.
- Raiz do projeto: `~/IdeaProjects/pierre-finance-app`. Todos os caminhos são relativos a ela.

## Aprovações e decisões (perguntas ao usuário, não passos)

- **C1** (Tarefa 8): posso acrescentar o script `sync` ao `package.json` e as variáveis das fontes ao `.env.example`? Nenhuma dependência é instalada.
- **C2** (Tarefa 8): o usuário edita o próprio `.env`: troca `PLUGGY_ITEM_IDS` por `PLUGGY_ITEMS` com rótulos. Cada rótulo deve ser o nome da instituição como o Pierre a informa em `connectorName`, para o Plano D parear as duas fontes (o plano mostra como listar esses nomes).
- **C3** (Tarefa 8): posso rodar `npm run sync` com as chaves reais do `.env`, gravando só em `data/gmf.sqlite` (ignorado pelo git)? Isso faz chamadas somente de leitura ao Pierre e ao Pluggy e não gasta cota de atualização dos bancos.

Decisões de design tomadas neste plano (revisáveis antes de executar):

1. As tabelas novas se chamam `source_accounts`, `source_transactions` e `source_bills`, e guardam o que cada fonte diz, sem mesclar. O design chama a camada de transações por fonte de `transaction_source_records`; o Plano D constrói o modelo canônico sobre estas tabelas.
2. A "importação do histórico do Pierre" do design é a mesma sincronização com `--since` antigo, como `npm run sync -- --since 2025-10-26`. Não há comando separado.
3. O `get-accounts` do Pierre não traz limite de crédito nem final do cartão. O adapter lê o limite de `account_credit_data`, que vem em cada transação de cartão dos últimos 90 dias, usando a transação mais recente de cada conta. Cartão sem transação nesse período fica com limites nulos. O final do cartão (`last4`) do Pierre é sempre nulo.
4. O Pluggy (MeuPluggy) esconde o banco real atrás do conector `MeuPluggy`, então o nome da instituição é um rótulo informado pelo usuário em `PLUGGY_ITEMS=Rótulo:itemId,...`.
5. Tipos de conta que o `core` não modela (investimentos, por exemplo) são ignorados com um aviso no relatório da sincronização, em vez de derrubar a fonte inteira. Qualquer outra divergência de formato falha o passo e aparece em `errors`.
6. A sincronização roda os passos contas, transações e faturas em sequência. Um passo que falha é registrado em `errors` e não impede os seguintes.
7. A ligação entre a conta de uma fonte e a da outra (por nome, instituição e transações em comum) fica para o Plano D. Os registros do Pierre não têm id de item nas contas (`externalItemId` é nulo).

Aviso de ambiente: o sandbox do Claude Code não abre portas de escuta e só alcança hosts liberados no dashboard. Os testes deste plano não usam rede (`FakeHttp`). A sincronização real (Tarefa 8) precisa de `NODE_USE_ENV_PROXY=1` no sandbox, porque o `fetch` do Node ignora o proxy sem essa variável, e dos hosts `www.pierre.finance` e `api.pluggy.ai` liberados.

---

### Task 1: Camada HTTP, ajudantes de formato e sinal de fluxo de caixa

**Files:**
- Create: `src/core/http.ts`, `src/adapters/shape.ts`, `src/adapters/cash-flow.ts`
- Modify: `src/core/types.ts` (campo `externalItemId`), `src/core/adapter.ts` (método `drainWarnings`)
- Test: `tests/core/http.test.ts`, `tests/adapters/shape.test.ts`

**Interfaces:**
- Consumes: `Cents`/`toCents` de `src/core/money.ts`; `AccountKind` de `src/core/types.ts`.
- Produces: `interface HttpClient { request(method, url, options?): Promise<HttpResponse> }` com `HttpResponse { status: number; body: unknown }`; `type SnapshotSink = (s: { endpoint: string; httpStatus: number; body: unknown }) => void`; classes `SourceHttpError(status, url)` e `SourceFormatError(message)`; `fetchHttpClient(timeoutMs?)`; `retryingClient(inner, { attempts?, baseDelayMs?, sleep? })`; `asRecord`, `asArray`, `reqString`, `optString`, `reqNumber`, `optNumber`, `reqIsoInstant`, `optDay`, `class UnsupportedAccountError`; `toCashFlow(kind, amount): Cents`; `toStatus(value): 'pending' | 'posted' | null`; `SourceAccount.externalItemId` passa a `string | null`; `SourceAdapter.drainWarnings?(): string[]`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/core/http.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryingClient, SourceHttpError, type HttpClient } from '../../src/core/http.ts';

function scripted(responses: Array<number | Error>, calls: string[]): HttpClient {
  let index = 0;
  return {
    async request(method, url) {
      calls.push(`${method} ${url}`);
      const next = responses[Math.min(index++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { status: next as number, body: { ok: next === 200 } };
    },
  };
}

const noSleep = async () => {};

test('retries a GET on 503 and returns the first good answer', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([503, 503, 200], calls), { sleep: noSleep });
  const res = await client.request('GET', 'https://x.test/a');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});

test('returns the last response when every attempt fails with 5xx', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([500], calls), { attempts: 3, sleep: noSleep });
  const res = await client.request('GET', 'https://x.test/a');
  assert.equal(res.status, 500);
  assert.equal(calls.length, 3);
});

test('retries network errors and finally throws the last one', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([new Error('reset')], calls), { attempts: 2, sleep: noSleep });
  await assert.rejects(client.request('GET', 'https://x.test/a'), /reset/);
  assert.equal(calls.length, 2);
});

test('does not retry client errors', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([404], calls), { sleep: noSleep });
  const res = await client.request('GET', 'https://x.test/a');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

test('never retries non-GET requests', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([503, 200], calls), { sleep: noSleep });
  const res = await client.request('POST', 'https://x.test/refresh');
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

test('waits longer after each failed attempt', async () => {
  const waits: number[] = [];
  const client = retryingClient(scripted([500, 500, 200], []), {
    baseDelayMs: 100,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  await client.request('GET', 'https://x.test/a');
  assert.deepEqual(waits, [100, 200]);
});

test('SourceHttpError carries the status and url', () => {
  const error = new SourceHttpError(401, 'https://x.test/a');
  assert.equal(error.status, 401);
  assert.match(error.message, /HTTP 401/);
});
```

Crie `tests/adapters/shape.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCashFlow, toStatus } from '../../src/adapters/cash-flow.ts';
import { asRecord, optDay, optNumber, reqIsoInstant, reqNumber, reqString } from '../../src/adapters/shape.ts';
import { SourceFormatError } from '../../src/core/http.ts';

test('toCashFlow keeps the sign of bank amounts', () => {
  assert.equal(toCashFlow('checking', -142.87), -14287);
  assert.equal(toCashFlow('savings', 2.35), 235);
});

test('toCashFlow flips credit card amounts', () => {
  assert.equal(toCashFlow('credit_card', 49.9), -4990);
  assert.equal(toCashFlow('credit_card', -804.74), 80474);
  assert.equal(Object.is(toCashFlow('credit_card', 0), 0), true);
});

test('toStatus maps source statuses', () => {
  assert.equal(toStatus('POSTED'), 'posted');
  assert.equal(toStatus('PENDING'), 'pending');
  assert.equal(toStatus('CANCELLED'), null);
});

test('shape helpers read strings, numbers and dates', () => {
  const r = asRecord({ a: 'x', n: '12.5', m: 3, when: '2026-10-26T03:00:00.000Z', bad: 'nope' }, 'item');
  assert.equal(reqString(r, 'a', 'item'), 'x');
  assert.equal(reqNumber(r, 'n', 'item'), 12.5);
  assert.equal(optNumber(r, 'missing'), null);
  assert.equal(optNumber(r, 'm'), 3);
  assert.equal(reqIsoInstant(r, 'when', 'item'), '2026-10-26T03:00:00.000Z');
  assert.equal(optDay(r, 'when'), '2026-10-26');
  assert.equal(optDay(r, 'bad'), null);
});

test('shape helpers raise a format error that names the path', () => {
  const r = asRecord({ a: 1 }, 'item');
  assert.throws(() => reqString(r, 'a', 'item'), (e: Error) => e instanceof SourceFormatError && /item\.a/.test(e.message));
  assert.throws(() => reqNumber(r, 'zzz', 'item'), SourceFormatError);
  assert.throws(() => reqIsoInstant(asRecord({ d: 'not a date' }, 'x'), 'd', 'x'), /not a valid date/);
  assert.throws(() => asRecord([], 'item'), /expected an object/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/core/http.test.ts tests/adapters/shape.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/core/http.ts`.

- [ ] **Step 3: Criar a camada HTTP**

Crie `src/core/http.ts`:

```ts
export interface HttpRequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** Minimal HTTP surface the adapters depend on, so tests can replace the network. */
export interface HttpClient {
  request(method: string, url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

/** Receives every raw response an adapter gets, before any normalization. */
export type SnapshotSink = (snapshot: { endpoint: string; httpStatus: number; body: unknown }) => void;

export class SourceHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'SourceHttpError';
    this.status = status;
    this.url = url;
  }
}

/** The source answered, but not in the shape the adapter expects. */
export class SourceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFormatError';
  }
}

export function fetchHttpClient(timeoutMs = 60_000): HttpClient {
  return {
    async request(method, url, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      let body: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        // keep the raw text
      }
      return { status: response.status, body: parsed };
    },
  };
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries only GET requests, on network errors, 429 and 5xx, with growing waits.
 * Other methods (for example a refresh request) are sent exactly once.
 */
export function retryingClient(inner: HttpClient, options: RetryOptions = {}): HttpClient {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async request(method, url, requestOptions) {
      if (method !== 'GET') return inner.request(method, url, requestOptions);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const response = await inner.request(method, url, requestOptions);
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === attempts) return response;
        } catch (error) {
          lastError = error;
          if (attempt === attempts) throw error;
        }
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
      throw lastError;
    },
  };
}
```

Crie `src/adapters/shape.ts`:

```ts
import { SourceFormatError } from '../core/http.ts';

export type Json = Record<string, unknown>;

/** The account type is valid data we do not model (for example an investment account). */
export class UnsupportedAccountError extends SourceFormatError {}

export function asRecord(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SourceFormatError(`${path}: expected an object`);
  }
  return value as Json;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SourceFormatError(`${path}: expected an array`);
  return value;
}

export function reqString(record: Json, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new SourceFormatError(`${path}.${key}: expected a non-empty string`);
  return value;
}

export function optString(record: Json, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Accepts a number or a numeric string, as Pierre sends balances and bill totals as strings. */
export function reqNumber(record: Json, key: string, path: string): number {
  const value = record[key];
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new SourceFormatError(`${path}.${key}: expected a number`);
  return n;
}

export function optNumber(record: Json, key: string): number | null {
  const value = record[key];
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function reqIsoInstant(record: Json, key: string, path: string): string {
  const raw = reqString(record, key, path);
  const time = new Date(raw);
  if (Number.isNaN(time.getTime())) throw new SourceFormatError(`${path}.${key}: not a valid date`);
  return time.toISOString();
}

/** Date part (YYYY-MM-DD) of an ISO string, or null when absent or invalid. */
export function optDay(record: Json, key: string): string | null {
  const raw = optString(record, key);
  if (raw === null) return null;
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}
```

Crie `src/adapters/cash-flow.ts`:

```ts
import type { Cents } from '../core/money.ts';
import { toCents } from '../core/money.ts';
import type { AccountKind } from '../core/types.ts';

/**
 * Converts a source amount to cash-flow sign: money leaving the user is negative.
 * Bank accounts already use that sign. Credit cards report purchases as positive
 * and payments as negative, so they are flipped.
 */
export function toCashFlow(kind: AccountKind, amount: number): Cents {
  const cents = toCents(amount);
  if (kind !== 'credit_card') return cents;
  return cents === 0 ? 0 : -cents;
}

export function toStatus(value: string): 'pending' | 'posted' | null {
  if (value === 'POSTED') return 'posted';
  if (value === 'PENDING') return 'pending';
  return null;
}
```

- [ ] **Step 4: Ajustar os tipos do `core`**

Em `src/core/types.ts`, na interface `SourceAccount`, troque `externalItemId: string;` por:

```ts
  externalItemId: string | null;
```

Em `src/core/adapter.ts`, dentro de `SourceAdapter`, depois de `requestRefresh?(): Promise<RefreshHandle>;`, acrescente:

```ts
  /** Returns and clears notes about records the adapter skipped, for the sync report. */
  drainWarnings?(): string[];
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: `# fail 0` com 44 testes (32 anteriores mais 12) e `typecheck` sem erros.

- [ ] **Step 6: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 3 arquivos novos de `src/`, os 2 de `tests/` e as duas modificações.

---

### Task 2: Normalizadores do Pluggy

**Files:**
- Create: `src/adapters/pluggy/normalize.ts`
- Create: `tests/fixtures/pluggy.ts`
- Test: `tests/adapters/pluggy/normalize.test.ts`

**Interfaces:**
- Consumes: ajudantes da Tarefa 1; `AccountKind`, `SourceAccount`, `SourceBill`, `SourceTransaction`.
- Produces: `normalizeAccount(raw: unknown, institution: string): SourceAccount`; `normalizeTransaction(raw: unknown, kind: AccountKind): SourceTransaction`; `normalizeBill(raw: unknown, accountExternalId: string): SourceBill`. Fixtures sintéticas `pluggyBankAccount`, `pluggyCardAccount`, `pluggyBankCredit`, `pluggyCardPurchase`, `pluggyCardPayment`, `pluggyBill`, `pluggyItem`.

- [ ] **Step 1: Criar as fixtures e escrever o teste que falha**

Crie `tests/fixtures/pluggy.ts`:

```ts
// Synthetic payloads shaped like the Pluggy API responses. No real data.

export const pluggyBankAccount = {
  id: 'acc-bank-1',
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  name: 'Conta Corrente',
  balance: 1523.45,
  currencyCode: 'BRL',
  itemId: 'item-1',
  number: '12345-6',
  marketingName: null,
  bankData: { transferNumber: '0001/12345-6', closingBalance: 1523.45 },
  creditData: null,
};

export const pluggyCardAccount = {
  id: 'acc-card-1',
  type: 'CREDIT',
  subtype: 'CREDIT_CARD',
  name: 'Cartao Exemplo',
  balance: 320.5,
  currencyCode: 'BRL',
  itemId: 'item-1',
  number: '1234',
  creditData: {
    creditLimit: 5000,
    availableCreditLimit: 4679.5,
    minimumPayment: 48.0825,
    balanceDueDate: '2026-11-10T00:00:00.000Z',
    balanceCloseDate: null,
  },
};

export const pluggyBankCredit = {
  id: 'tx-1',
  description: 'Pix recebido',
  descriptionRaw: 'Transferencia recebida',
  amount: 150,
  date: '2026-10-20T12:00:00.000Z',
  category: 'Transfer',
  status: 'POSTED',
  type: 'CREDIT',
  accountId: 'acc-bank-1',
  creditCardMetadata: null,
};

export const pluggyCardPurchase = {
  id: 'tx-2',
  description: 'Loja Exemplo 2/5',
  descriptionRaw: 'LOJA EXEMPLO 02/05',
  amount: 99.9,
  date: '2026-10-21T03:00:00.000Z',
  category: 'Shopping',
  status: 'PENDING',
  type: 'DEBIT',
  accountId: 'acc-card-1',
  creditCardMetadata: { installmentNumber: 2, totalInstallments: 5, cardNumber: '1234' },
};

export const pluggyCardPayment = {
  id: 'tx-3',
  description: 'Pagamento recebido',
  descriptionRaw: 'PAGAMENTO RECEBIDO',
  amount: -320,
  date: '2026-10-15T03:00:00.000Z',
  category: null,
  status: 'POSTED',
  type: 'CREDIT',
  accountId: 'acc-card-1',
  creditCardMetadata: null,
};

export const pluggyBill = {
  id: 'bill-1',
  dueDate: '2026-11-10T00:00:00.000Z',
  billClosingDate: '2026-11-03T00:00:00.000Z',
  totalAmount: 320.5,
  totalAmountCurrencyCode: 'BRL',
  minimumPaymentAmount: 48.08,
};

export const pluggyItem = {
  id: 'item-1',
  status: 'UPDATED',
  lastUpdatedAt: '2026-10-26T14:53:55.112Z',
};
```

Crie `tests/adapters/pluggy/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccount, normalizeBill, normalizeTransaction } from '../../../src/adapters/pluggy/normalize.ts';
import { SourceFormatError } from '../../../src/core/http.ts';
import {
  pluggyBankAccount,
  pluggyBankCredit,
  pluggyBill,
  pluggyCardAccount,
  pluggyCardPayment,
  pluggyCardPurchase,
} from '../../fixtures/pluggy.ts';

test('normalizes a bank account', () => {
  assert.deepEqual(normalizeAccount(pluggyBankAccount, 'Bank A'), {
    externalId: 'acc-bank-1',
    externalItemId: 'item-1',
    institution: 'Bank A',
    kind: 'checking',
    name: 'Conta Corrente',
    last4: null,
    balance: 152345,
    creditLimit: null,
    availableLimit: null,
    minimumPayment: null,
    dueDate: null,
  });
});

test('normalizes a credit card account with limit data', () => {
  const account = normalizeAccount(pluggyCardAccount, 'Bank A');
  assert.equal(account.kind, 'credit_card');
  assert.equal(account.last4, '1234');
  assert.equal(account.balance, 32050);
  assert.equal(account.creditLimit, 500000);
  assert.equal(account.availableLimit, 467950);
  assert.equal(account.minimumPayment, 4808);
  assert.equal(account.dueDate, '2026-11-10');
});

test('rejects an unsupported account type', () => {
  const odd = { ...pluggyBankAccount, type: 'INVESTMENT', subtype: 'FUND' };
  assert.throws(() => normalizeAccount(odd, 'Bank A'), SourceFormatError);
});

test('keeps the sign of bank transactions', () => {
  const tx = normalizeTransaction(pluggyBankCredit, 'checking');
  assert.equal(tx.amount, 15000);
  assert.equal(tx.status, 'posted');
  assert.equal(tx.occurredAt, '2026-10-20T12:00:00.000Z');
  assert.equal(tx.descriptionRaw, 'Transferencia recebida');
  assert.equal(tx.installment, null);
});

test('flips credit card purchases and payments to cash-flow sign', () => {
  assert.equal(normalizeTransaction(pluggyCardPurchase, 'credit_card').amount, -9990);
  assert.equal(normalizeTransaction(pluggyCardPayment, 'credit_card').amount, 32000);
});

test('reads installment data and pending status from a card purchase', () => {
  const tx = normalizeTransaction(pluggyCardPurchase, 'credit_card');
  assert.equal(tx.status, 'pending');
  assert.deepEqual(tx.installment, { number: 2, total: 5 });
  assert.equal(tx.category, 'Shopping');
});

test('a missing category becomes null', () => {
  assert.equal(normalizeTransaction(pluggyCardPayment, 'credit_card').category, null);
});

test('rejects an unknown transaction status', () => {
  assert.throws(() => normalizeTransaction({ ...pluggyBankCredit, status: 'CANCELLED' }, 'checking'), /unsupported value CANCELLED/);
});

test('rejects a transaction without an id', () => {
  const { id: _id, ...rest } = pluggyBankCredit;
  assert.throws(() => normalizeTransaction(rest, 'checking'), /pluggy\.transaction\.id/);
});

test('normalizes a bill', () => {
  assert.deepEqual(normalizeBill(pluggyBill, 'acc-card-1'), {
    externalId: 'bill-1',
    accountExternalId: 'acc-card-1',
    dueDate: '2026-11-10',
    closingDate: '2026-11-03',
    total: 32050,
    minimumPayment: 4808,
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/adapters/pluggy/normalize.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/adapters/pluggy/normalize.ts`.

- [ ] **Step 3: Implementar**

Crie `src/adapters/pluggy/normalize.ts`:

```ts
import type { AccountKind, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { SourceFormatError } from '../../core/http.ts';
import { toCents } from '../../core/money.ts';
import { toCashFlow, toStatus } from '../cash-flow.ts';
import { asRecord, optDay, optNumber, optString, reqIsoInstant, reqNumber, reqString, UnsupportedAccountError } from '../shape.ts';

function kindOf(type: string, subtype: string, path: string): AccountKind {
  if (type === 'BANK' && subtype === 'CHECKING_ACCOUNT') return 'checking';
  if (type === 'BANK' && subtype === 'SAVINGS_ACCOUNT') return 'savings';
  if (type === 'CREDIT' && subtype === 'CREDIT_CARD') return 'credit_card';
  throw new UnsupportedAccountError(`${path}: unsupported account type ${type}/${subtype}`);
}

/** `institution` is the label the user gave the item, since MeuPluggy items hide the real bank name. */
export function normalizeAccount(raw: unknown, institution: string): SourceAccount {
  const path = 'pluggy.account';
  const r = asRecord(raw, path);
  const kind = kindOf(reqString(r, 'type', path), reqString(r, 'subtype', path), path);
  const credit = r.creditData === null || r.creditData === undefined ? null : asRecord(r.creditData, `${path}.creditData`);
  const limit = credit ? optNumber(credit, 'creditLimit') : null;
  const available = credit ? optNumber(credit, 'availableCreditLimit') : null;
  const minimum = credit ? optNumber(credit, 'minimumPayment') : null;

  return {
    externalId: reqString(r, 'id', path),
    externalItemId: optString(r, 'itemId'),
    institution,
    kind,
    name: reqString(r, 'name', path),
    last4: kind === 'credit_card' ? optString(r, 'number') : null,
    balance: toCents(reqNumber(r, 'balance', path)),
    creditLimit: limit === null ? null : toCents(limit),
    availableLimit: available === null ? null : toCents(available),
    minimumPayment: minimum === null ? null : toCents(minimum),
    dueDate: credit ? optDay(credit, 'balanceDueDate') : null,
  };
}

export function normalizeTransaction(raw: unknown, kind: AccountKind): SourceTransaction {
  const path = 'pluggy.transaction';
  const r = asRecord(raw, path);
  const rawStatus = reqString(r, 'status', path);
  const status = toStatus(rawStatus);
  if (status === null) throw new SourceFormatError(`${path}.status: unsupported value ${rawStatus}`);

  let installment: SourceTransaction['installment'] = null;
  if (r.creditCardMetadata !== null && r.creditCardMetadata !== undefined) {
    const meta = asRecord(r.creditCardMetadata, `${path}.creditCardMetadata`);
    const number = optNumber(meta, 'installmentNumber');
    const total = optNumber(meta, 'totalInstallments');
    if (number !== null && total !== null) installment = { number, total };
  }

  return {
    externalId: reqString(r, 'id', path),
    accountExternalId: reqString(r, 'accountId', path),
    occurredAt: reqIsoInstant(r, 'date', path),
    amount: toCashFlow(kind, reqNumber(r, 'amount', path)),
    description: reqString(r, 'description', path),
    descriptionRaw: optString(r, 'descriptionRaw'),
    status,
    installment,
    category: optString(r, 'category'),
  };
}

export function normalizeBill(raw: unknown, accountExternalId: string): SourceBill {
  const path = 'pluggy.bill';
  const r = asRecord(raw, path);
  const minimum = optNumber(r, 'minimumPaymentAmount');
  const dueDate = optDay(r, 'dueDate');
  if (dueDate === null) throw new SourceFormatError(`${path}.dueDate: expected a date`);
  return {
    externalId: reqString(r, 'id', path),
    accountExternalId,
    dueDate,
    closingDate: optDay(r, 'billClosingDate'),
    total: toCents(reqNumber(r, 'totalAmount', path)),
    minimumPayment: minimum === null ? null : toCents(minimum),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 54 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 3 arquivos novos desta tarefa.

---

### Task 3: Adapter do Pluggy

**Files:**
- Create: `src/adapters/pluggy/adapter.ts`
- Create: `tests/support/fake-http.ts`
- Test: `tests/adapters/pluggy/adapter.test.ts`

**Interfaces:**
- Consumes: `normalizeAccount`, `normalizeTransaction`, `normalizeBill`; `HttpClient`, `SnapshotSink`, `SourceHttpError`, `SourceFormatError`.
- Produces: `class PluggyAdapter implements SourceAdapter` com `new PluggyAdapter(config: PluggyConfig, deps: { http; sink; now?; baseUrl? })`; `interface PluggyConfig { clientId; clientSecret; items: { label; itemId }[] }`; `id === 'pluggy'`; helpers de teste `FakeHttp(routes)` com `.calls` e `.callsTo(method, fragment)`, e `ok(body)`.

- [ ] **Step 1: Criar o dublê de rede e escrever o teste que falha**

Crie `tests/support/fake-http.ts`:

```ts
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../src/core/http.ts';

export interface FakeRoute {
  method: string;
  /** Matched against the full URL: a string means "ends with", a RegExp is tested as is. */
  match: string | RegExp;
  respond: (url: string, options?: HttpRequestOptions) => HttpResponse;
}

export interface RecordedCall {
  method: string;
  url: string;
  options?: HttpRequestOptions;
}

/** Scripted network: routes are tried in order, and a request that matches none fails the test. */
export class FakeHttp implements HttpClient {
  readonly calls: RecordedCall[] = [];
  private readonly routes: FakeRoute[];

  constructor(routes: FakeRoute[]) {
    this.routes = routes;
  }

  async request(method: string, url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    this.calls.push({ method, url, options });
    const route = this.routes.find(
      (r) => r.method === method && (typeof r.match === 'string' ? url.endsWith(r.match) : r.match.test(url)),
    );
    if (!route) throw new Error(`FakeHttp: no route for ${method} ${url}`);
    return route.respond(url, options);
  }

  callsTo(method: string, fragment: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.url.includes(fragment));
  }
}

export function ok(body: unknown): HttpResponse {
  return { status: 200, body };
}
```

Crie `tests/adapters/pluggy/adapter.test.ts`:

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/adapters/pluggy/adapter.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/adapters/pluggy/adapter.ts`.

- [ ] **Step 3: Implementar**

Crie `src/adapters/pluggy/adapter.ts`:

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
      const itemBody = asRecord(await this.get(`/items/${item.itemId}`), 'pluggy.item');
      freshness.push({
        sourceId: this.id,
        institution: item.label,
        lastUpdatedAt: reqIsoInstant(itemBody, 'lastUpdatedAt', 'pluggy.item'),
        observedAt,
      });

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

  private async get(path: string): Promise<unknown> {
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
      this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
      if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
      return response.body;
    }
    throw new SourceHttpError(403, url);
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 63 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 3 arquivos novos desta tarefa.

---

### Task 4: Normalizadores do Pierre

**Files:**
- Create: `src/adapters/pierre/normalize.ts`
- Create: `tests/fixtures/pierre.ts`
- Test: `tests/adapters/pierre/normalize.test.ts`

**Interfaces:**
- Consumes: ajudantes da Tarefa 1.
- Produces: `kindOf(type, subtype, path): AccountKind`; `extractCardCredit(rawTransactions: unknown[]): Map<string, CardCredit>`; `normalizeAccount(raw, credit: CardCredit | undefined): SourceAccount`; `normalizeTransaction(raw): SourceTransaction`; `normalizeBill(raw): SourceBill`; `dataArray(body, path): unknown[]`; `interface CardCredit { creditLimit; availableLimit; minimumPayment: number | null; dueDate: string | null }`. Fixtures sintéticas `pierreBankAccount`, `pierreCardAccount`, `pierreWalletAccount`, `pierreBankCredit`, `pierreCardPurchase`, `pierreCardPayment`, `pierreBill`.

- [ ] **Step 1: Criar as fixtures e escrever o teste que falha**

Crie `tests/fixtures/pierre.ts`:

```ts
// Synthetic payloads shaped like the Pierre API responses. No real data.

export const pierreBankAccount = {
  id: 'p-acc-bank',
  name: 'Conta Corrente',
  customName: null,
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  balance: '1523.45',
  currencyCode: 'BRL',
  marketingName: null,
  connectorName: 'Bank A',
  itemLastUpdatedAt: '2026-10-26T13:34:07.676Z',
  itemIsActive: true,
};

export const pierreCardAccount = {
  id: 'p-acc-card',
  name: 'Cartao Exemplo',
  customName: null,
  type: 'CREDIT',
  subtype: 'CREDIT_CARD',
  balance: '320.50',
  currencyCode: 'BRL',
  marketingName: null,
  connectorName: 'Bank A',
  itemLastUpdatedAt: '2026-10-26T13:34:07.676Z',
  itemIsActive: true,
};

export const pierreWalletAccount = {
  id: 'p-acc-wallet',
  name: 'Carteira',
  customName: null,
  type: 'BANK',
  subtype: 'SAVINGS',
  balance: '0.00',
  currencyCode: 'BRL',
  marketingName: null,
  connectorName: null,
  itemLastUpdatedAt: '2026-09-13T14:41:41.675Z',
  itemIsActive: true,
};

export const pierreBankCredit = {
  id: 'p-tx-1',
  account_id: 'p-acc-bank',
  description: 'Pix recebido',
  original_description: 'Transferencia recebida',
  category: 'Transfer',
  currency_code: 'BRL',
  amount: 150,
  date: '2026-10-20T12:00:00.000Z',
  installment_due_date: '2026-10-20T12:00:00.000Z',
  type: 'CREDIT',
  status: 'POSTED',
  provider_id: 'prov-1',
  credit_card_data: null,
  account_credit_data: null,
  account_type: 'BANK',
  account_subtype: 'CHECKING_ACCOUNT',
  manual_transaction: false,
};

export const pierreCardPurchase = {
  id: 'p-tx-2',
  account_id: 'p-acc-card',
  description: 'Loja Exemplo 2/5',
  original_description: 'LOJA EXEMPLO 02/05',
  category: 'Shopping',
  currency_code: 'BRL',
  amount: 99.9,
  date: '2026-10-21T03:00:00.000Z',
  installment_due_date: '2026-11-21T03:00:00.000Z',
  type: 'DEBIT',
  status: 'PENDING',
  provider_id: null,
  credit_card_data: { installmentNumber: 2, totalInstallments: 5, billId: null },
  account_credit_data: {
    creditLimit: 5000,
    availableCreditLimit: 4679.5,
    minimumPayment: 48.08,
    balanceDueDate: '2026-11-10T00:00:00.000Z',
  },
  account_type: 'CREDIT',
  account_subtype: 'CREDIT_CARD',
  manual_transaction: false,
};

export const pierreCardPayment = {
  id: 'p-tx-3',
  account_id: 'p-acc-card',
  description: 'Pagamento recebido',
  original_description: 'PAGAMENTO RECEBIDO',
  category: null,
  currency_code: 'BRL',
  amount: -320,
  date: '2026-10-15T03:00:00.000Z',
  installment_due_date: '2026-10-15T03:00:00.000Z',
  type: 'CREDIT',
  status: 'POSTED',
  provider_id: null,
  credit_card_data: { installmentNumber: null, totalInstallments: null },
  account_credit_data: {
    creditLimit: 4000,
    availableCreditLimit: 3000,
    minimumPayment: 30,
    balanceDueDate: '2026-10-10T00:00:00.000Z',
  },
  account_type: 'CREDIT',
  account_subtype: 'CREDIT_CARD',
  manual_transaction: false,
};

export const pierreBill = {
  id: 'p-bill-1',
  userId: 'user-1',
  itemId: 'p-item-1',
  accountId: 'p-acc-card',
  dueDate: '2026-11-10T00:00:00.000Z',
  billClosingDate: '2026-11-03T00:00:00.000Z',
  totalAmount: '320.50',
  totalAmountCurrencyCode: 'BRL',
  minimumPaymentAmount: '48.08',
  allowsInstallments: true,
};
```

Crie `tests/adapters/pierre/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCardCredit,
  kindOf,
  normalizeAccount,
  normalizeBill,
  normalizeTransaction,
} from '../../../src/adapters/pierre/normalize.ts';
import { SourceFormatError } from '../../../src/core/http.ts';
import { UnsupportedAccountError } from '../../../src/adapters/shape.ts';
import {
  pierreBankAccount,
  pierreBankCredit,
  pierreBill,
  pierreCardAccount,
  pierreCardPayment,
  pierreCardPurchase,
  pierreWalletAccount,
} from '../../fixtures/pierre.ts';

test('maps account types, including the manual savings wallet', () => {
  assert.equal(kindOf('BANK', 'CHECKING_ACCOUNT', 'x'), 'checking');
  assert.equal(kindOf('BANK', 'SAVINGS', 'x'), 'savings');
  assert.equal(kindOf('BANK', 'SAVINGS_ACCOUNT', 'x'), 'savings');
  assert.equal(kindOf('CREDIT', 'CREDIT_CARD', 'x'), 'credit_card');
  assert.throws(() => kindOf('INVESTMENT', 'FUND', 'x'), UnsupportedAccountError);
});

test('normalizes a bank account with a balance sent as a string', () => {
  const account = normalizeAccount(pierreBankAccount, undefined);
  assert.equal(account.balance, 152345);
  assert.equal(account.institution, 'Bank A');
  assert.equal(account.kind, 'checking');
  assert.equal(account.externalItemId, null);
  assert.equal(account.creditLimit, null);
});

test('an account without a connector belongs to the Manual institution', () => {
  assert.equal(normalizeAccount(pierreWalletAccount, undefined).institution, 'Manual');
});

test('adds the card limit data that came from transactions', () => {
  const account = normalizeAccount(pierreCardAccount, {
    creditLimit: 5000,
    availableLimit: 4679.5,
    minimumPayment: 48.08,
    dueDate: '2026-11-10',
  });
  assert.equal(account.creditLimit, 500000);
  assert.equal(account.availableLimit, 467950);
  assert.equal(account.minimumPayment, 4808);
  assert.equal(account.dueDate, '2026-11-10');
  assert.equal(account.balance, 32050);
});

test('a card without limit data keeps the limits null', () => {
  const account = normalizeAccount(pierreCardAccount, undefined);
  assert.equal(account.creditLimit, null);
  assert.equal(account.availableLimit, null);
});

test('extractCardCredit takes the newest transaction of each account', () => {
  const credit = extractCardCredit([pierreCardPayment, pierreCardPurchase, pierreBankCredit]);
  assert.equal(credit.size, 1);
  assert.deepEqual(credit.get('p-acc-card'), {
    creditLimit: 5000,
    availableLimit: 4679.5,
    minimumPayment: 48.08,
    dueDate: '2026-11-10',
  });
});

test('flips card transactions and keeps bank transactions', () => {
  assert.equal(normalizeTransaction(pierreCardPurchase).amount, -9990);
  assert.equal(normalizeTransaction(pierreCardPayment).amount, 32000);
  assert.equal(normalizeTransaction(pierreBankCredit).amount, 15000);
});

test('reads installments, status and the original description', () => {
  const tx = normalizeTransaction(pierreCardPurchase);
  assert.deepEqual(tx.installment, { number: 2, total: 5 });
  assert.equal(tx.status, 'pending');
  assert.equal(tx.descriptionRaw, 'LOJA EXEMPLO 02/05');
  assert.equal(tx.accountExternalId, 'p-acc-card');
  assert.equal(normalizeTransaction(pierreCardPayment).installment, null);
});

test('rejects an unknown transaction status', () => {
  assert.throws(() => normalizeTransaction({ ...pierreBankCredit, status: 'VOID' }), SourceFormatError);
});

test('normalizes a bill whose amounts are strings', () => {
  assert.deepEqual(normalizeBill(pierreBill), {
    externalId: 'p-bill-1',
    accountExternalId: 'p-acc-card',
    dueDate: '2026-11-10',
    closingDate: '2026-11-03',
    total: 32050,
    minimumPayment: 4808,
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/adapters/pierre/normalize.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/adapters/pierre/normalize.ts`.

- [ ] **Step 3: Implementar**

Crie `src/adapters/pierre/normalize.ts`:

```ts
import type { AccountKind, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { SourceFormatError } from '../../core/http.ts';
import { toCents } from '../../core/money.ts';
import { toCashFlow, toStatus } from '../cash-flow.ts';
import {
  asArray,
  asRecord,
  optDay,
  optNumber,
  optString,
  reqIsoInstant,
  reqNumber,
  reqString,
  UnsupportedAccountError,
} from '../shape.ts';

export interface CardCredit {
  creditLimit: number | null;
  availableLimit: number | null;
  minimumPayment: number | null;
  dueDate: string | null;
}

export function kindOf(type: string, subtype: string, path: string): AccountKind {
  if (type === 'BANK' && subtype === 'CHECKING_ACCOUNT') return 'checking';
  if (type === 'BANK' && (subtype === 'SAVINGS_ACCOUNT' || subtype === 'SAVINGS')) return 'savings';
  if (type === 'CREDIT' && subtype === 'CREDIT_CARD') return 'credit_card';
  throw new UnsupportedAccountError(`${path}: unsupported account type ${type}/${subtype}`);
}

/**
 * Pierre's account list has no card limits, so they come from the credit data that
 * rides on every card transaction. The newest transaction of each account wins.
 */
export function extractCardCredit(rawTransactions: unknown[]): Map<string, CardCredit> {
  const newest = new Map<string, { date: string; credit: CardCredit }>();
  for (const raw of rawTransactions) {
    const r = asRecord(raw, 'pierre.transaction');
    if (r.account_credit_data === null || r.account_credit_data === undefined) continue;
    const data = asRecord(r.account_credit_data, 'pierre.transaction.account_credit_data');
    const accountId = reqString(r, 'account_id', 'pierre.transaction');
    const date = reqIsoInstant(r, 'date', 'pierre.transaction');
    const current = newest.get(accountId);
    if (current && current.date >= date) continue;
    newest.set(accountId, {
      date,
      credit: {
        creditLimit: optNumber(data, 'creditLimit'),
        availableLimit: optNumber(data, 'availableCreditLimit'),
        minimumPayment: optNumber(data, 'minimumPayment'),
        dueDate: optDay(data, 'balanceDueDate'),
      },
    });
  }
  return new Map([...newest].map(([accountId, value]) => [accountId, value.credit]));
}

const cents = (value: number | null) => (value === null ? null : toCents(value));

export function normalizeAccount(raw: unknown, credit: CardCredit | undefined): SourceAccount {
  const path = 'pierre.account';
  const r = asRecord(raw, path);
  const kind = kindOf(reqString(r, 'type', path), reqString(r, 'subtype', path), path);
  return {
    externalId: reqString(r, 'id', path),
    externalItemId: null,
    institution: optString(r, 'connectorName') ?? 'Manual',
    kind,
    name: reqString(r, 'name', path),
    last4: null,
    balance: toCents(reqNumber(r, 'balance', path)),
    creditLimit: kind === 'credit_card' ? cents(credit?.creditLimit ?? null) : null,
    availableLimit: kind === 'credit_card' ? cents(credit?.availableLimit ?? null) : null,
    minimumPayment: kind === 'credit_card' ? cents(credit?.minimumPayment ?? null) : null,
    dueDate: kind === 'credit_card' ? (credit?.dueDate ?? null) : null,
  };
}

export function normalizeTransaction(raw: unknown): SourceTransaction {
  const path = 'pierre.transaction';
  const r = asRecord(raw, path);
  const kind = kindOf(reqString(r, 'account_type', path), reqString(r, 'account_subtype', path), path);
  const rawStatus = reqString(r, 'status', path);
  const status = toStatus(rawStatus);
  if (status === null) throw new SourceFormatError(`${path}.status: unsupported value ${rawStatus}`);

  let installment: SourceTransaction['installment'] = null;
  if (r.credit_card_data !== null && r.credit_card_data !== undefined) {
    const meta = asRecord(r.credit_card_data, `${path}.credit_card_data`);
    const number = optNumber(meta, 'installmentNumber');
    const total = optNumber(meta, 'totalInstallments');
    if (number !== null && total !== null) installment = { number, total };
  }

  return {
    externalId: reqString(r, 'id', path),
    accountExternalId: reqString(r, 'account_id', path),
    occurredAt: reqIsoInstant(r, 'date', path),
    amount: toCashFlow(kind, reqNumber(r, 'amount', path)),
    description: reqString(r, 'description', path),
    descriptionRaw: optString(r, 'original_description'),
    status,
    installment,
    category: optString(r, 'category'),
  };
}

export function normalizeBill(raw: unknown): SourceBill {
  const path = 'pierre.bill';
  const r = asRecord(raw, path);
  const dueDate = optDay(r, 'dueDate');
  if (dueDate === null) throw new SourceFormatError(`${path}.dueDate: expected a date`);
  const minimum = optNumber(r, 'minimumPaymentAmount');
  return {
    externalId: reqString(r, 'id', path),
    accountExternalId: reqString(r, 'accountId', path),
    dueDate,
    closingDate: optDay(r, 'billClosingDate'),
    total: toCents(reqNumber(r, 'totalAmount', path)),
    minimumPayment: cents(minimum),
  };
}

export function dataArray(body: unknown, path: string): unknown[] {
  return asArray(asRecord(body, path).data, `${path}.data`);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 73 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 3 arquivos novos desta tarefa.

---

### Task 5: Adapter do Pierre

**Files:**
- Create: `src/adapters/pierre/adapter.ts`
- Test: `tests/adapters/pierre/adapter.test.ts`

**Interfaces:**
- Consumes: normalizadores da Tarefa 4; `FakeHttp` da Tarefa 3.
- Produces: `class PierreAdapter implements SourceAdapter` com `new PierreAdapter(config: { apiKey: string }, deps: { http; sink; now?; baseUrl? })`; `id === 'pierre'`; `capabilities.refreshOnDemand === true`; `requestRefresh()` faz um único `POST manual-update` e devolve `{ requestedAt }`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/adapters/pierre/adapter.test.ts`:

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/adapters/pierre/adapter.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/adapters/pierre/adapter.ts`.

- [ ] **Step 3: Implementar**

Crie `src/adapters/pierre/adapter.ts`:

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
    const freshness = new Map<string, Freshness>();
    const observedAt = this.now().toISOString();

    for (const raw of rawAccounts) {
      const record = asRecord(raw, 'pierre.account');
      try {
        const account = normalizeAccount(raw, credit.get(optString(record, 'id') ?? ''));
        accounts.push(account);
      } catch (error) {
        if (!(error instanceof UnsupportedAccountError)) throw error;
        this.warnings.push(`skipped an account (${error.message})`);
        continue;
      }
      const connector = optString(record, 'connectorName');
      if (connector !== null && !freshness.has(connector)) {
        freshness.set(connector, {
          sourceId: this.id,
          institution: connector,
          lastUpdatedAt: reqIsoInstant(record, 'itemLastUpdatedAt', 'pierre.account'),
          observedAt,
        });
      }
    }
    return { accounts, freshness: [...freshness.values()] };
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

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}/${path}`;
    const response = await this.http.request('GET', url, { headers: this.headers() });
    this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
    return response.body;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 83 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 2 arquivos novos desta tarefa.

---

### Task 6: Tabelas e métodos do Store para registros por fonte

**Files:**
- Create: `migrations/002_source_records.sql`
- Replace: `src/store/store.ts`, `src/store/sqlite-store.ts`
- Modify: `tests/store/sqlite-store.test.ts`, `tests/http/router.test.ts`
- Test: `tests/store/source-records.test.ts`

**Interfaces:**
- Consumes: `SourceAccount`, `SourceTransaction`, `SourceBill`, `SourceId`, `Freshness`.
- Produces: no `Store`, `upsertSourceAccounts/Transactions/Bills(sourceId, records, seenAt)` (idempotentes, em transação, mantêm `first_seen_at` e atualizam `last_seen_at`) e `listSourceAccounts/Transactions/Bills(sourceId)`; tipos `StoredSourceAccount`, `StoredSourceTransaction`, `StoredSourceBill` (registro da fonte mais `sourceId`, `firstSeenAt`, `lastSeenAt`). A versão do esquema passa a 2.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/store/source-records.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceBill, SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T1 = '2026-10-26T10:00:00.000Z';
const T2 = '2026-10-26T12:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T1);
  return store;
}

const account: SourceAccount = {
  externalId: 'acc-1',
  externalItemId: null,
  institution: 'Bank A',
  kind: 'credit_card',
  name: 'Cartao Exemplo',
  last4: '1234',
  balance: 32050,
  creditLimit: 500000,
  availableLimit: 467950,
  minimumPayment: 4808,
  dueDate: '2026-11-10',
};

const tx: SourceTransaction = {
  externalId: 'tx-1',
  accountExternalId: 'acc-1',
  occurredAt: '2026-10-21T03:00:00.000Z',
  amount: -9990,
  description: 'Loja Exemplo 2/5',
  descriptionRaw: 'LOJA EXEMPLO 02/05',
  status: 'pending',
  installment: { number: 2, total: 5 },
  category: 'Shopping',
};

const bill: SourceBill = {
  externalId: 'bill-1',
  accountExternalId: 'acc-1',
  dueDate: '2026-11-10',
  closingDate: '2026-11-03',
  total: 32050,
  minimumPayment: 4808,
};

test('stores and lists accounts with their seen timestamps', () => {
  const store = newStore();
  store.upsertSourceAccounts('pierre', [account], T1);
  assert.deepEqual(store.listSourceAccounts('pierre'), [{ ...account, sourceId: 'pierre', firstSeenAt: T1, lastSeenAt: T1 }]);
});

test('an upsert updates the values and last_seen_at but keeps first_seen_at', () => {
  const store = newStore();
  store.upsertSourceAccounts('pierre', [account], T1);
  store.upsertSourceAccounts('pierre', [{ ...account, balance: 50000, availableLimit: 450000 }], T2);
  const [stored] = store.listSourceAccounts('pierre');
  assert.equal(stored?.balance, 50000);
  assert.equal(stored?.availableLimit, 450000);
  assert.equal(stored?.firstSeenAt, T1);
  assert.equal(stored?.lastSeenAt, T2);
  assert.equal(store.listSourceAccounts('pierre').length, 1);
});

test('stores transactions with installments and nulls', () => {
  const store = newStore();
  const plain: SourceTransaction = { ...tx, externalId: 'tx-2', installment: null, descriptionRaw: null, category: null };
  store.upsertSourceTransactions('pierre', [tx, plain], T1);
  const stored = store.listSourceTransactions('pierre');
  assert.equal(stored.length, 2);
  const byId = Object.fromEntries(stored.map((s) => [s.externalId, s]));
  assert.deepEqual(byId['tx-1']?.installment, { number: 2, total: 5 });
  assert.equal(byId['tx-2']?.installment, null);
  assert.equal(byId['tx-2']?.descriptionRaw, null);
});

test('a pending transaction can later be confirmed by an upsert', () => {
  const store = newStore();
  store.upsertSourceTransactions('pierre', [tx], T1);
  store.upsertSourceTransactions('pierre', [{ ...tx, status: 'posted' }], T2);
  const [stored] = store.listSourceTransactions('pierre');
  assert.equal(stored?.status, 'posted');
  assert.equal(stored?.firstSeenAt, T1);
});

test('stores bills', () => {
  const store = newStore();
  store.upsertSourceBills('pierre', [bill], T1);
  assert.deepEqual(store.listSourceBills('pierre'), [{ ...bill, sourceId: 'pierre', firstSeenAt: T1, lastSeenAt: T1 }]);
});

test('records of different sources do not mix', () => {
  const store = newStore();
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T1);
  store.upsertSourceTransactions('pierre', [tx], T1);
  store.upsertSourceTransactions('pluggy', [{ ...tx, amount: -1 }], T1);
  assert.equal(store.listSourceTransactions('pierre')[0]?.amount, -9990);
  assert.equal(store.listSourceTransactions('pluggy')[0]?.amount, -1);
});

test('rejects records of an unregistered source', () => {
  const store = newStore();
  assert.throws(() => store.upsertSourceTransactions('ghost', [tx], T1), /FOREIGN KEY/);
});

test('a failing batch is rolled back as a whole', () => {
  const store = newStore();
  const broken = { ...tx, externalId: 'tx-bad', description: null } as unknown as SourceTransaction;
  assert.throws(() => store.upsertSourceTransactions('pierre', [tx, broken], T1), /NOT NULL/);
  assert.deepEqual(store.listSourceTransactions('pierre'), []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/source-records.test.ts`
Expected: FAIL com `TypeError: store.upsertSourceAccounts is not a function`.

- [ ] **Step 3: Criar a migração**

Crie `migrations/002_source_records.sql`:

```sql
-- Normalized records as each source reports them. The canonical, reconciled
-- model is built on top of these tables, so nothing here is merged across sources.

CREATE TABLE source_accounts (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  external_item_id TEXT,
  institution TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  last4 TEXT,
  balance INTEGER NOT NULL,
  credit_limit INTEGER,
  available_limit INTEGER,
  minimum_payment INTEGER,
  due_date TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE TABLE source_transactions (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  description_raw TEXT,
  status TEXT NOT NULL,
  installment_number INTEGER,
  installment_total INTEGER,
  category TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX idx_source_transactions_account
  ON source_transactions (source_id, account_external_id, occurred_at);

CREATE TABLE source_bills (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  due_date TEXT NOT NULL,
  closing_date TEXT,
  total INTEGER NOT NULL,
  minimum_payment INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
```

- [ ] **Step 4: Substituir a interface e a implementação do Store**

Substitua o conteúdo de `src/store/store.ts`:

```ts
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

export interface Store {
  schemaVersion(): number;
  registerSource(source: SourceRegistration, now: string): void;
  saveSnapshot(snapshot: NewSnapshot): number;
  latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null;
  upsertFreshness(freshness: Freshness): void;
  listFreshness(): Freshness[];
  /** Inserts new records and refreshes existing ones; first_seen_at is kept, last_seen_at becomes seenAt. */
  upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void;
  upsertSourceTransactions(sourceId: SourceId, transactions: SourceTransaction[], seenAt: string): void;
  upsertSourceBills(sourceId: SourceId, bills: SourceBill[], seenAt: string): void;
  listSourceAccounts(sourceId: SourceId): StoredSourceAccount[];
  listSourceTransactions(sourceId: SourceId): StoredSourceTransaction[];
  listSourceBills(sourceId: SourceId): StoredSourceBill[];
  close(): void;
}
```

Substitua o conteúdo de `src/store/sqlite-store.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountKind, Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction, TransactionStatus } from '../core/types.ts';
import { currentVersion, migrate } from './migrations.ts';
import type {
  NewSnapshot,
  Snapshot,
  SourceRegistration,
  Store,
  StoredSourceAccount,
  StoredSourceBill,
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

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Atualizar a versão do esquema nos testes existentes**

Em `tests/store/sqlite-store.test.ts`, no teste `applies the real migrations on open`, troque `assert.equal(store.schemaVersion(), 1);` por `assert.equal(store.schemaVersion(), 2);`.

Em `tests/http/router.test.ts`, no teste `GET /healthz reports ok with version and schema version`, troque `schemaVersion: 1,` por `schemaVersion: 2,`.

- [ ] **Step 6: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 91 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: a migração, os dois arquivos de `src/store/` modificados, os dois testes ajustados e o teste novo.

---

### Task 7: Serviço de sincronização, configuração e linha de comando

**Files:**
- Create: `src/sync/sync.ts`, `src/sync/config.ts`, `src/sync/adapters.ts`, `src/sync/args.ts`, `src/sync/cli.ts`
- Test: `tests/sync/sync.test.ts`, `tests/sync/config.test.ts`, `tests/sync/e2e.test.ts`

**Interfaces:**
- Consumes: `PierreAdapter`, `PluggyAdapter`, `Store`, `retryingClient`, `fetchHttpClient`, `loadConfig` de `src/config.ts`.
- Produces: `syncSource(adapter, { store, now? }, since: Date): Promise<SyncResult>` com `SyncResult { sourceId; accounts; transactions; bills; freshness; warnings; errors }`; `createSnapshotSink(store, sourceId, now?)`; `registerAdapter(adapter, store, now)`; `buildAdapters(env: AdapterEnv, { store, http, now? }): SourceAdapter[]` (o único lugar que conhece os adapters existentes); `loadAdapterEnv(env)`, `parsePluggyItems(value)`; `parseSyncArgs(argv, now)`; o ponto de entrada `src/sync/cli.ts` (códigos de saída: 0 sucesso, 1 falha de passo ou nenhuma fonte, 2 argumento ou configuração inválidos).

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/sync/sync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FakeAdapter } from '../support/fake-adapter.ts';
import { createSnapshotSink, registerAdapter, syncSource } from '../../src/sync/sync.ts';
import { SourceHttpError } from '../../src/core/http.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T15:00:00.000Z');
const SINCE = new Date('2026-08-01T00:00:00.000Z');

const account: SourceAccount = {
  externalId: 'acc-1',
  externalItemId: null,
  institution: 'Bank A',
  kind: 'checking',
  name: 'Conta Corrente',
  last4: null,
  balance: 152345,
  creditLimit: null,
  availableLimit: null,
  minimumPayment: null,
  dueDate: null,
};

const tx = (id: string, occurredAt: string): SourceTransaction => ({
  externalId: id,
  accountExternalId: 'acc-1',
  occurredAt,
  amount: -1990,
  description: 'Coffee',
  descriptionRaw: null,
  status: 'posted',
  installment: null,
  category: null,
});

class FailingBills extends FakeAdapter {
  override async fetchBills(): Promise<never> {
    throw new SourceHttpError(500, 'https://x.test/bills?token=secret');
  }
}

class WarningAdapter extends FakeAdapter {
  drainWarnings(): string[] {
    return ['skipped one account'];
  }
}

function setup() {
  return openSqliteStore(':memory:', MIGRATIONS);
}

test('stores accounts, transactions, bills and freshness from a source', async () => {
  const store = setup();
  const adapter = new FakeAdapter('fake', {
    accounts: [account],
    freshness: [{ sourceId: 'fake', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:00:00.000Z', observedAt: NOW.toISOString() }],
    transactions: [tx('t1', '2026-09-01T10:00:00.000Z'), tx('t2', '2026-07-01T10:00:00.000Z')],
    bills: [{ externalId: 'b1', accountExternalId: 'acc-1', dueDate: '2026-11-10', closingDate: null, total: 1000, minimumPayment: null }],
  });
  const result = await syncSource(adapter, { store, now: () => NOW }, SINCE);
  assert.deepEqual(result, {
    sourceId: 'fake',
    accounts: 1,
    transactions: 1,
    bills: 1,
    freshness: 1,
    warnings: [],
    errors: [],
  });
  assert.equal(store.listSourceTransactions('fake').length, 1);
  assert.equal(store.listFreshness()[0]?.institution, 'Bank A');
});

test('running the sync twice does not duplicate records', async () => {
  const store = setup();
  const adapter = new FakeAdapter('fake', { accounts: [account], transactions: [tx('t1', '2026-09-01T10:00:00.000Z')] });
  await syncSource(adapter, { store, now: () => NOW }, SINCE);
  await syncSource(adapter, { store, now: () => new Date('2026-10-26T16:00:00.000Z') }, SINCE);
  assert.equal(store.listSourceAccounts('fake').length, 1);
  const [stored] = store.listSourceTransactions('fake');
  assert.equal(store.listSourceTransactions('fake').length, 1);
  assert.equal(stored?.firstSeenAt, NOW.toISOString());
  assert.equal(stored?.lastSeenAt, '2026-10-26T16:00:00.000Z');
});

test('a failing step is reported without a url query and does not stop the others', async () => {
  const store = setup();
  const adapter = new FailingBills('fake', { accounts: [account], transactions: [tx('t1', '2026-09-01T10:00:00.000Z')] });
  const result = await syncSource(adapter, { store, now: () => NOW }, SINCE);
  assert.equal(result.accounts, 1);
  assert.equal(result.transactions, 1);
  assert.deepEqual(result.errors, ['bills: HTTP 500 from https://x.test/bills']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('adapter warnings are included in the result', async () => {
  const store = setup();
  const result = await syncSource(new WarningAdapter('fake'), { store, now: () => NOW }, SINCE);
  assert.deepEqual(result.warnings, ['skipped one account']);
});

test('the snapshot sink stores each raw response under the source', () => {
  const store = setup();
  registerAdapter(new FakeAdapter('fake'), store, NOW);
  const sink = createSnapshotSink(store, 'fake', () => NOW);
  sink({ endpoint: 'get-accounts', httpStatus: 200, body: { data: [] } });
  const snapshot = store.latestSnapshot('fake', 'get-accounts');
  assert.equal(snapshot?.fetchedAt, NOW.toISOString());
  assert.deepEqual(snapshot?.body, { data: [] });
});

test('registerAdapter records the declared capabilities and is repeatable', () => {
  const store = setup();
  const adapter = new FakeAdapter('fake', {}, { refreshOnDemand: true });
  registerAdapter(adapter, store, NOW);
  registerAdapter(adapter, store, NOW);
  store.saveSnapshot({ sourceId: 'fake', endpoint: 'e', fetchedAt: NOW.toISOString(), httpStatus: 200, body: {} });
});
```

Crie `tests/sync/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterEnv, parsePluggyItems } from '../../src/sync/config.ts';
import { parseSyncArgs } from '../../src/sync/args.ts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

test('parsePluggyItems reads labels with spaces and accents', () => {
  assert.deepEqual(parsePluggyItems(`Banco A:${UUID_A}, Crédito Ágil :${UUID_B}`), [
    { label: 'Banco A', itemId: UUID_A },
    { label: 'Crédito Ágil', itemId: UUID_B },
  ]);
});

test('parsePluggyItems rejects malformed and duplicate entries', () => {
  assert.throws(() => parsePluggyItems(UUID_A), /expected Label:itemId/);
  assert.throws(() => parsePluggyItems(`:${UUID_A}`), /expected Label:itemId/);
  assert.throws(() => parsePluggyItems('Banco A:'), /expected Label:itemId/);
  assert.throws(() => parsePluggyItems(`A:${UUID_A},B:${UUID_A}`), /duplicate item id/);
  assert.throws(() => parsePluggyItems(' , '), /no items/);
});

test('loadAdapterEnv enables only the configured sources', () => {
  assert.deepEqual(loadAdapterEnv({}), {});
  assert.deepEqual(loadAdapterEnv({ PIERRE_API_KEY: ' sk-1 ' }), { pierre: { apiKey: 'sk-1' } });
  const both = loadAdapterEnv({
    PIERRE_API_KEY: 'sk-1',
    PLUGGY_CLIENT_ID: 'cid',
    PLUGGY_CLIENT_SECRET: 'sec',
    PLUGGY_ITEMS: `Banco A:${UUID_A}`,
  });
  assert.equal(both.pluggy?.items[0]?.label, 'Banco A');
  assert.equal(both.pluggy?.clientId, 'cid');
});

test('loadAdapterEnv treats empty values as missing', () => {
  assert.deepEqual(loadAdapterEnv({ PIERRE_API_KEY: '', PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '', PLUGGY_ITEMS: '' }), {});
});

test('loadAdapterEnv refuses a partial Pluggy configuration', () => {
  assert.throws(() => loadAdapterEnv({ PLUGGY_CLIENT_ID: 'cid' }), /PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET and PLUGGY_ITEMS together/);
});

test('parseSyncArgs defaults to the last 90 days and every source', () => {
  const args = parseSyncArgs([], new Date('2026-10-26T15:00:00.000Z'));
  assert.equal(args.since.toISOString(), '2026-07-28T15:00:00.000Z');
  assert.equal(args.source, null);
});

test('parseSyncArgs reads --since and --source', () => {
  const args = parseSyncArgs(['--since', '2025-10-26', '--source', 'pluggy'], new Date('2026-10-26T15:00:00.000Z'));
  assert.equal(args.since.toISOString(), '2025-10-26T00:00:00.000Z');
  assert.equal(args.source, 'pluggy');
});

test('parseSyncArgs rejects bad input', () => {
  const now = new Date('2026-10-26T15:00:00.000Z');
  assert.throws(() => parseSyncArgs(['--since'], now), /--since expects/);
  assert.throws(() => parseSyncArgs(['--since', '26/10/2026'], now), /--since expects/);
  assert.throws(() => parseSyncArgs(['--since', '2026-13-45'], now), /--since expects/);
  assert.throws(() => parseSyncArgs(['--source'], now), /--source expects/);
  assert.throws(() => parseSyncArgs(['--bogus'], now), /Unknown argument/);
});
```

Crie `tests/sync/e2e.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildAdapters } from '../../src/sync/adapters.ts';
import { syncSource } from '../../src/sync/sync.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { FakeHttp, ok } from '../support/fake-http.ts';
import {
  pierreBankAccount,
  pierreBankCredit,
  pierreBill,
  pierreCardAccount,
  pierreCardPurchase,
} from '../fixtures/pierre.ts';
import {
  pluggyBankAccount,
  pluggyBankCredit,
  pluggyBill,
  pluggyCardAccount,
  pluggyCardPurchase,
  pluggyItem,
} from '../fixtures/pluggy.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T15:00:00.000Z');
const SINCE = new Date('2026-08-01T00:00:00.000Z');

function network() {
  return new FakeHttp([
    { method: 'GET', match: '/get-accounts', respond: () => ok({ data: [pierreBankAccount, pierreCardAccount] }) },
    { method: 'GET', match: /\/get-transactions\?/, respond: () => ok({ data: [pierreBankCredit, pierreCardPurchase] }) },
    { method: 'GET', match: '/get-bills', respond: () => ok({ data: [pierreBill] }) },
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: 'key-1' }) },
    { method: 'GET', match: '/items/item-1', respond: () => ok(pluggyItem) },
    { method: 'GET', match: /\/accounts\?itemId=item-1$/, respond: () => ok({ results: [pluggyBankAccount, pluggyCardAccount] }) },
    { method: 'GET', match: /\/v2\/transactions\?accountId=acc-bank-1/, respond: () => ok({ results: [pluggyBankCredit], next: null }) },
    { method: 'GET', match: /\/v2\/transactions\?accountId=acc-card-1/, respond: () => ok({ results: [pluggyCardPurchase], next: null }) },
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=1$/, respond: () => ok({ page: 1, totalPages: 1, results: [pluggyBill] }) },
  ]);
}

test('syncs both sources end to end into the store', async () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapters = buildAdapters(
    {
      pierre: { apiKey: 'sk-test' },
      pluggy: { clientId: 'cid', clientSecret: 'sec', items: [{ label: 'Bank A', itemId: 'item-1' }] },
    },
    { store, http: network(), now: () => NOW },
  );
  assert.deepEqual(adapters.map((a) => a.id), ['pierre', 'pluggy']);

  const results = [];
  for (const adapter of adapters) results.push(await syncSource(adapter, { store, now: () => NOW }, SINCE));

  assert.deepEqual(results.map((r) => [r.sourceId, r.accounts, r.transactions, r.bills, r.errors.length]), [
    ['pierre', 2, 2, 1, 0],
    ['pluggy', 2, 2, 1, 0],
  ]);
  assert.equal(store.listSourceTransactions('pierre').length, 2);
  assert.equal(store.listSourceTransactions('pluggy').length, 2);
  assert.deepEqual(store.listFreshness().map((f) => [f.sourceId, f.institution]), [
    ['pierre', 'Bank A'],
    ['pluggy', 'Bank A'],
  ]);
  assert.ok(store.latestSnapshot('pluggy', '/items/item-1'));
  assert.ok(store.latestSnapshot('pierre', 'get-bills'));
});

test('the same purchase from both sources has the same cash-flow amount', async () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapters = buildAdapters(
    { pierre: { apiKey: 'sk-test' }, pluggy: { clientId: 'cid', clientSecret: 'sec', items: [{ label: 'Bank A', itemId: 'item-1' }] } },
    { store, http: network(), now: () => NOW },
  );
  for (const adapter of adapters) await syncSource(adapter, { store, now: () => NOW }, SINCE);
  const pierre = store.listSourceTransactions('pierre').find((t) => t.externalId === 'p-tx-2');
  const pluggy = store.listSourceTransactions('pluggy').find((t) => t.externalId === 'tx-2');
  assert.equal(pierre?.amount, -9990);
  assert.equal(pluggy?.amount, -9990);
  assert.equal(pierre?.occurredAt, pluggy?.occurredAt);
});

test('only configured sources are built', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  assert.deepEqual(buildAdapters({}, { store, http: network() }), []);
  assert.deepEqual(buildAdapters({ pierre: { apiKey: 'k' } }, { store, http: network() }).map((a) => a.id), ['pierre']);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning "tests/sync/*.test.ts"`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/sync/sync.ts`.

- [ ] **Step 3: Implementar o serviço, a configuração e a montagem dos adapters**

Crie `src/sync/sync.ts`:

```ts
import type { SourceAdapter } from '../core/adapter.ts';
import { SourceHttpError, type SnapshotSink } from '../core/http.ts';
import type { SourceId } from '../core/types.ts';
import type { Store } from '../store/store.ts';

export interface SyncDeps {
  store: Store;
  now?: () => Date;
}

export interface SyncResult {
  sourceId: SourceId;
  accounts: number;
  transactions: number;
  bills: number;
  freshness: number;
  warnings: string[];
  errors: string[];
}

/** Registers the source so snapshots and records can reference it. Safe to call repeatedly. */
export function registerAdapter(adapter: SourceAdapter, store: Store, now: Date): void {
  store.registerSource(
    { id: adapter.id, kind: 'aggregator', capabilities: { ...adapter.capabilities } },
    now.toISOString(),
  );
}

/** Builds the sink an adapter uses to store every raw response it receives. */
export function createSnapshotSink(store: Store, sourceId: SourceId, now: () => Date = () => new Date()): SnapshotSink {
  return (snapshot) => {
    store.saveSnapshot({
      sourceId,
      endpoint: snapshot.endpoint,
      fetchedAt: now().toISOString(),
      httpStatus: snapshot.httpStatus,
      body: snapshot.body,
    });
  };
}

function describe(error: unknown): string {
  if (error instanceof SourceHttpError) {
    const path = error.url.split('?')[0] ?? error.url;
    return `HTTP ${error.status} from ${path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pulls accounts, transactions and bills from one source and stores them.
 * A failing step is reported and does not stop the steps after it.
 */
export async function syncSource(adapter: SourceAdapter, deps: SyncDeps, since: Date): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const { store } = deps;
  registerAdapter(adapter, store, now());

  const result: SyncResult = {
    sourceId: adapter.id,
    accounts: 0,
    transactions: 0,
    bills: 0,
    freshness: 0,
    warnings: [],
    errors: [],
  };

  try {
    const { accounts, freshness } = await adapter.fetchAccounts();
    const seenAt = now().toISOString();
    store.upsertSourceAccounts(adapter.id, accounts, seenAt);
    for (const entry of freshness) store.upsertFreshness(entry);
    result.accounts = accounts.length;
    result.freshness = freshness.length;
  } catch (error) {
    result.errors.push(`accounts: ${describe(error)}`);
  }

  try {
    const transactions = await adapter.fetchTransactions(since);
    store.upsertSourceTransactions(adapter.id, transactions, now().toISOString());
    result.transactions = transactions.length;
  } catch (error) {
    result.errors.push(`transactions: ${describe(error)}`);
  }

  try {
    const bills = await adapter.fetchBills();
    store.upsertSourceBills(adapter.id, bills, now().toISOString());
    result.bills = bills.length;
  } catch (error) {
    result.errors.push(`bills: ${describe(error)}`);
  }

  result.warnings = adapter.drainWarnings?.() ?? [];
  return result;
}
```

Crie `src/sync/config.ts`:

```ts
import type { PierreConfig } from '../adapters/pierre/adapter.ts';
import type { PluggyConfig, PluggyItemConfig } from '../adapters/pluggy/adapter.ts';

export interface AdapterEnv {
  pierre?: PierreConfig;
  pluggy?: PluggyConfig;
}

/**
 * Parses `Label:itemId,Other Label:itemId`. The label is whatever the user calls the
 * connection (usually the bank), and the item id is the part after the last colon.
 */
export function parsePluggyItems(value: string): PluggyItemConfig[] {
  const items = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const cut = part.lastIndexOf(':');
      const label = cut > 0 ? part.slice(0, cut).trim() : '';
      const itemId = cut > 0 ? part.slice(cut + 1).trim() : '';
      if (label === '' || itemId === '') throw new Error(`PLUGGY_ITEMS: expected Label:itemId, got "${part}"`);
      return { label, itemId };
    });
  if (items.length === 0) throw new Error('PLUGGY_ITEMS: no items found');
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.itemId)) throw new Error(`PLUGGY_ITEMS: duplicate item id ${item.itemId}`);
    seen.add(item.itemId);
  }
  return items;
}

export function loadAdapterEnv(env: Record<string, string | undefined>): AdapterEnv {
  const out: AdapterEnv = {};

  const apiKey = env.PIERRE_API_KEY?.trim();
  if (apiKey) out.pierre = { apiKey };

  const clientId = env.PLUGGY_CLIENT_ID?.trim();
  const clientSecret = env.PLUGGY_CLIENT_SECRET?.trim();
  const items = env.PLUGGY_ITEMS?.trim();
  const given = [clientId, clientSecret, items].filter((v) => v).length;
  if (given === 3) {
    out.pluggy = { clientId: clientId as string, clientSecret: clientSecret as string, items: parsePluggyItems(items as string) };
  } else if (given > 0) {
    throw new Error('Pluggy needs PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET and PLUGGY_ITEMS together');
  }
  return out;
}
```

Crie `src/sync/adapters.ts`:

```ts
import { PierreAdapter } from '../adapters/pierre/adapter.ts';
import { PluggyAdapter } from '../adapters/pluggy/adapter.ts';
import type { SourceAdapter } from '../core/adapter.ts';
import type { HttpClient } from '../core/http.ts';
import type { Store } from '../store/store.ts';
import type { AdapterEnv } from './config.ts';
import { createSnapshotSink, registerAdapter } from './sync.ts';

export interface BuildDeps {
  store: Store;
  http: HttpClient;
  now?: () => Date;
}

/** The single place that knows which adapters exist. Removing a source means removing its lines here. */
export function buildAdapters(env: AdapterEnv, deps: BuildDeps): SourceAdapter[] {
  const now = deps.now ?? (() => new Date());
  const adapters: SourceAdapter[] = [];

  if (env.pierre) {
    adapters.push(new PierreAdapter(env.pierre, { http: deps.http, sink: createSnapshotSink(deps.store, 'pierre', now), now }));
  }
  if (env.pluggy) {
    adapters.push(new PluggyAdapter(env.pluggy, { http: deps.http, sink: createSnapshotSink(deps.store, 'pluggy', now), now }));
  }
  for (const adapter of adapters) registerAdapter(adapter, deps.store, now());
  return adapters;
}
```

Crie `src/sync/args.ts`:

```ts
export interface SyncArgs {
  since: Date;
  /** Restrict the run to one source id; null means every configured source. */
  source: string | null;
}

const DEFAULT_DAYS = 90;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseSyncArgs(argv: string[], now: Date): SyncArgs {
  let since = new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
  let source: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      const value = argv[++i];
      if (value === undefined || !DAY_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
        throw new Error('--since expects a date like 2026-01-31');
      }
      since = new Date(`${value}T00:00:00.000Z`);
    } else if (arg === '--source') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error('--source expects a source id such as pierre or pluggy');
      source = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { since, source };
}
```

- [ ] **Step 4: Criar o ponto de entrada**

Crie `src/sync/cli.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { fetchHttpClient, retryingClient } from '../core/http.ts';
import type { SourceAdapter } from '../core/adapter.ts';
import { loadConfig } from '../config.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { buildAdapters } from './adapters.ts';
import { parseSyncArgs, type SyncArgs } from './args.ts';
import { loadAdapterEnv } from './config.ts';
import { syncSource } from './sync.ts';

function fail(error: unknown): never {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

let args: SyncArgs;
try {
  args = parseSyncArgs(process.argv.slice(2), new Date());
} catch (error) {
  fail(error);
}

const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);

try {
  let adapters: SourceAdapter[];
  try {
    adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) }).filter(
      (adapter) => args.source === null || adapter.id === args.source,
    );
  } catch (error) {
    fail(error);
  }

  if (adapters.length === 0) {
    console.error('No source to sync. Set PIERRE_API_KEY and/or the PLUGGY_* variables, or check --source.');
    process.exitCode = 1;
  }

  for (const adapter of adapters) {
    const result = await syncSource(adapter, { store }, args.since);
    console.log(
      `${result.sourceId}: ${result.accounts} accounts, ${result.transactions} transactions, ${result.bills} bills, ${result.freshness} institutions`,
    );
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    for (const error of result.errors) console.error(`  error: ${error}`);
    if (result.errors.length > 0) process.exitCode = 1;
  }
} finally {
  store.close();
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 108 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 6: Testar o CLI sem rede nem chaves**

Run:

```bash
env -i PATH="$PATH" DB_PATH=/tmp/gmf-cli.sqlite node --disable-warning=ExperimentalWarning src/sync/cli.ts; echo "exit=$?"
env -i PATH="$PATH" DB_PATH=/tmp/gmf-cli.sqlite node --disable-warning=ExperimentalWarning src/sync/cli.ts --bogus; echo "exit=$?"
env -i PATH="$PATH" DB_PATH=/tmp/gmf-cli.sqlite PLUGGY_CLIENT_ID=x node --disable-warning=ExperimentalWarning src/sync/cli.ts; echo "exit=$?"
rm -f /tmp/gmf-cli.sqlite /tmp/gmf-cli.sqlite-shm /tmp/gmf-cli.sqlite-wal
```

Expected, em ordem: `No source to sync. Set PIERRE_API_KEY and/or the PLUGGY_* variables, or check --source.` com `exit=1`; `error: Unknown argument: --bogus` com `exit=2`; `error: Pluggy needs PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET and PLUGGY_ITEMS together` com `exit=2`.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 5 arquivos de `src/sync/` e os 3 testes.

---

### Task 8: Script `sync`, variáveis de ambiente e sincronização real (depende de C1, C2 e C3)

**Files:**
- Modify: `package.json` (script `sync`), `.env.example`

**Interfaces:**
- Consumes: o CLI da Tarefa 7.
- Produces: `npm run sync [-- --since YYYY-MM-DD] [--source pierre|pluggy]`; dados reais em `data/gmf.sqlite`.

- [ ] **Step 1: Confirmar C1 e acrescentar o script**

Em `package.json`, em `scripts`, depois de `typecheck`, acrescente:

```json
"sync": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/sync/cli.ts"
```

- [ ] **Step 2: Atualizar o `.env.example`**

Substitua o conteúdo de `.env.example`:

```
PORT=8080
DB_PATH=data/gmf.sqlite
APP_VERSION=dev

# Sources (leave a source empty to skip it)
PIERRE_API_KEY=
PLUGGY_CLIENT_ID=
PLUGGY_CLIENT_SECRET=
# One entry per connection: Label:itemId, separated by commas.
# Use the same institution names Pierre reports so the two sources can be paired later.
PLUGGY_ITEMS=
```

- [ ] **Step 3: Sincronizar o Pierre primeiro (C3)**

O `.env` do usuário já tem `PIERRE_API_KEY`. No terminal do usuário: `npm run sync -- --since 2026-07-28 --source pierre`
No sandbox do Claude Code, prefixe com `NODE_USE_ENV_PROXY=1` e libere antes `www.pierre.finance` no dashboard.
Expected: uma linha `pierre: N accounts, N transactions, N bills, N institutions` e `exit=0`. Se aparecer `error: accounts: HTTP 401 from ...`, a chave é inválida ou a assinatura expirou. A fonte sem as variáveis do Pluggy é simplesmente ignorada.

- [ ] **Step 4: Ver como o Pierre chama cada instituição**

Run: `node --disable-warning=ExperimentalWarning -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("data/gmf.sqlite"); console.log(db.prepare("SELECT institution FROM freshness WHERE source_id = ? ORDER BY institution").all("pierre").map((r) => r.institution).join("\n"));'`
Expected: um nome por instituição conectada (os valores de `connectorName` do Pierre).

- [ ] **Step 5: Ajustar o `.env` real (C2, ação do usuário)**

No `.env` do usuário, apague a linha `PLUGGY_ITEM_IDS=...` e crie `PLUGGY_ITEMS=Rótulo1:itemId1,Rótulo2:itemId2,...`, um par por conexão do MeuPluggy. Cada rótulo deve ser exatamente um dos nomes do passo anterior, o da instituição à qual aquele item corresponde (o usuário sabe qual item é de qual banco pelo painel do Meu Pluggy). Mantenha `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET`. O arquivo continua ignorado pelo git; nunca cole esses valores em chat nem em commits.

- [ ] **Step 6: Sincronizar o Pluggy**

Run: `npm run sync -- --since 2026-07-28 --source pluggy` (no sandbox: `NODE_USE_ENV_PROXY=1`, com `api.pluggy.ai` liberado).
Expected: `pluggy: N accounts, N transactions, N bills, N institutions` e `exit=0`. Um `warning: ... skipped an account` é esperado se houver contas de tipos que o `core` não modela.

- [ ] **Step 7: Conferir o que foi gravado (somente leitura)**

Run:

```bash
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/gmf.sqlite");
for (const t of ["source_accounts", "source_transactions", "source_bills"]) {
  console.log(t, JSON.stringify(db.prepare(`SELECT source_id, COUNT(*) AS n FROM ${t} GROUP BY source_id`).all()));
}
console.log("freshness", JSON.stringify(db.prepare("SELECT source_id, institution, last_updated_at FROM freshness ORDER BY source_id, institution").all()));
console.log("snapshots", JSON.stringify(db.prepare("SELECT source_id, COUNT(*) AS n FROM raw_snapshots GROUP BY source_id").all()));
'
```

Expected: contagens maiores que zero para as duas fontes, uma linha de `freshness` por instituição em cada fonte, e snapshots para cada chamada feita. As contagens devem ter ordem de grandeza parecida com a da auditoria (cerca de 11 contas no Pierre, 13 no Pluggy, e algumas centenas de transações em 90 dias).

- [ ] **Step 8: Conferir que nenhuma credencial foi gravada**

Run: `node --disable-warning=ExperimentalWarning -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("data/gmf.sqlite"); const hit = db.prepare("SELECT COUNT(*) AS n FROM raw_snapshots WHERE body LIKE ? OR endpoint LIKE ?").get("%\"apiKey\"%", "%/auth%"); console.log(JSON.stringify(hit));'`
Expected: `{"n":0}`.

- [ ] **Step 9: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `package.json` e `.env.example` modificados. `data/` e `.env` não aparecem, porque estão no `.gitignore`.

---

## Fora deste plano

- Mesclar as duas fontes, parear contas entre elas, deduplicar cartões consolidados e calcular grupos de limite: Plano D.
- Observador de `lastUpdatedAt`, atualização manual pelo Pierre e orçamento de cota: Plano E. O `requestRefresh` do Pierre já existe, mas nada o chama ainda.
- Detectar registros que sumiram de uma fonte: o campo `last_seen_at` já permite, e o Plano D decide o que fazer.

## Auto-revisão contra o design

- Seção 4 (contrato do adapter, snapshots brutos antes de normalizar): Tarefas 1, 3, 5 e 7. Os snapshots são gravados pelo `SnapshotSink` antes de qualquer normalização, inclusive de respostas com erro.
- Seção 5 (leitura incremental, falhas): leituras com repetição e `since` em todas as buscas de transações (Tarefas 1, 3, 5). Um passo que falha não derruba os outros (Tarefa 7).
- Seção 6 (tabelas por fonte, `first_seen_at` e `last_seen_at`): Tarefa 6.
- Seção 11 (erros): erros de formato com o caminho do campo (Tarefa 1), tipos não modelados ignorados com aviso (Tarefas 2 a 5), mensagens de erro sem a query da URL (Tarefa 7), credenciais fora dos snapshots (Tarefas 3 e 5).
- Seção 8 do Plano A (importação do histórico): `--since` antigo na Tarefa 8.
