/** Opt-in index experiment for the disposable hosted database. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {pendingLeaveTaskMetadata} from '../../core/leave';
import {hireEmployee} from '../../core/org';
import {withTenant} from '../../db/client';
import {addDaysIso} from '../../lib/roster-month';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';

const file='test/performance/leave-pending-index.profile.test.ts';
const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selection)&&selection.length===1&&selection[0]===file;
const retainedPerTenant=50_000;
const pendingPerTenant=32;

beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('compares a partial Leave pending header index against the native owner',async()=>{
 const evidenceDir=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(!evidenceDir)throw Error('Focused evidence directory is required');
 const report:Record<string,unknown>={
  kind:'LEAVE_PENDING_HEADER_INDEX_AB_COMPONENT_ONLY',
  releaseEligible:false,
  fixture:{tenants:2,retainedPerTenant,pendingPerTenant},
  limitations:'Synthetic sparse queue and one authorized actor, without concurrent traffic. Write probes measure isolated table DML under application RLS, with RETURNING to verify affected rows. They exclude service workflow, audit and commit latency.',
 };
 const save=()=>writeFileSync(join(evidenceDir,'leave-pending-index.json'),JSON.stringify(report,null,2));
 const date=addDaysIso(todayInKualaLumpur(),-180);
 await resetDb();
 const base=await seedBase();
 const foreign=await seedBase();
 const ctx=adminCtx(base);
 async function seedQueue(b:Base){
  const employee=await hireEmployee(adminCtx(b),{
   person:{fullName:'Fictional retained Leave employee',primaryEmail:`leave-index-${b.tenantId}@example.invalid`},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',
   hiredOn:addDaysIso(date,-365),
  });
  await owner.client`insert into public.leave_request
   (tenant_id,employment_id,leave_type_id,start_date,end_date,days,status)
   select ${b.tenantId}::uuid,${employee.employmentId}::uuid,${b.annualLeaveTypeId}::uuid,
          ${date}::date,${date}::date,1,'rejected'
   from generate_series(1,${retainedPerTenant}::integer)`;
  const rows=await owner.client<{id:string}[]>`insert into public.leave_request
   (tenant_id,employment_id,leave_type_id,start_date,end_date,days,status,created_at)
   select ${b.tenantId}::uuid,${employee.employmentId}::uuid,${b.annualLeaveTypeId}::uuid,
          ${date}::date,${date}::date,1,'pending',
          ${date}::date+make_interval(secs=>n)
   from generate_series(1,${pendingPerTenant}::integer)n returning id`;
  return {employee,ids:rows.map(row=>row.id)};
 }
 const own=await seedQueue(base);
 const other=await seedQueue(foreign);
 const counts=await owner.client<{total:number;pending:number}[]>`select count(*)::int as total,
  count(*) filter(where status='pending')::int as pending from public.leave_request`;
 expect(counts[0]).toEqual({total:2*(retainedPerTenant+pendingPerTenant),pending:2*pendingPerTenant});
 await owner.client`analyze public.leave_request`;
 report.counts=counts[0];
 const phases:unknown[]=[],writes:unknown[]=[];
 report.writes=writes;
 const read=()=>pendingLeaveTaskMetadata(ctx,[base.companyId,foreign.companyId]);
 let reference:Awaited<ReturnType<typeof read>>|undefined;
 async function measure(phase:string){
  const {role,plan}=await withTenant(ctx,async tx=>{
   const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);
   // This is the exact header selection in the native pending task owner's CTE.
   const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json)
    select q.id,q.employment_id,q.created_at from public.leave_request q
    where q.tenant_id=${ctx.tenantId}::uuid and q.status='pending'`));
   return {role:identity.role,plan};
  });
  expect(role).toBe('ai_hr_app');
  const samplesMs:number[]=[];
  for(let iteration=0;iteration<5;iteration++){
   const started=performance.now();
   const rows=await read();
   samplesMs.push(performance.now()-started);
   expect(rows).toHaveLength(pendingPerTenant);
   expect(new Set(rows.map(row=>row.id))).toEqual(new Set(own.ids));
   expect(rows.every(row=>row.employmentId===own.employee.employmentId&&!other.ids.includes(row.id))).toBe(true);
   reference??=rows;
   expect(rows).toEqual(reference);
  }
  phases.push({phase,samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2],plan});
  report.phases=phases;
  save();
 }
 const createCandidateIndex=()=>owner.client`create index performance_leave_pending_header_ab on public.leave_request
  (tenant_id,employment_id) include (id,created_at) where status='pending'`;
 const dropCandidateIndex=()=>owner.client`drop index public.performance_leave_pending_header_ab`;
 await measure('baseline');
 const started=performance.now();
 await createCandidateIndex();
 try{
  report.indexBuildMs=performance.now()-started;
  const [size]=await owner.client<{bytes:number}[]>`select pg_relation_size('public.performance_leave_pending_header_ab')::int as bytes`;
  report.indexBytes=size.bytes;
  await measure('candidate');
  await measure('candidate-repeat');
 }finally{
  await dropCandidateIndex();
 }
 await measure('baseline-repeat');

 const rolledBack=Error('Rollback synthetic Leave write probe');
 const targetIds=sql.join(own.ids.map(id=>sql`${id}::uuid`),sql`, `);
 const target=sql`tenant_id=${base.tenantId}::uuid and status='pending' and id in (${targetIds})`;
 const operations={
  insertPending:sql`insert into public.leave_request
   (tenant_id,employment_id,leave_type_id,start_date,end_date,days,status)
   select ${base.tenantId}::uuid,${own.employee.employmentId}::uuid,${base.annualLeaveTypeId}::uuid,
          ${date}::date,${date}::date,1,'pending'
   from generate_series(1,${pendingPerTenant}::integer) returning id`,
  decidePending:sql`update public.leave_request set status='rejected',decided_at=now()
   where ${target} returning id`,
  deletePending:sql`delete from public.leave_request where ${target} returning id`,
 };
 type WritePlan={
  Plan:{'Actual Rows':number;'WAL Records'?:number;'WAL Bytes'?:number};
  'Execution Time':number;
 };
 async function measureWrites(phase:string){
  for(const [operation,query] of Object.entries(operations)){
   try{
    await withTenant(ctx,async tx=>{
     const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);
     expect(identity.role).toBe('ai_hr_app');
     const started=performance.now();
     const [row]=await tx.execute<{'QUERY PLAN':WritePlan[]}>(sql`explain(analyze,buffers,wal,format json) ${query}`);
     const elapsedMs=performance.now()-started;
     const [plan]=row['QUERY PLAN'];
     expect(plan.Plan['Actual Rows']).toBe(pendingPerTenant);
     writes.push({phase,operation,elapsedMs,executionMs:plan['Execution Time'],role:identity.role,
      walRecords:plan.Plan['WAL Records']??0,walBytes:plan.Plan['WAL Bytes']??0,plan});
     throw rolledBack;
    });
   }catch(error){if(error!==rolledBack)throw error;}
   save();
  }
 }
 // Separate write rounds leave the original read comparison free of rolled-back tuple versions.
 await measureWrites('baseline');
 await createCandidateIndex();
 try{
  await measureWrites('candidate');
  await measureWrites('candidate-repeat');
 }finally{
  await dropCandidateIndex();
 }
 await measureWrites('baseline-repeat');
 const [remaining]=await owner.client<{total:number;pending:number}[]>`select count(*)::int as total,
  count(*) filter(where status='pending')::int as pending from public.leave_request`;
 expect(remaining).toEqual(counts[0]);
 expect((await read()).map(row=>row.id)).toEqual(reference?.map(row=>row.id));
 report.writeProbesRolledBack=true;
 save();
},180_000);
