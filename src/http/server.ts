import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AuthService } from '../auth/service.ts';
import { handle, type AppDeps } from './app.ts';
import { serveStatic } from './static.ts';

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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
      const body = await readBody(req);
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        req.destroy();
        return;
      }
      const first = handle({ method, pathname: url.pathname, search: url.search.slice(1), headers: req.headers as Record<string, string | undefined>, body }, full);
      let result = first;
      if (first.deferred) {
        const real = await first.deferred();
        // Cookies the first answer set (a renewed session) are kept next to the real answer.
        result = { ...real, headers: { ...first.headers, ...real.headers }, cookies: [...(first.cookies ?? []), ...(real.cookies ?? [])] };
      }
      const setCookie = [result.headers['Set-Cookie'], ...(result.cookies ?? [])].filter((c): c is string => c !== undefined);
      res.writeHead(result.status, setCookie.length > 0 ? { ...result.headers, 'Set-Cookie': setCookie } : result.headers);
      res.end(result.bytes ?? result.body ?? undefined);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });
}
