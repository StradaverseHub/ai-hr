import { savePasswordPolicy } from '../core/password-policy';
import { passwordChangeRequired, replacePassword } from '../lib/internal-auth/password-policy';
import { assertActiveCredential, type Credential } from '../lib/internal-auth/credential';
import { passwordHash } from '../lib/internal-auth/crypto';
import { internalIssuer } from '../lib/internal-auth/config';
import { authTransaction, writeRecord } from '../lib/internal-auth/store';
import { provisionEntraTestOrganization } from './entra-fixture';
import { randomUUID } from 'node:crypto';
import { afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { client,withTenant } from '../db/client';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { saveConnector,connector } from '../lib/entra/store';
import { createEntraSession,readEntraSession,rotateEntraRefresh,revokeEntraSession } from '../lib/entra/sessions';
import { issuerFor,type EntraConfig } from '../lib/entra/model';
let base:Base,config:EntraConfig;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();base=await seedBase();
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));
 config={tenantId:base.tenantId,organization:'acme',directoryTenantId:randomUUID(),clientId:randomUUID(),clientSecret:'Secret-unique-782',provisioningClientId:randomUUID(),provisioningClientSecret:'Secret-unique-823',servicePrincipalId:randomUUID(),jobId:'job-1',mode:'cloud',domain:'acme.test',sourceAnchorAttribute:'extension_'+'a'.repeat(32)+'_hrSourceId',enabled:true,provisioningEnabled:true,immutableMatchingConfirmed:true,revision:randomUUID()};
 await provisionEntraTestOrganization(base,config.organization);
 await saveConnector(adminCtx(base),config,null);
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
async function employee(){return hireEmployee(adminCtx(base),{person:{fullName:'Entra Employee',primaryEmail:'entra@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});}
async function claim(){return (await client.unsafe('select * from app.entra_claim($1::date)',[todayInKualaLumpur()]))[0];}
describe('Entra actual app-role and durable lifecycle',()=>{
 it('encrypts secrets, refuses direct reads and rejects stale configuration revisions',async()=>{
  expect((await connector(base.tenantId))?.clientId).toBe(config.clientId);
  const raw=JSON.stringify(await owner.client`select * from app_internal_auth_record`);expect(raw).not.toContain(config.clientSecret);expect(raw).not.toContain(config.provisioningClientSecret);
  await expect(client`select * from entra_connector`).rejects.toThrow(/permission denied/);
  await expect(saveConnector(adminCtx(base),{...config,revision:randomUUID()},null)).rejects.toThrow();
 });
 it('queues only committed hires, leases once and cannot confirm a stale workforce revision',async()=>{
  const hire=await employee(),first=await claim();expect(first.person_id).toBe(hire.personId);expect(first.active).toBe(true);expect(await claim()).toBeUndefined();
  await owner.client`update person set full_name='Changed after lease' where id=${hire.personId}`;
  const [result]=await client.unsafe("select app.entra_finish($1::uuid,$2::uuid,$3::bigint,$4::uuid,'ready',NULL,true,60) ok",[base.tenantId,hire.personId,first.revision,first.lease]);
  expect(result.ok).toBe(false);expect((await claim()).revision).not.toBe(first.revision);
 });
 it('does not expose another tenant queue and denies employee configuration',async()=>{
  const hire=await employee(),other=await seedBase();
  const foreign=await withTenant(adminCtx(other),tx=>tx.execute(sql`select * from app.entra_status()`));expect(foreign).toHaveLength(0);
  await expect(saveConnector({...adminCtx(base),userId:randomUUID(),grants:[{role:'employee',companyId:base.companyId}]},config,config.revision)).rejects.toThrow();
  expect(hire.personId).toBeTruthy();
 });
 it('retains native reconciliation and refuses a stale administrator without changing its row or audit',async()=>{
  const hire=await employee(),ctx=adminCtx(base);
  await owner.client`update entra_workforce set status='uncertain',last_location=null,lease=null,lease_until=null where tenant_id=${base.tenantId}::uuid and person_id=${hire.personId}::uuid`;
  await withTenant(ctx,tx=>tx.execute(sql`select app.entra_reconcile_hold(${hire.personId}::uuid,${todayInKualaLumpur()}::date)`));
  const [reconciled]=await owner.client`select status,submitted_revision,revision from entra_workforce where tenant_id=${base.tenantId}::uuid and person_id=${hire.personId}::uuid`;
  expect(reconciled.status).toBe('awaiting-sync');expect(reconciled.submitted_revision).toBe(reconciled.revision);
  expect(await owner.client`select event_type from domain_event where tenant_id=${base.tenantId}::uuid and aggregate_id=${hire.personId}::uuid and event_type='entra.reconciliation-requested'`).toHaveLength(1);
  await owner.client`update entra_workforce set status='uncertain' where tenant_id=${base.tenantId}::uuid and person_id=${hire.personId}::uuid`;
  await owner.client`update app_user set archived_at=now() where id=${ctx.userId!}::uuid`;
  const before=await owner.client`select * from entra_workforce where tenant_id=${base.tenantId}::uuid and person_id=${hire.personId}::uuid`;
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.entra_reconcile_hold(${hire.personId}::uuid,${todayInKualaLumpur()}::date)`))).rejects.toThrow();
  expect(await owner.client`select * from entra_workforce where tenant_id=${base.tenantId}::uuid and person_id=${hire.personId}::uuid`).toEqual(before);
  expect(await owner.client`select event_type from domain_event where tenant_id=${base.tenantId}::uuid and aggregate_id=${hire.personId}::uuid and event_type='entra.reconciliation-requested'`).toHaveLength(1);
 });
 it('creates one baseline employee identity after confirmed provisioning, rotates refresh and revokes replayed families',async()=>{
  const hire=await employee(),work=await claim(),object=randomUUID();
  const args=[base.tenantId,hire.personId,work.revision,work.lease,object];
  const [bound]=await client.unsafe('select app.entra_auto_bind($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid) ok',args);expect(bound.ok).toBe(true);
  const [again]=await client.unsafe('select app.entra_auto_bind($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid) ok',args);expect(again.ok).toBe(true);
  const users=await owner.client`select id from app_user where person_id=${hire.personId}`;expect(users).toHaveLength(1);
  const roles=await owner.client`select role from role_assignment where app_user_id=${users[0].id}`;expect(roles.map(r=>r.role)).toEqual(['employee']);
  const tokens=await createEntraSession(config,object,true);expect(await readEntraSession(tokens.access_token,true)).toMatchObject({issuer:issuerFor(config.directoryTenantId),subject:object});
  const next=await rotateEntraRefresh(tokens.refresh_token!);expect(next?.access_token).not.toBe(tokens.access_token);
  await expect(rotateEntraRefresh(tokens.refresh_token!)).rejects.toThrow();expect(await readEntraSession(next!.access_token,true)).toBeNull();
 });
 it('refuses unbound identities and applies connector disablement to retained sessions',async()=>{
  await expect(createEntraSession(config,randomUUID(),false)).rejects.toThrow();
  const hire=await employee(),work=await claim(),object=randomUUID();
  await client.unsafe('select app.entra_auto_bind($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid)',[base.tenantId,hire.personId,work.revision,work.lease,object]);
  const tokens=await createEntraSession(config,object,false);expect(await readEntraSession(tokens.access_token)).not.toBeNull();
  await revokeEntraSession(tokens.access_token);expect(await readEntraSession(tokens.access_token)).toBeNull();
  const second=await createEntraSession(config,object,false);await saveConnector(adminCtx(base),{...config,enabled:false,revision:randomUUID()},config.revision);expect(await readEntraSession(second.access_token)).toBeNull();
 });
 it('invalidates a Microsoft HR session when an existing local credential version changes during recovery',async()=>{
  const object=randomUUID(),local=randomUUID();
  const {internalIssuer}=await import('../lib/internal-auth/config');const {writeRecord}=await import('../lib/internal-auth/store');
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuerFor(config.directoryTenantId)},${object},${base.adminUserId}),(${internalIssuer(base.tenantId)},${local},${base.adminUserId})`;
  await writeRecord(client,`credential:${local}`,{version:'before-recovery'},local);
  const session=await createEntraSession(config,object,false);expect(await readEntraSession(session.access_token)).not.toBeNull();
  await writeRecord(client,`credential:${local}`,{version:'after-recovery'},local);expect(await readEntraSession(session.access_token)).toBeNull();
 });

 it('keeps Microsoft credential authority separate from local expiry while revoking Microsoft sessions after an actual local password replacement',async()=>{
  const subject=randomUUID(),object=randomUUID();
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuerFor(config.directoryTenantId)},${object},${base.adminUserId}),(${internalIssuer(base.tenantId)},${subject},${base.adminUserId})`;
  const credential:Credential={subject,tenantId:base.tenantId,issuer:internalIssuer(base.tenantId),organization:'acme',username:'expiry-owner',email:'fictional.expiry@example.test',emailVerified:true,enabled:true,password:await passwordHash('Fictional initial password 882!'),mustChange:false,version:randomUUID(),totpSecret:'A'.repeat(32),lastStep:-1,recoveryHashes:[],passwordChangedAt:Date.now()-2*86400000};
  await writeRecord(client,`credential:${subject}`,credential,subject);
  await savePasswordPolicy({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},{enabled:true,interval:1,unit:'days'},0);
  expect(await passwordChangeRequired(client,credential)).toBe(true);
  await expect(assertActiveCredential(client,credential)).rejects.toMatchObject({code:'invalidLogin'});
  const microsoft=await createEntraSession(config,object,false);expect(await readEntraSession(microsoft.access_token)).not.toBeNull();
  await authTransaction(subject,async tx=>{await replacePassword(tx,credential,'Fictional replacement password 993!');credential.version=randomUUID();await writeRecord(tx,`credential:${subject}`,credential,subject);});
  expect(await passwordChangeRequired(client,credential)).toBe(false);expect(await assertActiveCredential(client,credential)).toMatchObject({app_user_id:base.adminUserId});expect(await readEntraSession(microsoft.access_token)).toBeNull();
 });

 it('does not exhaust the shared pool during concurrent same-user Microsoft logins',async()=>{
  const hire=await employee(),work=await claim(),object=randomUUID();
  await client.unsafe('select app.entra_auto_bind($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid)',[base.tenantId,hire.personId,work.revision,work.lease,object]);
  const sessions=await Promise.all(Array.from({length:12},()=>createEntraSession(config,object,true)));
  expect(new Set(sessions.map(value=>value.access_token)).size).toBe(12);
 });
 it('refuses an Entra organization alias different from the canonical HR organization',async()=>{
  await expect(saveConnector(adminCtx(base),{...config,organization:'another-organization',revision:randomUUID()},config.revision)).rejects.toMatchObject({code:'conflict'});
  expect((await connector(base.tenantId))?.organization).toBe('acme');
 });

});
