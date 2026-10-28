import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api.ts';
import { guessDeviceName, passkeysSupported, usePasskey } from './passkey.ts';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Senha ou código incorretos.',
  too_many_attempts: 'Muitas tentativas. Aguarde alguns minutos.',
  auth_not_configured: 'O login ainda não foi configurado no servidor.',
};

const TRUST_KEY = 'gmf.trust';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(() => localStorage.getItem(TRUST_KEY) === '1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!passkeysSupported()) {
      setShowPassword(true);
      return;
    }
    api.methods().then((m) => {
      setPasskeys(m.passkeys);
      setShowPassword(!m.passkeys);
    }).catch(() => setShowPassword(true));
  }, []);

  const remember = (value: boolean) => {
    setTrust(value);
    localStorage.setItem(TRUST_KEY, value ? '1' : '0');
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError) setError(MESSAGES[e.message] ?? e.message);
    else if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) setError('A passkey foi cancelada. Tente de novo ou use a senha.');
    else setError('Não foi possível entrar.');
    setBusy(false);
  };

  async function withPassword(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password, code.trim(), trust, guessDeviceName());
      onDone();
    } catch (e) {
      fail(e);
    }
  }

  async function withPasskey() {
    setBusy(true);
    setError(null);
    try {
      const credential = await usePasskey(await api.passkeyLoginOptions());
      await api.passkeyLogin(credential, trust, guessDeviceName());
      onDone();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <main class="login">
      <form onSubmit={withPassword} class="card">
        <h1>Gata Molhada Finance</h1>
        {passkeys && (
          <button type="button" class="primary" disabled={busy} onClick={() => void withPasskey()}>
            {busy ? 'Aguardando…' : 'Entrar com passkey'}
          </button>
        )}
        {passkeys && !showPassword && (
          <button type="button" class="link" onClick={() => setShowPassword(true)}>
            Usar senha e código do autenticador
          </button>
        )}
        {showPassword && (
          <>
            <label>
              Senha
              <input type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)} required />
            </label>
            <label>
              Código do autenticador ou de recuperação
              <input inputMode="numeric" autocomplete="one-time-code" value={code} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} required />
            </label>
          </>
        )}
        <label class="check">
          <input type="checkbox" checked={trust} onChange={(e) => remember((e.currentTarget as HTMLInputElement).checked)} />
          Confiar neste aparelho por 30 dias (só em aparelho seu)
        </label>
        {error && <div class="error" role="alert">{error}</div>}
        {showPassword && <button class={passkeys ? 'icon' : 'primary'} disabled={busy}>{busy ? 'Entrando…' : 'Entrar com senha'}</button>}
      </form>
    </main>
  );
}
