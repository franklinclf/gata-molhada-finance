import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Dashboard } from './Dashboard.tsx';
import { TransactionDrawer } from './Drawer.tsx';
import { useStoredFlag } from './hooks.ts';
import { Login } from './Login.tsx';
import { AccountsPage } from './pages/accounts.tsx';
import { CardsPage } from './pages/cards.tsx';
import { Palette } from './Palette.tsx';
import { ChatPage } from './pages/chat.tsx';
import { GoalsPage } from './pages/goals.tsx';
import { CalendarPage } from './pages/calendar.tsx';
import { BudgetsPage } from './pages/budgets.tsx';
import { NetWorthPage } from './pages/networth.tsx';
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
  ['networth', 'Patrimônio'],
  ['goals', 'Metas'],
  ['calendar', 'Calendário'],
  ['chat', 'Analista'],
  ['accounts', 'Contas'],
  ['cashflow', 'Fluxo de caixa'],
  ['status', 'Fontes e conferência'],
  ['settings', 'Ajustes'],
];

/** Every section of the top bar of a wide screen, in order. Those that do not fit the width move under "Mais". */
const NAV: Array<[string, string]> = [
  ['', 'Painel'],
  ['transactions', 'Transações'],
  ['spending', 'Gastos'],
  ['cards', 'Cartões'],
  ['budgets', 'Orçamento'],
  ['accounts', 'Contas'],
  ['chat', 'Analista'],
  ['networth', 'Patrimônio'],
  ['goals', 'Metas'],
  ['calendar', 'Calendário'],
  ['cashflow', 'Fluxo de caixa'],
  ['status', 'Fontes e conferência'],
  ['settings', 'Ajustes'],
];

const NAV_GAP = 4;

/** How many of the top bar links fit in the bar's width. `all` means no "Mais" button is needed. */
function useFittingCount(total: number) {
  const bar = useRef<HTMLElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(total);
  useLayoutEffect(() => {
    const measure = () => {
      if (!bar.current || !probe.current) return;
      const available = bar.current.clientWidth;
      const kids = [...probe.current.children] as HTMLElement[];
      const more = kids.pop()?.offsetWidth ?? 0;
      const widths = kids.map((k) => k.offsetWidth);
      const all = widths.reduce((s, w) => s + w + NAV_GAP, 0) - NAV_GAP;
      if (available <= 0 || all <= available) return setFit(total);
      let used = more;
      let count = 0;
      for (const w of widths) {
        if (used + NAV_GAP + w > available) break;
        used += NAV_GAP + w;
        count++;
      }
      setFit(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (bar.current) observer.observe(bar.current);
    return () => observer.disconnect();
  }, [total]);
  return { bar, probe, fit };
}

export function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  // Values start hidden on a device that never chose, so opening the app in public shows nothing by accident.
  const [hidden, setHidden] = useStoredFlag('gmf.hidden', true);
  const [now, setNow] = useState(() => new Date());
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const route = useRoute();
  const { bar, probe, fit } = useFittingCount(NAV.length);

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase('out'));
    api.session().then(() => setPhase('in')).catch(() => setPhase('out'));
  }, []);

  // The top bar menu closes on a click anywhere else or on Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

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
    case 'chat':
      page = <ChatPage route={route} hidden={hidden} />;
      break;
    case 'goals':
      page = <GoalsPage now={now} hidden={hidden} />;
      break;
    case 'calendar':
      page = <CalendarPage route={route} now={now} hidden={hidden} />;
      break;
    case 'networth':
      page = <NetWorthPage now={now} hidden={hidden} />;
      break;
    case 'accounts':
      page = <AccountsPage now={now} hidden={hidden} />;
      break;
    case 'cashflow':
      page = <CashflowPage route={route} now={now} hidden={hidden} />;
      break;
    case 'status':
      page = <StatusPage now={now} hidden={hidden} />;
      break;
    case 'settings':
      page = <SettingsPage route={route} hidden={hidden} now={now} />;
      break;
    case '':
    case 'dashboard':
      page = <Dashboard hidden={hidden} now={now} />;
      break;
    default:
      page = (
        <div class="page-body">
          <h1 class="page-title">Página não encontrada</h1>
          <p class="muted">O endereço #/{route.page} não existe. Use o menu para voltar.</p>
        </div>
      );
  }

  return (
    <>
      <header class="topbar">
        <h1>
          <a class="brand" href={hrefFor('')}>Gata Molhada</a>
        </h1>
        <nav aria-label="Seções" ref={bar}>
          {NAV.slice(0, fit).map(([id, label]) => (
            <a key={id} class={route.page === id ? 'navlink on' : 'navlink'} href={hrefFor(id)}>
              {label}
            </a>
          ))}
          {fit < NAV.length && (
            <div class="nav-more">
              <button class={NAV.slice(fit).some(([id]) => id === route.page) ? 'navlink on' : 'navlink'} aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}>
                Mais ▾
              </button>
              {menu && (
                <div class="nav-menu" role="menu">
                  {NAV.slice(fit).map(([id, label]) => (
                    <a key={id} role="menuitem" class={route.page === id ? 'navlink on' : 'navlink'} href={hrefFor(id)} onClick={() => setMenu(false)}>
                      {label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          <div class="nav-probe" ref={probe} aria-hidden="true">
            {NAV.map(([id, label]) => (
              <span key={id} class="navlink">{label}</span>
            ))}
            <span class="navlink">Mais ▾</span>
          </div>
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
      <Palette hidden={hidden} />
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
