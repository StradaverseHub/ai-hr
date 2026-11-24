/**
 * Board eb01800b — every dated record that can block a new event is visible, and a refusal names it.
 *
 *  - Termination applies Decision 5 of the dated-corrections ADR: a later correction boundary that changes nothing is
 *    dropped and audited (employment.information.boundary.reapplied), and the termination saves; one that still
 *    changes a value refuses it, naming the correction (kind, date, fields, actor), and nothing is written.
 *  - Employment History lists a department-only correction, an organisation-structure (mapping) split and an untagged
 *    assignment change as `recordChange` lines (no Edit, no Roll Back), beside the movements and never inside them:
 *    movement replay and the Movement Excel export read exactly the rows they read before.
 *  - Another tenant's administrator is refused.
 * Fictional tenant, companies and people.
 */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull} from 'drizzle-orm';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {AssignmentBeforeCurrentStartError,hireEmployee,setEmploymentAssignment} from '../core/org';
import {createMovementEvent,movementHistory,movementHistoryWithTypes,recordedMovementChangesTx} from '../core/movement';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {prepareCompanyOrganisationRun,companyOrganisationRuns,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../core/company-organisation';
import {WorkforceAccessError} from '../core/workforce-access';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {InformationChanges} from '../lib/information-correction';

let b:Base;
beforeAll(async()=>{await migrateTestDb();await resetDb();b=await seedBase();});
afterAll(closeAll);

const HIRED='2025-06-03';
const ctx=()=>adminCtx(b);
async function hire(code:string){
 const e=await hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code+'-'+randomUUID().slice(0,4),companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:HIRED});
 return e.employmentId as string;
}
async function correct(id:string,changes:InformationChanges,effectiveOn:string){
 const review=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason:'Fictional correction',effectiveOn});
 await correctInformation(ctx(),{employmentId:id,changes,reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn});
}
const versions=(id:string)=>owner.db.select({id:schema.assignment.id,validFrom:schema.assignment.validFrom,validTo:schema.assignment.validTo,departmentId:schema.assignment.departmentId}).from(schema.assignment)
 .where(and(eq(schema.assignment.employmentId,id),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom));
const eventsOf=(id:string,eventType:string)=>owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent)
 .where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,eventType))).orderBy(asc(schema.domainEvent.sequence));
const terminatedOn=async(id:string)=>(await owner.db.select({on:schema.employment.terminatedOn}).from(schema.employment).where(eq(schema.employment.id,id)))[0].on;
const terminate=(id:string,effectiveDate:string)=>createMovementEvent(ctx(),{employmentId:id,kind:'termination',effectiveDate,endDate:effectiveDate,terminationReasonCode:'redundancy'});

describe('Termination before a later Information-Only Correction (Decision 5)',()=>{
 it('saves when the later correction boundary changes nothing, and audits the dropped boundary',async()=>{
  const id=await hire('RC-1');
  await correct(id,{departmentId:b.deptB},'2026-03-01');
  // The latest saved correction controls from 1 Jan: the 1 Mar boundary now repeats the same Department.
  await correct(id,{departmentId:b.deptB},'2026-01-01');
  const boundary=(await versions(id)).find(v=>v.validFrom==='2026-03-01');
  expect(boundary?.departmentId).toBe(b.deptB);
  await terminate(id,'2026-02-01');
  expect(await terminatedOn(id)).toBe('2026-02-01');
  expect((await versions(id)).map(v=>[v.validFrom,v.validTo,v.departmentId])).toEqual([[HIRED,'2026-01-01',b.deptA],['2026-01-01','2026-02-01',b.deptB]]);
  const audit=await eventsOf(id,'employment.information.boundary.reapplied');
  expect(audit).toHaveLength(1);
  expect(audit[0].payload).toMatchObject({movementDate:'2026-02-01',boundaries:[],lifted:[boundary!.id]});
 });

 it('refuses when the later correction still changes a value, names it, and writes nothing',async()=>{
  const id=await hire('RC-2');
  await correct(id,{departmentId:b.deptB},'2026-03-01');
  const before=await versions(id);
  const auditBefore=(await eventsOf(id,'employment.information.boundary.reapplied')).length;
  const error=await terminate(id,'2026-02-01').then(()=>null,(e:unknown)=>e);
  expect(error).toBeInstanceOf(AssignmentBeforeCurrentStartError);
  const refusal=error as AssignmentBeforeCurrentStartError;
  expect(refusal.effectiveDate).toBe('2026-02-01');
  expect(refusal.source).toMatchObject({kind:'correction',effectiveDate:'2026-03-01',fields:['departmentId'],versionId:before[1].id});
  expect(refusal.source?.actorId).toBe(b.adminUserId);
  expect(refusal.message).toContain('The later record is an Information-Only Correction (Department) dated 01-Mar-2026');
  // Nothing written: the lift rolled back with the transaction.
  expect(await versions(id)).toEqual(before);
  expect(await terminatedOn(id)).toBeNull();
  expect(await eventsOf(id,'employment.terminated')).toHaveLength(0);
  expect(await eventsOf(id,'employment.information.boundary.reapplied')).toHaveLength(auditBefore);
  // On or after the correction's date it still terminates.
  await terminate(id,'2026-03-01');
  expect(await terminatedOn(id)).toBe('2026-03-01');
 });

 it('names an untagged assignment change that blocks a termination',async()=>{
  const id=await hire('RC-3');
  await setEmploymentAssignment(ctx(),{employmentId:id,effectiveDate:'2026-04-01',departmentId:b.deptB});
  const error=await terminate(id,'2026-02-01').then(()=>null,(e:unknown)=>e) as AssignmentBeforeCurrentStartError;
  expect(error).toBeInstanceOf(AssignmentBeforeCurrentStartError);
  expect(error.source).toMatchObject({kind:'untagged',effectiveDate:'2026-04-01',fields:['departmentId']});
  expect(await terminatedOn(id)).toBeNull();
 });
});

describe('Employment History record lines',()=>{
 it('shows a department-only correction and an untagged change as record lines, outside replay and export',async()=>{
  const id=await hire('RC-4');
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2025-09-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  await correct(id,{departmentId:b.deptA},'2026-03-01');
  await setEmploymentAssignment(ctx(),{employmentId:id,effectiveDate:'2026-05-01',departmentId:b.deptB});
  const plain=await movementHistory(ctx(),id);
  const {movements,recordChanges}=await movementHistoryWithTypes(ctx(),id,{includeRecordChanges:true});
  // The movements are exactly the rows every other consumer reads (the Movement Excel export reads movementHistory).
  expect(movements).toEqual(plain);
  expect(plain.some(r=>r.kind==='recordChange'||r.recordChange)).toBe(false);
  expect(plain.map(r=>r.kind)).toEqual(['hired','transfer']);
  expect(recordChanges.map(r=>[r.effectiveDate,r.kind,r.recordChange.kind,r.recordChange.fields])).toEqual([
   ['2026-03-01','recordChange','correction',['departmentId']],
   ['2026-05-01','recordChange','untagged',['departmentId']],
  ]);
  const [correction]=recordChanges;
  expect(correction).toMatchObject({canEdit:false,canReverse:false,status:'applied',reversed:null,payrollLocked:false});
  expect(correction.recordChange.actorId).toBe(b.adminUserId);
  const [deptA]=await owner.db.select({name:schema.department.name}).from(schema.department).where(eq(schema.department.id,b.deptA));
  expect(correction.department).toBe(deptA.name);
  // Movement replay reads the recorded movements only.
  const replay=await withTenant(ctx(),tx=>recordedMovementChangesTx(tx,b.tenantId,id));
  expect(replay.map(r=>r.kind)).toEqual(['hired','transfer']);
  expect(replay.some(r=>r.id.startsWith('record:'))).toBe(false);
 });

 it('shows an organisation-structure (mapping) split as a record line',async()=>{
  await setModule(b.tenantId,'rewards','active');
  let doer:SessionContext=await entitledCtx(b);
  const [doerPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional HR doer',primaryEmail:`doer-${randomUUID().slice(0,6)}@org.invalid`}).returning();
  await owner.db.update(schema.appUser).set({personId:doerPerson.id}).where(eq(schema.appUser.id,doer.userId!));doer={...doer,personId:doerPerson.id};
  const [checkPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional independent HR checker',primaryEmail:`checker-${randomUUID().slice(0,6)}@org.invalid`}).returning();
  const checker:SessionContext={...doer,userId:await createAppUser(b.tenantId,checkPerson.id,'hr_admin'),personId:checkPerson.id};
  const suffix=randomUUID().slice(0,4).toUpperCase();
  const units=await owner.db.insert(schema.businessUnit).values([{tenantId:b.tenantId,companyId:b.companyId,code:'LEG'+suffix,name:'Legacy chosen unit '+suffix},{tenantId:b.tenantId,companyId:b.companyId,code:'MAP'+suffix,name:'Reviewed mapped unit '+suffix,label:'Reviewed mapped unit '+suffix}]).returning();
  const today=todayInKualaLumpur(),hireDate=`${Number(today.slice(0,4))-2}-01-01`;
  const {employmentId:id}=await hireEmployee(doer,{person:{fullName:'Fictional mapped',primaryEmail:`mapped-${randomUUID().slice(0,6)}@org.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hireDate,businessUnitId:units[0].id});
  const runId=await prepareCompanyOrganisationRun(doer,{kind:'mapping',companyIds:[b.companyId],effectiveOn:today,changes:[{companyId:b.companyId,businessUnitId:units[1].id,parentCompanyId:null}]});
  const run=(await companyOrganisationRuns(doer)).find(r=>r.id===runId);
  await decideCompanyOrganisationRun(checker,{id:runId,digest:run!.digest,approve:true,reason:'Checked explicit company and independent BU identities'});
  let result=await processCompanyOrganisationRun(doer,runId);for(let n=0;n<5&&result.state==='staging';n++)result=await processCompanyOrganisationRun(doer,runId);
  expect(result.state,result.failure??'reviewed publication').toBe('published');
  expect((await versions(id)).map(v=>v.validFrom)).toEqual([hireDate,today]);
  const {movements,recordChanges}=await movementHistoryWithTypes(doer,id,{includeRecordChanges:true});
  expect(movements.some(r=>r.recordChange)).toBe(false);
  expect(recordChanges.map(r=>[r.effectiveDate,r.recordChange.kind,r.recordChange.fields])).toEqual([[today,'mapping',['businessUnitId']]]);
 });

 it('refuses another tenant’s administrator',async()=>{
  const id=await hire('RC-5');
  await correct(id,{departmentId:b.deptB},'2026-03-01');
  const other=await seedBase();
  await expect(movementHistoryWithTypes(adminCtx(other),id,{includeRecordChanges:true})).rejects.toBeInstanceOf(WorkforceAccessError);
  const forged={...adminCtx(other),roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
  await expect(movementHistoryWithTypes(forged,id,{includeRecordChanges:true})).rejects.toBeInstanceOf(WorkforceAccessError);
 });
});
