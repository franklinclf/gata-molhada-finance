export interface Config {
  port: number;
  dbPath: string;
  version: string;
  /** Run the observer that keeps the data fresh. Off unless OBSERVER is on, 1 or true. */
  observer: boolean;
  /** Folder with the built web app. Empty turns static serving off. */
  webDir: string | null;
  /** Send the session cookie only over HTTPS. Set COOKIE_SECURE=off for local development over HTTP. */
  secureCookies: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawPort = env.PORT ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  return {
    port,
    dbPath: env.DB_PATH ?? 'data/gmf.sqlite',
    version: env.APP_VERSION ?? 'dev',
    secureCookies: (env.COOKIE_SECURE ?? '').trim().toLowerCase() !== 'off',
    webDir: env.WEB_DIR === undefined ? 'dist/web' : env.WEB_DIR.trim() || null,
    observer: ['on', '1', 'true'].includes((env.OBSERVER ?? '').trim().toLowerCase()),
  };
}
