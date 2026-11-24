/** One request's read-only snapshot, shared by that request's own read owners.
 *
 * A Home stream (or one Today section) installs a session with `withSharedReadSnapshot` (db/client.ts). While it
 * runs, every `withTenant` call whose identity settings are exactly the session's joins ONE REPEATABLE READ READ
 * ONLY transaction instead of opening its own BEGIN / SET TRANSACTION / set_config / COMMIT. Identical read
 * statements with identical parameters inside that one snapshot return identical rows, so the session answers a
 * repeat from the first execution (a copy, never a shared object).
 *
 * WHAT CAN NEVER BE SHARED. The session lives for one request and one identity (tenant, user, roles, grants, agent
 * principal). Another identity's `withTenant`, even inside the same request, opens its own transaction. Nothing is
 * kept after the request: the memo belongs to the transaction object and is dropped with it.
 *
 * WHAT FALLS BACK. An owner whose transaction contract this snapshot cannot honour runs exactly as before, in its
 * own transaction: a barrier lock (payroll history, access configuration), a read-committed probe, a write, a
 * savepoint, a setting change, or any statement after a database error aborted the shared transaction. The guard
 * refuses such a statement before it is sent, marks that owner's join, and the whole owner reruns independently, so
 * a caught or swallowed refusal can never change its result.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {SQL} from 'drizzle-orm';
import type {SessionContext} from './client';

export class SharedReadIncompatibleError extends Error{
 constructor(readonly reason:string){super('This read must use its own transaction ('+reason+').');this.name='SharedReadIncompatibleError';}
}

/** `flights`: idle-to-busy transitions of the carrier connection. The driver pipelines statements sent while others are
 * outstanding, so a busy period can hold many statements; this is a lower bound on waits, not a round-trip count. */
export type SharedReadStats={joins:number;fallbacks:number;statements:number;memoHits:number;refused:Record<string,number>;failures:Record<string,number>;carriers:number;flights:number;
 /** Carriers that read a request preamble, and the owner statements it answered ahead (statement memo entries). */
 preambles:number;seeded:number;
 /** Default joins (package 1.1), and those of them that kept their own transaction because the open carrier predates
  * a completed fallback and another owner was still inside it. */
 defaultJoins:number;staleSkips:number;
 /** The most carriers this session held open at once (the default join's pool, at most its size). */
 peakCarriers:number};
const sessions=new AsyncLocalStorage<SharedReadSession<unknown>>();
const joins=new AsyncLocalStorage<Join>();

const independent=new AsyncLocalStorage<true>();
export function currentSharedRead():SharedReadSession<unknown>|undefined{return independent.getStore()?undefined:sessions.getStore();}
/** Every owner inside `work` keeps its own transaction, exactly as before shared snapshots existed. Equivalence
 * proofs compare this path with the shared one; it changes no authority and no result. */
export function withIndependentTransactions<T>(work:()=>Promise<T>):Promise<T>{return independent.run(true,work);}
export function independentTransactionsRequired():boolean{return independent.getStore()===true;}
export function runInSharedRead<T>(session:SharedReadSession<unknown>,work:()=>Promise<T>):Promise<T>{return sessions.run(session,work);}

/** ── Request preamble (docs/adr/2026-11-10-home-request-read-scope.md decision 12) ──────────────────────────────────
 * A carrier may answer, inside its own identity statement, the owner statements every composition of its request
 * sends first (the snapshot and principal proofs, the own identity, the dated company proof, the dashboard role and the
 * configuration reads). Each answer is one owner statement exactly: its text, its parameters, its mode and the rows the
 * driver returns for it, evaluated as a sub-select of the same statement text in the same transaction, snapshot and
 * identity settings. The carrier enters each answer into its statement memo before any owner can join, so the owner
 * that later sends that exact statement receives it as a repeat of an identical read in the same snapshot, which the
 * memo already answers (see the header). A statement whose text, parameters or mode differ (another employment, date
 * or identity) is not in the memo and reads as before. Nothing is kept beyond the carrier. */
export type SharedReadSeed={mode:'rows'|'values';query:string;params:unknown[];rows:unknown[]};
export type SharedReadPreambleRead={
 /** A JSON-valued expression of owner statements as sub-selects; evaluated only after the identity settings hold. */
 sql:SQL;
 /** The driver-shaped answer for each owner statement; throws when the value is not the expected shape. */
 decode(value:unknown):SharedReadSeed[];
 /** Every owner statement planned in this carrier may be planned with JIT off (it changes planning, never results). */
 jitOff:boolean;
};
export type SharedReadPreamble={build(ctx:SessionContext,tx:unknown):SharedReadPreambleRead|null};
const ownerPreamble=new AsyncLocalStorage<true>();
/** Every carrier opened inside `work` reads no preamble: each owner sends its own proofs, identity and configuration
 * reads, exactly as before decision 12. Equivalence proofs compare both paths. */
export function withOwnerPreambleReads<T>(work:()=>Promise<T>):Promise<T>{return ownerPreamble.run(true,work);}
export function ownerPreambleReads():boolean{return ownerPreamble.getStore()===true;}
/** The current session's carriers (from the next one opened) read `preamble`. A request declares it before its reads. */
export function declareSharedReadPreamble(preamble:SharedReadPreamble){
 const session=currentSharedRead();
 if(session)session.preamble=preamble;
}
let requestScopePreamble:SharedReadPreamble|undefined;
/** The preamble every request read scope's carriers read (lib/request-read-scope.ts: one Today page render). Its
 * module registers it when loaded (core/home-request-preamble.ts, imported by the root layout); until then, and in a
 * process that never loads it, a request scope's carriers read none and every owner reads as before. */
export function registerRequestScopePreamble(preamble:SharedReadPreamble){requestScopePreamble=preamble;}
export function scopePreamble():SharedReadPreamble|undefined{return requestScopePreamble;}

/** ── The default request join (ADR 0181 decision 2, plan package 1.1) ─────────────────────────────────────────────
 * During a server render, a `withTenant` read that is inside no shared session joins its identity's session of the
 * render's request read scope (lib/request-read-scope.ts) instead of opening its own transaction. The scope module
 * registers its resolver when loaded (by the root layout); a process that never loads it (a job, a script, the
 * worker) has no scope, and every owner keeps its own transaction exactly as before. Route handlers, server actions
 * and tests have no request scope (React `cache` is a passthrough there) unless a test models one explicitly.
 *
 * Every refusal and fallback rule of this module still applies to a default join. Two additions keep it at least as
 * fresh as the owner's own transaction would have been:
 *  - a default join never reads the request preamble (its carrier is plain: the preamble is a Home composition's), and
 *  - after an owner of the session has completed a fallback in its own transaction (which may have written), a default
 *    join never joins a carrier opened before that: an idle one is committed and a fresh snapshot begins; one still in
 *    use by another owner is left to it, and this owner opens a fresh carrier while the pool (below) has room, else
 *    reads in its own transaction, as before this package.
 * OPT-IN (owner decision, 24 November 2026): the join runs only while the web process has
 * `AIHR_DEFAULT_REQUEST_READ_JOIN=on` (read per call). Unset or any other value, every owner keeps its own transaction
 * exactly as before. One carrier is one connection, so owners that ran in parallel queue behind each other; on hardware
 * with many cores that can cost more wall time than the transactions it saves, so it stays off in production until it
 * is measured there. `withoutDefaultRequestJoin` and `withIndependentTransactions` switch it off for their work. No
 * switch changes an explicit shared snapshot (Home, Today, the shell's approval summary). */
let requestScopeResolver:(()=>object|undefined)|undefined;
export function registerRequestScopeResolver(resolve:()=>object|undefined){requestScopeResolver=resolve;}
const noDefaultJoin=new AsyncLocalStorage<true>();
/** Every owner inside `work` joins only a shared snapshot that is explicitly installed (equivalence proofs). */
export function withoutDefaultRequestJoin<T>(work:()=>Promise<T>):Promise<T>{return noDefaultJoin.run(true,work);}
/** Whether a render's reads share its read snapshot: `AIHR_DEFAULT_REQUEST_READ_JOIN=on` and not switched off for
 * this work. It also decides whether the root layout reads its frame inside the render's snapshot (package 1.2). */
export function requestReadJoinEnabled():boolean{
 return process.env.AIHR_DEFAULT_REQUEST_READ_JOIN==='on'&&!independent.getStore()&&!noDefaultJoin.getStore();
}
/** The request read scope a `withTenant` read outside any shared session may join, or undefined. */
export function defaultRequestReadScope():object|undefined{
 if(!requestScopeResolver||sessions.getStore()||!requestReadJoinEnabled())return undefined;
 return requestScopeResolver();
}
/** ── The carrier pool of a default join (ADR 0181 Phase 1, bounded pool) ────────────────────────────────────────────
 * One carrier is one connection: owners that ran in parallel in their own transactions queue behind each other on it.
 * `AIHR_DEFAULT_REQUEST_READ_CARRIERS` (read per call; 1, 2 or 3, anything else is 1) lets a request's session for one
 * identity hold up to that many carriers for its DEFAULT joins, so independent owners still run in parallel while the
 * transactions a page pays stay bounded by the pool size per identity in a wave of concurrent reads.
 *
 * WHAT A READ SEES. Carriers opened at different moments are different snapshots, so one render may read from up to N
 * snapshots. The unit of consistency of a default join is ONE OWNER (one `withTenant` call): every statement of it,
 * and every nested `withTenant` of the same identity inside it, runs in the one carrier it joined. Two owners of a
 * render are never promised one snapshot: with the join off (the production default) each keeps its own Read
 * Committed transaction, and with one carrier a later owner already reads a fresh snapshot once the earlier carrier
 * went idle. An owner that compares results across reads makes them inside one `withTenant`, or installs an explicit
 * shared snapshot (`withSharedReadSnapshot`): an explicit composition is PINNED to one carrier. Its joins take the
 * carrier they are nested in, else the session's oldest open carrier, and open one only when none is open, exactly as
 * with one carrier, so no setting changes an explicit snapshot (Home, Today, the shell's approval summary).
 *
 * The one exception is a composition that declares itself `pooled`: a set of independent owners grouped only to bound
 * their transactions, none of which compares its results with another's (the app frame's reads, package 1.2, which
 * keep their own transactions with the join off). Its owners choose carriers as default joins do, without the
 * stale-carrier rule (which no explicit join has); only the first carrier it opens reads the request preamble.
 * Nested reads still stay on their owner's carrier.
 *
 * ONE CARRIER IS KEPT FOR THE PAGE. With a pool of 2 or 3, a pooled composition opens at most N-1 carriers and joins
 * only its own, and the request's other reads (default joins and pinned compositions) prefer theirs: the frame never
 * fills the pool, so a page read (a redirect check, say) never queues behind frame statements. Each side joins the
 * other's carriers only when it has none of its own and the pool is full. With one carrier everything shares it. */
export function requestReadCarrierLimit():number{
 const value=process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;
 return value==='2'?2:value==='3'?3:1;
}

/** What a carrier lets its opener do before any owner joins: answer statements ahead, and record a held setting. */
export type SharedReadCarrierControl={seed(seeds:readonly SharedReadSeed[]):number;hold(setting:'jit',value:'on'|'off'):void};

/** One open carrier transaction. `finish` lets it commit; `done` settles after COMMIT or ROLLBACK. */
export type SharedReadCarrier<Tx>={tx:Promise<Tx>;finish:()=>void;done:Promise<void>};
/** What a carrier's opener and its statement guard know about that one carrier. */
export type SharedReadCarrierState={
 /** True only while the carrier sets its own transaction-local identity, before any owner can join it. */
 bootstrapping:boolean;
 /** Opened by a default join: it reads no request preamble (package 1.1). */
 readonly plain:boolean;
 /** Statements sent on this carrier and not yet answered (diagnostic flight count only). */
 inFlight:number;
};
/** 'pooled': opened by a pooled composition (the frame); 'page': by any other read of the request. */
type Lane='pooled'|'page';
type Slot<Tx>={carrier:SharedReadCarrier<Tx>;state:SharedReadCarrierState;lane:Lane;
 /** Owners inside this carrier now (joined or waiting for it to open). */
 active:number;
 /** Fallbacks completed when this carrier began (the stale-carrier rule). */
 fallbacks:number};
type Join={tainted:boolean;slot?:Slot<unknown>};
/** A carrier to join, or one to open in `lane`: `plain` reads no request preamble. */
type Choice<Tx>=Slot<Tx>|{plain:boolean;lane:Lane};
/** The session whose pooled composition (see the pool notes) the current work belongs to. */
const pooledWork=new AsyncLocalStorage<SharedReadSession<unknown>>();

export class SharedReadSession<Tx>{
 /** Open carriers, oldest first. Explicit joins use one (see the pool notes); default joins up to the pool size. */
 private slots:Slot<Tx>[]=[];
 private readonly carriers:Promise<void>[]=[];
 private poisoned=false;
 private closed=false;
 private active=0;
 private waitingOwn=0;
 /** Request-scoped sessions only: compositions currently running inside this session. */
 private works=0;
 readonly stats:SharedReadStats={joins:0,fallbacks:0,statements:0,memoHits:0,refused:{},failures:{},carriers:0,flights:0,preambles:0,seeded:0,defaultJoins:0,staleSkips:0,peakCarriers:0};
 /** Fallbacks completed so far. */
 private settledFallbacks=0;
 /** The request preamble each new carrier reads (decision 12), if its request declared one. */
 preamble?:SharedReadPreamble;
 /** `deadline`: the hard read deadline (db/workload.ts) every carrier of this session cancels its statements at, if any.
  * `idleRelease`: a request-scoped session is shared by several independent compositions of one request (the
  * Today sections and the shell's approvals). It is never closed; each carrier commits whenever no composition and
  * no owner is inside it, so it never holds a connection between them. A later composition opens a fresh carrier.
  * Only such a session pools its default joins (`requestReadCarrierLimit`). */
 constructor(private readonly owner:object,readonly identity:string,private readonly open:(state:SharedReadCarrierState)=>SharedReadCarrier<Tx>,
  readonly deadline?:AbortSignal,private readonly idleRelease=false){}

 /** Only the same database client, the exact same transaction identity settings and the same hard read deadline
  * (or none for both): an owner under another deadline would otherwise be cancelled at, or outlive, the wrong one. */
 admits(owner:object,identity:string,deadline?:AbortSignal){return !this.closed&&owner===this.owner&&identity===this.identity&&deadline===this.deadline;}
 poison(){this.poisoned=true;}
 /** The preamble a carrier opening now reads for `ctx`, or null (none declared, switched off, or not buildable). */
 openPreamble(ctx:SessionContext,tx:unknown,plain=false):SharedReadPreambleRead|null{
  if(plain||!this.preamble||ownerPreambleReads())return null;
  try{return this.preamble.build(ctx,tx);}catch{return null;}
 }

 /** An explicit composition's owner: the carrier it is nested in, else (pinned) the oldest open one or a new one, or
  * (a pooled composition) the pool's choice. */
 join<T>(fn:(tx:Tx)=>Promise<T>,ownTransaction:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  return this.joinCarrier(fn,ownTransaction,signal,()=>{
   const enclosing=joins.getStore()?.slot as Slot<Tx>|undefined;
   if(enclosing&&this.slots.includes(enclosing))return enclosing;
   if(pooledWork.getStore()!==this){
    // Pinned: the oldest open carrier (with a pool, the oldest of the page's own, so the frame's are never joined).
    const pinned=this.slots.length>1||this.slots[0]?.lane==='pooled'?this.slots.find(slot=>slot.lane==='page'):this.slots[0];
    return pinned??(this.slots.length<(this.idleRelease?requestReadCarrierLimit():1)?{plain:false,lane:'page'}:this.slots[0]);
   }
   const pick=this.pick(this.slots,'pooled');
   return pick==='room'?{plain:this.slots.length>0,lane:'pooled'}:pick!;
  });
 }
 /** A `withTenant` read that joins this request-scoped session by default (package 1.1; see the module notes above). */
 joinDefault<T>(fn:(tx:Tx)=>Promise<T>,ownTransaction:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();
  this.stats.defaultJoins++;
  // The stale-carrier rule: a carrier that predates a completed fallback is committed when idle and never joined.
  for(const slot of [...this.slots])if(slot.fallbacks!==this.settledFallbacks&&slot.active===0)this.releaseSlot(slot);
  const pick=this.pick(this.slots.filter(slot=>slot.fallbacks===this.settledFallbacks),'page');
  // Every carrier in reach is stale and still in use by another owner: this owner reads in its own transaction.
  if(!pick){this.stats.staleSkips++;return this.fallback(ownTransaction);}
  return this.joinCarrier(fn,ownTransaction,signal,()=>pick==='room'?{plain:true,lane:'page'}:pick);
 }
 /** The pool's choice among `candidates` for a read of `lane`: an idle carrier of its own lane (no new transaction),
  * else room for a new carrier (fewer than the pool size open, and a pooled composition below N-1), else the least
  * busy of its own lane, else the least busy of the other. With one carrier this is exactly the earlier rule. */
 private pick(candidates:Slot<Tx>[],lane:Lane):Slot<Tx>|'room'|undefined{
  const limit=this.idleRelease?requestReadCarrierLimit():1;
  const own=limit>1?candidates.filter(slot=>slot.lane===lane):candidates;
  const idle=own.find(slot=>slot.active===0);
  if(idle)return idle;
  if(this.slots.length<limit&&(lane==='page'||limit<2||this.slots.filter(slot=>slot.lane==='pooled').length<limit-1))return 'room';
  const least=(slots:Slot<Tx>[])=>{let best:Slot<Tx>|undefined;for(const slot of slots)if(!best||slot.active<best.active)best=slot;return best;};
  return least(own)??least(candidates);
 }
 private async joinCarrier<T>(fn:(tx:Tx)=>Promise<T>,ownTransaction:()=>Promise<T>,signal:AbortSignal|undefined,choose:()=>Choice<Tx>):Promise<T>{
  signal?.throwIfAborted();
  if(this.poisoned||this.closed)return this.fallback(ownTransaction);
  const chosen=choose();
  const slot='carrier' in chosen?chosen:this.begin(chosen.plain,chosen.lane);
  slot.active++;this.active++;
  let tainted=false,result:{ok:true;value:T}|{ok:false;error:unknown}|undefined;
  try{
   let tx:Tx;
   try{tx=await slot.carrier.tx;}
   catch{this.poisoned=true;tainted=true;}
   if(!tainted){
    signal?.throwIfAborted();
    this.stats.joins++;
    const join:Join={tainted:false,slot:slot as Slot<unknown>};
    try{result={ok:true,value:await joins.run(join,()=>fn(tx!))};}
    catch(error){result={ok:false,error};}
    // A failure while the shared transaction is aborted may come from a sibling's statement this owner awaited.
    tainted=join.tainted||(!result.ok&&this.poisoned);
   }
  }finally{this.leave(slot);}
  // A refused or failed statement anywhere in this owner's work: discard everything it saw and rerun it.
  if(tainted)return this.fallback(ownTransaction);
  if(!result!.ok)throw result!.error;
  return result!.value;
 }
 private begin(plain:boolean,lane:Lane):Slot<Tx>{
  this.stats.carriers++;
  const state:SharedReadCarrierState={bootstrapping:true,plain,inFlight:0};
  const slot:Slot<Tx>={carrier:this.open(state),state,lane,active:0,fallbacks:this.settledFallbacks};
  this.slots.push(slot);
  this.stats.peakCarriers=Math.max(this.stats.peakCarriers,this.slots.length);
  this.carriers.push(slot.carrier.done);return slot;
 }
 private leave(slot:Slot<Tx>){
  slot.active--;this.active--;
  if(slot.active===0&&(this.waitingOwn>0||this.idleRelease&&this.works===0))this.releaseSlot(slot);
 }
 /** One request-scoped composition: while it runs, its owners join this session; when the last one settles and no
  * owner is inside, the carriers commit. Results and failures are the composition's own. */
 async track<T>(work:()=>Promise<T>,pooled=false):Promise<T>{
  this.works++;
  const run=()=>runInSharedRead(this as SharedReadSession<unknown>,work);
  try{return await (pooled?pooledWork.run(this as SharedReadSession<unknown>,run):run());}
  finally{this.works--;if(this.works===0)this.releaseIdle();}
 }
 /** Every carrier this session opened has committed or rolled back. */
 settled(){return Promise.all(this.carriers.map(done=>done.catch(()=>undefined))).then(()=>undefined);}
 /** Commit an idle carrier so this request never holds a pool slot while its own fallback waits for one. A later
  * join opens a fresh carrier (a new snapshot and an empty memo). */
 private releaseSlot(slot:Slot<Tx>){
  const index=this.slots.indexOf(slot);
  if(index===-1)return;
  this.slots.splice(index,1);slot.carrier.finish();
 }
 private releaseIdle(){for(const slot of [...this.slots])if(slot.active===0)this.releaseSlot(slot);}
 private async fallback<T>(ownTransaction:()=>Promise<T>){
  this.stats.fallbacks++;this.waitingOwn++;
  this.releaseIdle();
  try{return await ownTransaction();}finally{this.waitingOwn--;this.settledFallbacks++;}
 }
 /** After the request's reads settle: commit every carrier and wait for each to finish. */
 async close(){this.closed=true;for(const slot of [...this.slots])this.releaseSlot(slot);await Promise.all(this.carriers.map(done=>done.catch(()=>undefined)));}
 refuse(reason:string){
  this.stats.refused[reason]=(this.stats.refused[reason]??0)+1;
  const join=joins.getStore();if(join)join.tainted=true;
  return new SharedReadIncompatibleError(reason);
 }
 failed(code:string){this.stats.failures[code]=(this.stats.failures[code]??0)+1;this.poisoned=true;const join=joins.getStore();if(join)join.tainted=true;}
}

/** The carrier transactions of shared sessions: one REPEATABLE READ READ ONLY snapshot each, for one identity. */
const carrierTransactions=new WeakSet<object>();
export function markSharedCarrierTransaction(tx:object){carrierTransactions.add(tx);}
const derived=new WeakMap<object,Map<string,Promise<unknown>>>();
const windows=new WeakMap<SharedReadSession<unknown>,Map<string,{from:string;to:string}>>();

/** A request that knows the widest date window its own reads need for one employment declares it here. Owners that
 * read a date-local fact (each date's answer depends only on that date, such as a holiday calendar, leave presence or a
 * dated company proof) may then read the whole window once inside the shared snapshot and answer each narrower request
 * by slicing it. A request outside the window, or outside a shared carrier, reads exactly as before. */
export function declareSharedReadWindow(employmentId:string,from:string,to:string){
 const session=currentSharedRead();
 if(!session||!(from<=to))return;
 let byEmployment=windows.get(session);
 if(!byEmployment)windows.set(session,byEmployment=new Map());
 byEmployment.set(employmentId,{from,to});
}
/** The declared window for `employmentId` when `tx` is the current shared carrier and it covers [from, to]. */
export function sharedReadWindow(tx:object,employmentId:string,from:string,to:string):{from:string;to:string}|null{
 if(!carrierTransactions.has(tx))return null;
 const session=currentSharedRead(),window=session?windows.get(session)?.get(employmentId):undefined;
 return window&&window.from<=from&&to<=window.to?window:null;
}
/** One value per shared carrier transaction and key: a pure function of that snapshot and its key, computed once.
 * Outside a carrier (an owner's own transaction, which may be READ COMMITTED) it is always computed afresh. A failed
 * computation is not kept. Callers hand each consumer its own copy. */
export function sharedSnapshotValue<T>(tx:object,key:string,compute:()=>Promise<T>):Promise<T>{
 if(!carrierTransactions.has(tx))return compute();
 let values=derived.get(tx);
 if(!values)derived.set(tx,values=new Map());
 let value=values.get(key) as Promise<T>|undefined;
 if(!value){
  value=compute();
  values.set(key,value);
  value.catch(()=>{if(values!.get(key)===value)values!.delete(key);});
 }
 return value;
}

/** Statement classes. Only a plain read is memoized; a compatible non-read passes through; anything that needs
 * another transaction contract is refused before it is sent. */
const CONTROL=/^\s*(insert|update|delete|merge|copy|lock|create|drop|alter|truncate|grant|revoke|comment|notify|listen|unlisten|vacuum|analyze|refresh|call|do|prepare|execute|deallocate|discard|savepoint|release|rollback|commit|begin|start|end|abort|reset|set|show|cluster|reindex|checkpoint|load|import|security|explain)\b/i;
const PASS_CONTROL=/^\s*(set\s+local\s+jit\s*(=|to)\s*(on|off)|set\s+transaction\s+read\s+only)\s*;?\s*$/i;
const REFUSE=[
 ['barrier',/\bpg_(try_)?advisory/i],
 ['setting',/\bset_config\s*\(/i],
 ['rowLock',/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i],
 ['readCommitted',/'read committed'/i],
 ['write',/\b(insert\s+into|delete\s+from|update\s+("?[a-z_][a-z0-9_.]*"?\.)?"?[a-z_][a-z0-9_]*"?\s+set\b|nextval\s*\(|setval\s*\(|pg_notify\s*\(|txid_current|pg_current_xact_id|lo_[a-z]+\s*\(|dblink)/i],
] as const;
/** SQL functions that write even when called from a SELECT. A statement calling one keeps its own transaction. */
const WRITING_FUNCTIONS=/\bapp\.reward_access_observe\s*\(/i;
/** SQL functions that take an advisory barrier inside their body and refuse any transaction but read-only Read
 * Committed (db/migrations/2135_profile_presentation_read_lock.sql). Sent to the carrier, the call raises and aborts
 * the shared transaction, so every later owner of the request would rerun alone; refused before sending, only its own
 * owner reruns, exactly as a barrier in the statement text does. */
const BARRIER_FUNCTIONS=/\bapp\.access_profile_policy_read_lock\s*\(/i;
/** Statement texts (never parameters or rows) that a read-only carrier refused with 25006 in this process. They
 * are refused before sending from then on; the first refusal already reran every affected owner. */
const learnedWriters=new Set<string>();
const LEARNED_LIMIT=500;
const VOLATILE=/\b(clock_timestamp|statement_timestamp|timeofday|random|gen_random_uuid|uuid_generate_[a-z0-9_]+|pg_sleep)\s*\(/i;

export type SharedStatementClass={kind:'memo'|'pass'}|{kind:'refuse';reason:string};
export function classifySharedStatement(query:string):SharedStatementClass{
 if(PASS_CONTROL.test(query))return {kind:'pass'};
 if(CONTROL.test(query))return {kind:'refuse',reason:'control'};
 if(!/^\s*\(?\s*(select|with|values|table)\b/i.test(query))return {kind:'refuse',reason:'unknown'};
 if(WRITING_FUNCTIONS.test(query)||learnedWriters.has(query))return {kind:'refuse',reason:'write'};
 if(BARRIER_FUNCTIONS.test(query))return {kind:'refuse',reason:'barrier'};
 for(const [reason,pattern] of REFUSE)if(pattern.test(query))return {kind:'refuse',reason};
 return VOLATILE.test(query)?{kind:'pass'}:{kind:'memo'};
}

function cloneValue(value:unknown):unknown{
 if(Array.isArray(value))return value.map(cloneValue);
 if(value instanceof Date)return new Date(value.getTime());
 if(Buffer.isBuffer(value))return Buffer.from(value);
 if(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
  const copy:Record<string,unknown>={};for(const key of Object.keys(value))copy[key]=cloneValue((value as Record<string,unknown>)[key]);return copy;
 }
 return value;
}
/** Every consumer receives its own rows; result metadata the driver attaches travels with the copy. */
function cloneResult(result:unknown):unknown{
 if(!Array.isArray(result))return cloneValue(result);
 const copy=result.map(cloneValue) as unknown[]&Record<string,unknown>;
 for(const key of ['count','command','columns','statement','state'])if(key in result)copy[key]=(result as unknown as Record<string,unknown>)[key];
 return copy;
}
const paramKey=(params:unknown)=>JSON.stringify(params??[],function(this:unknown,_key,value){
 const raw=(this as Record<string,unknown>)[_key];
 if(raw instanceof Date)return 'D:'+raw.toISOString();
 if(Buffer.isBuffer(raw))return 'B:'+raw.toString('hex');
 return typeof value==='bigint'?'N:'+value.toString():value;
});

type Pending={values():Pending;then(resolve?:(value:unknown)=>unknown,reject?:(error:unknown)=>unknown):Promise<unknown>;
 catch(reject:(error:unknown)=>unknown):Promise<unknown>;finally(done:()=>void):Promise<unknown>};
type DriverQuery=PromiseLike<unknown>&{values():PromiseLike<unknown>};
type DriverTransaction={unsafe(query:string,params?:unknown[],options?:unknown):DriverQuery};

/** Wrap the driver's transaction-scoped client for the one carrier transaction. Drizzle issues every statement
 * through `unsafe(query, params)` (optionally `.values()`), and the driver starts a query only when awaited. */
export function sharedReadDriver<T extends object>(sqlTx:T,session:SharedReadSession<unknown>,state:SharedReadCarrierState,control?:{current?:SharedReadCarrierControl}):T{
 const driver=sqlTx as unknown as DriverTransaction;
 const memo=new Map<string,Promise<unknown>>();
 // Settings already in force on this carrier transaction: READ ONLY from BEGIN, and any SET LOCAL jit it was sent.
 const held=new Map<string,string>([['transaction','read only']]);
 if(control)control.current={
  // A request preamble's answers (decision 12): each is entered exactly as the driver's own result for that statement
  // would be, before any owner joins. Only a plain read is answered ahead; an existing entry is never replaced.
  seed(seeds){
   let count=0;
   for(const seed of seeds){
    if(classifySharedStatement(seed.query).kind!=='memo')continue;
    const key=seed.mode+'\u0000'+seed.query+'\u0000'+paramKey(seed.params);
    if(memo.has(key))continue;
    memo.set(key,Promise.resolve(Object.assign(seed.rows.map(cloneValue),{count:seed.rows.length,command:'SELECT'})));
    count++;
   }
   session.stats.seeded+=count;
   return count;
  },
  // A setting the carrier's identity statement already put in force.
  hold(setting,value){held.set(setting,value);},
 };
 const unsafe=(query:string,params?:unknown[],options?:unknown):Pending=>{
  let mode:'rows'|'values'='rows',started:Promise<unknown>|undefined;
  const run=()=>started??=execute(query,params,options,mode);
  const pending:Pending={values(){mode='values';return pending;},
   then:(resolve,reject)=>run().then(resolve,reject),catch:reject=>run().catch(reject),finally:done=>run().finally(done)};
  return pending;
 };
 const send=(query:string,params:unknown[]|undefined,options:unknown,mode:'rows'|'values')=>{
  session.stats.statements++;
  if(state.inFlight++===0)session.stats.flights++;
  const sent=driver.unsafe(query,params,options);
  return Promise.resolve(mode==='values'?sent.values():sent).finally(()=>{state.inFlight--;}).catch(error=>{
   const code=String((error as {code?:unknown})?.code??'unknown');
   if(code==='25006'&&learnedWriters.size<LEARNED_LIMIT)learnedWriters.add(query);
   session.failed(code);throw error;
  });
 };
 const execute=(query:string,params:unknown[]|undefined,options:unknown,mode:'rows'|'values'):Promise<unknown>=>{
  // The carrier's own identity statement, before any owner can join: never counted, classified or memoized.
  if(state.bootstrapping){const sent=driver.unsafe(query,params,options);return Promise.resolve(mode==='values'?sent.values():sent);}
  const statement=classifySharedStatement(query);
  if(statement.kind==='refuse')return Promise.reject(session.refuse(statement.reason));
  // A transaction-local setting the carrier already holds changes nothing when sent again: answer it here. The carrier
  // is begun READ ONLY, so SET TRANSACTION READ ONLY is always already in force.
  if(statement.kind==='pass'&&options===undefined){
   const setting=/^\s*set\s+local\s+jit\s*(?:=|to)\s*(on|off)\s*;?\s*$/i.exec(query)?.[1]?.toLowerCase()??(/^\s*set\s+transaction\s+read\s+only\s*;?\s*$/i.test(query)?'read only':null);
   if(setting){
    const key=setting==='read only'?'transaction':'jit';
    if(held.get(key)===setting){session.stats.memoHits++;return Promise.resolve(Object.assign([],{count:null,command:'SET'}));}
    // Held from the moment it is sent: the driver runs this carrier's statements in order, and a failure aborts the
    // whole carrier, rerunning every owner on its own.
    held.set(key,setting);
    return send(query,params,options,mode);
   }
  }
  if(statement.kind==='pass'||options!==undefined)return send(query,params,options,mode);
  const key=mode+'\u0000'+query+'\u0000'+paramKey(params);
  let first=memo.get(key);
  if(first)session.stats.memoHits++;
  else{
   first=send(query,params,options,mode);
   memo.set(key,first);
   first.catch(()=>{memo.delete(key);});
  }
  return first.then(cloneResult);
 };
 return new Proxy(sqlTx,{get(target,property,receiver){
  if(property==='unsafe')return unsafe;
  if(property==='savepoint')return ()=>Promise.reject(session.refuse('savepoint'));
  return Reflect.get(target,property,receiver);
 }});
}
