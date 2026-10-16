/** Real erasure owner with FORCE RLS and a restricted definer, not a superuser-only demonstration. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,updatePerson} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {saveHomePolicy,saveHomeSharing,sendHomeGreeting,homeReceivedGreetings} from '../core/home-policy';
import {createNotice,publishNotice,noticesForEmployment,acknowledgeNotice} from '../core/notice';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;const raw=owner.client;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function employee(name:string){const e=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@home.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});const userId=await createAppUser(b.tenantId,e.personId,'employee');return{...e,ctx:{...adminCtx(b),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]}as SessionContext};}
async function restrictedErasureOwner(run:()=>Promise<void>){
 const role='home_erase_'+randomUUID().replaceAll('-',''),quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
 const tables=['home_greeting','notice_acknowledgement'],functions=['app.home_redact_person_text(uuid)','app.home_guard()','app.home_notice_ack_guard()'];
 const tableOwners=await raw`select c.relname,r.rolname as owner from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='public'::regnamespace and c.relname=any(${tables}::text[])`;
 const fnOwners=await raw`select p.oid::regprocedure::text signature,r.rolname as owner from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=any(${functions}::regprocedure[])`;
 const migration=readFileSync(new URL('../db/migrations/0555_home_policies.sql',import.meta.url),'utf8'),start=migration.indexOf('DO $owner_policies$'),end=migration.indexOf('END;$owner_policies$;',start)+ 'END;$owner_policies$;'.length;
 expect(start).toBeGreaterThan(0);expect(end-start).toBeGreaterThan(1000);const policies=migration.slice(start,end).split('\n').filter(line=>!line.includes('projection_owner_read')).join('\n');
 const drop=async()=>{for(const [table,prefix]of[['home_greeting','home_greeting'],['notice_acknowledgement','notice_ack']]as const)for(const phase of['read','update'])await raw.unsafe(`DROP POLICY ${quote(prefix+'_erasure_owner_'+phase)} ON public.${quote(table)}`);};
 await raw.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
 try{
  await raw.unsafe(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${quote(role)}`);await raw.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quote(role)}`);await raw.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${quote(role)}`);
  await drop();for(const table of tables)await raw.unsafe(`ALTER TABLE public.${quote(table)} OWNER TO ${quote(role)}`);for(const signature of functions)await raw.unsafe(`ALTER FUNCTION ${signature} OWNER TO ${quote(role)}`);
  await raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE ${quote(role)}`);await tx.unsafe(policies);});
  const [flags]=await raw`select rolsuper,rolbypassrls,pg_has_role('ai_hr_app',oid,'MEMBER') app_member from pg_roles where rolname=${role}`;expect(flags).toEqual({rolsuper:false,rolbypassrls:false,app_member:false});
  await run();
 }finally{
  await drop();for(const row of fnOwners)await raw.unsafe(`ALTER FUNCTION ${row.signature} OWNER TO ${quote(row.owner)}`);for(const row of tableOwners)await raw.unsafe(`ALTER TABLE public.${quote(row.relname)} OWNER TO ${quote(row.owner)}`);
  expect(new Set(tableOwners.map(row=>row.owner)).size).toBe(1);await raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE ${quote(tableOwners[0].owner)}`);await tx.unsafe(policies);});
  await raw.unsafe(`DROP OWNED BY ${quote(role)}`);await raw.unsafe(`DROP ROLE ${quote(role)}`);
 }
}
describe('one-way Home private-copy erasure',()=>{
 it('redacts actual sender/recipient copies and acknowledgement text through canonical erasure while retaining evidence under a restricted owner',async()=>{
  const sender=await employee('Fictional sender'),subject=await employee('Fictional birthday'),today=todayInKualaLumpur();
  await updatePerson(adminCtx(b),{personId:subject.personId,fullName:'Fictional birthday',primaryEmail:'birthday@home.invalid',dateOfBirth:'2000'+today.slice(4)});
  await saveHomePolicy(adminCtx(b),{companyId:b.companyId,expectedRevision:0,wfhEnabled:false,wfhApprovalRequired:true,availabilityEnabled:false,birthdaysEnabled:true,anniversariesEnabled:false});
  await saveHomeSharing(subject.ctx,{employmentId:subject.employmentId,expectedRevision:0,availability:false,birthday:true,anniversary:false,weekStartsOn:1});
  const input={employmentId:sender.employmentId,recipientEmploymentId:subject.employmentId,requestId:randomUUID(),kind:'birthday'as const,date:today,message:'Private fictional birthday sentence'};await sendHomeGreeting(sender.ctx,input);
  const notice=await createNotice(adminCtx(b),{title:'Fictional private copy',body:'Recorded notice body',startOn:today,endOn:today,targetMode:'individual',employmentIds:[subject.employmentId],requiresAcknowledgement:true});await publishNotice(adminCtx(b),notice.id);
  const read=(await noticesForEmployment(subject.ctx,subject.employmentId))[0];await acknowledgeNotice(subject.ctx,{noticeId:notice.id,employmentId:subject.employmentId,expectedDigest:read.contentDigest});
  const beforeG=(await owner.db.select().from(s.homeGreeting))[0],beforeA=(await owner.db.select().from(s.noticeAcknowledgement))[0];
  await restrictedErasureOwner(async()=>{
   await expect(withTenant(subject.ctx,tx=>tx.execute(sql`select * from app.home_redact_person_text(${subject.employmentId}::uuid)`))).rejects.toThrow();
   const report=await erasePersonPii(adminCtx(b),{subjectEmploymentId:subject.employmentId,scope:'contact',reason:'Fictional erasure verification',requestRef:randomUUID()});expect(report.erased).toEqual(expect.arrayContaining(['homeGreetingText','noticeAcknowledgementText']));
   const afterG=(await owner.db.select().from(s.homeGreeting))[0],afterA=(await owner.db.select().from(s.noticeAcknowledgement))[0];
   expect(afterG).toMatchObject({...beforeG,message:null,redactedAt:expect.any(Date)});expect(afterA).toMatchObject({...beforeA,titleSnapshot:null,bodySnapshot:null,redactedAt:expect.any(Date)});
   expect((await homeReceivedGreetings(subject.ctx,subject.employmentId)).items).toEqual([]);
   expect(await sendHomeGreeting(sender.ctx,input)).toEqual({id:beforeG.id});
   await expect(withTenant(adminCtx(b),tx=>tx.update(s.homeGreeting).set({message:'Restore',redactedAt:null}))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
   await expect(raw.unsafe(`UPDATE public.home_greeting SET message='Restore',redacted_at=NULL WHERE id='${beforeG.id}'`)).rejects.toThrow(/immutable/);
   const again=await erasePersonPii(adminCtx(b),{subjectEmploymentId:subject.employmentId,scope:'contact',reason:'Idempotent repeat',requestRef:randomUUID()});expect(again.erased).not.toContain('homeGreetingText');
  });
 });
});
