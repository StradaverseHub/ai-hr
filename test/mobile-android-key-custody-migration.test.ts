/** Draft migration rehearsal in rolled-back worker transactions, never a shared/live upgrade. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import type {Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,createAppUser,owner,resetDb,seedBase} from './harness';
const migration=readFileSync(new URL('../db/migrations/0636_mobile_android_key_custody.sql',import.meta.url),'utf8');
beforeEach(resetDb);afterAll(closeAll);
async function rehearsal(run:(tx:Tx,row:typeof schema.mobileIntegrityKey.$inferInsert)=>Promise<void>){
 const b=await seedBase(),e=await hireEmployee(adminCtx(b),{person:{fullName:'Custody fixture',primaryEmail:randomUUID()+'@key.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),actorId=await createAppUser(b.tenantId,e.personId,'employee');
 const rolledBack=new Error('intentional migration rehearsal rollback');
 try{await owner.db.transaction(async tx=>{
  const original=await tx.execute(sql`select relrowsecurity,relforcerowsecurity,relacl::text from pg_class where oid='mobile_integrity_key'::regclass`);
  for(const block of migration.split('--> statement-breakpoint').filter(value=>value.trim()))await tx.execute(sql.raw(block));
  expect(await tx.execute(sql`select relrowsecurity,relforcerowsecurity,relacl::text from pg_class where oid='mobile_integrity_key'::regclass`)).toEqual(original);
  const identity=await tx.execute(sql`select app.mobile_integrity_installation_id() id`),installationId=String(identity[0].id),challengeId=randomUUID(),appInstallationId=randomUUID();
  await tx.insert(schema.mobileIntegrityChallenge).values({id:challengeId,tenantId:b.tenantId,actorId,employmentId:e.employmentId,installationId,appInstallationId,requestId:randomUUID(),purpose:'device.enrollment',bindingHash:'1'.repeat(64),nonce:'A'.repeat(43),issuedAt:new Date(),expiresAt:new Date(Date.now()+600000),consumedAt:new Date()});
  const row={id:randomUUID(),tenantId:b.tenantId,actorId,appInstallationId,installationId,originChallengeId:challengeId,enrolledForEmploymentId:e.employmentId,platform:'ios' as const,appId:'ABCDEFGHIJ.example.app',environment:'production' as const,vendorKeyId:Buffer.alloc(32,1).toString('base64'),fingerprint:'2'.repeat(64),publicKeySpki:Buffer.alloc(91,1),proofDigest:'3'.repeat(64),proofKind:'apple_key_proof' as const,receiptCiphertext:'synthetic encrypted proof',assertionCounter:0};
  await run(tx,row);throw rolledBack;
 });}catch(error){if(error!==rolledBack)throw error;}
}
async function refuses(tx:Tx,row:typeof schema.mobileIntegrityKey.$inferInsert){
 // A savepoint isolates each expected constraint refusal from the surrounding rehearsal.
 await expect(tx.transaction(async nested=>{await nested.insert(schema.mobileIntegrityKey).values(row);})).rejects.toThrow();
}
describe('Android custody schema extension',()=>{
 it('accepts Android provenance without an Apple environment and preserves revocation/immutability',async()=>{
  await rehearsal(async(tx,base)=>{
   const row={...base,platform:'android' as never,appId:'a.b',environment:null as never,proofKind:'google_key_generation_proof' as never,metadata:{versionCode:'4'} as never};
   await tx.insert(schema.mobileIntegrityKey).values(row);
   await expect(tx.transaction(async nested=>{await nested.update(schema.mobileIntegrityKey).set({assertionCounter:1}).where(eq(schema.mobileIntegrityKey.id,row.id!));})).rejects.toThrow();
   await tx.update(schema.mobileIntegrityKey).set({revokedAt:sql`clock_timestamp()`}).where(eq(schema.mobileIntegrityKey.id,row.id!));
   await expect(tx.transaction(async nested=>{await nested.update(schema.mobileIntegrityKey).set({revokedAt:null}).where(eq(schema.mobileIntegrityKey.id,row.id!));})).rejects.toThrow();
  });
 });
 it('refuses Android counter, environment, Apple proof kind and missing/non-object provenance',async()=>{
  await rehearsal(async(tx,base)=>{
   const row={...base,platform:'android' as never,environment:null as never,proofKind:'google_key_generation_proof' as never,metadata:{} as never};
   for(const change of [{assertionCounter:1},{environment:'production'},{proofKind:'apple_key_proof'},{metadata:null},{metadata:[]},{metadata:'claimed'}])await refuses(tx,{...row,...change} as typeof row);
  });
 });
 it('retains Apple environment, app-id and metadata requirements',async()=>{
  await rehearsal(async(tx,row)=>{
   for(const change of [{environment:null},{appId:'a.b'},{proofKind:'google_key_generation_proof'},{proofKind:'apple_app_metadata',metadata:null}])await refuses(tx,{...row,...change} as typeof row);
   await tx.insert(schema.mobileIntegrityKey).values(row);
  });
 });
});
