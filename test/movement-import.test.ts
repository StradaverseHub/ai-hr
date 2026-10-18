import {randomUUID} from 'node:crypto';
import {asc,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {assignment,compensation,domainEvent,employment,leaveLedger,leaveEntitlementRecalcAudit} from '../db/schema';
import {hireEmployee} from '../core/org';
import {withTenant} from '../db/client';
import {createCompany,createDepartment} from '../core/admin';
import {setLabelCriteriaBatch} from '../core/system-labels';
import {createMovementEvent,movementCurrentState,movementHistory,reverseMovementEvent,applyDueMovementsTx} from '../core/movement';
import {previewMovementImport,commitMovementImport,movementImportCatalog} from '../core/movement-import';
import {saveMovementEventType,setMovementEventTypeActive} from '../core/movement-type';
import * as leaveService from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';
import type {MovementImportPreview} from '../lib/movement-import-contract';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function hire(code='EMP-0004'){
 const result=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Movement '+code,primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60),employeeCode:code});return result.employmentId;
}
const csv=(rows:(string|number)[][])=>toCsv([['employee_code','event_type','effective_date','department_id','basic_salary','remarks'],...rows]);
const fingerprints=(preview:MovementImportPreview)=>Object.fromEntries(preview.employees.filter(employee=>employee.fingerprint).map(employee=>[employee.employeeCode,employee.fingerprint!]));
async function ready(text:string,selection?:number[]){return previewMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection});}
async function commit(text:string,preview:MovementImportPreview,acknowledgeExcluded=true){return commitMovementImport(adminCtx(b),{companyId:b.companyId,csv:text,selection:preview.selection,inputHash:preview.inputHash,fingerprints:fingerprints(preview),acknowledgeExcluded});}
async function state(id:string){return {
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)).orderBy(asc(employment.id)),
 assignments:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 compensation:await owner.db.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
 ledger:await owner.db.select().from(leaveLedger).where(eq(leaveLedger.employmentId,id)).orderBy(asc(leaveLedger.id)),
 audit:await owner.db.select().from(leaveEntitlementRecalcAudit).where(eq(leaveEntitlementRecalcAudit.employmentId,id)).orderBy(asc(leaveEntitlementRecalcAudit.id)),
};}
describe('Movement rollback-only preview and atomic confirmation',()=>{
 it('rehearses effective-date order, excludes an invalid type, and commits only the explicitly rechecked valid sequence',async()=>{
  const id=await hire(),before=await state(id);
  const text=csv([['EMP-0004','transfer',day(-2),b.deptB,'','Later transfer'],['EMP-0004','hired',day(-3),'','','Not creatable'],['EMP-0004','promotion',day(-5),'','3500','Earlier promotion']]);
  const initial=await ready(text);expect(initial.fileErrors).toEqual([]);expect(initial.valid).toBe(2);expect(initial.excluded).toBe(1);
  expect(initial.employees[0].rows.map(row=>row.row)).toEqual([4,3,2]);expect(await state(id)).toEqual(before);
  const preview=await ready(text,[2,4]);expect(preview.valid).toBe(2);expect(preview.employees[0].rows.find(row=>row.row===3)?.status).toBe('excluded');
  await expect(commit(text,preview,false)).rejects.toThrow('confirm_excluded_rows');
  expect((await commit(text,preview)).imported).toBe(2);expect(await movementCurrentState(adminCtx(b),id)).toMatchObject({departmentId:b.deptB,basicSalary:'3500.00'});
  const history=await movementHistory(adminCtx(b),id);expect(history.filter(row=>row.kind==='promotion'||row.kind==='transfer')).toHaveLength(2);
 });
 it('never trusts an excluded predecessor when validating the remaining sequence',async()=>{
  const id=await hire();const text=csv([['EMP-0004','transfer',day(-5),b.deptB,'',''],['EMP-0004','transfer',day(-2),b.deptA,'','']]);
  expect((await ready(text)).valid).toBe(2);
  const selected=await ready(text,[3]);expect(selected.valid).toBe(0);expect(selected.employees[0].rows.find(row=>row.row===3)?.status).toBe('invalid');
  const result=await commit(text,selected);expect(result.imported).toBe(0);expect(result.failed).toBe(1);expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptA);
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
 it('rolls every selected row, compensation, grade/leave/audit back when the second required leave leg refuses',async()=>{
  const id=await hire(),before=await state(id);const text=csv([['EMP-0004','promotion',day(-5),'','3500',''],['EMP-0004','transfer',day(-2),b.deptB,'','']]);const preview=await ready(text);expect(preview.valid).toBe(2);
  const real=leaveService.reprojectEntitlementForEmployment;let calls=0;
  const spy=vi.spyOn(leaveService,'reprojectEntitlementForEmployment').mockImplementation(async(...args)=>{calls++;if(calls===2)throw new Error('fixture_required_leave_refusal');return real(...args);});
  try {const result=await commit(text,preview);expect(result.imported).toBe(0);expect(result.failed).toBe(2);expect(await state(id)).toEqual(before);}finally{spy.mockRestore();}
 });
 it('keeps unrelated employees independent while refusing nonexistent Employee IDs and non-admin callers',async()=>{
  const id=await hire();const text=csv([['EMP-0004','transfer',day(-2),b.deptB,'',''],['MISSING','promotion',day(-1),'','3500','']]);
  const initial=await ready(text);expect(initial.valid).toBe(1);const preview=await ready(text,[2]);const result=await commit(text,preview);expect(result).toMatchObject({imported:1,excluded:1});expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptB);
  await expect(previewMovementImport({...adminCtx(b),roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},{companyId:b.companyId,csv:text})).rejects.toThrow('Only an admin');
 });

 it('validates a future Entity Transfer then a destination-scoped promotion without applying either early',async()=>{
  const id=await hire(),ctx=adminCtx(b);const destination=await createCompany(ctx,{legalName:'Fictional Movement destination',country:'MY'});
  const department=await createDepartment(ctx,{companyId:destination.id,name:'Destination Operations'});
  await setLabelCriteriaBatch(ctx,[{kind:'department',labelId:department.id,isGlobal:false,companyIds:[destination.id]}]);
  const text=toCsv([['employee_code','event_type','effective_date','company_id','department_id','basic_salary'],['EMP-0004','entityTransfer',day(7),destination.id,department.id,''],['EMP-0004','promotion',day(14),'',department.id,'4200']]);
  const before=await state(id);const preview=await ready(text);expect(preview.valid).toBe(2);expect(await state(id)).toEqual(before);
  expect(preview.employees[0].rows[1].before?.companyId).toContain(destination.id);expect(preview.employees[0].rows[1].proposed?.basicSalary).toBe('4200.00');
  const result=await commit(text,preview);expect(result.imported).toBe(2);expect((await movementCurrentState(ctx,id)).companyId).toBe(b.companyId);
  const history=await movementHistory(ctx,id);expect(history.filter(row=>row.scheduled&&row.status==='pending')).toHaveLength(2);
  await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,id,day(14)));
  expect(await movementCurrentState(ctx,id)).toMatchObject({companyId:destination.id,departmentId:department.id,basicSalary:'4200.00'});
 });
 it('refuses pre-hire neutral events and conflicting same-date writes while retaining disjoint same-date changes',async()=>{
  const id=await hire(),before=await state(id);
  expect((await ready(csv([['EMP-0004','secondment',day(-61),'','','Before hire']]))).valid).toBe(0);
  const conflict=csv([['EMP-0004','promotion',day(-2),'','3500',''],['EMP-0004','increment',day(-2),'','3700','']]);const preview=await ready(conflict);expect(preview.valid).toBe(1);expect(preview.employees[0].rows.find(row=>row.row===3)?.errors).toContain('same_date_conflicting_changes');
  expect(await state(id)).toEqual(before);
  const disjoint=csv([['EMP-0004','promotion',day(-2),'','3500',''],['EMP-0004','transfer',day(-2),b.deptB,'','']]);expect((await ready(disjoint)).valid).toBe(2);
 });
 it('refuses a selected ordinary successor after an earlier selected termination, with no retained preview effects',async()=>{
  const id=await hire(),before=await state(id);
  const text=toCsv([['employee_code','event_type','effective_date','end_date','termination_reason_code','remarks'],['EMP-0004','termination',day(-5),day(-5),'contract_expiry','Fictional end'],['EMP-0004','secondment',day(-2),'','','After end']]);
  const preview=await ready(text);expect(preview.valid).toBe(1);expect(preview.employees[0].rows.find(row=>row.row===3)?.errors).toContain('event_after_exit');expect(await state(id)).toEqual(before);
 });
 it('rolls back on an unexpected database refusal during preview, never retaining successful earlier row legs',async()=>{
  const id=await hire(),before=await state(id);const text=csv([['EMP-0004','promotion',day(-5),'','3500',''],['EMP-0004','transfer',day(-2),b.deptB,'','']]);
  await owner.db.execute(sql`create function public.b20_movement_preview_refusal() returns trigger language plpgsql as $$ begin raise exception 'fixture assignment refusal'; end $$`);
  await owner.db.execute(sql`create trigger b20_movement_preview_refusal before insert on assignment for each row execute function public.b20_movement_preview_refusal()`);
  try {const preview=await ready(text);expect(preview.employees[0].rows.some(row=>row.status==='invalid')).toBe(true);expect(await state(id)).toEqual(before);}finally{await owner.db.execute(sql`drop trigger b20_movement_preview_refusal on assignment`);await owner.db.execute(sql`drop function public.b20_movement_preview_refusal()`);}
 });
});
