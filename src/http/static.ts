import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export interface StaticFile {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function readIfFile(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Serves the built web app. Unknown paths without a file extension get index.html, so the app can handle its own routes.
 * Returns null when there is nothing to serve (no build, or a missing asset).
 */
export async function serveStatic(root: string, pathname: string): Promise<StaticFile | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  if (relative.split(sep).includes('..')) return null;

  let file = relative === '' ? 'index.html' : relative;
  let body = await readIfFile(join(root, file));
  if (!body && extname(file) === '') {
    file = 'index.html';
    body = await readIfFile(join(root, file));
  }
  if (!body) return null;

  const hashed = file.startsWith(`assets${sep}`);
  return {
    status: 200,
    body,
    headers: {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
    },
  };
}
