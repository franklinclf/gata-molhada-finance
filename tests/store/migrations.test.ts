import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentVersion, loadMigrations, migrate } from '../../src/store/migrations.ts';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

test('applies migrations in order and records the version', () => {
  const dir = dirWith({
    '001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '002_b.sql': 'CREATE TABLE b (id INTEGER);',
  });
  const db = new DatabaseSync(':memory:');
  assert.equal(migrate(db, dir), 2);
  assert.equal(currentVersion(db), 2);
  db.prepare('INSERT INTO a VALUES (1)').run();
  db.prepare('INSERT INTO b VALUES (1)').run();
});

test('is idempotent: a second run applies nothing', () => {
  const dir = dirWith({ '001_a.sql': 'CREATE TABLE a (id INTEGER);' });
  const db = new DatabaseSync(':memory:');
  migrate(db, dir);
  assert.equal(migrate(db, dir), 1);
  assert.equal(currentVersion(db), 1);
});

test('applies only the migrations added since the last run', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, dirWith({ '001_a.sql': 'CREATE TABLE a (id INTEGER);' }));
  const dir = dirWith({
    '001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '002_b.sql': 'CREATE TABLE b (id INTEGER);',
  });
  migrate(db, dir);
  assert.equal(currentVersion(db), 2);
});

test('rolls back a failing migration and keeps the previous version', () => {
  const dir = dirWith({
    '001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '002_bad.sql': 'CREATE TABLE b (id INTEGER); INSERT INTO missing VALUES (1);',
  });
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db, dir), /Migration 002_bad.sql failed/);
  assert.equal(currentVersion(db), 1);
  assert.throws(() => db.prepare('SELECT * FROM b').get(), /no such table/);
});

test('rejects gaps and bad file names', () => {
  assert.throws(() => loadMigrations(dirWith({ '001_a.sql': '', '003_c.sql': '' })), /without gaps/);
  assert.throws(() => loadMigrations(dirWith({ 'init.sql': '' })), /Invalid migration file name/);
});

test('rejects a database newer than the code', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 5');
  assert.throws(() => migrate(db, dirWith({ '001_a.sql': 'CREATE TABLE a (id INTEGER);' })), /only 1 migrations exist/);
});
