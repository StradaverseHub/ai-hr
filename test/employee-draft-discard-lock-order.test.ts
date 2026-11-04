import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {discardEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
function signal(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
it('takes Workforce authority before Onboarding audit custody during native draft deletion',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const ctx=adminCtx(b);
 const draft=await saveEmployeeDraft(ctx,{data:{},currentStep:1});
 const holding=signal(),allowAudit=signal(),workerReady=signal();let workerPid=0;
 // This is the existing create/update order. Deletion must not hold audit while waiting
 // for this writer's authority lock, or the writer and deletion form a cycle.
 const holder=withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,b.tenantId);holding.resolve();await allowAudit.promise;
  await tx.execute(sql`select set_config('lock_timeout','200ms',true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId}))`);
 }).then(()=>({ok:true}),()=>({ok:false}));
 let worker:Promise<{ok:boolean}>|undefined;
 try{
  await holding.promise;
  worker=withTenant(ctx,async tx=>{
   const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);workerPid=row.pid;workerReady.resolve();
   await discardEmployeeDraft(ctx,draft.id,tx);
  }).then(()=>({ok:true}),()=>({ok:false}));
  await workerReady.promise;
  let waiting=false;
  for(let attempt=0;attempt<30&&!waiting;attempt++){
   const [row]=await owner.client`select exists(select 1 from pg_locks where pid=${workerPid} and locktype='advisory' and not granted)as waiting`;
   waiting=row.waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(waiting,'native delete reached the independently held authority barrier').toBe(true);
  allowAudit.resolve();
  expect(await holder,'ordinary writer must acquire audit without a lock cycle').toEqual({ok:true});
  expect(await worker,'native discard must retain its original bounded completion').toEqual({ok:true});
  const [remaining]=await owner.client`select count(*)::int as count from employee_draft where id=${draft.id}::uuid`;
  expect(remaining.count).toBe(0);
  const [events]=await owner.client`select count(*)::int as count from domain_event where aggregate_id=${draft.id}::uuid and event_type='employee-draft.discarded'`;
  expect(events.count).toBe(1);
 }finally{allowAudit.resolve();await Promise.allSettled([holder,...(worker?[worker]:[])]);}
});
