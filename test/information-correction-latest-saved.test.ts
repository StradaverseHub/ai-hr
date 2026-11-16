/**
 * Board 4604dccc revision 4 (ADR 2026-11-15 dated information corrections, revision 4) — the LATEST SAVED correction
 * controls each corrected field from its Effective Date onward. An earlier-saved correction no longer ends it or
 * overrides it; a recorded movement still takes over on its own date for the fields it changes; earlier corrections
 * stay in history and the review lists them. Corrections saved in Effective Date order give the revision 3 answers.
 * Fictional tenant, companies and people only.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull,isNotNull,sql,type SQL} from 'drizzle-orm';
import * as schema from '../db/schema';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {previewInformationCorrection,correctInformation,correctionCarry,INFORMATION_CORRECTED_EVENT} from '../core/information-correction';
import {correctHireDetails} from '../core/hire-correction';
import {employmentInformationAt} from '../core/information-correction-history';
import {planDatedCorrection,INFORMATION_BOUNDARY_REAPPLIED_EVENT,type DatedVersion} from '../core/movement-history';
import type {InformationChanges} from '../lib/information-correction';

let b:Base;let beta:string;let gamma:string;let deptC:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await owner.db.update(schema.company).set({companyLabel:'ALPHA',country:'MY'}).where(eq(schema.company.id,b.companyId));
 [beta,gamma]=await Promise.all(['Beta','Gamma'].map(async name=>(await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:name+' Fictional Sdn Bhd',companyLabel:name.toUpperCase(),country:'MY'}).returning({id:schema.company.id}))[0].id));
 deptC=(await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional Logistics'}).returning({id:schema.department.id}))[0].id;
 for(const [labelKind,labelId] of [['department',b.deptA],['department',b.deptB],['department',deptC],['position',b.positionId]] as const)
  await owner.db.insert(schema.labelCompanyAssignment).values([beta,gamma].map(companyId=>({tenantId:b.tenantId,labelKind,labelId,companyId})));
 await owner.db.insert(schema.profileOption).values([{tenantId:b.tenantId,category:'branch',value:'NORTH',label:'North'},{tenantId:b.tenantId,category:'branch',value:'SOUTH',label:'South'}]);
});

const HIRED='2025-01-02',SAVED_FIRST='2025-11-01',SAVED_LATER='2025-03-01',TRANSFER='2026-02-01';
const ctx=()=>adminCtx(b);
async function hire(code:string,companyId=b.companyId){
 const e=await hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code,companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:HIRED});
 return e.employmentId as string;
}
async function correct(id:string,changes:InformationChanges,effectiveOn:string,extra:{method?:'manual'|'excel';acknowledgeClosedPayroll?:boolean}={}){
 const method=extra.method??'manual';
 const review=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason:'Fictional correction',effectiveOn},{extended:method==='excel'});
 await correctInformation(ctx(),{employmentId:id,changes,reason:'Fictional correction',fingerprint:review.fingerprint,method,effectiveOn,...(extra.acknowledgeClosedPayroll?{acknowledgeClosedPayroll:true}:{})});
 return review;
}
const versions=async(id:string)=>(await owner.db.select({validFrom:schema.assignment.validFrom,validTo:schema.assignment.validTo,companyId:schema.assignment.companyId,departmentId:schema.assignment.departmentId}).from(schema.assignment).where(and(eq(schema.assignment.employmentId,id),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom)));
const employment=async(id:string)=>(await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0];
const lastCorrection=async(id:string)=>(await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,INFORMATION_CORRECTED_EVENT))).orderBy(asc(schema.domainEvent.sequence))).at(-1)!.payload as Record<string,unknown>;
const correctionCount=async(id:string)=>(await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,INFORMATION_CORRECTED_EVENT)))).length;

type AtField='hiredOn'|'joinDate'|'companyId';
const FALLBACK:Record<AtField,SQL>={hiredOn:sql`${schema.employment.hiredOn}`,joinDate:sql`${schema.employment.joinDate}`,companyId:sql`${schema.employment.companyId}`};
/** Revision 3's reader, verbatim: the earliest-saved correction dated after the day gives its before value. */
const legacyAt=(field:AtField,asOf:SQL)=>sql<string|null>`case when exists(select 1 from ${schema.domainEvent} ev where ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${schema.employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text) then (select ev.payload->'before'->>${field} from ${schema.domainEvent} ev where ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${schema.employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text order by ev.sequence limit 1) else ${FALLBACK[field]}::text end`;
async function readAt(id:string,day:string){
 const asOf=sql`${day}::date`;
 const [row]=await withTenant(ctx(),tx=>tx.select({
  hiredOn:employmentInformationAt('hiredOn',asOf,FALLBACK.hiredOn),joinDate:employmentInformationAt('joinDate',asOf,FALLBACK.joinDate),companyId:employmentInformationAt('companyId',asOf,FALLBACK.companyId),
  legacyHiredOn:legacyAt('hiredOn',asOf),legacyJoinDate:legacyAt('joinDate',asOf),legacyCompanyId:legacyAt('companyId',asOf),
 }).from(schema.employment).where(eq(schema.employment.id,id)));
 return row;
}
const addDays=(day:string,n:number)=>new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7))-1,Number(day.slice(8,10))+n)).toISOString().slice(0,10);

describe('company (dated assignment): correction A saved first from 1 Nov, correction B saved later from 1 Mar',()=>{
 it('B applies from 1 Mar onward, including after 1 Nov; a recorded transfer still applies on its date',async()=>{
  const id=await hire('LS-CO',gamma);
  await correct(id,{companyId:beta},SAVED_FIRST);
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:TRANSFER,departmentId:b.deptB,remarks:'Fictional transfer recorded between the corrections'});
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId,v.departmentId])).toEqual([[HIRED,gamma,b.deptA],[SAVED_FIRST,beta,b.deptA],[TRANSFER,beta,b.deptB]]);
  const review=await correct(id,{companyId:b.companyId},SAVED_LATER);
  expect(review.before.companyId).toBe(gamma);
  // Nothing ends B before the current record: the earlier correction's boundary and the department transfer pass.
  expect(review.until).toBeUndefined();
  expect(review.conflicts).toBeUndefined();
  expect(review.warnings).toContainEqual({code:'companyFrom',date:SAVED_LATER});
  expect(review.replacedCorrections).toEqual([expect.objectContaining({effectiveOn:SAVED_FIRST,fields:['companyId']})]);
  expect(review.timeline?.map(r=>[r.date,r.kind,r.status])).toEqual([[HIRED,'hired','unchanged'],[SAVED_LATER,'thisCorrection','corrected'],[SAVED_FIRST,'informationCorrection','corrected'],[TRANSFER,'transfer','corrected']]);
  expect((await versions(id)).map(v=>[v.validFrom,v.validTo,v.companyId,v.departmentId])).toEqual([
   [HIRED,SAVED_LATER,gamma,b.deptA],[SAVED_LATER,SAVED_FIRST,b.companyId,b.deptA],[SAVED_FIRST,TRANSFER,b.companyId,b.deptA],[TRANSFER,null,b.companyId,b.deptB]]);
  expect((await employment(id)).companyId).toBe(b.companyId);
  // The earlier correction stays on record; the new one names it.
  expect(await correctionCount(id)).toBe(2);
  const payload=await lastCorrection(id);
  expect(payload).toMatchObject({effectiveOn:SAVED_LATER,nextBoundary:null,fields:['companyId']});
  expect(payload.replacedCorrectionSequences).toHaveLength(1);
  // The superseded versions remain as evidence beside their replacements.
  expect((await owner.db.select({id:schema.assignment.id}).from(schema.assignment).where(and(eq(schema.assignment.employmentId,id),isNotNull(schema.assignment.supersededAt)))).length).toBeGreaterThanOrEqual(2);
  // Payroll and statutory readers (employmentInformationAt): Gamma before 1 Mar, Alpha from 1 Mar, also after 1 Nov.
  expect((await readAt(id,'2025-02-01')).companyId).toBe(gamma);
  for(const day of ['2025-03-01','2025-06-01','2025-10-31','2025-11-01','2025-12-31','2026-03-01'])expect((await readAt(id,day)).companyId,day).toBe(b.companyId);
  // Revision 3 answered with the older correction for June.
  expect((await readAt(id,'2025-06-01')).legacyCompanyId).toBe(gamma);
 });
 it('names a recorded company transfer the replaced period would contradict, and saves nothing',async()=>{
  const id=await hire('LS-CLASH',gamma);
  await correct(id,{companyId:beta},SAVED_FIRST);
  await createMovementEvent(ctx(),{employmentId:id,kind:'entityTransfer',effectiveDate:TRANSFER,companyId:gamma,remarks:'Fictional transfer back'});
  const before=await versions(id);
  const review=await previewInformationCorrection(ctx(),{employmentId:id,changes:{companyId:b.companyId},reason:'Fictional correction',effectiveOn:SAVED_LATER});
  // The movement owns its date: the correction stops there and its recorded "from" (Beta) is contradicted.
  expect(review.until).toEqual({companyId:TRANSFER});
  expect(review.conflicts).toEqual([expect.objectContaining({date:TRANSFER,field:'companyId',kind:'entityTransfer'})]);
  await expect(correctInformation(ctx(),{employmentId:id,changes:{companyId:b.companyId},reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn:SAVED_LATER})).rejects.toThrow(/on 2026-02-01 records a change from a different value/);
  expect(await versions(id)).toEqual(before);
 });
 it('in Effective Date order gives the revision 3 records and replaces nothing',async()=>{
  const id=await hire('LS-ORDER',gamma);
  await correct(id,{companyId:b.companyId},SAVED_LATER);
  const review=await correct(id,{companyId:beta},SAVED_FIRST);
  expect(review.replacedCorrections).toBeUndefined();expect(review.until).toBeUndefined();
  expect((await versions(id)).map(v=>[v.validFrom,v.validTo,v.companyId])).toEqual([[HIRED,SAVED_LATER,gamma],[SAVED_LATER,SAVED_FIRST,b.companyId],[SAVED_FIRST,null,beta]]);
  expect((await employment(id)).companyId).toBe(beta);
 });
 it('needs the closed-payroll acknowledgement for the whole period it now covers, and leaves the payslip as issued',async()=>{
  const id=await hire('LS-PAY');
  await correct(id,{departmentId:b.deptB},SAVED_FIRST);
  const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2025-12',status:'open'}).returning({id:schema.payPeriod.id});
  const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:pp.id,payPeriod:'2025-12',runSeq:1,runType:'regular',batchDate:'2025-12-28',status:'closed'}).returning({id:schema.payrollBatch.id});
  await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'4000.00',grossPay:'4000.00',totalDeductions:'500.00',netPay:'3500.00',employerCost:'4500.00',statutory:{}});
  const review=await previewInformationCorrection(ctx(),{employmentId:id,changes:{departmentId:deptC},reason:'Fictional correction',effectiveOn:SAVED_LATER});
  // Revision 3 stopped at 1 Nov, before December; the latest saved correction now reaches it.
  expect(review.closedPayrollPeriods).toEqual(['2025-12']);
  await expect(correctInformation(ctx(),{employmentId:id,changes:{departmentId:deptC},reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn:SAVED_LATER})).rejects.toThrow(/2025-12 is already closed/);
  await correct(id,{departmentId:deptC},SAVED_LATER,{acknowledgeClosedPayroll:true});
  expect((await versions(id)).map(v=>[v.validFrom,v.departmentId])).toEqual([[HIRED,b.deptA],[SAVED_LATER,deptC],[SAVED_FIRST,deptC]]);
  expect((await owner.db.select({net:schema.payslip.netPay,gross:schema.payslip.grossPay}).from(schema.payslip).where(eq(schema.payslip.employmentId,id)))[0]).toEqual({net:'3500.00',gross:'4000.00'});
  expect((await owner.db.select({id:schema.informationPayslipSnapshot.payslipId}).from(schema.informationPayslipSnapshot).where(eq(schema.informationPayslipSnapshot.employmentId,id)))).toHaveLength(1);
 });
});

describe('Group Join Date and Join Date (employmentInformationAt)',()=>{
 it('the later-saved March correction answers from March onward, including after November',async()=>{
  const id=await hire('LS-DATES');
  await correct(id,{hiredOn:'2025-01-05',joinDate:'2025-02-01'},SAVED_FIRST);
  const review=await correct(id,{hiredOn:'2025-01-03',joinDate:'2025-01-15'},SAVED_LATER);
  expect(review.replacedCorrections).toEqual([expect.objectContaining({effectiveOn:SAVED_FIRST,fields:['hiredOn','joinDate']})]);
  expect(await employment(id)).toMatchObject({hiredOn:'2025-01-03',joinDate:'2025-01-15'});
  expect(await readAt(id,'2025-01-10')).toMatchObject({hiredOn:HIRED,joinDate:HIRED});
  for(const day of ['2025-03-01','2025-06-01','2025-11-01','2026-01-31'])expect(await readAt(id,day),day).toMatchObject({hiredOn:'2025-01-03',joinDate:'2025-01-15'});
  expect(await readAt(id,'2025-06-01')).toMatchObject({legacyHiredOn:HIRED,legacyJoinDate:HIRED});
 });
 it('equivalence: corrections saved in Effective Date order give the revision 3 answer on every day',async()=>{
  const id=await hire('LS-EQ',gamma);
  await correct(id,{companyId:b.companyId,joinDate:'2025-01-20'},'2025-03-01');
  await correct(id,{employmentType:'part_time'},'2025-08-01');
  await correct(id,{companyId:beta,hiredOn:'2025-01-03'},'2025-11-01');
  await correct(id,{joinDate:'2025-02-03'},'2025-11-01');
  const days=new Set<string>();
  for(let y=2025;y<=2026;y++)for(let m=1;m<=12;m++)days.add(`${y}-${String(m).padStart(2,'0')}-01`);
  for(const day of ['2025-03-01','2025-08-01','2025-11-01'])for(const n of [-1,0,1])days.add(addDays(day,n));
  for(const day of [...days].sort()){
   const r=await readAt(id,day);
   expect({hiredOn:r.hiredOn,joinDate:r.joinDate,companyId:r.companyId},day).toEqual({hiredOn:r.legacyHiredOn,joinDate:r.legacyJoinDate,companyId:r.legacyCompanyId});
  }
  // Independent expected values, so the equivalence is not vacuous.
  expect(await readAt(id,'2025-02-15')).toMatchObject({hiredOn:HIRED,joinDate:HIRED,companyId:gamma});
  expect(await readAt(id,'2025-06-01')).toMatchObject({hiredOn:HIRED,joinDate:'2025-01-20',companyId:b.companyId});
  expect(await readAt(id,'2025-12-01')).toMatchObject({hiredOn:'2025-01-03',joinDate:'2025-02-03',companyId:beta});
 });
});

describe('a flat label and the Direct Superior (Excel)',()=>{
 it('the latest saved Branch is current; the earlier correction no longer ends it',async()=>{
  const id=await hire('LS-LABEL');
  await correct(id,{orgBranch:'NORTH'},SAVED_FIRST,{method:'excel'});
  expect((await employment(id)).orgBranch).toBe('NORTH');
  const review=await correct(id,{orgBranch:'SOUTH'},SAVED_LATER,{method:'excel'});
  expect(review.until).toBeUndefined();
  expect(review.replacedCorrections).toEqual([expect.objectContaining({effectiveOn:SAVED_FIRST,fields:['orgBranch']})]);
  expect((await employment(id)).orgBranch).toBe('SOUTH');
  expect(await lastCorrection(id)).not.toHaveProperty('labelsNotCurrent');
 });
 it('the latest saved Direct Superior replaces the line an earlier correction wrote',async()=>{
  const id=await hire('LS-SUP'),first=await hire('LS-M1'),second=await hire('LS-M2');
  await correct(id,{managerEmploymentId:first},SAVED_FIRST,{method:'excel'});
  const review=await correct(id,{managerEmploymentId:second},SAVED_LATER,{method:'excel'});
  expect(review.until).toBeUndefined();
  expect(review.replacedCorrections).toEqual([expect.objectContaining({effectiveOn:SAVED_FIRST,fields:['managerEmploymentId']})]);
  const lines=await owner.db.select({validFrom:schema.reportingLine.validFrom,validTo:schema.reportingLine.validTo,manager:schema.reportingLine.managerEmploymentId,supersededAt:schema.reportingLine.supersededAt}).from(schema.reportingLine).where(and(eq(schema.reportingLine.subordinateEmploymentId,id),eq(schema.reportingLine.lineType,'administrative'))).orderBy(asc(schema.reportingLine.validFrom));
  expect(lines.filter(l=>!l.supersededAt).map(l=>[l.validFrom,l.validTo,l.manager])).toEqual([[SAVED_LATER,null,second]]);
  // The earlier correction's line is superseded, never deleted.
  expect(lines.filter(l=>l.supersededAt).map(l=>[l.validFrom,l.manager])).toEqual([[SAVED_FIRST,first]]);
 });
});

describe('Organisation Hire Correction',()=>{
 it('is the latest saved correction: it passes the boundary an earlier correction set for the same field',async()=>{
  const id=await hire('LS-HIRE');
  await correct(id,{departmentId:b.deptB},'2026-01-01');
  await correctHireDetails(ctx(),{employmentId:id,reason:'Fictional hire correction',changes:{departmentId:deptC}});
  expect((await versions(id)).map(v=>[v.validFrom,v.departmentId])).toEqual([[HIRED,deptC],['2026-01-01',deptC]]);
 });
 it('still stops at a recorded movement of the field',async()=>{
  const id=await hire('LS-HIRE-MOVE');
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-01-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  await correctHireDetails(ctx(),{employmentId:id,reason:'Fictional hire correction',changes:{departmentId:deptC}});
  expect((await versions(id)).map(v=>[v.validFrom,v.departmentId])).toEqual([[HIRED,deptC],['2026-01-01',b.deptB]]);
 });
});

describe('the dated planner (pure)',()=>{
 const v=(id:string,validFrom:string,validTo:string|null,companyId:string,departmentId='d1'):DatedVersion=>({id,validFrom,validTo,companyId,departmentId,employmentType:'full_time',businessUnitId:null,positionId:null});
 const rows=[v('v1',HIRED,SAVED_LATER,'G'),v('v2',SAVED_LATER,SAVED_FIRST,'A'),v('v3',SAVED_FIRST,TRANSFER,'B'),v('v4',TRANSFER,null,'B','d2')];
 const corrections=[{eventType:INFORMATION_CORRECTED_EVENT,payload:{effectiveOn:SAVED_LATER,fields:['companyId']}},{eventType:INFORMATION_CORRECTED_EVENT,payload:{effectiveOn:SAVED_FIRST,fields:['companyId']}}];
 const transfer={effectiveDate:TRANSFER,fields:['departmentId']};
 it('equivalence: with no earlier correction dated after the Effective Date nothing is carried and the plan is revision 3\'s',()=>{
  const carry=correctionCarry(corrections,[transfer],['companyId'],'2026-03-01');
  expect(carry).toEqual({});
  expect(planDatedCorrection(rows,'2026-03-01',{companyId:'C'},carry)).toEqual(planDatedCorrection(rows,'2026-03-01',{companyId:'C'}));
 });
 it('carries through an earlier correction boundary, never through a movement that owns the field',()=>{
  const carry=correctionCarry(corrections,[transfer,{effectiveDate:SAVED_FIRST,fields:['departmentId']}],['companyId','departmentId','businessUnitId'],'2025-06-01');
  expect(carry).toEqual({companyId:[SAVED_FIRST],businessUnitId:[SAVED_FIRST]});
  const plan=planDatedCorrection(rows,'2025-06-01',{companyId:'C'},carry);
  expect(plan.ranges.companyId).toEqual({from:'2025-06-01',to:null});
  expect(plan.affected.map(a=>[a.index,a.values])).toEqual([[1,{companyId:'C'}],[2,{companyId:'C'}],[3,{companyId:'C'}]]);
  // Revision 3 stopped at the earlier correction.
  expect(planDatedCorrection(rows,'2025-06-01',{companyId:'C'}).ranges.companyId).toEqual({from:'2025-06-01',to:SAVED_FIRST});
  // A movement on the same date that changed the field owns it.
  expect(correctionCarry(corrections,[{effectiveDate:SAVED_FIRST,fields:['companyId']}],['companyId'],'2025-06-01')).toEqual({});
  // A re-applied boundary counts as a correction's.
  expect(correctionCarry([{eventType:INFORMATION_BOUNDARY_REAPPLIED_EVENT,payload:{boundaries:[{date:'2025-09-01',fields:['departmentId']}]}}],[],['departmentId'],'2025-06-01')).toEqual({departmentId:['2025-09-01']});
 });
});
