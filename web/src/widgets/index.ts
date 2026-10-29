import type { FunctionComponent } from 'preact';
import type { LayoutItem, WidgetId } from '../api.ts';
import type { SizeClass } from '../grid.ts';
import { BalancesWidget } from './balances.tsx';
import { BudgetWidget } from './budget.tsx';
import { CardsWidget } from './cards.tsx';
import { CashflowWidget } from './cashflow.tsx';
import { FindingsWidget } from './findings.tsx';
import { FreshnessWidget } from './freshness.tsx';
import { InstallmentsWidget } from './installments.tsx';
import { CalendarWidget } from './calendar.tsx';
import { GoalsWidget } from './goals.tsx';
import { NetWorthWidget } from './networth.tsx';
import { RecentWidget } from './recent.tsx';
import { ReviewWidget } from './review.tsx';
import { SummaryWidget } from './summary.tsx';
import { TrendWidget } from './trend.tsx';
import { UpcomingWidget } from './upcoming.tsx';
import { SpendingWidget } from './spending.tsx';

export interface WidgetProps {
  item: LayoutItem;
  now: Date;
  hidden: boolean;
  size: SizeClass;
  /** Settings of this widget instance, saved with the layout. */
  config: Record<string, string>;
  setConfig: (patch: Record<string, string>) => void;
}

export const WIDGETS: Record<WidgetId, { title: string; component: FunctionComponent<WidgetProps> }> = {
  balances: { title: 'Saldo em contas', component: BalancesWidget },
  cards: { title: 'Cartões e faturas', component: CardsWidget },
  cashflow: { title: 'Fluxo de caixa', component: CashflowWidget },
  spending: { title: 'Gastos', component: SpendingWidget },
  installments: { title: 'Parcelas', component: InstallmentsWidget },
  budget: { title: 'Orçamento', component: BudgetWidget },
  goals: { title: 'Metas', component: GoalsWidget },
  summary: { title: 'Resumo do mês', component: SummaryWidget },
  upcoming: { title: 'Próximos 14 dias', component: UpcomingWidget },
  calendar: { title: 'Calendário', component: CalendarWidget },
  trend: { title: 'Maiores altas', component: TrendWidget },
  review: { title: 'Para revisar', component: ReviewWidget },
  networth: { title: 'Patrimônio', component: NetWorthWidget },
  recent: { title: 'Transações recentes', component: RecentWidget },
  freshness: { title: 'Atualização das fontes', component: FreshnessWidget },
  findings: { title: 'Para conferir', component: FindingsWidget },
};
