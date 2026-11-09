import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_BILL_FILE_BYTES, MAX_VISION_BODY_BYTES } from '../api/bill-import.ts';
import { AuthService } from '../auth/service.ts';
import { COOKIE_NAME, handle, readCookie, type AppDeps } from './app.ts';
import { serveStatic } from './static.ts';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Routes (POST) with a larger body cap than the rest. Their body is read only after the session cookie checks out, and a
 * declared size over the cap is refused before reading, so a stranger cannot make the server hold megabytes. A `raw` one
 * takes a file as bytes; the others are JSON like every route.
 */
const LARGE_BODIES = new Map<string, { cap: number; raw: boolean }>([
  ['/api/bill-files', { cap: MAX_BILL_FILE_BYTES, raw: true }],
  ['/api/bill-files/vision', { cap: MAX_VISION_BODY_BYTES, raw: false }],
]);

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Answers without reading the rest of the body, and closes the connection once the answer is out. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify({ error }), () => req.destroy());
}

export function createHttpServer(deps: Partial<AppDeps> & Pick<AppDeps, 'store' | 'version'>, webRoot: string | null = null): Server {
  const now = deps.now ?? (() => new Date());
  const full: AppDeps = {
    now,
    auth: new AuthService(deps.store, null, now),
    secureCookies: true,
    ...deps,
  };
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const isApp = url.pathname === '/healthz' || url.pathname.startsWith('/api/');
      if (webRoot && !isApp && (method === 'GET' || method === 'HEAD')) {
        const file = await serveStatic(webRoot, url.pathname);
        if (file) {
          res.writeHead(file.status, { ...file.headers, 'Content-Length': String(file.body.length) });
          res.end(method === 'HEAD' ? undefined : file.body);
          return;
        }
      }
      const large = method === 'POST' ? LARGE_BODIES.get(url.pathname) : undefined;
      if (large) {
        if (!full.auth.verifySession(readCookie(req.headers.cookie, COOKIE_NAME))) return refuse(req, res, 401, 'unauthorized');
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > large.cap) return refuse(req, res, 413, 'payload_too_large');
      }
      const raw = await readBody(req, large?.cap ?? MAX_BODY_BYTES);
      if (raw === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        req.destroy();
        return;
      }
      const base = { method, pathname: url.pathname, search: url.search.slice(1), headers: req.headers as Record<string, string | undefined> };
      // A file stays bytes: decoding it as text would corrupt it.
      const first = handle(large?.raw ? { ...base, body: '', bytes: raw } : { ...base, body: raw.toString('utf8') }, full);
      let result = first;
      if (first.deferred) {
        const real = await first.deferred();
        // Cookies the first answer set (a renewed session) are kept next to the real answer.
        result = { ...real, headers: { ...first.headers, ...real.headers }, cookies: [...(first.cookies ?? []), ...(real.cookies ?? [])] };
      }
      const setCookie = [result.headers['Set-Cookie'], ...(result.cookies ?? [])].filter((c): c is string => c !== undefined);
      res.writeHead(result.status, setCookie.length > 0 ? { ...result.headers, 'Set-Cookie': setCookie } : result.headers);
      res.end(result.bytes ?? result.body ?? undefined);
    })().catch((error: unknown) => {
      console.error(`request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });
}
