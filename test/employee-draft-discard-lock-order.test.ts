import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {lockAccessConfigurationReadTx,lockAccessConfigurationWriteTx} from '../core/access-configuration-lock';
import {discardEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
function signal(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
it('takes Workforce authority before Onboarding audit custody during native draft deletion',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const ctx=adminCtx(b);
 const draft=await saveEmployeeDraft(ctx,{data:{},currentStep:1});
 const holding=signal(),allowAudit=signal(),workerReady=signal();let workerPid=0;
 // This is the existing create/update order. Deletion must not hold audit while waiting
 // for this writer's authority lock, or the writer and deletion form a cycle.
 const holder=withTenant(ctx,async tx=>{
  await lockAccessConfigurationWriteTx(tx,b.tenantId);holding.resolve();await allowAudit.promise;
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

it('retries an owned draft discard after an audit lock timeout and commits one delete event',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const ctx=await entitledCtx(b);
 const draft=await saveEmployeeDraft(ctx,{data:{},currentStep:1});
 const holding=signal(),release=signal();let holderPid=0;
 const holder=withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);
  holderPid=row.pid;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId}))`);
  holding.resolve();await release.promise;
 });
 let discard:Promise<void>|undefined;
 try{
  await holding.promise;
  discard=discardEmployeeDraft(ctx,draft.id);
  void discard.catch(()=>undefined);
  let blocked=false;
  for(let attempt=0;attempt<100&&!blocked;attempt++){
   const [row]=await owner.client`select exists(select 1 from pg_stat_activity
    where datname=current_database() and ${holderPid}=any(pg_blocking_pids(pid))) as waiting`;
   blocked=row.waiting;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(blocked,'standalone discard reached the audit fence after Workforce authority').toBe(true);
  // Exceed the native 500 ms lock budget, then release during the retry window.
  await new Promise(resolve=>setTimeout(resolve,650));
  release.resolve();
  await discard;
  const [result]=await owner.client`select
   (select count(*)::int from employee_draft where id=${draft.id}::uuid) as drafts,
   (select count(*)::int from domain_event where aggregate_id=${draft.id}::uuid
    and event_type='employee-draft.discarded') as events`;
  expect(result).toEqual({drafts:0,events:1});
 }finally{
  release.resolve();
  await Promise.allSettled([holder,...(discard?[discard]:[])]);
 }
});

it('observes the standalone Personnel discard fallback queue a shared Access read', async () => {
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'lifecycle', 'active');
  const ctx = await entitledCtx(base);
  const draft = await saveEmployeeDraft(ctx, { data: {}, currentStep: 1 });
  let discard: Promise<void> | undefined;
  let read: Promise<boolean> | undefined;

  try {
    await owner.db.transaction(async holder => {
      await lockAccessConfigurationReadTx(holder, base.tenantId);
      const [holderBackend] = await holder.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      const waiters = () => holder.execute<{
        pid: number; mode: 'ExclusiveLock' | 'ShareLock'; blockedBy: number[]; nativeDiscardBarrier: boolean;
      }>(sql`
        with access_key as (select hashtextextended(${'access-configuration:' + base.tenantId}, 0) as id)
        select l.pid, l.mode, pg_blocking_pids(l.pid) as "blockedBy",
          a.query like 'select app.access_configuration_write_lock()%' as "nativeDiscardBarrier"
        from pg_locks l join pg_stat_activity a on a.pid=l.pid cross join access_key k
        where a.datname=current_database() and l.locktype='advisory' and not l.granted and l.objsubid=1
          and l.classid::bigint=((k.id>>32)&4294967295) and l.objid::bigint=(k.id&4294967295)
      `);

      discard = discardEmployeeDraft(ctx, draft.id);
      void discard.catch(() => undefined);
      let discardPid: number | undefined;
      await expect.poll(async () => {
        discardPid = (await waiters()).find(lock => lock.mode === 'ExclusiveLock'
          && lock.nativeDiscardBarrier && lock.blockedBy.includes(holderBackend.pid))?.pid;
        return discardPid !== undefined;
      }, { timeout: 4000, interval: 10 }).toBe(true);

      read = withTenant(ctx, async tx => {
        await lockAccessConfigurationReadTx(tx, base.tenantId);
        const [principal] = await tx.execute<{ current: boolean }>(sql`select app.principal_snapshot_current() as current`);
        return principal.current;
      });
      void read.catch(() => undefined);
      await expect.poll(async () => (await waiters()).some(lock => lock.mode === 'ShareLock'
        && lock.blockedBy.some(pid => pid === discardPid)), { timeout: 1000, interval: 10 }).toBe(true);
    });

    await expect(discard).resolves.toBeUndefined();
    await expect(read).resolves.toBe(true);
    const [result] = await owner.client`select
      (select count(*)::int from employee_draft where id=${draft.id}::uuid) as drafts,
      (select count(*)::int from domain_event where aggregate_id=${draft.id}::uuid
        and event_type='employee-draft.discarded') as events`;
    expect(result).toEqual({ drafts: 0, events: 1 });
  } finally {
    await Promise.allSettled([discard, read]);
  }
}, 15000);
