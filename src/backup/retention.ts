import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Removes the oldest copies in a folder so only the newest `keep` stay. Only files that start with `prefix` and end
 * with `.sqlite` are touched, and the names carry an ISO timestamp, so sorting by name is sorting by age.
 * Returns the names removed. A file that cannot be removed is left and does not stop the others.
 */
export function pruneCopies(dir: string, prefix: string, keep: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite')).sort();
  } catch {
    return [];
  }
  const old = names.slice(0, Math.max(0, names.length - Math.max(1, keep)));
  const removed: string[] = [];
  for (const name of old) {
    try {
      rmSync(join(dir, name));
      removed.push(name);
    } catch {
      // Left for the next time.
    }
  }
  return removed;
}

/** Throws when the copy is missing or empty, so a reset never goes on with a copy that protects nothing. */
export function assertCopyWritten(file: string): void {
  if (statSync(file).size === 0) throw new Error(`a cópia do banco ficou vazia (${file}), então a leitura completa não foi feita`);
}
