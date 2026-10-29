import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decryptBackup } from './backup.ts';

// Opens a backup into a NEW database file. It never overwrites anything: stop the app, move the old database away and put this file in its place.
// Usage: GMF_BACKUP_PASSPHRASE=... npm run restore:backup -- backup.gmfbak restored.sqlite
const [input, output] = process.argv.slice(2);
const passphrase = process.env.GMF_BACKUP_PASSPHRASE ?? '';
if (!input || !output || passphrase === '') {
  console.error('Usage: GMF_BACKUP_PASSPHRASE=... npm run restore:backup -- <backup file> <new database file>');
  process.exit(2);
}
if (existsSync(output)) {
  console.error(`${output} already exists. Choose a new name; this command never overwrites a file.`);
  process.exit(2);
}
try {
  const database = decryptBackup(readFileSync(input), passphrase);
  writeFileSync(output, database, { flag: 'wx', mode: 0o600 });
  const db = new DatabaseSync(output, { readOnly: true });
  const check = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  db.close();
  if (check !== 'ok') throw new Error(`the restored database failed its integrity check: ${check}`);
  console.log(`restored ${output} (${database.length} bytes, schema version ${version}). Stop the app, move the current database away, copy this file to the database path and start the app.`);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
