/** ADR 0181 decision 2, plan package 1.1: during a server render, a `withTenant` read inside no shared session joins
 * its identity's session of the render's request read scope (db/client.ts, db/shared-read.ts defaultRequestReadScope).
 * Opt-in: only with AIHR_DEFAULT_REQUEST_READ_JOIN=on (owner, 24 November 2026: production default off). Every case
 * below runs with it on, except the switch case, which proves that unset means off.
 *
 * Proves: one identity's reads of one render share one REPEATABLE READ READ ONLY carrier; without a request scope
 * (a route handler, an action, a job, a test that models no render) every read keeps its own transaction exactly as
 * before; another identity, an agent, a login-less context or another hard read deadline never joins; every refusal
 * still reruns the owner in its own transaction with its own result; a default join reads no request preamble; after
 * a fallback has completed (it may have written), a default join never reads through a carrier opened before it, so
 * the read sees that commit; and both switches turn the default off without touching an explicit shared snapshot.
 *
 * The bounded carrier pool (AIHR_DEFAULT_REQUEST_READ_CARRIERS=2|3, last block): one identity's concurrent default joins
 * spread over at most that many carriers and never more; every owner and its nested reads stay on one carrier (one
 * snapshot); two owners of one render may read two snapshots, exactly as without the join; an explicit composition
 * never spreads; a pooled composition (the app frame) may take all N, and the page then opens one carrier of its own
 * (N+1 at most) so a page read never queues behind the frame; the stale-carrier rule and every refusal still hold; and a
 * carrier begins its transaction only for an admitted statement, so an owner refused first costs only its own. */
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {requestReadJoinEnabled,requestScopedReadStats,withSharedReadSnapshot,withTenant,withoutDefaultRequestJoin,type SessionContext,type Tx} from '../db/client';
import {classifySharedStatement,requestReadCarrierLimit,withIndependentTransactions,type SharedReadStats} from '../db/shared-read';
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
 process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='on';
});
afterEach(()=>{closed.length=0;process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='on';delete process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;});
afterAll(async()=>{delete hooks.__aihrPerfSharedRead;delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;delete process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;await closeAll();});

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

 it('refuses a barrier hidden in a SQL function before sending it, so the snapshot stays usable for later owners',async()=>{
  expect(classifySharedStatement('select app.access_profile_policy_read_lock()')).toEqual({kind:'refuse',reason:'barrier'});
  const scope={};
  // As its owners call it (core/profile.ts): a read-only Read Committed transaction, then the barrier function.
  const policyRead=async(tx:Tx)=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);await tx.execute(sql`select app.access_profile_policy_read_lock()`);return probeTx(tx);};
  const [locked,later]=await render(scope,async()=>[await withTenant(ctxA,policyRead),await probe(ctxA)] as const);
  expect(locked.iso).toBe('read committed');
  expect(comparable(locked)).toEqual(comparable(await withTenant(ctxA,policyRead)));
  // The carrier was never aborted: the next owner of the render still joins a read-only snapshot.
  expect(later.iso).toBe('repeatable read');
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.refused.barrier,Object.keys(stats.failures).length]).toEqual([1,0]);
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

 it('is off unless AIHR_DEFAULT_REQUEST_READ_JOIN=on, and off under withoutDefaultRequestJoin and independent transactions',async()=>{
  const pair=()=>Promise.all([probe(ctxA),probe(ctxA)]);
  const own=['read committed','read committed'];
  // The production default: unset, and any value but `on`, keeps every owner's own transaction.
  for(const value of [undefined,'off','true','1','ON']){
   if(value===undefined)delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;else process.env.AIHR_DEFAULT_REQUEST_READ_JOIN=value;
   expect(requestReadJoinEnabled(),String(value)).toBe(false);
   expect((await render({},pair)).map(row=>row.iso),String(value)).toEqual(own);
  }
  process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='on';
  expect(requestReadJoinEnabled()).toBe(true);
  expect((await render({},()=>withoutDefaultRequestJoin(async()=>{expect(requestReadJoinEnabled()).toBe(false);return pair();}))).map(row=>row.iso)).toEqual(own);
  expect((await render({},()=>withIndependentTransactions(pair))).map(row=>row.iso)).toEqual(['read committed','read committed']);
  // An explicit shared snapshot is unchanged by the switches.
  delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;
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

describe('bounded carrier pool for the default join (AIHR_DEFAULT_REQUEST_READ_CARRIERS)',()=>{
 const pool=(size:1|2|3)=>{if(size===1)delete process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;else process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS=String(size);};

 it('accepts only 2 or 3; unset and any other value is one carrier',()=>{
  for(const [value,size] of [[undefined,1],['1',1],['2',2],['3',3],['4',1],['0',1],['two',1],[' 2',1]] as const){
   if(value===undefined)delete process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;else process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS=value;
   expect(requestReadCarrierLimit(),String(value)).toBe(size);
  }
 });

 it.each([1,2,3] as const)('spreads concurrent reads over at most %i carriers, each answer its own transaction\'s',async size=>{
  pool(size);
  const scope={};
  const reads=()=>Promise.all(Array.from({length:7},()=>probe(ctxA)));
  const shared=await observeStatements(()=>render(scope,reads));
  expect(shared.transactions).toBe(size);
  expect(new Set(shared.result.map(row=>row.pid)).size).toBe(size);
  expect(shared.result.every(row=>row.iso==='repeatable read')).toBe(true);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.peakCarriers,stats.joins,stats.defaultJoins,stats.fallbacks]).toEqual([size,size,7,7,0]);
  const independent=await render({},()=>withoutDefaultRequestJoin(reads));
  expect(shared.result.map(comparable)).toEqual(independent.map(comparable));
 });

 it('never opens more carriers than the pool, wave after wave, and none while the join is off',async()=>{
  pool(2);
  const scope={};
  const wave=()=>Promise.all(Array.from({length:5},()=>probe(ctxA)));
  const waves=await observeStatements(()=>render(scope,async()=>{await wave();await wave();return wave();}));
  // Each wave's carriers commit when it settles; the next wave opens at most the pool again.
  expect(waves.transactions).toBe(6);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.peakCarriers]).toEqual([6,2]);
  delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;
  const off=await observeStatements(()=>render({},wave));
  expect(off.transactions).toBe(5);
  expect(off.result.every(row=>row.iso==='read committed')).toBe(true);
 });

 it('keeps every owner, and the reads nested in it, on the one carrier (one snapshot) it joined',async()=>{
  pool(3);
  const scope={};
  const ownerRead=()=>withTenant(ctxA,async tx=>{
   const first=await probeTx(tx);
   const nested=await probe(ctxA);
   const again=await probeTx(tx);
   return {first,nested,again};
  });
  const owners=await render(scope,()=>Promise.all([ownerRead(),ownerRead(),ownerRead()]));
  for(const {first,nested,again} of owners){
   expect([nested.pid,again.pid,nested.at,again.at]).toEqual([first.pid,first.pid,first.at,first.at]);
  }
  expect(new Set(owners.map(row=>row.first.pid)).size).toBe(3);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.joins,stats.defaultJoins]).toEqual([3,6,3]);
 });

 it('may give two owners of one render two snapshots, exactly as each owner\'s own transaction would',async()=>{
  const run=async(size:1|2)=>{
   pool(size);
   const scope={},holding=deferred(),opened=deferred();
   // A: an owner that is still reading when the commit below lands.
   const held=render(scope,()=>withTenant(ctxA,async tx=>{const before=await probeTx(tx);opened.resolve();await holding.promise;return {before,after:await probeTx(tx)};}));
   await opened.promise;
   // A commit from outside the render (another user's save).
   const [row]=await owner.db.insert(schema.company).values({tenantId:a.tenantId,legalName:'Fictional Carrier Pool Sdn Bhd'}).returning({id:schema.company.id});
   // B: an owner that starts after the commit, while A still reads.
   const later=await render(scope,()=>probe(ctxA));
   holding.resolve();
   const first=await held;
   await owner.db.execute(sql`delete from company where id=${row.id}::uuid`);
   return {added:row.id,first,later};
  };
  // One carrier: B joins A's snapshot and does not see the commit.
  const one=await run(1);
  expect(one.later.pid).toBe(one.first.before.pid);
  expect(one.later.companies).not.toContain(one.added);
  // Two carriers: B opens a second snapshot and sees it, as B's own Read Committed transaction (join off) would.
  const two=await run(2);
  expect(two.later.pid).not.toBe(two.first.before.pid);
  expect(two.later.companies).toContain(two.added);
  // Either way A reads one snapshot throughout, never a mix.
  for(const {first,added} of [one,two]){
   expect(first.before.companies).not.toContain(added);
   expect(first.after.companies).toEqual(first.before.companies);
  }
 });

 it('never spreads an explicit composition: its owners share one carrier at any pool size',async()=>{
  pool(3);
  const scope={};
  const rows=await render(scope,()=>withSharedReadSnapshot(ctxA,()=>Promise.all(Array.from({length:5},()=>probe(ctxA))),undefined,requestReadScope()));
  expect(new Set(rows.map(row=>row.pid)).size).toBe(1);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.peakCarriers,stats.joins,stats.defaultJoins]).toEqual([1,1,5,0]);
 });

 it.each([[1,1],[2,2],[3,3]] as const)('with a pool of %i, spreads a pooled composition (the app frame) over at most %i carriers; only its first reads the preamble',async(size,carriers)=>{
  pool(size);
  const scope={};
  const nestedRead=()=>withTenant(ctxA,async tx=>{const outer=await probeTx(tx);const inner=await probe(ctxA);return {outer,inner};});
  const rows=await observeStatements(()=>render(scope,()=>withSharedReadSnapshot(ctxA,()=>Promise.all(Array.from({length:5},nestedRead)),undefined,requestReadScope(),{pooled:true})));
  // The frame may take the whole pool; the page's own carrier is opened beside it when the page reads (below).
  expect(rows.transactions).toBe(carriers);
  expect(new Set(rows.result.map(row=>row.outer.pid)).size).toBe(carriers);
  for(const {outer,inner} of rows.result)expect([inner.pid,inner.at]).toEqual([outer.pid,outer.at]);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.peakCarriers,stats.joins,stats.defaultJoins,stats.preambles]).toEqual([carriers,carriers,10,0,1]);
  const independent=await render({},()=>withoutDefaultRequestJoin(()=>Promise.all(Array.from({length:5},nestedRead))));
  expect(rows.result.map(row=>comparable(row.outer))).toEqual(independent.map(row=>comparable(row.outer)));
 });

 it.each([1,2,3] as const)('with a pool of %i, a page read never queues behind a busy frame carrier (the page opens one of its own)',async size=>{
  pool(size);
  const scope={},holding=deferred(),started=Array.from({length:4},deferred);
  // The frame: a pooled composition whose four owners all hold their carriers.
  const frame=render(scope,()=>withSharedReadSnapshot(ctxA,()=>Promise.all(started.map(gate=>withTenant(ctxA,async tx=>{
   const row=await probeTx(tx);gate.resolve();await holding.promise;return row;}))),undefined,requestReadScope(),{pooled:true}));
  await Promise.all(started.map(gate=>gate.promise));
  // The page, while every frame owner is still busy: a default join and a pinned composition (the Today sections).
  const [page,today]=await render(scope,()=>Promise.all([probe(ctxA),withSharedReadSnapshot(ctxA,()=>probe(ctxA),undefined,requestReadScope())]));
  holding.resolve();
  const frameRows=await frame;
  const framePids=new Set(frameRows.map(row=>row.pid));
  const [stats]=await requestScopedReadStats(scope);
  expect(stats.peakCarriers).toBeLessThanOrEqual(size===1?1:size+1);
  if(size===1){
   // One carrier: everything shares it, exactly as before the pool.
   expect([page.pid,today.pid]).toEqual([frameRows[0].pid,frameRows[0].pid]);
   expect(stats.carriers).toBe(1);
  }else{
   // The frame holds the whole pool; the page opens exactly one more, shared by its default join and its pinned
   // composition: N+1 at most, and only while the two overlap.
   expect(framePids.size).toBe(size);
   expect(framePids.has(page.pid)).toBe(false);
   expect(framePids.has(today.pid)).toBe(false);
   expect(today.pid).toBe(page.pid);
   expect([stats.carriers,stats.peakCarriers]).toEqual([size+1,size+1]);
  }
  expect([page.iso,today.iso]).toEqual(['repeatable read','repeatable read']);
 });

 it('after a completed fallback, opens a fresh carrier while the pool has room, and falls back only when every carrier is stale and busy',async()=>{
  pool(2);
  const scope={};
  const holding=deferred(),opened=[deferred(),deferred()];
  // A and B: two owners holding both carriers of the pool.
  const held=[0,1].map(index=>render(scope,()=>withTenant(ctxA,async tx=>{const before=await probeTx(tx);opened[index].resolve();await holding.promise;return before;})));
  await Promise.all(opened.map(gate=>gate.promise));
  // W: refused in the carrier (barrier), reruns in its own transaction and commits a new company before it settles.
  let added:string|undefined;
  await render(scope,()=>withTenant(ctxA,async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('carrier-pool-stale',0))`);
   if(!added){const [row]=await owner.db.insert(schema.company).values({tenantId:a.tenantId,legalName:'Fictional Pool Stale Sdn Bhd'}).returning({id:schema.company.id});added=row.id;}
  }));
  // C: both carriers predate W and are busy, and the pool is full: C reads in its own transaction and sees W.
  const full=await render(scope,()=>probe(ctxA));
  expect(full.iso).toBe('read committed');
  expect(full.companies).toContain(added);
  // Release A and B: their carriers commit, the pool has room, and D opens a fresh snapshot that sees W.
  holding.resolve();
  const before=await Promise.all(held);
  for(const row of before)expect(row.companies).not.toContain(added);
  const fresh=await render(scope,()=>probe(ctxA));
  expect(fresh.iso).toBe('repeatable read');
  expect(fresh.companies).toContain(added);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.staleSkips,stats.peakCarriers]).toEqual([1,2]);
  // A fresh carrier is opened while one stale carrier is still busy (room in the pool), instead of falling back.
  const scope2={},hold2=deferred(),open2=deferred();
  const busy=render(scope2,()=>withTenant(ctxA,async tx=>{const row=await probeTx(tx);open2.resolve();await hold2.promise;return row;}));
  await open2.promise;
  await render(scope2,()=>withTenant(ctxA,async tx=>{await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('carrier-pool-stale',1))`);}));
  const roomy=await render(scope2,()=>probe(ctxA));
  hold2.resolve();
  const old=await busy;
  expect(roomy.iso).toBe('repeatable read');
  expect(roomy.pid).not.toBe(old.pid);
  expect(roomy.at).not.toBe(old.at);
  const [stats2]=await requestScopedReadStats(scope2);
  // The busy carrier, the one the refused owner was given (refused first, it never began), and the fresh one.
  expect([stats2.staleSkips,stats2.carriers,stats2.unopened]).toEqual([0,3,1]);
  await owner.db.execute(sql`delete from company where id=${added!}::uuid`);
 });

 it.each([2,3] as const)('finishes concurrent joined and refused owners with a pool of %i, each with its own result',async size=>{
  pool(size);
  const scope={};
  const owners=()=>Array.from({length:8},(_,index)=>withTenant(ctxA,async tx=>{
   if(index%2)await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('carrier-pool-mixed',0))`);
   return probeTx(tx);
  }));
  const results=await render(scope,()=>Promise.all(owners()));
  expect(results.every(row=>row.companies.join()===a.companyId)).toBe(true);
  const [stats]=await requestScopedReadStats(scope);
  expect(stats.fallbacks).toBe(4);
  expect(stats.peakCarriers).toBeLessThanOrEqual(size);
  expect(Object.keys(stats.failures)).toEqual([]);
 });

 it.each([1,2,3] as const)('begins no carrier transaction for an owner refused on its first statement, with a pool of %i',async size=>{
  pool(size);
  // As the payroll-history owners send it: a read-only declaration (already in force on a carrier), then the barrier.
  const refusedFirst=async(tx:Tx)=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);
   await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('carrier-first-refused',0))`);
   return probeTx(tx);
  };
  // Alone: the owner's chosen carrier never begins, so the render pays exactly the owner's own transaction.
  const aloneScope={};
  const alone=await observeStatements(()=>render(aloneScope,()=>withTenant(ctxA,refusedFirst)));
  const aloneOff=await observeStatements(()=>render({},()=>withoutDefaultRequestJoin(()=>withTenant(ctxA,refusedFirst))));
  expect(alone.result.iso).toBe('read committed');
  expect(comparable(alone.result)).toEqual(comparable(aloneOff.result));
  expect([alone.transactions,aloneOff.transactions]).toEqual([1,1]);
  let [stats]=await requestScopedReadStats(aloneScope);
  expect([stats.carriers,stats.unopened,stats.fallbacks,stats.refused.barrier,stats.joins]).toEqual([1,1,1,1,1]);
  expect(Object.keys(stats.failures)).toEqual([]);
  // Beside readers of the same render: whichever carrier it was given (a fresh one with room in the pool, else a
  // reader's), it costs no carrier transaction of its own, and the readers still share their carriers.
  const scope={};
  const mixed=()=>Promise.all([probe(ctxA),withTenant(ctxA,refusedFirst),probe(ctxA),withTenant(ctxA,refusedFirst)]);
  const shared=await observeStatements(()=>render(scope,mixed));
  const off=await observeStatements(()=>render({},()=>withoutDefaultRequestJoin(mixed)));
  expect(shared.result.map(comparable)).toEqual(off.result.map(comparable));
  expect(shared.result.map(row=>row.iso)).toEqual(['repeatable read','read committed','repeatable read','read committed']);
  expect(off.transactions).toBe(4);
  expect(shared.transactions).toBeLessThanOrEqual(off.transactions);
  [stats]=await requestScopedReadStats(scope);
  expect([stats.fallbacks,stats.refused.barrier]).toEqual([2,2]);
  // Every carrier that began is one transaction, and every one only refused owners were given began none.
  expect(shared.transactions).toBe(stats.carriers-stats.unopened+stats.fallbacks);
  // With room in the pool the first refused owner is given a fresh carrier of its own, which never begins.
  expect(stats.unopened).toBe(size===1?0:1);
  // The carrier stays usable: the refusals were answered before anything reached it.
  expect(Object.keys(stats.failures)).toEqual([]);
 });

 it('an owner refused after its first admitted statement still began its carrier, and reruns alone',async()=>{
  pool(3);
  const scope={};
  const readThenBarrier=async(tx:Tx)=>{
   const before=await probeTx(tx);
   await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('carrier-later-refused',0))`);
   return {...before,second:await probeTx(tx)};
  };
  const shared=await observeStatements(()=>render(scope,()=>withTenant(ctxA,readThenBarrier)));
  expect([shared.result.iso,shared.result.second.iso]).toEqual(['read committed','read committed']);
  // The admitted read began the carrier; the barrier then reran the whole owner in its own transaction.
  expect(shared.transactions).toBe(2);
  const [stats]=await requestScopedReadStats(scope);
  expect([stats.carriers,stats.unopened,stats.fallbacks,stats.refused.barrier]).toEqual([1,0,1,1]);
 });

 it('pools per identity: another identity in the same render has its own pool',async()=>{
  pool(2);
  const scope={};
  const rows=await observeStatements(()=>render(scope,()=>Promise.all([...Array.from({length:4},()=>probe(ctxA)),...Array.from({length:4},()=>probe(ctxB))])));
  expect(rows.transactions).toBe(4);
  expect(rows.result.slice(0,4).every(row=>row.companies.join()===a.companyId)).toBe(true);
  expect(rows.result.slice(4).every(row=>row.companies.join()===b.companyId)).toBe(true);
  expect((await requestScopedReadStats(scope)).map(row=>row.peakCarriers)).toEqual([2,2]);
 });
});
