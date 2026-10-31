/** Real Server Actions and app-role transactions; only session/cache adapters are replaced. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import type {EmployeeDraftData} from '../lib/employee-draft-schema';
const actor=vi.hoisted(()=>({ctx:null as SessionContext|null}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>{if(!actor.ctx)throw new Error('Missing real fixture actor');return actor.ctx;}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
import {createEmployeeAction} from '../app/(app)/admin/personnel/new/actions';
import {createEmployeeDraftWithReservedCode,getEmployeeDraft} from '../core/employee-draft';
import {createConfig} from '../core/employee-id-config';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();actor.ctx=adminCtx(b);});
function input(name:string):EmployeeDraftData{return {
 profile:{fullName:name,primaryEmail:randomUUID()+'@draft-action.test',preferredName:name+' preferred',phone:'001234',gender:'female',dateOfBirth:'1990-04-05',permanentPostcode:'00120'},
 employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-03-01'},
 statutory:{bankName:'Fictional Bank',bankAccountNo:'000123',childReliefMode:'auto',subjectToHrdf:'no'},
 payroll:{basicSalary:'3000',paymentMethod:'bank_transfer'},
 family:[{fullName:'Fictional Child',relationship:'child',dateOfBirth:'2018-03-04',childTaxRelief:true,childReliefCategory:'under_18',childReliefPercentage:'100'}],
};}
async function held(){await createConfig(actor.ctx!,{companyId:b.companyId,prefix:'ACTION',startNumber:7,numberLength:5,increment:1,allowManualOverride:true});return createEmployeeDraftWithReservedCode(actor.ctx!,{companyId:b.companyId,fullName:'Initial saved name',primaryEmail:randomUUID()+'@draft-action.test'});}
async function business(){const out:Record<string,unknown>={};for(const table of ['person','employment','assignment','reporting_line','employee_statutory_my','employment_tax_selection_my','compensation','employee_dependent','leave_ledger','employee_id_config','tenant_counter','performance_assessment_reminder_epoch']){const [row]=await owner.client.unsafe<{rows:unknown}[]>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from ${table} t where tenant_id=$1`,[b.tenantId]);out[table]=row.rows;}out.events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),sql`${s.domainEvent.aggregateType}<>'employee-draft'`)).orderBy(asc(s.domainEvent.id));return out;}
async function waitForDraftWaiters(count:number,blockerPid:number){
 for(let i=0;i<500;i++){
  // Observe the actual blocking graph: the first action waits for the held Draft row, and the
  // second may wait at the earlier access barrier owned by that first action. Both serialize.
  const [row]=await owner.db.execute(sql`WITH RECURSIVE blocked(pid) AS (
   SELECT a.pid FROM pg_stat_activity a WHERE a.datname=current_database() AND ${blockerPid}::int=ANY(pg_blocking_pids(a.pid))
   UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
  ) SELECT count(DISTINCT a.pid)::int n FROM blocked b JOIN pg_stat_activity a ON a.pid=b.pid WHERE a.usename='ai_hr_app' AND a.wait_event_type='Lock'`) as unknown as {n:number}[];
  if(row.n>=count)return;await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error('Actual action blocking graph was not observed');
}

describe('Draft action exact-payload activation',()=>{
 it('serializes two actual actions with distinct payloads queued on the SAME Draft row',async()=>{
  const draft=await held(),a=input('Caller A exact payload'),bInput=input('Caller B different payload');let release!:()=>void,locked!:()=>void,blockerPid=0;
  const blockerReady=new Promise<void>(resolve=>locked=resolve),unblock=new Promise<void>(resolve=>release=resolve);
  const blocker=owner.db.transaction(async tx=>{const [backend]=await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[];blockerPid=backend.pid;await tx.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,draft.id)).for('update');locked();await unblock;});await blockerReady;
  let first:ReturnType<typeof createEmployeeAction>|undefined,second:ReturnType<typeof createEmployeeAction>|undefined;
  let queueFailure:unknown;
  try{first=createEmployeeAction(draft.id,a,4);await waitForDraftWaiters(1,blockerPid);second=createEmployeeAction(draft.id,bInput,4);await waitForDraftWaiters(2,blockerPid);}catch(error){queueFailure=error;}finally{release();await blocker;}
  if(queueFailure){await Promise.allSettled([first,second].filter((p):p is ReturnType<typeof createEmployeeAction>=>!!p));throw queueFailure;}
  if(!first||!second)throw new Error('Both real actions must have reached the database lock');
  const [aResult,bResult]=await Promise.all([first,second]);expect(aResult.ok).toBe(true);expect(bResult).toEqual({ok:false,kind:'validation',code:'draft_unavailable',fields:[]});
  if(!aResult.ok)throw new Error('Expected first action success');const [emp]=await owner.db.select().from(s.employment).where(eq(s.employment.id,aResult.employmentId)),[person]=await owner.db.select().from(s.person).where(eq(s.person.id,emp.personId));
  expect(person).toMatchObject({fullName:a.profile!.fullName,primaryEmail:a.profile!.primaryEmail,preferredName:a.profile!.preferredName});expect(emp.employeeCode).toBe(draft.employeeCode);
  expect(await owner.db.select().from(s.employment).where(eq(s.employment.tenantId,b.tenantId))).toHaveLength(1);expect(await getEmployeeDraft(actor.ctx!,draft.id)).toBeNull();
 },60000);
 it('commits attempted Draft input but rolls back all business owners after a late SQL/audit failure',async()=>{
  const draft=await held(),attempt=input('Attempted input survives reopen'),before=await business();
  await owner.client.unsafe("create function public.board16_draft_action_fail() returns trigger language plpgsql as $$begin if new.event_type='employee-draft.completed' then raise exception 'private bank 000123 failure' using errcode='23514';end if;return new;end$$");
  await owner.client.unsafe('create trigger board16_draft_action_fail before insert on domain_event for each row execute function public.board16_draft_action_fail()');
  const logger=vi.spyOn(console,'error').mockImplementation(()=>{});try{
   const result=await createEmployeeAction(draft.id,attempt,4);expect(result).toMatchObject({ok:false,kind:'system',reference:expect.stringMatching(/^DRAFT-[0-9A-F]{8}$/)});expect(JSON.stringify(result)).not.toContain('000123');
   const reopened=await getEmployeeDraft(actor.ctx!,draft.id);expect(reopened).toMatchObject({id:draft.id,reservedEmployeeCode:draft.employeeCode,currentStep:4});expect(reopened!.data).toEqual({...attempt,profile:{...attempt.profile,employeeCode:draft.employeeCode},employment:{...attempt.employment,companyId:b.companyId}});expect(await business()).toEqual(before);
  }finally{logger.mockRestore();await owner.client.unsafe('drop trigger board16_draft_action_fail on domain_event');await owner.client.unsafe('drop function public.board16_draft_action_fail()');}
  const retry=await createEmployeeAction(draft.id,attempt,4);expect(retry.ok).toBe(true);expect(await getEmployeeDraft(actor.ctx!,draft.id)).toBeNull();
 });
 it('retains the exact attempted fields and held ID on typed validation failure',async()=>{
  const draft=await held(),attempt=input('Invalid saved attempt');attempt.employment!.departmentId='';const before=await business();
  const result=await createEmployeeAction(draft.id,attempt,2);expect(result).toMatchObject({ok:false,kind:'validation',code:'required_fields',fields:expect.arrayContaining([{tab:'job',field:'department'}])});
  const reopened=await getEmployeeDraft(actor.ctx!,draft.id);expect(reopened).toMatchObject({id:draft.id,reservedEmployeeCode:draft.employeeCode,currentStep:2});expect(reopened!.data.profile).toMatchObject(attempt.profile!);expect(reopened!.data.employment?.departmentId).toBe('');expect(await business()).toEqual(before);
 });
});
