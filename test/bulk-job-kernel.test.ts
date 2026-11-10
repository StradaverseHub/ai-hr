/** Shared background bulk-job kernel (migration 5011) with a fixture kind in per-step mode, the shape the leave
 * ledger import needs: real PostgreSQL, real RLS, real worker ticks. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {BULK_JOB_ALREADY_RUNNING,enqueueBulkJobTx,readBulkJob,requestBulkJobCancel} from '../core/bulk-job';
import {runBulkJobTick,type BulkJobHandler} from '../core/bulk-job-worker';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext;
let busyOnce=0;
const fixture:BulkJobHandler<{value:string}>={
 kind:'kernel_fixture',mode:'per-step',chunkBudgetMs:1,maxStepsPerChunk:2,
 stepRef:step=>step.payload.value,
 async prepare(_ctx,job){
  const values=(job.input as {values:string[]}).values;
  if(values.includes('refuse-file'))return{refused:'Fixture file refused.',counters:{total:values.length}};
  return{steps:values.map((value,i)=>({kind:'item',rowNum:i+1,payload:{value}})),counters:{total:values.length}};
 },
 async applyStepTx(tx,_ctx,job,step){
  if(step.payload.value==='bad')throw new Error('Fixture row refused.');
  if(step.payload.value==='busy'&&busyOnce++===0)throw Object.assign(new Error('fixture serialization failure'),{code:'40001'});
  await tx.execute(sql`insert into public.kernel_fixture_row(tenant_id,job_id,value) values(${job.tenant_id}::uuid,${job.id}::uuid,${step.payload.value})`);
  return{counters:{written:1}};
 },
};
const tick=()=>runBulkJobTick(owner.client,{handlers:[fixture]});
async function run(id:string,until:(state:string)=>boolean=s=>['completed','failed','cancelled'].includes(s),max=200){
 for(let i=0;i<max;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(until(row.state)&&(!['completed','failed','cancelled'].includes(row.state)||row.notified))return row.state;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,60));
 }
 throw new Error('fixture job did not finish');
}
const admit=(as:SessionContext,values:string[],operationKey?:string)=>withTenant(as,tx=>enqueueBulkJobTx(tx,as,{kind:'kernel_fixture',operationKey,input:{values},source:{name:'fixture.csv',content:Buffer.from(values.join('\n'))}}));
const written=async(id:string)=>(await owner.client<{value:string}[]>`select value from public.kernel_fixture_row where job_id=${id}::uuid order by id`).map(r=>r.value);
beforeAll(async()=>{
 await migrateTestDb();
 await owner.client.unsafe(`create table if not exists public.kernel_fixture_row(id bigserial primary key,tenant_id uuid not null,job_id uuid not null,value text not null)`);
 await owner.client.unsafe(`grant select,insert on public.kernel_fixture_row to ai_hr_app; grant usage on sequence public.kernel_fixture_row_id_seq to ai_hr_app`);
});
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);busyOnce=0;
 await owner.client`insert into bulk_job_kind(kind,scope_kind,exclusive) values('kernel_fixture',null,'creator') on conflict do nothing`;
 await owner.client`delete from public.kernel_fixture_row`;
});
afterAll(async()=>{await owner.client.unsafe('drop table if exists public.kernel_fixture_row');await closeAll();});

it('runs per-step jobs to completion, recording refused rows while the others commit, and notifies once',async()=>{
 const {row}=await admit(ctx,['a','bad','c','d']);
 expect(row).toMatchObject({state:'queued',exclusive_key:ctx.userId});
 expect(await run(row.id)).toBe('completed');
 const job=await readBulkJob(ctx,row.id);
 expect(job).toMatchObject({state:'completed',steps_total:4,steps_done:4,counters:{total:4,written:3,failed:1}});
 expect(job.errors).toEqual([{rowNum:2,ref:'bad',message:'Fixture row refused.'}]);
 expect(await written(row.id)).toEqual(['a','c','d']);
 expect(Number(job.metrics.chunks)).toBeGreaterThan(1);
 // The completion notice: one creator-authored event, recorded on the job.
 const events=await owner.client<{id:string;actor_id:string;payload:{kind:string;outcome:string}}[]>`select id,actor_id,payload from domain_event where aggregate_type='bulk-job' and aggregate_id=${row.id}::uuid`;
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actor_id:ctx.userId,payload:{kind:'kernel_fixture',outcome:'completed'}});
 expect(job.notice_event_id).toBe(events[0].id);
 for(let i=0;i<3;i++)await tick();
 expect(await owner.client`select id from domain_event where aggregate_type='bulk-job' and aggregate_id=${row.id}::uuid`).toHaveLength(1);
 // The worker reported the kinds it serves.
 const [beat]=await owner.client<{kinds:string[]}[]>`select kinds from bulk_job_worker order by beat_at desc limit 1`;
 expect(beat.kinds).toEqual(['kernel_fixture']);
});

it('admits idempotently per operation, one active job per creator, and hides a job from everyone else',async()=>{
 const key=randomUUID();
 const first=await admit(ctx,['a'],key),again=await admit(ctx,['a'],key);
 expect(again).toMatchObject({existing:true,row:{id:first.row.id}});
 await expect(admit(ctx,['b'])).rejects.toThrow(BULK_JOB_ALREADY_RUNNING);
 const otherUser=await createAppUser(b.tenantId,null,'hr_admin');
 const other:SessionContext={...ctx,userId:otherUser,grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']};
 const theirs=await admit(other,['z']);expect(theirs.existing).toBe(false);
 await expect(readBulkJob(other,first.row.id)).rejects.toThrow('unavailable');
 await expect(requestBulkJobCancel(other,first.row.id)).rejects.toThrow('unavailable');
});

it('retries a transient refusal without repeating committed steps',async()=>{
 const {row}=await admit(ctx,['a','busy','c']);
 expect(await run(row.id)).toBe('completed');
 expect(await written(row.id)).toEqual(['a','busy','c']);
 expect((await readBulkJob(ctx,row.id)).transient_retries).toBe(0);
});

it('records a step that stays transiently refused as failed once its retry limit is reached, and moves on',async()=>{
 const limited={...fixture,transientStepLimit:2,async applyStepTx(...args:Parameters<typeof fixture.applyStepTx>){if(args[3].payload.value==='stuck')throw Object.assign(new Error('fixture lock timeout'),{code:'55P03'});return fixture.applyStepTx(...args);}};
 const {row}=await admit(ctx,['a','stuck','c']);
 for(let i=0;i<200;i++){const [r]=await owner.client<{state:string}[]>`select state from bulk_job where id=${row.id}::uuid`;if(r.state==='completed')break;if(!await runBulkJobTick(owner.client,{handlers:[limited]}))await new Promise(resolve=>setTimeout(resolve,60));}
 const job=await readBulkJob(ctx,row.id);
 expect(job).toMatchObject({state:'completed',counters:{written:2,failed:1}});
 expect(job.errors).toMatchObject([{rowNum:2,ref:'stuck'}]);expect(job.errors[0].message).toMatch(/busy/);
 expect(await written(row.id)).toEqual(['a','c']);
});

it('stops a per-step job at the creator\'s request, keeping the rows already saved',async()=>{
 const {row}=await admit(ctx,Array.from({length:10},(_,i)=>'v'+i));
 await run(row.id,s=>s==='running');await tick();
 const before=await written(row.id);expect(before.length).toBeGreaterThan(0);
 await requestBulkJobCancel(ctx,row.id);
 expect(await run(row.id)).toBe('cancelled');
 expect(await written(row.id)).toEqual(before);
 const [event]=await owner.client<{payload:{outcome:string}}[]>`select payload from domain_event where aggregate_type='bulk-job' and aggregate_id=${row.id}::uuid`;
 expect(event.payload.outcome).toBe('cancelled');
 await expect(requestBulkJobCancel(ctx,row.id)).rejects.toThrow('no longer be stopped');
});

it('fails a refused file before any step, and reclaims a job whose worker died holding the lease',async()=>{
 const refused=await admit(ctx,['refuse-file']);
 expect(await run(refused.row.id)).toBe('failed');
 expect(await readBulkJob(ctx,refused.row.id)).toMatchObject({state:'failed',error:'Fixture file refused.',steps_total:0});
 const {row}=await admit(ctx,['a','b','c']);
 await run(row.id,s=>s==='running');
 await owner.client`update bulk_job set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '1 hour' where id=${row.id}::uuid`;
 expect(await tick()).toBe(false);
 await owner.client`update bulk_job set lease_expires_at=now()-interval '1 second' where id=${row.id}::uuid`;
 expect(await run(row.id)).toBe('completed');
 expect(await written(row.id)).toEqual(['a','b','c']);
});
