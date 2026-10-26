import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const migrations = files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new Error(`Invalid migration file name: ${file}`);
    return { version: Number(match[1]), name: file, sql: readFileSync(join(dir, file), 'utf8') };
  });
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(`Migration numbering must be 001, 002, ... without gaps or duplicates (found ${m.name} at position ${index + 1})`);
    }
  });
  return migrations;
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DatabaseSync, dir: string): number {
  const migrations = loadMigrations(dir);
  const applied = currentVersion(db);
  if (applied > migrations.length) {
    throw new Error(`Database is at version ${applied} but only ${migrations.length} migrations exist`);
  }
  for (const m of migrations.slice(applied)) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return migrations.length;
}
