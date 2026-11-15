/**
 * Board 4604dccc — Information-Only Correction with an Effective Date (ADR 2026-11-15 dated information corrections).
 * A correction applies from its Effective Date until each field's next recorded change; it no longer blocks an
 * earlier-dated movement; closed payroll in the corrected period is acknowledged, never recalculated; the hire
 * correction passes through a correction boundary for fields it did not set. Fictional tenant, companies, people.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull} from 'drizzle-orm';
import * as XLSX from 'xlsx';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {previewInformationUpload,confirmInformationUpload} from '../core/information-correction-import';
import {correctHireDetails} from '../core/hire-correction';
import {validatePayrollHistoryImport} from '../core/payroll-history-import';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {INFORMATION_HEADERS_V2,INFORMATION_HEADERS_V3,type InformationChanges} from '../lib/information-correction';
import {todayInKualaLumpur} from '../lib/hr-date';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {parseCsvRecords} from '../lib/csv';
import type {MovementImportRecord} from '../lib/movement-import-contract';

let b:Base;let coB:string;let coC:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await owner.db.update(schema.company).set({companyLabel:'ACME',country:'MY'}).where(eq(schema.company.id,b.companyId));
 const [beta]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Sdn Bhd',companyLabel:'BETA',country:'MY'}).returning({id:schema.company.id});coB=beta.id;
 const [gamma]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Gamma Fictional Sdn Bhd',companyLabel:'GAMMA',country:'MY'}).returning({id:schema.company.id});coC=gamma.id;
 for(const [labelKind,labelId] of [['department',b.deptA],['department',b.deptB],['position',b.positionId]] as const)
  await owner.db.insert(schema.labelCompanyAssignment).values([coB,coC].map(companyId=>({tenantId:b.tenantId,labelKind,labelId,companyId})));
});

const HIRED='2025-06-03';
const ctx=()=>adminCtx(b);
async function hire(code:string,hiredOn=HIRED,companyId=b.companyId){
 const e=await hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code,companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn});
 return e.employmentId as string;
}
const versions=(id:string)=>owner.db.select({validFrom:schema.assignment.validFrom,validTo:schema.assignment.validTo,companyId:schema.assignment.companyId,departmentId:schema.assignment.departmentId,employmentType:schema.assignment.employmentType}).from(schema.assignment).where(and(eq(schema.assignment.employmentId,id),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom));
const companyOf=async(id:string)=>(await owner.db.select({companyId:schema.employment.companyId}).from(schema.employment).where(eq(schema.employment.id,id)))[0].companyId;
async function correct(id:string,changes:InformationChanges,effectiveOn?:string,extra:{method?:'manual'|'excel';acknowledgeClosedPayroll?:boolean}={}){
 const method=extra.method??'manual';
 const review=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason:'Fictional correction',...(effectiveOn?{effectiveOn}:{})},{extended:method==='excel'});
 await correctInformation(ctx(),{employmentId:id,changes,reason:'Fictional correction',fingerprint:review.fingerprint,method,...(effectiveOn?{effectiveOn}:{}),...(extra.acknowledgeClosedPayroll?{acknowledgeClosedPayroll:true}:{})});
 return review;
}
async function closedPayroll(employmentId:string,companyId:string,period:string){
 const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'}).returning({id:schema.payPeriod.id});
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:pp.id,payPeriod:period,runSeq:1,runType:'regular',batchDate:`${period}-28`,status:'closed'}).returning({id:schema.payrollBatch.id});
 await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'4000.00',grossPay:'4000.00',totalDeductions:'500.00',netPay:'3500.00',employerCost:'4500.00',statutory:{}});
}

describe('a dated correction',()=>{
 it('splits the covering record at the Effective Date and leaves a later correction untouched',async()=>{
  const id=await hire('ED-1');
  await correct(id,{companyId:coB},'2026-06-01');
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[HIRED,b.companyId],['2026-06-01',coB]]);
  const review=await correct(id,{companyId:coC},'2026-01-01');
  // The later correction owns its own period; the new one stops there.
  expect(review.until).toEqual({companyId:'2026-06-01'});
  expect(review.warnings?.[0]).toEqual({code:'companyFrom',date:'2026-01-01',to:'2026-06-01'});
  expect((await versions(id)).map(v=>[v.validFrom,v.validTo,v.companyId])).toEqual([[HIRED,'2026-01-01',b.companyId],['2026-01-01','2026-06-01',coC],['2026-06-01',null,coB]]);
  // Today's company stays with the record with the latest Effective Date.
  expect(await companyOf(id)).toBe(coB);
  const [event]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,'employment.information.corrected'))).orderBy(asc(schema.domainEvent.sequence)).offset(1);
  expect(event.payload).toMatchObject({effectiveOn:'2026-01-01',nextBoundary:'2026-06-01',dated:true,fields:['companyId']});
 });
 it('from the Group Join Date corrects every field through the records that inherited it',async()=>{
  const id=await hire('ED-2');
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  const review=await correct(id,{companyId:coB,employmentType:'part_time'},HIRED);
  expect(review.fromJoinDate).toBe(true);
  expect(review.timeline?.map(r=>[r.date,r.kind,r.status])).toEqual([[HIRED,'hired','corrected'],['2026-02-01','transfer','corrected']]);
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId,v.departmentId,v.employmentType])).toEqual([[HIRED,coB,b.deptA,'part_time'],['2026-02-01',coB,b.deptB,'part_time']]);
  expect(await companyOf(id)).toBe(coB);
 });
 it('refuses a correction that contradicts a later movement\'s recorded Before value, naming it',async()=>{
  const id=await hire('ED-3');
  await createMovementEvent(ctx(),{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-04-01',companyId:coB,remarks:'Fictional transfer'});
  const review=await previewInformationCorrection(ctx(),{employmentId:id,changes:{companyId:coC},reason:'Fictional correction',effectiveOn:HIRED});
  expect(review.conflicts).toEqual([expect.objectContaining({date:'2026-04-01',field:'companyId',kind:'entityTransfer'})]);
  expect(review.timeline?.find(r=>r.date==='2026-04-01')?.status).toBe('conflict');
  const before=await versions(id);
  await expect(correctInformation(ctx(),{employmentId:id,changes:{companyId:coC},reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn:HIRED})).rejects.toThrow(/later .* on 2026-04-01 records a change from a different value/);
  expect(await versions(id)).toEqual(before);
  // A field the transfer did not change carries through it: no conflict.
  const agree=await previewInformationCorrection(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',effectiveOn:HIRED});
  expect(agree.conflicts).toBeUndefined();
 });
 it('needs an acknowledgement for closed payroll in the corrected period, and refuses one paid by another company',async()=>{
  const id=await hire('ED-4');
  await closedPayroll(id,b.companyId,'2026-02');
  const review=await previewInformationCorrection(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',effectiveOn:'2026-01-01'});
  expect(review.closedPayrollPeriods).toEqual(['2026-02']);
  await expect(correctInformation(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn:'2026-01-01'})).rejects.toThrow(/2026-02 is already closed/);
  await correctInformation(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn:'2026-01-01',acknowledgeClosedPayroll:true});
  expect((await versions(id)).map(v=>[v.validFrom,v.employmentType])).toEqual([[HIRED,'full_time'],['2026-01-01','part_time']]);
  // The closed payslip stays as issued.
  expect((await owner.db.select({net:schema.payslip.netPay}).from(schema.payslip).where(eq(schema.payslip.employmentId,id)))[0].net).toBe('3500.00');
  await expect(previewInformationCorrection(ctx(),{employmentId:id,changes:{companyId:coB},reason:'Fictional correction',effectiveOn:'2026-01-01'})).rejects.toThrow(/Payroll for 2026-02 was closed under a different company/);
 });
 it('refuses a future Effective Date and one before the Group Join Date',async()=>{
  const id=await hire('ED-5');
  await expect(previewInformationCorrection(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',effectiveOn:'2099-01-01'})).rejects.toThrow('Effective Date cannot be in the future.');
  await expect(previewInformationCorrection(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',effectiveOn:'2025-06-02'})).rejects.toThrow(/cannot be before 2025-06-03/);
  await expect(previewInformationCorrection(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction',effectiveOn:'2026-13-01'})).rejects.toThrow(/Effective Date: use a valid date/);
  // Blank means today.
  expect((await previewInformationCorrection(ctx(),{employmentId:id,changes:{employmentType:'part_time'},reason:'Fictional correction'})).effectiveOn).toBe(todayInKualaLumpur());
 });
});

describe('a correction no longer blocks an earlier-dated movement',()=>{
 it('places the earlier movement before the correction; the latest Effective Date is the current information',async()=>{
  const id=await hire('ED-6');
  await correct(id,{companyId:coB});
  const today=todayInKualaLumpur();
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-03-01',departmentId:b.deptB,remarks:'Fictional transfer recorded later'});
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId,v.departmentId])).toEqual([[HIRED,b.companyId,b.deptA],['2026-03-01',b.companyId,b.deptB],[today,coB,b.deptB]]);
  expect(await companyOf(id)).toBe(coB);
  const reapplied=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,'employment.information.boundary.reapplied')));
  expect(reapplied).toHaveLength(1);
  expect(reapplied[0].payload).toMatchObject({movementDate:'2026-03-01',boundaries:[expect.objectContaining({date:today,fields:['companyId']})]});
 });
 it('lets the hire correction pass through a correction for the fields it did not set',async()=>{
  const id=await hire('ED-7');
  await correct(id,{employmentType:'part_time'},'2026-01-01');
  await correctHireDetails(ctx(),{employmentId:id,reason:'Fictional hire correction',changes:{departmentId:b.deptB}});
  // Department carried through the correction boundary (it did not set it); employment type kept its own period.
  expect((await versions(id)).map(v=>[v.validFrom,v.departmentId,v.employmentType])).toEqual([[HIRED,b.deptB,'full_time'],['2026-01-01',b.deptB,'part_time']]);
 });
});

describe('the Information-Only Correction import',()=>{
 const workbook=(headers:readonly string[],rows:Record<string,string>[])=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[...headers],...rows.map(row=>headers.map(h=>row[h]??''))]),'Corrections');return XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;};
 it('imports a version 2 file from today and a version 3 file from its Effective Date',async()=>{
  const v2=await hire('ED-V2'),v3=await hire('ED-V3');
  const two=await previewInformationUpload(ctx(),{name:'v2.xlsx',content:workbook(INFORMATION_HEADERS_V2,[{'Company Code':'ACME','Employee ID':'ED-V2','Employment Type':'part_time','Correction Reason':'Fictional correction'}]),operationKey:randomUUID()});
  expect(two.plan.templateVersion).toBe(2);expect(two.plan.rows[0].errors).toEqual([]);expect(two.plan.rows[0].preview?.effectiveOn).toBe(todayInKualaLumpur());
  expect((await confirmInformationUpload(ctx(),{attemptId:two.attemptId,previewHash:two.plan.previewHash})).succeeded).toBe(1);
  expect((await versions(v2)).at(-1)).toMatchObject({validFrom:todayInKualaLumpur(),employmentType:'part_time'});
  const three=await previewInformationUpload(ctx(),{name:'v3.xlsx',content:workbook(INFORMATION_HEADERS_V3,[{'Company Code':'ACME','Employee ID':'ED-V3','Employment Type':'part_time','Department':'','Correction Reason':'Fictional correction','Effective Date':'2026-01-01'}]),operationKey:randomUUID()});
  expect(three.plan.templateVersion).toBe(3);expect(three.plan.rows[0].errors).toEqual([]);
  expect((await confirmInformationUpload(ctx(),{attemptId:three.attemptId,previewHash:three.plan.previewHash})).succeeded).toBe(1);
  expect((await versions(v3)).map(v=>[v.validFrom,v.employmentType])).toEqual([[HIRED,'full_time'],['2026-01-01','part_time']]);
 });
 it('reports a future Effective Date and closed payroll without the batch confirmation as row errors',async()=>{
  const id=await hire('ED-RW');await closedPayroll(id,b.companyId,'2026-02');
  const future=await previewInformationUpload(ctx(),{name:'f.xlsx',content:workbook(INFORMATION_HEADERS_V3,[{'Company Code':'ACME','Employee ID':'ED-RW','Employment Type':'part_time','Correction Reason':'Fictional correction','Effective Date':'2099-01-01'}]),operationKey:randomUUID()});
  expect(future.plan.rows[0].errors).toEqual(['Effective Date cannot be in the future.']);
  const closed=await previewInformationUpload(ctx(),{name:'c.xlsx',content:workbook(INFORMATION_HEADERS_V3,[{'Company Code':'ACME','Employee ID':'ED-RW','Employment Type':'part_time','Correction Reason':'Fictional correction','Effective Date':'2026-01-01'}]),operationKey:randomUUID()});
  expect(closed.plan.rows[0].preview?.closedPayrollPeriods).toEqual(['2026-02']);
  const refused=await confirmInformationUpload(ctx(),{attemptId:closed.attemptId,previewHash:closed.plan.previewHash});
  expect(refused.rows[0]).toMatchObject({status:'failed'});expect(refused.rows[0].errors[0]).toMatch(/2026-02 is already closed/);
 });
});

/** The reporter's case end to end: an employee migrated into Company B who really joined Company A. */
describe('the reporter\'s migration scenario',()=>{
 const JOIN='2026-01-01',TRANSFER='2026-07-01';
 it('corrects the hire to A from the join date, imports the 1 Jul transfer to B, then payroll history under each company',async()=>{
  const id=await hire('ED-MIG',JOIN,coB);
  await correct(id,{companyId:b.companyId},JOIN);
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[JOIN,b.companyId]]);
  const records:MovementImportRecord[]=[{row:2,employeeCode:'ED-MIG',cells:{kind:'entityTransfer',effectiveDate:TRANSFER,companyId:coB},before:{companyId:b.companyId},errors:[],importVersion:2,source:{sheet:'Movements',row:2}}];
  const preview=await previewMovementImport(ctx(),{companyId:b.companyId,csv:'',records});
  expect(preview.employees[0].rows[0].errors).toEqual([]);
  const committed=await commitMovementImport(ctx(),{companyId:b.companyId,csv:'',records,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.map(e=>[e.employeeCode,e.fingerprint!])),acknowledgeExcluded:false});
  expect(committed.imported).toBe(1);
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[JOIN,b.companyId],[TRANSFER,coB]]);
  expect(await companyOf(id)).toBe(coB);
  // Payroll history: January to June under A, July under B; a July row under A names B.
  await seedPayrollCycleCatalog(ctx(),b.companyId);await seedPayrollCycleCatalog(ctx(),coB);
  await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
  const month=(period:string,company:string)=>['BASIC,5000.00','EEEPF,550.00','EESOCSO,24.75','EEEIS,9.90','PCB,0.00','EREPF,650.00','ERSOCSO,86.65','EREIS,9.90'].map(item=>{const [code,amount]=item.split(',');return ['ED-MIG',period,'ME',code,company,amount].join(',');});
  const file=(...lines:string[])=>parseCsvRecords([PAYROLL_HISTORY_HEADERS.join(','),...lines].join('\n')).records;
  const underA=await validatePayrollHistoryImport(ctx(),{companyId:b.companyId,records:file(...['202601','202602','202603','202604','202605','202606'].flatMap(p=>month(p,'ACME')))});
  expect(underA.months.map(m=>m.ok)).toEqual([true,true,true,true,true,true]);
  const underB=await validatePayrollHistoryImport(ctx(),{companyId:coB,records:file(...month('202607','BETA'))});
  expect(underB.months.map(m=>m.ok)).toEqual([true]);
  const julyUnderA=await validatePayrollHistoryImport(ctx(),{companyId:b.companyId,records:file(...month('202607','ACME'))});
  expect(julyUnderA.months[0].ok).toBe(false);
  expect(julyUnderA.issues.map(i=>i.description)).toContain('Employee ED-MIG belonged to Beta Fictional Sdn Bhd during 2026-07, not Acme Sdn Bhd. Import this month under Beta Fictional Sdn Bhd.');
 });
 it('repairs a record already corrected the old way (from today): correct from the join date, then import the transfer',async()=>{
  const id=await hire('ED-OLD',JOIN,coB);
  await correct(id,{companyId:b.companyId});
  const today=todayInKualaLumpur();
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[JOIN,coB],[today,b.companyId]]);
  // The form compares with the record on the Effective Date: Company B then, although Company A today.
  const review=await correct(id,{companyId:b.companyId},JOIN);
  expect(review.before.companyId).toBe(coB);expect(review.until).toEqual({companyId:today});
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[JOIN,b.companyId],[today,b.companyId]]);
  await createMovementEvent(ctx(),{employmentId:id,kind:'entityTransfer',effectiveDate:TRANSFER,companyId:coB,remarks:'Fictional transfer recorded after the corrections'});
  // The old correction no longer changes anything after the join-date correction, so the transfer's company stands.
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[JOIN,b.companyId],[TRANSFER,coB]]);
  expect(await companyOf(id)).toBe(coB);
 });
});
