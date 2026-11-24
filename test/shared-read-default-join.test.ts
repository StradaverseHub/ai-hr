/** ADR 0181 decision 2, plan package 1.1: during a server render, a `withTenant` read inside no shared session joins
 * its identity's session of the render's request read scope by default (db/client.ts, db/shared-read.ts
 * defaultRequestReadScope).
 *
 * Proves: one identity's reads of one render share one REPEATABLE READ READ ONLY carrier; without a request scope
 * (a route handler, an action, a job, a test that models no render) every read keeps its own transaction exactly as
 * before; another identity, an agent, a login-less context or another hard read deadline never joins; every refusal
 * still reruns the owner in its own transaction with its own result; a default join reads no request preamble; after
 * a fallback has completed (it may have written), a default join never reads through a carrier opened before it, so
 * the read sees that commit; and both switches turn the default off without touching an explicit shared snapshot. */
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {requestScopedReadStats,withSharedReadSnapshot,withTenant,withoutDefaultRequestJoin,type SessionContext,type Tx} from '../db/client';
import {withIndependentTransactions,type SharedReadStats} from '../db/shared-read';
import {withDatabaseReadDeadline} from '../db/workload';
import {requestReadScope,withRequestReadScope} from '../lib/request-read-scope';
// The request preamble every request scope's composition carriers read (registered on import, as the root layout does).
import '../core/home-request-preamble';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {observeStatements} from './helpers/statement-observer';

let a:Base,b:Base,ctxA:SessionContext,ctxB:SessionContext;
const closed:SharedReadStats[]=[];
const hooks=globalThis as {__aihrPerfSharedRead?:(stats:SharedReadStats)=>void};
beforeAll(async()=>{
 await migrateTestDb();await resetDb();a=await seedBase();b=await seedBase();
 ctxA=adminCtx(a);ctxB=adminCtx(b);
 hooks.__aihrPerfSharedRead=stats=>{closed.push(stats);};
});
afterEach(()=>{closed.length=0;delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;});
afterAll(async()=>{delete hooks.__aihrPerfSharedRead;await closeAll();});

type Probe={at:string;iso:string;pid:number;tenant:string;companies:string[]};
async function probeTx(tx:Tx):Promise<Probe>{
 const [row]=await tx.execute(sql`select now()::text as at,current_setting('transaction_isolation') as iso,pg_backend_pid() as pid,
  current_setting('app.tenant_id',true) as tenant`) as unknown as {at:string;iso:string;pid:number;tenant:string}[];
 const companies=await tx.execute(sql`select id::text as id from company order by id`) as unknown as {id:string}[];
 return {at:row.at,iso:row.iso,pid:Number(row.pid),tenant:row.tenant,companies:companies.map(company=>company.id)};
}
const probe=(ctx:SessionContext)=>withTenant(ctx,probeTx);
const comparable=(value:Probe)=>({...value,at:null,pid:null,iso:null});
/** One modelled page render: every read inside `work` belongs to `scope`. */
const render=<T,>(scope:object,work:()=>Promise<T>)=>withRequestReadScope(scope,work);
const deferred=()=>{let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

describe('default request join (ADR 0181 package 1.1)',()=>{
 it('joins one identity\'s concurrent reads of a render into one read-only snapshot',async()=>{
  const scope={};
  const [one,two]=await render(scope,()=>Promise.all([probe(ctxA),probe(ctxA)]));
  expect(one.iso).toBe('repeatable read');
  expect([two.at,two.pid,two.iso]).toEqual([one.at,one.pid,one.iso]);
  expect(one.companies).toEqual([a.companyId]);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.joins,stats.defaultJoins,stats.fallbacks,stats.preambles]).toEqual([1,2,2,0,0]);
  // Each read's answer is exactly its own transaction's answer.
  expect(comparable(one)).toEqual(comparable(await probe(ctxA)));
 });

 it('costs one transaction for many concurrent reads, against one per read without the default',async()=>{
  const reads=()=>Promise.all(Array.from({length:6},()=>probe(ctxA)));
  const shared=await observeStatements(()=>render({},reads));
  const independent=await observeStatements(()=>render({},()=>withoutDefaultRequestJoin(reads)));
  expect(shared.transactions).toBe(1);
  expect(independent.transactions).toBe(6);
  expect(shared.result.map(comparable)).toEqual(independent.result.map(comparable));
 });

 it('commits an idle carrier: a later sequential read of the render opens a fresh snapshot',async()=>{
  const scope={};
  const first=await render(scope,()=>probe(ctxA));
  const second=await render(scope,()=>probe(ctxA));
  expect(second.iso).toBe('repeatable read');
  expect(second.at).not.toBe(first.at);
  expect((await requestScopedReadStats(scope))[0].carriers).toBe(2);
 });

 it('keeps every read\'s own transaction without a request scope, exactly as before',async()=>{
  expect(requestReadScope()).toBeUndefined();
  const [one,two]=await Promise.all([probe(ctxA),probe(ctxA)]);
  expect([one.iso,two.iso]).toEqual(['read committed','read committed']);
  expect(one.pid===two.pid&&one.at===two.at).toBe(false);
 });

 it('never joins another tenant, another grant set, an agent or a login-less context',async()=>{
  const scope={};
  const otherGrants={...ctxA,roles:['employee'],grants:undefined};
  const loginless={...ctxA,userId:undefined};
  const [own,tenant,grants,anonymous]=await render(scope,()=>Promise.all([probe(ctxA),probe(ctxB),probe(otherGrants),probe(loginless)]));
  expect(own.iso).toBe('repeatable read');
  // Another identity joins its OWN session of the same scope; a login-less context keeps its own transaction.
  expect(tenant.pid).not.toBe(own.pid);expect(grants.pid).not.toBe(own.pid);
  expect(anonymous.iso).toBe('read committed');
  expect(tenant.companies).toEqual([b.companyId]);
  expect(own.companies).toEqual([a.companyId]);
  expect((await requestScopedReadStats(scope)).map(row=>row.defaultJoins)).toEqual([1,1,1]);
 });

 it('reruns an owner that needs a barrier, read committed, a setting or a control statement in its own transaction',async()=>{
  const owners=[
   ['barrier',sql`select pg_advisory_xact_lock_shared(hashtextextended('default-join-test',0))`],
   ['readCommitted',sql`select current_setting('transaction_isolation')='read committed' as rc`],
   ['setting',sql`select set_config('app.default_join_test','1',true)`],
   ['control',sql`set local statement_timeout = '5s'`],
  ] as const;
  for(const [reason,statement] of owners){
   const scope={};
   const owned=async(tx:Tx)=>{await tx.execute(statement);return probeTx(tx);};
   const shared=await render(scope,()=>withTenant(ctxA,owned));
   const independent=await withTenant(ctxA,owned);
   expect(shared.iso,reason).toBe('read committed');
   expect(comparable(shared),reason).toEqual(comparable(independent));
   const [stats]=await requestScopedReadStats(scope);
   expect([stats.fallbacks,stats.refused[reason]],reason).toEqual([1,1]);
  }
 });

 it('after a completed fallback, never answers a later read from a carrier opened before it',async()=>{
  const scope={};
  const holding=deferred(),opened=deferred();
  // A: holds the carrier open (another owner of the same render still inside it).
  const held=render(scope,()=>withTenant(ctxA,async tx=>{const before=await probeTx(tx);opened.resolve();await holding.promise;return before;}));
  await opened.promise;
  // W: refused in the carrier (barrier), reruns in its own transaction and commits a new company before it settles.
  let added:string|undefined;
  await render(scope,()=>withTenant(ctxA,async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('default-join-stale',0))`);
   if(!added){const [row]=await owner.db.insert(schema.company).values({tenantId:a.tenantId,legalName:'Fictional Default Join Sdn Bhd'}).returning({id:schema.company.id});added=row.id;}
  }));
  // C: a later read of the same render must see W's commit, although A still holds the old snapshot.
  const later=await render(scope,()=>probe(ctxA));
  holding.resolve();
  const before=await held;
  expect(before.companies).not.toContain(added);
  expect(later.companies).toContain(added);
  expect(later.iso).toBe('read committed');
  let [stats]=await requestScopedReadStats(scope);
  expect(stats.staleSkips).toBe(1);
  // Once the old carrier is idle and committed, the next read joins a fresh snapshot that sees the commit.
  const fresh=await render(scope,()=>probe(ctxA));
  expect(fresh.iso).toBe('repeatable read');
  expect(fresh.companies).toContain(added);
  [stats]=await requestScopedReadStats(scope);
  expect(stats.carriers).toBe(2);
  await owner.db.execute(sql`delete from company where id=${added!}::uuid`);
 });

 it('reads no request preamble on a default join, while an explicit composition still does',async()=>{
  const scope={};
  await render(scope,()=>probe(ctxA));
  expect((await requestScopedReadStats(scope))[0].preambles).toBe(0);
  await render(scope,()=>withSharedReadSnapshot(ctxA,()=>probe(ctxA),undefined,requestReadScope()));
  const [stats]=await requestScopedReadStats(scope);
  expect(stats.carriers).toBe(2);
  expect(stats.preambles).toBe(1);
 });

 it('joins an explicit composition already installed rather than opening a second session',async()=>{
  const scope={};
  const [inside,outside]=await render(scope,()=>withSharedReadSnapshot(ctxA,()=>Promise.all([probe(ctxA),probe(ctxA)]),undefined,requestReadScope())
   .then(async pair=>[pair,await probe(ctxA)] as const));
  expect(inside[0].pid).toBe(inside[1].pid);
  expect(outside.iso).toBe('repeatable read');
  const stats=await requestScopedReadStats(scope);
  expect(stats).toHaveLength(1);
  expect([stats[0].joins,stats[0].defaultJoins]).toEqual([3,1]);
 });

 it('keeps its own transaction under another hard read deadline than the session\'s',async()=>{
  const scope={},cap=new AbortController();
  const plain=await render(scope,()=>probe(ctxA));
  const capped=await render(scope,()=>withDatabaseReadDeadline(cap.signal,()=>probe(ctxA)));
  expect(plain.iso).toBe('repeatable read');
  expect(capped.iso).toBe('read committed');
  expect((await requestScopedReadStats(scope))[0].defaultJoins).toBe(1);
 });

 it('is switched off by AIHR_DEFAULT_REQUEST_READ_JOIN=off, withoutDefaultRequestJoin and independent transactions',async()=>{
  const pair=()=>Promise.all([probe(ctxA),probe(ctxA)]);
  process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='off';
  expect((await render({},pair)).map(row=>row.iso)).toEqual(['read committed','read committed']);
  delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;
  expect((await render({},()=>withoutDefaultRequestJoin(pair))).map(row=>row.iso)).toEqual(['read committed','read committed']);
  expect((await render({},()=>withIndependentTransactions(pair))).map(row=>row.iso)).toEqual(['read committed','read committed']);
  // An explicit shared snapshot is unchanged by the switches.
  process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='off';
  expect((await withSharedReadSnapshot(ctxA,pair)).map(row=>row.iso)).toEqual(['repeatable read','repeatable read']);
 });

 it('finishes concurrent joined and refused owners of one render, each with its own result',async()=>{
  const scope={};
  const owners=()=>Array.from({length:8},(_,index)=>withTenant(ctxA,async tx=>{
   if(index%2)await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('default-join-pool',0))`);
   return probeTx(tx);
  }));
  const results=await render(scope,()=>Promise.all(owners()));
  expect(results.every(row=>row.companies.join()===a.companyId)).toBe(true);
  const [stats]=await requestScopedReadStats(scope);
  expect(stats.fallbacks).toBe(4);
 });
});
