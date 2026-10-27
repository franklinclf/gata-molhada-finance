export interface Config {
  port: number;
  dbPath: string;
  version: string;
  /** Run the observer that keeps the data fresh. Off unless OBSERVER is on, 1 or true. */
  observer: boolean;
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
    observer: ['on', '1', 'true'].includes((env.OBSERVER ?? '').trim().toLowerCase()),
  };
}
