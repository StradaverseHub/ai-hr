/** ADR 0181 J1 equivalence on the real kernel: real PostgreSQL, real RLS, real claims and leases. A payroll-lane
 * process, an import-lane process and one all-lane process (the default service) run together over one mixed queue.
 * They must give the same job outcomes as one all-lane process alone, never claim a job twice or run one job in two
 * processes at once, keep each company's payroll jobs in order, and run the singleton ticks (Bank and the others)
 * only in the all-lane process. The fixture kinds stand for the payroll and import lanes: each process registers only
 * its lane's handlers and advertises its lane marker, exactly as scripts/bank-import-runner.ts does. */
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {withTenant,type SessionContext} from '../db/client';
import {enqueueBulkJobTx} from '../core/bulk-job';
import {BulkJobWaiting,type BulkJobHandler} from '../core/bulk-job-worker';
import {WORKER_LANES,laneMarker,type WorkerLane} from '../core/bulk-job-lanes';
import {runWorkerLaneIteration,type WorkerSingletonTicks} from '../core/worker-lane-loop';
import {runBankImportTick} from '../core/bank-import-worker';
import {openImportWorkerOwner} from '../db/worker-connection';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const PAY='lane_fixture_payroll',IMP='lane_fixture_import';
type Input={company:string;values:string[]};
let b:Base,ctx:SessionContext;

/** One process's handlers; `label` records which process applied each step. A payroll job of a company waits
 * (BulkJobWaiting, as payroll does) until every earlier job of that company has ended. */
function handlers(label:string,kinds:readonly string[]):BulkJobHandler<{value:string}>[]{
 type Apply=BulkJobHandler<{value:string}>['applyStepTx'];
 const apply=(sleepMs:number):Apply=>async(tx,_ctx,job,step)=>{
  if(step.payload.value==='bad-row')throw new Error('Fixture row refused.');
  const [{started}]=await tx.execute<{started:string}>(sql`select clock_timestamp()::text as started`);
  await tx.execute(sql`select pg_sleep(${sleepMs/1000})`);
  await tx.execute(sql`insert into public.lane_fixture_row(tenant_id,job_id,seq,value,process,started_at,finished_at)
   values(${job.tenant_id}::uuid,${job.id}::uuid,${step.seq},${step.payload.value},${label},${started}::timestamptz,clock_timestamp())`);
  return{counters:{written:1}};
 };
 const steps=(job:{input:unknown})=>{const {values}=job.input as Input;return{steps:values.map((value,i)=>({kind:'item',rowNum:i+1,payload:{value}})),counters:{total:values.length}};};
 const payroll:BulkJobHandler<{value:string}>={kind:PAY,mode:'per-step',chunkBudgetMs:1,maxStepsPerChunk:1,
  async prepare(as,job){
   const {company}=job.input as Input;
   const [earlier]=await withTenant(as,tx=>tx.execute(sql`select 1 from bulk_job where kind=${PAY} and id<>${job.id}::uuid and input->>'company'=${company}
    and (created_at,id)<(${new Date(job.created_at).toISOString()}::timestamptz,${job.id}::uuid) and state not in ('completed','failed','cancelled') limit 1`));
   if(earlier)throw new BulkJobWaiting();
   return steps(job);
  },
  applyStepTx:apply(10)};
 // An import's units are longer: they are what payroll must no longer queue behind.
 const imports:BulkJobHandler<{value:string}>={kind:IMP,mode:'per-step',chunkBudgetMs:1,maxStepsPerChunk:1,async prepare(_as,job){return steps(job);},applyStepTx:apply(40)};
 return [payroll,imports].filter(h=>kinds.includes(h.kind));
}

type Proc={label:string;lanes:readonly WorkerLane[];kinds:readonly string[];workerId:string;owner:postgres.Sql;ticks:Record<keyof WorkerSingletonTicks,number>;iterations:number};
const procs:Proc[]=[];
function proc(label:string,lanes:readonly WorkerLane[],kinds:readonly string[]):Proc{
 const p:Proc={label,lanes,kinds,workerId:randomUUID(),owner:openImportWorkerOwner(process.env.TEST_MIGRATION_DATABASE_URL!),ticks:{bank:0,individual:0,rewardPlans:0,probation:0},iterations:0};
 procs.push(p);return p;
}
/** Runs the processes concurrently until every job has ended and been notified. */
async function runFleet(fleet:Proc[],jobIds:string[]){
 const deadline=Date.now()+50_000;
 const finished=async()=>{const [r]=await owner.client<{open:number}[]>`select count(*)::int as open from bulk_job where id=any(${jobIds}::uuid[]) and (state not in ('completed','failed','cancelled') or notified_at is null)`;return r.open===0;};
 let done=false;
 await Promise.all(fleet.map(async p=>{
  const hs=handlers(p.label,p.kinds);
  const ticks:WorkerSingletonTicks={
   // The real Bank tick (its advisory lock and empty queue), counted; the others are counted only.
   bank:async db=>{p.ticks.bank++;return runBankImportTick(db);},
   individual:async()=>{p.ticks.individual++;return false;},
   rewardPlans:async()=>{p.ticks.rewardPlans++;return false;},
   probation:async()=>{p.ticks.probation++;return false;},
  };
  while(!done){
   if(Date.now()>deadline)throw new Error(`fleet did not finish (${p.label})`);
   const worked=await runWorkerLaneIteration({owner:p.owner,probationOwner:p.lanes.includes('default')?owner:null,lanes:p.lanes,handlers:hs,workerId:p.workerId,ticks});
   p.iterations++;
   if(!worked.bulk){if(await finished())done=true;else await new Promise(resolve=>setTimeout(resolve,20));}
  }
 }));
}
/** Each job's company, recorded at admission: the kernel clears a finished job's input. */
const companyOf=new Map<string,string>();
/** The same mixed queue every time: payroll jobs for two companies (in order) between three long imports. */
async function admitQueue(){
 const ids:string[]=[];
 const admit=async(kind:string,company:string,values:string[])=>{
  const {row}=await withTenant(ctx,tx=>enqueueBulkJobTx(tx,ctx,{kind,input:{company,values},source:{name:'fixture.csv',content:Buffer.from(values.join('\n'))}}));
  ids.push(row.id);companyOf.set(row.id,company);
 };
 await admit(IMP,'-',Array.from({length:6},(_,i)=>`import-1-${i}`));
 await admit(PAY,'A',['a1-1','a1-2','a1-3']);
 await admit(IMP,'-',Array.from({length:6},(_,i)=>`import-2-${i}`));
 await admit(PAY,'B',['b1-1','b1-2']);
 await admit(PAY,'A',['a2-1','a2-2']);
 // The import refuses one row, so the outcomes include a per-step failure.
 await admit(IMP,'-',['import-3-0','bad-row','import-3-2']);
 await admit(PAY,'B',['b2-1']);
 await admit(PAY,'A',['a3-1']);
 return ids;
}
type Outcome={kind:string;state:string;stepsDone:number;counters:unknown;values:string[]};
async function outcomes(ids:string[]):Promise<Outcome[]>{
 const out:Outcome[]=[];
 for(const id of ids){
  const [job]=await owner.client<{kind:string;state:string;steps_done:number;counters:unknown}[]>`select kind,state,steps_done,counters from bulk_job where id=${id}::uuid`;
  const rows=await owner.client<{value:string}[]>`select value from public.lane_fixture_row where job_id=${id}::uuid order by seq`;
  out.push({kind:job.kind,state:job.state,stepsDone:job.steps_done,counters:job.counters,values:rows.map(r=>r.value)});
 }
 return out;
}
let baseline:Outcome[]|null=null;
/** The harness may return timestamps as text; compare instants either way. */
const ms=(value:string|Date)=>new Date(value).getTime();

beforeAll(async()=>{
 await migrateTestDb();
 // A step written twice violates the unique key and fails its job, so a double claim cannot pass unnoticed.
 await owner.client.unsafe(`create table if not exists public.lane_fixture_row(id bigserial primary key,tenant_id uuid not null,job_id uuid not null,seq int not null,
  value text not null,process text not null,started_at timestamptz not null,finished_at timestamptz not null,unique(job_id,seq))`);
 await owner.client.unsafe(`grant select,insert on public.lane_fixture_row to ai_hr_app; grant usage on sequence public.lane_fixture_row_id_seq to ai_hr_app`);
});
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);
 await owner.client`insert into bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner) values(${PAY},null,'none','{"company":"string","values":"array"}'::jsonb,false),
  (${IMP},null,'none','{"company":"string","values":"array"}'::jsonb,false) on conflict(kind) do update set exclusive=excluded.exclusive,input_shape=excluded.input_shape`;
 await owner.client`delete from public.lane_fixture_row`;
});
afterEach(async()=>{
 // Never leave a live lane heartbeat behind: admission in a later file would read it.
 const ids=procs.map(p=>p.workerId);
 await owner.client`delete from bulk_job_worker where id=any(${ids}::uuid[])`;
 await Promise.all(procs.splice(0).map(p=>p.owner.end({timeout:5})));
});
afterAll(async()=>{await owner.client.unsafe('drop table if exists public.lane_fixture_row');await closeAll();});

it('one all-lane process alone sets the baseline outcomes',async()=>{
 const ids=await admitQueue();
 const all=proc('all',WORKER_LANES,[PAY,IMP]);
 await runFleet([all],ids);
 baseline=await outcomes(ids);
 expect(baseline.map(o=>o.state)).toEqual(Array(8).fill('completed'));
 expect(baseline[5]).toMatchObject({kind:IMP,stepsDone:3,counters:{total:3,written:2,failed:1},values:['import-3-0','import-3-2']});
 expect(all.ticks.bank).toBe(all.iterations);
},60_000);

it('two lane processes and one all-lane process give the same outcomes, claim nothing twice and keep payroll order',async()=>{
 expect(baseline).not.toBeNull();
 const ids=await admitQueue();
 const payroll=proc('payroll',['payroll'],[PAY]),imports=proc('import',['import'],[IMP]),all=proc('all',WORKER_LANES,[PAY,IMP]);
 await runFleet([payroll,imports,all],ids);
 // Same outcomes, job by job, as one process alone.
 expect(await outcomes(ids)).toEqual(baseline);

 const rows=await owner.client<{job_id:string;kind:string;process:string;started_at:string|Date;finished_at:string|Date}[]>`select r.job_id,j.kind,r.process,r.started_at,r.finished_at
  from public.lane_fixture_row r join bulk_job j on j.id=r.job_id where r.job_id=any(${ids}::uuid[]) order by r.started_at,r.id`;
 // No double claim: each job's units ran one after another, never in two processes at once.
 for(const id of ids){
  const units=rows.filter(r=>r.job_id===id);
  for(let i=1;i<units.length;i++)expect(ms(units[i].started_at)).toBeGreaterThanOrEqual(ms(units[i-1].finished_at));
 }
 // Each lane process ran only its own lane's kind; the all-lane process may run either.
 expect(rows.filter(r=>r.process==='payroll').every(r=>r.kind===PAY)).toBe(true);
 expect(rows.filter(r=>r.process==='import').every(r=>r.kind===IMP)).toBe(true);
 expect(rows.some(r=>r.process==='payroll')).toBe(true);
 expect(rows.some(r=>r.process==='import')).toBe(true);
 // Per-company payroll order: a company's next payroll job starts only after its previous one finished.
 for(const company of ['A','B']){
  const jobs=ids.filter(id=>companyOf.get(id)===company&&rows.some(r=>r.job_id===id&&r.kind===PAY));
  expect(jobs.length).toBeGreaterThan(1);
  for(let i=1;i<jobs.length;i++){
   const previousEnd=Math.max(...rows.filter(r=>r.job_id===jobs[i-1]).map(r=>ms(r.finished_at)));
   const nextStart=Math.min(...rows.filter(r=>r.job_id===jobs[i]).map(r=>ms(r.started_at)));
   expect(nextStart,`company ${company} job ${i+1}`).toBeGreaterThanOrEqual(previousEnd);
  }
 }
 // Singleton ticks run only in the all-lane process, once per pass of its loop.
 for(const p of [payroll,imports])expect(p.ticks).toEqual({bank:0,individual:0,rewardPlans:0,probation:0});
 expect(all.ticks).toEqual({bank:all.iterations,individual:all.iterations,rewardPlans:all.iterations,probation:all.iterations});
 // Each process advertised exactly its kinds and lane markers.
 const beats=await owner.client<{id:string;kinds:string[]}[]>`select id,kinds from bulk_job_worker where id=any(${[payroll.workerId,imports.workerId,all.workerId]}::uuid[])`;
 const kindsOf=(p:Proc)=>beats.find(w=>w.id===p.workerId)?.kinds;
 expect(kindsOf(payroll)).toEqual([PAY,laneMarker('payroll')]);
 expect(kindsOf(imports)).toEqual([IMP,laneMarker('import')]);
 expect(kindsOf(all)).toEqual([PAY,IMP,...WORKER_LANES.map(laneMarker)]);
},60_000);

it('keeps the Bank tick single-runner across processes through its session advisory lock',async()=>{
 const a=proc('a',WORKER_LANES,[]),c=proc('c',WORKER_LANES,[]);
 const held=await a.owner.reserve();
 try{
  const [lock]=await held<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended('bank-import-worker',0)) as ok`;
  expect(lock.ok).toBe(true);
  // While one process holds the Bank lock, another process's Bank tick does nothing.
  expect(await runBankImportTick(c.owner)).toBe(false);
  const [mine]=await c.owner<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended('bank-import-worker',0)) as ok`;
  expect(mine.ok).toBe(false);
 }finally{await held`select pg_advisory_unlock(hashtextextended('bank-import-worker',0))`;held.release();}
});

