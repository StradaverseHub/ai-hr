import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {hireEmployee,changeEmploymentCompany,transferEmploymentCompanyTx} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {requirePackFor} from '../localization/registry';
import {resolveTaxSelectionMY,saveTaxSelectionMYTx} from '../localization/my/tax-selection';
import {setStatutoryProfileMY,setTaxProfileMY} from '../localization/my/statutory';
import {saveTaxSchemeDeclarationMY} from '../localization/my/tax-scheme-declarations';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,a:SessionContext,e:Awaited<ReturnType<typeof hireEmployee>>,destination:string,department:string;
const year=Number(todayInKualaLumpur().slice(0,4))-1;
const hiredOn=`${year}-01-01`,transferDate=`${year}-02-01`;
beforeAll(async()=>{await migrateTestDb();});afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();a=adminCtx(b);
 e=await hireEmployee(a,{person:{fullName:'Synthetic transfer tax',primaryEmail:`transfer_${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});
 await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900101123456',epfCitizenship:'non_citizen'});
 const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic new employer',country:'MY'}).returning();destination=co.id;
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:destination,name:'New employer department'}).returning();department=dept.id;
});
async function select(scheme:string,companyId=b.companyId){const save=requirePackFor('MY').statutory.saveTaxSelection;if(!save)throw new Error('MY direct selection missing');return save(a,{employmentId:e.employmentId,expectedCompanyId:companyId,scheme});}
const events=()=>owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.subjectEmploymentId,e.employmentId))).orderBy(schema.domainEvent.sequence);
const owners=()=>owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId)).orderBy(schema.employmentTaxSelectionMy.id);
const move=(companyId=destination,departmentId=department,date=transferDate,ctx=a)=>createMovementEvent(ctx,{employmentId:e.employmentId,kind:'entityTransfer',effectiveDate:date,companyId,departmentId});
const rows=async(companyId:string)=>{const all=await owners();return all.find(row=>row.companyId===companyId)!;};
describe('ordinary tax defaults in canonical employer changes',()=>{
 for(const writer of ['entity_transfer','hire_correction'] as const){
  it.each(['resident','non_resident','rep','knowledge_worker','c_suite'])(`${writer} retains scoped residency but never inherits %s incentive eligibility`,async scheme=>{
   const before=await select(scheme);
   // Deliberately contradictory legacy flags must not override the resolved scoped owner.
   await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900101123456',isResident:scheme==='non_resident'});
   if(writer==='entity_transfer')await move();else await changeEmploymentCompany(a,{employmentId:e.employmentId,newCompanyId:destination,departmentId:department});
   expect(await rows(b.companyId)).toEqual(before);
   const next=await rows(destination);
   expect(next).toMatchObject({scheme:scheme==='non_resident'?'non_resident':'resident',transitionState:'resolved',updatedByUserId:a.userId,provenance:{reason:'ordinary_new_employer_default',fromCompanyId:b.companyId,sourceSelectionId:before.id}});
   expect((await events()).find(event=>event.aggregateId===next.id)).toMatchObject({actorId:a.userId,eventType:'employee.tax-scheme.selected',payload:{companyId:destination,eligibilityDecision:'ordinary_new_employer_default',fromCompanyId:b.companyId}});
  });
 }
 it('returning to either employer preserves its exact previously selected owner and revision',async()=>{
  const first=await select('rep');await move();const second=await select('knowledge_worker',destination);
  await move(b.companyId,b.deptA,`${year}-03-01`);expect(await rows(b.companyId)).toEqual(first);
  await move(destination,department,`${year}-04-01`);expect(await rows(destination)).toEqual(second);
 });
 it('hire-time company correction back and forth preserves both employer owners',async()=>{
  const first=await select('non_resident');
  await changeEmploymentCompany(a,{employmentId:e.employmentId,newCompanyId:destination,departmentId:department});
  const second=await select('knowledge_worker',destination);
  await changeEmploymentCompany(a,{employmentId:e.employmentId,newCompanyId:b.companyId,departmentId:b.deptA});
  expect(await rows(b.companyId)).toEqual(first);
  await changeEmploymentCompany(a,{employmentId:e.employmentId,newCompanyId:destination,departmentId:department});
  expect(await rows(destination)).toEqual(second);
 });
 it('reversing a real movement preserves both selection histories and restores the old owner',async()=>{
  const first=await select('rep');await move();const second=await rows(destination);
  const history=await movementHistory(a,e.employmentId),transfer=history.find(row=>row.kind==='entityTransfer')!;
  await reverseMovementEvent(a,{employmentId:e.employmentId,movementId:transfer.id,reason:'Synthetic reversal'});
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,e.employmentId)))[0].companyId).toBe(b.companyId);
  expect(await rows(b.companyId)).toEqual(first);expect(await rows(destination)).toEqual(second);
 });
 it('a surrounding transaction failure rolls back company, assignment, selection and audit together',async()=>{
  const before=await owners(),oldEvents=await events();
  const oldAssignments=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId)).orderBy(schema.assignment.validFrom,schema.assignment.id);
  await expect(withTenant(a,async tx=>{await transferEmploymentCompanyTx(tx,a,{employmentId:e.employmentId,newCompanyId:destination,effectiveDate:transferDate,placement:{departmentId:department},movement:{type:'entityTransfer',groupId:randomUUID()}});throw new Error('Synthetic rollback');})).rejects.toThrow('Synthetic rollback');
  expect(await owners()).toEqual(before);expect(await events()).toEqual(oldEvents);
  expect(await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId)).orderBy(schema.assignment.validFrom,schema.assignment.id)).toEqual(oldAssignments);
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,e.employmentId)))[0].companyId).toBe(b.companyId);
 });
 it.each([true,false])('preexisting missing ordinary source converts once with legacy isResident=%s compatibility',async resident=>{
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900101123456',isResident:resident});await move();
  expect(await rows(b.companyId)).toMatchObject({scheme:resident?'resident':'non_resident',source:'legacy_conversion'});
  expect(await rows(destination)).toMatchObject({scheme:resident?'resident':'non_resident'});
 });
 it.each(['rep','non_resident'])('non-MY source creates an ordinary MY default without importing legacy %s intent',async legacy=>{
  const [source]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic foreign employer',country:'SG'}).returning();
  const [sourceDept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:source.id,name:'Foreign employer department'}).returning();
  e=await hireEmployee(a,{person:{fullName:'Synthetic foreign transfer',primaryEmail:`foreign_${randomUUID()}@test.local`},companyId:source.id,departmentId:sourceDept.id,employmentType:'full_time',hiredOn});
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900202123456',epfCitizenship:'non_citizen'});
  await setTaxProfileMY(a,{personId:e.personId,taxResidency:legacy});
  expect(await owners()).toEqual([]);
  const userId=await createAppUser(b.tenantId,e.personId,'employee');
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,companyId:source.id,role:'hr_admin'});
  const outgoing:SessionContext={tenantId:b.tenantId,userId,grants:[{role:'hr_admin',companyId:source.id}],entitlements:a.entitlements};
  await expect(move(destination,department,transferDate,outgoing)).rejects.toBeDefined();
  expect(await owners()).toEqual([]);
  await move();
  expect(await owners()).toHaveLength(1);
  expect(await rows(destination)).toMatchObject({scheme:'resident',provenance:{reason:'ordinary_new_employer_default',fromCompanyId:source.id},updatedByUserId:a.userId});
  expect((await rows(destination)).provenance).not.toHaveProperty('sourceSelectionId');
 });
 it('ambiguous missing source refuses atomically rather than silently becoming resident',async()=>{
  await saveTaxSchemeDeclarationMY(a,{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme:'rep',validFrom:`${year}-01`,validTo:`${year}-12`,approvalReference:'Synthetic legacy ambiguity',eligibilityConfirmed:true});
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  await expect(move()).rejects.toMatchObject({code:'confirmation_required'});expect(await owners()).toEqual([]);
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,e.employmentId)))[0].companyId).toBe(b.companyId);
 });
 it('a tax save waiting for a partial profile update permits the writer subject-audit FK lock',async()=>{
  // The real app role holds the profile UPDATE before the authoritative save starts.
  // Observe the actual database wait, then release the audit barrier: no timed sleep establishes order.
  let profilePid=0,savePid=0;
  let releaseAudit!:()=>void,announceProfile!:()=>void,announceSave!:()=>void;
  const auditBarrier=new Promise<void>(resolve=>{releaseAudit=resolve;});
  const profileReady=new Promise<void>(resolve=>{announceProfile=resolve;});
  const saveReady=new Promise<void>(resolve=>{announceSave=resolve;});
  const writer=withTenant(a,async tx=>{
   await tx.execute(sql`SET LOCAL lock_timeout='2500ms'`);
   const pid=await tx.execute(sql`SELECT pg_backend_pid() AS pid`);profilePid=Number(pid[0].pid);
   const [profile]=await tx.update(schema.employeeStatutoryMy).set({taxNumber:'Synthetic concurrent partial update'}).where(eq(schema.employeeStatutoryMy.personId,e.personId)).returning({id:schema.employeeStatutoryMy.id});
   announceProfile();await auditBarrier;
   await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'employee-statutory',aggregateId:profile.id,eventType:'employee.tax.updated',actor:actorOf(a),subjectEmploymentId:e.employmentId,payload:{synthetic:true}});
  }).then(()=>null,error=>error);
  await Promise.race([profileReady,writer.then(error=>{throw error??new Error('Profile writer finished before barrier');})]);
  const saver=withTenant(a,async tx=>{
   await tx.execute(sql`SET LOCAL lock_timeout='2500ms'`);
   const pid=await tx.execute(sql`SELECT pg_backend_pid() AS pid`);savePid=Number(pid[0].pid);announceSave();
   await saveTaxSelectionMYTx(tx,a,{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme:'resident'});
  }).then(()=>null,error=>error);
  let blocked=false;let outcomes:unknown[]=[];
  try{
   await Promise.race([saveReady,saver.then(error=>{throw error??new Error('Tax save finished before barrier');})]);
   const deadline=Date.now()+2000;
   while(Date.now()<deadline){
    const wait=await owner.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${savePid} AND NOT granted AND locktype='transactionid') AND ${profilePid}::integer=ANY(pg_blocking_pids(${savePid}::integer)) AS blocked`);
    if(wait[0].blocked===true){blocked=true;break;}
   }
  }finally{releaseAudit();outcomes=await Promise.all([writer,saver]);}
  expect(blocked,'save must be observably waiting on the profile transaction').toBe(true);
  expect(outcomes,'profile audit FK and authoritative save must both commit without lock failure').toEqual([null,null]);
  expect(await rows(b.companyId)).toMatchObject({scheme:'resident',transitionState:'resolved'});
  expect((await events()).some(event=>event.eventType==='employee.tax.updated')).toBe(true);
 });
 it('an arbitrary missing owner remains refused by payroll; no continuing fallback exists',async()=>{
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  await expect(withTenant(a,tx=>resolveTaxSelectionMY(tx,{tenantId:b.tenantId,employmentId:e.employmentId,companyId:b.companyId,payPeriod:`${year}-01`,legacyScheme:'resident',resident:true}))).rejects.toMatchObject({code:'confirmation_required'});
  expect(await owners()).toEqual([]);
 });
 it('outgoing-only and foreign-tenant actors cannot change employer or initialize another owner',async()=>{
  const userId=await createAppUser(b.tenantId,e.personId,'employee');await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,companyId:b.companyId,role:'hr_admin'});
  const outgoing:SessionContext={tenantId:b.tenantId,userId,grants:[{role:'hr_admin',companyId:b.companyId}],entitlements:a.entitlements};
  const before=await owners();await expect(move(destination,department,transferDate,outgoing)).rejects.toBeDefined();
  await expect(changeEmploymentCompany(outgoing,{employmentId:e.employmentId,newCompanyId:destination,departmentId:department})).rejects.toBeDefined();
  const foreign=await seedBase();await expect(move(destination,department,transferDate,adminCtx(foreign))).rejects.toBeDefined();expect(await owners()).toEqual(before);
 });
});
