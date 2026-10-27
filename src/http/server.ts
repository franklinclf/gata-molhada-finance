import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AuthService } from '../auth/service.ts';
import { handle, type AppDeps } from './app.ts';

const MAX_BODY_BYTES = 16 * 1024;

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

export function createHttpServer(deps: Partial<AppDeps> & Pick<AppDeps, 'store' | 'version'>): Server {
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
      const body = await readBody(req);
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        req.destroy();
        return;
      }
      const result = handle({ method: req.method ?? 'GET', pathname: url.pathname, search: url.search.slice(1), headers: req.headers as Record<string, string | undefined>, body }, full);
      res.writeHead(result.status, result.headers);
      res.end(result.body ?? undefined);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });
}
