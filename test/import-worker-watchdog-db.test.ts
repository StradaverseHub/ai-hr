/** The protected import worker's stall watchdog against real PostgreSQL and the real kernel:
 * - the actual runner logs its limit at start, honours the setting, refuses an invalid one before connecting, and its
 *   watchdog timer does not keep a --once run alive;
 * - a bulk-job unit interrupted by the watchdog's exit commits nothing, is not run again while its lease lasts, and
 *   once the lease expires a fresh worker claims it and applies every step exactly once.
 * Pure watchdog behaviour (clock, phases, exit) is in test/import-worker-watchdog.test.ts. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {enqueueBulkJobTx} from '../core/bulk-job';
import {runBulkJobTick,type BulkJobHandler} from '../core/bulk-job-worker';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

let ctx:SessionContext;
const fixture:BulkJobHandler<{value:string}>={
 kind:'watchdog_fixture',mode:'per-step',chunkBudgetMs:10_000,maxStepsPerChunk:8,
 async prepare(_ctx,job){
  const values=(job.input as {values:string[]}).values;
  return{steps:values.map((value,i)=>({kind:'item',rowNum:i+1,payload:{value}})),counters:{total:values.length}};
 },
 async applyStepTx(tx,_ctx,job,step){
  await tx.execute(sql`insert into public.watchdog_fixture_row(job_id,value) values(${job.id}::uuid,${step.payload.value})`);
  return{counters:{written:1}};
 },
};
const tick=()=>runBulkJobTick(owner.client,{handlers:[fixture]});
async function run(id:string,max=200){
 for(let i=0;i<max;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(['completed','failed','cancelled'].includes(row.state)&&row.notified)return row.state;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,60));
 }
 throw new Error('fixture job did not finish');
}
const written=async(id:string)=>(await owner.client<{value:string}[]>`select value from public.watchdog_fixture_row where job_id=${id}::uuid order by id`).map(r=>r.value);
/** The real runner, as systemd starts it but with --once. */
const runner=(env:Record<string,string|undefined>)=>spawnSync(process.execPath,['--import','tsx','scripts/bank-import-runner.ts','--once'],
 {cwd:process.cwd(),encoding:'utf8',timeout:90_000,env:{...process.env,DATABASE_URL:process.env.DATABASE_URL,MIGRATION_DATABASE_URL:process.env.MIGRATION_DATABASE_URL,...env}});

beforeAll(async()=>{
 await migrateTestDb();
 await owner.client.unsafe(`create table if not exists public.watchdog_fixture_row(id bigserial primary key,job_id uuid not null,value text not null)`);
 await owner.client.unsafe(`grant select,insert on public.watchdog_fixture_row to ai_hr_app; grant usage on sequence public.watchdog_fixture_row_id_seq to ai_hr_app`);
});
beforeEach(async()=>{
 await resetDb();ctx=adminCtx(await seedBase());
 await owner.client`insert into bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner) values('watchdog_fixture',null,'creator','{"values":"array"}'::jsonb,false)
  on conflict(kind) do update set input_shape=excluded.input_shape,finalize_owner=excluded.finalize_owner`;
 await owner.client`delete from public.watchdog_fixture_row`;
});
afterAll(async()=>{await owner.client.unsafe('drop table if exists public.watchdog_fixture_row');await closeAll();});

// Each spawn compiles the worker's module graph with tsx (the packaged startup check allows 60 s); 3x two spawns.
it('logs its limit at start, honours the setting and ends a --once run with the watchdog armed',()=>{
 const standard=runner({AIHR_IMPORT_WORKER_STALL_SECONDS:undefined});
 expect(standard.status,standard.stderr).toBe(0);
 expect(standard.stderr).toMatch(/Import worker started \(pid \d+\); stall watchdog 1200 s \(AIHR_IMPORT_WORKER_STALL_SECONDS\)\./);
 expect(standard.stderr).not.toContain('stalled');
 const tuned=runner({AIHR_IMPORT_WORKER_STALL_SECONDS:'3600'});
 expect(tuned.status,tuned.stderr).toBe(0);
 expect(tuned.stderr).toContain('stall watchdog 3600 s (AIHR_IMPORT_WORKER_STALL_SECONDS).');
},360_000);

it('refuses to start with an invalid limit before it connects or claims anything',async()=>{
 const {row}=await withTenant(ctx,tx=>enqueueBulkJobTx(tx,ctx,{kind:'watchdog_fixture',input:{values:['a']},source:{name:'fixture.csv',content:Buffer.from('a')}}));
 const refused=runner({AIHR_IMPORT_WORKER_STALL_SECONDS:'60'});
 expect(refused.status).toBe(1);
 expect(refused.stderr).toContain('AIHR_IMPORT_WORKER_STALL_SECONDS must be a whole number of seconds from 960 to 21600 (default 1200).');
 expect(refused.stderr).not.toContain('Import worker started');
 const [job]=await owner.client<{state:string;lease_token:string|null}[]>`select state,lease_token from bulk_job where id=${row.id}::uuid`;
 expect(job).toEqual({state:'queued',lease_token:null});
},180_000);

it('leaves a unit interrupted by the watchdog uncommitted and re-claimable once its lease expires',async()=>{
 const {row}=await withTenant(ctx,tx=>enqueueBulkJobTx(tx,ctx,{kind:'watchdog_fixture',input:{values:['a','b','c']},source:{name:'fixture.csv',content:Buffer.from('a\nb\nc')}}));
 // Prepare here, so the child's first unit is a chunk transaction.
 expect(await tick()).toBe(true);
 const [prepared]=await owner.client<{state:string;steps_total:number;lease_token:string|null}[]>`select state,steps_total,lease_token from bulk_job where id=${row.id}::uuid`;
 expect(prepared).toEqual({state:'running',steps_total:3,lease_token:null});

 const child=spawnSync(process.execPath,['--import','tsx','test/helpers/import-worker-watchdog-stall-child.ts','2'],
  {cwd:process.cwd(),encoding:'utf8',timeout:90_000,env:{...process.env,DATABASE_URL:process.env.DATABASE_URL,MIGRATION_DATABASE_URL:process.env.MIGRATION_DATABASE_URL}});
 expect(child.status,child.stdout+child.stderr+String(child.error??'')).toBe(70);
 expect(child.stdout).toContain('step written, now stalling');
 expect(child.stdout).not.toContain('tick returned');
 expect(child.stderr).toMatch(/Import worker stalled in bulk for [2-9] s; exiting so systemd restarts it\./);

 // Nothing of the interrupted chunk committed: no fixture row, no applied step, no progress.
 expect(await written(row.id)).toEqual([]);
 const steps=await owner.client<{state:string}[]>`select state from bulk_job_step where job_id=${row.id}::uuid order by seq`;
 expect(steps.map(s=>s.state)).toEqual(['pending','pending','pending']);
 const [left]=await owner.client<{state:string;steps_done:number;leased:boolean;live:boolean}[]>`select state,steps_done,lease_token is not null as leased,lease_expires_at>now() as live from bulk_job where id=${row.id}::uuid`;
 expect(left).toEqual({state:'running',steps_done:0,leased:true,live:true});
 // A restarted worker does not run the unit again while the dead worker's lease lasts.
 expect(await tick()).toBe(false);
 expect(await written(row.id)).toEqual([]);

 // The lease expires (60 s after the claim in production); the next worker claims the job and finishes it once.
 await owner.client`update bulk_job set lease_expires_at=now()-interval '1 second' where id=${row.id}::uuid`;
 expect(await run(row.id)).toBe('completed');
 expect(await written(row.id)).toEqual(['a','b','c']);
 const [done]=await owner.client<{steps_done:number;counters:Record<string,number>}[]>`select steps_done,counters from bulk_job where id=${row.id}::uuid`;
 expect(done).toMatchObject({steps_done:3,counters:{total:3,written:3}});
},180_000);
