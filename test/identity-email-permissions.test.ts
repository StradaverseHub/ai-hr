import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { emailServiceDatabaseGrants,recordEmailAudit } from '../deploy/identity-email/database';
import { client,withTenant } from '../db/client';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import * as schema from '../db/schema';
let base:Base;const issuer='https://hr.test/identity/realms/ai-hr';
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(closeAll);
const allowed=()=>withTenant(adminCtx(base),async tx=>(await tx.execute(sql`select app.is_identity_email_operator() allowed`) as unknown as {allowed:boolean}[])[0].allowed);
async function enroll(){await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'owner',appUserId:base.adminUserId});await owner.db.insert(schema.deploymentIdentityOperator).values({issuer,subject:'owner',testEmail:'owner@example.test'});}
describe('private identity email authority in the actual database',()=>{
 it('does not grant an HR administrator deployment mail authority implicitly',async()=>{expect(await allowed()).toBe(false);await enroll();expect(await allowed()).toBe(true);});
 it('rechecks revocation and archived users',async()=>{
  await enroll();await owner.db.update(schema.deploymentIdentityOperator).set({revokedAt:new Date()});expect(await allowed()).toBe(false);
  await owner.db.update(schema.deploymentIdentityOperator).set({revokedAt:null});await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()});expect(await allowed()).toBe(false);
  await owner.db.update(schema.appExternalIdentity).set({revokedAt:null});await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));expect(await allowed()).toBe(false);
 });
 it('requires the exact issuer, subject, user and tenant for the isolated service',async()=>{
  await enroll();const info=(iss:string,sub:string,user:string,tenant:string)=>owner.client`select * from identity_email.operator_info(${iss},${sub},${user}::uuid,${tenant}::uuid)`;
  expect(await info(issuer,'owner',base.adminUserId,base.tenantId)).toHaveLength(1);
  const other=await seedBase();for(const [iss,sub,user,tenant]of [[issuer,'other',base.adminUserId,base.tenantId],['https://evil.test','owner',base.adminUserId,base.tenantId],[issuer,'owner',other.adminUserId,base.tenantId],[issuer,'owner',base.adminUserId,other.tenantId]])expect(await info(iss,sub,user,tenant)).toHaveLength(0);
 });
 it('keeps enrollment and service audit functions private to the web role',async()=>{
  await expect(client`select * from deployment_identity_operator`).rejects.toThrow(/permission denied/);
  for(const fn of ['identity_email.operator_info(text,text,uuid,uuid)','identity_email.record_event(text,text,uuid,uuid,text,jsonb)']){
   expect((await owner.client`select has_function_privilege('ai_hr_app',${fn},'EXECUTE') allowed`)[0].allowed).toBe(false);
  }
 });
 it('gives the installed service only its private schema, despite PUBLIC shared helper execution grants',async()=>{
  await enroll();const role='test_identity_email_'+randomUUID().replaceAll('-','');
  const [{name}]=await owner.client`select current_database() as name`;
  await owner.client.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  try{
   for(const grant of emailServiceDatabaseGrants(name,role))await owner.client.unsafe(grant);
   const asService=(query:string)=>owner.client.begin(async tx=>{
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);return tx.unsafe(query);
   });
   await owner.client.begin(async tx=>{
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);
    expect((await tx`select has_schema_privilege(current_user,'app','USAGE') allowed`)[0].allowed).toBe(false);
    expect(await tx`select * from identity_email.operator_info(${issuer},'owner',${base.adminUserId}::uuid,${base.tenantId}::uuid)`).toHaveLength(1);
    await tx`select identity_email.record_event(${issuer},'owner',${base.adminUserId}::uuid,${base.tenantId}::uuid,'draft-saved','{}'::jsonb)`;
   });
   for(const query of [
    `select app.principal('${base.adminUserId}'::uuid)`,
    `select app.append_auth_event('${base.tenantId}'::uuid,'app-user','${base.adminUserId}'::uuid,'forged','system',null,'{}'::jsonb)`,
    'select * from public.app_user','select * from public.deployment_identity_operator',
   ])await expect(asService(query)).rejects.toThrow(/permission denied/);
  }finally{
   await owner.client.unsafe(`DROP OWNED BY "${role}"`);await owner.client.unsafe(`DROP ROLE "${role}"`);
  }
 });
 it('writes only allowed audit metadata and rejects unauthorized actors',async()=>{
  await enroll();const event=(subject:string,meta:object)=>owner.client`select identity_email.record_event(${issuer},${subject},${base.adminUserId}::uuid,${base.tenantId}::uuid,'draft-saved',${JSON.stringify(meta)}::jsonb)`;
  await event('owner',{draftId:'test',passwordChanged:true});const rows=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'identity-email.draft-saved'));expect(rows).toHaveLength(1);expect(rows[0].actorType).toBe('user');
  await expect(event('other',{})).rejects.toThrow(/administrator required/);await expect(event('owner',{password:'secret'})).rejects.toThrow(/invalid identity email audit/);
 });
 it('stores object metadata through the actual raw-driver login used by the agent',async()=>{
  await enroll();const role='test_email_login_'+randomUUID().replaceAll('-',''),password=randomUUID();
  const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);const [{name}]=await owner.client`select current_database() as name`;
  await owner.client.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  url.username=role;url.password=password;url.pathname='/'+name;
  // Deliberately do not wrap this client in drizzle: drizzle replaces JSON serializers.
  const service=postgres(url.toString(),{max:1});
  try{
   for(const grant of emailServiceDatabaseGrants(name,role))await owner.client.unsafe(grant);
   expect((await service`select session_user as name`)[0].name).toBe(role);
   const metadata={draftId:randomUUID(),passwordChanged:true};
   await recordEmailAudit(service,{issuer,subject:'owner',userId:base.adminUserId,tenantId:base.tenantId},'draft-saved',metadata);
   const rows=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'identity-email.draft-saved'));
   expect(rows).toHaveLength(1);expect(rows[0].payload).toEqual(metadata);
  }finally{
   await service.end();await owner.client.unsafe(`DROP OWNED BY "${role}"`);await owner.client.unsafe(`DROP ROLE "${role}"`);
  }
 });
});
