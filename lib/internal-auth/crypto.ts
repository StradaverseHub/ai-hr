import { createHash, createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { internalConfig } from './config';

export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const validOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
// OWASP's memory/CPU-equivalent scrypt profile: 32 MiB, r=8, p=3. Bound concurrent work per process.
let active = 0;
export class AuthBusyError extends Error {}
export class AuthRecordExpiredError extends Error {}
async function derive(password: string, salt: Buffer) {
  if (active >= 2) throw new AuthBusyError('Authentication busy. Try again shortly.');
  active++;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))); }
  finally { active--; }
}
export function validatePassword(password: string, username = '', email = '') {
  const normalized = password.toLowerCase();
  if (Array.from(password).length < 14 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 512 ||
      password.includes('\u0000') || (username && normalized.includes(username.toLowerCase())) ||
      (email && normalized.includes(email.toLowerCase()))) throw new Error('passwordPolicy');
}
export async function passwordHash(password: string) {
  if (password.length > 128 || Buffer.byteLength(password) > 512) throw new Error('passwordPolicy');
  const salt = randomBytes(16);
  return `scrypt$32768$8$3$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string) {
  if (typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password) > 512) return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$3' || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  return timingSafeEqual(await derive(password, Buffer.from(parts[4], 'hex')), Buffer.from(parts[5], 'hex'));
}
// Unknown users do the same password work. This is a non-secret, invalid-account comparison value.
export const DUMMY_PASSWORD_HASH = `scrypt$32768$8$3$${'00'.repeat(16)}$${'00'.repeat(64)}`;
export function encryptRecord(value: unknown, purpose: string, expiresAt: number | null) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(internalConfig().key, 'hex'), iv);
  cipher.setAAD(Buffer.from(`aihr-internal-v1:${purpose}`));
  const body = Buffer.concat([cipher.update(JSON.stringify({ value, expiresAt }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function decryptRecord<T>(sealed: string, purpose: string, now = Date.now()): T {
  if (sealed.length > 65536) throw new Error('Invalid authentication record.');
  const input = Buffer.from(sealed, 'base64url');
  if (input.length < 29) throw new Error('Invalid authentication record.');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(internalConfig().key, 'hex'), input.subarray(0, 12));
  decipher.setAAD(Buffer.from(`aihr-internal-v1:${purpose}`)); decipher.setAuthTag(input.subarray(12, 28));
  const parsed = JSON.parse(Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8'));
  if (!parsed || !(parsed.expiresAt === null || Number.isFinite(parsed.expiresAt))) throw new Error('Invalid authentication record.');
  if (parsed.expiresAt !== null && parsed.expiresAt <= now) throw new AuthRecordExpiredError('Authentication record expired.');
  return parsed.value as T;
}
