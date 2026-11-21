import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createDb} from '../db/client';
import {withBackgroundDatabaseWork,withDatabaseReadCancellation,withDatabaseReadDeadline,withIdempotentDatabaseRead} from '../db/workload';
import {takeRequestBudget} from '../lib/request-budget';
import {pgSqlState} from '../lib/db-error';
import postgres from 'postgres';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const random31=()=>Math.floor(Math.random()*2_000_000_000)+1;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
let base:Base;
const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','admission-'+randomUUID());
const database=createDb(url.toString(),{max:4});
const otherUrl=new URL(process.env.TEST_DATABASE_URL!);otherUrl.searchParams.set('application_name','admission-fair-'+randomUUID());
const fair=createDb(otherUrl.toString(),{max:4,admissionWaitMs:15000});
const pool=(name:string,max:number,admissionWaitMs?:number)=>{const u=new URL(process.env.TEST_DATABASE_URL!);u.searchParams.set('application_name',name+'-'+randomUUID());return createDb(u.toString(),{max,admissionWaitMs});};
const five=pool('admission-five',5),eight=pool('admission-eight',8,15000),deadline=pool('admission-deadline',4,300),retrying=pool('admission-retry',4,300);
const lockUrl=process.env.TEST_MIGRATION_DATABASE_URL!;
beforeAll(async()=>{await migrateTestDb();await resetDb();base=await seedBase();});
afterAll(async()=>{await Promise.all([database,fair,five,eight,deadline,retrying].map(db=>db.client.end()));await closeAll();});
describe('physical pool admission with real tenant transactions',()=>{
 it('shares bounded tenant write ordering across handles without holding a connection while waiting',async()=>{
  const alias=createDb(url.toString(),{max:4}),ctx=adminCtx(base),entered=deferred(),finish=deferred();
  const held=database.withTenantWriteWork(ctx.tenantId,async()=>{entered.resolve();await finish.promise;});
  await entered.promise;let queuedEntered=false;
  const next=alias.withTenantWriteWork(ctx.tenantId,()=>{queuedEntered=true;return alias.withTenant(ctx,async tx=>(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0]);});
  try{
   // Another logical tenant uses the idle lane. Its callback performs a real
   // authorized read, proving the first logical holder borrowed no connection.
   const row=await alias.withTenantWriteWork(randomUUID(),()=>alias.withTenant(ctx,async tx=>(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0]));
   expect(row.tenant).toBe(ctx.tenantId);expect(queuedEntered).toBe(false);
  }finally{finish.resolve();await held;}
  expect((await next).tenant).toBe(ctx.tenantId);expect(queuedEntered).toBe(true);
 });
 it('keeps 500 passive fan-outs outside the physical queue while interactive pages finish',async()=>{
  const ctx=adminCtx(base),held=deferred(),finish=deferred(),started=deferred();let operations=0;
  const holder=withBackgroundDatabaseWork(()=>database.withTenant(ctx,async tx=>{await tx.execute(sql`select 1`);held.resolve();await finish.promise;}));
  await held.promise;
  const first=database.withBackgroundReadWork(ctx.tenantId,async()=>{
   operations++;started.resolve();
   return database.withBackgroundReadWork(ctx.tenantId,()=>Promise.all(Array.from({length:8},()=>database.withTenant(ctx,async tx=>(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0]))));
  });
  await started.promise;
  const controllers=Array.from({length:499},()=>new AbortController()),reason=new Error('passive response left');
  const pending=controllers.map(controller=>database.withBackgroundReadWork(ctx.tenantId,async()=>{operations++;return database.withTenant(ctx,tx=>tx.execute(sql`select 1`));},controller.signal));
  const settled=Promise.allSettled(pending);
  try{
   const pages=await Promise.all(Array.from({length:3},()=>database.withTenant(ctx,async tx=>(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0])));
   expect(pages.every(row=>row.tenant===base.tenantId)).toBe(true);expect(operations).toBe(1);
   controllers.forEach(controller=>controller.abort(reason));
   const outcomes=await settled;expect(outcomes).toHaveLength(499);
   expect(outcomes.every(outcome=>outcome.status==='rejected'&&outcome.reason===reason)).toBe(true);
  }finally{controllers.forEach(controller=>controller.abort(reason));finish.resolve();await holder;}
  const rows=await first;expect(rows).toHaveLength(8);expect(rows.every(row=>row.tenant===base.tenantId)).toBe(true);
  expect(operations).toBe(1);
 });
 it('removes abandoned nested Home reads without cancelling another response or an executing transaction',async()=>{
  const ctx=adminCtx(base),entered=deferred(),finish=deferred();
  const holder=withBackgroundDatabaseWork(()=>database.withTenant(ctx,async()=>{entered.resolve();await finish.promise;}));
  await entered.promise;
  const controller=new AbortController(),reason=new Error('Home response disconnected');
  let queuedEntered=false,rawEntered=false;
  const pending=withDatabaseReadCancellation(controller.signal,()=>withBackgroundDatabaseWork(()=>database.withTenant(ctx,async()=>{queuedEntered=true;return 'abandoned';})));
  const raw=withDatabaseReadCancellation(controller.signal,()=>withBackgroundDatabaseWork(()=>database.withPoolWork(ctx.tenantId,async()=>{rawEntered=true;return 'abandoned';})));
  const other=withBackgroundDatabaseWork(()=>database.withTenant(ctx,async tx=>(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0]));
  const rejected=Promise.all([expect(pending).rejects.toBe(reason),expect(raw).rejects.toBe(reason)]);
  controller.abort(reason);
  try{await rejected;expect(queuedEntered).toBe(false);expect(rawEntered).toBe(false);}
  finally{finish.resolve();await holder;}
  expect((await other).tenant).toBe(base.tenantId);

  const activeController=new AbortController(),activeEntered=deferred(),release=deferred();
  const active=withDatabaseReadCancellation(activeController.signal,()=>database.withTenant(ctx,async tx=>{
   activeEntered.resolve();await release.promise;
   return (await tx.execute(sql`select app.current_tenant_id() as tenant`))[0];
  }));
  await activeEntered.promise;activeController.abort(reason);release.resolve();
  expect((await active).tenant).toBe(base.tenantId);
 });
 it('cancels a stuck statement at a Home read deadline, then frees its connection for the pool',async()=>{
  const ctx=adminCtx(base),deadline=new AbortController(),reason=new Error('Home card hard cap');
  const name=url.searchParams.get('application_name')!;
  const sleeping=async()=>(await owner.client`select count(*)::int as n from pg_stat_activity
   where application_name=${name} and state='active' and query like '%pg_sleep(60)%'`)[0].n as number;
  const started=performance.now();
  const stuck=withDatabaseReadDeadline(deadline.signal,()=>database.withTenant(ctx,tx=>tx.execute(sql`select pg_sleep(60)`)));
  const outcome=stuck.then(()=>'completed',(error:unknown)=>error);
  while(await sleeping()===0){
   expect(performance.now()-started).toBeLessThan(20000);
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  deadline.abort(reason);
  // PostgreSQL itself cancelled the running statement (Drizzle wraps the driver error as its cause).
  expect(await outcome).toMatchObject({cause:{code:'57014',message:'canceling statement due to user request'}});
  expect(performance.now()-started).toBeLessThan(30000);
  expect(await sleeping()).toBe(0);
  // Every slot of the four-connection pool is usable again, each on its own backend. Fair admission keeps one
  // permit for login, so three tenant transactions and one authentication-lane transaction fill the pool.
  const entered=Array.from({length:4},deferred),release=deferred();
  const pages=entered.slice(0,3).map(entry=>database.withTenant(ctx,async tx=>{
   const [row]=await tx.execute(sql`select app.current_tenant_id() as tenant,pg_backend_pid() as pid`);entry.resolve();await release.promise;return row;}));
  const login=database.withPoolWork('authentication',()=>database.client.begin(async sqlTx=>{
   const [row]=await sqlTx`select pg_backend_pid() as pid`;entered[3].resolve();await release.promise;return row.pid as number;}));
  await Promise.all(entered.map(entry=>entry.promise));release.resolve();
  const rows=await Promise.all(pages),loginPid=await login;
  expect(new Set([...rows.map(row=>row.pid),loginPid]).size).toBe(4);expect(rows.every(row=>row.tenant===base.tenantId)).toBe(true);

  // A statement requested after the deadline never reaches the connection.
  const late=new AbortController(),between=deferred(),resume=deferred();let secondRan=false;
  const pending=withDatabaseReadDeadline(late.signal,()=>database.withTenant(ctx,async tx=>{
   await tx.execute(sql`select 1`);between.resolve();await resume.promise;
   const row=await tx.execute(sql`select 2 as n`);secondRan=true;return row;}));
  await between.promise;late.abort(reason);resume.resolve();
  const refused=await pending.then(()=>null,(error:unknown)=>error as {cause?:unknown});
  expect(refused?.cause).toBe(reason);expect(secondRan).toBe(false);
  expect((await database.withTenant(ctx,tx=>tx.execute(sql`select app.current_tenant_id() as tenant`)))[0].tenant).toBe(base.tenantId);
 });
// A pool of 4 keeps one permit for login, so 1 background and 3 interactive transactions need a pool of 5.
 it('allows three independent interactive transactions while background work waits outside the five-slot pool',async()=>{
  const ctx=adminCtx(base),entered=deferred(),finish=deferred();
  const held=withBackgroundDatabaseWork(()=>five.withTenant(ctx,async tx=>{await tx.execute(sql`select 1`);entered.resolve();await finish.promise;}));
  await entered.promise;
  let backgroundEntered=false;
  const waiting=withBackgroundDatabaseWork(()=>five.withTenant(ctx,async tx=>{backgroundEntered=true;return(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0];}));
  const pageReleases=Array.from({length:3},deferred),pageEntered=Array.from({length:3},deferred);
  const pages=pageReleases.map((release,i)=>five.withTenant(ctx,async tx=>{const [row]=await tx.execute(sql`select app.current_tenant_id() as tenant,pg_backend_pid() as pid`);pageEntered[i].resolve();await release.promise;return row;}));
  try{
   await Promise.all(pageEntered.map(x=>x.promise));expect(backgroundEntered).toBe(false);
  }finally{pageReleases.forEach(x=>x.resolve());finish.resolve();}
  const rows=await Promise.all(pages);await held;const backgroundRow=await waiting;
  expect(new Set(rows.map(r=>r.pid)).size).toBe(3);expect(rows.every(r=>r.tenant===base.tenantId)).toBe(true);expect(backgroundRow.tenant).toBe(base.tenantId);
 });
 it('shares the same physical budget with raw connection owners and releases their failures',async()=>{
  const ctx=adminCtx(base),entered=deferred(),finish=deferred();
  const holding=withBackgroundDatabaseWork(()=>database.withTenant(ctx,async tx=>{await tx.execute(sql`select 1`);entered.resolve();await finish.promise;}));
  await entered.promise;
  const controller=new AbortController(),reason=new Error('raw work cancelled');let ran=false;
  const queued=withBackgroundDatabaseWork(()=>database.withPoolWork(ctx.tenantId,async()=>{ran=true;return database.client`select 1`;},controller.signal));
  const rejected=expect(queued).rejects.toBe(reason);controller.abort(reason);
  try{
   await rejected;expect(ran).toBe(false);
   const [raw]=await database.withPoolWork(ctx.tenantId,()=>database.client`select current_user as role`);
   expect(raw.role).toBe('ai_hr_app');
  }finally{finish.resolve();await holding;}
  await expect(database.withPoolWork(ctx.tenantId,()=>database.client`select 1/0`)).rejects.toMatchObject({code:'22012'});
  expect(await database.withPoolWork(ctx.tenantId,()=>Promise.resolve('released'))).toBe('released');
 });
 it('asks again for a refused permit, so a top-level write runs once instead of failing, but never retries nested work',async()=>{
  const ctx=adminCtx(base),finish=deferred(),entered=Array.from({length:3},deferred);
  // A pool of four keeps one permit for login, so these three hold every permit this tenant's work may use.
  const held=entered.map(entry=>retrying.withTenant(ctx,async()=>{entry.resolve();await finish.promise;}));
  await Promise.all(entered.map(entry=>entry.promise));
  let writes=0;
  const write=retrying.withTenant(ctx,async tx=>{writes++;return (await tx.execute(sql`select app.current_tenant_id() as tenant`))[0];});
  // The first request is refused at the 300 ms stall budget, which started nothing; the retry gets the freed permit.
  const freed=new Promise(resolve=>setTimeout(resolve,500)).then(()=>finish.resolve());
  expect((await write).tenant).toBe(base.tenantId);expect(writes).toBe(1);
  await freed;await Promise.all(held);

  // Code that already holds a permit keeps its single wait: a retry would keep that permit through the retry.
  const finishNested=deferred(),enteredNested=Array.from({length:2},deferred);
  const heldNested=enteredNested.map(entry=>retrying.withTenant(ctx,async()=>{entry.resolve();await finishNested.promise;}));
  await Promise.all(enteredNested.map(entry=>entry.promise));
  const started=performance.now();
  const nested=await retrying.withPoolWork(randomUUID(),()=>retrying.withTenant(ctx,async()=>'nested')).then(()=>'served',(error:{code?:string})=>error.code);
  const elapsed=performance.now()-started;
  finishNested.resolve();await Promise.all(heldNested);
  // One 300 ms wait; three retried requests would take at least 300 + 150 + 300 + 300 + 300 ms before the last refusal.
  expect(nested).toBe('queue-timeout');expect(elapsed).toBeLessThan(1200);
 });
 it('does not start an abandoned queued read and frees admission after rollback',async()=>{
  const ctx=adminCtx(base),finish=deferred(),entered=Array.from({length:4},deferred);
  const held=entered.map((entry)=>five.withTenant(ctx,async tx=>{await tx.execute(sql`select 1`);entry.resolve();await finish.promise;}));
  await Promise.all(entered.map(x=>x.promise));
  const controller=new AbortController(),reason=new Error('read disconnected');let ran=false;
  const pending=five.withTenant(ctx,async()=>{ran=true;},{readSignal:controller.signal});
  const rejected=expect(pending).rejects.toBe(reason);controller.abort(reason);
  try{await rejected;expect(ran).toBe(false);}finally{finish.resolve();await Promise.all(held);}
  await expect(five.withTenant(ctx,async tx=>{await tx.execute(sql`select 1/0`);})).rejects.toThrow();
  const [row]=await five.withTenant(ctx,tx=>tx.execute(sql`select app.current_tenant_id() as tenant`));
  expect(row.tenant).toBe(base.tenantId);
 });
});

describe('fair admission with real PostgreSQL lock waiters',()=>{
 it("holds one tenant's lock waiters to its share while another tenant has work, and login still starts",async()=>{
  const lockSql=postgres(lockUrl,{max:1,onnotice:()=>{}}),key=random31();
  await lockSql`select pg_advisory_lock(${key})`;
  const hot=randomUUID(),other=randomUUID(),events:string[]=[],entered=deferred(),finish=deferred();
  const waitingCount=async()=>Number((await lockSql`select count(*) from pg_locks where locktype='advisory' and objid=${key} and not granted`)[0].count);
  // Pool of 8: a fair share of 5. The other tenant is already running, so the share binds.
  const running=eight.withTenant({tenantId:other,userId:randomUUID()},async tx=>{await tx.execute(sql`select 1`);entered.resolve();await finish.promise;});
  await entered.promise;
  const waiters=Array.from({length:8},(_,i)=>eight.withTenant({tenantId:hot,userId:randomUUID()},async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(${key})`);events.push('hot'+i);return i;
  }));
  try{
   await vi.waitFor(async()=>expect(await waitingCount()).toBe(5),{timeout:5000});
   // Exactly five reached PostgreSQL; the other three wait in admission holding no connection.
   const started=performance.now();
   const [tenant]=await eight.withTenant({tenantId:other,userId:randomUUID()},tx=>tx.execute(sql`select app.current_tenant_id() as tenant`));
   expect(tenant.tenant).toBe(other);
   const [login]=await eight.withPoolWork('authentication',()=>eight.client`select current_user as role`);
   expect(login.role).toBe('ai_hr_app');
   expect(performance.now()-started).toBeLessThan(2500);
   expect(await waitingCount()).toBe(5);
  }finally{
   await lockSql`select pg_advisory_unlock(${key})`;finish.resolve();
   await Promise.all([running,...waiters]);
   await lockSql`select pg_advisory_unlock_all()`;await lockSql.end({timeout:5});
  }
  expect(events.length).toBe(8);
 },20_000);
 it('lets a lone tenant use every connection except the login reserve, then serves an arriving tenant first',async()=>{
  const hot=randomUUID(),other=randomUUID();
  const holds=Array.from({length:3},()=>({entered:deferred(),finish:deferred()}));
  // Pool of 4 with a fair share of 2: alone, the tenant still holds three real connections.
  const running=holds.map(hold=>fair.withTenant({tenantId:hot,userId:randomUUID()},async tx=>{
   const [row]=await tx.execute(sql`select pg_backend_pid() as pid`);hold.entered.resolve();await hold.finish.promise;return row.pid;
  }));
  await Promise.all(holds.map(hold=>hold.entered.promise));
  let queuedHotEntered=false,otherEntered=false;const otherDone=deferred(),otherRunning=deferred();
  const queuedHot=fair.withTenant({tenantId:hot,userId:randomUUID()},async tx=>{queuedHotEntered=true;return (await tx.execute(sql`select 1 as ok`))[0];});
  const arriving=fair.withTenant({tenantId:other,userId:randomUUID()},async tx=>{otherEntered=true;const [row]=await tx.execute(sql`select app.current_tenant_id() as tenant`);otherRunning.resolve();await otherDone.promise;return row;});
  try{
   const [login]=await fair.withPoolWork('authentication',()=>fair.client`select 1 as ok`);
   expect(login.ok).toBe(1);expect(otherEntered).toBe(false);
   holds[0].finish.resolve();
   await otherRunning.promise;
   // One hot transaction ended: the arriving tenant went first, and the hot tenant is held at its share.
   expect(otherEntered).toBe(true);expect(queuedHotEntered).toBe(false);
  }finally{holds.forEach(hold=>hold.finish.resolve());otherDone.resolve();}
  const pids=await Promise.all(running);expect(new Set(pids).size).toBe(3);
  expect((await arriving).tenant).toBe(other);expect((await queuedHot).ok).toBe(1);
 },20_000);
 it('bounds a raw login query with a deadline instead of waiting in the driver queue',async()=>{
  const finish=deferred(),entered=[deferred(),deferred()];
  // Pool of 4 allows two authentication permits; hold both.
  const held=entered.map(e=>deadline.withPoolWork('authentication',async()=>{e.resolve();await finish.promise;}));
  await Promise.all(entered.map(e=>e.promise));
  const raw=deadline.withPoolWork('authentication',()=>deadline.client`select 1`);
  await expect(raw).rejects.toMatchObject({name:'DatabaseAdmissionError',code:'queue-timeout'});
  finish.resolve();await Promise.all(held);
 });
 it('admits the raw request-budget query on the reserved login permit while tenants hold the rest',async()=>{
  const app=await import('../db/client');
  const finish=deferred();
  // Default pool of 10: 6 for one tenant, 2 for another, leaving only the 2 reserved login permits.
  const holders=[...Array.from({length:6},()=>app.withPoolWork('hot-tenant',()=>finish.promise)),...Array.from({length:2},()=>app.withPoolWork('other-tenant',()=>finish.promise))];
  try{await expect(takeRequestBudget(['admission-test',randomUUID()],5,60)).resolves.toBeUndefined();}
  finally{finish.resolve();await Promise.all(holders);}
 });
 it('retries a cancelled read invisibly and never retries a write',async()=>{
  const ctx=adminCtx(base);let reads=0;
  const rows=await database.withTenant(ctx,async tx=>{
   reads++;
   if(reads===1){await tx.execute(sql`set local statement_timeout='50ms'`);await tx.execute(sql`select pg_sleep(3)`);}
   return tx.execute(sql`select app.current_tenant_id() as tenant`);
  },{readOnlySnapshot:true});
  expect(reads).toBe(2);expect(rows[0].tenant).toBe(base.tenantId);
  let writes=0;
  const failure=await database.withTenant(ctx,async tx=>{writes++;await tx.execute(sql`set local statement_timeout='50ms'`);await tx.execute(sql`select pg_sleep(3)`);}).catch(error=>error);
  expect(writes).toBe(1);expect(pgSqlState(failure)).toBe('57014');
  expect((failure as {digest?:string}).digest).toBe('AIHR_DATABASE_CAPACITY');
 });
 it('retries a declared read operation but not an undeclared plain transaction',async()=>{
  const ctx=adminCtx(base);let attempts=0;
  const result=await withIdempotentDatabaseRead(()=>database.withTenant(ctx,async tx=>{
   attempts++;
   if(attempts===1){await tx.execute(sql`set local statement_timeout='50ms'`);await tx.execute(sql`select pg_sleep(3)`);}
   return (await tx.execute(sql`select 1 as ok`))[0];
  }));
  expect(attempts).toBe(2);expect(result.ok).toBe(1);
 });
});
