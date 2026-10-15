import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { internalIssuer } from './config';
import { digest, passwordHash, validOpaque, validatePassword } from './crypto';
import { readRecord, writeRecord, type AuthSql } from './store';
import { loginKey, type Credential, type Organization } from './service';
/** Operator-owned database connection only. There is no HTTP route to bootstrap an administrator. */
export async function bootstrapInternalOwner(db: Sql, input: {
  appUserId: string; organization: string; username: string; email: string; password: string; installationOperator: boolean; invitationToken?: string;
}) {
  const code = input.organization.trim().toLowerCase(), username = input.username.trim().toLowerCase(), email = input.email.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(code) || !/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username) ||
    !/^\S+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255 || !/^[0-9a-f-]{36}$/i.test(input.appUserId)) throw new Error('Invalid owner enrollment input.');
  validatePassword(input.password, username, email);
  const privileged = await db.unsafe("select pg_has_role(current_user,pg_get_userbyid(c.relowner),'MEMBER') allowed from pg_class c where c.oid='app_internal_auth_record'::regclass");
  if (!privileged[0]?.allowed) throw new Error('The migration/schema owner connection is required.');
  const hash = await passwordHash(input.password);
  return db.begin(async rawTx => {
    const tx = rawTx as unknown as AuthSql;
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth-bootstrap:'||$1,0))", [input.appUserId]);
    const users = await tx.unsafe(`select u.id,u.tenant_id,u.person_id,t.name,
      exists(select 1 from role_assignment r where r.app_user_id=u.id and r.tenant_id=u.tenant_id
       and (r.role='super_admin' or (r.role='hr_admin' and r.company_id is null))) administrator
      from app_user u join tenant t on t.id=u.tenant_id where u.id=$1::uuid and not app.login_blocked(u.id) for update of u`, [input.appUserId]);
    const user = users[0]; if (!user) throw new Error('Choose an existing active group administrator by exact internal ID.');
    if (!user.administrator) {
      if (!validOpaque(input.invitationToken)) throw new Error('A fresh installation requires its private first-administrator invitation.');
      const invitation = await tx.unsafe(`select 1 from app_invitation where token_hash=$1 and tenant_id=$2::uuid
        and person_id=$3::uuid and lower(email)=$4 and role='hr_admin' and company_id is null and created_by is null
        and status='pending' and expires_at>now() for update`, [digest(input.invitationToken), user.tenant_id, user.person_id, email]);
      if (!invitation.length) throw new Error('The private invitation must select this exact provisioned group administrator.');
    }
    const orgKey = `org:${code}`, tenantKey = `tenant:${user.tenant_id}`, indexKey = loginKey(code, username);
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [indexKey]);
    const org = await readRecord<Organization>(tx, orgKey, true), tenantOrg = await readRecord<Organization>(tx, tenantKey, true);
    if ((org && org.tenantId !== user.tenant_id) || (tenantOrg && tenantOrg.code !== code)) throw new Error('Organization code is already bound; no existing namespace may be reassigned.');
    const existing = await readRecord<{ subject: string }>(tx, indexKey, true);
    const issuer = internalIssuer(user.tenant_id);
    if (existing) {
      const c = await readRecord<Credential>(tx, `credential:${existing.subject}`);
      const binding = await tx.unsafe('select app_user_id from app_external_identity where issuer=$1 and subject=$2 and revoked_at is null', [issuer, existing.subject]);
      if (!c || c.email !== email || binding[0]?.app_user_id !== input.appUserId) throw new Error('Owner username already exists with different identity.');
      return { subject: c.subject, tenantId: user.tenant_id as string, alreadyEnrolled: true };
    }
    const enrolled = await tx.unsafe('select 1 from app_external_identity where app_user_id=$1::uuid and issuer=$2', [input.appUserId, issuer]);
    if (enrolled.length) throw new Error('This HR administrator already has an internal identity. Bootstrap never replaces it.');
    const subject = randomUUID();
    const c: Credential = { subject, tenantId: user.tenant_id, issuer, organization: code, username, email, emailVerified: true,
      enabled: true, password: hash, mustChange: true, version: randomUUID(), totpSecret: null, lastStep: -1, recoveryHashes: [] };
    const organization: Organization = { code, tenantId: user.tenant_id, name: user.name };
    await writeRecord(tx, orgKey, organization, null); await writeRecord(tx, tenantKey, organization, null);
    await writeRecord(tx, `credential:${subject}`, c, subject); await writeRecord(tx, indexKey, { subject }, subject);
    if (!user.administrator) {
      const accepted = await tx.unsafe('select * from app.consume_identity_invitation($1,$2,$3,$4)', [input.invitationToken!, issuer, subject, email]);
      if (accepted[0]?.app_user_id !== input.appUserId || accepted[0]?.tenant_id !== user.tenant_id) throw new Error('First-administrator identity binding refused.');
    } else await tx.unsafe('insert into app_external_identity(issuer,subject,app_user_id) values($1,$2,$3::uuid)', [issuer, subject, input.appUserId]);
    if (input.installationOperator) await tx.unsafe('insert into deployment_identity_operator(issuer,subject,test_email) values($1,$2,$3)', [issuer, subject, email]);
    await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.internal-owner-enrolled','user',$2::uuid,$3::jsonb)",
      [user.tenant_id, input.appUserId, JSON.stringify({ organization: code, installationOperator: input.installationOperator, ownershipAttested: true })]);
    return { subject, tenantId: user.tenant_id as string, alreadyEnrolled: false };
  });
}
