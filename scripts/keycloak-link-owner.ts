/** Owner-run enrollment after the additive migration, before selecting Keycloak. No email auto-linking. */
import { readFileSync } from 'node:fs';
import { INITIAL_SYSTEM_ADMIN_EMAIL } from '../lib/identity/bootstrap';

async function main() {
  if (process.getuid?.() !== 0) throw new Error('Server administrator access is required to read the bootstrap identity.');
  const target = process.argv.find(a=>a.startsWith('--app-user-id='))?.slice('--app-user-id='.length);
  if (!target || !/^[0-9a-f-]{36}$/i.test(target)) throw new Error('Pass the reviewed existing initial administrator UUID with --app-user-id=.');
  const identity = JSON.parse(readFileSync('/etc/aihr-keycloak/initial-owner.json','utf8'));
  if (identity.email !== INITIAL_SYSTEM_ADMIN_EMAIL || typeof identity.subject !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.subject) ||
      typeof identity.issuer !== 'string' || !identity.issuer.startsWith('https://') || !identity.issuer.endsWith('/identity/realms/ai-hr')) throw new Error('Invalid bootstrap identity.');
  const postgres = (await import('postgres')).default;
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('The migration-role database connection must be configured.');
  const db = postgres(process.env.MIGRATION_DATABASE_URL,{max:1});
  try {
    await db.begin(async tx=>{
      const [user] = await tx`select u.id,u.tenant_id from app_user u where u.id=${target}::uuid and not app.login_blocked(u.id)
        and exists(select 1 from role_assignment r where r.app_user_id=u.id and r.company_id is null and r.role in ('hr_admin','super_admin')) for update`;
      if (!user) throw new Error('Target must be an active existing group administrator. No grants or HR records were changed.');
      const existing = await tx`select * from app_external_identity where (issuer=${identity.issuer} and subject=${identity.subject}) or app_user_id=${target}::uuid`;
      if (existing.length) {
        if (existing.length===1 && existing[0].issuer===identity.issuer && existing[0].subject===identity.subject && existing[0].app_user_id===target && existing[0].revoked_at===null) {
          const enrolled=await tx`insert into deployment_identity_operator(issuer,subject,test_email) values(${identity.issuer},${identity.subject},${identity.email}) on conflict do nothing returning issuer`;
          if(enrolled.length) await tx`select app.append_auth_event(${user.tenant_id}::uuid,'app-user',${target}::uuid,'app-user.identity-email-enrolled','system',null,${tx.json({via:'operator-controlled-installation'})}::jsonb)`;
          return;
        }
        throw new Error('An identity is already enrolled. Inspect it before linking; this script never replaces a binding.');
      }
      await tx`insert into app_external_identity(issuer,subject,app_user_id) values(${identity.issuer},${identity.subject},${target}::uuid)`;
      await tx`select app.append_auth_event(${user.tenant_id}::uuid,'app-user',${target}::uuid,'app-user.identity-linked','system',null,
        ${tx.json({issuer:identity.issuer,subject:identity.subject,bootstrapEmail:identity.email,via:'operator-controlled-installation'})}::jsonb)`;
      await tx`insert into deployment_identity_operator(issuer,subject,test_email) values(${identity.issuer},${identity.subject},${identity.email})`;
      await tx`select app.append_auth_event(${user.tenant_id}::uuid,'app-user',${target}::uuid,'app-user.identity-email-enrolled','system',null,${tx.json({via:'operator-controlled-installation'})}::jsonb)`;
      const [resolved] = await tx`select * from app.principal_by_identity(${identity.issuer},${identity.subject})`;
      if (resolved?.app_user_id !== target) throw new Error('The enrolled identity does not resolve to the reviewed account.');
    });
    console.log('Initial administrator linked to the reviewed existing account; internal IDs and grants are preserved.');
  } finally { await db.end(); }
}
main().then(()=>process.exit(0),()=>{console.error('Initial administrator enrollment failed. No identity binding or grants were changed.');process.exit(1);});
