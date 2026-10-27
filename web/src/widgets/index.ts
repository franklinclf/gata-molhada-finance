import type { WidgetId } from '../../../src/api/layout.ts';
import type { FunctionComponent } from 'preact';
import { BalancesWidget } from './balances.tsx';
import { CardsWidget } from './cards.tsx';
import { CashflowWidget } from './cashflow.tsx';
import { FindingsWidget } from './findings.tsx';
import { FreshnessWidget } from './freshness.tsx';
import { InstallmentsWidget } from './installments.tsx';
import { RecentWidget } from './recent.tsx';
import { SpendingWidget } from './spending.tsx';

export interface WidgetProps {
  now: Date;
  hidden: boolean;
}

export const WIDGETS: Record<WidgetId, { title: string; component: FunctionComponent<WidgetProps> }> = {
  balances: { title: 'Saldo em contas', component: BalancesWidget },
  cards: { title: 'Cartões e limite', component: CardsWidget },
  cashflow: { title: 'Fluxo de caixa', component: CashflowWidget },
  spending: { title: 'Gastos', component: SpendingWidget },
  installments: { title: 'Parcelas', component: InstallmentsWidget },
  recent: { title: 'Transações recentes', component: RecentWidget },
  freshness: { title: 'Atualização das fontes', component: FreshnessWidget },
  findings: { title: 'Divergências abertas', component: FindingsWidget },
};
