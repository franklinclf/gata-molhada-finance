import { useState } from 'preact/hooks';
import { api, ApiError } from './api.ts';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Senha ou código incorretos.',
  too_many_attempts: 'Muitas tentativas. Aguarde alguns minutos.',
  auth_not_configured: 'O login ainda não foi configurado no servidor.',
};

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password, code.trim());
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? (MESSAGES[e.message] ?? e.message) : 'Sem conexão com o servidor.');
      setBusy(false);
    }
  }

  return (
    <main class="login">
      <form onSubmit={submit} class="card">
        <h1>Gata Molhada Finance</h1>
        <label>
          Senha
          <input type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)} required />
        </label>
        <label>
          Código do autenticador ou de recuperação
          <input inputMode="numeric" autocomplete="one-time-code" value={code} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} required />
        </label>
        {error && <div class="error" role="alert">{error}</div>}
        <button class="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </main>
  );
}
