/** Canonical credential/principal check. No connection, session or record lookup is implicit. */
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
