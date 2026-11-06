import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createDb} from '../db/client';
import {withBackgroundDatabaseWork} from '../db/workload';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
let base:Base;
const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','admission-'+randomUUID());
const database=createDb(url.toString(),{max:4});
beforeAll(async()=>{await migrateTestDb();await resetDb();base=await seedBase();});
afterAll(async()=>{await database.client.end();await closeAll();});
describe('physical pool admission with real tenant transactions',()=>{
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
