import { randomBytes, createHmac } from 'node:crypto';
import type { Credential } from './credential';
import { readRecord, writeRecord, type AuthSql } from './record-store';
import { passwordHash, passwordMatches, validatePassword } from './crypto';
import { InternalAuthError } from './errors';
import { DEFAULT_PASSWORD_POLICY, passwordExpired, passwordPolicyKey, validatePasswordPolicy, type PasswordPolicyState } from '../password-policy';

export async function passwordChangeRequired(tx: AuthSql, c: Credential) {
  if (c.mustChange) return true;
  const state = await readRecord<PasswordPolicyState>(tx, passwordPolicyKey(c.tenantId));
  return passwordExpired(c.passwordChangedAt, state ? validatePasswordPolicy(state.policy) : DEFAULT_PASSWORD_POLICY);
}
type History = { secret: string; legacyHash: string | null };
/** Caller holds the subject's advisory lock and persists the credential in this transaction.
 * A per-subject random HMAC key is encrypted with the existing auth store. Separate permanent
 * markers keep lookup cost/storage per change bounded without retaining plaintext or trimming history.
 * The original scrypt hash covers the one password whose plaintext predates history tracking. */
export async function replacePassword(tx: AuthSql, c: Credential, password: string) {
  try { validatePassword(password, c.username, c.email); } catch { throw new InternalAuthError('passwordPolicy'); }
  const historyKey = `password-history:${c.subject}`;
  const history = await readRecord<History>(tx, historyKey, true) ?? { secret: randomBytes(32).toString('hex'), legacyHash: c.password };
  const fingerprint = createHmac('sha256', Buffer.from(history.secret, 'hex')).update(JSON.stringify(['aihr-password-history-v1', c.subject, password])).digest('hex');
  const marker = `password-used:${c.subject}:${fingerprint}`;
  if (await readRecord(tx, marker) ||
      (c.password && await passwordMatches(password, c.password)) ||
      (history.legacyHash && history.legacyHash !== c.password && await passwordMatches(password, history.legacyHash))) {
    throw new InternalAuthError('passwordPolicy');
  }
  c.password = await passwordHash(password);
  c.passwordChangedAt = Date.now();
  await writeRecord(tx, historyKey, history, c.subject);
  await writeRecord(tx, marker, { used: true }, c.subject);
}
