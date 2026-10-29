import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { transactionsCsv } from '../../src/api/export.ts';
import type { ExplorerRow } from '../../src/api/explorer.ts';
import { decryptBackup, encryptBackup } from '../../src/backup/backup.ts';
import { localDay } from '../../src/core/time.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

const row = (extra: Partial<ExplorerRow>): ExplorerRow =>
  ({ id: 't', accountId: 'a', occurredAt: '2026-10-20T15:00:00Z', amount: -12345, description: 'Padaria; do "Zé"', descriptionRaw: null, status: 'posted', installment: { number: 2, total: 5 }, category: 'Supermercado', state: 'confirmed', sourceIds: [], excluded: false, account: { institution: 'Banco Alfa', name: 'Gold', last4: '1111', kind: 'credit_card' }, counterparty: null, ...extra }) as ExplorerRow;

test('CSV: byte order mark, semicolons and decimal comma by default, quoting, and no formulas', () => {
  const csv = transactionsCsv([row({}), row({ description: '=HYPERLINK("x")', amount: 500, category: null, status: 'pending' })], localDay);
  assert.ok(csv.startsWith('﻿Data;Instituição;Conta;Descrição'));
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[1], '2026-10-20;Banco Alfa;Gold 1111;"Padaria; do ""Zé""";Supermercado;-123,45;lançada;2/5;confirmada;');
  assert.ok(lines[2]!.includes("\"'=HYPERLINK(\"\"x\"\")\""), 'a leading = gets an apostrophe');
  assert.ok(lines[2]!.includes(';5,00;pendente;'));
});

test('CSV in the international style uses commas and a decimal point', () => {
  const csv = transactionsCsv([row({ description: 'Loja' })], localDay, 'intl');
  assert.equal(csv.trimEnd().split('\r\n')[1], '2026-10-20,Banco Alfa,Gold 1111,Loja,Supermercado,-123.45,lançada,2/5,confirmada,');
});

test('a backup opens only with the right passphrase and detects any change', () => {
  const data = Buffer.from('SQLite format 3\0'.repeat(500));
  const file = encryptBackup(data, 'uma frase bem longa');
  assert.equal(file.subarray(0, 8).toString(), 'GMFBAK01');
  assert.ok(!file.includes(Buffer.from('SQLite format')), 'nothing readable is left in the file');
  assert.deepEqual(decryptBackup(file, 'uma frase bem longa'), data);
  assert.throws(() => decryptBackup(file, 'outra frase bem longa'), /wrong passphrase/);
  const flipped = Buffer.from(file);
  flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
  assert.throws(() => decryptBackup(flipped, 'uma frase bem longa'), /wrong passphrase, or the file is damaged/);
  const header = Buffer.from(file);
  header[3] = header[3]! ^ 1;
  assert.throws(() => decryptBackup(header, 'uma frase bem longa'), /not a Gata Molhada backup/);
  assert.throws(() => encryptBackup(data, 'curta'), /at least 12/);
  assert.notDeepEqual(encryptBackup(data, 'uma frase bem longa'), file, 'a new salt and nonce each time');
});

test('a real database survives the round trip through copyTo, encryption and a new file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-backup-'));
  try {
    const store = openSqliteStore(join(dir, 'live.sqlite'), MIGRATIONS);
    store.setSetting('marker', 'kept', '2026-10-28T00:00:00Z');
    store.copyTo(join(dir, 'copy.sqlite'));
    store.close();
    const file = encryptBackup(readFileSync(join(dir, 'copy.sqlite')), 'uma frase bem longa');
    const restored = decryptBackup(file, 'uma frase bem longa');
    const out = join(dir, 'restored.sqlite');
    writeFileSync(out, restored);
    const db = new DatabaseSync(out, { readOnly: true });
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'marker'").get() as { value: string }).value, 'kept');
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
