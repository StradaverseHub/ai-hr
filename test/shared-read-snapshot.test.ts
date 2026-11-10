/** One request's shared read-only snapshot (db/shared-read.ts, db/client.ts withSharedReadSnapshot).
 *
 * Proves the contract the Home stream and Today sections rely on: the same identity joins one REPEATABLE READ READ
 * ONLY transaction; any other identity, tenant or request never does; an owner needing another transaction contract
 * (barrier lock, read-committed probe, setting, write) reruns in its own transaction with its original result, even
 * when it swallows the refusal; a database error aborts only the shared transaction and every affected owner reruns;
 * repeated identical reads are answered from the first execution as independent copies, within one request only. */
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {withIndependentTransactions,withSharedReadSnapshot,withTenant,type SessionContext,type Tx} from '../db/client';
import {classifySharedStatement,type SharedReadStats} from '../db/shared-read';
import {withDatabaseReadDeadline} from '../db/workload';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let a:Base,b:Base,ctxA:SessionContext,ctxB:SessionContext;
const sessions:SharedReadStats[]=[];
const hooks=globalThis as {__aihrPerfSharedRead?:(stats:SharedReadStats)=>void};
beforeAll(async()=>{
 await migrateTestDb();await resetDb();a=await seedBase();b=await seedBase();
 ctxA=adminCtx(a);ctxB=adminCtx(b);
 hooks.__aihrPerfSharedRead=stats=>{sessions.push(stats);};
});
afterEach(()=>{sessions.length=0;});
afterAll(async()=>{delete hooks.__aihrPerfSharedRead;await closeAll();});

type Probe={at:string;iso:string;pid:number;tenant:string;companies:string[]};
async function probeTx(tx:Tx,tag:string):Promise<Probe>{
 const [row]=await tx.execute(sql`select now()::text as at,current_setting('transaction_isolation') as iso,pg_backend_pid() as pid,
  current_setting('app.tenant_id',true) as tenant,${tag}::text as tag`) as unknown as {at:string;iso:string;pid:number;tenant:string}[];
 const companies=await tx.execute(sql`select id::text as id from company order by id`) as unknown as {id:string}[];
 return {at:row.at,iso:row.iso,pid:Number(row.pid),tenant:row.tenant,companies:companies.map(company=>company.id)};
}
const probe=(ctx:SessionContext,tag:string)=>withTenant(ctx,tx=>probeTx(tx,tag));

describe('shared read snapshot',()=>{
 it('joins every read of one identity into one read-only snapshot',async()=>{
  const [one,two]=await withSharedReadSnapshot(ctxA,()=>Promise.all([probe(ctxA,'one'),probe(ctxA,'two')]));
  expect(one.iso).toBe('repeatable read');
  expect([two.at,two.pid,two.iso]).toEqual([one.at,one.pid,one.iso]);
  expect(one.companies).toEqual([a.companyId]);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].joins).toBe(2);
  expect(sessions[0].fallbacks).toBe(0);
 });

 it('never lets another tenant, user or grant set join, and their rows stay their own',async()=>{
  const otherRoles={...ctxA,roles:['employee'],grants:undefined};
  const [own,otherTenant,otherGrants]=await withSharedReadSnapshot(ctxA,()=>Promise.all([probe(ctxA,'own'),probe(ctxB,'tenant'),probe(otherRoles,'grants')]));
  expect(own.iso).toBe('repeatable read');
  for(const foreign of [otherTenant,otherGrants]){
   expect(foreign.iso).toBe('read committed');
   expect(foreign.pid).not.toBe(own.pid);
  }
  expect(otherTenant.tenant).toBe(b.tenantId);
  expect(otherTenant.companies).toEqual([b.companyId]);
  expect(own.companies).toEqual([a.companyId]);
  expect(sessions[0].joins).toBe(1);
  // Each foreign result is exactly what that context reads on its own.
  const independent=await probe(ctxB,'tenant');
  expect({...otherTenant,at:null,pid:null}).toEqual({...independent,at:null,pid:null});
 });

 it('reruns an owner that needs a barrier lock, read committed, a setting or a write in its own transaction',async()=>{
  const owners=[
   ['barrier',sql`select pg_advisory_xact_lock_shared(hashtextextended('shared-read-test',0))`],
   ['readCommitted',sql`select current_setting('transaction_isolation')='read committed' as rc`],
   ['setting',sql`select set_config('app.shared_read_test','1',true)`],
   ['control',sql`set local statement_timeout = '5s'`],
  ] as const;
  for(const [reason,statement] of owners){
   sessions.length=0;
   const shared=await withSharedReadSnapshot(ctxA,()=>withTenant(ctxA,async tx=>{await tx.execute(statement);return probeTx(tx,reason);}));
   const independent=await withTenant(ctxA,async tx=>{await tx.execute(statement);return probeTx(tx,reason);});
   expect(shared.iso,reason).toBe('read committed');
   expect({...shared,at:null,pid:null}).toEqual({...independent,at:null,pid:null});
   expect(sessions[0].fallbacks,reason).toBe(1);
   expect(sessions[0].refused[reason],reason).toBe(1);
  }
 });

 it('a refusal the owner swallows still reruns the whole owner, so it cannot change the result',async()=>{
  const owner=async(tx:Tx)=>{
   let refused=false;
   try{await tx.execute(sql`select set_config('app.shared_read_test','1',true)`);}catch{refused=true;}
   const [row]=await tx.execute(sql`select current_setting('app.shared_read_test',true) as value`) as unknown as {value:string|null}[];
   return {refused,value:row?.value??null};
  };
  const shared=await withSharedReadSnapshot(ctxA,()=>withTenant(ctxA,owner));
  expect(shared).toEqual(await withTenant(ctxA,owner));
  expect(shared).toEqual({refused:false,value:'1'});
 });

 it('a database error fails only its owner; siblings and later owners rerun independently',async()=>{
  const [error,sibling,later]=await withSharedReadSnapshot(ctxA,async()=>{
   const results=await Promise.allSettled([withTenant(ctxA,tx=>tx.execute(sql`select 1/0 as never`)),probe(ctxA,'sibling')]);
   return [results[0],results[1],await probe(ctxA,'later')] as const;
  });
  expect(error.status).toBe('rejected');
  const independentError=await withTenant(ctxA,tx=>tx.execute(sql`select 1/0 as never`)).then(()=>null,cause=>cause);
  const code=(cause:unknown)=>(cause as {code?:string;cause?:{code?:string}}).code??(cause as {cause?:{code?:string}}).cause?.code;
  expect(code((error as PromiseRejectedResult).reason)).toBe(code(independentError));
  expect(code(independentError)).toBe('22012');
  expect(sibling.status).toBe('fulfilled');
  expect((sibling as PromiseFulfilledResult<Probe>).value.companies).toEqual([a.companyId]);
  expect(later.iso).toBe('read committed');
  expect(sessions[0].fallbacks).toBeGreaterThanOrEqual(2);
 });

 it('answers a repeated read from its first execution with an independent copy',async()=>{
  const read=()=>withTenant(ctxA,async tx=>(await tx.execute(sql`select json_build_object('k',1,'list',json_build_array(1,2)) as v,now()::text as at`)) as unknown as {v:{k:number;list:number[]};at:string}[]);
  const [first,second]=await withSharedReadSnapshot(ctxA,async()=>{
   const first=await read();
   first[0].v.k=99;first[0].v.list.push(3);first[0].at='changed';first.push(first[0]);
   return [first,await read()] as const;
  });
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(1);
  expect(second[0].v).toEqual({k:1,list:[1,2]});
  expect(second[0].at).not.toBe('changed');
  expect(sessions[0].memoHits).toBe(1);
  expect(sessions[0].statements).toBe(1);
 });

 it('keeps nothing between requests and can be switched off for equivalence proofs',async()=>{
  const first=await withSharedReadSnapshot(ctxA,()=>probe(ctxA,'request'));
  const second=await withSharedReadSnapshot(ctxA,()=>probe(ctxA,'request'));
  expect(second.at).not.toBe(first.at);
  expect(sessions.map(stats=>stats.statements)).toEqual([2,2]);
  const off=await withIndependentTransactions(()=>withSharedReadSnapshot(ctxA,()=>probe(ctxA,'off')));
  expect(off.iso).toBe('read committed');
  expect(sessions).toHaveLength(2);
 });

 it('joins only owners under the snapshot\'s own hard read deadline; any other deadline keeps its own transaction',async()=>{
  const cap=new AbortController(),other=new AbortController();
  const [own,foreign]=await withDatabaseReadDeadline(cap.signal,()=>withSharedReadSnapshot(ctxA,()=>Promise.all([
   probe(ctxA,'own'),withDatabaseReadDeadline(other.signal,()=>probe(ctxA,'other deadline'))])));
  expect(own.iso).toBe('repeatable read');
  expect(foreign.iso).toBe('read committed');expect(foreign.pid).not.toBe(own.pid);
  expect(foreign.companies).toEqual(own.companies);
  expect(sessions[0].joins).toBe(1);
  sessions.length=0;
  const [plain,capped]=await withSharedReadSnapshot(ctxA,()=>Promise.all([
   probe(ctxA,'no deadline'),withDatabaseReadDeadline(other.signal,()=>probe(ctxA,'capped'))]));
  expect(plain.iso).toBe('repeatable read');
  expect(capped.iso).toBe('read committed');expect(capped.pid).not.toBe(plain.pid);
  expect(sessions[0].joins).toBe(1);
 });

 it('cancels the shared carrier\'s running statement at the snapshot\'s deadline and releases its connection',async()=>{
  const deadline=new AbortController(),reason=new Error('Fictional Home card hard cap');
  const sleeping=async()=>(await owner.client`select count(*)::int as n from pg_stat_activity
   where datname=current_database() and pid<>pg_backend_pid() and state='active' and query like '%pg_sleep(60)%'`)[0].n as number;
  const started=performance.now();
  const stuck=withDatabaseReadDeadline(deadline.signal,()=>withSharedReadSnapshot(ctxA,()=>
   withTenant(ctxA,tx=>tx.execute(sql`select pg_sleep(60)`))));
  const outcome=stuck.then(()=>'completed',(error:unknown)=>error);
  while(await sleeping()===0){
   expect(performance.now()-started).toBeLessThan(20000);
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  deadline.abort(reason);
  // The carrier's statement is cancelled by PostgreSQL; the owner's rerun is refused at the same deadline.
  expect(await outcome).not.toBe('completed');
  expect(performance.now()-started).toBeLessThan(30000);
  expect(await sleeping()).toBe(0);
  expect(sessions[0].failures['57014']).toBe(1);
  // The snapshot settled only after its carrier finished, so its connection is free for an ordinary read.
  expect((await probe(ctxA,'after')).companies).toEqual([a.companyId]);
 });

 it('classifies statements conservatively',()=>{
  const kind=(query:string)=>{const result=classifySharedStatement(query);return result.kind==='refuse'?'refuse:'+result.reason:result.kind;};
  expect(kind('select "id" from "employment" where "employment"."id" = $1')).toBe('memo');
  expect(kind('with a as (select 1) select * from a')).toBe('memo');
  expect(kind('select "updated_at" from "notice"')).toBe('memo');
  expect(kind('set local jit=off')).toBe('pass');
  expect(kind('SET TRANSACTION READ ONLY')).toBe('pass');
  expect(kind('select clock_timestamp()')).toBe('pass');
  expect(kind('select pg_advisory_xact_lock_shared(hashtextextended($1,0))')).toBe('refuse:barrier');
  expect(kind("select current_setting('transaction_isolation')='read committed' as safe")).toBe('refuse:readCommitted');
  expect(kind("select set_config('app.x', $1, true)")).toBe('refuse:setting');
  expect(kind('select * from "leave_request" where id=$1 for update')).toBe('refuse:rowLock');
  expect(kind('with moved as (delete from x returning id) select id from moved')).toBe('refuse:write');
  expect(kind('with x as (update "notice" set "title" = $1 returning id) select id from x')).toBe('refuse:write');
  expect(kind('select nextval($1)')).toBe('refuse:write');
  expect(kind('select app.reward_access_observe(NULL::uuid)')).toBe('refuse:write');
  expect(kind('insert into x values (1)')).toBe('refuse:control');
  expect(kind('set statement_timeout = 0')).toBe('refuse:control');
  expect(kind('begin')).toBe('refuse:control');
 });
});
