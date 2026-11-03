import { digest, opaque, validOpaque } from './crypto';
import { readRecord, writeRecord, type AuthSql } from './record-store';
import type { Credential } from './credential';
import { DEFAULT_REMEMBERED_MFA_POLICY, rememberedMfaPolicyKey, validateRememberedMfaState, type RememberedMfaPolicyState } from '../remembered-mfa-policy';

type RememberedDevice = { subject: string; tenantId: string; version: string; native: boolean; verifiedAt: number; expiresAt: number; policyRevision: number };
export async function readRememberedMfaPolicy(tx: AuthSql, tenantId: string) {
  const key = rememberedMfaPolicyKey(tenantId);
  // Serialize policy changes with both remembered sign-in and proof issuance.
  await tx.unsafe('select pg_advisory_xact_lock_shared(hashtextextended($1,0))', [key]);
  const state = await readRecord<RememberedMfaPolicyState>(tx, key);
  return state ? validateRememberedMfaState(state) : { policy: DEFAULT_REMEMBERED_MFA_POLICY, revision: 0 };
}
/** A remembered factor is never a session: callers must first verify the current password and principal. */
export async function rememberedFactorValid(tx: AuthSql, c: Credential, native: boolean, token: string | undefined) {
  if (!validOpaque(token) || !c.totpSecret) return false;
  const state = await readRememberedMfaPolicy(tx, c.tenantId);
  if (state.policy.rememberDays === 0) return false;
  const proof = await readRecord<RememberedDevice>(tx, `remembered-mfa:${digest(token!)}`);
  const now = Date.now();
  return !!proof && proof.subject === c.subject && proof.tenantId === c.tenantId && proof.version === c.version &&
    proof.native === native && proof.policyRevision === state.revision && Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt > 0 && proof.verifiedAt <= now &&
    Number.isSafeInteger(proof.expiresAt) && now < proof.expiresAt && now < proof.verifiedAt + state.policy.rememberDays * 86_400_000;
}
/** Only call immediately after real TOTP verification, inside the locked credential transaction. */
export async function rememberVerifiedFactor(tx: AuthSql, c: Credential, native: boolean, offeredDays: number) {
  const state = await readRememberedMfaPolicy(tx, c.tenantId);
  if (!Number.isSafeInteger(offeredDays) || offeredDays <= 0) return {};
  const days = Math.min(state.policy.rememberDays, offeredDays);
  if (!days) return {};
  // A policy increase during the challenge cannot exceed the visitor's displayed consent.
  const token = opaque(), verifiedAt = Date.now(), expiresAt = verifiedAt + days * 86_400_000;
  await writeRecord(tx, `remembered-mfa:${digest(token)}`, {
    subject: c.subject, tenantId: c.tenantId, version: c.version, native, verifiedAt, expiresAt, policyRevision: state.revision,
  } satisfies RememberedDevice, c.subject, expiresAt);
  return { remembered_device_token: token, remembered_device_expires_in: days * 86400 };
}
