import { createServer, type Server } from 'node:http';
import { route, type RouterDeps } from './router.ts';

export function createHttpServer(deps: Partial<RouterDeps> & Pick<RouterDeps, 'store' | 'version'>): Server {
  const full: RouterDeps = { now: () => new Date(), ...deps };
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const result = route(req.method ?? 'GET', url.pathname, full);
    res.writeHead(result.status, result.headers);
    res.end(result.body ?? undefined);
  });
}
