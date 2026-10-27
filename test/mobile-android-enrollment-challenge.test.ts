/** Real database challenge ownership; no vendor proof or key registration is simulated. */
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAndroidEnrollmentChallenges} from '../core/mobile-android-enrollment-challenge';
import {issueOwnIntegrityChallenge,consumeOwnIntegrityChallenge} from '../core/mobile-integrity-challenge';
import {androidEnrollmentClientData} from '../lib/mobile-android-enrollment';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee','strongbox'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let base:Base;
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(closeAll);
async function employee(b=base){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Android employee',primaryEmail:randomUUID()+'@key.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}],entitlements:harnessSnapshot(b.tenantId)};
 return {...e,ctx,intent:{employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()}};
}
describe('Android enrollment challenge owner',()=>{
 it('recovers the exact server-owned challenge, digest and alias on concurrent retries and reads',async()=>{
  const e=await employee(),service=createAndroidEnrollmentChallenges(settings);
  const [a,b]=await Promise.all([service.begin(e.ctx,e.intent),service.begin(e.ctx,e.intent)]);
  expect(a).toEqual(b);expect(await service.read(e.ctx,{...e.intent,challengeId:a.challenge.id})).toEqual(a);
  expect(a.context).toMatchObject({actorId:e.ctx.userId,tenantId:base.tenantId,employmentId:e.employmentId,appInstallationId:e.intent.appInstallationId});
  expect(a.clientDataHash).toBe(createHash('sha256').update(androidEnrollmentClientData(a.context)).digest('base64'));
  expect(a.alias).toBe('aihr_'+createHash('sha256').update(JSON.stringify(['aihr-android-key-alias',1,a.context.installationId,base.tenantId,e.ctx.userId,e.intent.appInstallationId,a.challenge.id])).digest('hex'));
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(1);
  expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
 });
 it('refuses policy/origin/installation/request changes without replacing the original challenge',async()=>{
  const e=await employee(),service=createAndroidEnrollmentChallenges(settings),original=await service.begin(e.ctx,e.intent);
  for(const config of [{...settings,apiOrigin:'https://other.example.com'},{...settings,target:{...settings.target,versionCodes:['5']}},{...settings,target:{...settings.target,minimumOsPatchLevel:202601}}]){
   const changed=createAndroidEnrollmentChallenges(config);
   await expect(changed.begin(e.ctx,e.intent)).rejects.toMatchObject({reason:'binding_conflict'});
   await expect(changed.read(e.ctx,{...e.intent,challengeId:original.challenge.id})).rejects.toMatchObject({reason:'binding_conflict'});
  }
  await expect(service.begin(e.ctx,{...e.intent,appInstallationId:randomUUID()})).rejects.toMatchObject({reason:'binding_conflict'});
  await expect(service.read(e.ctx,{...e.intent,requestId:randomUUID(),challengeId:original.challenge.id})).rejects.toMatchObject({reason:'not_found'});
  await expect(service.begin(e.ctx,{...e.intent,actorId:randomUUID()} as never)).rejects.toThrow();
  expect(await service.begin(e.ctx,e.intent)).toEqual(original);
 });
 it('denies peers, other tenants, administrators and an archived owner',async()=>{
  const e=await employee(),peer=await employee(),foreign=await employee(await seedBase()),service=createAndroidEnrollmentChallenges(settings),a=await service.begin(e.ctx,e.intent);
  for(const ctx of [peer.ctx,foreign.ctx,adminCtx(base)])await expect(service.read(ctx,{...e.intent,challengeId:a.challenge.id})).rejects.toThrow();
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));
  await expect(service.begin(e.ctx,e.intent)).rejects.toThrow();await expect(service.read(e.ctx,{...e.intent,challengeId:a.challenge.id})).rejects.toThrow();
 });
 it('preserves consumed state and refuses a different platform owner binding',async()=>{
  const e=await employee(),service=createAndroidEnrollmentChallenges(settings),a=await service.begin(e.ctx,e.intent);
  const intent={...e.intent,purpose:'device.enrollment' as const,bindingHash:a.challenge.bindingHash};
  await consumeOwnIntegrityChallenge(e.ctx,{...intent,challengeId:a.challenge.id},async()=>undefined);
  const terminal=await service.begin(e.ctx,e.intent);expect(terminal.challenge.state).toBe('consumed');expect(terminal.context).toEqual(a.context);expect(terminal.clientDataHash).toBe(a.clientDataHash);
  await expect(issueOwnIntegrityChallenge(e.ctx,{...intent,bindingHash:createHash('sha256').update('different platform owner').digest('hex')})).rejects.toMatchObject({reason:'binding_conflict'});
 });
 it('uses the shared pending challenge admission limit while allowing exact recovery',async()=>{
  const e=await employee(),service=createAndroidEnrollmentChallenges(settings),a=await service.begin(e.ctx,e.intent);
  for(let i=0;i<3;i++)await service.begin(e.ctx,{...e.intent,requestId:randomUUID()});
  await expect(service.begin(e.ctx,{...e.intent,requestId:randomUUID()})).rejects.toMatchObject({name:'RequestBudgetExceeded'});
  expect(await service.begin(e.ctx,e.intent)).toEqual(a);
 });
});
