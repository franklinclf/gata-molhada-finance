import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * File layout of a backup, all in one buffer:
 *   8 bytes   magic "GMFBAK01" (also authenticated, so a changed header fails to decrypt)
 *   16 bytes  scrypt salt
 *   12 bytes  AES-256-GCM nonce
 *   16 bytes  GCM tag
 *   rest      gzip of the SQLite database file, encrypted
 * The key comes from the passphrase with scrypt (N 2^15, r 8, p 1). Without the passphrase the file cannot be opened.
 */
const MAGIC = Buffer.from('GMFBAK01', 'ascii');
const SALT = 16;
const NONCE = 12;
const TAG = 16;
export const MIN_PASSPHRASE = 12;

const keyFor = (passphrase: string, salt: Buffer): Buffer => scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export function encryptBackup(database: Buffer, passphrase: string): Buffer {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(SALT);
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, salt), nonce);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(gzipSync(database)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, nonce, cipher.getAuthTag(), body]);
}

/** The database bytes inside a backup. Throws with a plain message when the file is not a backup or the passphrase is wrong. */
export function decryptBackup(file: Buffer, passphrase: string): Buffer {
  if (file.length < MAGIC.length + SALT + NONCE + TAG + 1 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('this file is not a Gata Molhada backup');
  let at = MAGIC.length;
  const salt = file.subarray(at, (at += SALT));
  const nonce = file.subarray(at, (at += NONCE));
  const tag = file.subarray(at, (at += TAG));
  const decipher = createDecipheriv('aes-256-gcm', keyFor(passphrase, salt), nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([decipher.update(file.subarray(at)), decipher.final()]));
  } catch {
    throw new Error('wrong passphrase, or the file is damaged');
  }
}
