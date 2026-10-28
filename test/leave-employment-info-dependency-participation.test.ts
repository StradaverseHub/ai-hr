/** Authored UNRUN: actual app-role writers, protected intervals and immutable command inputs. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as tenantDb from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import * as commands from '../core/workforce-commands';
import {completeEmployeeDraft,createEmployeeDraftWithReservedCode,saveEmployeeDraft,saveAndCompleteEmployeeDraft} from '../core/employee-draft';
import {createConfig} from '../core/employee-id-config';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx} from '../core/leave-dependency-lock';
import {hasExitDateAuthorityTx,withExitDateAuthorityTx} from '../core/exit-date-authority';
import type {EmployeeDraftData} from '../lib/employee-draft-schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const hire=()=>hireEmployee(group(),{person:{fullName:'Fictional Info Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
async function state(){const result:Record<string,unknown>={};for(const table of ['person','employment','assignment','reporting_line','employee_statutory_my','employment_tax_selection_my','compensation','employee_dependent','leave_ledger','employee_draft','employee_id_config','tenant_counter','domain_event','performance_assessment_reminder_epoch']){const [row]=await owner.client.unsafe<{rows:unknown}[]>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${table} t where tenant_id=$1`,[b.tenantId]);result[table]=row.rows;}return result;}
async function held(id?:string){let ready!:()=>void,failed!:(e:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),done=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{failed(Error('owned info interval timed out'));release();},10000);const pending=withTenant(group(),async tx=>{if(id)await lockLeaveDependenciesTx(tx,b.tenantId,[id]);else await lockLeaveDependencyReadConfigurationTx(tx,b.tenantId);ready();await done;});void pending.catch(failed);await started;return{async close(){release();clearTimeout(timer);await pending;}};}
describe('employment information owns its earlier source interval',()=>{
 it.each(['direct-config','direct-employee','caller-tx','wrapper'] as const)('%s refuses without effects, then applies the exact request after release',async mode=>{
  const a=await hire(),input={employmentId:a.employmentId,confirmationDate:'2020-04-01'},ctx=group();
  const invoke=()=>mode==='caller-tx'?withTenant(ctx,tx=>setEmploymentInfo(ctx,input,tx)):mode==='wrapper'?commands.setEmploymentInfo(ctx,input):setEmploymentInfo(ctx,input);
  const before=await state(),holder=await held(mode==='direct-config'?undefined:a.employmentId);
  try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  await invoke();const after=await state();const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,a.employmentId));expect(emp.confirmationDate).toBe('2020-04-01');
  const oldIds=new Set((before.domain_event as {id:string}[]).map(e=>e.id));const added=(after.domain_event as {id:string;event_type:string;aggregate_id:string}[]).filter(e=>!oldIds.has(e.id));expect(added).toHaveLength(1);expect(added[0]).toMatchObject({event_type:'employment.info.updated',aggregate_id:a.employmentId});
  // The canonical owner audits supplied fields even when equal; no invented no-op contract.
  await invoke();const repeated=await state();expect((repeated.employment as unknown[])).toEqual(after.employment);expect((repeated.leave_ledger as unknown[])).toEqual(after.leave_ledger);expect((repeated.domain_event as unknown[])).toHaveLength((after.domain_event as unknown[]).length+1);
 });
 it('captures wrapper context and nested movement before asynchronous Workforce admission',async()=>{
  const a=await hire(),ctx=group(),input={employmentId:a.employmentId,confirmationDate:'2020-04-01',movement:{type:'confirmation',groupId:randomUUID()}};
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),pause=new Promise<void>(yes=>{release=yes;});const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{entered();await pause;return actual(c,fn);});
  const pending=commands.setEmploymentInfo(ctx,input);
  try{await ready;input.employmentId=randomUUID();input.confirmationDate='2024-01-01';input.movement.type='retargeted';ctx.userId=randomUUID();ctx.grants![0].role='employee';ctx.roles!.splice(0,ctx.roles!.length,'employee');release();await pending;}finally{release();await pending.catch(()=>{});boundary.mockRestore();}
  const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,a.employmentId));expect(emp.confirmationDate).toBe('2020-04-01');const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,a.employmentId));expect(JSON.stringify(events)).not.toContain('retargeted');
 });
 it('retains actual transaction identity for exit-date authority, never a posted movement grant',async()=>{
  const a=await hire();await withTenant(group(),async tx=>{
   await expect(setEmploymentInfo(group(),{employmentId:a.employmentId,resignationDate:'2026-10-01',movement:{type:'resignation',groupId:randomUUID()}},tx)).rejects.toThrow('Nothing to change');
   await withExitDateAuthorityTx(tx,a.employmentId,async()=>{expect(hasExitDateAuthorityTx(tx,a.employmentId)).toBe(true);expect(hasExitDateAuthorityTx({...tx} as typeof tx,a.employmentId)).toBe(false);await setEmploymentInfo(group(),{employmentId:a.employmentId,resignationDate:'2026-10-01',movement:{type:'resignation',groupId:randomUUID()}},tx);});expect(hasExitDateAuthorityTx(tx,a.employmentId)).toBe(false);
  });const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,a.employmentId));expect(emp.resignationDate).toBe('2026-10-01');
 });
});
function draftData():EmployeeDraftData{return{profile:{fullName:'Fictional Draft Interval',primaryEmail:randomUUID()+'@fixture.test',preferredName:'Draft',gender:'female',dateOfBirth:'1990-04-05',phone:'00123456789',permanentPostcode:'00120'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-03-01'},statutory:{bankName:'Test Bank',bankAccountNo:'0000123456',subjectToHrdf:'no',childReliefMode:'auto'},payroll:{basicSalary:'3000',paymentMethod:'bank_transfer'}};}
describe('Draft activation owns configuration outside the savepoint',()=>{
 it.each(['complete','save-and-complete'] as const)('%s refuses before Draft changes and activates only after release',async mode=>{
  const ctx=group(),data=draftData();await createConfig(ctx,{companyId:b.companyId,prefix:'INF',startNumber:7,numberLength:5,increment:1,allowManualOverride:true});const draft=await createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:data.profile!.fullName!,primaryEmail:data.profile!.primaryEmail!});await saveEmployeeDraft(ctx,{id:draft.id,data,currentStep:6});
  const changed=structuredClone(data);changed.profile!.preferredName='Saved Candidate';const invoke=()=>mode==='complete'?completeEmployeeDraft(ctx,draft.id):saveAndCompleteEmployeeDraft(ctx,{id:draft.id,data:changed,currentStep:6});
  const before=await state(),holder=await held();try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  const result=await invoke();const [emp]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,result.employmentId));expect(emp.employeeCode).toBe(draft.employeeCode);expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,draft.id))).toEqual([]);
  const completed=await state();await expect(completeEmployeeDraft(ctx,draft.id)).rejects.toThrow();expect(await state()).toEqual(completed);
 });
 it('preserves the saved Draft but rolls back activation on a late savepoint fault, then retries the same Draft',async()=>{
  const ctx=group(),data=draftData();await createConfig(ctx,{companyId:b.companyId,prefix:'INF',startNumber:7,numberLength:5,increment:1,allowManualOverride:true});const draft=await createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:data.profile!.fullName!,primaryEmail:data.profile!.primaryEmail!});await saveEmployeeDraft(ctx,{id:draft.id,data,currentStep:6});const before=await state();
  const changed=structuredClone(data);changed.profile!.preferredName='Saved after failed activation';
  await owner.client.unsafe("create function public.info_activation_fault() returns trigger language plpgsql as $$begin if new.event_type='employee-draft.completed' then raise exception 'owned late activation fault' using errcode='23514'; end if; return new; end$$");
  try{await owner.client.unsafe('create trigger info_activation_fault before insert on domain_event for each row execute function public.info_activation_fault()');await expect(saveAndCompleteEmployeeDraft(ctx,{id:draft.id,data:changed,currentStep:6})).rejects.toThrow();}
  finally{await owner.client.unsafe('drop trigger if exists info_activation_fault on domain_event');await owner.client.unsafe('drop function if exists public.info_activation_fault()');}
  const failed=await state();for(const key of ['person','employment','assignment','reporting_line','employee_statutory_my','employment_tax_selection_my','compensation','employee_dependent','leave_ledger'])expect(failed[key]).toEqual(before[key]);
  const oldEventIds=new Set((before.domain_event as {id:string}[]).map(row=>row.id));const newEvents=(failed.domain_event as {id:string;event_type:string}[]).filter(row=>!oldEventIds.has(row.id));expect(newEvents).toHaveLength(1);expect(newEvents[0].event_type).toBe('employee-draft.updated');
  const [saved]=await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,draft.id));expect((saved.data as EmployeeDraftData).profile?.preferredName).toBe('Saved after failed activation');
  const result=await completeEmployeeDraft(ctx,draft.id);expect(result.employmentId).toBeTruthy();
 });

});
