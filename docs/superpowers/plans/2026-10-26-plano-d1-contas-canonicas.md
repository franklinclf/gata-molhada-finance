# Gata Molhada Finance, Plano D1: contas canônicas (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partir dos registros por fonte já sincronizados, construir as contas canônicas: uma linha por conta real, sem cartões duplicados, com saldo da fonte mais recente, grupos de limite compartilhado e totais corretos, e um comando `npm run accounts` que mostra o resultado.

**Architecture:** `reconcileAccounts` é uma função pura que recebe uma visão de cada fonte (contas, transações, frescor) e devolve contas canônicas, grupos de limite e notas. Ela agrupa as contas das fontes em clusters por transações em comum, trata cópias duplicadas de um cartão dentro de uma fonte, escolhe o saldo pela fonte mais recente de cada instituição e detecta limites compartilhados. `runAccountReconciliation` lê o `Store`, chama a função e grava o resultado em tabelas derivadas, substituídas por inteiro a cada execução. As transações canônicas e as divergências ficam no Plano D2.

**Tech Stack:** Node 22 (`node:sqlite`, `node:crypto`, `node:test`), TypeScript por remoção de tipos. Nenhuma dependência nova.

## Global Constraints

- Node >= 22.18, TypeScript por remoção de tipos: só sintaxe apagável (sem `enum`, `namespace` nem propriedades de parâmetro no construtor), `import type` para tipos e extensão `.ts` em todo import relativo.
- Sem dependências novas. Valores monetários em centavos inteiros. Datas em ISO 8601 UTC.
- Repositório público: testes e fixtures só têm dados sintéticos e nomes neutros (nada de bancos, cartões, ids ou valores reais).
- O `core` não conhece nenhum adapter nem fonte específica: a reconciliação recebe fontes genéricas com prioridade. Só `src/reconcile/run.ts` conhece a ordem `pierre`, `pluggy`.
- Quem executa este plano não faz commit nem push sem pedido explícito do usuário. A `main` é protegida: o trabalho vai em branch.
- Identificadores e comentários em inglês. Documentação em português.
- Raiz do projeto: `~/IdeaProjects/pierre-finance-app`. Todos os caminhos são relativos a ela.

## Aprovações e decisões (perguntas ao usuário, não passos)

- **D1-A** (Tarefa 4): posso acrescentar o script `accounts` ao `package.json`? Nenhuma dependência é instalada.
- **D1-B** (Tarefa 5): posso rodar `npm run accounts` com o banco real? Ele só lê as tabelas `source_*` e grava as tabelas derivadas em `data/gmf.sqlite`, sem fazer chamadas de rede.

Decisões de design deste plano (revisáveis antes de executar):

1. **Prioridade das fontes:** `pierre` primeiro, `pluggy` depois. A prioridade desempata o nome e o saldo quando as duas fontes têm a mesma idade de dado.
2. **Pareamento de contas entre fontes:** pelas transações em comum. A chave forte é o mesmo instante, valor e descrição original; a chave fraca é o mesmo dia e valor. Cada chave forte vale 10 pontos e cada fraca 1. Uma conta só pareia com contas da mesma espécie e da mesma instituição (comparada sem acentos nem maiúsculas). Sem transações em comum, pareia por instituição, espécie e nome.
3. **Cartão listado mais de uma vez por uma fonte:** o Pluggy mostra o mesmo cartão sob dois itens quando um banco consolida cartões de outro. Contas da mesma fonte com a mesma espécie, os mesmos últimos dígitos e o mesmo nome formam um grupo de cópias: a cópia da instituição que pareia com a outra fonte vira a conta principal e as demais viram `duplicate`. Só cartões com `last4` entram nessa regra.
4. **Saldo:** vem da fonte com o `lastUpdatedAt` mais recente para a instituição da conta, e o empate vai para a prioridade. Limite, disponível, pagamento mínimo e vencimento vêm da mesma conta escolhida; o que faltar nela vem das outras fontes, na ordem de prioridade.
5. **Grupo de limite compartilhado:** cartões da mesma instituição com o mesmo limite e o mesmo disponível, e com algo já usado. Cartões sem uso e com limites iguais não formam grupo, porque seriam indistinguíveis de cartões separados. Esse é um limite conhecido da regra.
6. **Totais:** o saldo bancário soma contas correntes e poupanças. A dívida de cartão e o limite contam um grupo de limite uma vez só.
7. **Id canônico:** `acc_` mais os 16 primeiros caracteres do SHA-256 de `espécie|instituição normalizada|nome normalizado`, com sufixo da conta principal se houver colisão. Não depende da ordem das fontes. Se o banco renomear a conta, o id muda; um mecanismo de renomeação fica para quando houver dados do usuário ligados aos ids.
8. **Dados derivados:** as tabelas `accounts`, `account_source_refs` e `limit_groups` são apagadas e recriadas a cada execução, numa transação. As notas (divergências de saldo, cópias ignoradas, contas que só existem numa fonte) são impressas, não gravadas; a tabela de divergências é do Plano D2.
9. **Fontes nunca sincronizadas** são ignoradas, para não gerar a nota "não encontrada" em todas as contas.

---

### Task 1: Nomes normalizados e tipos canônicos

**Files:**
- Create: `src/reconcile/names.ts`, `src/core/canonical.ts`, `src/reconcile/types.ts`
- Create: `tests/support/builders.ts`
- Test: `tests/reconcile/names.test.ts`

**Interfaces:**
- Consumes: `Cents` de `src/core/money.ts`; `AccountKind`, `Freshness`, `SourceAccount`, `SourceId`, `SourceTransaction` de `src/core/types.ts`.
- Produces: `normalizeName(value): string` e `institutionKey(institution): string`; em `src/core/canonical.ts`, `AccountRole`, `AccountRef`, `CanonicalAccount`, `LimitGroup`; em `src/reconcile/types.ts`, `SourceView`, `AccountReconciliation`, `AccountTotals`; construtores de teste `account()`, `card()`, `tx()`, `history()`, `view()`, `fresh()`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/reconcile/names.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { institutionKey, normalizeName } from '../../src/reconcile/names.ts';

test('normalizeName removes accents, case and punctuation', () => {
  assert.equal(normalizeName('Crédito Útil Múltiplo MC Plat'), 'credito util multiplo mc plat');
  assert.equal(normalizeName('  PAGA2  INSTITUICAO-DE PAGAMENTO S.A. '), 'paga2 instituicao de pagamento s a');
});

test('institutionKey matches names written differently', () => {
  assert.equal(institutionKey('Crédito Útil'), institutionKey('CREDITO UTIL'));
  assert.notEqual(institutionKey('Banco Central'), institutionKey('Banco Central Cartões'));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/reconcile/names.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/reconcile/names.ts`.

- [ ] **Step 3: Implementar os nomes, os tipos e os construtores de teste**

Crie `src/reconcile/names.ts`:

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

Crie `src/core/canonical.ts`:

```ts
import type { Cents } from './money.ts';
import type { AccountKind, SourceId } from './types.ts';

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
```

Crie `src/reconcile/types.ts`:

```ts
import type { CanonicalAccount, LimitGroup } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import type { Freshness, SourceAccount, SourceId, SourceTransaction } from '../core/types.ts';

/** One source as the reconciliation sees it. A lower `priority` number wins ties. */
export interface SourceView {
  sourceId: SourceId;
  priority: number;
  accounts: SourceAccount[];
  transactions: SourceTransaction[];
  freshness: Freshness[];
}

export interface AccountReconciliation {
  accounts: CanonicalAccount[];
  groups: LimitGroup[];
  notes: string[];
}

export interface AccountTotals {
  /** Checking and savings balances. */
  bankBalance: Cents;
  /** Amount owed on credit cards, counting a shared limit group once. */
  cardOwed: Cents;
  creditLimit: Cents;
  creditUsed: Cents;
  creditAvailable: Cents;
}
```

Crie `tests/support/builders.ts`:

```ts
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';
import type { SourceView } from '../../src/reconcile/types.ts';

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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 110 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 5 arquivos novos desta tarefa.

---

### Task 2: Reconciliação de contas

**Files:**
- Create: `src/reconcile/accounts.ts`
- Test: `tests/reconcile/accounts.test.ts`

**Interfaces:**
- Consumes: `SourceView`, `CanonicalAccount`, `LimitGroup`, `normalizeName`, `institutionKey`, `formatBRL`; construtores de teste da Tarefa 1.
- Produces: `reconcileAccounts(views: SourceView[]): AccountReconciliation` com `{ accounts, groups, notes }`; `summarizeAccounts(accounts: CanonicalAccount[]): AccountTotals` com `{ bankBalance, cardOwed, creditLimit, creditUsed, creditAvailable }`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/reconcile/accounts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAccounts, summarizeAccounts } from '../../src/reconcile/accounts.ts';
import { account, card, fresh, history, tx, view } from '../support/builders.ts';

const T_OLD = '2026-10-25T20:00:00.000Z';
const T_NEW = '2026-10-26T15:00:00.000Z';

test('pairs the same account across sources by shared transactions', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1' })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.accounts[0]?.refs.map((r) => `${r.sourceId}:${r.externalId}:${r.role}`), ['pierre:p1:member', 'pluggy:g1:member']);
});

test('does not pair accounts of different institutions even with equal transactions', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', institution: 'Bank A' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', institution: 'Bank B' })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts.length, 2);
});

test('matches institution names written with different accents and case', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', institution: 'Crédito Útil' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', institution: 'CREDITO UTIL' })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts.length, 1);
});

test('chooses the right account among several of one institution', () => {
  const pierreTx = [...history('p-check', 'pa', 4), ...history('p-card', 'pb', 0)];
  const pluggyChecking = history('g-check', 'ga', 4);
  const pluggyOther = [tx({ externalId: 'x1', accountExternalId: 'g-other', amount: -99999, descriptionRaw: 'UNRELATED' })];
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p-check' })], transactions: pierreTx }),
    view('pluggy', 1, {
      accounts: [account({ externalId: 'g-other', name: 'Outra' }), account({ externalId: 'g-check' })],
      transactions: [...pluggyChecking, ...pluggyOther],
    }),
  ]);
  const paired = result.accounts.find((a) => a.refs.some((r) => r.sourceId === 'pierre'));
  assert.deepEqual(paired?.refs.map((r) => r.externalId), ['p-check', 'g-check']);
  assert.equal(result.accounts.length, 2);
});

test('pairs accounts without transactions by institution, kind and name', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', kind: 'savings', name: 'Poupança' })] }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', kind: 'savings', name: 'poupanca' })] }),
  ]);
  assert.equal(result.accounts.length, 1);
});

test('keeps accounts that exist in only one source and says so', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, {
      accounts: [account({ externalId: 'g1' }), card({ externalId: 'g2', institution: 'Bank A', name: 'Cartao Solto', last4: '9999' })],
      transactions: history('g1', 'gt'),
    }),
  ]);
  assert.equal(result.accounts.length, 2);
  assert.ok(result.notes.some((n) => /Cartao Solto: not found in pierre/.test(n)));
});

test('does not complain about the manual wallet missing from other sources', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'w', institution: 'Manual', kind: 'savings', name: 'Carteira' })] }),
    view('pluggy', 1, { accounts: [] }),
  ]);
  assert.equal(result.notes.length, 0);
});

test('treats a card listed twice by one source as a single card', () => {
  const copyUnderA = card({ externalId: 'g-a', institution: 'Bank A' });
  const copyUnderB = card({ externalId: 'g-b', institution: 'Bank B' });
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [card({ externalId: 'p1', last4: null })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, {
      accounts: [copyUnderB, copyUnderA],
      transactions: [...history('g-a', 'ga'), ...history('g-b', 'gb')],
    }),
  ]);
  assert.equal(result.accounts.length, 1);
  const refs = result.accounts[0]?.refs.map((r) => `${r.sourceId}:${r.externalId}:${r.role}`);
  assert.deepEqual(refs, ['pierre:p1:member', 'pluggy:g-a:member', 'pluggy:g-b:duplicate']);
  assert.equal(result.accounts[0]?.last4, '1234');
  assert.ok(result.notes.some((n) => /ignored a duplicate copy in pluggy \(listed under Bank B\)/.test(n)));
});

test('a duplicated card seen only by one source keeps the copy with the freshest institution', () => {
  const result = reconcileAccounts([
    view('pluggy', 0, {
      accounts: [card({ externalId: 'g-a', institution: 'Bank A' }), card({ externalId: 'g-b', institution: 'Bank B' })],
      freshness: [fresh('pluggy', 'Bank A', T_OLD), fresh('pluggy', 'Bank B', T_NEW)],
    }),
  ]);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0]?.institution, 'Bank B');
});

test('uses the balance of the source that synced the institution most recently', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [account({ externalId: 'p1', balance: 500000 })],
      transactions: history('p1', 'pt'),
      freshness: [fresh('pierre', 'Bank A', T_NEW)],
    }),
    view('pluggy', 1, {
      accounts: [account({ externalId: 'g1', balance: 514051 })],
      transactions: history('g1', 'gt'),
      freshness: [fresh('pluggy', 'Bank A', T_OLD)],
    }),
  ]);
  const a = result.accounts[0];
  assert.equal(a?.balance, 500000);
  assert.equal(a?.balanceSourceId, 'pierre');
  assert.equal(a?.balanceAsOf, T_NEW);
  assert.ok(result.notes.some((n) => /balances differ/.test(n) && /using pierre/.test(n)));
});

test('prefers the other source when it is the fresher one', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', balance: 100 })], transactions: history('p1', 'pt'), freshness: [fresh('pierre', 'Bank A', T_OLD)] }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', balance: 200 })], transactions: history('g1', 'gt'), freshness: [fresh('pluggy', 'Bank A', T_NEW)] }),
  ]);
  assert.equal(result.accounts[0]?.balance, 200);
  assert.equal(result.accounts[0]?.balanceSourceId, 'pluggy');
});

test('falls back to source priority when no freshness is known', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', balance: 100 })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', balance: 200 })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts[0]?.balance, 100);
  assert.equal(result.accounts[0]?.balanceAsOf, null);
});

test('fills card limits from another source when the chosen one has none', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [card({ externalId: 'p1', last4: null, creditLimit: null, availableLimit: null })],
      transactions: history('p1', 'pt'),
      freshness: [fresh('pierre', 'Bank A', T_NEW)],
    }),
    view('pluggy', 1, { accounts: [card({ externalId: 'g1' })], transactions: history('g1', 'gt'), freshness: [fresh('pluggy', 'Bank A', T_OLD)] }),
  ]);
  assert.equal(result.accounts[0]?.creditLimit, 500000);
  assert.equal(result.accounts[0]?.availableLimit, 470000);
});

test('cards of one institution that report the same used limit form a shared group', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [
        card({ externalId: 'c1', name: 'Card One', last4: '1111', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c2', name: 'Card Two', last4: '2222', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c3', name: 'Card Three', last4: '3333', balance: 30943, creditLimit: 150000, availableLimit: 119057 }),
      ],
    }),
  ]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.memberIds.length, 2);
  const grouped = result.accounts.filter((a) => a.limitGroupId !== null);
  assert.deepEqual(grouped.map((a) => a.name).sort(), ['Card One', 'Card Two']);
});

test('unused cards with equal limits are not treated as one pool', () => {
  const unused = { balance: 0, creditLimit: 500000, availableLimit: 500000 };
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [card({ externalId: 'c1', name: 'One', last4: '1', ...unused }), card({ externalId: 'c2', name: 'Two', last4: '2', ...unused })] }),
  ]);
  assert.equal(result.groups.length, 0);
});

test('summary counts a shared limit once and separates bank money from card debt', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [
        account({ externalId: 'b1', balance: 500000 }),
        account({ externalId: 'b2', name: 'Poupanca', kind: 'savings', balance: 100000 }),
        card({ externalId: 'c1', name: 'Card One', last4: '1111', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c2', name: 'Card Two', last4: '2222', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c3', name: 'Card Three', last4: '3333', balance: 30943, creditLimit: 150000, availableLimit: 119057 }),
      ],
    }),
  ]);
  assert.deepEqual(summarizeAccounts(result.accounts), {
    bankBalance: 600000,
    cardOwed: 360215,
    creditLimit: 1990000,
    creditUsed: 360215,
    creditAvailable: 1629785,
  });
});

test('a card with a balance but no limit counts only as debt', () => {
  const result = reconcileAccounts([view('pierre', 0, { accounts: [card({ externalId: 'c1', creditLimit: null, availableLimit: null, balance: 5000 })] })]);
  assert.deepEqual(summarizeAccounts(result.accounts), { bankBalance: 0, cardOwed: 5000, creditLimit: 0, creditUsed: 0, creditAvailable: 0 });
});

test('canonical ids are stable and do not depend on input order', () => {
  const pierre = view('pierre', 0, { accounts: [account({ externalId: 'p1' }), account({ externalId: 'p2', name: 'Poupanca', kind: 'savings' })] });
  const pluggy = view('pluggy', 1, { accounts: [account({ externalId: 'g2', name: 'Poupanca', kind: 'savings' }), account({ externalId: 'g1' })] });
  const a = reconcileAccounts([pierre, pluggy]).accounts.map((x) => x.id).sort();
  const b = reconcileAccounts([pluggy, pierre]).accounts.map((x) => x.id).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 2);
  assert.ok(a.every((id) => /^acc_[0-9a-f]{16}$/.test(id)));
});

test('two accounts with the same kind and name in one institution still get distinct ids', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'a' }), account({ externalId: 'b' })] }),
  ]);
  assert.equal(result.accounts.length, 2);
  assert.notEqual(result.accounts[0]?.id, result.accounts[1]?.id);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/reconcile/accounts.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/reconcile/accounts.ts`.

- [ ] **Step 3: Implementar**

Crie `src/reconcile/accounts.ts`:

```ts
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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 129 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 2 arquivos novos desta tarefa.

---

### Task 3: Tabelas e métodos do Store para as contas canônicas

**Files:**
- Create: `migrations/003_canonical_accounts.sql`
- Replace: `src/store/store.ts`, `src/store/sqlite-store.ts`
- Modify: `tests/store/sqlite-store.test.ts`, `tests/http/router.test.ts`
- Test: `tests/store/canonical-accounts.test.ts`

**Interfaces:**
- Consumes: `CanonicalAccount`, `LimitGroup` de `src/core/canonical.ts`.
- Produces: no `Store`, `replaceCanonicalAccounts(accounts, groups, builtAt)` (apaga e recria tudo numa transação), `listCanonicalAccounts()` (com `refs`, membros antes de duplicatas) e `listLimitGroups()` (com `memberIds`). A versão do esquema passa a 3.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/store/canonical-accounts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { CanonicalAccount, LimitGroup } from '../../src/core/canonical.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T1 = '2026-10-26T10:00:00.000Z';
const T2 = '2026-10-26T12:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T1);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T1);
  return store;
}

const account = (overrides: Partial<CanonicalAccount> = {}): CanonicalAccount => ({
  id: 'acc_1',
  institution: 'Bank A',
  kind: 'credit_card',
  name: 'Cartao Exemplo',
  last4: '1234',
  balance: 30000,
  balanceSourceId: 'pierre',
  balanceAsOf: T1,
  creditLimit: 500000,
  availableLimit: 470000,
  minimumPayment: 4800,
  dueDate: '2026-11-10',
  limitGroupId: 'lg_1',
  refs: [
    { sourceId: 'pierre', externalId: 'p1', role: 'member' },
    { sourceId: 'pluggy', externalId: 'g1', role: 'member' },
    { sourceId: 'pluggy', externalId: 'g2', role: 'duplicate' },
  ],
  ...overrides,
});

const group: LimitGroup = { id: 'lg_1', institution: 'Bank A', creditLimit: 500000, memberIds: ['acc_1', 'acc_2'] };

test('stores canonical accounts with their references and limit groups', () => {
  const store = newStore();
  const second = account({ id: 'acc_2', name: 'Outro', last4: '5678', refs: [{ sourceId: 'pierre', externalId: 'p2', role: 'member' }] });
  store.replaceCanonicalAccounts([account(), second], [group], T1);
  const accounts = store.listCanonicalAccounts();
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.find((a) => a.id === 'acc_1'), account());
  assert.deepEqual(store.listLimitGroups(), [group]);
});

test('replacing removes accounts, groups and references that are no longer present', () => {
  const store = newStore();
  store.replaceCanonicalAccounts([account()], [group], T1);
  store.replaceCanonicalAccounts([account({ id: 'acc_9', limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'p9', role: 'member' }] })], [], T2);
  const accounts = store.listCanonicalAccounts();
  assert.deepEqual(accounts.map((a) => a.id), ['acc_9']);
  assert.deepEqual(store.listLimitGroups(), []);
});

test('a failing replace keeps the previous canonical data', () => {
  const store = newStore();
  store.replaceCanonicalAccounts([account()], [group], T1);
  const broken = account({ id: 'acc_dup' });
  assert.throws(() => store.replaceCanonicalAccounts([broken, broken], [], T2), /UNIQUE|constraint/i);
  assert.deepEqual(store.listCanonicalAccounts().map((a) => a.id), ['acc_1']);
});

test('a source reference can point at only one canonical account', () => {
  const store = newStore();
  const a = account({ id: 'acc_1', limitGroupId: null });
  const b = account({ id: 'acc_2', limitGroupId: null });
  assert.throws(() => store.replaceCanonicalAccounts([a, b], [], T1), /UNIQUE|constraint/i);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/store/canonical-accounts.test.ts`
Expected: FAIL com `store.replaceCanonicalAccounts is not a function`.

- [ ] **Step 3: Criar a migração**

Crie `migrations/003_canonical_accounts.sql`:

```sql
-- Canonical accounts: one row per real-world account, built from the source_* tables.
-- These rows are derived data, rebuilt by the account reconciliation.

CREATE TABLE limit_groups (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,
  credit_limit INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  last4 TEXT,
  balance INTEGER NOT NULL,
  balance_source_id TEXT,
  balance_as_of TEXT,
  credit_limit INTEGER,
  available_limit INTEGER,
  minimum_payment INTEGER,
  due_date TEXT,
  limit_group_id TEXT REFERENCES limit_groups(id),
  built_at TEXT NOT NULL
);

CREATE TABLE account_source_refs (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX idx_account_source_refs_account ON account_source_refs (account_id);
```

- [ ] **Step 4: Substituir a interface e a implementação do Store**

Substitua o conteúdo de `src/store/store.ts`:

```ts
import type { CanonicalAccount, LimitGroup } from '../core/canonical.ts';
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
  /** Replaces all canonical accounts, limit groups and source references in one transaction. */
  replaceCanonicalAccounts(accounts: CanonicalAccount[], groups: LimitGroup[], builtAt: string): void;
  listCanonicalAccounts(): CanonicalAccount[];
  listLimitGroups(): LimitGroup[];
  close(): void;
}
```

Substitua o conteúdo de `src/store/sqlite-store.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountRef, CanonicalAccount, LimitGroup } from '../core/canonical.ts';
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

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Atualizar a versão do esquema nos testes existentes**

Em `tests/store/sqlite-store.test.ts`, no teste `applies the real migrations on open`, troque `assert.equal(store.schemaVersion(), 2);` por `assert.equal(store.schemaVersion(), 3);`.

Em `tests/http/router.test.ts`, no teste `GET /healthz reports ok with version and schema version`, troque `schemaVersion: 2,` por `schemaVersion: 3,`.

- [ ] **Step 6: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 133 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: a migração, os dois arquivos de `src/store/` modificados, os dois testes ajustados e o teste novo.

---

### Task 4: Serviço de reconciliação e comando `accounts` (depende de D1-A)

**Files:**
- Create: `src/reconcile/run.ts`, `src/reconcile/cli.ts`
- Modify: `package.json` (script `accounts`)
- Test: `tests/reconcile/run.test.ts`

**Interfaces:**
- Consumes: `reconcileAccounts`, `summarizeAccounts`, `Store`, `loadConfig`, `formatBRL`.
- Produces: `DEFAULT_SOURCE_PRIORITY` (`['pierre', 'pluggy']`); `loadSourceViews(store, priority): SourceView[]`; `runAccountReconciliation(store, { priority?, now? }): AccountReconciliation`; o comando `npm run accounts` (saída 0 com contas, 1 sem contas sincronizadas).

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/reconcile/run.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSourceViews, runAccountReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, history } from '../support/builders.ts';

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test --disable-warning=ExperimentalWarning tests/reconcile/run.test.ts`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `src/reconcile/run.ts`.

- [ ] **Step 3: Implementar o serviço e o comando**

Crie `src/reconcile/run.ts`:

```ts
import type { Store } from '../store/store.ts';
import { reconcileAccounts } from './accounts.ts';
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
```

Crie `src/reconcile/cli.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { formatBRL } from '../core/money.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { summarizeAccounts } from './accounts.ts';
import { runAccountReconciliation } from './run.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);

try {
  const result = runAccountReconciliation(store);
  if (result.accounts.length === 0) {
    console.error('No accounts found. Run `npm run sync` first.');
    process.exitCode = 1;
  } else {
    const groupOf = new Map(result.groups.map((g, i) => [g.id, `G${i + 1}`]));
    console.log('Institution  Kind         Name                        Last4  Balance          From    Pool  Sources');
    for (const a of result.accounts) {
      const sources = a.refs.map((r) => `${r.sourceId}${r.role === 'duplicate' ? '*' : ''}`).join(',');
      console.log(
        [
          a.institution.padEnd(12),
          a.kind.padEnd(12),
          a.name.slice(0, 26).padEnd(27),
          (a.last4 ?? '').padEnd(6),
          formatBRL(a.balance).padStart(14),
          ` ${(a.balanceSourceId ?? '').padEnd(7)}`,
          (a.limitGroupId ? (groupOf.get(a.limitGroupId) ?? '') : '').padEnd(5),
          sources,
        ].join(' '),
      );
    }
    console.log('  (* = duplicate copy ignored)');

    const totals = summarizeAccounts(result.accounts);
    console.log('');
    console.log(`Bank balance:     ${formatBRL(totals.bankBalance)}`);
    console.log(`Cards owed:       ${formatBRL(totals.cardOwed)}`);
    console.log(`Credit limit:     ${formatBRL(totals.creditLimit)} (used ${formatBRL(totals.creditUsed)}, available ${formatBRL(totals.creditAvailable)})`);
    if (result.notes.length > 0) {
      console.log('');
      console.log('Notes:');
      for (const note of result.notes) console.log(`  - ${note}`);
    }
  }
} finally {
  store.close();
}
```

- [ ] **Step 4: Acrescentar o script ao `package.json`**

Em `scripts`, depois de `sync`, acrescente:

```json
"accounts": "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/reconcile/cli.ts"
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: 137 testes, `# fail 0`, `typecheck` sem erros.

- [ ] **Step 6: Testar o comando com um banco vazio**

Run: `env -i PATH="$PATH" DB_PATH=/tmp/gmf-empty.sqlite node --disable-warning=ExperimentalWarning src/reconcile/cli.ts; echo "exit=$?"; rm -f /tmp/gmf-empty.sqlite /tmp/gmf-empty.sqlite-wal /tmp/gmf-empty.sqlite-shm`
Expected: ``No accounts found. Run `npm run sync` first.`` e `exit=1`.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os 3 arquivos desta tarefa e `package.json` modificado.

---

### Task 5: Aceitação com os dados reais (depende de D1-B)

**Files:** nenhum arquivo do repositório.

**Interfaces:**
- Consumes: `data/gmf.sqlite` com as duas fontes sincronizadas (Plano C, Tarefa 8).
- Produces: a lista de contas canônicas e os totais, para conferir com o app do Pierre.

- [ ] **Step 1: Rodar o comando**

Run: `npm run accounts`
Expected: uma tabela com uma linha por conta real; a coluna `Sources` mostra `pierre,pluggy` nas contas pareadas, e um asterisco (`pluggy*`) nas cópias duplicadas ignoradas; cartões que compartilham limite aparecem com o mesmo rótulo na coluna `Pool`. Depois da tabela vêm o saldo bancário, a dívida de cartões e o limite (total, usado e disponível), e a lista de notas.

- [ ] **Step 2: Conferir com o app do Pierre**

Compare estes valores com as telas do app (saldo em contas e limite usado):
- O saldo bancário do comando deve ser igual ao "Saldo em contas".
- A dívida de cartões e o limite usado devem ser iguais ao "Limite usado".
- O limite disponível pode diferir do app exatamente pelo limite de cartões que existem só numa das fontes (o app esconde cartões que ele não lista). A nota "not found in pierre" aponta quais são.

Se o saldo de uma conta diferir entre as fontes, a nota `balances differ` mostra os dois valores e a hora de cada um, e informa qual foi usado.

- [ ] **Step 3: Conferir a idempotência**

Run: `npm run accounts > /tmp/accounts-1.txt; npm run accounts > /tmp/accounts-2.txt; diff /tmp/accounts-1.txt /tmp/accounts-2.txt && echo "saida identica"; rm -f /tmp/accounts-1.txt /tmp/accounts-2.txt`
Expected: `saida identica`.

- [ ] **Step 4: Conferir o que foi gravado (somente leitura)**

Run: `node --disable-warning=ExperimentalWarning -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("data/gmf.sqlite"); console.log("contas", db.prepare("SELECT COUNT(*) n FROM accounts").get().n, "| referencias", db.prepare("SELECT role, COUNT(*) n FROM account_source_refs GROUP BY role").all().map((r) => r.role + "=" + r.n).join(", "), "| grupos", db.prepare("SELECT COUNT(*) n FROM limit_groups").get().n);'`
Expected: o número de contas igual ao da tabela do passo 1, referências `member` e `duplicate`, e o número de grupos de limite.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `data/` não aparece, porque está no `.gitignore`.

---

## Fora deste plano

- Transações canônicas, pareamento de transações entre fontes, estados `confirmed`, `single_source` e `conflict`, pendentes parados e a tabela de divergências: Plano D2.
- Usar a diferença de `lastUpdatedAt` para trocar a fonte de um banco inteiro (a regra de leitura por banco do design): o saldo já segue essa regra por conta; a leitura de transações segue no D2.
- Detectar limites compartilhados de cartões sem uso: exigiria uma configuração do usuário.
- Renomear contas mantendo o id: quando houver dados do usuário ligados aos ids.

## Auto-revisão contra o design

- Seção 4 (modelo canônico, conta única para cartões repetidos e grupos de limite): Tarefas 1, 2 e 3.
- Seção 4 (qual fonte vale por banco): saldo e limites pela fonte mais recente com desempate por prioridade (Tarefa 2). A leitura de transações por banco fica no D2.
- Seção 6 (tabelas `accounts`, `account_source_refs`, `limit_groups`): Tarefa 3. A série temporal `account_snapshots` não é criada aqui, porque nada a lê ainda.
- Seção 2 (cartões de limite compartilhado contados em dobro): corrigido nos totais da Tarefa 2 e conferido com o app na Tarefa 5.
