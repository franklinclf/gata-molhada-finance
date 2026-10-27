import { createInterface } from 'node:readline/promises';
import { hashPassword } from './password.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery.ts';
import { generateTotpSecret, otpauthUri } from './totp.ts';

// Prompts for a password and prints the values to store (for example in Key Vault). Nothing is written to disk.
const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = await rl.question('New password (min 12 characters): ');
const again = await rl.question('Repeat password: ');
rl.close();

if (password.length < 12 || password !== again) {
  console.error('Passwords must match and have at least 12 characters.');
  process.exit(1);
}

const secret = generateTotpSecret();
const codes = generateRecoveryCodes();
console.log('\nStore these values as secrets (AUTH_PASSWORD_HASH, AUTH_TOTP_SECRET, AUTH_RECOVERY_HASHES):\n');
console.log(`AUTH_PASSWORD_HASH=${hashPassword(password)}`);
console.log(`AUTH_TOTP_SECRET=${secret}`);
console.log(`AUTH_RECOVERY_HASHES=${codes.map(hashRecoveryCode).join(',')}`);
console.log('\nAdd this to your authenticator app (type the key, or turn the link into a QR code):\n');
console.log(`Key: ${secret}`);
console.log(otpauthUri(secret, 'owner', 'Gata Molhada Finance'));
console.log('\nRecovery codes (each works once; keep them offline, they are not stored anywhere in plain text):\n');
for (const code of codes) console.log(code);
