/** Canonical credential/principal check. No connection, session or record lookup is implicit. */
import { z } from 'zod';
import type { AuthSql } from './record-store';
import { InternalAuthError } from './errors';
export type Credential = { subject: string; tenantId: string; issuer: string; organization: string; username: string; email: string;
  emailVerified: boolean; enabled: boolean; password: string | null; mustChange: boolean; version: string;
  totpSecret: string | null; lastStep: number; recoveryHashes: string[]; enrollmentId?: string };
export async function assertActiveCredential(tx: AuthSql, c: Credential) {
  if (!c.enabled || !c.password || c.mustChange || !c.totpSecret || !c.emailVerified) throw new InternalAuthError('invalidLogin');
  const rows = await tx.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
  const principal = rows[0];
  if (!principal || typeof principal.app_user_id !== 'string' || principal.tenant_id !== c.tenantId) throw new InternalAuthError('invalidLogin');
  return { app_user_id: principal.app_user_id, tenant_id: c.tenantId };
}

/** Additive structural projection for the isolated broker. These generous bounds contain canonical
 * writers (UUID versions, <=64 login identifiers, <=255 email, scrypt hashes, TOTP/recovery values).
 * They bound decrypted input; they add no password, entitlement, MFA or eligibility policy and do
 * not change existing Auth readers. Active state remains assertActiveCredential's authority. */
const credentialProjection=z.object({
 subject:z.uuid(),tenantId:z.uuid(),issuer:z.string().url().max(500),
 organization:z.string().max(64),username:z.string().max(64),email:z.string().max(320),
 emailVerified:z.boolean(),enabled:z.boolean(),password:z.string().max(1024).nullable(),
 mustChange:z.boolean(),version:z.uuid(),totpSecret:z.string().max(1024).nullable(),
 lastStep:z.number().int().safe().min(-1),recoveryHashes:z.array(z.string().max(128)).max(1000),
 enrollmentId:z.string().max(500).optional(),
}).strict();
export function parseCredential(raw:unknown):Credential|null {
 const parsed=credentialProjection.safeParse(raw);return parsed.success?parsed.data:null;
}
