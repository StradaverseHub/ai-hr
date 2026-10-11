import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
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
  await enroll();const info=(iss:string,sub:string,user:string,tenant:string)=>owner.client`select * from app.identity_email_operator_info(${iss},${sub},${user}::uuid,${tenant}::uuid)`;
  expect(await info(issuer,'owner',base.adminUserId,base.tenantId)).toHaveLength(1);
  const other=await seedBase();for(const [iss,sub,user,tenant]of [[issuer,'other',base.adminUserId,base.tenantId],['https://evil.test','owner',base.adminUserId,base.tenantId],[issuer,'owner',other.adminUserId,base.tenantId],[issuer,'owner',base.adminUserId,other.tenantId]])expect(await info(iss,sub,user,tenant)).toHaveLength(0);
 });
 it('keeps enrollment and service audit functions private to the web role',async()=>{
  await expect(client`select * from deployment_identity_operator`).rejects.toThrow(/permission denied/);
  for(const fn of ['app.identity_email_operator_info(text,text,uuid,uuid)','app.record_identity_email_event(text,text,uuid,uuid,text,jsonb)']){
   expect((await owner.client`select has_function_privilege('ai_hr_app',${fn},'EXECUTE') allowed`)[0].allowed).toBe(false);
  }
 });
 it('writes only allowed audit metadata and rejects unauthorized actors',async()=>{
  await enroll();const event=(subject:string,meta:object)=>owner.client`select app.record_identity_email_event(${issuer},${subject},${base.adminUserId}::uuid,${base.tenantId}::uuid,'draft-saved',${JSON.stringify(meta)}::jsonb)`;
  await event('owner',{draftId:'test',passwordChanged:true});const rows=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'identity-email.draft-saved'));expect(rows).toHaveLength(1);expect(rows[0].actorType).toBe('user');
  await expect(event('other',{})).rejects.toThrow(/administrator required/);await expect(event('owner',{password:'secret'})).rejects.toThrow(/invalid identity email audit/);
 });
});
