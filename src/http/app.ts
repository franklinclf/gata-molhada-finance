import type { AuthService } from '../auth/service.ts';
import { route, type RouteResult, type RouterDeps } from './router.ts';

export interface AppRequest {
  method: string;
  pathname: string;
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

export function handle(request: AppRequest, deps: AppDeps): RouteResult {
  const { method, pathname } = request;
  if (pathname === '/healthz') return route(method, pathname, deps);

  if (pathname === '/api/auth/login') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const body = parseJson(request);
    if (!body || typeof body.password !== 'string' || typeof body.code !== 'string') return json(400, { error: 'bad_request' });
    const result = deps.auth.login(body.password, body.code);
    if (result.ok) {
      const maxAge = Math.max(1, Math.floor((Date.parse(result.expiresAt) - deps.now().getTime()) / 1000));
      return json(200, { expiresAt: result.expiresAt }, { 'Set-Cookie': sessionCookie(result.token, maxAge, deps.secureCookies) });
    }
    if (result.reason === 'locked') return json(429, { error: 'too_many_attempts', retryAfterSeconds: result.retryAfterSeconds }, { 'Retry-After': String(result.retryAfterSeconds) });
    if (result.reason === 'not_configured') return json(503, { error: 'auth_not_configured' });
    return json(401, { error: 'invalid_credentials' });
  }

  const token = readCookie(request.headers.cookie, COOKIE_NAME);
  const authenticated = deps.auth.verifySession(token);

  if (pathname === '/api/auth/logout') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    deps.auth.logout(token);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, deps.secureCookies) });
  }
  if (pathname === '/api/auth/session') {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    return authenticated ? json(200, { authenticated: true }) : json(401, { error: 'unauthorized' });
  }

  if (pathname.startsWith('/api/')) {
    if (!authenticated) return json(401, { error: 'unauthorized' });
    return json(404, { error: 'not_found' });
  }
  return json(404, { error: 'not_found' });
}
