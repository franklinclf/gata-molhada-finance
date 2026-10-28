import type { AuthService } from '../auth/service.ts';
import type { AssertionInput, RegistrationInput } from '../auth/webauthn.ts';
import { apiRoute } from '../api/routes.ts';
import { route, type RouteResult, type RouterDeps } from './router.ts';

export interface AppRequest {
  method: string;
  pathname: string;
  /** Query string without the leading question mark. */
  search?: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface AppDeps extends RouterDeps {
  auth: AuthService;
  /** Send the session cookie only over HTTPS. Turn off for local development over plain HTTP. */
  secureCookies: boolean;
}

export const COOKIE_NAME = 'gmf_session';
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

function json(status: number, payload: unknown, extra: Record<string, string> = {}): RouteResult {
  return { status, headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS, ...extra }, body: JSON.stringify(payload) };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function parseJson(request: AppRequest): Record<string, unknown> | null {
  // Requiring JSON blocks plain cross-site form posts, on top of the SameSite cookie.
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return null;
  try {
    const value = JSON.parse(request.body) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const DEVICE_COOKIE = 'gmf_device';

function cookieFor(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** Adds cookies to a response: the first goes in the Set-Cookie header, the rest in `cookies`. */
function withCookies(result: RouteResult, cookies: string[]): RouteResult {
  if (cookies.length === 0) return result;
  const [first, ...rest] = cookies;
  return { ...result, headers: { ...result.headers, 'Set-Cookie': first! }, ...(rest.length > 0 ? { cookies: rest } : {}) };
}

const NO_PASSKEYS = { error: 'passkeys_not_configured' };

function loginResponse(result: ReturnType<AuthService['login']>, deps: AppDeps): RouteResult {
  if (result.ok) {
    const maxAge = Math.max(1, Math.floor((Date.parse(result.expiresAt) - deps.now().getTime()) / 1000));
    const cookies = [cookieFor(COOKIE_NAME, result.token, maxAge, deps.secureCookies)];
    if (result.device) cookies.push(cookieFor(DEVICE_COOKIE, result.device.token, result.device.maxAgeSeconds, deps.secureCookies));
    return withCookies(json(200, { expiresAt: result.expiresAt, trusted: result.device !== undefined }), cookies);
  }
  if (result.reason === 'locked') return json(429, { error: 'too_many_attempts', retryAfterSeconds: result.retryAfterSeconds }, { 'Retry-After': String(result.retryAfterSeconds) });
  if (result.reason === 'not_configured') return json(503, { error: 'auth_not_configured' });
  return json(401, { error: 'invalid_credentials' });
}

const trustFrom = (body: Record<string, unknown>): { name: string } | null => (body.trust === true ? { name: typeof body.deviceName === 'string' ? body.deviceName : 'Aparelho' } : null);

export function handle(request: AppRequest, deps: AppDeps): RouteResult {
  const { method, pathname } = request;
  if (pathname === '/healthz') return route(method, pathname, deps);
  const notAllowed = (allow: string) => json(405, { error: 'method_not_allowed' }, { Allow: allow });

  // ---------- public: how to sign in ----------
  if (pathname === '/api/auth/methods') return method === 'GET' ? json(200, { password: true, passkeys: deps.auth.passkeysAvailable }) : notAllowed('GET');

  if (pathname === '/api/auth/login') {
    if (method !== 'POST') return notAllowed('POST');
    const body = parseJson(request);
    if (!body || typeof body.password !== 'string' || typeof body.code !== 'string') return json(400, { error: 'bad_request' });
    return loginResponse(deps.auth.login(body.password, body.code, trustFrom(body)), deps);
  }

  if (pathname === '/api/auth/passkey/login/options') {
    if (method !== 'POST') return notAllowed('POST');
    const options = deps.auth.passkeyLoginOptions();
    if (options === null) return json(503, NO_PASSKEYS);
    if ('locked' in options) return json(429, { error: 'too_many_attempts', retryAfterSeconds: options.locked }, { 'Retry-After': String(options.locked) });
    return json(200, options.options);
  }

  if (pathname === '/api/auth/passkey/login') {
    if (method !== 'POST') return notAllowed('POST');
    const body = parseJson(request);
    const credential = body?.credential as AssertionInput | undefined;
    if (!body || !credential?.response || typeof credential.rawId !== 'string') return json(400, { error: 'bad_request' });
    return loginResponse(deps.auth.passkeyLogin(credential, trustFrom(body)), deps);
  }

  // ---------- everything else needs a session; a trusted device can start one ----------
  const secure = deps.secureCookies;
  if (pathname === '/api/auth/logout') {
    // Handled before any restore, so the device being forgotten is the one the cookie names.
    if (method !== 'POST') return notAllowed('POST');
    deps.auth.logout(readCookie(request.headers.cookie, COOKIE_NAME), readCookie(request.headers.cookie, DEVICE_COOKIE));
    return withCookies(json(200, { ok: true }), [cookieFor(COOKIE_NAME, '', 0, secure), cookieFor(DEVICE_COOKIE, '', 0, secure)]);
  }
  let token = readCookie(request.headers.cookie, COOKIE_NAME);
  const deviceToken = readCookie(request.headers.cookie, DEVICE_COOKIE);
  const renewed: string[] = [];
  if (!deps.auth.verifySession(token) && deviceToken) {
    const restored = deps.auth.restoreFromDevice(deviceToken);
    if (restored) {
      token = restored.token;
      const maxAge = Math.max(1, Math.floor((Date.parse(restored.expiresAt) - deps.now().getTime()) / 1000));
      renewed.push(cookieFor(COOKIE_NAME, restored.token, maxAge, secure));
      if (restored.device) renewed.push(cookieFor(DEVICE_COOKIE, restored.device.token, restored.device.maxAgeSeconds, secure));
    } else {
      // The device is no longer trusted (forgotten or expired): drop its cookie.
      renewed.push(cookieFor(DEVICE_COOKIE, '', 0, secure));
    }
  }
  const info = deps.auth.sessionInfo(token);
  const authenticated = info !== null;
  const done = (result: RouteResult) => withCookies(result, renewed.concat(result.headers['Set-Cookie'] ? [result.headers['Set-Cookie']] : [], result.cookies ?? []));

  if (pathname === '/api/auth/session') {
    if (method !== 'GET') return notAllowed('GET');
    return done(authenticated ? json(200, { authenticated: true, strength: info.strength }) : json(401, { error: 'unauthorized' }));
  }

  if (pathname.startsWith('/api/')) {
    if (!authenticated) return done(json(401, { error: 'unauthorized' }));
    if ((method === 'POST' || method === 'PUT') && !(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return done(json(415, { error: 'unsupported_media_type' }));
    }

    // ---------- security: passkeys and trusted devices ----------
    if (pathname.startsWith('/api/auth/')) return done(securityRoute(request, deps, token, info.deviceId));

    const result = apiRoute(method, pathname, new URLSearchParams(request.search ?? ''), deps.store, deps.now(), request.body);
    return done(result ? json(result.status, result.body) : json(404, { error: 'not_found' }));
  }
  return json(404, { error: 'not_found' });
}

/** Passkey and device management. Changes need a session that started with a password or passkey. */
function securityRoute(request: AppRequest, deps: AppDeps, token: string | null, deviceId: string | null): RouteResult {
  const { method, pathname } = request;
  const parts = pathname.split('/').filter(Boolean); // api, auth, ...
  const sub = parts.slice(2).join('/');
  const reauth = () => json(403, { error: 'reauth_required' });

  if (sub === 'security') {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
    return json(200, { strength: deps.auth.sessionInfo(token)?.strength, passkeysAvailable: deps.auth.passkeysAvailable, passkeys: deps.auth.listPasskeys(), devices: deps.auth.listDevices(deviceId) });
  }
  if (sub === 'passkey/register/options') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (!deps.auth.passkeysAvailable) return json(503, NO_PASSKEYS);
    const options = deps.auth.passkeyRegisterOptions(token);
    return options ? json(200, options) : reauth();
  }
  if (sub === 'passkey/register') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const body = parseJson(request);
    const credential = body?.credential as RegistrationInput | undefined;
    if (!body || !credential?.response || typeof credential.rawId !== 'string') return json(400, { error: 'bad_request' });
    const result = deps.auth.passkeyRegister(token, credential, typeof body.name === 'string' ? body.name : '');
    if (result.ok) return json(200, { ok: true });
    return result.error === 'reauth_required' ? reauth() : json(result.error === 'passkeys_not_configured' ? 503 : 400, { error: result.error });
  }
  if (parts[2] === 'passkeys' && parts.length === 4) {
    if (method !== 'DELETE') return json(405, { error: 'method_not_allowed' });
    if (!deps.auth.isFullSession(token)) return reauth();
    return deps.auth.removePasskey(token, decodeURIComponent(parts[3]!)) ? json(200, { ok: true }) : json(404, { error: 'not_found' });
  }
  if (sub === 'devices/trust') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const body = parseJson(request);
    const issued = deps.auth.trustDevice(token, typeof body?.name === 'string' ? body.name : 'Aparelho');
    if (!issued) return reauth();
    return withCookies(json(200, { ok: true }), [cookieFor(DEVICE_COOKIE, issued.token, issued.maxAgeSeconds, deps.secureCookies)]);
  }
  if (parts[2] === 'devices' && parts.length === 4) {
    if (method !== 'DELETE') return json(405, { error: 'method_not_allowed' });
    if (!deps.auth.isFullSession(token)) return reauth();
    const forgotten = deps.auth.forgetDevice(token, decodeURIComponent(parts[3]!));
    if (!forgotten) return json(404, { error: 'not_found' });
    // Forgetting the device this browser is using also clears its cookie.
    const own = decodeURIComponent(parts[3]!) === deviceId;
    return withCookies(json(200, { ok: true }), own ? [cookieFor(DEVICE_COOKIE, '', 0, deps.secureCookies)] : []);
  }
  return json(404, { error: 'not_found' });
}
