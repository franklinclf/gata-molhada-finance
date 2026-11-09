import type { AuthService } from '../auth/service.ts';
import type { AssertionInput, RegistrationInput } from '../auth/webauthn.ts';
import { transactionsCsv, type CsvStyle } from '../api/export.ts';
import { explore } from '../api/explorer.ts';
import { apiRoute, parseExplorer } from '../api/routes.ts';
import { readBillFile } from '../api/bill-import.ts';
import { localDay } from '../core/time.ts';
import type { AnalystReply } from '../ai/analyst.ts';
import type { AiRunReply, AiRunScope } from '../ai/job.ts';
import { decide, validSignature, type DeployHook } from './deploy-hook.ts';
import { parsePluggyEvent, tokenMatches, type PluggyHook } from './pluggy-hook.ts';
import type { Resetter } from '../sync/reset.ts';
import { route, type RouteResult, type RouterDeps } from './router.ts';

export interface AppRequest {
  method: string;
  pathname: string;
  /** Query string without the leading question mark. */
  search?: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** The raw body of a file upload. Only the routes that take a file get it (see LARGE_BODIES in server.ts); their `body` is empty. */
  bytes?: Uint8Array;
}

export interface AppDeps extends RouterDeps {
  auth: AuthService;
  /** Send the session cookie only over HTTPS. Turn off for local development over plain HTTP. */
  secureCookies: boolean;
  /** Builds an encrypted copy of the database. Absent when backups are not available. */
  backup?: (passphrase: string) => Buffer | Promise<Buffer>;
  /** Lets GitHub tell the app that a new image was published. Absent (and the route answers 404) when no secret is set. */
  deployHook?: DeployHook;
  /** Reads everything the source has again (soft or hard reset). Absent when no source can be read. */
  resetter?: Resetter;
  /** Lets Pluggy tell the app that an item changed. Absent (and the route answers 404) when no secret is set. */
  pluggyHook?: PluggyHook;
  /** Checks the source often for a while, because the owner asked for a refresh at Meu Pluggy. Null or absent when nothing watches the source. */
  watchSources?: () => { until: string } | null;
  /** Answers a question to the analyst. Absent when the AI is off. */
  /** Asks the categorizer now, for everything pending, everything again, or one transaction. Absent when the AI is off. */
  categorize?: (scope: AiRunScope) => Promise<AiRunReply>;
  analyst?: (input: { conversationId?: number; question: string }) => Promise<AnalystReply>;
  /** Asks the host to look for a newer image now. Returns false when asked too recently. Absent when the app does not run under the deploy service. */
  deployNow?: () => boolean;
  /** When this process started, which is when the running version went up. */
  startedAt?: string;
}

let chatBusy = false;
let categorizeBusy = false;

export const COOKIE_NAME = 'gmf_session';
const VIEW_CACHES = new WeakMap<object, Map<string, { changes: number; at: number; body: unknown }>>();
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

/** The address the proxy saw: the last entry of X-Forwarded-For, which is the one the proxy added itself. */
const clientOf = (request: AppRequest): string => {
  const forwarded = request.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim();
  return last && last.length <= 64 ? last : 'unknown';
};

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
    const client = clientOf(request);
    const result = deps.auth.login(body.password, body.code, trustFrom(body), client);
    // A trace of failed sign-ins and lockouts, with the address and never the password or code.
    if (!result.ok && result.reason !== 'not_configured') console.warn(`login ${result.reason} from ${client}`);
    return loginResponse(result, deps);
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

  // GitHub's webhook cannot hold a session: it proves who it is with a signature over the body.
  if (pathname === '/api/hooks/deploy') {
    if (!deps.deployHook) return json(404, { error: 'not_found' });
    if (method !== 'POST') return notAllowed('POST');
    if (!validSignature(request.body, request.headers['x-hub-signature-256'], deps.deployHook.secret)) return json(401, { error: 'bad_signature' });
    let payload: unknown = null;
    try {
      payload = JSON.parse(request.body);
    } catch {
      return json(400, { error: 'bad_request' });
    }
    const decision = decide(request.headers['x-github-event'], payload);
    if (decision === 'deploy') deps.deployHook.trigger();
    return json(202, { decision });
  }

  // Pluggy's webhook cannot hold a session or set headers from its dashboard, so the secret is the last path segment.
  // A wrong or missing token gets the same 404 as a route that does not exist.
  if (pathname.startsWith('/api/hooks/pluggy/')) {
    if (!deps.pluggyHook || !tokenMatches(pathname.slice('/api/hooks/pluggy/'.length), deps.pluggyHook.secret)) return json(404, { error: 'not_found' });
    if (method !== 'POST') return notAllowed('POST');
    let payload: unknown = null;
    try {
      payload = JSON.parse(request.body);
    } catch {
      return json(400, { error: 'bad_request' });
    }
    // Pluggy stops retrying after a 4xx, so everything that parsed is acknowledged, even events this app does not use.
    const event = parsePluggyEvent(payload);
    if (event) deps.pluggyHook.onEvent(event);
    return json(202, { received: event !== null });
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
    // A statement upload is the one body that is not JSON. application/pdf is not a type a cross-site form can send either.
    const upload = method === 'POST' && pathname === '/api/bill-files';
    const contentType = (request.headers['content-type'] ?? '').toLowerCase();
    if ((method === 'POST' || method === 'PUT') && !contentType.startsWith(upload ? 'application/pdf' : 'application/json')) {
      return done(json(415, { error: 'unsupported_media_type' }));
    }
    if (upload) {
      // The file name in ?name= is for display in the browser only: it is not read, stored or logged here. The body arrives as bytes (see LARGE_BODIES in server.ts).
      const result = readBillFile(deps.store, request.bytes ?? new Uint8Array(), deps.now());
      return done(result.ok ? json(200, result.value) : json(result.status, { error: result.error, message: result.message }));
    }

    // ---------- security: passkeys and trusted devices ----------
    if (pathname.startsWith('/api/auth/')) return done(securityRoute(request, deps, token, info.deviceId));

    if (pathname === '/api/reset') {
      if (method === 'GET') return done(json(200, { available: deps.resetter !== undefined, ...(deps.resetter?.state() ?? {}) }));
      if (method !== 'POST') return done(notAllowed('GET, POST'));
      if (!deps.resetter) return done(json(503, { error: 'unavailable' }));
      // Rebuilding everything from the source changes what every screen shows, so it needs a recent password or passkey sign-in.
      if (!deps.auth.isFullSession(token)) return done(json(403, { error: 'reauth_required' }));
      const input = parseJson(request);
      if (input?.mode !== 'soft' && input?.mode !== 'hard') return done(json(400, { error: 'bad_request', message: 'mode must be soft or hard' }));
      const started = deps.resetter.start(input.mode);
      return done(started.started ? json(202, { started: true }) : json(409, { error: 'blocked', reason: started.reason }));
    }

    if (pathname === '/api/version') {
      if (method !== 'GET') return done(notAllowed('GET'));
      return done(json(200, { version: deps.version, startedAt: deps.startedAt ?? null, canDeploy: deps.deployNow !== undefined }));
    }
    if (pathname === '/api/deploy/check') {
      if (method !== 'POST') return done(notAllowed('POST'));
      if (!deps.deployNow) return done(json(503, { error: 'unavailable' }));
      // Starting a deploy is not dangerous in itself (it adopts the newest image that passed CI), but it restarts the app, so it needs a recent sign-in.
      if (!deps.auth.isFullSession(token)) return done(json(403, { error: 'reauth_required' }));
      return done(deps.deployNow() ? json(202, { asked: true }) : json(429, { error: 'too_soon' }));
    }
    if (pathname === '/api/sources/watch') {
      if (method !== 'POST') return done(notAllowed('POST'));
      const watching = deps.watchSources?.() ?? null;
      return done(watching ? json(202, watching) : json(503, { error: 'unavailable' }));
    }
    if (pathname === '/api/ai/run') {
      if (method !== 'POST') return done(notAllowed('POST'));
      if (!deps.categorize) return done(json(503, { error: 'unavailable' }));
      const input = parseJson(request);
      const kind = input?.scope;
      const id = typeof input?.transactionId === 'string' ? input.transactionId : '';
      if (kind !== 'pending' && kind !== 'all' && !(kind === 'transaction' && id !== '')) return done(json(400, { error: 'bad_request', message: 'scope must be pending, all or transaction (with transactionId)' }));
      // Asking again about everything spends money and replaces the model's earlier answers, so it needs a recent sign-in.
      if (kind === 'all' && !deps.auth.isFullSession(token)) return done(json(403, { error: 'reauth_required' }));
      if (categorizeBusy) return done(json(429, { error: 'busy', message: 'a IA já está trabalhando' }));
      const categorize = deps.categorize;
      const scope: AiRunScope = kind === 'transaction' ? { kind, id } : { kind };
      const base = done(json(200, {}));
      return {
        ...base,
        deferred: async () => {
          categorizeBusy = true;
          try {
            return json(200, await categorize(scope));
          } catch (error) {
            return error instanceof RangeError ? json(400, { error: 'bad_request', message: error.message }) : json(500, { error: 'internal_error' });
          } finally {
            categorizeBusy = false;
          }
        },
      };
    }
    if (pathname === '/api/chat/status') return method === 'GET' ? done(json(200, { available: deps.analyst !== undefined })) : done(notAllowed('GET'));
    if (pathname === '/api/chat' && method !== 'POST') return done(notAllowed('POST'));
    if (pathname === '/api/chat' && method === 'POST') {
      if (!deps.analyst) return done(json(503, { error: 'unavailable' }));
      const input = parseJson(request);
      const question = typeof input?.question === 'string' ? input.question : '';
      const conversationId = typeof input?.conversationId === 'number' && Number.isInteger(input.conversationId) ? input.conversationId : undefined;
      if (question.trim() === '') return done(json(400, { error: 'bad_request', message: 'question is required' }));
      if (chatBusy) return done(json(429, { error: 'busy', message: 'uma pergunta ainda está sendo respondida' }));
      const analyst = deps.analyst;
      const base = done(json(200, {}));
      return {
        ...base,
        deferred: async () => {
          chatBusy = true;
          try {
            return json(200, await analyst({ conversationId, question }));
          } catch (error) {
            return error instanceof RangeError ? json(400, { error: 'bad_request', message: error.message }) : json(500, { error: 'internal_error' });
          } finally {
            chatBusy = false;
          }
        },
      };
    }

    if (pathname === '/api/export/transactions.csv') {
      if (method !== 'GET') return done(notAllowed('GET'));
      const params = new URLSearchParams(request.search ?? '');
      const parsed = parseExplorer(params);
      if (!parsed.ok) return done(json(400, { error: 'bad_request', message: parsed.error }));
      const ids = new Set(params.getAll('id'));
      // Rows picked by hand come as they are, whatever the other filters say.
      const query = ids.size > 0 ? { ...parsed.value, from: undefined, to: undefined, kind: 'all' as const, categories: undefined, accountIds: undefined, institutions: undefined, q: undefined, merchant: undefined, status: undefined, states: undefined, min: undefined, max: undefined, cycle: undefined, spendingOnly: false, hideOwnTransfers: false, includeExcluded: true } : parsed.value;
      const result = explore(deps.store, { ...query, limit: 200_000, offset: 0 }, deps.now());
      const rows = ids.size > 0 ? result.items.filter((t) => ids.has(t.id)) : result.items;
      const style: CsvStyle = params.get('style') === 'intl' ? 'intl' : 'br';
      const name = `transacoes-${localDay(deps.now().toISOString())}.csv`;
      return done({ status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, ...SECURITY_HEADERS }, body: transactionsCsv(rows, localDay, style) });
    }

    if (pathname === '/api/backup') {
      if (method !== 'POST') return done(notAllowed('POST'));
      if (!deps.backup) return done(json(503, { error: 'unavailable' }));
      // A copy of everything leaves the server, so it needs a recent password or passkey sign-in, like changing how you sign in.
      if (!deps.auth.isFullSession(token)) return done(json(403, { error: 'reauth_required' }));
      const input = parseJson(request);
      const passphrase = typeof input?.passphrase === 'string' ? input.passphrase : '';
      if (passphrase.length < 12) return done(json(400, { error: 'bad_request', message: 'the passphrase needs at least 12 characters' }));
      const file = deps.backup(passphrase);
      const sent = (bytes: Buffer): RouteResult => ({ status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="gmf-backup-${localDay(deps.now().toISOString())}.gmfbak"`, ...SECURITY_HEADERS }, body: null, bytes });
      if (Buffer.isBuffer(file)) return done(sent(file));
      // Packing a large database takes a while, so it runs in the background and the server keeps answering meanwhile.
      return {
        ...done(json(200, {})),
        deferred: async () => {
          try {
            return sent(await file);
          } catch (error) {
            console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
            return json(500, { error: 'internal_error' });
          }
        },
      };
    }

    const now = deps.now();
    // A view is computed from the whole database, so it is kept until the data changes or a minute passes (dates and "ago" texts move with the clock).
    const VIEW_CACHE = VIEW_CACHES.get(deps.store) ?? new Map<string, { changes: number; at: number; body: unknown }>();
    VIEW_CACHES.set(deps.store, VIEW_CACHE);
    const cacheKey = method === 'GET' ? `${pathname}?${request.search ?? ''}` : null;
    const changes = deps.store.changeCount();
    const cached = cacheKey === null ? undefined : VIEW_CACHE.get(cacheKey);
    if (cached && cached.changes === changes && now.getTime() - cached.at < 60_000) return done(json(200, cached.body));
    const result = apiRoute(method, pathname, new URLSearchParams(request.search ?? ''), deps.store, now, request.body);
    if (cacheKey !== null && result?.status === 200 && deps.store.changeCount() === changes) {
      if (VIEW_CACHE.size >= 300) VIEW_CACHE.delete(VIEW_CACHE.keys().next().value as string);
      VIEW_CACHE.set(cacheKey, { changes, at: now.getTime(), body: result.body });
    }
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
