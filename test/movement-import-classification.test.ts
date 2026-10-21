import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {employment,domainEvent,leaveLedger,assignment,compensation} from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {setEmploymentTestRecord,employmentTestRecord} from '../core/employment-test-record';
import {EMPLOYMENT_TEST_RECORD_EVENT} from '../core/movement-import-admission';
import {previewMovementImport,commitMovementImport,movementImportDownloadData} from '../core/movement-import';
import {createCompany,createDepartment} from '../core/admin';
import {setLabelCriteriaBatch} from '../core/system-labels';
import {setCompensation} from '../core/comp';
import {movementCurrentState,movementHistory,applyDueMovementsTx} from '../core/movement';
import {todayInKualaLumpur} from '../lib/hr-date';
import {personnelField} from '../lib/personnel-field-registry';
import type {MovementImportRecord,MovementImportPreview} from '../lib/movement-import-contract';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const ctx=()=>adminCtx(b);
async function hire(code:string,companyId=b.companyId,departmentId=b.deptA){return hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:day(-100),employeeCode:code});}
const record=(code:string,kind:string,cells:MovementImportRecord['cells']={},row=1):MovementImportRecord=>({row,employeeCode:code,cells:{kind,effectiveDate:day(-1),...cells},errors:[],importVersion:2,source:{sheet:kind,row:row+5}});
const preview=(records:MovementImportRecord[])=>previewMovementImport(ctx(),{companyId:b.companyId,csv:'',records,sourceHash:'fictional-file'});
const apply=(records:MovementImportRecord[],p:MovementImportPreview,selection=p.selection)=>commitMovementImport(ctx(),{companyId:b.companyId,csv:'',records,sourceHash:'fictional-file',selection,inputHash:p.inputHash,fingerprints:Object.fromEntries(p.employees.map(e=>[e.employeeCode,e.fingerprint!])),acknowledgeExcluded:true});
const audit=(id:string)=>owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence));
describe('deliberate employment classification and import-only new-superior admission',()=>{
 it('writes metadata and actor/before/after audit without financial or leave side effects and has no generic/ESS binding',async()=>{
  const e=await hire('B22-SUB');const before={ledger:await owner.db.select().from(leaveLedger).orderBy(asc(leaveLedger.id)),assignment:await owner.db.select().from(assignment).orderBy(asc(assignment.id)),comp:await owner.db.select().from(compensation).orderBy(asc(compensation.id))};
  expect(await employmentTestRecord(ctx(),e.employmentId)).toEqual({isTestRecord:false});await setEmploymentTestRecord(ctx(),{employmentId:e.employmentId,isTestRecord:true});await setEmploymentTestRecord(ctx(),{employmentId:e.employmentId,isTestRecord:true});
  expect(await employmentTestRecord(ctx(),e.employmentId)).toEqual({isTestRecord:true});const events=(await audit(e.employmentId)).filter(e=>e.eventType===EMPLOYMENT_TEST_RECORD_EVENT);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorId:b.adminUserId,payload:expect.objectContaining({before:false,after:true})});
  expect({ledger:await owner.db.select().from(leaveLedger).orderBy(asc(leaveLedger.id)),assignment:await owner.db.select().from(assignment).orderBy(asc(assignment.id)),comp:await owner.db.select().from(compensation).orderBy(asc(compensation.id))}).toEqual(before);
  const field=personnelField('employment.data_classification.istestrecord')!;expect(field.import.column).toBeUndefined();expect(field.import.writer).toBeUndefined();expect(field.ess.binding).toBeUndefined();expect(field.ess.visibility).toBe('protected');
  await expect(setEmploymentTestRecord({...ctx(),roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},{employmentId:e.employmentId,isTestRecord:false})).rejects.toThrow('classification_not_available');
 });
 it('retains marked subjects in filtered prefill and does not stale an unrelated event for subject/current/unrelated manager flags',async()=>{
  const sub=await hire('B22-SUB'),manager=await hire('B22-MANAGER'),other=await hire('B22-OTHER');await setReportingLine(ctx(),{subordinateEmploymentId:sub.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:day(-90)});
  const records=[record('B22-SUB','secondment',{remarks:'Fictional exercise'})],p=await preview(records);expect(p.valid).toBe(1);
  for(const e of [sub,manager,other])await setEmploymentTestRecord(ctx(),{employmentId:e.employmentId,isTestRecord:true});
  const download=await movementImportDownloadData(ctx(),{companyId:b.companyId,typeCode:'secondment'});expect(download.subjects.some(e=>e.employeeCode==='B22-SUB')).toBe(true);
  expect((await apply(records,p)).imported).toBe(1);
 });
 it('resolves an unchanged marked manager instead of refusing an unrelated salary exercise',async()=>{
  const sub=await hire('B22-SUB'),manager=await hire('B22-MANAGER');await setReportingLine(ctx(),{subordinateEmploymentId:sub.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:day(-90)});await setEmploymentTestRecord(ctx(),{employmentId:manager.employmentId,isTestRecord:true});await setCompensation(ctx(),{employmentId:sub.employmentId,effectiveFrom:day(-80),basicSalary:3000});
  const records=[{...record('B22-SUB','increment',{managerEmploymentId:'B22-MANAGER'}),incrementAmount:'25.13'}],p=await preview(records);expect(p.valid).toBe(1);expect((await apply(records,p)).imported).toBe(1);expect((await movementCurrentState(ctx(),sub.employmentId)).basicSalary).toBe('3025.13');
 });
 it('rejects a newly typed marked superior and stales a relevant false→true→false change',async()=>{
  await hire('B22-SUB');const manager=await hire('B22-MANAGER');const records=[record('B22-SUB','reportingLineChange',{managerEmploymentId:'B22-MANAGER'})],p=await preview(records);expect(p.valid).toBe(1);
  await setEmploymentTestRecord(ctx(),{employmentId:manager.employmentId,isTestRecord:true});expect((await preview(records)).valid).toBe(0);await setEmploymentTestRecord(ctx(),{employmentId:manager.employmentId,isTestRecord:false});
  expect((await apply(records,p)).imported).toBe(0);const fresh=await preview(records);expect((await apply(records,fresh)).imported).toBe(1);
 });
 it('uses independent sequence, not timestamp or UUID order, for a relevant newly appended classification audit',async()=>{
  await hire('B22-SUB');const manager=await hire('B22-MANAGER'),when=new Date(day(-1)+'T00:00:00Z');
  // Append-only fixture events deliberately tie timestamps and descend UUIDs; no existing audit is edited.
  await owner.db.insert(domainEvent).values({id:'ffffffff-ffff-4fff-8fff-ffffffffffff',tenantId:b.tenantId,aggregateType:'employment',aggregateId:manager.employmentId,eventType:EMPLOYMENT_TEST_RECORD_EVENT,actorType:'user',actorId:b.adminUserId,subjectEmploymentId:manager.employmentId,occurredAt:when,payload:{before:true,after:false}});
  const records=[record('B22-SUB','reportingLineChange',{managerEmploymentId:'B22-MANAGER'})],p=await preview(records);expect(p.valid).toBe(1);
  await owner.db.insert(domainEvent).values({id:'00000001-0000-4000-8000-000000000001',tenantId:b.tenantId,aggregateType:'employment',aggregateId:manager.employmentId,eventType:EMPLOYMENT_TEST_RECORD_EVENT,actorType:'user',actorId:b.adminUserId,subjectEmploymentId:manager.employmentId,occurredAt:when,payload:{before:true,after:false}});
  expect((await apply(records,p)).imported).toBe(0);
 });
 it('prevalidates a later partial employee selection before an earlier independent employee can commit',async()=>{
  const first=await hire('B22-FIRST');await hire('B22-SECOND');const records=[record('B22-FIRST','secondment',{},1),record('B22-SECOND','secondment',{},2),record('B22-SECOND','actingPosition',{effectiveDate:day(0)},3)],p=await preview(records),before=await audit(first.employmentId);
  await expect(apply(records,p,[1,2])).rejects.toThrow('whole_employee_selection_required');expect(await audit(first.employmentId)).toEqual(before);
 });
 it('preserves future Entity Transfer then destination-qualified manager sequence through canonical replay and sweep',async()=>{
  const sub=await hire('B22-SUB'),destination=await createCompany(ctx(),{legalName:'Fictional Destination',country:'MY'}),department=await createDepartment(ctx(),{companyId:destination.id,name:'Destination Operations'});await setLabelCriteriaBatch(ctx(),[{kind:'department',labelId:department.id,isGlobal:false,companyIds:[destination.id]}]);const manager=await hire('B22-DEST',destination.id,department.id);
  const records=[record('B22-SUB','entityTransfer',{companyId:'Fictional Destination',departmentId:'Fictional Destination · Destination Operations',effectiveDate:day(7)},1),record('B22-SUB','reportingLineChange',{managerEmploymentId:'Fictional Destination · B22-DEST · Fictional B22-DEST',effectiveDate:day(14)},2)];
  const p=await preview(records);expect(p.valid).toBe(2);expect(p.employees[0].rows[1].before?.companyId).toBe('Fictional Destination');expect((await apply(records,p)).imported).toBe(2);expect((await movementCurrentState(ctx(),sub.employmentId)).companyId).toBe(b.companyId);expect((await movementHistory(ctx(),sub.employmentId)).filter(r=>r.status==='pending')).toHaveLength(2);
  await withTenant(ctx(),tx=>applyDueMovementsTx(tx,ctx(),sub.employmentId,day(14)));expect(await movementCurrentState(ctx(),sub.employmentId)).toMatchObject({companyId:destination.id,managerEmploymentId:manager.employmentId});
 });
 it('warns on direct salary adjustment increases and keeps exact authoritative increment cents',async()=>{
  const sub=await hire('B22-SUB');await setCompensation(ctx(),{employmentId:sub.employmentId,effectiveFrom:day(-80),basicSalary:3000});const records=[record('B22-SUB','salaryAdjustment',{basicSalary:'4000.00',remarks:'Fictional pay exercise'})],p=await preview(records);expect(p.valid).toBe(1);expect(p.employees[0].rows[0].warnings).toContain('salary_rise_over_twenty_percent');
  const increment=[{...record('B22-SUB','increment'),incrementAmount:'25.13'}],q=await preview(increment);expect(q.employees[0].rows[0].proposed?.basicSalary).toBe('3025.13');expect((await apply(increment,q)).imported).toBe(1);
 });
});
