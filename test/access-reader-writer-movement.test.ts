/**
 * Reader/writer Access lock, movement wave (ADR 0181 write side). Real PostgreSQL through the repository harness.
 *
 * A New Event save used to take the EXCLUSIVE Access lock with no bound as its first lock, so it waited for every
 * shared holder in the tenant and then blocked them all (production 24 November 2026: Save movement up to 7.4 s,
 * Direct Superior movement up to 8.1 s). createMovementEventSharedTx now takes the shared lock first for every
 * comparison kind except Entity Transfer and the Contract posting kind. Observed here:
 * - strict mode: every shared kind (built-in and a tenant's own event type, today and backdated, every leg) finishes
 *   holding only the SHARED Access lock with app.access_lock_strict and AIHR_ACCESS_LOCK_STRICT on, so nothing on
 *   its path (TypeScript or SQL) asked for the exclusive lock;
 * - liveness: a shared save completes while another session holds the shared lock; an exclusive kind still waits;
 * - outcome: the same movement on twin employees, once through the previous exclusive path and once through the
 *   shared path, leaves the same assignment, grade, salary, reporting line and movement history.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq,isNull,sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {createMovementEvent,createMovementEventSharedTx,createMovementEventTx,movementHistory,MOVEMENT_EXCLUSIVE_ACCESS_KINDS} from '../core/movement';
import {hireEmployee,setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;let raw:postgres.Sql;let strictBefore:string|undefined;
beforeAll(async()=>{
 await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:8,onnotice:()=>{}});
 strictBefore=process.env.AIHR_ACCESS_LOCK_STRICT;process.env.AIHR_ACCESS_LOCK_STRICT='on';
});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{
 if(strictBefore===undefined)delete process.env.AIHR_ACCESS_LOCK_STRICT;else process.env.AIHR_ACCESS_LOCK_STRICT=strictBefore;
 await raw.end({timeout:5});await closeAll();
});

const today=()=>todayInKualaLumpur();
const lockKey=(tenantId:string)=>`hashtextextended('access-configuration:${tenantId}',0)`;
async function hire(label:string){
 const h=await hireEmployee(adminCtx(b),{person:{fullName:`Fictional ${label}`,primaryEmail:`mv-${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-06'});
 await setCompensation(adminCtx(b),{employmentId:h.employmentId,basicSalary:4000,effectiveFrom:'2025-01-06'});
 return h;
}
async function grade(code:string){
 const [g]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code,name:'Fictional grade '+code}).returning({id:s.jobGrade.id});
 return g.id;
}
/** The shared path in one transaction with strict mode on: the Access mode held when it finishes. */
async function strict(ctx:SessionContext,input:Parameters<typeof createMovementEventTx>[2]){
 return withTenant(ctx,async tx=>{
  await tx.execute(dsql`select set_config('app.access_lock_strict','on',true)`);
  await createMovementEventSharedTx(tx,ctx,input);
  const [row]=await tx.execute<{mode:string|null}>(dsql`select app.access_lock_mode_held(${ctx.tenantId}::uuid) as mode`);
  return row?.mode??null;
 });
}
async function sharedHolder(){
 let release!:()=>void;const released=new Promise<void>(r=>{release=r;});let held!:()=>void;const holding=new Promise<void>(r=>{held=r;});
 const done=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held();await released;});
 await holding;
 return {release:async()=>{release();await done;}};
}

describe('strict mode: every shared movement kind holds only the shared Access lock',()=>{
 it('covers each leg, today and backdated, and a tenant event type',async()=>{
  const ctx=adminCtx(b);
  const manager=await hire('manager'),second=await hire('second manager');
  const g1=await grade('G1');
  // A tenant's own event type carrying Transfer behaviour (written as the storage owner; the catalogue editor is not under test).
  await owner.db.insert(s.movementEventType).values({tenantId:b.tenantId,code:'FICTIONAL_MOVE',behaviourKind:'transfer',label:'Fictional internal move'});
  const cases:[string,(id:string)=>Parameters<typeof createMovementEventTx>[2]][]=[
   ['reporting line today',id=>({employmentId:id,kind:'reportingLineChange',effectiveDate:today(),managerEmploymentId:manager.employmentId,remarks:'Fictional'})],
   ['reporting line backdated',id=>({employmentId:id,kind:'reportingLineChange',effectiveDate:'2026-06-01',managerEmploymentId:second.employmentId,remarks:'Fictional'})],
   ['transfer: department and salary today',id=>({employmentId:id,kind:'transfer',effectiveDate:today(),departmentId:b.deptB,basicSalary:4500,remarks:'Fictional'})],
   ['transfer: department and salary backdated',id=>({employmentId:id,kind:'transfer',effectiveDate:'2026-07-01',departmentId:b.deptB,basicSalary:4400,remarks:'Fictional'})],
   ['promotion: grade and salary',id=>({employmentId:id,kind:'promotion',effectiveDate:today(),gradeId:g1,basicSalary:5000,remarks:'Fictional'})],
   ['increment',id=>({employmentId:id,kind:'increment',effectiveDate:today(),basicSalary:4200,remarks:'Fictional'})],
   ['salary adjustment backdated',id=>({employmentId:id,kind:'salaryAdjustment',effectiveDate:'2026-05-01',basicSalary:4100,remarks:'Fictional'})],
   ['organisation assignment',id=>({employmentId:id,kind:'orgAssignmentChange',effectiveDate:today(),departmentId:b.deptB,remarks:'Fictional'})],
   ['employment type',id=>({employmentId:id,kind:'employmentTypeChange',effectiveDate:today(),employmentType:'part_time',remarks:'Fictional'})],
   ['confirmation',id=>({employmentId:id,kind:'confirmation',effectiveDate:today(),remarks:'Fictional'})],
  ];
  const seen:Record<string,string|null>={};
  for(const[label,input]of cases){const e=await hire(label);seen[label]=await strict(ctx,input(e.employmentId));}
  expect(seen).toEqual(Object.fromEntries(cases.map(([label])=>[label,'S'])));
  // A tenant's own event type mapped onto Transfer is shared too (it can only resolve to an interchangeable kind).
  const custom=await hire('custom');
  expect(await strict(ctx,{employmentId:custom.employmentId,kind:'FICTIONAL_MOVE',effectiveDate:today(),departmentId:b.deptB,remarks:'Fictional'})).toBe('S');
 },240_000);

 it('keeps the exclusive lock for the kinds that change the company or end or create an employment',()=>{
  for(const kind of ['entityTransfer','termination','resignation','blacklist','rehire','historicalHire','contractRenewal','secondment','actingPosition','probationExtension','joinDateChange','groupJoinDateCorrection'])
   expect(MOVEMENT_EXCLUSIVE_ACCESS_KINDS.has(kind),kind).toBe(true);
  for(const kind of ['transfer','promotion','demotion','increment','salaryAdjustment','orgAssignmentChange','employmentTypeChange','reportingLineChange','confirmation'])
   expect(MOVEMENT_EXCLUSIVE_ACCESS_KINDS.has(kind),kind).toBe(false);
 });
});

describe('liveness: a movement save no longer waits for shared holders',()=>{
 const within=<T>(ms:number,label:string,work:Promise<T>)=>Promise.race([work,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error(`${label} did not finish within ${ms} ms`)),ms))]);
 it('completes while another session holds the shared Access lock',async()=>{
  const ctx=adminCtx(b);const e=await hire('live'),m=await hire('live manager');
  const holder=await sharedHolder();
  try{
   const started=performance.now();
   await within(4000,'shared Direct Superior movement',createMovementEvent(ctx,{employmentId:e.employmentId,kind:'reportingLineChange',effectiveDate:today(),managerEmploymentId:m.employmentId,remarks:'Fictional'}));
   console.log(`[access-reader-writer-movement] shared save beside a shared holder: ${Math.round(performance.now()-started)} ms`);
  }finally{await holder.release();}
 },60_000);
 it('an exclusive kind still waits for the shared holder',async()=>{
  const ctx=adminCtx(b);const e=await hire('exclusive');
  const [other]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional Other Sdn Bhd') returning id`;
  const [dept]=await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name) values(${b.tenantId}::uuid,${other.id}::uuid,'Fictional') returning id`;
  const holder=await sharedHolder();let finished=false;
  const exclusive=createMovementEvent(ctx,{employmentId:e.employmentId,kind:'entityTransfer',effectiveDate:today(),companyId:other.id,departmentId:dept.id,managerEmploymentId:null,remarks:'Fictional'})
   .then(()=>'saved',(error:Error)=>'refused: '+error.message).finally(()=>{finished=true;});
  await new Promise(r=>setTimeout(r,800));
  expect(finished).toBe(false);
  await holder.release();
  const outcome=await within(20000,'exclusive Entity Transfer after release',exclusive);
  console.log(`[access-reader-writer-movement] exclusive kind after the holder released: ${outcome}`);
 },60_000);
});

describe('outcome: the shared path writes what the exclusive path wrote',()=>{
 it('leaves the same records for twin employees',async()=>{
  const ctx=adminCtx(b);const m=await hire('twin manager');const g=await grade('G2');
  const snapshot=async(id:string)=>({
   assignment:(await owner.db.select({department:s.assignment.departmentId,from:s.assignment.validFrom,to:s.assignment.validTo}).from(s.assignment).where(and(eq(s.assignment.employmentId,id),isNull(s.assignment.supersededAt))).orderBy(asc(s.assignment.validFrom))),
   salary:(await owner.db.select({basic:s.compensation.basicSalary,from:s.compensation.validFrom,to:s.compensation.validTo}).from(s.compensation).where(and(eq(s.compensation.employmentId,id),isNull(s.compensation.supersededAt))).orderBy(asc(s.compensation.validFrom))),
   lines:(await owner.db.select({manager:s.reportingLine.managerEmploymentId,from:s.reportingLine.validFrom,to:s.reportingLine.validTo}).from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,id),isNull(s.reportingLine.supersededAt))).orderBy(asc(s.reportingLine.validFrom))),
   grade:(await owner.db.select({grade:s.employment.gradeId}).from(s.employment).where(eq(s.employment.id,id)))[0],
   history:(await movementHistory(ctx,id)).map(row=>({kind:row.kind,effectiveDate:row.effectiveDate})),
  });
  const inputs=(id:string):Parameters<typeof createMovementEventTx>[2][]=>[
   {employmentId:id,kind:'transfer',effectiveDate:'2026-07-01',departmentId:b.deptB,basicSalary:4400,remarks:'Fictional'},
   {employmentId:id,kind:'reportingLineChange',effectiveDate:'2026-06-01',managerEmploymentId:m.employmentId,remarks:'Fictional'},
   {employmentId:id,kind:'promotion',effectiveDate:today(),gradeId:g,basicSalary:5000,remarks:'Fictional'},
  ];
  const before=await hire('twin before'),after=await hire('twin after');
  for(const input of inputs(before.employmentId))await withTenant(ctx,tx=>createMovementEventTx(tx,ctx,input));
  for(const input of inputs(after.employmentId))await createMovementEvent(ctx,input);
  expect(await snapshot(after.employmentId)).toEqual(await snapshot(before.employmentId));
  expect((await snapshot(after.employmentId)).history.length).toBeGreaterThanOrEqual(3);
 },120_000);
});
void setReportingLine;void ({} as Tx);
