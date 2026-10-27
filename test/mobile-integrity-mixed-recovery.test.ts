/** Synthetic custody rows, real HTTP/core/RLS. No Android hardware proof is claimed. */
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {GET as keysV1} from '../app/api/mobile/v1/integrity/keys/route';
import {GET as keysV2} from '../app/api/mobile/v2/integrity/keys/route';
import {POST as receiptV1} from '../app/api/mobile/v1/integrity/key-receipt/route';
import {POST as receiptV2} from '../app/api/mobile/v2/integrity/key-receipt/route';
import {POST as revokeV1} from '../app/api/mobile/v1/integrity/revoke/route';
import {POST as revokeV2} from '../app/api/mobile/v2/integrity/revoke/route';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
let caller:SessionContext,base:Base;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>caller}));
const checks=()=>owner.db.execute(sql`select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='mobile_integrity_key'::regclass and contype='c' order by conname`);
let originalChecks:Awaited<ReturnType<typeof checks>>;
let originalEnvironmentRequired:boolean;
// Only this disposable worker sees the draft, and its original check definitions are restored.
beforeAll(async()=>{
 originalChecks=await checks();
 const [environment]=await owner.db.execute(sql`select attnotnull from pg_attribute where attrelid='mobile_integrity_key'::regclass and attname='environment'`);
 originalEnvironmentRequired=Boolean(environment.attnotnull);
 const draft=readFileSync(new URL('../db/migrations/0636_mobile_android_key_custody.sql',import.meta.url),'utf8');
 if(!originalChecks.some(row=>row.conname==='mobile_integrity_key_platform_evidence_check'))await owner.db.transaction(async tx=>{for(const block of draft.split('--> statement-breakpoint').filter(value=>value.trim()))await tx.execute(sql.raw(block));});
});
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(async()=>{
 try{
  await resetDb();
  await owner.db.transaction(async tx=>{
   for(const row of await checks())await tx.execute(sql.raw(`ALTER TABLE mobile_integrity_key DROP CONSTRAINT "${row.conname}"`));
   for(const row of originalChecks)await tx.execute(sql.raw(`ALTER TABLE mobile_integrity_key ADD CONSTRAINT "${row.conname}" ${row.definition}`));
   await tx.execute(sql.raw(`ALTER TABLE mobile_integrity_key ALTER COLUMN environment ${originalEnvironmentRequired?'SET':'DROP'} NOT NULL`));
  });
  expect(await checks()).toEqual(originalChecks);
 }finally{await closeAll();}
});
async function employee(b=base){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Mixed key owner',primaryEmail:randomUUID()+'@key.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(b.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}],entitlements:harnessSnapshot(b.tenantId)};
 return {...e,ctx};
}
async function seedKey(e:Awaited<ReturnType<typeof employee>>,platform:'ios'|'android',revoked=false,createdAt=new Date()){
 const identity=await owner.db.execute(sql`select app.mobile_integrity_installation_id() id`),installationId=String(identity[0].id),id=randomUUID(),originChallengeId=randomUUID(),appInstallationId=randomUUID();
 await owner.db.insert(schema.mobileIntegrityChallenge).values({id:originChallengeId,tenantId:e.ctx.tenantId,actorId:e.ctx.userId!,employmentId:e.employmentId,installationId,appInstallationId,requestId:randomUUID(),purpose:'device.enrollment',bindingHash:'1'.repeat(64),nonce:randomBytes(32).toString('base64url'),issuedAt:createdAt,expiresAt:new Date(createdAt.getTime()+600000),consumedAt:createdAt});
 await owner.db.insert(schema.mobileIntegrityKey).values({id,originChallengeId,tenantId:e.ctx.tenantId,actorId:e.ctx.userId!,enrolledForEmploymentId:e.employmentId,installationId,appInstallationId,
  platform:platform as never,appId:platform==='ios'?'ABCDEFGHIJ.example.app':'example.app',environment:(platform==='ios'?'production':null) as never,proofKind:(platform==='ios'?'apple_key_proof':'google_key_generation_proof') as never,
  metadata:(platform==='ios'?null:{versionCode:'4'}) as never,vendorKeyId:randomBytes(32).toString('base64'),fingerprint:randomBytes(32).toString('hex'),publicKeySpki:Buffer.alloc(91,1),proofDigest:randomBytes(32).toString('hex'),receiptCiphertext:'PRIVATE_SYNTHETIC_PROOF',assertionCounter:0,createdAt,revokedAt:revoked?createdAt:null});
 return {id,originChallengeId};
}
async function call(handler:(request:Request)=>Promise<Response>,employmentId:string,body?:unknown){
 const response=await handler(new Request('https://hr.example/api/mobile/recovery?employmentId='+employmentId,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}));
 return {response,body:await response.json()};
}
describe('mixed platform recovery compatibility',()=>{
 it('filters v1 before its display limit and recovers v2 Android receipts without private proof',async()=>{
  const e=await employee();caller=e.ctx;
  const old=await seedKey(e,'ios',true,new Date(Date.now()-86400000));let android!:Awaited<ReturnType<typeof seedKey>>;
  for(let i=0;i<21;i++)android=await seedKey(e,'android',true,new Date(Date.now()-1000+i));
  const legacy=await call(keysV1,e.employmentId),modern=await call(keysV2,e.employmentId);
  expect(legacy.body.items).toHaveLength(1);expect(legacy.body.items[0].keyId).toBe(old.id);
  expect(modern.body.items).toHaveLength(20);expect(modern.body.items.every((key:{platform:string})=>key.platform==='android')).toBe(true);
  expect((await call(receiptV1,e.employmentId,{originChallengeId:android.originChallengeId})).body).toEqual({outcome:'key_receipt',key:null});
  const exact=await call(receiptV2,e.employmentId,{originChallengeId:android.originChallengeId});
  expect(exact.response.status).toBe(200);expect(exact.response.headers.get('cache-control')).toBe('no-store');
  expect(exact.body.key).toMatchObject({keyId:android.id,platform:'android',environment:null,proofKind:'google_key_generation_proof'});
  expect(Object.keys(exact.body.key).sort()).toEqual(['appId','createdAt','environment','keyId','nativeKeyBinding','originChallengeId','platform','proofKind','revokedAt'].sort());
 });
 it('refuses v1 Android revocation before mutation, then durably recovers v2 revocation',async()=>{
  const e=await employee();caller=e.ctx;const key=await seedKey(e,'android');
  const legacy=await call(revokeV1,e.employmentId,{keyId:key.id});
  expect((await owner.db.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,key.id)))[0].revokedAt).toBeNull();
  expect(legacy.body).toEqual({outcome:'refused',code:'key_unavailable'});
  const revoked=await call(revokeV2,e.employmentId,{keyId:key.id});expect(revoked.body.outcome).toBe('revoked');expect(revoked.body.key.revokedAt).not.toBeNull();
  expect((await call(revokeV2,e.employmentId,{keyId:key.id})).body).toEqual(revoked.body);
  expect((await call(receiptV2,e.employmentId,{originChallengeId:key.originChallengeId})).body.key).toEqual(revoked.body.key);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,key.id));expect(events.filter(event=>event.eventType==='mobile.integrity.key.revoked')).toHaveLength(1);
 });
 it('hides Android keys from peers and other tenants, and denies administrator or archived access',async()=>{
  const e=await employee(),peer=await employee(),foreign=await employee(await seedBase()),key=await seedKey(e,'android');
  for(const other of [peer,foreign]){
   caller=other.ctx;expect(await withTenant(other.ctx,tx=>tx.select().from(schema.mobileIntegrityKey))).toHaveLength(0);
   expect((await call(receiptV2,other.employmentId,{originChallengeId:key.originChallengeId})).body.key).toBeNull();
   expect((await call(revokeV2,other.employmentId,{keyId:key.id})).body).toEqual({outcome:'refused',code:'key_unavailable'});
  }
  caller=adminCtx(base);expect((await call(keysV2,e.employmentId)).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  caller=e.ctx;await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));
  expect((await call(revokeV2,e.employmentId,{keyId:key.id})).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  expect((await owner.db.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,key.id)))[0].revokedAt).toBeNull();
 });
});
