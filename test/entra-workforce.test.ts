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
});
