# Gata Molhada Finance, Plano D2: transações canônicas e divergências (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Juntar as transações das duas fontes numa única lista canônica por conta, dizer para cada uma se as fontes concordam, separar o que é atraso de sincronização do que é divergência real, pôr de lado os pendentes parados, e mostrar tudo com `npm run reconcile`.

**Architecture:** `reconcileTransactions` é uma função pura. Para cada conta canônica, usa a fonte de maior prioridade como base e junta os registros das outras fontes em quatro passadas, da mais exata à mais frouxa. Cada grupo vira uma transação canônica com estado (`confirmed`, `single_source`, `conflict` ou `stale_pending`) e gera, quando cabe, divergências. `runReconciliation` encadeia contas e transações, grava o resultado em tabelas derivadas e sincroniza as divergências, que mantêm o histórico entre execuções.

**Tech Stack:** Node 22 (`node:sqlite`, `node:crypto`, `node:test`), TypeScript por remoção de tipos. Nenhuma dependência nova.

## Global Constraints

- Node >= 22.18, TypeScript por remoção de tipos: só sintaxe apagável (sem `enum`, `namespace` nem propriedades de parâmetro no construtor), `import type` para tipos e extensão `.ts` em todo import relativo.
- Sem dependências novas. Valores monetários em centavos inteiros, com sinal de fluxo de caixa (dinheiro que sai é negativo). Datas em ISO 8601 UTC; o dia de uma transação é o dia no Brasil (UTC-3, sem horário de verão).
- Repositório público: testes e fixtures só têm dados sintéticos e nomes neutros.
- O `core` e a reconciliação não conhecem fontes específicas: recebem fontes genéricas com prioridade. Só `src/reconcile/run.ts` conhece a ordem `pierre`, `pluggy`.
- Quem executa este plano não faz commit nem push sem pedido explícito do usuário. A `main` é protegida: o trabalho vai em branch.
- Identificadores e comentários em inglês. Documentação em português.
- Raiz do projeto: `~/IdeaProjects/pierre-finance-app`. Todos os caminhos são relativos a ela.

## Aprovações e decisões (perguntas ao usuário, não passos)

- **D2-A** (Tarefa 4): posso acrescentar o script `reconcile` ao `package.json`? Nenhuma dependência é instalada.
- **D2-B** (Tarefa 5): posso rodar `npm run reconcile` com o banco real? Ele lê as tabelas `source_*` e as contas já calculadas, e grava as tabelas derivadas e as divergências em `data/gmf.sqlite`, sem rede.

Decisões de design deste plano (revisáveis antes de executar):

1. **Junção por conta canônica.** Só entram os registros das contas `member` de cada fonte; cópias `duplicate` são ignoradas. A fonte de maior prioridade presente na conta fornece o grupo-base, e as outras fontes são juntadas a ele.
2. **Quatro passadas, da mais exata à mais frouxa**, cada registro de uma fonte usado uma vez (um para um):
   1. mesmo instante, mesmo valor e mesma descrição original;
   2. mesmo dia (Brasil), mesmo valor e mesma descrição;
   3. parcela: mesmo valor e mesma descrição, em qualquer data, mas só se algum dos dois tiver dados de parcela ou terminar em `NN/NN`, porque as fontes datam uma parcela de formas diferentes (compra numa, cobrança na outra);
   4. mesmo valor em até 36 horas, com descrições diferentes (por exemplo, "Transferência enviada pelo Pix|Fulano" contra "Transferência enviada|Fulano"); vence o candidato mais próximo no tempo.
   A passada 3 não junta uma cobrança mensal com a do mês seguinte, de propósito. A passada 4 pode juntar duas compras diferentes de mesmo valor em até 36 horas na mesma conta; o relatório mostra quantas junções vieram dela.
3. **Estado e status.** Um grupo com registros de duas fontes é `confirmed`, ou `conflict` se os status diferirem; o status canônico é `posted` se alguma fonte diz `posted`. Um grupo com uma fonte só é `single_source`, ou `stale_pending` (e `excluded`) quando está `pending` além do limite: 7 dias em conta e 30 dias em cartão, porque uma compra no cartão fica pendente até a fatura fechar.
4. **Campos.** Data, valor e descrição vêm do registro de maior prioridade; descrição original, categoria e parcela, do primeiro registro que os tiver.
5. **Divergências.** `status_conflict` (informativa quando a fonte que diz `pending` sincronizou antes da outra; aviso caso contrário), `missing_in_source` (aviso: a outra fonte sincronizou depois da transação e mesmo assim não a tem), `not_yet_synced` (informativa: a outra fonte ainda não sincronizou depois dela) e `stale_pending` (aviso). Transações mais antigas que tudo o que a outra fonte tem não geram divergência, porque estão fora da janela dela.
6. **Id canônico** da transação: `tx_` mais os 16 primeiros caracteres do SHA-256 de `conta|dia no Brasil|valor|descrição original normalizada|ordinal`, calculado sobre o registro de maior prioridade; o ordinal separa compras idênticas no mesmo dia. Se uma transação só do Pluggy ganhar depois um par do Pierre pela passada 4 (descrição diferente), o id muda. Limite conhecido, a tratar quando houver dados do usuário ligados aos ids.
7. **Divergências persistem.** O id de uma divergência é o hash de `tipo|id da transação`. A cada execução, as presentes são atualizadas (o `opened_at` é mantido), as ausentes ficam com `resolved_at`, e uma resolvida que volta é reaberta com novo `opened_at`. As tabelas `transactions` e `transaction_links` são apagadas e recriadas a cada execução, numa transação.
8. **Sem chave estrangeira em `transactions.account_id`.** As contas podem ser recriadas isoladamente por `npm run accounts`, e uma chave impediria isso.

---

### Task 1: Tipos canônicos de transação e de divergência

**Files:**
- Replace: `src/core/canonical.ts`

**Interfaces:**
- Consumes: `Cents`, `AccountKind`, `SourceId`, `TransactionStatus`.
- Produces: tipos `TransactionState`, `CanonicalTransaction`, `TransactionLink`, `FindingKind`, `FindingSeverity`, `Finding`, além dos já existentes.

- [ ] **Step 1: Substituir os tipos canônicos**

Substitua o conteúdo de `src/core/canonical.ts`:

```ts
import type { Cents } from './money.ts';
import type { AccountKind, SourceId, TransactionStatus } from './types.ts';

export type AccountRole = 'member' | 'duplicate';

export interface AccountRef {
  sourceId: SourceId;
  externalId: string;
  /** `member` is the source's chosen copy; `duplicate` is another copy of the same account in that source. */
  role: AccountRole;
}

export interface CanonicalAccount {
  id: string;
  institution: string;
  kind: AccountKind;
  name: string;
  last4: string | null;
  balance: Cents;
  balanceSourceId: SourceId | null;
  /** When the source last synced this institution, if the source reports it. */
  balanceAsOf: string | null;
  creditLimit: Cents | null;
  availableLimit: Cents | null;
  minimumPayment: Cents | null;
  dueDate: string | null;
  limitGroupId: string | null;
  refs: AccountRef[];
}

export interface LimitGroup {
  id: string;
  institution: string;
  creditLimit: Cents;
  memberIds: string[];
}

export type TransactionState = 'confirmed' | 'single_source' | 'conflict' | 'stale_pending';

export interface CanonicalTransaction {
  id: string;
  accountId: string;
  occurredAt: string;
  amount: Cents;
  description: string;
  descriptionRaw: string | null;
  status: TransactionStatus;
  installment: { number: number; total: number } | null;
  category: string | null;
  state: TransactionState;
  /** Sources that report this transaction. */
  sourceIds: SourceId[];
  /** True for stale pending entries, which are kept for review but left out of totals. */
  excluded: boolean;
}

export interface TransactionLink {
  sourceId: SourceId;
  externalId: string;
  transactionId: string;
  /** 0 = first record of the group; 1 = same instant; 2 = same day; 3 = installment; 4 = same amount within 36 hours. */
  matchPass: number;
}

export type FindingKind = 'missing_in_source' | 'not_yet_synced' | 'status_conflict' | 'stale_pending';
export type FindingSeverity = 'info' | 'warning';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  accountId: string;
  transactionId: string;
  summary: string;
  details: Record<string, unknown>;
}
```

- [ ] **Step 2: Conferir que nada quebrou**

Run: `npm test && npm run typecheck`
Expected: 137 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 3: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `src/core/canonical.ts` modificado.

---

### Task 2: Reconciliação de transações

**Files:**
- Create: `src/reconcile/transactions.ts`
- Replace: `tests/support/builders.ts`
- Test: `tests/reconcile/transactions.test.ts`

**Interfaces:**
- Consumes: `CanonicalAccount`, `Freshness`, `SourceTransaction`, `normalizeName`, `institutionKey`, `formatBRL`.
- Produces: construtores de teste `canonical()` e `txSource()`, além dos já existentes; `reconcileTransactions(input: TransactionInput): TransactionReconciliation` com `{ transactions, links, findings, stats }`; `localDay(instant): string`; `TransactionSource { sourceId; priority; transactions; freshness }`; `TransactionInput { accounts; sources; now; staleDays? }`; `TransactionStats { groups; byState; byPass }`.

- [ ] **Step 1: Escrever o teste que falha**

Substitua o conteúdo de `tests/support/builders.ts` (acrescenta os construtores `canonical()` e `txSource()`):

```ts
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';
import type { CanonicalAccount } from '../../src/core/canonical.ts';
import type { SourceView } from '../../src/reconcile/types.ts';
import type { TransactionSource } from '../../src/reconcile/transactions.ts';

export function account(overrides: Partial<SourceAccount> = {}): SourceAccount {
  return {
    externalId: 'acc-1',
    externalItemId: null,
    institution: 'Bank A',
    kind: 'checking',
    name: 'Conta Corrente',
    last4: null,
    balance: 100000,
    creditLimit: null,
    availableLimit: null,
    minimumPayment: null,
    dueDate: null,
    ...overrides,
  };
}

export function card(overrides: Partial<SourceAccount> = {}): SourceAccount {
  return account({
    externalId: 'card-1',
    kind: 'credit_card',
    name: 'Cartao Exemplo',
    last4: '1234',
    balance: 30000,
    creditLimit: 500000,
    availableLimit: 470000,
    ...overrides,
  });
}

export function tx(overrides: Partial<SourceTransaction> = {}): SourceTransaction {
  return {
    externalId: 'tx-1',
    accountExternalId: 'acc-1',
    occurredAt: '2026-10-20T12:00:00.000Z',
    amount: -1990,
    description: 'Coffee',
    descriptionRaw: 'COFFEE SHOP',
    status: 'posted',
    installment: null,
    category: null,
    ...overrides,
  };
}

/** Several transactions on distinct days, enough to make two accounts recognizably the same one. */
export function history(accountExternalId: string, idPrefix: string, count = 4): SourceTransaction[] {
  return Array.from({ length: count }, (_, i) =>
    tx({
      externalId: `${idPrefix}-${i}`,
      accountExternalId,
      occurredAt: `2026-10-${String(10 + i).padStart(2, '0')}T12:00:00.000Z`,
      amount: -(1000 + i * 111),
      descriptionRaw: `SHOP ${i}`,
    }),
  );
}

export function view(
  sourceId: string,
  priority: number,
  data: Partial<Pick<SourceView, 'accounts' | 'transactions' | 'freshness'>> = {},
): SourceView {
  return { sourceId, priority, accounts: [], transactions: [], freshness: [], ...data };
}

export function fresh(sourceId: string, institution: string, lastUpdatedAt: string) {
  return { sourceId, institution, lastUpdatedAt, observedAt: lastUpdatedAt };
}


export function canonical(overrides: Partial<CanonicalAccount> = {}): CanonicalAccount {
  return {
    id: 'acc_test',
    institution: 'Bank A',
    kind: 'checking',
    name: 'Conta Corrente',
    last4: null,
    balance: 0,
    balanceSourceId: 'pierre',
    balanceAsOf: null,
    creditLimit: null,
    availableLimit: null,
    minimumPayment: null,
    dueDate: null,
    limitGroupId: null,
    refs: [
      { sourceId: 'pierre', externalId: 'p1', role: 'member' },
      { sourceId: 'pluggy', externalId: 'g1', role: 'member' },
    ],
    ...overrides,
  };
}

export function txSource(
  sourceId: string,
  priority: number,
  transactions: TransactionSource['transactions'] = [],
  freshness: TransactionSource['freshness'] = [],
): TransactionSource {
  return { sourceId, priority, transactions, freshness };
}
```

Crie `tests/reconcile/transactions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, reconcileTransactions } from '../../src/reconcile/transactions.ts';
import { canonical, fresh, tx, txSource } from '../support/builders.ts';

const NOW = new Date('2026-10-26T16:00:00.000Z');

function run(pierre: ReturnType<typeof tx>[], pluggy: ReturnType<typeof tx>[], extra: Partial<Parameters<typeof reconcileTransactions>[0]> = {}) {
  const p = pierre.map((t) => ({ ...t, accountExternalId: 'p1' }));
  const g = pluggy.map((t) => ({ ...t, accountExternalId: 'g1' }));
  return reconcileTransactions({
    accounts: [canonical()],
    sources: [txSource('pierre', 0, p, [fresh('pierre', 'Bank A', '2026-10-26T15:00:00.000Z')]), txSource('pluggy', 1, g, [fresh('pluggy', 'Bank A', '2026-10-26T15:00:00.000Z')])],
    now: NOW,
    ...extra,
  });
}

test('localDay uses the Brazilian calendar day', () => {
  assert.equal(localDay('2026-10-21T03:00:00.000Z'), '2026-10-21');
  assert.equal(localDay('2026-10-21T02:59:00.000Z'), '2026-10-20');
});

test('joins the same transaction from two sources when instant, amount and description agree', () => {
  const r = run([tx({ externalId: 'a' })], [tx({ externalId: 'b' })]);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0]?.state, 'confirmed');
  assert.deepEqual(r.transactions[0]?.sourceIds, ['pierre', 'pluggy']);
  assert.deepEqual(r.links.map((l) => [l.sourceId, l.matchPass]).sort(), [['pierre', 0], ['pluggy', 1]]);
  assert.equal(r.findings.length, 0);
});

test('joins by calendar day when the time differs', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2026-10-20T12:00:00.000Z' })], [tx({ externalId: 'b', occurredAt: '2026-10-20T18:30:00.000Z' })]);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 2);
});

test('joins an installment charge dated differently by the two sources', () => {
  const pierreTx = tx({ externalId: 'a', occurredAt: '2025-11-29T03:00:00.000Z', amount: -29240, description: 'Store 10/12', descriptionRaw: 'STORE 10/12', installment: { number: 10, total: 12 } });
  const pluggyTx = tx({ externalId: 'b', occurredAt: '2026-08-07T03:00:00.000Z', amount: -29240, description: 'Store 10/12', descriptionRaw: 'STORE 10/12', installment: { number: 10, total: 12 } });
  const r = run([pierreTx], [pluggyTx]);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 3);
});

test('joins the same amount within 36 hours when the descriptions are worded differently', () => {
  const r = run(
    [tx({ externalId: 'a', amount: -2000, descriptionRaw: 'Transferencia enviada pelo Pix|Alice', description: 'Transferencia enviada pelo Pix|Alice' })],
    [tx({ externalId: 'b', amount: -2000, occurredAt: '2026-10-21T08:00:00.000Z', descriptionRaw: 'Transferencia enviada|Alice', description: 'Transferencia enviada|Alice' })],
  );
  assert.equal(r.transactions.length, 1);
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 4);
});

test('does not join different amounts or transactions more than 36 hours apart', () => {
  const r = run(
    [tx({ externalId: 'a', amount: -2000, descriptionRaw: 'ONE' })],
    [tx({ externalId: 'b', amount: -2001, descriptionRaw: 'TWO' }), tx({ externalId: 'c', amount: -2000, descriptionRaw: 'THREE', occurredAt: '2026-10-23T12:00:00.000Z' })],
  );
  assert.equal(r.transactions.length, 3);
});

test('a monthly charge is not joined to the same charge of another month', () => {
  const r = run(
    [tx({ externalId: 'a', occurredAt: '2026-10-18T12:00:00.000Z', amount: -2390, descriptionRaw: 'STREAMING' })],
    [tx({ externalId: 'b', occurredAt: '2026-09-18T12:00:00.000Z', amount: -2390, descriptionRaw: 'STREAMING' })],
  );
  assert.equal(r.transactions.length, 2);
});

test('identical purchases on one day are paired one to one', () => {
  const same = { amount: -500, descriptionRaw: 'BAKERY', occurredAt: '2026-10-20T12:00:00.000Z' };
  const r = run([tx({ externalId: 'a1', ...same }), tx({ externalId: 'a2', ...same })], [tx({ externalId: 'b1', ...same }), tx({ externalId: 'b2', ...same })]);
  assert.equal(r.transactions.length, 2);
  assert.ok(r.transactions.every((t) => t.state === 'confirmed'));
  assert.equal(new Set(r.transactions.map((t) => t.id)).size, 2);
});

test('a status difference is a conflict and the posted status wins', () => {
  const r = run([tx({ externalId: 'a', status: 'posted' })], [tx({ externalId: 'b', status: 'pending' })], {
    sources: [
      txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', status: 'posted' })], [fresh('pierre', 'Bank A', '2026-10-26T15:00:00.000Z')]),
      txSource('pluggy', 1, [tx({ externalId: 'b', accountExternalId: 'g1', status: 'pending' })], [fresh('pluggy', 'Bank A', '2026-10-25T20:00:00.000Z')]),
    ],
  });
  assert.equal(r.transactions[0]?.state, 'conflict');
  assert.equal(r.transactions[0]?.status, 'posted');
  assert.equal(r.findings[0]?.kind, 'status_conflict');
  assert.equal(r.findings[0]?.severity, 'info');
});

test('a status conflict that the sync times do not explain is a warning', () => {
  const r = run([tx({ externalId: 'a', status: 'posted' })], [tx({ externalId: 'b', status: 'pending' })]);
  assert.equal(r.findings[0]?.severity, 'warning');
});

test('a transaction in one source only is missing when the other source synced after it', () => {
  const r = run([tx({ externalId: 'a' })], []);
  assert.equal(r.transactions[0]?.state, 'single_source');
  assert.equal(r.findings[0]?.kind, 'missing_in_source');
  assert.equal(r.findings[0]?.details.missingIn, 'pluggy');
});

test('a transaction newer than the other source last sync is only not synced yet', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2026-10-26T14:00:00.000Z' })], [], {
    sources: [
      txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', occurredAt: '2026-10-26T14:00:00.000Z' })], [fresh('pierre', 'Bank A', '2026-10-26T15:00:00.000Z')]),
      txSource('pluggy', 1, [tx({ externalId: 'x', accountExternalId: 'g1', occurredAt: '2026-10-10T12:00:00.000Z', amount: -1 })], [fresh('pluggy', 'Bank A', '2026-10-25T20:00:00.000Z')]),
    ],
  });
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('not_yet_synced'));
  assert.equal(r.findings.find((f) => f.kind === 'not_yet_synced')?.severity, 'info');
});

test('no finding for a transaction older than everything the other source has', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2026-07-01T12:00:00.000Z' })], [tx({ externalId: 'b', occurredAt: '2026-10-01T12:00:00.000Z', amount: -777, descriptionRaw: 'OTHER' })]);
  const old = r.transactions.find((t) => t.occurredAt.startsWith('2026-07-01'));
  assert.equal(old?.state, 'single_source');
  assert.equal(r.findings.filter((f) => f.transactionId === old?.id).length, 0);
});

test('a lone pending bank transaction is set aside after 7 days, a card one after 30', () => {
  const bank = run([tx({ externalId: 'a', status: 'pending', occurredAt: '2026-10-10T12:00:00.000Z' })], []);
  assert.equal(bank.transactions[0]?.state, 'stale_pending');
  assert.equal(bank.transactions[0]?.excluded, true);
  assert.equal(bank.stats.byState.stale_pending, 1);

  const recentBank = run([tx({ externalId: 'a', status: 'pending', occurredAt: '2026-10-22T12:00:00.000Z' })], []);
  assert.equal(recentBank.transactions[0]?.state, 'single_source');

  const card = (days: number) =>
    reconcileTransactions({
      accounts: [canonical({ kind: 'credit_card', name: 'Card' })],
      sources: [txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', status: 'pending', occurredAt: new Date(NOW.getTime() - days * 86_400_000).toISOString() })])],
      now: NOW,
    }).transactions[0]?.state;
  assert.equal(card(20), 'single_source');
  assert.equal(card(35), 'stale_pending');
});

test('a pending transaction that both sources report is never set aside', () => {
  const old = '2026-08-01T12:00:00.000Z';
  const r = run([tx({ externalId: 'a', status: 'pending', occurredAt: old })], [tx({ externalId: 'b', status: 'pending', occurredAt: old })]);
  assert.equal(r.transactions[0]?.state, 'confirmed');
});

test('fills missing fields from the other source', () => {
  const r = run([tx({ externalId: 'a', category: null, descriptionRaw: null })], [tx({ externalId: 'b', category: 'Food', descriptionRaw: 'COFFEE SHOP' })]);
  assert.equal(r.transactions[0]?.category, 'Food');
});

test('ignores duplicate copies of an account and accounts known to one source only', () => {
  const account = canonical({
    refs: [
      { sourceId: 'pierre', externalId: 'p1', role: 'member' },
      { sourceId: 'pluggy', externalId: 'g1', role: 'duplicate' },
    ],
  });
  const r = reconcileTransactions({
    accounts: [account],
    sources: [txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1' })]), txSource('pluggy', 1, [tx({ externalId: 'b', accountExternalId: 'g1' })])],
    now: NOW,
  });
  assert.equal(r.transactions.length, 1);
  assert.equal(r.findings.length, 0);
});

test('canonical ids are stable and do not depend on input order', () => {
  const a = [tx({ externalId: 'a', descriptionRaw: 'ONE', amount: -100 }), tx({ externalId: 'b', descriptionRaw: 'TWO', amount: -200 })];
  const first = run(a, []);
  const second = run([...a].reverse(), []);
  assert.deepEqual(first.transactions.map((t) => t.id).sort(), second.transactions.map((t) => t.id).sort());
  assert.ok(first.transactions.every((t) => /^tx_[0-9a-f]{16}$/.test(t.id)));
});

test('finding ids are stable between runs', () => {
  const first = run([tx({ externalId: 'a' })], []);
  const second = run([tx({ externalId: 'a' })], []);
  assert.deepEqual(first.findings.map((f) => f.id), second.findings.map((f) => f.id));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/reconcile/transactions.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/reconcile/transactions.ts`.

- [ ] **Step 3: Implementar**

Crie `src/reconcile/transactions.ts`:

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
import { institutionKey, normalizeName } from './names.ts';

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

const BRAZIL_OFFSET_MS = 3 * 3_600_000;
const FUZZY_WINDOW_MS = 36 * 3_600_000;
const DAY_MS = 86_400_000;
const INSTALLMENT_SUFFIX = /\d{1,2}\s*\/\s*\d{1,2}\s*$/;

/** Calendar day in Brazil (UTC-3, no daylight saving), which is how purchases are dated on statements. */
export function localDay(instant: string): string {
  return new Date(new Date(instant).getTime() - BRAZIL_OFFSET_MS).toISOString().slice(0, 10);
}

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

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 156 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 2 arquivos novos desta tarefa, `tests/support/builders.ts` modificado e o `src/core/canonical.ts` da Tarefa 1.

---

### Task 3: Tabelas e métodos do Store para transações e divergências

**Files:**
- Create: `migrations/004_canonical_transactions.sql`
- Replace: `src/store/store.ts`, `src/store/sqlite-store.ts`
- Modify: `tests/store/sqlite-store.test.ts`, `tests/http/router.test.ts`
- Test: `tests/store/canonical-transactions.test.ts`

**Interfaces:**
- Consumes: `CanonicalTransaction`, `TransactionLink`, `Finding` de `src/core/canonical.ts`.
- Produces: no `Store`, `replaceCanonicalTransactions(transactions, links, builtAt)`, `listCanonicalTransactions({ accountId?, includeExcluded? })` (ordem: mais recentes primeiro; `sourceIds` pelos vínculos), `syncFindings(findings, now)` e `listFindings({ includeResolved? })` (tipo `StoredFinding` com `openedAt`, `lastSeenAt`, `resolvedAt`). A versão do esquema passa a 4.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/store/canonical-transactions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { CanonicalTransaction, Finding, TransactionLink } from '../../src/core/canonical.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T1 = '2026-10-26T10:00:00.000Z';
const T2 = '2026-10-26T12:00:00.000Z';
const T3 = '2026-10-26T14:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T1);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T1);
  return store;
}

const transaction = (overrides: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id: 'tx_1',
  accountId: 'acc_1',
  occurredAt: '2026-10-20T12:00:00.000Z',
  amount: -1990,
  description: 'Coffee',
  descriptionRaw: 'COFFEE SHOP',
  status: 'posted',
  installment: { number: 2, total: 5 },
  category: 'Food',
  state: 'confirmed',
  sourceIds: ['pierre', 'pluggy'],
  excluded: false,
  ...overrides,
});

const links: TransactionLink[] = [
  { sourceId: 'pierre', externalId: 'a', transactionId: 'tx_1', matchPass: 0 },
  { sourceId: 'pluggy', externalId: 'b', transactionId: 'tx_1', matchPass: 1 },
];

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'fd_1',
  kind: 'missing_in_source',
  severity: 'warning',
  accountId: 'acc_1',
  transactionId: 'tx_1',
  summary: 'Something is missing',
  details: { missingIn: 'pluggy' },
  ...overrides,
});

test('stores canonical transactions with their sources and installment data', () => {
  const store = newStore();
  store.replaceCanonicalTransactions([transaction()], links, T1);
  assert.deepEqual(store.listCanonicalTransactions(), [transaction()]);
});

test('replacing removes the previous transactions and links', () => {
  const store = newStore();
  store.replaceCanonicalTransactions([transaction()], links, T1);
  store.replaceCanonicalTransactions([transaction({ id: 'tx_2', installment: null, sourceIds: ['pierre'] })], [{ sourceId: 'pierre', externalId: 'a', transactionId: 'tx_2', matchPass: 0 }], T2);
  assert.deepEqual(store.listCanonicalTransactions().map((t) => t.id), ['tx_2']);
});

test('excluded transactions are hidden unless requested, and the list can be filtered by account', () => {
  const store = newStore();
  const stale = transaction({ id: 'tx_s', state: 'stale_pending', excluded: true, sourceIds: ['pluggy'] });
  const other = transaction({ id: 'tx_o', accountId: 'acc_2', sourceIds: ['pierre'] });
  store.replaceCanonicalTransactions([transaction(), stale, other], [
    ...links,
    { sourceId: 'pluggy', externalId: 's', transactionId: 'tx_s', matchPass: 0 },
    { sourceId: 'pierre', externalId: 'o', transactionId: 'tx_o', matchPass: 0 },
  ], T1);
  assert.deepEqual(store.listCanonicalTransactions().map((t) => t.id).sort(), ['tx_1', 'tx_o']);
  assert.equal(store.listCanonicalTransactions({ includeExcluded: true }).length, 3);
  assert.deepEqual(store.listCanonicalTransactions({ accountId: 'acc_2' }).map((t) => t.id), ['tx_o']);
});

test('a link can point at only one canonical transaction', () => {
  const store = newStore();
  assert.throws(
    () => store.replaceCanonicalTransactions([transaction(), transaction({ id: 'tx_2' })], [links[0] as TransactionLink, { ...(links[0] as TransactionLink), transactionId: 'tx_2' }], T1),
    /UNIQUE|constraint/i,
  );
  assert.deepEqual(store.listCanonicalTransactions(), []);
});

test('findings keep their opening time while the problem persists', () => {
  const store = newStore();
  store.syncFindings([finding()], T1);
  store.syncFindings([finding({ summary: 'Still missing' })], T2);
  const [stored] = store.listFindings();
  assert.equal(stored?.openedAt, T1);
  assert.equal(stored?.lastSeenAt, T2);
  assert.equal(stored?.summary, 'Still missing');
  assert.deepEqual(stored?.details, { missingIn: 'pluggy' });
  assert.equal(stored?.resolvedAt, null);
});

test('a finding that disappears is marked resolved and hidden from the open list', () => {
  const store = newStore();
  store.syncFindings([finding(), finding({ id: 'fd_2', kind: 'stale_pending' })], T1);
  store.syncFindings([finding({ id: 'fd_2', kind: 'stale_pending' })], T2);
  assert.deepEqual(store.listFindings().map((f) => f.id), ['fd_2']);
  const all = store.listFindings({ includeResolved: true });
  assert.equal(all.find((f) => f.id === 'fd_1')?.resolvedAt, T2);
});

test('a resolved finding that returns is reopened with a new opening time', () => {
  const store = newStore();
  store.syncFindings([finding()], T1);
  store.syncFindings([], T2);
  store.syncFindings([finding()], T3);
  const [stored] = store.listFindings();
  assert.equal(stored?.resolvedAt, null);
  assert.equal(stored?.openedAt, T3);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/canonical-transactions.test.ts`
Expected: FAIL com `store.replaceCanonicalTransactions is not a function`.

- [ ] **Step 3: Criar a migração**

Crie `migrations/004_canonical_transactions.sql`:

```sql
-- Canonical transactions and reconciliation findings, derived from the source_* tables.
-- transactions.account_id points at accounts.id but has no foreign key: both tables are
-- rebuilt together by the reconciliation, and accounts can be rebuilt on their own.

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  description_raw TEXT,
  status TEXT NOT NULL,
  installment_number INTEGER,
  installment_total INTEGER,
  category TEXT,
  state TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL
);

CREATE INDEX idx_transactions_account ON transactions (account_id, occurred_at);

CREATE TABLE transaction_links (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  match_pass INTEGER NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX idx_transaction_links_transaction ON transaction_links (transaction_id);

-- A finding keeps its id while the same problem persists, so a rerun updates it instead of duplicating it.
CREATE TABLE reconciliation_findings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  account_id TEXT,
  transaction_id TEXT,
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);
```

- [ ] **Step 4: Substituir a interface e a implementação do Store**

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
import { currentVersion, migrate } from './migrations.ts';
import type {
  NewSnapshot,
  Snapshot,
  SourceRegistration,
  Store,
  StoredSourceAccount,
  StoredSourceBill,
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

Em `tests/store/sqlite-store.test.ts`, no teste `applies the real migrations on open`, troque `assert.equal(store.schemaVersion(), 3);` por `assert.equal(store.schemaVersion(), 4);`.

Em `tests/http/router.test.ts`, no teste `GET /healthz reports ok with version and schema version`, troque `schemaVersion: 3,` por `schemaVersion: 4,`.

- [ ] **Step 6: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 163 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: a migração, os dois arquivos de `src/store/` modificados, os dois testes ajustados e o teste novo.

---

### Task 4: Serviço completo, relatório e comando `reconcile` (depende de D2-A)

**Files:**
- Replace: `src/reconcile/run.ts`, `tests/reconcile/run.test.ts`
- Create: `src/reconcile/report.ts`, `src/reconcile/reconcile-cli.ts`
- Modify: `package.json` (script `reconcile`)
- Test: `tests/reconcile/report.test.ts`

**Interfaces:**
- Consumes: `reconcileAccounts`, `reconcileTransactions`, `summarizeAccounts`, `Store`.
- Produces: `runReconciliation(store, { priority?, now?, staleDays? }): { accounts, transactions }` (reconstrói contas, depois transações e divergências, e grava tudo); `formatTransactionReport(result, limit?): string[]`; o comando `npm run reconcile [--all]` (saída 0 com contas, 1 sem contas sincronizadas, 2 com argumento desconhecido).

- [ ] **Step 1: Escrever os testes que falham**

Substitua o conteúdo de `tests/reconcile/run.test.ts` (acrescenta três testes do serviço completo aos quatro existentes):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSourceViews, runAccountReconciliation, runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, history, tx } from '../support/builders.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1', balance: 500000 })], NOW.toISOString());
  store.upsertSourceTransactions('pierre', history('p1', 'pt'), NOW.toISOString());
  store.upsertSourceAccounts('pluggy', [account({ externalId: 'g1', balance: 514051 })], NOW.toISOString());
  store.upsertSourceTransactions('pluggy', history('g1', 'gt'), NOW.toISOString());
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T15:38:00.000Z', observedAt: NOW.toISOString() });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-25T20:00:00.000Z', observedAt: NOW.toISOString() });
  return store;
}

test('rebuilds and saves the canonical accounts from the stored source records', () => {
  const store = seeded();
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.equal(result.accounts.length, 1);
  const [saved] = store.listCanonicalAccounts();
  assert.equal(saved?.balance, 500000);
  assert.equal(saved?.balanceSourceId, 'pierre');
  assert.equal(saved?.refs.length, 2);
});

test('running it again keeps the same ids and does not duplicate rows', () => {
  const store = seeded();
  runAccountReconciliation(store, { now: () => NOW });
  const first = store.listCanonicalAccounts().map((a) => a.id);
  runAccountReconciliation(store, { now: () => new Date('2026-10-26T17:00:00.000Z') });
  assert.deepEqual(store.listCanonicalAccounts().map((a) => a.id), first);
  assert.equal(store.listCanonicalAccounts().length, 1);
});

test('a source that was never synced is ignored', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1' })], NOW.toISOString());
  const views = loadSourceViews(store, ['pierre', 'pluggy']);
  assert.deepEqual(views.map((v) => v.sourceId), ['pierre']);
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.deepEqual(result.notes, []);
});

test('with no synced data it saves nothing', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(store.listCanonicalAccounts(), []);
});


function seededTransactions() {
  const store = seeded();
  const at = NOW.toISOString();
  const shared = history('p1', 'pt');
  store.upsertSourceTransactions('pierre', [...shared, tx({ externalId: 'pierre-only', accountExternalId: 'p1', occurredAt: '2026-10-22T12:00:00.000Z', amount: -777, descriptionRaw: 'ONLY HERE' })], at);
  store.upsertSourceTransactions('pluggy', history('g1', 'gt'), at);
  return store;
}

test('the full reconciliation saves accounts, transactions, links and findings', () => {
  const store = seededTransactions();
  const result = runReconciliation(store, { now: () => NOW });
  assert.equal(result.accounts.accounts.length, 1);
  assert.equal(result.transactions.stats.byState.confirmed, 4);
  assert.equal(result.transactions.stats.byState.single_source, 1);
  assert.equal(store.listCanonicalTransactions().length, 5);
  const findings = store.listFindings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'missing_in_source');
});

test('running it again keeps ids and the opening time of open findings', () => {
  const store = seededTransactions();
  runReconciliation(store, { now: () => NOW });
  const before = store.listFindings()[0];
  const later = new Date('2026-10-26T18:00:00.000Z');
  runReconciliation(store, { now: () => later });
  const after = store.listFindings()[0];
  assert.equal(after?.id, before?.id);
  assert.equal(after?.openedAt, before?.openedAt);
  assert.equal(after?.lastSeenAt, later.toISOString());
  assert.equal(store.listCanonicalTransactions().length, 5);
});

test('a finding is resolved once the other source reports the transaction', () => {
  const store = seededTransactions();
  runReconciliation(store, { now: () => NOW });
  store.upsertSourceTransactions('pluggy', [tx({ externalId: 'pluggy-has-it', accountExternalId: 'g1', occurredAt: '2026-10-22T12:00:00.000Z', amount: -777, descriptionRaw: 'ONLY HERE' })], NOW.toISOString());
  runReconciliation(store, { now: () => new Date('2026-10-26T18:00:00.000Z') });
  assert.deepEqual(store.listFindings(), []);
  assert.equal(store.listFindings({ includeResolved: true }).length, 1);
});
```

Crie `tests/reconcile/report.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTransactionReport } from '../../src/reconcile/report.ts';
import type { TransactionReconciliation } from '../../src/reconcile/transactions.ts';
import type { Finding } from '../../src/core/canonical.ts';

const finding = (n: number, kind: Finding['kind'] = 'missing_in_source', severity: Finding['severity'] = 'warning'): Finding => ({
  id: `fd_${n}`,
  kind,
  severity,
  accountId: 'acc',
  transactionId: `tx_${n}`,
  summary: `finding ${n}`,
  details: {},
});

const result = (findings: Finding[]): TransactionReconciliation => ({
  transactions: [],
  links: [],
  findings,
  stats: { groups: 10, byState: { confirmed: 6, single_source: 2, conflict: 1, stale_pending: 1 }, byPass: [10, 5, 1, 0, 2] },
});

test('summarizes states and the passes that joined records', () => {
  const lines = formatTransactionReport(result([]));
  assert.equal(lines[0], 'Transactions: 10 (confirmed 6, single source 2, status conflict 1, set aside as stale pending 1)');
  assert.equal(lines[1], 'Joined across sources by: same instant 5, same day 1, same amount within 36 hours 2');
  assert.equal(lines[2], 'Findings: none');
});

test('lists findings grouped by kind and caps each group', () => {
  const findings = [1, 2, 3].map((n) => finding(n)).concat([finding(4, 'stale_pending', 'warning')]);
  const lines = formatTransactionReport(result(findings), 2);
  assert.ok(lines.includes('Findings: 3 missing_in_source (warning), 1 stale_pending (warning)'));
  assert.ok(lines.includes('missing_in_source (warning):'));
  assert.ok(lines.includes('  - finding 1') && lines.includes('  - finding 2'));
  assert.equal(lines.includes('  - finding 3'), false);
  assert.ok(lines.includes('  ... 1 more (run with --all)'));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/reconcile/report.test.ts tests/reconcile/run.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/reconcile/report.ts`.

- [ ] **Step 3: Implementar**

Substitua o conteúdo de `src/reconcile/run.ts`:

```ts
import type { Store } from '../store/store.ts';
import { reconcileAccounts } from './accounts.ts';
import { reconcileTransactions, type TransactionReconciliation } from './transactions.ts';
import type { AccountReconciliation, SourceView } from './types.ts';

/** Earlier entries win ties. Pierre is the primary source for recent data and Pluggy the cross-check. */
export const DEFAULT_SOURCE_PRIORITY: readonly string[] = ['pierre', 'pluggy'];

export interface RunOptions {
  priority?: readonly string[];
  now?: () => Date;
}

/** Sources that have never been synced are left out, so they do not make every account look incomplete. */
export function loadSourceViews(store: Store, priority: readonly string[]): SourceView[] {
  const freshness = store.listFreshness();
  const views: SourceView[] = [];
  priority.forEach((sourceId, index) => {
    const accounts = store.listSourceAccounts(sourceId);
    if (accounts.length === 0) return;
    views.push({
      sourceId,
      priority: index,
      accounts,
      transactions: store.listSourceTransactions(sourceId),
      freshness: freshness.filter((f) => f.sourceId === sourceId),
    });
  });
  return views;
}

/** Rebuilds the canonical accounts from the stored source records and saves them. */
export function runAccountReconciliation(store: Store, options: RunOptions = {}): AccountReconciliation {
  const now = options.now ?? (() => new Date());
  const result = reconcileAccounts(loadSourceViews(store, options.priority ?? DEFAULT_SOURCE_PRIORITY));
  store.replaceCanonicalAccounts(result.accounts, result.groups, now().toISOString());
  return result;
}

export interface FullReconciliation {
  accounts: AccountReconciliation;
  transactions: TransactionReconciliation;
}

/** Rebuilds canonical accounts, then canonical transactions and findings, and saves all of them. */
export function runReconciliation(store: Store, options: RunOptions & { staleDays?: { bank?: number; card?: number } } = {}): FullReconciliation {
  const now = options.now ?? (() => new Date());
  const accounts = runAccountReconciliation(store, options);
  const views = loadSourceViews(store, options.priority ?? DEFAULT_SOURCE_PRIORITY);
  const transactions = reconcileTransactions({
    accounts: accounts.accounts,
    sources: views.map((v) => ({ sourceId: v.sourceId, priority: v.priority, transactions: v.transactions, freshness: v.freshness })),
    now: now(),
    staleDays: options.staleDays,
  });
  const stamp = now().toISOString();
  store.replaceCanonicalTransactions(transactions.transactions, transactions.links, stamp);
  store.syncFindings(transactions.findings, stamp);
  return { accounts, transactions };
}
```

Crie `src/reconcile/report.ts`:

```ts
import type { TransactionReconciliation } from './transactions.ts';

const PASS_LABELS = ['', 'same instant', 'same day', 'installment', 'same amount within 36 hours'];

/** Plain-text summary of a transaction reconciliation. `limit` caps the findings listed per kind. */
export function formatTransactionReport(result: TransactionReconciliation, limit = 10): string[] {
  const { stats, findings } = result;
  const lines: string[] = [];
  lines.push(
    `Transactions: ${stats.groups} (confirmed ${stats.byState.confirmed}, single source ${stats.byState.single_source}, ` +
      `status conflict ${stats.byState.conflict}, set aside as stale pending ${stats.byState.stale_pending})`,
  );
  const joined = stats.byPass
    .map((n, pass) => (pass === 0 || n === 0 ? null : `${PASS_LABELS[pass]} ${n}`))
    .filter((x): x is string => x !== null);
  lines.push(`Joined across sources by: ${joined.length > 0 ? joined.join(', ') : 'nothing'}`);

  if (findings.length === 0) {
    lines.push('Findings: none');
    return lines;
  }
  const groups = new Map<string, typeof findings>();
  for (const f of findings) {
    const key = `${f.kind} (${f.severity})`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  lines.push(`Findings: ${[...groups].map(([key, list]) => `${list.length} ${key}`).join(', ')}`);
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('');
    lines.push(`${key}:`);
    for (const f of list.slice(0, limit)) lines.push(`  - ${f.summary}`);
    if (list.length > limit) lines.push(`  ... ${list.length - limit} more (run with --all)`);
  }
  return lines;
}
```

Crie `src/reconcile/reconcile-cli.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { formatBRL } from '../core/money.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { summarizeAccounts } from './accounts.ts';
import { formatTransactionReport } from './report.ts';
import { runReconciliation } from './run.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const showAll = process.argv.includes('--all');
const unknown = process.argv.slice(2).filter((a) => a !== '--all');
if (unknown.length > 0) {
  console.error(`error: Unknown argument: ${unknown.join(' ')}`);
  process.exit(2);
}

const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
try {
  const { accounts, transactions } = runReconciliation(store);
  if (accounts.accounts.length === 0) {
    console.error('No accounts found. Run `npm run sync` first.');
    process.exitCode = 1;
  } else {
    const totals = summarizeAccounts(accounts.accounts);
    console.log(`Accounts: ${accounts.accounts.length} (bank balance ${formatBRL(totals.bankBalance)}, cards owed ${formatBRL(totals.cardOwed)})`);
    for (const line of formatTransactionReport(transactions, showAll ? Number.MAX_SAFE_INTEGER : 10)) console.log(line);
  }
} finally {
  store.close();
}
```

- [ ] **Step 4: Acrescentar o script ao `package.json`**

Em `scripts`, depois de `accounts`, acrescente:

```json
"reconcile": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/reconcile/reconcile-cli.ts"
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 168 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 6: Testar o comando sem dados e com argumento inválido**

Run:

```bash
env -i PATH="$PATH" DB_PATH=/tmp/gmf-empty.sqlite node --disable-warning=ExperimentalWarning src/reconcile/reconcile-cli.ts; echo "exit=$?"
env -i PATH="$PATH" DB_PATH=/tmp/gmf-empty.sqlite node --disable-warning=ExperimentalWarning src/reconcile/reconcile-cli.ts --bogus; echo "exit=$?"
rm -f /tmp/gmf-empty.sqlite /tmp/gmf-empty.sqlite-wal /tmp/gmf-empty.sqlite-shm
```

Expected: ``No accounts found. Run `npm run sync` first.`` com `exit=1`, e `error: Unknown argument: --bogus` com `exit=2`.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os arquivos novos e modificados desta tarefa.

---

### Task 5: Aceitação com os dados reais (depende de D2-B)

**Files:** nenhum arquivo do repositório.

**Interfaces:**
- Consumes: `data/gmf.sqlite` com as duas fontes sincronizadas.
- Produces: o relatório de transações e divergências.

- [ ] **Step 1: Sincronizar para ter dados atuais (opcional)**

Run: `npm run sync -- --since 2026-07-28`
No sandbox do Claude Code, prefixe com `NODE_USE_ENV_PROXY=1`. Expected: uma linha por fonte, sem `error:`.

- [ ] **Step 2: Rodar a reconciliação**

Run: `npm run reconcile`
Expected: a linha de contas, a linha de transações com a divisão por estado, a linha das passadas que juntaram registros (a maior parte "same instant"), a contagem de divergências por tipo e, abaixo, as dez primeiras de cada tipo. Use `npm run reconcile -- --all` para listar todas.

- [ ] **Step 3: Conferir que o resultado faz sentido**

- A quantidade de transações canônicas deve ser menor que a soma dos registros das duas fontes, porque as confirmadas contam uma vez só (as cópias duplicadas de cartão já ficam fora).
- A maioria deve estar `confirmed`. Os `single_source` e as divergências `missing_in_source` são, em geral, pagamentos de fatura e estornos que uma das fontes não traz.
- Os `stale_pending` devem ser lançamentos de cartão pendentes há mais de 30 dias, que só uma das fontes ainda lista.
- Divergências `not_yet_synced` devem ser lançamentos recentes que uma fonte ainda não leu; elas somem depois da próxima sincronização dessa fonte.

- [ ] **Step 4: Conferir a idempotência**

Run: `npm run reconcile > /tmp/rec-1.txt; npm run reconcile > /tmp/rec-2.txt; diff /tmp/rec-1.txt /tmp/rec-2.txt && echo "saida identica"; rm -f /tmp/rec-1.txt /tmp/rec-2.txt`
Expected: `saida identica`.

- [ ] **Step 5: Conferir o que foi gravado (somente leitura)**

Run:

```bash
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/gmf.sqlite");
console.log("transacoes", JSON.stringify(db.prepare("SELECT state, COUNT(*) n FROM transactions GROUP BY state").all()));
console.log("vinculos por passada", JSON.stringify(db.prepare("SELECT match_pass, COUNT(*) n FROM transaction_links GROUP BY match_pass").all()));
console.log("divergencias abertas", JSON.stringify(db.prepare("SELECT kind, severity, COUNT(*) n FROM reconciliation_findings WHERE resolved_at IS NULL GROUP BY kind, severity").all()));
'
```

Expected: as contagens coincidem com as do relatório do passo 2.

- [ ] **Step 6: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `data/` não aparece, porque está no `.gitignore`.

---

## Fora deste plano

- Regras do usuário sobre divergências (marcar como aceita, corrigir categorias, lançar manualmente): quando houver a interface.
- Critério de caixa e de competência, grupos de categorias, detecção de recorrências e projeção de parcelas: dependem das transações canônicas deste plano e entram nos planos de widgets.
- Mapeamento de ids estáveis quando uma transação só de uma fonte ganha par por descrição diferente: depende de haver dados do usuário ligados aos ids.
- Uso da diferença de `lastUpdatedAt` para trocar a fonte lida de uma instituição inteira: o saldo e as notas já seguem essa regra; a leitura de transações junta as duas fontes e não escolhe uma.

## Auto-revisão contra o design

- Seção 4, Reconciliação (três passadas, estados confirmada, fonte única e conflito, "ainda não sincronizada" contra divergência real, pendente parado fora dos totais): Tarefa 2. O design previa três passadas; a quarta (parcela) veio dos dados reais, em que as fontes datam parcelas de formas diferentes.
- Seção 4, regra de qual fonte vale: prioridade para os campos e `posted` vence `pending`; a escolha por frescor segue no saldo (Plano D1).
- Seção 6 (tabelas `transactions`, `transaction_source_records`/vínculos, `reconciliation_findings`): Tarefa 3. A coluna de acordo ("aceita") fica para o plano da interface.
- Seção 11 (reconciliação determinística, reexecutável sem duplicar achados): ids estáveis das divergências e sincronização por `last_seen_at` (Tarefas 2 e 3).
