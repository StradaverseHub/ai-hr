import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createDb} from '../db/client';
import {withBackgroundDatabaseWork,withDatabaseReadCancellation} from '../db/workload';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
let base:Base;
const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','admission-'+randomUUID());
const database=createDb(url.toString(),{max:4});
beforeAll(async()=>{await migrateTestDb();await resetDb();base=await seedBase();});
afterAll(async()=>{await database.client.end();await closeAll();});
describe('physical pool admission with real tenant transactions',()=>{
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
