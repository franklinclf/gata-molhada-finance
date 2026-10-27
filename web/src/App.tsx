import { useEffect, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Dashboard } from './Dashboard.tsx';
import { TransactionDrawer } from './Drawer.tsx';
import { useStoredFlag } from './hooks.ts';
import { Login } from './Login.tsx';
import { AccountsPage } from './pages/accounts.tsx';
import { CardsPage } from './pages/cards.tsx';
import { CashflowPage } from './pages/cashflow.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SpendingPage } from './pages/spending.tsx';
import { StatusPage } from './pages/status.tsx';
import { TransactionsPage } from './pages/transactions.tsx';
import { hrefFor, useRoute } from './router.ts';

type Phase = 'checking' | 'out' | 'in';

const NAV: Array<[string, string]> = [
  ['', 'Painel'],
  ['transactions', 'Transações'],
  ['spending', 'Gastos'],
  ['cards', 'Cartões'],
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
      page = <SettingsPage route={route} hidden={hidden} />;
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
      {tx && <TransactionDrawer id={tx} hidden={hidden} />}
    </>
  );
}
