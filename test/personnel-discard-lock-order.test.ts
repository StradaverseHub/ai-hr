/** Actual native discard must join Access before onboarding takes the audit-chain lock. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {saveEmployeeDraft,discardEmployeeDraft} from '../core/employee-draft';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,entitledCtx} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
it('queues a lifecycle-enabled Personnel discard behind Access without holding the audit chain',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const ctx=await entitledCtx(b);
 const draft=await saveEmployeeDraft(ctx,{data:{},currentStep:1});
 const entered=barrier(),release=barrier();let pid:number|undefined,discard:Promise<unknown>|undefined;
 const holder=withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);entered.resolve();await release.promise;});
 try{
  await entered.promise;
  // Observe a real pending lock on this exact backend, rather than infer concurrency from a delay.
  discard=withTenant(ctx,async tx=>{const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);pid=row.pid;await discardEmployeeDraft(ctx,draft.id,tx);});
  // Attach a handler immediately: a native refusal must remain an assertion failure, not an unhandled rejection.
  const outcome=discard.then(()=>({ok:true as const}),error=>({ok:false as const,error}));
  const until=Date.now()+400;let waiting=false;
  while(Date.now()<until){
   if(pid){const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and not granted) as waiting`);if(row.waiting){waiting=true;break;}}
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(waiting,'discard must reach the held native Access lock before its unchanged500ms lock bound').toBe(true);
  const auditAvailable=await owner.client.begin(async observer=>{const [row]=await observer`select pg_try_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId})) as available`;return row.available;});
  expect(auditAvailable,'a queued discard must not invert Access -> audit-chain ordering').toBe(true);
  release.resolve();expect(await outcome).toEqual({ok:true});
  const [deleted]=await owner.db.execute<{missing:boolean}>(sql`select not exists(select 1 from employee_draft where id=${draft.id}::uuid) as missing`);expect(deleted.missing).toBe(true);
  const [event]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from domain_event where aggregate_id=${draft.id}::uuid and event_type='employee-draft.discarded'`);expect(event.n).toBe(1);
 }finally{release.resolve();await Promise.allSettled([holder,...(discard?[discard]:[])]);}
});
