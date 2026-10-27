import { useEffect, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Dashboard } from './Dashboard.tsx';
import { useStoredFlag } from './hooks.ts';
import { Login } from './Login.tsx';

type Phase = 'checking' | 'out' | 'in';

export function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  // Values start hidden on a device that never chose, so opening the app in public shows nothing by accident.
  const [hidden, setHidden] = useStoredFlag('gmf.hidden', true);

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase('out'));
    api.session().then(() => setPhase('in')).catch(() => setPhase('out'));
  }, []);

  if (phase === 'checking') return <div class="empty page">Carregando…</div>;
  if (phase === 'out') return <Login onDone={() => setPhase('in')} />;
  return (
    <Dashboard
      hidden={hidden}
      onToggleHidden={() => setHidden(!hidden)}
      onLogout={() => {
        void api.logout().finally(() => setPhase('out'));
      }}
    />
  );
}
