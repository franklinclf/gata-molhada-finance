export interface SyncArgs {
  since: Date;
  /** Restrict the run to one source id; null means every configured source. */
  source: string | null;
}

const DEFAULT_DAYS = 90;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseSyncArgs(argv: string[], now: Date): SyncArgs {
  let since = new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
  let source: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      const value = argv[++i];
      if (value === undefined || !DAY_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
        throw new Error('--since expects a date like 2026-01-31');
      }
      since = new Date(`${value}T00:00:00.000Z`);
    } else if (arg === '--source') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error('--source expects a source id such as pierre or pluggy');
      source = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { since, source };
}
