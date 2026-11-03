/** AI v2 Phase 2, P2-4 — the HR capacity ledger on fictional records (migration 0966, core/capacity/*).
 *
 *  1. Role access: an employee, a manager and an agent are refused before any read; HR and group administrators read
 *     the companies they administer only.
 *  2. Baseline missing: no hours until a baseline exists; the counts still show.
 *  3. Setting a baseline: a new version each time, earlier ones kept; the database refuses an update, a delete, and a
 *     baseline for a company the writer does not administer; invalid minutes are refused.
 *  4. Hours freed from real loop cards: items x the company's minutes - review time (the gap from preparation to
 *     confirmation, capped at 15 minutes and at the item's minutes), written out by hand.
 *  5. Tenant and company isolation, including question counts (group administrators only) and the measure's company
 *     filter (core/process-assessment.ts measureForCompany).
 * Expected values are written out from the fixtures, never re-derived from the ledger's own helpers. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../db/teras-schema';
import {terasCapacityBaseline} from '../db/teras-capacity-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {CapacityRefused,baselineSetup,setCapacityBaseline} from '../core/capacity/baseline';
import {capacityLedger} from '../core/capacity/ledger';
import {measure,measureForCompany} from '../core/process-assessment';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const MIN=60_000,DAY=86_400_000;
let b:Base,group:Login,second:{id:string;dept:string};
type Login=SessionContext&{employmentId:string;personId:string;userId:string};

async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId=base.companyId,departmentId=base.deptA):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 const ctx=await entitledCtx(base,[role]);
 return {...ctx,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
async function companyAdmin(base:Base,companyId:string,departmentId:string):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Company Administrator',primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 const ctx=await entitledCtx(base,['hr_admin']);
 return {...ctx,userId:user.id,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}],employmentId:hired.employmentId};
}

/** A loop card a person completed: prepared `gap` minutes before it was confirmed, confirmed two days ago. */
const closedAt=()=>new Date(Date.now()-2*DAY);
let subjects=0;
/** A distinct calendar day per card, so no two cards share a subject. */
const subjectDay=()=>{const n=subjects++;return `20${10+Math.floor(n/300)}-${String(1+Math.floor(n/28)%12).padStart(2,'0')}-${String(1+n%28).padStart(2,'0')}`;};
async function doneCase(p:Readonly<{companyId:string;employmentId:string|null;worker:'loop_missed_clock_outs'|'loop_payroll_inputs';gapMinutes:number;resolution?:'as_prepared'|'changed'|'completed'}>){
 const closed=closedAt(),opened=new Date(closed.getTime()-p.gapMinutes*MIN);
 const subject=p.worker==='loop_payroll_inputs'?`payroll:${p.companyId}:${subjectDay()}`:`clockout:${p.employmentId}:${subjectDay()}`;
 await owner.db.execute(sql`insert into public.teras_loop_case (tenant_id,worker_id,company_id,employment_id,subject_key,recipient,state,close_reason,resolution,facts,
   first_opened_at,opened_at,checked_at,closed_at,opened_run_id,checked_run_id)
  values (${b.tenantId}::uuid,${p.worker},${p.companyId}::uuid,${p.employmentId}::uuid,${subject},${p.worker==='loop_payroll_inputs'?'payroll':'employee'},'closed','done',
   ${p.resolution??'completed'},'{}'::jsonb,${opened.toISOString()}::timestamptz,${opened.toISOString()}::timestamptz,${closed.toISOString()}::timestamptz,
   ${closed.toISOString()}::timestamptz,${randomUUID()}::uuid,${randomUUID()}::uuid)`);
}
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail','code'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const refusedWith=async(promise:Promise<unknown>,pattern:RegExp)=>{let error:unknown=null;try{await promise;}catch(e){error=e;}expect(error,'expected a refusal').not.toBeNull();expect(pgText(error)).toMatch(pattern);};
const setBaseline=(ctx:SessionContext,companyId:string,entered:Record<string,string>,minutesPerStaffAction='')=>setCapacityBaseline(ctx,{companyId,days:90,minutesPerStaffAction,entered});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 group=await login(b,'Fictional Group Administrator','hr_admin');
 const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:co.id,name:'Fictional Ops'}).returning();
 second={id:co.id,dept:dept.id};
});

describe('who may read the ledger',()=>{
 it('refuses an employee, a manager and an agent before any read',async()=>{
  const employee=await login(b,'Fictional Employee','employee');
  const manager=await login(b,'Fictional Manager','manager');
  for(const ctx of [employee,manager,{...group,agent:{principalId:randomUUID(),enablements:[]}} as SessionContext]){
   await expect(capacityLedger(ctx)).rejects.toMatchObject({name:'CapacityRefused',reason:'not_administrator'});
   await expect(baselineSetup(ctx,{companyId:b.companyId,days:90})).rejects.toBeInstanceOf(CapacityRefused);
   await expect(setBaseline(ctx,b.companyId,{loop_payroll_inputs:'240'})).rejects.toMatchObject({reason:'not_administrator'});
  }
  // Nor can an employee read a baseline row directly.
  await setBaseline(group,b.companyId,{loop_payroll_inputs:'240'});
  expect(await withTenant(employee,tx=>tx.select().from(terasCapacityBaseline))).toEqual([]);
 });

 it('shows a company administrator only the companies they administer, even when asked for another',async()=>{
  const scoped=await companyAdmin(b,second.id,second.dept);
  expect((await capacityLedger(group)).companies.map(row=>row.name)).toEqual(['Acme Sdn Bhd','Fictional Second Sdn Bhd']);
  const own=await capacityLedger(scoped,{companyId:b.companyId});
  expect(own.companies.map(row=>row.id)).toEqual([second.id]);
  expect(own.companyId).toBeNull();
  expect(own.ledger.companiesWithoutBaseline).toEqual([second.id]);
  await expect(baselineSetup(scoped,{companyId:b.companyId,days:90})).rejects.toMatchObject({reason:'not_administrator'});
 });
});

describe('the baseline',()=>{
 it('is missing until set: no hours, while the counts still show',async()=>{
  const worker=await login(b,'Fictional Worker','employee');
  await doneCase({companyId:b.companyId,employmentId:worker.employmentId,worker:'loop_missed_clock_outs',gapMinutes:2});
  const view=await capacityLedger(group,{companyId:b.companyId});
  expect(view.baselines).toEqual([]);
  expect(view.ledger.freedMinutes).toBeNull();
  expect(view.ledger.companiesWithoutBaseline).toEqual([b.companyId]);
  expect(view.ledger.loopActions).toEqual({done:1,changed:0});
  expect(view.ledger.rows).toEqual([{item:'loop_missed_clock_outs',done:1,manualMinutes:0,reviewMinutes:0,freedMinutes:0,withoutBaseline:1}]);
 });

 it('records the period and the administrator\'s minutes, and keeps every version',async()=>{
  const setup=await baselineSetup(group,{companyId:b.companyId,days:90});
  // No loop has started here, so the period ends today and runs back 90 days.
  expect(setup.autopilotStart).toBeNull();
  expect(Date.parse(setup.periodTo)-Date.parse(setup.periodFrom)).toBe(90*DAY);
  expect(setup.current).toBeNull();
  expect(await setBaseline(group,b.companyId,{loop_missed_clock_outs:'6',loop_payroll_inputs:'240',questions_answered:''})).toMatchObject({version:1});
  expect(await setBaseline(group,b.companyId,{loop_missed_clock_outs:'5'})).toMatchObject({version:2});
  const rows=await withTenant(group,tx=>tx.select().from(terasCapacityBaseline).orderBy(terasCapacityBaseline.version));
  expect(rows.map(row=>[row.version,row.items,row.setByUserId,row.periodFrom,row.periodTo])).toEqual([
   [1,{loop_missed_clock_outs:{minutes:6,basis:'entered'},loop_payroll_inputs:{minutes:240,basis:'entered'}},group.userId,setup.periodFrom,setup.periodTo],
   [2,{loop_missed_clock_outs:{minutes:5,basis:'entered'}},group.userId,setup.periodFrom,setup.periodTo]]);
  expect((await baselineSetup(group,{companyId:b.companyId,days:30})).current).toMatchObject({version:2});
  // The setting is audited, with numbers and keys only.
  const [event]=await owner.db.execute(sql`select payload from public.domain_event where tenant_id=${b.tenantId}::uuid and event_type='teras-capacity.baseline-set' order by sequence desc limit 1`) as unknown as {payload:Record<string,unknown>}[];
  expect(event.payload).toMatchObject({companyId:b.companyId,version:2,items:{loop_missed_clock_outs:{basis:'entered',minutes:5}}});
 });

 it('is append-only, per company, and refuses invalid or empty minutes',async()=>{
  const scoped=await companyAdmin(b,second.id,second.dept);
  // FORCE row-level security, and exactly read and insert for the application role.
  const [rls]=await owner.db.execute(sql`select relrowsecurity,relforcerowsecurity from pg_class where oid='public.teras_capacity_baseline'::regclass`) as unknown as {relrowsecurity:boolean;relforcerowsecurity:boolean}[];
  expect(rls).toEqual({relrowsecurity:true,relforcerowsecurity:true});
  const grants=await owner.db.execute(sql`select privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='teras_capacity_baseline'
   and grantee='ai_hr_app' order by 1`) as unknown as {privilege_type:string}[];
  expect(Array.from(grants).map(row=>row.privilege_type)).toEqual(['INSERT','SELECT']);
  await setBaseline(group,b.companyId,{loop_payroll_inputs:'240'});
  await refusedWith(withTenant(group,tx=>tx.execute(sql`update public.teras_capacity_baseline set version=9`)),/permission denied|append-only/i);
  await refusedWith(withTenant(group,tx=>tx.execute(sql`delete from public.teras_capacity_baseline`)),/permission denied|append-only/i);
  // Even the owner cannot rewrite a baseline.
  await refusedWith(owner.db.execute(sql`update public.teras_capacity_baseline set version=9`),/append-only/i);
  // A company administrator cannot set another company's baseline, in code or in the database.
  await expect(setBaseline(scoped,b.companyId,{loop_payroll_inputs:'1'})).rejects.toMatchObject({reason:'not_administrator'});
  await refusedWith(withTenant(scoped,tx=>tx.insert(terasCapacityBaseline).values({tenantId:b.tenantId,companyId:b.companyId,version:5,periodFrom:'2026-01-01',periodTo:'2026-02-01',
   items:{loop_payroll_inputs:{minutes:1,basis:'entered'}},setByUserId:scoped.userId})),/row-level security/i);
  // Nor can anyone write a baseline in another person's name.
  await refusedWith(withTenant(group,tx=>tx.insert(terasCapacityBaseline).values({tenantId:b.tenantId,companyId:b.companyId,version:5,periodFrom:'2026-01-01',periodTo:'2026-02-01',
   items:{loop_payroll_inputs:{minutes:1,basis:'entered'}},setByUserId:scoped.userId})),/row-level security/i);
  await expect(setBaseline(group,b.companyId,{loop_payroll_inputs:'-1'})).rejects.toMatchObject({reason:'invalid'});
  await expect(setBaseline(group,b.companyId,{loop_payroll_inputs:'2000'})).rejects.toMatchObject({reason:'invalid'});
  await expect(setBaseline(group,b.companyId,{},'999')).rejects.toMatchObject({reason:'invalid'});
  await expect(setBaseline(group,b.companyId,{})).rejects.toMatchObject({reason:'empty'});
  // A per-staff-action figure alone is not enough while the event log cannot measure anything here.
  await expect(setBaseline(group,b.companyId,{},'3')).rejects.toMatchObject({reason:'empty'});
  expect(await withTenant(group,tx=>tx.select({version:terasCapacityBaseline.version}).from(terasCapacityBaseline))).toEqual([{version:1}]);
 });
});

describe('hours freed from the records',()=>{
 it('subtracts capped review time from items x the company\'s own minutes',async()=>{
  const worker=await login(b,'Fictional Worker','employee');
  // Clock-outs at 6 minutes each: confirmed after 2 minutes (review 2) and after 45 (review capped at 6), one changed.
  await doneCase({companyId:b.companyId,employmentId:worker.employmentId,worker:'loop_missed_clock_outs',gapMinutes:2});
  await doneCase({companyId:b.companyId,employmentId:worker.employmentId,worker:'loop_missed_clock_outs',gapMinutes:45,resolution:'changed'});
  // Payroll inputs at 240 minutes: confirmed after 10 minutes (review 10).
  await doneCase({companyId:b.companyId,employmentId:null,worker:'loop_payroll_inputs',gapMinutes:10});
  await setBaseline(group,b.companyId,{loop_missed_clock_outs:'6',loop_payroll_inputs:'240'});
  const view=await capacityLedger(group,{companyId:b.companyId,period:'last30'});
  // Clock-outs: 12 - (2 + 6) = 4. Payroll inputs: 240 - 10 = 230. Total 234 minutes.
  expect(view.ledger.freedMinutes).toBe(234);
  expect(view.ledger.rows).toEqual([
   {item:'loop_payroll_inputs',done:1,manualMinutes:240,reviewMinutes:10,freedMinutes:230,withoutBaseline:0},
   {item:'loop_missed_clock_outs',done:2,manualMinutes:12,reviewMinutes:8,freedMinutes:4,withoutBaseline:0}]);
  expect(view.ledger.loopActions).toEqual({done:3,changed:1});
  // The month of the confirmations carries the same 234 minutes.
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(closedAt()).slice(0,7);
  expect(view.ledger.months.find(row=>row.month===month)?.freedMinutes).toBe(234);
  expect(view.ledger.months.reduce((sum,row)=>sum+row.freedMinutes,0)).toBe(234);
 });
});

describe('isolation',()=>{
 it('keeps companies and tenants apart, and shows question counts to group administrators only',async()=>{
  const first=await login(b,'Fictional First Worker','employee');
  const other=await login(b,'Fictional Second Worker','employee',second.id,second.dept);
  const scoped=await companyAdmin(b,second.id,second.dept);
  await doneCase({companyId:b.companyId,employmentId:first.employmentId,worker:'loop_missed_clock_outs',gapMinutes:1});
  await doneCase({companyId:second.id,employmentId:other.employmentId,worker:'loop_missed_clock_outs',gapMinutes:1});
  await doneCase({companyId:second.id,employmentId:other.employmentId,worker:'loop_missed_clock_outs',gapMinutes:1});
  // Two answered employee questions in the second company, one in the first.
  for(const [companyId,asker] of [[second.id,other.userId],[second.id,other.userId],[b.companyId,first.userId]] as const){
   const at=closedAt();
   await owner.db.insert(terasOutcomeRecord).values({tenantId:b.tenantId,companyId,runId:randomUUID(),runKind:'turn',startedAt:at,finishedAt:at,authorityKind:'person',
    askedByUserId:asker,agentIdentity:'teras.assistant',reads:[],checks:[],replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
    outcomeKind:'answered',outcome:{},humanInvolvement:'none',notice:'not_applicable'});
  }
  // A prepared action an approver accepted 5 minutes after it was prepared, in the second company.
  const prepared=new Date(closedAt().getTime()-5*MIN);
  const [record]=await owner.db.insert(terasOutcomeRecord).values({tenantId:b.tenantId,companyId:second.id,runId:randomUUID(),runKind:'turn',startedAt:prepared,finishedAt:prepared,
   authorityKind:'person',askedByUserId:scoped.userId,agentIdentity:'worker.approver_recommendation',reads:[],checks:[],
   replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},outcomeKind:'suggested',outcome:{},humanInvolvement:'none',notice:'not_applicable'}).returning();
  await owner.db.insert(terasOutcomeFollowup).values({tenantId:b.tenantId,recordId:record.id,kind:'decision',decision:'accepted',humanInvolvement:'decided',byUserId:scoped.userId,at:closedAt()});
  await setBaseline(group,second.id,{loop_missed_clock_outs:'4',questions_answered:'3',actions_confirmed:'10'});
  const b2=await seedBase();
  const group2=await login(b2,'Fictional Other Tenant Administrator','hr_admin');

  // Group administrator, second company: clock-outs 2 x 4 - (1 + 1) = 6; questions 2 x 3 = 6; the accepted action 10 - 5 = 5.
  const all=await capacityLedger(group,{companyId:second.id});
  expect(all.ledger.freedMinutes).toBe(17);
  expect(all.ledger.questions).toBe(2);
  expect(all.ledger.rows.map(row=>[row.item,row.done,row.freedMinutes])).toEqual([['loop_missed_clock_outs',2,6],['questions_answered',2,6],['actions_confirmed',1,5]]);
  // Every company: the first company's card and question count as done, freeing nothing (no baseline there).
  const both=await capacityLedger(group);
  expect(both.ledger.loopActions.done).toBe(3);
  expect(both.ledger.questions).toBe(3);
  expect(both.ledger.freedMinutes).toBe(17);
  expect(both.ledger.companiesWithoutBaseline).toEqual([b.companyId]);
  // The second company's own administrator: its cards only, and no question or action counts (outcome records are
  // readable across people by group administrators only).
  const own=await capacityLedger(scoped);
  expect(own.ledger.loopActions.done).toBe(2);
  expect(own.ledger.questions).toBeNull();
  expect(own.ledger.rows.map(row=>row.item)).toEqual(['loop_missed_clock_outs']);
  expect(own.ledger.freedMinutes).toBe(6);
  // The other tenant sees none of it, even when asking for this tenant's company.
  const foreign=await capacityLedger(group2,{companyId:second.id});
  expect(foreign.companies.map(row=>row.id)).toEqual([b2.companyId]);
  expect(foreign.ledger.loopActions.done).toBe(0);
  expect(foreign.ledger.questions).toBe(0);
  expect(foreign.baselines).toEqual([]);
  expect(await withTenant(group2,tx=>tx.select().from(terasCapacityBaseline))).toEqual([]);
 });

 it('narrows the event log measure to one company, with the same counting rule',async()=>{
  const first=await login(b,'Fictional First Worker','employee');
  const other=await login(b,'Fictional Second Worker','employee',second.id,second.dept);
  for(const who of [first,first,first,other,other])await owner.db.insert(schema.profileChangeRequest).values({tenantId:b.tenantId,personId:who.personId,
   employmentId:who.employmentId,proposed:{bankName:'Fictional Bank',bankAccountNo:'000111'}} as never);
  const from=new Date(Date.now()-DAY),to=new Date(Date.now()+DAY);
  const [one,two,whole]=await withTenant(group,async tx=>[await measureForCompany(tx,'profile_change',b.companyId,from,to),
   await measureForCompany(tx,'profile_change',second.id,from,to),await measure(tx,'profile_change',from,to)]);
  expect([one.started,two.started,whole.started]).toEqual([3,2,5]);
  expect([one.open,two.open]).toEqual([3,2]);
 });
});
