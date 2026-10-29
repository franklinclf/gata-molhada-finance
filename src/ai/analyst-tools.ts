import { localDay } from '../core/time.ts';
import { budgetsFor } from '../api/budgets.ts';
import { explore } from '../api/explorer.ts';
import { forecast } from '../api/forecast.ts';
import { listGoals } from '../api/goals.ts';
import { netWorth } from '../api/networth.ts';
import { detectRecurring } from '../api/recurring.ts';
import { categoryTrend } from '../api/trends.ts';
import * as views from '../api/views.ts';
import type { Store } from '../store/store.ts';

/** What the model may ask for. Every tool only reads, and every number is computed here, not by the model. */
export interface Tool {
  name: string;
  /** One line for the prompt, with the arguments. */
  help: string;
  run: (store: Store, now: Date, args: Record<string, unknown>) => unknown;
}

const reais = (cents: number): number => Math.round(cents) / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_TEXT = 80;
const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

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

export const TOOLS: Tool[] = [
  {
    name: 'summary',
    help: 'summary {month?} : visão geral do mês (saldo nas contas, dívida de cartão, patrimônio, gastos, entradas e saídas, maiores categorias).',
    run: (store, now, args) => {
      const today = localDay(now.toISOString());
      const m = month(args, today);
      const from = `${m}-01`;
      const to = m === today.slice(0, 7) ? today : new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);
      const spend = views.spending(store, { from, to }, 'category', now);
      const flow = views.cashFlow(store, { from, to }, now);
      const worth = netWorth(store, now);
      return {
        mes: m,
        saldoNasContas: reais(views.balances(store, now).total),
        dividaDeCartao: reais(views.cards(store, now).totals.reportedByIssuer),
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
    help: 'cashflow {from?, to?} : o que entrou e saiu das contas bancárias no período (compras no cartão só contam quando a fatura é paga).',
    run: (store, now, args) => {
      const r = range(args, localDay(now.toISOString()));
      const flow = views.cashFlow(store, r, now);
      return { de: r.from, ate: r.to, entrou: reais(flow.inflow), saiu: reais(flow.outflow), saldoDoPeriodo: reais(flow.net) };
    },
  },
  {
    name: 'transactions',
    help: 'transactions {from?, to?, q?, category?, merchant?, kind?: expense|income, min?, max? (reais, valor absoluto), limit?<=25} : lista de transações e a soma de todas as que combinam.',
    run: (store, now, args) => {
      const today = localDay(now.toISOString());
      const r = range(args, today);
      const kind = args.kind === 'income' ? 'income' : args.kind === 'expense' ? 'expense' : 'all';
      const cents = (key: string) => (typeof args[key] === 'number' && Number.isFinite(args[key]) && (args[key] as number) >= 0 ? Math.round((args[key] as number) * 100) : undefined);
      const result = explore(store, {
        from: r.from, to: r.to, kind, sort: 'amount_desc', limit: limit(args, 15, 25), offset: 0,
        q: typeof args.q === 'string' && args.q.trim() ? args.q.trim().slice(0, 60) : undefined,
        merchant: typeof args.merchant === 'string' && args.merchant.trim() ? args.merchant.trim().slice(0, 60) : undefined,
        categories: typeof args.category === 'string' && args.category.trim() ? [args.category.trim().slice(0, 60)] : undefined,
        min: cents('min'), max: cents('max'), spendingOnly: kind === 'expense', hideOwnTransfers: false, includeExcluded: false,
      }, now);
      return {
        de: r.from, ate: r.to,
        quantidadeTotal: result.total,
        somaEntradas: reais(result.sums.income), somaSaidas: reais(result.sums.expense),
        transacoes: result.items.map((t) => ({ data: localDay(t.occurredAt), descricao: clip(t.description), valor: reais(t.amount), categoria: t.category, conta: `${t.account.institution}${t.account.last4 ? ` ${t.account.last4}` : ''}`, status: t.status, parcela: t.installment ? `${t.installment.number}/${t.installment.total}` : null })),
        observacao: result.total > result.items.length ? `mostrando as ${result.items.length} de maior valor; as somas valem para todas as ${result.total}` : undefined,
      };
    },
  },
  {
    name: 'cards',
    help: 'cards {} : cada cartão (fatura aberta, vencimento, limite, usado) e o total devido.',
    run: (store, now) => {
      const v = views.cards(store, now);
      return {
        totalDevidoAosEmissores: reais(v.totals.reportedByIssuer), faturasFechadasNaoPagas: reais(v.totals.outstanding), parcelasDeFaturasFuturas: reais(v.totals.futureInstallments), limiteTotal: reais(v.totals.creditLimit), proximoVencimento: v.totals.nextDueDate,
        cartoes: v.cards.map((c) => ({ cartao: `${c.institution}${c.last4 ? ` ${c.last4}` : ` ${c.name}`}`, faturaAberta: reais(c.total), vencimento: c.cycle?.dueDate ?? null, limite: c.creditLimit === null ? null : reais(c.creditLimit), emDivida: reais(c.balance) })),
      };
    },
  },
  {
    name: 'card_forecast',
    help: 'card_forecast {} : estimativa das próximas faturas de cartão (parcelas conhecidas, recorrentes e média do variável).',
    run: (store, now) => ({ meses: forecast(store, now).months.map((m) => ({ mes: m.key, aberta: m.open, parcelas: reais(m.installments), recorrentes: reais(m.recurring), variavel: reais(m.variable), total: reais(m.total) })) }),
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
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
