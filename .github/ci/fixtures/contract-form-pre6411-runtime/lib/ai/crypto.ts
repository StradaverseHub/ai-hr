/**
 * Secret-at-rest encryption for tenant AI provider keys (ADR-0023).
 *
 * AES-256-GCM with a fresh random 12-byte IV per encryption and the 16-byte auth tag. The 32-byte
 * key is derived once (scrypt over the operator passphrase `AI_CONFIG_SECRET` + a fixed app salt)
 * and cached for the process lifetime. scrypt — not a bare sha256 — so a low-entropy passphrase is
 * key-stretched against brute force from a leaked ciphertext.
 *
 * SECURITY CONTRACT (do not weaken):
 *  - Per-tenant binding: the tenant id is the GCM **additional authenticated data (AAD)**. A
 *    ciphertext encrypted for tenant A fails to decrypt under tenant B — a row copied/restored across
 *    tenants becomes a hard error, never a usable key.
 *  - Fail closed: with no/weak `AI_CONFIG_SECRET`, `isSecretStorable()` is false and encrypt/decrypt
 *    throw. A deploy without the secret cannot silently store recoverable-by-anyone keys.
 *  - Authenticated: decryption throws on any tamper (wrong tag, wrong tenant AAD, corruption) and
 *    never returns partial plaintext.
 *  - Never log: the passphrase, the derived key, the plaintext key, the IV, or the tag. Errors here
 *    are deliberately generic.
 *
 * Token layout (base64url of): [version:1B][IV:12B][tag:16B][ciphertext:NB].
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 1;
const IV_LEN = 12; // GCM-standard 96-bit IV
const TAG_LEN = 16; // 128-bit auth tag
const KEY_LEN = 32; // AES-256
const PASSPHRASE_ENV = 'AI_CONFIG_SECRET';
const MIN_PASSPHRASE_LEN = 16;

// Fixed, non-secret app salt — domain-separates this app's derived key and defeats generic
// precomputed-table attacks. A per-row random salt would force re-running the slow KDF per op and
// storing the salt alongside every ciphertext; the passphrase is the real secret (rotate + re-encrypt
// if exposed).
const APP_SALT = Buffer.from('ai-hr.ai-provider-key.v1', 'utf8');
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigError';
  }
}

const passphrase = (): string | undefined => {
  const v = process.env[PASSPHRASE_ENV]?.trim();
  return v && v.length >= MIN_PASSPHRASE_LEN ? v : undefined;
};

/** True when a usable master passphrase is set — gate "store a key" UI/actions on this. */
export function isSecretStorable(): boolean {
  return Boolean(passphrase());
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const pass = passphrase();
  if (!pass) {
    throw new SecretConfigError(
      `${PASSPHRASE_ENV} is unset or shorter than ${MIN_PASSPHRASE_LEN} chars; in-app key storage is disabled.`,
    );
  }
  cachedKey = scryptSync(pass, APP_SALT, KEY_LEN, SCRYPT_PARAMS);
  return cachedKey;
}

/**
 * Encrypt a UTF-8 secret, binding it to `aad` (the tenant id) as GCM additional authenticated data.
 * A fresh IV per call means encrypting the same key twice yields different tokens.
 */
export function encryptSecret(plaintext: string, aad: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('encryptSecret expects a non-empty plaintext.');
  }
  const iv = randomBytes(IV_LEN); // NEVER reuse an IV under the same key
  const cipher = createCipheriv(ALGO, key(), iv, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // read only after final()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString('base64url');
}

/**
 * Decrypt a token produced by `encryptSecret`, requiring the same `aad` (tenant id). Throws on a
 * malformed token, unknown version, or any authentication failure (tamper / wrong tenant / wrong
 * passphrase). Never returns partial plaintext.
 */
export function decryptSecret(token: string, aad: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('decryptSecret expects a non-empty token.');
  }
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < 1 + IV_LEN + TAG_LEN) {
    throw new SecretConfigError('Invalid token: too short.');
  }
  if (raw[0] !== VERSION) {
    throw new SecretConfigError(`Unsupported token version: ${raw[0]}.`);
  }
  const iv = raw.subarray(1, 1 + IV_LEN);
  const tag = raw.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Normalize node's "unable to authenticate data" — never leak key/iv/tag material.
    throw new SecretConfigError('Decryption failed: data is corrupt, tampered, or for another tenant.');
  }
}

/** Last 4 chars of a key, for display only (computed at write time from the plaintext). */
export function keyLast4(plaintext: string): string {
  return plaintext.slice(-4);
}
