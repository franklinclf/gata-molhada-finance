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
import { SettingsPage } from './pages/settings.tsx';
import { SpendingPage } from './pages/spending.tsx';
import { NAV, useNavOrder } from './nav.ts';
import { useTopbarTools } from './topbar.ts';
import { TransactionsPage } from './pages/transactions.tsx';
import { hrefFor, useRoute } from './router.ts';

const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true } as const;
const Eye = () => (
  <svg {...svg}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOff = () => (
  <svg {...svg}>
    <path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a17.7 17.7 0 0 1 4.1-5M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M2 2l20 20" />
  </svg>
);
const LogOut = () => (
  <svg {...svg}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </svg>
);

type Phase = 'checking' | 'out' | 'in';

/** The four sections kept on the bottom bar of a phone; the rest sit behind "Mais". */
const TABS: Array<[string, string, string]> = [
  ['', 'Dashboard', '▦'],
  ['transactions', 'Transações', '☰'],
  ['spending', 'Gastos', '◔'],
  ['cards', 'Cartões', '▭'],
];
const MORE: Array<[string, string]> = [
  ['budgets', 'Orçamento'],
  ['goals', 'Metas'],
  ['calendar', 'Calendário'],
  ['chat', 'Analista'],
  ['accounts', 'Contas'],
  ['settings', 'Ajustes'],
];

const NAV_GAP = 4;

/** How many of the top bar links fit in the bar's width. When all fit, no "Mais" button is needed. */
function useFittingCount(total: number, order: string, actions: unknown) {
  const bar = useRef<HTMLElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(total);
  useLayoutEffect(() => {
    const header = bar.current?.parentElement;
    if (!header) return;
    const measure = () => {
      if (!bar.current || !probe.current) return;
      // The room is what the bar has left once the brand and the page actions (which grow while customizing the panel) take theirs.
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap) || 0;
      const others = ([...header.children] as HTMLElement[]).filter((child) => child !== bar.current);
      const available = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - others.reduce((sum, child) => sum + child.offsetWidth + gap, 0);
      const kids = [...probe.current.children] as HTMLElement[];
      const more = kids.pop()?.offsetWidth ?? 0;
      const widths = kids.map((k) => k.offsetWidth);
      const all = widths.reduce((s, w) => s + w + NAV_GAP, 0) - NAV_GAP;
      if (all <= available) return setFit(total);
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
    // Every child of the bar is watched, so a change in the page actions measures again.
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    for (const child of header.children) observer.observe(child);
    return () => observer.disconnect();
  }, [total, order, actions]);
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
  const nav = useNavOrder();
  // Measured again when the page actions change, since they take room from the menu.
  const tools = useTopbarTools();
  const { bar, probe, fit } = useFittingCount(NAV.length, nav.ids.join(), tools);
  const [dragging, setDragging] = useState<string | null>(null);
  // Cash flow and net worth are views of the accounts page.
  const section = route.page === 'cashflow' || route.page === 'networth' ? 'accounts' : route.page === 'status' ? 'settings' : route.page;
  const link = (id: string, label: string, onClick?: () => void) => (
    <a
      key={id}
      class={`${section === id ? 'navlink on' : 'navlink'}${dragging === id ? ' dragging' : ''}`}
      href={hrefFor(id)}
      draggable
      onDragStart={() => setDragging(id)}
      onDragEnd={() => setDragging(null)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (dragging) nav.move(dragging, id);
        setDragging(null);
      }}
      onClick={onClick}
    >
      {label}
    </a>
  );

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
  const inMore = MORE.some(([id]) => id === (route.page === 'cashflow' || route.page === 'networth' ? 'accounts' : route.page));
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
      page = <AccountsPage route={route} now={now} hidden={hidden} view="networth" />;
      break;
    case 'accounts':
      page = <AccountsPage route={route} now={now} hidden={hidden} />;
      break;
    case 'cashflow':
      page = <AccountsPage route={route} now={now} hidden={hidden} view="cashflow" />;
      break;
    case 'status':
      // Sources and checks now live in Settings, Data.
      page = <SettingsPage route={{ page: 'settings', params: new URLSearchParams({ tab: 'data' }) }} hidden={hidden} now={now} />;
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
          {nav.items.slice(0, fit).map(([id, label]) => link(id, label))}
          {fit < NAV.length && (
            <div class="nav-more">
              <button class={nav.items.slice(fit).some(([id]) => id === section) ? 'navlink on' : 'navlink'} aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}>
                Mais ▾
              </button>
              {menu && (
                <div class="nav-menu">
                  {nav.items.slice(fit).map(([id, label]) => link(id, label, () => setMenu(false)))}
                  {nav.custom && (
                    <button class="navlink" onClick={() => nav.reset()}>
                      Ordem original
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div class="nav-probe" ref={probe} aria-hidden="true">
            {nav.items.map(([id, label]) => (
              <span key={id} class="navlink">{label}</span>
            ))}
            <span class="navlink">Mais ▾</span>
          </div>
        </nav>
        <div class="topbar-actions">
          {tools}
          <button class="icon icon-btn" onClick={() => setHidden(!hidden)} aria-pressed={hidden} aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'} title={hidden ? 'Mostrar valores' : 'Ocultar valores'}>
            {hidden ? <EyeOff /> : <Eye />}
          </button>
          <button
            class="icon icon-btn"
            aria-label="Sair"
            title="Sair"
            onClick={() => {
              void api.logout().finally(() => setPhase('out'));
            }}
          >
            <LogOut />
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
