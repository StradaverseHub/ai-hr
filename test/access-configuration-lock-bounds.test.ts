/** Production incident, 10 November 2026: one long Access holder must not hang the whole process.
 * Fictional fixtures only. Reproduces one long exclusive holder plus many Access callers on the app pool
 * and checks that waits are bounded, every waiter either acquires or times out at the bound (the per-process
 * waiter cap was removed on 11 November 2026; db/admission.ts owns connection capacity), unrelated work and
 * the clock-in dependency lock respond within bounds, and lock_timeout is restored on the success path. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import {
  ACCESS_CONFIGURATION_LOCK_WAIT_MS,lockAccessConfigurationReadTx,lockAccessConfigurationTx,
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
/** Requests still queued (not granted) on this tenant's Access key, whoever they wait behind. */
async function queuedOnKey(){const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from pg_catalog.pg_locks l
  cross join (select hashtextextended(${'access-configuration:'+ctx.tenantId},0) as k) target
  where l.locktype='advisory' and not l.granted and l.objsubid=1
    and l.classid::bigint=((target.k>>32)&4294967295) and l.objid::bigint=(target.k&4294967295)`);return row.n;}
async function untilQueued(n:number){for(let i=0;i<200;i++){if(await queuedOnKey()>=n)return;await new Promise(yes=>setTimeout(yes,10));}throw Error(`Expected ${n} queued Access requests`);}
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
  });

  it('a waiter gives up with the retryable 55P03 after the bound, and its connection returns to the pool',async()=>{
    const h=await holder();
    try{
      const r=await timed(()=>withTenant(ctx,tx=>lockAccessConfigurationTx(tx,ctx.tenantId)));
      expect(pgSqlState(r.error)).toBe('55P03');
      expect(r.ms).toBeGreaterThanOrEqual(ACCESS_CONFIGURATION_LOCK_WAIT_MS-250);
      expect(r.ms).toBeLessThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS+3000);
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
  },20_000);

  it('an exclusive holder re-entering through a shared reader is admitted at once while others queue',async()=>{
    let ready!:()=>void,release!:()=>void;
    const holding=new Promise<void>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});
    let pid=0,reentered:{error:unknown;ms:number}|undefined;
    const holderTx=withTenant(ctx,async tx=>{
      await lockAccessConfigurationTx(tx,ctx.tenantId);
      [{pid}]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready();await finish;
      // Three exclusive callers are now queued behind this transaction.
      reentered=await timed(()=>lockAccessConfigurationReadTx(tx,ctx.tenantId));
    });
    await holding;
    const queued=Array.from({length:3},()=>timed(()=>withTenant(ctx,tx=>lockAccessConfigurationTx(tx,ctx.tenantId))));
    try{await untilWaiters(pid,3);}finally{release();}
    await holderTx;
    expect(reentered?.error).toBeUndefined();expect(reentered?.ms).toBeLessThan(1000);
    for(const r of await Promise.all(queued))expect(r.error).toBeUndefined();
  },20_000);

  it('many waiters on a held lock each acquire or time out at the bound, and unrelated reads keep running',async()=>{
    // Stay inside the admission layer's pool capacity: one holder plus every other connection but one, so the
    // measured unrelated read is admitted at once while all of these callers are genuinely waiting.
    const many=client.options.max-2;
    expect(many).toBeGreaterThanOrEqual(3);
    const longHolder=await holder();
    try{
      const callers=Array.from({length:many},()=>timed(()=>withTenant(ctx,tx=>lockAccessConfigurationTx(tx,ctx.tenantId))));
      await untilWaiters(longHolder.pid,many);
      const unrelated=await timed(()=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{ok:number}>(sql`select 1 as ok`);return row.ok;}));
      expect(unrelated.error).toBeUndefined();expect(unrelated.value).toBe(1);expect(unrelated.ms).toBeLessThan(1000);
      // Nobody is refused before the bound: each waiter times out at it with the retryable 55P03.
      for(const r of await Promise.all(callers)){
        expect(pgSqlState(r.error)).toBe('55P03');
        expect(r.ms).toBeGreaterThanOrEqual(ACCESS_CONFIGURATION_LOCK_WAIT_MS-250);
        expect(r.ms).toBeLessThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS+3000);
      }
      expect(await waitersOn(longHolder.pid)).toBe(0);
    }finally{longHolder.release();await longHolder.done;}
    // The same number of waiters behind a short holder all acquire, with lock_timeout restored.
    const shortHolder=await holder();
    const acquired=Array.from({length:many},()=>timed(()=>withTenant(ctx,async tx=>{
      await lockAccessConfigurationTx(tx,ctx.tenantId);
      const [row]=await tx.execute<{v:string}>(sql`select current_setting('lock_timeout') as v`);return row.v;
    })));
    await untilWaiters(shortHolder.pid,many);shortHolder.release();await shortHolder.done;
    for(const r of await Promise.all(acquired)){expect(r.error).toBeUndefined();expect(r.value).toBe('0');}
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
      await untilQueued(2);
      expect(await queuedOnKey()).toBe(2);
      const [w,r]=await Promise.all([writer,reader]);
      // The writer times out against the long shared holder; only then may the reader share the lock.
      expect(pgSqlState(w.error)).toBe('55P03');
      expect(r.error).toBeUndefined();
      expect(r.ms).toBeGreaterThan(ACCESS_CONFIGURATION_LOCK_WAIT_MS/2);
    }finally{h.release();await h.done;}
  },20_000);
});
