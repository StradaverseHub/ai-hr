/** JIT is off in every tenant transaction (db/client.ts bootstrapTenantTx), set in the identity statement itself.
 *
 * Staging, 11 Nov 2026: row-level security makes the planner's cost estimates large, and PostgreSQL's JIT then compiled
 * hundreds of functions per statement (one Audit loop read 1,270 ms with JIT and 11 ms without; the Approvals leave list
 * about 700 ms against 22-34 ms). Pinned here:
 *  - a tenant transaction, a read-only snapshot and a shared read carrier all run with jit=off;
 *  - the setting is transaction-local: on the same connection, a session that had JIT on has it on again after the
 *    tenant transaction commits or rolls back (so a pooled server connection hands nothing to the next client;
 *    test/pgbouncer-transaction-pool.test.ts checks the same through a real PgBouncer in transaction mode);
 *  - it costs no round trip: BEGIN, the one identity statement, then the caller;
 *  - an owner may still switch JIT on for its own transaction. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client,createDb,withSharedReadSnapshot,withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';

let b:Base;
let ctx:SessionContext;
const jitOf=async(tx:{execute:(query:ReturnType<typeof sql>)=>Promise<unknown>})=>
 ((await tx.execute(sql`select current_setting('jit') as jit,pg_backend_pid() as pid`)) as {jit:string;pid:number}[])[0]!;

beforeAll(async()=>{await migrateTestDb();await resetDb();b=await seedBase();ctx=adminCtx(b);});
afterAll(closeAll);

describe('JIT off in every tenant transaction', ()=>{
 it('a tenant transaction, a read-only snapshot and a shared read carrier all run without JIT', async()=>{
  expect((await withTenant(ctx,jitOf)).jit).toBe('off');
  expect((await withTenant(ctx,jitOf,{readOnlySnapshot:true})).jit).toBe('off');
  const shared=await withSharedReadSnapshot(ctx,()=>withTenant(ctx,jitOf));
  expect(shared.jit).toBe('off');
 });

 it('is transaction-local: the connection has JIT on again after commit and after rollback', async()=>{
  // A pool of one connection of its own, so every statement below runs on the same backend.
  const url=new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('application_name','with-tenant-jit-off');
  const pool=createDb(url.toString(),{max:1});
  try{
   await pool.client`set jit = on`;
   const [before]=await pool.client<{jit:string;pid:number}[]>`select current_setting('jit') as jit,pg_backend_pid() as pid`;
   expect(before!.jit).toBe('on');
   const inside=await pool.withTenant(ctx,jitOf);
   expect(inside).toEqual({jit:'off',pid:before!.pid});
   const [afterCommit]=await pool.client<{jit:string;pid:number}[]>`select current_setting('jit') as jit,pg_backend_pid() as pid`;
   expect(afterCommit).toEqual({jit:'on',pid:before!.pid});
   const failure=new Error('fictional rollback');
   await expect(pool.withTenant(ctx,async tx=>{expect((await jitOf(tx)).jit).toBe('off');throw failure;})).rejects.toBe(failure);
   const [afterRollback]=await pool.client<{jit:string;pid:number}[]>`select current_setting('jit') as jit,pg_backend_pid() as pid`;
   expect(afterRollback).toEqual({jit:'on',pid:before!.pid});
  }finally{await pool.client.end({timeout:5});}
 });

 it('costs no round trip: BEGIN, the one identity statement that also switches JIT off, then the caller', async()=>{
  const options=client.options as {debug?:unknown};
  const previous=options.debug;
  const sent:{connection:number;text:string}[]=[];
  options.debug=(connection:number,text:string)=>{sent.push({connection,text:text.replace(/\s+/g,' ').trim()});};
  try{await withTenant(ctx,async tx=>{await tx.execute(sql`select 'jit-off-caller' as marker`);});}
  finally{options.debug=previous;}
  const callerAt=sent.findIndex(q=>q.text.includes("'jit-off-caller'"));
  const own=sent.filter(q=>q.connection===sent[callerAt]!.connection).map(q=>q.text);
  const begin=own.findIndex(text=>/^begin\b/i.test(text)),caller=own.findIndex(text=>text.includes("'jit-off-caller'"));
  const bootstrap=own.slice(begin+1,caller);
  expect(bootstrap).toHaveLength(1);
  expect(bootstrap[0]).toContain("set_config('app.tenant_id'");
  expect(bootstrap[0]).toContain("set_config('jit', 'off', true)");
 });

 it('lets an owner switch JIT on for its own transaction only', async()=>{
  const own=await withTenant(ctx,async tx=>{await tx.execute(sql`set local jit=on`);return jitOf(tx);});
  expect(own.jit).toBe('on');
  expect((await withTenant(ctx,jitOf)).jit).toBe('off');
 });
});
