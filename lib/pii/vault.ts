/**
 * Crypto primitives for ADR-0030 Layer-1 per-subject crypto-shredding. Pure functions; the stateful key
 * custody (the pii_key table) lives in core/pii-vault.ts.
 *
 * Two-tier envelope: a random per-subject DEK seals the values; the DEK itself is wrapped by the MASTER
 * key. Today the master key is the env-derived scrypt key from lib/ai/crypto.ts — the same one securing
 * AI-config secrets. ADR-0030 §4 is explicit that an env passphrase is too weak for payroll PII at scale:
 * before sealing real bank/NRIC at production volume, swap wrapDek/unwrapDek to a KMS/HSM-backed master
 * key. The interface here is the seam for that swap; nothing else changes.
 *
 * Shredding = deleting the wrapped DEK (in the DB). With the DEK gone, every value sealed under it is
 * unrecoverable — the ciphertext stays in the append-only log but decrypts to nothing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, isSecretStorable } from '../ai/crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;

/** Fail-closed gate: if the master key is unavailable, the service must refuse to seal (never store
 *  cleartext silently). Mirrors lib/ai/crypto's storability check. */
export function masterKeyAvailable(): boolean {
  return isSecretStorable();
}

/** A fresh, random per-subject data-encryption key. */
export function newDek(): Buffer {
  return randomBytes(DEK_LEN);
}

/** Short random key id, so a subject can rotate keys and old sealed blobs still resolve to the right DEK. */
export function newKid(): string {
  return randomBytes(8).toString('hex');
}

/** Wrap a DEK under the master key. AAD binds it to (tenant, subject) so a wrapped DEK can't be replayed
 *  for a different subject. Swap to KMS/HSM for production payroll PII (ADR-0030 §4). */
export function wrapDek(dek: Buffer, aad: string): string {
  return encryptSecret(dek.toString('base64'), aad);
}
export function unwrapDek(wrapped: string, aad: string): Buffer {
  return Buffer.from(decryptSecret(wrapped, aad), 'base64');
}

/** Seal a value under a DEK → "kid.iv.ct.tag" (base64 parts). AAD binds (tenant, subject, kid). */
export function sealUnderDek(dek: Buffer, kid: string, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_LEN); // never reuse an IV under the same key
  const c = createCipheriv(ALGO, dek, iv, { authTagLength: TAG_LEN });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return [kid, iv.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join('.');
}

/** Parse the kid from a sealed token without needing the DEK (to look up the right key row). */
export function kidOf(token: string): string {
  const kid = token.split('.')[0];
  if (!kid) throw new Error('Malformed sealed token: no kid');
  return kid;
}

/** Unseal a "kid.iv.ct.tag" token under its DEK. Throws on any tamper (GCM tag / AAD mismatch). */
export function unsealUnderDek(dek: Buffer, token: string, aad: string): string {
  const [, ivB, ctB, tagB] = token.split('.');
  if (!ivB || !ctB || !tagB) throw new Error('Malformed sealed token');
  const d = createDecipheriv(ALGO, dek, Buffer.from(ivB, 'base64'), { authTagLength: TAG_LEN });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}
