import { merchantOf } from '../core/merchant.ts';
import { localDay } from '../core/time.ts';
import { budgetsFor, suggestBudgets } from '../api/budgets.ts';
import { categoryParents } from '../api/category-groups.ts';
import { explore, type ExplorerQuery, type ExplorerRow } from '../api/explorer.ts';
import { forecast } from '../api/forecast.ts';
import { listGoals } from '../api/goals.ts';
import { unregisteredIncome } from '../api/income.ts';
import { listCategories } from '../api/mutations.ts';
import { netWorth } from '../api/networth.ts';
import { outlook } from '../api/outlook.ts';
import { detectRecurring } from '../api/recurring.ts';
import { suggestRules } from '../api/rule-suggestions.ts';
import { listRules } from '../api/rules.ts';
import { visibleAccounts } from '../api/scope.ts';
import { categoryTrend } from '../api/trends.ts';
import * as views from '../api/views.ts';
import type { Store } from '../store/store.ts';

/** A transaction the model was shown, as the code finds it again: its id in this run and one source record, which outlives a rebuild. */
export interface TxTarget {
  id: string;
  sourceId: string;
  externalId: string;
}

/**
 * Short handles ("t1", "f2") for what the model was shown in this run. The code maps them back to the real ids, so a write
 * step can only point at something the model saw in this run, and a handle from an earlier run, or an invented one, finds nothing.
 */
export class RefBook {
  readonly #values = new Map<string, unknown>();
  readonly #refOf = new Map<string, string>();

  issue(prefix: 't' | 'f', key: string, make: () => unknown): string {
    const known = this.#refOf.get(`${prefix}|${key}`);
    if (known !== undefined) return known;
    const ref = `${prefix}${this.#refOf.size + 1}`;
    this.#refOf.set(`${prefix}|${key}`, ref);
    this.#values.set(ref, make());
    return ref;
  }

  get<T>(ref: string, prefix: 't' | 'f'): T | undefined {
    return ref.startsWith(prefix) ? (this.#values.get(ref) as T | undefined) : undefined;
  }

  transaction(store: Store, id: string): string {
    return this.issue('t', id, (): TxTarget => {
      // A transaction typed in by hand has no source record: its id is the record.
      if (id.startsWith('man_')) return { id, sourceId: 'manual', externalId: id };
      const first = store.listTransactionLinks(id)[0];
      return { id, sourceId: first?.sourceId ?? '', externalId: first?.externalId ?? '' };
    });
  }

  finding(findingId: string): string {
    return this.issue('f', findingId, () => findingId);
  }
}

/** What a run keeps for its tools. Absent when a tool is called on its own (a test, a script). */
export interface ToolContext {
  refs: RefBook;
}

/** What the model may ask for. A read tool only reads, and every number is computed here, not by the model. */
export interface Tool {
  name: string;
  /** One line for the prompt, with the arguments. */
  help: string;
  run: (store: Store, now: Date, args: Record<string, unknown>, ctx?: ToolContext) => unknown;
}

const reais = (cents: number): number => Math.round(cents) / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_TEXT = 80;
const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** Same words the Cartões screen uses for the state of a bill. */
const STATUS: Record<string, string> = { open: 'em aberto', paid: 'paga', rolled: 'sobra rolou para a fatura seguinte', partial: 'paga em parte', unpaid: 'fechada, a pagar', overdue: 'vencida', empty: 'sem valor', unknown: 'pagamento não conferido' };
const statusText = (status: string | undefined): string | null => (status === undefined ? null : (STATUS[status] ?? status));

export class ToolError extends Error {}

function day(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ToolError(`${key} must look like 2026-10-28`);
  return value;
}

function month(args: Record<string, unknown>, today: string): string {
  const value = args.month;
  if (value === undefined || value === null || value === '') return today.slice(0, 7);
  if (typeof value !== 'string' || !MONTH.test(value)) throw new ToolError('month must look like 2026-10');
  return value;
}

function limit(args: Record<string, unknown>, fallback: number, max: number): number {
  const value = args.limit;
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolError('limit must be a positive whole number');
  return Math.min(value, max);
}

function range(args: Record<string, unknown>, today: string): { from: string; to: string } {
  const from = day(args, 'from', `${today.slice(0, 7)}-01`);
  const to = day(args, 'to', today);
  if (from > to) throw new ToolError('from must not be after to');
  return { from, to };
}

const accountLabel = (a: { institution: string; last4: string | null; name: string }): string => `${a.institution}${a.last4 ? ` ${a.last4}` : ` ${a.name}`}`;
const folded = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const texts = (value: unknown, max: number): string[] => (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim().slice(0, 60)).slice(0, max);

/** The accounts a name can mean: the label the tools show ("Banco 1234"), the account name, or the institution alone. */
function accountIdsFor(store: Store, names: string[]): string[] {
  const accounts = visibleAccounts(store);
  const ids = new Set<string>();
  for (const name of names) {
    const wanted = folded(name);
    const hits = accounts.filter((a) => [accountLabel(a), `${a.institution} ${a.last4 ?? ''}`, a.name, a.institution].some((label) => folded(label) === wanted));
    if (hits.length === 0) throw new ToolError(`no account is called "${name}"; use the accounts tool for the names`);
    for (const a of hits) ids.add(a.id);
  }
  return [...ids];
}

/** The filters the transaction tools share, read from the model's arguments. A value that is not valid is left out, as `transactions` always did. */
export function readFilter(store: Store, args: Record<string, unknown>, today: string, base: { defaultFrom: string | undefined; kind: 'all' | 'expense' | 'income' }): Pick<ExplorerQuery, 'from' | 'to' | 'kind' | 'q' | 'merchant' | 'categories' | 'min' | 'max' | 'accountIds' | 'recurrence'> {
  const from = day(args, 'from', base.defaultFrom ?? '');
  const to = day(args, 'to', today);
  if (from !== '' && from > to) throw new ToolError('from must not be after to');
  const kind = args.kind === 'income' ? 'income' : args.kind === 'expense' ? 'expense' : args.kind === 'all' ? 'all' : base.kind;
  const cents = (key: string) => (typeof args[key] === 'number' && Number.isFinite(args[key]) && (args[key] as number) >= 0 ? Math.round((args[key] as number) * 100) : undefined);
  const categories = [...texts(args.category, 1), ...texts(args.categories, 10)];
  const accountNames = texts(args.accounts, 10);
  return {
    from: from === '' ? undefined : from, to, kind,
    q: typeof args.q === 'string' && args.q.trim() ? args.q.trim().slice(0, 60) : undefined,
    merchant: typeof args.merchant === 'string' && args.merchant.trim() ? args.merchant.trim().slice(0, 60) : undefined,
    categories: categories.length > 0 ? categories : undefined,
    min: cents('min'), max: cents('max'),
    accountIds: accountNames.length > 0 ? accountIdsFor(store, accountNames) : undefined,
    recurrence: args.recurrence === 'subscription' || args.recurrence === 'recurring' || args.recurrence === 'any' ? args.recurrence : undefined,
  };
}

/** Every transaction a filter matches, one row each (a refund is not folded into its purchase), planned installments left out. */
export function matchingRows(store: Store, now: Date, filter: ReturnType<typeof readFilter>, extra: Partial<ExplorerQuery> = {}): ExplorerRow[] {
  const result = explore(store, { ...filter, sort: 'date_desc', limit: 100_000, offset: 0, spendingOnly: filter.kind === 'expense', hideOwnTransfers: false, includeExcluded: false, foldRefunds: false, ...extra }, now);
  return result.items.filter((t) => t.estimated !== true);
}

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIMENSIONS = ['category', 'group', 'merchant', 'month', 'account', 'institution', 'weekday'] as const;
type Dimension = (typeof DIMENSIONS)[number];
const MAX_GROUPS = 30;

export const TOOLS: Tool[] = [
  {
    name: 'summary',
    help: 'summary {month?} : visão geral do mês (saldo nas contas, o que falta pagar nas faturas, saldo devedor dos emissores, patrimônio, gastos, entradas e saídas, maiores categorias).',
    run: (store, now, args) => {
      const today = localDay(now.toISOString());
      const m = month(args, today);
      const from = `${m}-01`;
      const to = m === today.slice(0, 7) ? today : new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);
      const spend = views.spending(store, { from, to }, 'category', now);
      const flow = views.cashFlow(store, { from, to }, now);
      const worth = netWorth(store, now);
      const bills = views.cards(store, now);
      return {
        mes: m,
        saldoNasContas: reais(views.balances(store, now).total),
        // Same number as the Cartões screen ("A pagar"): open bills plus closed bills still unpaid. Installments of later bills are not in it.
        aPagarNasFaturas: reais(bills.totals.toPay),
        // What the issuers report as owed: bills plus every installment still to come. Larger than aPagarNasFaturas.
        saldoDevedorNosEmissores: reais(bills.totals.reportedByIssuer),
        patrimonio: reais(worth.net),
        gastosDoMes: reais(spend.total),
        entradasNasContas: reais(flow.inflow),
        saidasDasContas: reais(flow.outflow),
        maioresCategorias: spend.groups.slice(0, 8).map((g) => ({ categoria: g.name, valor: reais(g.amount), transacoes: g.count })),
      };
    },
  },
  {
    name: 'spending',
    help: 'spending {from?, to?, by: category|merchant, limit?<=20} : gastos do período (compras no cartão pela data da compra), agrupados.',
    run: (store, now, args) => {
      const today = localDay(now.toISOString());
      const r = range(args, today);
      const by = args.by === 'merchant' ? 'merchant' : 'category';
      const view = views.spending(store, r, by, now);
      return { de: r.from, ate: r.to, agrupadoPor: by, total: reais(view.total), grupos: view.groups.slice(0, limit(args, 12, 20)).map((g) => ({ nome: g.name, valor: reais(g.amount), transacoes: g.count, grupo: g.parent })) };
    },
  },
  {
    name: 'cashflow',
    help: 'cashflow {from?, to?} : o que entrou e saiu das contas bancárias no período (compras no cartão só contam quando a fatura é paga; aplicações e resgates de investimento ficam de fora e aparecem em investidoNoPeriodo).',
    run: (store, now, args) => {
      const r = range(args, localDay(now.toISOString()));
      const flow = views.cashFlow(store, r, now);
      return { de: r.from, ate: r.to, entrou: reais(flow.inflow), saiu: reais(flow.outflow), saldoDoPeriodo: reais(flow.net), investidoNoPeriodo: reais(flow.invested) };
    },
  },
  {
    name: 'transactions',
    help: 'transactions {from?, to?, q?, category?, merchant?, kind?: expense|income, min?, max? (reais, valor absoluto), accounts?: [nomes], recurrence?: subscription|recurring|any, limit?<=25} : lista de transações e a soma de todas as que combinam. Cada linha traz um ref (t1, t2...) que as ferramentas de alteração aceitam nesta conversa. nome é o nome que o dono deu à transação (numa parcela, com o contador 2/5); ao falar dela, use o nome. descricao é sempre o texto do banco, e q busca nos dois.',
    run: (store, now, args, ctx) => {
      const today = localDay(now.toISOString());
      const r = range(args, today);
      const filter = readFilter(store, args, today, { defaultFrom: r.from, kind: 'all' });
      const result = explore(store, { ...filter, from: r.from, to: r.to, sort: 'amount_desc', limit: limit(args, 15, 25), offset: 0, spendingOnly: filter.kind === 'expense', hideOwnTransfers: false, includeExcluded: false }, now);
      return {
        de: r.from, ate: r.to,
        quantidadeTotal: result.total,
        somaEntradas: reais(result.sums.income), somaSaidas: reais(result.sums.expense),
        // A planned installment is not a transaction yet, so it gets no ref.
        transacoes: result.items.map((t) => ({ ref: t.estimated || !ctx ? undefined : ctx.refs.transaction(store, t.id), data: localDay(t.occurredAt), ...(t.customName !== null ? { nome: clip(t.title) } : {}), descricao: clip(t.description), valor: reais(t.amount), categoria: t.category, conta: `${t.account.institution}${t.account.last4 ? ` ${t.account.last4}` : ''}`, status: t.status, parcela: t.installment ? `${t.installment.number}/${t.installment.total}` : null, moedaOriginal: t.foreign ? `${t.foreign.currency} ${(t.foreign.amount / 100).toFixed(2)}` : undefined })),
        observacao: result.total > result.items.length ? `mostrando as ${result.items.length} de maior valor; as somas valem para todas as ${result.total}` : undefined,
      };
    },
  },
  {
    name: 'aggregate',
    help: 'aggregate {from?, to?, groupBy: [1 ou 2 de category|group|merchant|month|account|institution|weekday], metric?: sum|count|avg|max (ordena), order?: value|key, kind?: expense|income|all (padrão expense: compras já descontados os estornos, como em spending), q?, category?, categories?: [..], merchant?, min?, max?, accounts?: [nomes], recurrence?: subscription|recurring|any, limit?<=30} : agrupa as transações do período e devolve soma, quantidade, média e maior valor de cada grupo, mais o total de todas. Use para perguntas que cruzam dimensões (por exemplo categoria por mês).',
    run: (store, now, args) => {
      const today = localDay(now.toISOString());
      const r = range(args, today);
      const raw = Array.isArray(args.groupBy) ? args.groupBy : args.groupBy === undefined ? [] : [args.groupBy];
      const dims = raw.filter((d): d is Dimension => (DIMENSIONS as readonly unknown[]).includes(d));
      if (dims.length < 1 || dims.length > 2 || dims.length !== raw.length || new Set(dims).size !== dims.length) throw new ToolError(`groupBy must be one or two different of: ${DIMENSIONS.join(', ')}`);
      const metric = args.metric === 'count' || args.metric === 'avg' || args.metric === 'max' ? args.metric : 'sum';
      const filter = readFilter(store, args, today, { defaultFrom: r.from, kind: 'expense' });
      // Expenses are net of refunds, like spending and the Gastos screen: the credits that give money back join the rows and subtract.
      const net = filter.kind === 'expense';
      const rows = matchingRows(store, now, { ...filter, kind: net ? 'all' : filter.kind, from: r.from, to: r.to }, net ? { netSpending: true } : {});
      const parents = categoryParents(store);
      const keyOf = (t: ExplorerRow, dim: Dimension): string => {
        switch (dim) {
          case 'category': return t.category ?? 'Sem categoria';
          case 'group': return t.category === null ? 'Sem categoria' : (parents.get(t.category) ?? t.category);
          case 'merchant': return merchantOf(t);
          case 'month': return localDay(t.occurredAt).slice(0, 7);
          case 'account': return accountLabel(t.account);
          case 'institution': return t.account.institution;
          case 'weekday': return WEEKDAYS[new Date(`${localDay(t.occurredAt)}T00:00:00Z`).getUTCDay()]!;
        }
      };
      // An expense is shown as a positive amount; with both kinds the sign is kept (money out is negative).
      const valueOf = (t: ExplorerRow): number => (net ? -t.amount : t.amount);
      const groups = new Map<string, { keys: string[]; sum: number; count: number; max: number }>();
      let total = 0;
      let counted = 0;
      for (const t of rows) {
        const keys = dims.map((d) => keyOf(t, d));
        const id = keys.join('\u0000');
        const value = valueOf(t);
        const g = groups.get(id) ?? { keys, sum: 0, count: 0, max: Number.NEGATIVE_INFINITY };
        g.sum += value;
        // A refund lowers the sum but is not a purchase: it is not counted, and it is not the biggest.
        if (!(net && t.amount > 0)) {
          g.count += 1;
          counted += 1;
          g.max = Math.max(g.max, value);
        }
        groups.set(id, g);
        total += value;
      }
      const mean = (g: { sum: number; count: number }): number => (g.count === 0 ? 0 : g.sum / g.count);
      const score = (g: { sum: number; count: number; max: number }): number => (metric === 'count' ? g.count : metric === 'avg' ? mean(g) : metric === 'max' ? g.max : g.sum);
      // Months read best in order; anything else reads best from the biggest.
      const byKey = args.order === 'key' || (args.order !== 'value' && dims.includes('month'));
      const ordered = [...groups.values()].sort((a, b) => (byKey ? a.keys.join(' ').localeCompare(b.keys.join(' ')) : score(b) - score(a) || a.keys.join(' ').localeCompare(b.keys.join(' '))));
      const shown = ordered.slice(0, limit(args, 15, MAX_GROUPS));
      return {
        de: r.from, ate: r.to, agrupadoPor: dims, ordenadoPor: byKey ? 'chave' : metric, tipo: filter.kind,
        quantidadeTotal: counted, somaTotal: reais(total),
        grupos: shown.map((g) => ({ chave: g.keys, soma: reais(g.sum), quantidade: g.count, media: reais(mean(g)), maior: reais(Number.isFinite(g.max) ? g.max : 0) })),
        observacao: [net ? 'os estornos de compras já foram descontados das somas (mesmo valor das ferramentas spending e da tela Gastos); quantidade e média contam só as compras' : null, ordered.length > shown.length ? `mostrando ${shown.length} de ${ordered.length} grupos; o total vale para todos` : null].filter((x) => x !== null).join('; ') || undefined,
      };
    },
  },
  {
    name: 'cards',
    help: 'cards {} : o que falta pagar de fatura (total, por mês de vencimento e por cartão, com vencimento e situação), fatura aberta, limite e saldo devedor dos emissores.',
    run: (store, now) => {
      const v = views.cards(store, now);
      return {
        // The figure the Cartões screen calls "A pagar": open bills plus closed bills still unpaid.
        aPagarNasFaturas: reais(v.totals.toPay),
        faturasFechadasNaoPagas: reais(v.totals.outstanding),
        // Bills by due month, adding the cards that close on different days (the open bill of a card sits in its own due month).
        faturasPorMesDeVencimento: Object.entries(v.totals.byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([mes, part]) => ({ mes, total: reais(part.total), cartoes: part.cards })),
        // What the issuers report as owed: bills plus every installment still to come. Larger than aPagarNasFaturas.
        saldoDevedorNosEmissores: reais(v.totals.reportedByIssuer),
        parcelasDeFaturasFuturas: reais(v.totals.futureInstallments), limiteTotal: reais(v.totals.creditLimit), proximoVencimento: v.totals.nextDueDate,
        cartoes: v.cards.map((c) => ({
          cartao: `${c.institution}${c.last4 ? ` ${c.last4}` : ` ${c.name}`}`,
          // aPagar: this card's open bill plus its closed bills still unpaid. venceEm: the oldest unpaid bill, else the open bill.
          aPagar: reais(c.toPay), venceEm: c.nextDueDate, situacaoDaFaturaAberta: statusText(c.cycle?.status), faturasFechadasNaoPagas: reais(c.outstanding),
          faturaAberta: reais(c.total), vencimentoDaFaturaAberta: c.cycle?.dueDate ?? null, limite: c.creditLimit === null ? null : reais(c.creditLimit), saldoDevedorNoEmissor: reais(c.balance),
        })),
      };
    },
  },
  {
    name: 'card_forecast',
    help: 'card_forecast {} : próximas faturas de cartão por mês de vencimento. previstoCerto = parcelas já compradas + cobranças que se repetem (ou a fatura já publicada); comMedia = previstoCerto + média do gasto de costume (um chute). A tela Futuras mostra previstoCerto, e comMedia quando a estimativa pela média está ligada.',
    run: (store, now) => ({
      meses: forecast(store, now).months.map((m) => ({ mes: m.key, aberta: m.open, parcelas: reais(m.installments), recorrentes: reais(m.recurring), mediaDoGastoDeCostume: reais(m.variable), previstoCerto: reais(m.certain), comMedia: reais(m.estimated) })),
    }),
  },
  {
    name: 'budgets',
    help: 'budgets {month?} : orçamento do mês por categoria ou grupo, com gasto, % usado e ritmo.',
    run: (store, now, args) => {
      const v = budgetsFor(store, month(args, localDay(now.toISOString())), now);
      return { mes: v.month, diasPassados: v.elapsedDays, diasNoMes: v.totalDays, totais: { orcado: reais(v.totals.budget), gasto: reais(v.totals.actual), ritmo: reais(v.totals.pace), acimaDoLimite: v.totals.over }, linhas: v.lines.slice(0, 25).map((l) => ({ nome: l.name, tipo: l.scope, orcamento: l.budget === null ? null : reais(l.budget), gasto: reais(l.actual), usado: l.used, ritmo: reais(l.pace), mesPassado: reais(l.previous) })) };
    },
  },
  {
    name: 'recurring',
    help: 'recurring {} : cobranças e entradas que se repetem todo mês, com valor, dia e próxima data.',
    run: (store, now) => ({ itens: detectRecurring(store, now).map((r) => ({ nome: r.name, tipo: r.direction === 'in' ? 'entrada' : 'saida', valor: reais(r.amount), valorVaria: r.kind === 'variable', noCartao: r.account === 'card', diaDoMes: r.dayOfMonth, proxima: r.nextDay, atrasado: r.late })) }),
  },
  {
    name: 'net_worth',
    help: 'net_worth {} : patrimônio hoje, de onde vem e o histórico mensal reconstruído.',
    run: (store, now) => {
      const v = netWorth(store, now);
      return { bens: reais(v.assets), dividas: reais(v.liabilities), patrimonio: reais(v.net), itens: v.items.map((i) => ({ nome: i.name, valor: reais(i.liability ? -i.value : i.value) })), historico: v.history.map((p) => ({ dia: p.day, patrimonio: reais(p.net) })) };
    },
  },
  {
    name: 'goals',
    help: 'goals {} : metas de economia, quanto falta e o ritmo.',
    run: (store, now) => ({ metas: listGoals(store, now).filter((g) => !g.archived).map((g) => ({ nome: g.name, meta: reais(g.target), atual: reais(g.current), progresso: g.progress, situacao: g.status, ate: g.targetDay, porMes: g.requiredMonthly === null ? null : reais(g.requiredMonthly) })) }),
  },
  {
    name: 'trend',
    help: 'trend {months?: 3|6|12} : gasto por categoria mês a mês; serve para ver o que subiu.',
    run: (store, now, args) => {
      const months = args.months === 3 || args.months === 12 ? args.months : 6;
      const v = categoryTrend(store, now, months);
      return { meses: v.months, categorias: v.rows.slice(0, 15).map((r) => ({ nome: r.name, porMes: r.points.map(reais), mediaDosFechados: reais(r.average), mesAtual: reais(r.current) })) };
    },
  },
  {
    name: 'outlook',
    help: 'outlook {} : o mês em curso: saldo agora, entradas esperadas, faturas e contas a vencer, livre para gastar até o fim do mês, linha do tempo de cobertura por vencimento e parte da renda comprometida.',
    run: (store, now) => {
      const v = outlook(store, now);
      const event = (e: (typeof v.timeline)[number]) => ({ dia: e.day, nome: e.name, tipo: e.direction === 'in' ? 'entrada' : 'saida', valor: reais(e.amount), origem: e.origin, estimado: e.estimate, atrasado: e.late, saldoAntes: reais(e.balanceBefore), saldoDepois: reais(e.balanceAfter), cobre: e.covered, faltam: reais(e.shortfall), saiDaContaAteAqui: reais(e.cumulativeOut) });
      return {
        hoje: v.today,
        fimDoMes: v.monthEnd,
        saldoNasContas: reais(v.balance),
        entradasEsperadas: { total: reais(v.expectedIn.total), origem: v.expectedIn.source, explicacao: v.expectedIn.explain, itens: v.expectedIn.items.map(event) },
        aVencerAteOFimDoMes: { total: reais(v.dueOut.total), faturas: reais(v.dueOut.bills), recorrentesDasContas: reais(v.dueOut.recurring), explicacao: v.dueOut.explain, itens: v.dueOut.items.map(event) },
        faturasDepoisDoFimDoMes: { total: reais(v.afterMonth.total), quantidade: v.afterMonth.count, primeiroVencimento: v.afterMonth.firstDay },
        livreParaGastar: { valor: reais(v.free.value), porDia: v.free.perDay === null ? null : reais(v.free.perDay), diasRestantes: v.daysLeft, explicacao: v.free.explain },
        menorSaldoProjetado: v.lowest === null ? null : { dia: v.lowest.day, valor: reais(v.lowest.value) },
        primeiroVencimentoSemCobertura: v.firstUncovered === null ? null : event(v.firstUncovered),
        linhaDoTempo: v.timeline.slice(0, 30).map(event),
        rendaComprometida: { renda: v.committed.income.amount === null ? null : reais(v.committed.income.amount), origemDaRenda: v.committed.income.source, parcelas: reais(v.committed.installments), assinaturas: reais(v.committed.subscriptions), fixos: reais(v.committed.fixed), total: reais(v.committed.total), parte: v.committed.share, explicacao: v.committed.explain },
      };
    },
  },
];

const SUGGESTION_KINDS = ['rules', 'budgets', 'duplicates', 'categories', 'income'] as const;
const SHOWN = 10;

TOOLS.push(
  {
    name: 'suggestions',
    help: 'suggestions {kind?: rules|budgets|duplicates|categories|income (padrão: todas), month?} : o que o app sugere e ainda não foi resolvido: regras por estabelecimento, orçamentos pela média, possíveis lançamentos duplicados (com ref f1, f2...), categorias que a IA sugeriu e rendas detectadas sem cadastro.',
    run: (store, now, args, ctx) => {
      const today = localDay(now.toISOString());
      const wanted = SUGGESTION_KINDS.includes(args.kind as never) ? [args.kind as (typeof SUGGESTION_KINDS)[number]] : [...SUGGESTION_KINDS];
      const out: Record<string, unknown> = {};
      if (wanted.includes('rules')) out.regras = suggestRules(store).slice(0, SHOWN).map((s) => ({ estabelecimento: s.merchant, categoria: s.category, transacoes: s.count, divergentes: s.differing }));
      if (wanted.includes('budgets')) {
        const m = month(args, today);
        out.orcamentos = { mes: m, linhas: suggestBudgets(store, m, 3, now).filter((s) => !s.hasBudget).slice(0, 12).map((s) => ({ categoria: s.name, sugerido: reais(s.amount), mesesNaMedia: s.months })) };
      }
      if (wanted.includes('duplicates')) out.possiveisDuplicatas = store.listFindings().slice(0, SHOWN).map((f) => ({ ref: ctx?.refs.finding(f.id), resumo: f.summary, valor: typeof f.details.amount === 'number' ? reais(f.details.amount) : undefined }));
      if (wanted.includes('categories')) {
        const open = [...store.listAiCategories().values()].filter((e) => e.status === 'suggested').sort((a, b) => a.sample.localeCompare(b.sample));
        out.categoriasSugeridasPelaIA = open.slice(0, SHOWN).map((e) => ({ descricao: e.sample, categoria: e.category, confianca: e.confidence }));
      }
      if (wanted.includes('income')) out.rendasSemCadastro = unregisteredIncome(store, now).slice(0, SHOWN).map((r) => ({ nome: r.name, valor: reais(r.amount), diaDoMes: r.dayOfMonth }));
      return out;
    },
  },
  {
    name: 'categories',
    help: 'categories {} : nomes das categorias que existem, com o grupo e o número de transações. Use um destes nomes ao mudar categorias; Pagamento de fatura, Transferência entre minhas contas e Investimentos definem o papel da transação.',
    run: (store) => ({ categorias: listCategories(store).slice(0, 60).map((c) => ({ nome: c.name, grupo: c.parent, transacoes: c.count, criadaPeloDono: c.custom })) }),
  },
  {
    name: 'accounts',
    help: 'accounts {} : contas e cartões visíveis, com tipo e final. O campo conta é o nome que os filtros aceitam em accounts.',
    run: (store) => ({ contas: visibleAccounts(store).map((a) => ({ conta: accountLabel(a), nome: a.name, instituicao: a.institution, tipo: a.kind === 'credit_card' ? 'cartão de crédito' : a.kind === 'savings' ? 'poupança' : 'conta corrente', final: a.last4 })) }),
  },
  {
    name: 'rules',
    help: 'rules {} : regras de categoria cadastradas, com o nome, a categoria que aplicam, se estão ativas e quantas transações combinam.',
    run: (store) => ({ regras: listRules(store).slice(0, 40).map((r) => ({ nome: r.name, categoria: r.actions.category, ativa: r.active, combinam: r.matches })) }),
  },
  {
    name: 'income_items',
    help: 'income_items {} : rendas que o dono cadastrou (nome, valor, dia do mês, período).',
    run: (store) => ({ rendas: store.listIncome().map((i) => ({ nome: i.name, valor: reais(i.amount), diaDoMes: i.dayOfMonth, desde: i.fromMonth, ate: i.untilMonth })) }),
  },
);

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
