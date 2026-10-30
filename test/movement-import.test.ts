import {randomUUID} from 'node:crypto';
import {asc,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {assignment,compensation,domainEvent,employment,leaveLedger,leaveEntitlementRecalcAudit,payPeriod,payrollBatch,payslip,movementEventType,systemLabelCriteriaEpoch} from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {withTenant} from '../db/client';
import * as tenantClient from '../db/client';
import {createCompany,createDepartment,createJobGrade} from '../core/admin';
import {setLabelCriteriaBatch} from '../core/system-labels';
import {createMovementEvent,movementCurrentState,movementHistory,reverseMovementEvent,applyDueMovementsTx} from '../core/movement';
import {previewMovementImport,commitMovementImport,movementImportCatalog} from '../core/movement-import';
import {saveMovementEventType,setMovementEventTypeActive} from '../core/movement-type';
import * as leaveService from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';
import type {MovementImportPreview} from '../lib/movement-import-contract';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function hire(code='EMP-0004'){
 const result=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Movement '+code,primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60),employeeCode:code});return result.employmentId;
}
const csv=(rows:(string|number)[][])=>toCsv([['employee_code','event_type','effective_date','department_id','basic_salary','remarks'],...rows]);
const fingerprints=(preview:MovementImportPreview)=>Object.fromEntries(preview.employees.filter(employee=>employee.fingerprint).map(employee=>[employee.employeeCode,employee.fingerprint!]));
async function ready(text:string,selection?:number[]){return previewMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection});}
async function commit(text:string,preview:MovementImportPreview,acknowledgeExcluded=true){return commitMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection:preview.selection,inputHash:preview.inputHash,fingerprints:fingerprints(preview),acknowledgeExcluded});}
const epochs=()=>owner.db.select().from(systemLabelCriteriaEpoch).where(eq(systemLabelCriteriaEpoch.tenantId,b.tenantId)).orderBy(asc(systemLabelCriteriaEpoch.labelKind));
async function state(id:string){return {
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)).orderBy(asc(employment.id)),
 assignments:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 compensation:await owner.db.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
 ledger:await owner.db.select().from(leaveLedger).where(eq(leaveLedger.employmentId,id)).orderBy(asc(leaveLedger.id)),
 audit:await owner.db.select().from(leaveEntitlementRecalcAudit).where(eq(leaveEntitlementRecalcAudit.employmentId,id)).orderBy(asc(leaveEntitlementRecalcAudit.id)),
};}
describe('Movement rollback-only preview and atomic confirmation',()=>{
 it('rejects the whole employee sequence when any event is invalid and cannot salvage selected rows',async()=>{
  const id=await hire(),before=await state(id),beforeEpoch=await epochs();
  const text=csv([['EMP-0004','transfer',day(-2),b.deptB,'','Later transfer'],['EMP-0004','hired',day(-3),'','','Not creatable'],['EMP-0004','promotion',day(-5),'','3500','Earlier promotion']]);
  const initial=await ready(text);expect(initial.fileErrors).toEqual([]);expect(initial.valid).toBe(0);expect(initial.excluded).toBe(3);
  expect(initial.employees[0].rows.map(row=>row.row)).toEqual([4,3,2]);expect(await state(id)).toEqual(before);expect(await epochs()).toEqual(beforeEpoch);
  const narrowed=await ready(text,[2,4]);await expect(commit(text,narrowed)).rejects.toThrow('whole_employee_selection_required');expect(await state(id)).toEqual(before);
 });
 it('refuses selecting a successor without its predecessor before the first write',async()=>{
  const id=await hire();const text=csv([['EMP-0004','transfer',day(-5),b.deptB,'',''],['EMP-0004','transfer',day(-2),b.deptA,'','']]);
  const selected=await ready(text,[3]);await expect(commit(text,selected)).rejects.toThrow('whole_employee_selection_required');expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptA);
 });
 it('preserves future scheduled semantics and ordinary history View/Edit/Roll Back identities',async()=>{
  const id=await hire(),before=await state(id);const text=csv([['EMP-0004','transfer',day(7),b.deptB,'','Scheduled fictional movement']]);
  const preview=await ready(text);expect(preview.valid).toBe(1);expect(preview.employees[0].rows[0].scheduled).toBe(true);expect(await state(id)).toEqual(before);
  expect((await commit(text,preview)).imported).toBe(1);expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptA);
  const row=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='transfer');expect(row).toBeDefined();expect(row?.status).toBe('pending');
  await reverseMovementEvent(adminCtx(b),{employmentId:id,movementId:row!.id,reason:'Fictional import rollback'});
  expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptA);expect((await movementHistory(adminCtx(b),id)).find(item=>item.id===row!.id)?.status).toBe('reversed');
 });
 it('refuses stale input, selected rows, live catalogue and canonical employee state',async()=>{
  const id=await hire();const text=csv([['EMP-0004','transfer',day(-2),b.deptB,'','']]);const preview=await ready(text);
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'secondment',effectiveDate:day(-1),remarks:'Concurrent change'});
  expect((await commit(text,preview)).imported).toBe(0);
  const fresh=await ready(text);await setMovementEventTypeActive(adminCtx(b),{code:'transfer',active:false});expect((await commit(text,fresh)).imported).toBe(0);
  await expect(commit(text+'\n',preview)).rejects.toThrow('preview_changed');
  await expect(commitMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection:[999],inputHash:preview.inputHash,fingerprints:fingerprints(preview),acknowledgeExcluded:true})).rejects.toThrow('invalid_selection');
 });
 it('offers and applies an active custom type through its canonical behaviour, refusing inactive and Hired',async()=>{
  await hire();const type=await saveMovementEventType(adminCtx(b),{label:'Regional Movement',behaviourKind:'secondment'});
  const catalog=await movementImportCatalog(adminCtx(b),b.companyId);expect(catalog.types.some(row=>row.code===type.code)).toBe(true);expect(catalog.types.some(row=>row.code==='hired')).toBe(false);
  const text=csv([['EMP-0004',type.code,day(-1),'','','']]);const preview=await ready(text);expect(preview.valid).toBe(1);expect((await commit(text,preview)).imported).toBe(1);
  await setMovementEventTypeActive(adminCtx(b),{code:type.code,active:false});expect((await ready(text)).valid).toBe(0);
 });
 it('rolls actual grade, leave, compensation and audit back when the committed pass’s second required leave leg refuses',async()=>{
  const ctx=adminCtx(b),year=todayInKualaLumpur().slice(0,4),grade=await createJobGrade(ctx,{code:'IMP16',name:'Import sixteen days'});
  await seedEntitlement(ctx,{leaveTypeId:b.annualLeaveTypeId,annualDays:8,validFrom:year+'-01-01',name:'Import base eight days'});
  await seedEntitlement(ctx,{leaveTypeId:b.annualLeaveTypeId,annualDays:16,gradeId:grade.id,validFrom:year+'-01-01',name:'Import grade sixteen days'});
  const e=await hireEmployee(ctx,{person:{fullName:'Fictional full atomic import',primaryEmail:randomUUID()+'@fixture.test'},employeeCode:'EMP-0004',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:year+'-01-01',grantLeaveTypes:[{id:b.annualLeaveTypeId,code:'ANNUAL'}]});
  const id=e.employmentId,before=await state(id);expect(before.ledger.reduce((sum,row)=>sum+Number(row.days),0)).toBe(8);
  const text=toCsv([['employee_code','event_type','effective_date','department_id','basic_salary','grade_id'],['EMP-0004','promotion',day(-5),'','3500',grade.id],['EMP-0004','transfer',day(-2),b.deptB,'','']]);const preview=await ready(text);expect(preview.valid).toBe(2);expect(await state(id)).toEqual(before);
  const real=leaveService.reprojectEntitlementForEmployment;let calls=0,committedPassDelta:number|null=null;
  const spy=vi.spyOn(leaveService,'reprojectEntitlementForEmployment').mockImplementation(async(...args)=>{calls++;if(calls===4)throw new Error('fixture_required_leave_refusal');const value=await real(...args);if(calls===3)committedPassDelta=value.totalDelta;return value;});
  try {const result=await commit(text,preview);expect(calls).toBe(4);expect(committedPassDelta).toBe(8);expect(result.imported).toBe(0);expect(result.failed).toBe(2);expect(await state(id)).toEqual(before);}finally{spy.mockRestore();}
 });
 it('keeps unrelated employees independent while refusing nonexistent Employee IDs and non-admin callers',async()=>{
  const id=await hire();const text=csv([['EMP-0004','transfer',day(-2),b.deptB,'',''],['MISSING','promotion',day(-1),'','3500','']]);
  const preview=await ready(text);expect(preview.valid).toBe(1);
  const result=await commitMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection:[2],inputHash:preview.inputHash,fingerprints:fingerprints(preview),acknowledgeExcluded:true});
  expect(result).toMatchObject({imported:1,failed:0,excluded:1});expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptB);
  await expect(previewMovementImport({...adminCtx(b),roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},{companyId:b.companyId,csv:text})).rejects.toThrow('Only an admin');
 });

 it('confirms an original mixed preview for a complete valid employee while excluding another employee’s invalid sequence',async()=>{
  const good=await hire(),bad=await hire('EMP-0005'),beforeGood=await state(good),beforeBad=await state(bad);
  const text=csv([['EMP-0004','secondment',day(-2),'','','Valid first event'],['EMP-0005','transfer',day(-1),'Missing department','','Invalid other employee'],['EMP-0004','actingPosition',day(-1),'','','Valid second event']]);
  const preview=await ready(text);expect(preview).toMatchObject({valid:2,excluded:1});expect(await state(good)).toEqual(beforeGood);expect(await state(bad)).toEqual(beforeBad);
  const payload={companyId:b.companyId,csv:text,selection:[2,4],inputHash:preview.inputHash,fingerprints:fingerprints(preview),acknowledgeExcluded:false};
  await expect(commitMovementImport(adminCtx(b),payload)).rejects.toThrow('confirm_excluded_rows');
  const result=await commitMovementImport(adminCtx(b),{...payload,acknowledgeExcluded:true});
  expect(result).toMatchObject({imported:2,failed:0,excluded:1});expect(await state(bad)).toEqual(beforeBad);
  const history=await movementHistory(adminCtx(b),good);
  expect(history.filter(row=>['secondment','actingPosition'].includes(row.kind)).map(row=>row.kind).sort()).toEqual(['actingPosition','secondment']);
  const audits=(await state(good)).events.filter(row=>row.eventType==='movement-import.employee.applied');
  expect(audits).toHaveLength(1);expect(audits[0].payload).toMatchObject({eventCount:2,sourceRows:[{key:2,sheet:'CSV',row:2},{key:4,sheet:'CSV',row:4}]});
 });

 it('allows deselecting a complete valid employee but refuses adding an employee not rehearsed in the preview',async()=>{
  const selected=await hire(),excluded=await hire('EMP-0005'),beforeExcluded=await state(excluded);
  const text=csv([['EMP-0004','secondment',day(-2),'','','Selected employee'],['EMP-0005','actingPosition',day(-1),'','','Excluded employee']]);
  const preview=await ready(text);expect(preview.valid).toBe(2);
  const result=await commitMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection:[2],inputHash:preview.inputHash,fingerprints:fingerprints(preview),acknowledgeExcluded:true});
  expect(result).toMatchObject({imported:1,failed:0,excluded:1});expect(await state(excluded)).toEqual(beforeExcluded);
  const narrowed=await ready(text,[2]);
  const unpreviewed=await commitMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection:[3],inputHash:narrowed.inputHash,fingerprints:fingerprints(narrowed),acknowledgeExcluded:true});
  expect(unpreviewed).toMatchObject({imported:0,failed:1,excluded:1});expect(await state(excluded)).toEqual(beforeExcluded);
  expect((await movementHistory(adminCtx(b),selected)).filter(row=>row.kind==='secondment')).toHaveLength(1);
 });

 it('validates a future Entity Transfer then a destination-scoped promotion without applying either early',async()=>{
  const id=await hire(),ctx=adminCtx(b);const destination=await createCompany(ctx,{legalName:'Fictional Movement destination',country:'MY'});
  const department=await createDepartment(ctx,{companyId:destination.id,name:'Destination Operations'});
  await setLabelCriteriaBatch(ctx,[{kind:'department',labelId:department.id,isGlobal:false,companyIds:[destination.id]}]);
  const text=toCsv([['employee_code','event_type','effective_date','company_id','department_id','basic_salary'],['EMP-0004','entityTransfer',day(7),destination.id,department.id,''],['EMP-0004','promotion',day(14),'',department.id,'4200']]);
  const before=await state(id);const preview=await ready(text);expect(preview.valid).toBe(2);expect(await state(id)).toEqual(before);
  expect(preview.employees[0].rows[1].before?.companyId).toBe('Fictional Movement destination');expect(preview.employees[0].rows[1].proposed?.basicSalary).toBe('4200.00');
  const result=await commit(text,preview);expect(result.imported).toBe(2);expect((await movementCurrentState(ctx,id)).companyId).toBe(b.companyId);
  const after=await state(id);expect(after.employment).toEqual(before.employment);expect(after.assignments).toEqual(before.assignments);expect(after.compensation).toEqual(before.compensation);
  const intents=after.events.filter(row=>row.eventType==='employment.movement.scheduled'),pending=(await movementHistory(ctx,id)).filter(row=>row.status==='pending');
  expect(intents).toEqual(expect.arrayContaining([expect.objectContaining({payload:expect.objectContaining({type:'entityTransfer',effectiveDate:day(7)})}),expect.objectContaining({payload:expect.objectContaining({type:'promotion',effectiveDate:day(14)})})]));expect(intents).toHaveLength(2);expect(pending.map(row=>row.id).sort()).toEqual(intents.map(row=>row.id).sort());
  await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,id,day(14)));
  expect(await movementCurrentState(ctx,id)).toMatchObject({companyId:destination.id,departmentId:department.id,basicSalary:'4200.00'});
 });
 it('commits future salary and department returns to the present baseline without applying either date early',async()=>{
  const id=await hire(),ctx=adminCtx(b);await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:day(-40)});
  const before=await state(id),text=csv([['EMP-0004','promotion',day(7),b.deptB,3500,'Future first'],['EMP-0004','promotion',day(14),b.deptA,3000,'Future return']]);
  const preview=await ready(text);expect(preview.valid).toBe(2);expect(preview.employees[0].rows[1].before?.basicSalary).toBe('3500.00');expect(preview.employees[0].rows[1].proposed?.basicSalary).toBe('3000.00');expect(await state(id)).toEqual(before);
  const result=await commit(text,preview);expect(result).toMatchObject({imported:2,failed:0});expect(result.employees[0].rows[1].proposed).toEqual(preview.employees[0].rows[1].proposed);
  const after=await state(id);expect(after.employment).toEqual(before.employment);expect(after.assignments).toEqual(before.assignments);expect(after.compensation).toEqual(before.compensation);
  const intents=after.events.filter(row=>row.eventType==='employment.movement.scheduled'),pending=(await movementHistory(ctx,id)).filter(row=>row.status==='pending');
  expect(intents).toEqual(expect.arrayContaining([expect.objectContaining({payload:expect.objectContaining({type:'promotion',effectiveDate:day(7)})}),expect.objectContaining({payload:expect.objectContaining({type:'promotion',effectiveDate:day(14)})})]));expect(intents).toHaveLength(2);expect(pending.map(row=>row.id).sort()).toEqual(intents.map(row=>row.id).sort());
  await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,id,day(7)));expect(await movementCurrentState(ctx,id)).toMatchObject({departmentId:b.deptB,basicSalary:'3500.00'});
  await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,id,day(14)));expect(await movementCurrentState(ctx,id)).toMatchObject({departmentId:b.deptA,basicSalary:'3000.00'});
 });
 it('refuses pre-hire neutral events and conflicting same-date writes while retaining disjoint same-date changes',async()=>{
  const id=await hire(),before=await state(id);
  expect((await ready(csv([['EMP-0004','secondment',day(-61),'','','Before hire']]))).valid).toBe(0);
  const conflict=csv([['EMP-0004','promotion',day(-2),'','3500',''],['EMP-0004','increment',day(-2),'','3700','']]);const preview=await ready(conflict);expect(preview.valid).toBe(0);expect(preview.employees[0].rows.find(row=>row.row===2)?.errors).toEqual(['employee_sequence_invalid']);expect(preview.employees[0].rows.find(row=>row.row===3)?.errors).toContain('same_date_conflicting_changes');
  expect(await state(id)).toEqual(before);
  const disjoint=csv([['EMP-0004','promotion',day(-2),'','3500',''],['EMP-0004','transfer',day(-2),b.deptB,'','']]);expect((await ready(disjoint)).valid).toBe(2);
 });
 it('refuses a selected ordinary successor after an earlier selected termination, with no retained preview effects',async()=>{
  const id=await hire(),before=await state(id);
  const text=toCsv([['employee_code','event_type','effective_date','end_date','termination_reason_code','remarks'],['EMP-0004','termination',day(-5),day(-5),'contract_expiry','Fictional end'],['EMP-0004','secondment',day(-2),'','','After end']]);
  const preview=await ready(text);expect(preview.valid).toBe(0);expect(preview.employees[0].rows.find(row=>row.row===2)?.errors).toEqual(['employee_sequence_invalid']);expect(preview.employees[0].rows.find(row=>row.row===3)?.errors).toContain('event_after_exit');expect(await state(id)).toEqual(before);
 });


 it('does not offer or execute a corrupt custom lifecycle mapping hidden behind an otherwise active code',async()=>{
  const id=await hire(),before=await state(id),ctx=adminCtx(b);
  // 1d58019a Step 2 (ADR-0166) — Termination is a configurable behaviour now, so the forged mapping uses a
  // lifecycle kind that is still out of reach for a tenant's own type.
  await owner.db.insert(movementEventType).values({tenantId:b.tenantId,code:'forged_exit',label:'Fictional forged lifecycle type',behaviourKind:'probationExtension',isActive:true});
  expect((await movementImportCatalog(ctx,b.companyId)).types.some(type=>type.code==='forged_exit')).toBe(false);
  expect((await ready(csv([['EMP-0004','forged_exit',day(-1),'','','']]))).valid).toBe(0);expect(await state(id)).toEqual(before);
 });
 it('requires both company scopes for Entity Transfer and refuses foreign-tenant subjects without leaking identity',async()=>{
  const id=await hire(),ctx=adminCtx(b),destination=await createCompany(ctx,{legalName:'Fictional restricted destination',country:'MY'}),department=await createDepartment(ctx,{companyId:destination.id,name:'Restricted destination department'});
  await setLabelCriteriaBatch(ctx,[{kind:'department',labelId:department.id,isGlobal:false,companyIds:[destination.id]}]);
  const text=toCsv([['employee_code','event_type','effective_date','company_id','department_id'],['EMP-0004','entityTransfer',day(-2),destination.id,department.id]]);
  const scoped={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};const before=await state(id);
  const refused=await previewMovementImport(scoped,{companyId:b.companyId,csv:text});expect(refused.valid).toBe(0);expect(await state(id)).toEqual(before);
  const foreign=await seedBase(),foreignResult=await previewMovementImport(adminCtx(foreign),{companyId:foreign.companyId,csv:csv([['EMP-0004','secondment',day(-1),'','','']])});
  expect(foreignResult.valid).toBe(0);expect(foreignResult.employees[0].name).toBeNull();expect(foreignResult.employees[0].employmentId).toBeNull();expect(await state(id)).toEqual(before);
 });
 it('keeps employees independent when a later canonical write fails for only one employee',async()=>{
  const first=await hire('EMP-0004'),second=await hire('EMP-0005'),beforeFirst=await state(first),beforeSecond=await state(second);
  const text=csv([['EMP-0004','promotion',day(-5),'','3500',''],['EMP-0004','transfer',day(-2),b.deptB,'',''],['EMP-0005','promotion',day(-1),'','3900','']]);const preview=await ready(text);expect(preview.valid).toBe(3);
  await owner.db.execute(sql`create function public.b20_import_one_employee_refusal() returns trigger language plpgsql as $$ begin if exists(select 1 from employment where id=NEW.employment_id and employee_code='EMP-0004') then raise exception 'fixture one employee write refusal'; end if; return NEW; end $$`);
  await owner.db.execute(sql`create trigger b20_import_one_employee_refusal before insert on assignment for each row execute function public.b20_import_one_employee_refusal()`);
  try {const result=await commit(text,preview);expect(result).toMatchObject({imported:1,failed:2});expect(await state(first)).toEqual(beforeFirst);expect((await state(second)).compensation).not.toEqual(beforeSecond.compensation);expect((await movementCurrentState(adminCtx(b),second)).basicSalary).toBe('3900.00');}
  finally{await owner.db.execute(sql`drop trigger b20_import_one_employee_refusal on assignment`);await owner.db.execute(sql`drop function public.b20_import_one_employee_refusal()`);}
 });
 it('records a backdated movement without altering a released payroll and retains its normal correction lock',async()=>{
  const id=await hire(),ctx=adminCtx(b),effective=day(-2),period=effective.slice(0,7);
  const [pp]=await owner.db.insert(payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning({id:payPeriod.id});
  const [batch]=await owner.db.insert(payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:pp.id,payPeriod:period,batchDate:period+'-25',status:'closed'}).returning({id:payrollBatch.id});
  await owner.db.insert(payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',statutory:{},totalDeductions:'0.00',netPay:'3000.00',employerCost:'3000.00'});
  const beforeBatch=await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id,batch.id)),beforeSlips=await owner.db.select().from(payslip).where(eq(payslip.batchId,batch.id)).orderBy(asc(payslip.id));
  const text=csv([['EMP-0004','transfer',effective,b.deptB,'','Fictional historic transfer']]),preview=await ready(text);expect(preview.valid).toBe(1);expect((await commit(text,preview)).imported).toBe(1);
  expect(await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id,batch.id))).toEqual(beforeBatch);expect(await owner.db.select().from(payslip).where(eq(payslip.batchId,batch.id)).orderBy(asc(payslip.id))).toEqual(beforeSlips);
  const movement=(await movementHistory(ctx,id)).find(row=>row.kind==='transfer');expect(movement).toMatchObject({payrollLocked:true,canReverse:true});
  // 646355e5 — the closed run no longer locks the row, but a correction without the acknowledgement is refused.
  await expect(reverseMovementEvent(ctx,{employmentId:id,movementId:movement!.id,reason:'Fictional unacknowledged rollback'})).rejects.toThrow(/already closed/);
 });

 it('rolls back transactional label epochs and an actually armed audit chain during preview',async()=>{
  const id=await hire(),before=await state(id),beforeEpoch=await epochs(),text=csv([['EMP-0004','transfer',day(-2),b.deptB,'','Armed preview audit']]);
  const original=tenantClient.withTenant,beforeIds=new Set(before.events.map(row=>row.id));let observedChainRows=0,observedEpochChange=false;
  const intercepted:typeof original=async<T>(ctx:tenantClient.SessionContext,fn:(tx:tenantClient.Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>original(ctx,async tx=>{
   await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
   try{return await fn(tx);}catch(error){
    const rows=await tx.select({id:domainEvent.id,chainSeq:domainEvent.chainSeq}).from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id));observedChainRows+=rows.filter(row=>!beforeIds.has(row.id)&&row.chainSeq!==null).length;
    const currentEpoch=await tx.select().from(systemLabelCriteriaEpoch).where(eq(systemLabelCriteriaEpoch.tenantId,b.tenantId)).orderBy(asc(systemLabelCriteriaEpoch.labelKind));observedEpochChange=JSON.stringify(currentEpoch)!==JSON.stringify(beforeEpoch);throw error;
   }
  },options);
  const spy=vi.spyOn(tenantClient,'withTenant').mockImplementation(intercepted);
  try{const preview=await ready(text);expect(preview.valid).toBe(1);expect(observedChainRows).toBeGreaterThan(0);expect(observedEpochChange).toBe(true);expect(await state(id)).toEqual(before);expect(await epochs()).toEqual(beforeEpoch);}finally{spy.mockRestore();}
 });
 it('rolls back on an unexpected database refusal during preview, never retaining successful earlier row legs',async()=>{
  const id=await hire(),before=await state(id);const text=csv([['EMP-0004','promotion',day(-5),'','3500',''],['EMP-0004','transfer',day(-2),b.deptB,'','']]);
  await owner.db.execute(sql`create function public.b20_movement_preview_refusal() returns trigger language plpgsql as $$ begin raise exception 'fixture assignment refusal'; end $$`);
  await owner.db.execute(sql`create trigger b20_movement_preview_refusal before insert on assignment for each row execute function public.b20_movement_preview_refusal()`);
  try {const preview=await ready(text);expect(preview.employees[0].rows.some(row=>row.status==='invalid')).toBe(true);
   expect(preview.valid).toBe(0);expect(preview.employees[0].rows.find(row=>row.row===2)?.errors).toEqual(['employee_sequence_invalid']);expect(preview.employees[0].rows.find(row=>row.row===3)?.errors).toEqual(['change_refused']);
   for(const row of preview.employees[0].rows.filter(row=>row.status==='invalid'))expect(row.errors.join(' ')).not.toMatch(/insert into|fixture assignment refusal|params:/i);
   expect(await state(id)).toEqual(before);}finally{await owner.db.execute(sql`drop trigger b20_movement_preview_refusal on assignment`);await owner.db.execute(sql`drop function public.b20_movement_preview_refusal()`);}
 });
});
