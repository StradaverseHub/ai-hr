import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { internalIssuer } from './config';
import { digest, passwordHash, passwordMatches, validatePassword } from './crypto';
import { deleteRecord, readRecord, revokeCredentialsSessions, writeRecord, type AuthSql } from './store';
import { InternalAuthError, loginKey, type Credential } from './service';

/** ADR-0117 operator sign-in reset, matched to prod-2026-11-01.1 (no tenant password policy/history or lockout there).
 * Operator-owned database connection only; there is no HTTP route. */
export type SignInResetPreview = { organization: string; username: string; email: string; fullName: string | null;
  grants: { role: string; company: string | null }[]; confirmation: string };

const confirmationOf = (c: Credential) => digest(`operator-sign-in-reset\0${c.subject}\0${c.version}`).slice(0, 12);

async function assertOwnerConnection(db: Sql) {
  const privileged = await db.unsafe("select pg_has_role(current_user,pg_get_userbyid(c.relowner),'MEMBER') allowed from pg_class c where c.oid='app_internal_auth_record'::regclass");
  if (!privileged[0]?.allowed) throw new Error('The migration/schema owner connection is required.');
}
function canonicalLogin(input: { organization: string; username: string }) {
  const organization = input.organization.trim().toLowerCase(), username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(organization) || !/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username)) throw new Error('Invalid organization or username.');
  return { organization, username };
}
/** Resolves only an enabled credential of an active, unarchived HR user in its exact tenant. */
async function resolve(tx: AuthSql, organization: string, username: string, lock: boolean) {
  const index = await readRecord<{ subject: string }>(tx, loginKey(organization, username));
  if (!index) throw new Error('No sign-in exists for this organization and username.');
  if (lock) await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [index.subject]);
  const c = await readRecord<Credential>(tx, `credential:${index.subject}`, lock);
  if (!c || c.subject !== index.subject || c.organization !== organization || c.username !== username || c.issuer !== internalIssuer(c.tenantId))
    throw new Error('No sign-in exists for this organization and username.');
  if (!c.enabled) throw new Error('This sign-in has not been activated. Use the pending enrollment or invitation instead.');
  const principals = await tx.unsafe('select app_user_id,tenant_id,person_id,grants from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
  const principal = principals[0];
  if (!principal || principal.tenant_id !== c.tenantId) throw new Error('This sign-in is archived, offboarded or no longer bound to an HR user. Nothing was changed.');
  return { c, principal: principal as unknown as { app_user_id: string; tenant_id: string; person_id: string | null; grants: { role: string; companyId: string | null }[] } };
}

export async function previewSignInReset(db: Sql, input: { organization: string; username: string }): Promise<SignInResetPreview> {
  await assertOwnerConnection(db);
  const { organization, username } = canonicalLogin(input);
  const tx = db as unknown as AuthSql;
  const { c, principal } = await resolve(tx, organization, username, false);
  const people = principal.person_id ? await tx.unsafe('select full_name from person where id=$1::uuid and tenant_id=$2::uuid', [principal.person_id, c.tenantId]) : [];
  const companies = await tx.unsafe('select id,legal_name from company where tenant_id=$1::uuid', [c.tenantId]);
  const companyName = new Map(companies.map(row => [row.id as string, row.legal_name as string]));
  return { organization, username, email: c.email, fullName: (people[0]?.full_name as string | undefined) ?? null,
    grants: principal.grants.map(g => ({ role: g.role, company: g.companyId ? companyName.get(g.companyId) ?? g.companyId : null })),
    confirmation: confirmationOf(c) };
}

/** The confirmation binds the reset to the exact credential version the operator reviewed. */
export async function resetSignIn(db: Sql, input: { organization: string; username: string; confirmation: string; password: string }) {
  await assertOwnerConnection(db);
  const { organization, username } = canonicalLogin(input);
  return db.begin(async rawTx => {
    const tx = rawTx as unknown as AuthSql;
    const { c, principal } = await resolve(tx, organization, username, true);
    if (input.confirmation.trim().toLowerCase() !== confirmationOf(c)) throw new Error('The sign-in changed after review. Run the preview again. Nothing was changed.');
    try { validatePassword(input.password, c.username, c.email); } catch { throw new InternalAuthError('passwordPolicy'); }
    if (c.password && await passwordMatches(input.password, c.password)) throw new InternalAuthError('passwordPolicy');
    c.password = await passwordHash(input.password);
    c.mustChange = true; c.totpSecret = null; c.lastStep = -1; c.recoveryHashes = []; c.version = randomUUID();
    // Removes sessions, refresh families, challenges and recovery links; the version change also refuses them.
    await revokeCredentialsSessions(tx, c.subject);
    await deleteRecord(tx, `recovery-active:${c.subject}`);
    await writeRecord(tx, `credential:${c.subject}`, c, c.subject);
    await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.operator-sign-in-reset','system',NULL,$3::jsonb)",
      [c.tenantId, principal.app_user_id, JSON.stringify({ organization, authenticatorRemoved: true, identityVerifiedOutOfBand: true })]);
    return { appUserId: principal.app_user_id, tenantId: c.tenantId };
  });
}
