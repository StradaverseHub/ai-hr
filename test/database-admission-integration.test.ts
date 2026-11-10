import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createDb} from '../db/client';
import {withBackgroundDatabaseWork,withDatabaseReadCancellation,withIdempotentDatabaseRead} from '../db/workload';
import {takeRequestBudget} from '../lib/request-budget';
import {pgSqlState} from '../lib/db-error';
import postgres from 'postgres';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
const random31=()=>Math.floor(Math.random()*2_000_000_000)+1;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
let base:Base;
const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','admission-'+randomUUID());
const database=createDb(url.toString(),{max:4});
const otherUrl=new URL(process.env.TEST_DATABASE_URL!);otherUrl.searchParams.set('application_name','admission-fair-'+randomUUID());
const fair=createDb(otherUrl.toString(),{max:4,admissionWaitMs:300});
const lockUrl=process.env.TEST_MIGRATION_DATABASE_URL!;
beforeAll(async()=>{await migrateTestDb();await resetDb();base=await seedBase();});
afterAll(async()=>{await database.client.end();await fair.client.end();await closeAll();});
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
 it('allows three independent interactive transactions while background work waits outside the four-slot pool',async()=>{
  const ctx=adminCtx(base),entered=deferred(),finish=deferred();
  const held=withBackgroundDatabaseWork(()=>database.withTenant(ctx,async tx=>{await tx.execute(sql`select 1`);entered.resolve();await finish.promise;}));
  await entered.promise;
  let backgroundEntered=false;
  const waiting=withBackgroundDatabaseWork(()=>database.withTenant(ctx,async tx=>{backgroundEntered=true;return(await tx.execute(sql`select app.current_tenant_id() as tenant`))[0];}));
  const pageReleases=Array.from({length:3},deferred),pageEntered=Array.from({length:3},deferred);
  const pages=pageReleases.map((release,i)=>database.withTenant(ctx,async tx=>{const [row]=await tx.execute(sql`select app.current_tenant_id() as tenant,pg_backend_pid() as pid`);pageEntered[i].resolve();await release.promise;return row;}));
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
 it('does not start an abandoned queued read and frees admission after rollback',async()=>{
  const ctx=adminCtx(base),finish=deferred(),entered=Array.from({length:4},deferred);
  const held=entered.map((entry)=>database.withTenant(ctx,async tx=>{await tx.execute(sql`select 1`);entry.resolve();await finish.promise;}));
  await Promise.all(entered.map(x=>x.promise));
  const controller=new AbortController(),reason=new Error('read disconnected');let ran=false;
  const pending=database.withTenant(ctx,async()=>{ran=true;},{readSignal:controller.signal});
  const rejected=expect(pending).rejects.toBe(reason);controller.abort(reason);
  try{await rejected;expect(ran).toBe(false);}finally{finish.resolve();await Promise.all(held);}
  await expect(database.withTenant(ctx,async tx=>{await tx.execute(sql`select 1/0`);})).rejects.toThrow();
  const [row]=await database.withTenant(ctx,tx=>tx.execute(sql`select app.current_tenant_id() as tenant`));
  expect(row.tenant).toBe(base.tenantId);
 });
});

describe('fair admission with real PostgreSQL lock waiters',()=>{
 it("does not let one tenant's lock waiters starve another tenant or login",async()=>{
  const lockSql=postgres(lockUrl,{max:1,onnotice:()=>{}}),key=random31();
  await lockSql`select pg_advisory_lock(${key})`;
  const hot=randomUUID(),other=randomUUID(),events:string[]=[];
  try{
   // Pool of 4: formula gives this tenant 2 connections, keeps 1 for other tenants and 1 for login.
   const waiters=Array.from({length:6},(_,i)=>fair.withTenant({tenantId:hot,userId:randomUUID()},async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(${key})`);events.push('hot'+i);return i;
   }));
   const waitingCount=async()=>Number((await lockSql`select count(*) from pg_locks where locktype='advisory' and objid=${key} and not granted`)[0].count);
   await vi.waitFor(async()=>expect(await waitingCount()).toBe(2),{timeout:5000});
   // Exactly two reached PostgreSQL; the other four wait in admission holding no connection.
   const started=performance.now();
   const [tenant]=await fair.withTenant({tenantId:other,userId:randomUUID()},tx=>tx.execute(sql`select app.current_tenant_id() as tenant`));
   expect(tenant.tenant).toBe(other);
   const [login]=await fair.withPoolWork('authentication',()=>fair.client`select current_user as role`);
   expect(login.role).toBe('ai_hr_app');
   expect(performance.now()-started).toBeLessThan(2500);
   expect(await waitingCount()).toBe(2);
   await lockSql`select pg_advisory_unlock(${key})`;
   await Promise.all(waiters);
   expect(events.length).toBe(6);
  }finally{await lockSql`select pg_advisory_unlock_all()`;await lockSql.end({timeout:5});}
 },20_000);
 it('bounds a raw login query with a deadline instead of waiting in the driver queue',async()=>{
  const finish=deferred(),entered=[deferred(),deferred()];
  // Pool of 4 allows two authentication permits; hold both.
  const held=entered.map(e=>fair.withPoolWork('authentication',async()=>{e.resolve();await finish.promise;}));
  await Promise.all(entered.map(e=>e.promise));
  const raw=fair.withPoolWork('authentication',()=>fair.client`select 1`);
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
