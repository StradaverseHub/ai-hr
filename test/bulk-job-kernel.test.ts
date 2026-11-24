/** Shared background bulk-job kernel (migrations 5011, 5013, 5014) with a fixture kind in per-step mode, the shape
 * the leave ledger import needs: real PostgreSQL, real RLS, real worker ticks. Also the hardened kernel: the
 * application role only reads the store, the worker's writes need its lease capability, the seal stops a job whose
 * data changed behind the worker, finalize gets the owner connection only when the kind declares it, and owner-path
 * events carry the job. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {BULK_JOB_ALREADY_RUNNING,enqueueBulkJobTx,listBulkJobsTx,readBulkJob,requestBulkJobCancel} from '../core/bulk-job';
import {runBulkJobTick,type BulkJobHandler,type BulkJobUnit} from '../core/bulk-job-worker';
import {pgSqlState} from '../lib/db-error';
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
const tick=(handlers:readonly BulkJobHandler[]=[fixture])=>runBulkJobTick(owner.client,{handlers});
async function run(id:string,until:(state:string)=>boolean=s=>['completed','failed','cancelled'].includes(s),max=200,handlers:readonly BulkJobHandler[]=[fixture]){
 for(let i=0;i<max;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(until(row.state)&&(!['completed','failed','cancelled'].includes(row.state)||row.notified))return row.state;
  if(!await tick(handlers))await new Promise(resolve=>setTimeout(resolve,60));
 }
 throw new Error('fixture job did not finish');
}
const admit=(as:SessionContext,values:string[],operationKey?:string,kind='kernel_fixture')=>withTenant(as,tx=>enqueueBulkJobTx(tx,as,{kind,operationKey,input:{values},source:{name:'fixture.csv',content:Buffer.from(values.join('\n'))}}));
/** The SQLSTATE an application-role statement ends with ('ok' when it succeeds). */
async function stateOf(as:SessionContext,statement:SQL|((tx:Tx)=>Promise<unknown>)){
 try{await withTenant(as,async tx=>typeof statement==='function'?statement(tx):tx.execute(statement));return'ok';}catch(error){return pgSqlState(error)??String((error as Error).message);}
}
const written=async(id:string)=>(await owner.client<{value:string}[]>`select value from public.kernel_fixture_row where job_id=${id}::uuid order by id`).map(r=>r.value);
beforeAll(async()=>{
 await migrateTestDb();
 await owner.client.unsafe(`create table if not exists public.kernel_fixture_row(id bigserial primary key,tenant_id uuid not null,job_id uuid not null,value text not null)`);
 await owner.client.unsafe(`grant select,insert on public.kernel_fixture_row to ai_hr_app; grant usage on sequence public.kernel_fixture_row_id_seq to ai_hr_app`);
});
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);busyOnce=0;
 // A kind declares its input shape (5013); only the second fixture kind may finalize on the owner connection.
 await owner.client`insert into bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner) values('kernel_fixture',null,'creator','{"values":"array"}'::jsonb,false),
  ('kernel_owner_fixture',null,'creator','{"values":"array"}'::jsonb,true) on conflict(kind) do update set input_shape=excluded.input_shape,finalize_owner=excluded.finalize_owner`;
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

it('lets the application role read its own jobs and nothing more: the worker writes the store with its lease capability',async()=>{
 const {row}=await admit(ctx,['a','b','c']);
 await run(row.id,s=>s==='running');
 // Privilege inventory as the application role: SELECT on the job, steps and kinds; no table or column write anywhere
 // in the store, nothing on the seal, no owner-only routine.
 const [grants]=await withTenant(ctx,tx=>tx.execute<Record<string,boolean|number>>(sql`select
  has_table_privilege(current_user,'public.bulk_job','SELECT') job_read,has_table_privilege(current_user,'public.bulk_job_step','SELECT') step_read,
  has_table_privilege(current_user,'public.bulk_job_kind','SELECT') kind_read,
  has_table_privilege(current_user,'public.bulk_job','INSERT,UPDATE,DELETE,TRUNCATE') job_write,has_table_privilege(current_user,'public.bulk_job_step','INSERT,UPDATE,DELETE,TRUNCATE') step_write,
  has_table_privilege(current_user,'public.bulk_job_kind','INSERT,UPDATE,DELETE,TRUNCATE') kind_write,has_table_privilege(current_user,'public.bulk_job_worker','SELECT,INSERT,UPDATE,DELETE') worker_any,
  has_table_privilege(current_user,'app.bulk_job_seal','SELECT,INSERT,UPDATE,DELETE') seal_any,has_table_privilege(current_user,'app.bulk_job_step_seal','SELECT,INSERT,UPDATE,DELETE') step_seal_any,
  (select count(*)::int from pg_attribute a where a.attrelid in ('public.bulk_job'::regclass,'public.bulk_job_step'::regclass,'public.bulk_job_kind'::regclass,'public.bulk_job_worker'::regclass)
    and a.attnum>0 and not a.attisdropped and (has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE') or has_column_privilege(current_user,a.attrelid,a.attnum,'INSERT'))) column_writes,
  has_function_privilege(current_user,'app.bulk_job_seal_verify(uuid,text)','EXECUTE') verify,has_function_privilege(current_user,'app.bulk_job_lease_capability(uuid,uuid,text)','EXECUTE') bind,
  has_function_privilege(current_user,'app.bulk_job_clear_inputs(uuid,boolean)','EXECUTE') clear,has_function_privilege(current_user,'app.bulk_job_held(uuid)','EXECUTE') held`));
 expect(grants).toEqual({job_read:true,step_read:true,kind_read:true,job_write:false,step_write:false,kind_write:false,worker_any:false,seal_any:false,step_seal_any:false,
  column_writes:0,verify:false,bind:false,clear:false,held:false});
 // The creator, as the application role, cannot change what the worker will trust or apply.
 const id=row.id;
 for(const statement of [
  sql`update bulk_job set input='{"values":["evil"]}'::jsonb where id=${id}::uuid`,
  sql`update bulk_job set plan='{"forged":true}'::jsonb where id=${id}::uuid`,
  sql`update bulk_job set state='completed',result='{"forged":true}'::jsonb where id=${id}::uuid`,
  sql`update bulk_job set cancel_requested_at=now() where id=${id}::uuid`,
  sql`select id from bulk_job where id=${id}::uuid for update`,
  sql`insert into bulk_job(tenant_id,kind,created_by,context,operation_key,exclusive_key) values(${b.tenantId}::uuid,'kernel_fixture',${ctx.userId}::uuid,'{}'::jsonb,gen_random_uuid(),'')`,
  sql`insert into bulk_job_step(job_id,tenant_id,seq,kind,payload) values(${id}::uuid,${b.tenantId}::uuid,99,'item','{"value":"evil"}'::jsonb)`,
  sql`update bulk_job_step set state='applied',result='{"forged":true}'::jsonb where job_id=${id}::uuid`,
  sql`update bulk_job_step set payload='{"value":"evil"}'::jsonb where job_id=${id}::uuid`,
  sql`delete from bulk_job_step where job_id=${id}::uuid`,
  sql`update bulk_job_kind set finalize_owner=true where kind='kernel_fixture'`,
  sql`select * from app.bulk_job_seal`,
  sql`select app.bulk_job_seal_verify(${id}::uuid,'full')`,
  // The worker's definers without its capability, and with a guessed one.
  sql`select app.bulk_job_worker_update(${id}::uuid,'{"planMerge":{"forged":true}}'::jsonb)`,
  sql`select app.bulk_job_step_update(${id}::uuid,'{0}'::int[],'{"state":"applied","result":{"forged":true}}'::jsonb)`,
  sql`select app.bulk_job_steps_put(${id}::uuid,false,'[{"seq":99,"kind":"item","row_num":99,"payload":{"value":"evil"}}]'::jsonb)`,
  sql`select * from app.bulk_job_pending_steps(${id}::uuid,10)`,
 ])expect(await stateOf(ctx,statement)).toBe('42501');
 expect(await stateOf(ctx,async tx=>{
  await tx.execute(sql`select set_config('app.bulk_job_capability',${'f'.repeat(64)},true)`);
  return tx.execute(sql`select app.bulk_job_worker_update(${id}::uuid,'{"planMerge":{"forged":true}}'::jsonb)`);
 })).toBe('42501');
 const [fence]=await withTenant(ctx,tx=>tx.execute<{fence:string}>(sql`select app.bulk_job_fence(${id}::uuid,${'f'.repeat(64)}) as fence`));
 expect(fence.fence).toBe('lost');
 // Nor can it attribute its own events to the job (5014).
 expect(await stateOf(ctx,async tx=>{
  await tx.execute(sql`select set_config('app.bulk_job',${id},true)`);
  return tx.execute(sql`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${b.tenantId}::uuid,'bulk-job',${id}::uuid,'fixture.forged','user',${ctx.userId}::uuid,'{}'::jsonb)`);
 })).toBe('42501');
 const [attribution]=await withTenant(ctx,tx=>tx.execute<{a:unknown}>(sql`select app.bulk_job_attribution() as a`));
 expect(attribution.a).toBeNull();
 // The worker carries on: the job completes with exactly its own rows and an untouched seal.
 expect(await run(id)).toBe('completed');
 expect(await written(id)).toEqual(['a','b','c']);
 const job=await readBulkJob(ctx,id);
 expect(job).toMatchObject({state:'completed',steps_done:3,plan:null,input:null,cancel_requested_at:null});
});

it('admits only through the definer: kind, companies and the declared input shape are checked, the file is hashed',async()=>{
 const enqueue=(admission:Parameters<typeof enqueueBulkJobTx>[2])=>stateOf(ctx,tx=>enqueueBulkJobTx(tx,ctx,admission));
 expect(await enqueue({kind:'kernel_fixture',input:{values:['a'],extra:true}})).toBe('22023');
 expect(await enqueue({kind:'kernel_fixture',input:{values:'a'}})).toBe('22023');
 expect(await enqueue({kind:'kernel_fixture',input:['a']})).toBe('22023');
 expect(await enqueue({kind:'kernel_fixture'})).toBe('22023');
 expect(await enqueue({kind:'no_such_kind',input:{values:[]}})).toBe('22023');
 expect(await enqueue({kind:'kernel_fixture',input:{values:['a']},companyIds:[randomUUID()]})).toBe('42501');
 expect(await owner.client`select id from bulk_job`).toHaveLength(0);
 const content=Buffer.from('a\nb');
 const {row}=await withTenant(ctx,tx=>enqueueBulkJobTx(tx,ctx,{kind:'kernel_fixture',companyIds:[b.companyId,b.companyId],input:{values:['a','b']},source:{name:'fixture.csv',content}}));
 expect(row).toMatchObject({state:'queued',kind:'kernel_fixture',company_ids:[b.companyId],source_bytes:content.length,source_hash:createHash('sha256').update(content).digest('hex'),input:{values:['a','b']},plan:null});
 const listed=await withTenant(ctx,tx=>listBulkJobsTx(tx,ctx,'kernel_fixture'));
 expect(listed.map(r=>r.id)).toEqual([row.id]);
 // The seal holds the admitted input; the application role never sees it.
 const [seal]=await owner.client<{ok:boolean}[]>`select input_digest=sha256(convert_to(${JSON.stringify({values:['a','b']})}::text::jsonb::text,'UTF8')) and plan_digest=sha256(convert_to('null','UTF8')) as ok from app.bulk_job_seal where job_id=${row.id}::uuid`;
 expect(seal.ok).toBe(true);
 expect(await run(row.id)).toBe('completed');
});

it('seals what the worker trusts: a step, a result or the plan changed behind its back stops the job',async()=>{
 const finalizing:BulkJobHandler<{value:string}>={...fixture,async finalize(){return{result:{finished:true}};}};
 // Control: untouched, the job finalizes with its result.
 const control=await admit(ctx,['a','b']);
 expect(await run(control.row.id,undefined,200,[finalizing])).toBe('completed');
 expect((await readBulkJob(ctx,control.row.id)).result).toEqual({finished:true});
 // A pending step's payload rewritten on the store itself: the chunk reader refuses it before it is applied.
 const payload=await admit(ctx,['a','b','c','d']);
 await run(payload.row.id,s=>s==='running',200,[finalizing]);
 await owner.client`update bulk_job_step set payload='{"value":"evil"}'::jsonb where job_id=${payload.row.id}::uuid and seq=3`;
 expect(await run(payload.row.id,undefined,200,[finalizing])).toBe('failed');
 expect((await readBulkJob(ctx,payload.row.id)).error).toMatch(/integrity check/);
 expect(await written(payload.row.id)).not.toContain('evil');
 // An applied step's result rewritten before finalize: the first finalize unit verifies every step.
 const result=await admit(ctx,['a','b']);
 await run(result.row.id,s=>s==='finalizing',200,[finalizing]);
 await owner.client`update bulk_job_step set result='{"forged":true}'::jsonb where job_id=${result.row.id}::uuid and seq=0`;
 expect(await run(result.row.id,undefined,200,[finalizing])).toBe('failed');
 expect(await readBulkJob(ctx,result.row.id)).toMatchObject({state:'failed',result:null,error:expect.stringMatching(/integrity check/)});
 // The plan rewritten before finalize.
 const plan=await admit(ctx,['a']);
 await run(plan.row.id,s=>s==='finalizing',200,[finalizing]);
 await owner.client`update bulk_job set plan='{"forged":true}'::jsonb where id=${plan.row.id}::uuid`;
 expect(await run(plan.row.id,undefined,200,[finalizing])).toBe('failed');
 expect((await readBulkJob(ctx,plan.row.id)).error).toMatch(/integrity check/);
});

it('gives finalize the owner connection only when the kind declares it, and attributes owner-path events to the job',async()=>{
 const seen:BulkJobUnit[]=[];
 const plain:BulkJobHandler<{value:string}>={...fixture,async finalize(_ctx,_job,unit){seen.push(unit);return{result:null};}};
 const first=await admit(ctx,['a']);
 expect(await run(first.row.id,undefined,200,[plain])).toBe('completed');
 expect(seen).toHaveLength(1);expect('ownerTx' in seen[0]).toBe(false);expect('owner' in seen[0]).toBe(false);
 // A handler that claims an owner finalize its kind row does not grant is stopped before finalize runs.
 let ran=false;
 const undeclared:BulkJobHandler<{value:string}>={...fixture,finalizeOwner:true,async finalize(){ran=true;return{result:null};}};
 const second=await admit(ctx,['a']);
 expect(await run(second.row.id,undefined,200,[undeclared])).toBe('failed');
 expect(ran).toBe(false);
 expect((await readBulkJob(ctx,second.row.id)).error).toMatch(/does not grant/);
 // Declared on both sides: one owner transaction, attributed (app.bulk_job), whose events carry the job.
 const declared:BulkJobHandler<{value:string}>={...fixture,kind:'kernel_owner_fixture',finalizeOwner:true,async finalize(_ctx,job,unit){
  await unit.ownerTx!(async owner=>{
   await owner`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload) values(${job.tenant_id}::uuid,'bulk-job',${job.id}::uuid,'fixture.owner-noted','system','{"note":1}'::jsonb)`;
   await unit.set(owner,{planMerge:{owned:true}});
  });
  return{result:{owned:true}};
 }};
 const third=await admit(ctx,['a'],undefined,'kernel_owner_fixture');
 expect(await run(third.row.id,undefined,200,[declared])).toBe('completed');
 const [event]=await owner.client<{payload:{note:number;bulkJob:{id:string;kind:string}}}[]>`select payload from domain_event where event_type='fixture.owner-noted' and aggregate_id=${third.row.id}::uuid`;
 expect(event.payload).toEqual({note:1,bulkJob:{id:third.row.id,kind:'kernel_owner_fixture'}});
 expect(await readBulkJob(ctx,third.row.id)).toMatchObject({state:'completed',plan:{owned:true},result:{owned:true}});
 // Events written outside an owner transaction carry no job.
 const [notice]=await owner.client<{payload:Record<string,unknown>}[]>`select payload from domain_event where event_type='bulk-job.finished' and aggregate_id=${third.row.id}::uuid`;
 expect(notice.payload).toMatchObject({kind:'kernel_owner_fixture',outcome:'completed'});expect(notice.payload.bulkJob).toBeUndefined();
});
