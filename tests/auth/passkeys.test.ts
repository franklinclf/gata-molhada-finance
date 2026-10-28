import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.ts';
import { AuthService } from '../../src/auth/service.ts';
import { base32Decode, generateTotpSecret, hotp, totpCounter } from '../../src/auth/totp.ts';
import { relyingPartyFor } from '../../src/auth/webauthn.ts';
import { handle, type AppDeps, type AppRequest } from '../../src/http/app.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { SoftAuthenticator } from '../support/authenticator.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const PASSWORD = 'a long test password';
const rp = relyingPartyFor('https://finance.example.com')!;

function setup() {
  const secret = generateTotpSecret();
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const clock = { ms: Date.parse('2026-10-28T12:00:00Z') };
  const now = () => new Date(clock.ms);
  const auth = new AuthService(store, { passwordHash: hashPassword(PASSWORD), totpSecret: secret, recoveryHashes: [] }, now, {}, rp);
  const deps: AppDeps = { store, version: 't', now, auth, secureCookies: true };
  // Moves to the next 30-second window each call, so a code is never reused.
  const code = () => {
    clock.ms += 30_000;
    return hotp(base32Decode(secret), totpCounter(clock.ms));
  };
  return { deps, clock, code, store };
}

type Jar = Map<string, string>;
const jar = (): Jar => new Map();

function cookieHeader(j: Jar): string {
  return [...j].map(([k, v]) => `${k}=${v}`).join('; ');
}

function call(deps: AppDeps, j: Jar, method: string, pathname: string, payload?: unknown): { status: number; body: any } {
  const request: AppRequest = { method, pathname, headers: { cookie: cookieHeader(j), 'content-type': 'application/json' }, body: payload === undefined ? '' : JSON.stringify(payload) };
  const res = handle(request, deps);
  for (const line of [res.headers['Set-Cookie'], ...(res.cookies ?? [])]) {
    if (!line) continue;
    const [pair, ...attrs] = line.split('; ');
    const [name, ...value] = pair!.split('=');
    if (attrs.some((a) => a === 'Max-Age=0')) j.delete(name!);
    else j.set(name!, value.join('='));
  }
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

function passwordLogin(t: ReturnType<typeof setup>, j: Jar, trust = false) {
  return call(t.deps, j, 'POST', '/api/auth/login', { password: PASSWORD, code: t.code(), trust, deviceName: 'Meu Mac' });
}

function registerPasskey(t: ReturnType<typeof setup>, j: Jar, device: SoftAuthenticator, name = 'Mac') {
  const options = call(t.deps, j, 'POST', '/api/auth/passkey/register/options', {});
  assert.equal(options.status, 200);
  assert.equal(options.body.authenticatorSelection.userVerification, 'required');
  return call(t.deps, j, 'POST', '/api/auth/passkey/register', { credential: device.create(options.body.challenge), name });
}

function passkeyLogin(t: ReturnType<typeof setup>, j: Jar, device: SoftAuthenticator, extra: Record<string, unknown> = {}) {
  const options = call(t.deps, j, 'POST', '/api/auth/passkey/login/options', {});
  assert.equal(options.status, 200);
  return call(t.deps, j, 'POST', '/api/auth/passkey/login', { credential: device.get(options.body.challenge), ...extra });
}

test('methods tell the login screen whether passkeys are available', () => {
  const t = setup();
  assert.deepEqual(call(t.deps, jar(), 'GET', '/api/auth/methods').body, { password: true, passkeys: true });
  const plain = new AuthService(t.store, null, () => new Date(t.clock.ms));
  assert.equal(handle({ method: 'GET', pathname: '/api/auth/methods', headers: {}, body: '' }, { ...t.deps, auth: plain }).status, 200);
  assert.equal(plain.passkeysAvailable, false);
  assert.equal(call({ ...t.deps, auth: new AuthService(t.store, { passwordHash: 'x', totpSecret: 'y', recoveryHashes: [] }, () => new Date(t.clock.ms)) }, jar(), 'POST', '/api/auth/passkey/login/options', {}).status, 503);
});

test('a signed-in user adds a passkey, then signs in with it alone', () => {
  const t = setup();
  const phone = new SoftAuthenticator(rp.id, rp.origin);
  const first = jar();
  assert.equal(passwordLogin(t, first).status, 200);
  assert.equal(registerPasskey(t, first, phone, 'Pixel').status, 200);
  assert.deepEqual(call(t.deps, first, 'GET', '/api/auth/security').body.passkeys.map((p: { name: string }) => p.name), ['Pixel']);

  const second = jar();
  assert.equal(call(t.deps, second, 'GET', '/api/balances').status, 401);
  const login = passkeyLogin(t, second, phone);
  assert.equal(login.status, 200);
  assert.equal(call(t.deps, second, 'GET', '/api/auth/session').body.strength, 'passkey');
  assert.equal(call(t.deps, second, 'GET', '/api/balances').status, 200);
});

test('registration needs a signed-in session, and a passkey cannot be added twice', () => {
  const t = setup();
  const device = new SoftAuthenticator(rp.id, rp.origin);
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/register/options', {}).status, 401);
  const j = jar();
  passwordLogin(t, j);
  assert.equal(registerPasskey(t, j, device).status, 200);
  const again = registerPasskey(t, j, device);
  assert.equal(again.status, 400);
  assert.equal(again.body.error, 'already_registered');
});

test('a challenge works once and only for its purpose', () => {
  const t = setup();
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const j = jar();
  passwordLogin(t, j);
  registerPasskey(t, j, device);
  const options = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).body;
  const assertion = device.get(options.challenge);
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: assertion }).status, 200);
  const replay = call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: assertion });
  assert.equal(replay.status, 401);
  // A login challenge cannot be used to add a passkey.
  const other = new SoftAuthenticator(rp.id, rp.origin);
  const loginChallenge = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).body.challenge;
  assert.equal(call(t.deps, j, 'POST', '/api/auth/passkey/register', { credential: other.create(loginChallenge), name: 'x' }).status, 400);
});

test('a challenge expires', () => {
  const t = setup();
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const j = jar();
  passwordLogin(t, j);
  registerPasskey(t, j, device);
  const options = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).body;
  t.clock.ms += 6 * 60_000;
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: device.get(options.challenge) }).status, 401);
});

test('a passkey from another site, an unknown key and a cloned counter are refused, and a flood of failures is slowed down', () => {
  const t = setup();
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const j = jar();
  passwordLogin(t, j);
  registerPasskey(t, j, device);
  const stranger = new SoftAuthenticator(rp.id, rp.origin);
  const o1 = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).body;
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: stranger.get(o1.challenge) }).status, 401);
  const o2 = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).body;
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: device.get(o2.challenge, { origin: 'https://evil.example.com' }) }).status, 401);
  assert.equal(passkeyLogin(t, jar(), device).status, 200);
  const o3 = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).body;
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: device.get(o3.challenge, { counter: 1 }) }).status, 401);
  for (let i = 0; i < 40; i++) {
    const o = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {});
    if (o.status === 429) break;
    call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: stranger.get(o.body.challenge) });
  }
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).status, 429);
});

test('a trusted device keeps the user signed in after the session ends, and the cookie changes every time', () => {
  const t = setup();
  const browser = jar();
  const login = passwordLogin(t, browser, true);
  assert.equal(login.body.trusted, true);
  assert.ok(browser.has('gmf_device'));
  const firstDevice = browser.get('gmf_device');

  t.clock.ms += 13 * 3_600_000; // the 12-hour session is over
  const session = call(t.deps, browser, 'GET', '/api/auth/session');
  assert.deepEqual([session.status, session.body.strength], [200, 'device']);
  assert.notEqual(browser.get('gmf_device'), firstDevice);

  // The old device cookie stops working after the grace period.
  t.clock.ms += 2 * 60_000;
  const thief = jar();
  thief.set('gmf_device', firstDevice!);
  assert.equal(call(t.deps, thief, 'GET', '/api/balances').status, 401);
  assert.equal(thief.has('gmf_device'), false);
});

test('a device is trusted for 30 days after its last use, and never past 90 days from the start', () => {
  const t = setup();
  const browser = jar();
  passwordLogin(t, browser, true);
  for (let week = 0; week < 8; week++) {
    t.clock.ms += 20 * 86_400_000;
    const res = call(t.deps, browser, 'GET', '/api/auth/session');
    if (t.clock.ms - Date.parse('2026-10-28T12:00:00Z') <= 90 * 86_400_000) assert.equal(res.status, 200, `day ${(week + 1) * 20}`);
    else {
      assert.equal(res.status, 401);
      return;
    }
  }
  assert.fail('the 90-day limit never applied');
});

test('a device that sat unused for more than 30 days is no longer trusted', () => {
  const t = setup();
  const browser = jar();
  passwordLogin(t, browser, true);
  t.clock.ms += 31 * 86_400_000;
  assert.equal(call(t.deps, browser, 'GET', '/api/auth/session').status, 401);
});

test('signing out forgets the device, and forgetting a device ends its sessions', () => {
  const t = setup();
  const browser = jar();
  passwordLogin(t, browser, true);
  call(t.deps, browser, 'POST', '/api/auth/logout', {});
  assert.equal(browser.has('gmf_device'), false);
  assert.equal(t.store.listDevices(new Date(t.clock.ms).toISOString()).length, 0);

  const other = jar();
  passwordLogin(t, other, true);
  const admin = jar();
  passwordLogin(t, admin);
  t.clock.ms += 13 * 3_600_000;
  assert.equal(call(t.deps, other, 'GET', '/api/auth/session').status, 200);
  const adminAgain = jar();
  passwordLogin(t, adminAgain);
  const devices = call(t.deps, adminAgain, 'GET', '/api/auth/security').body.devices;
  assert.equal(devices.length, 1);
  assert.equal(call(t.deps, adminAgain, 'DELETE', `/api/auth/devices/${devices[0].id}`).status, 200);
  assert.equal(call(t.deps, other, 'GET', '/api/auth/session').status, 401);
});

test('a session restored from a device cannot change how you sign in', () => {
  const t = setup();
  const browser = jar();
  passwordLogin(t, browser, true);
  t.clock.ms += 13 * 3_600_000;
  assert.equal(call(t.deps, browser, 'GET', '/api/auth/session').body.strength, 'device');
  assert.equal(call(t.deps, browser, 'POST', '/api/auth/passkey/register/options', {}).status, 403);
  assert.equal(call(t.deps, browser, 'POST', '/api/auth/devices/trust', { name: 'x' }).status, 403);
  assert.equal(call(t.deps, browser, 'DELETE', '/api/auth/passkeys/anything').status, 403);
  assert.equal(call(t.deps, browser, 'DELETE', '/api/auth/devices/anything').status, 403);
  assert.equal(call(t.deps, browser, 'GET', '/api/balances').status, 200);
});

test('a signed-in session can trust its device later, and remove a passkey', () => {
  const t = setup();
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const j = jar();
  passwordLogin(t, j);
  assert.equal(call(t.deps, j, 'POST', '/api/auth/devices/trust', { name: 'Notebook' }).status, 200);
  assert.ok(j.has('gmf_device'));
  registerPasskey(t, j, device);
  const id = call(t.deps, j, 'GET', '/api/auth/security').body.passkeys[0].id;
  assert.equal(call(t.deps, j, 'DELETE', `/api/auth/passkeys/${id}`).status, 200);
  assert.equal(call(t.deps, j, 'DELETE', `/api/auth/passkeys/${id}`).status, 404);
  assert.equal(passkeyLogin(t, jar(), device).status, 401);
});

test('a passkey login can also trust the device', () => {
  const t = setup();
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const j = jar();
  passwordLogin(t, j);
  registerPasskey(t, j, device);
  const fresh = jar();
  assert.equal(passkeyLogin(t, fresh, device, { trust: true, deviceName: 'Celular' }).body.trusted, true);
  t.clock.ms += 13 * 3_600_000;
  assert.equal(call(t.deps, fresh, 'GET', '/api/auth/session').body.strength, 'device');
});

test('failed passkey attempts never lock the password login, and the pile of challenges stays bounded', () => {
  const t = setup();
  const stranger = new SoftAuthenticator(rp.id, rp.origin);
  for (let i = 0; i < 40; i++) {
    const o = call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {});
    if (o.status !== 200) break;
    call(t.deps, jar(), 'POST', '/api/auth/passkey/login', { credential: stranger.get(o.body.challenge) });
  }
  assert.equal(call(t.deps, jar(), 'POST', '/api/auth/passkey/login/options', {}).status, 429);
  assert.equal(passwordLogin(t, jar()).status, 200);

  const flood = setup();
  for (let i = 0; i < 300; i++) call(flood.deps, jar(), 'POST', '/api/auth/passkey/login/options', {});
  // The oldest challenges were dropped, the newest still work.
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const j = jar();
  passwordLogin(flood, j);
  assert.equal(registerPasskey(flood, j, device).status, 200);
  assert.equal(passkeyLogin(flood, jar(), device).status, 200);
});

test('adding or removing ways to sign in needs a recent sign-in, not just any session', () => {
  const t = setup();
  const j = jar();
  passwordLogin(t, j);
  t.clock.ms += 20 * 60_000;
  assert.equal(call(t.deps, j, 'GET', '/api/balances').status, 200);
  assert.equal(call(t.deps, j, 'POST', '/api/auth/passkey/register/options', {}).status, 403);
  assert.equal(call(t.deps, j, 'POST', '/api/auth/devices/trust', { name: 'x' }).status, 403);
  assert.equal(call(t.deps, j, 'DELETE', '/api/auth/passkeys/x').status, 403);
});

test('requests sent in parallel with the old device cookie still work, and the old cookie later means theft', () => {
  const t = setup();
  const browser = jar();
  passwordLogin(t, browser, true);
  const original = browser.get('gmf_device')!;
  t.clock.ms += 13 * 3_600_000;

  const first = jar();
  first.set('gmf_device', original);
  assert.equal(call(t.deps, first, 'GET', '/api/balances').status, 200);
  const rotated = first.get('gmf_device')!;
  assert.notEqual(rotated, original);

  // A second request that still carries the old cookie, a few seconds later.
  t.clock.ms += 5_000;
  const parallel = jar();
  parallel.set('gmf_device', original);
  assert.equal(call(t.deps, parallel, 'GET', '/api/balances').status, 200);
  assert.equal(parallel.get('gmf_device'), original, 'the cookie is not cleared inside the grace period');
  // The new cookie keeps working.
  assert.equal(call(t.deps, first, 'GET', '/api/auth/session').status, 200);

  // Later, the old cookie shows up again: it was copied. The device is revoked for everyone.
  t.clock.ms += 5 * 60_000;
  const thief = jar();
  thief.set('gmf_device', original);
  assert.equal(call(t.deps, thief, 'GET', '/api/balances').status, 401);
  t.clock.ms += 13 * 3_600_000;
  assert.equal(call(t.deps, first, 'GET', '/api/balances').status, 401);
});

test('forgetting a device also ends the full session it was trusted from', () => {
  const t = setup();
  const laptop = jar();
  passwordLogin(t, laptop, true);
  const mine = jar();
  passwordLogin(t, mine);
  const id = call(t.deps, mine, 'GET', '/api/auth/security').body.devices[0].id;
  assert.equal(call(t.deps, laptop, 'GET', '/api/auth/security').body.devices[0].current, true);
  assert.equal(call(t.deps, mine, 'DELETE', `/api/auth/devices/${id}`).status, 200);
  assert.equal(call(t.deps, laptop, 'GET', '/api/balances').status, 401);
});

test('trusting the device later also ties the current session to it', () => {
  const t = setup();
  const j = jar();
  passwordLogin(t, j);
  call(t.deps, j, 'POST', '/api/auth/devices/trust', { name: 'Notebook' });
  const id = call(t.deps, j, 'GET', '/api/auth/security').body.devices[0].id;
  const other = jar();
  passwordLogin(t, other);
  call(t.deps, other, 'DELETE', `/api/auth/devices/${id}`);
  assert.equal(call(t.deps, j, 'GET', '/api/balances').status, 401);
});

test('signing out after the session ended still forgets the trusted device', () => {
  const t = setup();
  const browser = jar();
  passwordLogin(t, browser, true);
  t.clock.ms += 13 * 3_600_000;
  assert.equal(call(t.deps, browser, 'POST', '/api/auth/logout', {}).status, 200);
  assert.equal(t.store.listDevices(new Date(t.clock.ms).toISOString()).length, 0);
  assert.equal(browser.has('gmf_device'), false);
});
