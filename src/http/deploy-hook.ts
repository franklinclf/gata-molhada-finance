import { createHmac, timingSafeEqual } from 'node:crypto';

/** True when `header` (GitHub's X-Hub-Signature-256: "sha256=<hex>") is the HMAC-SHA256 of the raw body under the secret. */
export function validSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('sha256=') || secret === '') return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type HookDecision = 'ping' | 'deploy' | 'ignore';

/**
 * What a GitHub webhook delivery means for the deploy. Only a finished, successful run of the CI workflow on main
 * counts, because that run publishes the image as its last job. Everything else (other branches, pull requests,
 * failed runs, other events) is acknowledged and ignored.
 */
export function decide(event: string | undefined, payload: unknown): HookDecision {
  if (event === 'ping') return 'ping';
  if (event !== 'workflow_run' || typeof payload !== 'object' || payload === null) return 'ignore';
  const { action, workflow_run: run } = payload as { action?: unknown; workflow_run?: Record<string, unknown> };
  if (action !== 'completed' || !run) return 'ignore';
  return run.name === 'CI' && run.conclusion === 'success' && run.head_branch === 'main' && run.event === 'push' ? 'deploy' : 'ignore';
}

export interface DeployHook {
  secret: string;
  /** Tells the host a new image may be out. */
  trigger: () => unknown;
}

/** Keeps a burst of deliveries from touching the trigger more than once in a few seconds. */
export class Debounce {
  private last = 0;
  private readonly ms: number;
  private readonly now: () => number;

  constructor(ms: number, now: () => number = Date.now) {
    this.ms = ms;
    this.now = now;
  }

  allow(): boolean {
    const at = this.now();
    if (at - this.last < this.ms) return false;
    this.last = at;
    return true;
  }
}
