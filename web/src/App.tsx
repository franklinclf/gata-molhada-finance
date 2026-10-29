import { useEffect, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Dashboard } from './Dashboard.tsx';
import { TransactionDrawer } from './Drawer.tsx';
import { useStoredFlag } from './hooks.ts';
import { Login } from './Login.tsx';
import { AccountsPage } from './pages/accounts.tsx';
import { CardsPage } from './pages/cards.tsx';
import { BudgetsPage } from './pages/budgets.tsx';
import { CashflowPage } from './pages/cashflow.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SpendingPage } from './pages/spending.tsx';
import { StatusPage } from './pages/status.tsx';
import { TransactionsPage } from './pages/transactions.tsx';
import { hrefFor, useRoute } from './router.ts';

type Phase = 'checking' | 'out' | 'in';

/** The four sections kept on the bottom bar of a phone; the rest sit behind "Mais". */
const TABS: Array<[string, string, string]> = [
  ['', 'Painel', '▦'],
  ['transactions', 'Transações', '☰'],
  ['spending', 'Gastos', '◔'],
  ['cards', 'Cartões', '▭'],
];
const MORE: Array<[string, string]> = [
  ['budgets', 'Orçamento'],
  ['accounts', 'Contas'],
  ['cashflow', 'Fluxo de caixa'],
  ['status', 'Fontes e conferência'],
  ['settings', 'Ajustes'],
];

const NAV: Array<[string, string]> = [
  ['', 'Painel'],
  ['transactions', 'Transações'],
  ['spending', 'Gastos'],
  ['cards', 'Cartões'],
  ['budgets', 'Orçamento'],
  ['accounts', 'Contas'],
  ['cashflow', 'Fluxo'],
  ['status', 'Fontes'],
  ['settings', 'Ajustes'],
];

export function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  // Values start hidden on a device that never chose, so opening the app in public shows nothing by accident.
  const [hidden, setHidden] = useStoredFlag('gmf.hidden', true);
  const [now, setNow] = useState(() => new Date());
  const [more, setMore] = useState(false);
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase('out'));
    api.session().then(() => setPhase('in')).catch(() => setPhase('out'));
  }, []);

  // Keeps the "há N min" labels current.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (phase === 'checking') return <div class="empty page">Carregando…</div>;
  if (phase === 'out') return <Login onDone={() => setPhase('in')} />;

  const tx = route.params.get('tx');
  const inMore = MORE.some(([id]) => id === route.page);
  let page;
  switch (route.page) {
    case 'transactions':
      page = <TransactionsPage route={route} now={now} hidden={hidden} />;
      break;
    case 'spending':
      page = <SpendingPage route={route} now={now} hidden={hidden} />;
      break;
    case 'cards':
      page = <CardsPage route={route} now={now} hidden={hidden} />;
      break;
    case 'budgets':
      page = <BudgetsPage route={route} now={now} hidden={hidden} />;
      break;
    case 'accounts':
      page = <AccountsPage now={now} hidden={hidden} />;
      break;
    case 'cashflow':
      page = <CashflowPage route={route} now={now} hidden={hidden} />;
      break;
    case 'status':
      page = <StatusPage now={now} />;
      break;
    case 'settings':
      page = <SettingsPage route={route} hidden={hidden} now={now} />;
      break;
    default:
      page = <Dashboard hidden={hidden} now={now} />;
  }

  return (
    <>
      <header class="topbar">
        <h1>Gata Molhada</h1>
        <nav aria-label="Seções">
          {NAV.map(([id, label]) => (
            <a key={id} class={route.page === id ? 'navlink on' : 'navlink'} href={hrefFor(id)}>
              {label}
            </a>
          ))}
        </nav>
        <div class="topbar-actions">
          <button class="icon" onClick={() => setHidden(!hidden)} aria-pressed={hidden} title={hidden ? 'Mostrar valores' : 'Ocultar valores'}>
            {hidden ? 'Mostrar valores' : 'Ocultar valores'}
          </button>
          <button
            class="icon"
            onClick={() => {
              void api.logout().finally(() => setPhase('out'));
            }}
          >
            Sair
          </button>
        </div>
      </header>
      <main class="main">{page}</main>
      <nav class="tabbar" aria-label="Seções">
        {TABS.map(([id, label, icon]) => (
          <a key={id} class={route.page === id && !more ? 'tab-item on' : 'tab-item'} href={hrefFor(id)} onClick={() => setMore(false)}>
            <span aria-hidden="true">{icon}</span>
            {label}
          </a>
        ))}
        <button class={more || inMore ? 'tab-item on' : 'tab-item'} onClick={() => setMore(!more)} aria-expanded={more}>
          <span aria-hidden="true">⋯</span>
          Mais
        </button>
      </nav>
      {more && (
        <div class="overlay sheet-overlay" onClick={() => setMore(false)}>
          <div class="drawer sheet" role="dialog" aria-label="Mais seções" onClick={(e) => e.stopPropagation()}>
            <div class="sheet-handle" aria-hidden="true" />
            {MORE.map(([id, label]) => (
              <a key={id} class="sheet-item" href={hrefFor(id)} onClick={() => setMore(false)}>
                {label} <span aria-hidden="true">›</span>
              </a>
            ))}
            <button class="sheet-item" onClick={() => setHidden(!hidden)}>
              {hidden ? 'Mostrar valores' : 'Ocultar valores'}
            </button>
            <button
              class="sheet-item"
              onClick={() => {
                setMore(false);
                void api.logout().finally(() => setPhase('out'));
              }}
            >
              Sair
            </button>
          </div>
        </div>
      )}
      {tx && <TransactionDrawer key={tx} id={tx} hidden={hidden} />}
    </>
  );
}
