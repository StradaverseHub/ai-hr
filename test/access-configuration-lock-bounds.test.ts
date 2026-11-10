/** Production incident, 10 November 2026: one long Access holder must not hang the whole process.
 * Fictional fixtures only. Reproduces one long exclusive holder plus many Access callers on the app pool
 * (max 10) and checks that waits are bounded, the waiter cap leaves connections free, unrelated work and
 * the clock-in dependency lock respond within bounds, and lock_timeout is restored on the success path. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {
  ACCESS_CONFIGURATION_LOCK_WAIT_MS,ACCESS_CONFIGURATION_MAX_WAITERS,AccessConfigurationBusyError,
  accessConfigurationLockWaitersForTests,lockAccessConfigurationReadTx,lockAccessConfigurationTx,
} from '../core/access-configuration-lock';
import {lockAttendanceLeaveDependenciesTx} from '../core/attendance';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx={...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]};});

/** Holds the tenant's exclusive Access lock on its own app-pool connection until released. */
async function holder(mode:'exclusive'|'shared'='exclusive'){
  let ready!:(pid:number)=>void,release!:()=>void;
  const start=new Promise<number>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});
  const done=withTenant(ctx,async tx=>{
    if(mode==='exclusive')await lockAccessConfigurationTx(tx,ctx.tenantId);else await lockAccessConfigurationReadTx(tx,ctx.tenantId);
    const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(row.pid);await finish;
  });
  return{pid:await start,release,done};
}
async function waitersOn(pid:number){const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from pg_stat_activity a where ${pid}=any(pg_blocking_pids(a.pid))`);return row.n;}
async function untilWaiters(pid:number,n:number){for(let i=0;i<200;i++){if(await waitersOn(pid)>=n)return;await new Promise(yes=>setTimeout(yes,10));}throw Error(`Expected ${n} actual Access waiters`);}
const timed=async<T>(work:()=>Promise<T>)=>{const t=performance.now();try{return{value:await work(),ms:performance.now()-t,error:undefined as unknown};}catch(error){return{value:undefined,ms:performance.now()-t,error};}};

describe('bounded Access configuration lock',()=>{
  it('uncontended: acquires on the fast path and leaves lock_timeout unchanged',async()=>{
    const seen=await withTenant(ctx,async tx=>{
      await tx.execute(sql`select set_config('lock_timeout','2500ms',true)`);
      await lockAccessConfigurationTx(tx,ctx.tenantId);
      await lockAccessConfigurationTx(tx,ctx.tenantId); // re-entrant within one transaction
      const [row]=await tx.execute<{v:string}>(sql`select current_setting('lock_timeout') as v`);return row.v;
    });
    expect(seen).toBe('2500ms');
    expect(accessConfigurationLockWaitersForTests()).toBe(0);
  });

  it('a waiter gives up with the retryable 55P03 after the bound, and its connection returns to the pool',async()=>{
    const h=await holder();
    try{
      const r=await timed(()=>withTenant(ctx,tx=>lockAccessConfigurationTx(tx,ctx.tenantId)));
      expect(pgSqlState(r.error)).toBe('55P03');
      expect(r.ms).toBeGreaterThanOrEqual(ACCESS_CONFIGURATION_LOCK_WAIT_MS-250);
      expect(r.ms).toBeLessThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS+3000);
      expect(accessConfigurationLockWaitersForTests()).toBe(0);
      expect(await waitersOn(h.pid)).toBe(0);
    }finally{h.release();await h.done;}
  },20_000);

  it('keeps a tighter limit the caller already set',async()=>{
    const h=await holder();
    try{
      const r=await timed(()=>withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('lock_timeout','800ms',true)`);await lockAccessConfigurationTx(tx,ctx.tenantId);}));
      expect(pgSqlState(r.error)).toBe('55P03');
      expect(r.ms).toBeLessThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS-1000);
    }finally{h.release();await h.done;}
  },20_000);

  it('a short holder still lets the waiter in, and lock_timeout is restored afterwards',async()=>{
    for(const prior of ['0','1h']){
      const h=await holder();
      const waiting=withTenant(ctx,async tx=>{
        await tx.execute(sql`select set_config('lock_timeout',${prior},true)`);
        await lockAccessConfigurationTx(tx,ctx.tenantId);
        const [row]=await tx.execute<{v:string}>(sql`select current_setting('lock_timeout') as v`);return row.v;
      });
      await untilWaiters(h.pid,1);h.release();await h.done;
      expect(await waiting).toBe(prior==='0'?'0':'1h');
    }
    expect(accessConfigurationLockWaitersForTests()).toBe(0);
  },20_000);

  it('one long holder plus nine Access callers: three wait, six are refused at once, unrelated work and login-style reads still respond',async()=>{
    const h=await holder();
    try{
      const callers=Array.from({length:9},()=>timed(()=>withTenant(ctx,tx=>lockAccessConfigurationTx(tx,ctx.tenantId))));
      await untilWaiters(h.pid,ACCESS_CONFIGURATION_MAX_WAITERS);
      expect(accessConfigurationLockWaitersForTests()).toBe(ACCESS_CONFIGURATION_MAX_WAITERS);
      // The pool still serves work that does not need the Access lock (the login path takes none).
      const unrelated=await timed(()=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{ok:number}>(sql`select 1 as ok`);return row.ok;}));
      expect(unrelated.error).toBeUndefined();expect(unrelated.value).toBe(1);expect(unrelated.ms).toBeLessThan(1000);
      const results=await Promise.all(callers);
      const refusedAtOnce=results.filter(r=>r.error instanceof AccessConfigurationBusyError);
      const timedOut=results.filter(r=>!(r.error instanceof AccessConfigurationBusyError)&&pgSqlState(r.error)==='55P03');
      expect(refusedAtOnce).toHaveLength(9-ACCESS_CONFIGURATION_MAX_WAITERS);
      expect(timedOut).toHaveLength(ACCESS_CONFIGURATION_MAX_WAITERS);
      for(const r of refusedAtOnce){expect(pgSqlState(r.error)).toBe('55P03');expect(r.ms).toBeLessThan(1000);}
      expect(await waitersOn(h.pid)).toBe(0);
      expect(accessConfigurationLockWaitersForTests()).toBe(0);
    }finally{h.release();await h.done;}
  },30_000);

  it('the clock-in dependency lock is bounded by the same rule instead of hanging',async()=>{
    const h=await holder();
    try{
      const r=await timed(()=>withTenant(ctx,tx=>lockAttendanceLeaveDependenciesTx(tx,ctx,[])));
      expect(pgSqlState(r.error)).toBe('55P03');
      expect(r.ms).toBeLessThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS+3000);
    }finally{h.release();await h.done;}
  },20_000);

  it('shared navigation reads are bounded too, and the try-first path never jumps a queued writer',async()=>{
    const h=await holder('shared');
    try{
      // A writer queues behind the shared holder.
      const writer=timed(()=>withTenant(ctx,tx=>lockAccessConfigurationTx(tx,ctx.tenantId)));
      await untilWaiters(h.pid,1);
      // A later shared reader must queue behind that writer rather than take the free shared slot.
      const reader=timed(()=>withTenant(ctx,tx=>lockAccessConfigurationReadTx(tx,ctx.tenantId)));
      for(let i=0;i<200&&accessConfigurationLockWaitersForTests()<2;i++)await new Promise(yes=>setTimeout(yes,10));
      expect(accessConfigurationLockWaitersForTests()).toBe(2);
      const [w,r]=await Promise.all([writer,reader]);
      // The writer times out against the long shared holder; only then may the reader share the lock.
      expect(pgSqlState(w.error)).toBe('55P03');
      expect(r.error).toBeUndefined();
      expect(r.ms).toBeGreaterThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS/2);
    }finally{h.release();await h.done;}
  },20_000);
});
