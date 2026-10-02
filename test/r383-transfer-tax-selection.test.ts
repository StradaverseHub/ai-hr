import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,changeEmploymentCompany,transferEmploymentCompanyTx} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {requirePackFor} from '../localization/registry';
import {resolveTaxSelectionMY} from '../localization/my/tax-selection';
import {setStatutoryProfileMY} from '../localization/my/statutory';
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
const owners=()=>owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
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
  const oldAssignments=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId));
  await expect(withTenant(a,async tx=>{await transferEmploymentCompanyTx(tx,a,{employmentId:e.employmentId,newCompanyId:destination,effectiveDate:transferDate,placement:{departmentId:department},movement:{type:'entityTransfer',groupId:randomUUID()}});throw new Error('Synthetic rollback');})).rejects.toThrow('Synthetic rollback');
  expect(await owners()).toEqual(before);expect(await events()).toEqual(oldEvents);
  expect(await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId))).toEqual(oldAssignments);
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,e.employmentId)))[0].companyId).toBe(b.companyId);
 });
 it.each([true,false])('preexisting missing ordinary source converts once with legacy isResident=%s compatibility',async resident=>{
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900101123456',isResident:resident});await move();
  expect(await rows(b.companyId)).toMatchObject({scheme:resident?'resident':'non_resident',source:'legacy_conversion'});
  expect(await rows(destination)).toMatchObject({scheme:resident?'resident':'non_resident'});
 });
 it('ambiguous missing source refuses atomically rather than silently becoming resident',async()=>{
  await saveTaxSchemeDeclarationMY(a,{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme:'rep',validFrom:`${year}-01`,validTo:`${year}-12`,approvalReference:'Synthetic legacy ambiguity',eligibilityConfirmed:true});
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  await expect(move()).rejects.toMatchObject({code:'confirmation_required'});expect(await owners()).toEqual([]);
  expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,e.employmentId)))[0].companyId).toBe(b.companyId);
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
