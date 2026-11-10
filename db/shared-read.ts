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

export class SharedReadIncompatibleError extends Error{
 constructor(readonly reason:string){super('This read must use its own transaction ('+reason+').');this.name='SharedReadIncompatibleError';}
}

/** `flights`: network round trips of the carrier's statements. The driver pipelines statements sent while others are in
 * flight on the carrier connection, so several statements can share one round trip; a flight starts whenever a
 * statement is sent with none outstanding. */
export type SharedReadStats={joins:number;fallbacks:number;statements:number;memoHits:number;refused:Record<string,number>;failures:Record<string,number>;carriers:number;flights:number};
type Join={tainted:boolean};
const sessions=new AsyncLocalStorage<SharedReadSession<unknown>>();
const joins=new AsyncLocalStorage<Join>();

const independent=new AsyncLocalStorage<true>();
export function currentSharedRead():SharedReadSession<unknown>|undefined{return independent.getStore()?undefined:sessions.getStore();}
/** Every owner inside `work` keeps its own transaction, exactly as before shared snapshots existed. Equivalence
 * proofs compare this path with the shared one; it changes no authority and no result. */
export function withIndependentTransactions<T>(work:()=>Promise<T>):Promise<T>{return independent.run(true,work);}
export function independentTransactionsRequired():boolean{return independent.getStore()===true;}
export function runInSharedRead<T>(session:SharedReadSession<unknown>,work:()=>Promise<T>):Promise<T>{return sessions.run(session,work);}

/** One open carrier transaction. `finish` lets it commit; `done` settles after COMMIT or ROLLBACK. */
export type SharedReadCarrier<Tx>={tx:Promise<Tx>;finish:()=>void;done:Promise<void>};

export class SharedReadSession<Tx>{
 private carrier?:SharedReadCarrier<Tx>;
 private readonly carriers:Promise<void>[]=[];
 private poisoned=false;
 private closed=false;
 private active=0;
 private waitingOwn=0;
 /** Request-scoped sessions only: compositions currently running inside this session. */
 private works=0;
 /** True only while a carrier sets its own transaction-local identity, before any owner can join it. */
 bootstrapping=false;
 readonly stats:SharedReadStats={joins:0,fallbacks:0,statements:0,memoHits:0,refused:{},failures:{},carriers:0,flights:0};
 /** Statements sent on the current carrier and not yet answered (diagnostic flight count only). */
 inFlight=0;
 /** `idleRelease`: a request-scoped session is shared by several independent compositions of one request (the
  * Today sections and the shell's approvals). It is never closed; its carrier commits whenever no composition and
  * no owner is inside it, so it never holds a connection between them. A later composition opens a fresh carrier. */
 constructor(private readonly owner:object,readonly identity:string,private readonly open:()=>SharedReadCarrier<Tx>,private readonly idleRelease=false){}

 /** Only the same database client and the exact same transaction identity settings. */
 admits(owner:object,identity:string){return !this.closed&&owner===this.owner&&identity===this.identity;}
 poison(){this.poisoned=true;}

 async join<T>(fn:(tx:Tx)=>Promise<T>,ownTransaction:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();
  if(this.poisoned||this.closed)return this.fallback(ownTransaction);
  this.active++;
  let tainted=false,result:{ok:true;value:T}|{ok:false;error:unknown}|undefined;
  try{
   let tx:Tx;
   try{tx=await (this.carrier??=this.begin()).tx;}
   catch{this.poisoned=true;tainted=true;}
   if(!tainted){
    signal?.throwIfAborted();
    this.stats.joins++;
    const join:Join={tainted:false};
    try{result={ok:true,value:await joins.run(join,()=>fn(tx!))};}
    catch(error){result={ok:false,error};}
    // A failure while the shared transaction is aborted may come from a sibling's statement this owner awaited.
    tainted=join.tainted||(!result.ok&&this.poisoned);
   }
  }finally{this.leave();}
  // A refused or failed statement anywhere in this owner's work: discard everything it saw and rerun it.
  if(tainted)return this.fallback(ownTransaction);
  if(!result!.ok)throw result!.error;
  return result!.value;
 }
 private begin(){this.stats.carriers++;this.bootstrapping=true;const carrier=this.open();this.carriers.push(carrier.done);return carrier;}
 private leave(){this.active--;if(this.active===0&&(this.waitingOwn>0||this.idleRelease&&this.works===0))this.release();}
 /** One request-scoped composition: while it runs, its owners join this session; when the last one settles and no
  * owner is inside, the carrier commits. Results and failures are the composition's own. */
 async track<T>(work:()=>Promise<T>):Promise<T>{
  this.works++;
  try{return await runInSharedRead(this as SharedReadSession<unknown>,work);}
  finally{this.works--;if(this.works===0&&this.active===0)this.release();}
 }
 /** Every carrier this session opened has committed or rolled back. */
 settled(){return Promise.all(this.carriers.map(done=>done.catch(()=>undefined))).then(()=>undefined);}
 /** Commit an idle carrier so this request never holds a pool slot while its own fallback waits for one. A later
  * join opens a fresh carrier (a new snapshot and an empty memo). */
 private release(){const carrier=this.carrier;this.carrier=undefined;carrier?.finish();}
 private async fallback<T>(ownTransaction:()=>Promise<T>){
  this.stats.fallbacks++;this.waitingOwn++;
  if(this.active===0)this.release();
  try{return await ownTransaction();}finally{this.waitingOwn--;}
 }
 /** After the request's reads settle: commit every carrier and wait for each to finish. */
 async close(){this.closed=true;this.release();await Promise.all(this.carriers.map(done=>done.catch(()=>undefined)));}
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
export function sharedReadDriver<T extends object>(sqlTx:T,session:SharedReadSession<unknown>):T{
 const driver=sqlTx as unknown as DriverTransaction;
 const memo=new Map<string,Promise<unknown>>();
 // Settings already in force on this carrier transaction: READ ONLY from BEGIN, and any SET LOCAL jit it was sent.
 const held=new Map<string,string>([['transaction','read only']]);
 const observe=(globalThis as {__aihrPerfSharedStatement?:(query:string)=>void}).__aihrPerfSharedStatement;
 const unsafe=(query:string,params?:unknown[],options?:unknown):Pending=>{
  let mode:'rows'|'values'='rows',started:Promise<unknown>|undefined;
  const run=()=>started??=execute(query,params,options,mode);
  const pending:Pending={values(){mode='values';return pending;},
   then:(resolve,reject)=>run().then(resolve,reject),catch:reject=>run().catch(reject),finally:done=>run().finally(done)};
  return pending;
 };
 const send=(query:string,params:unknown[]|undefined,options:unknown,mode:'rows'|'values')=>{
  session.stats.statements++;
  // Diagnostics only: a sent statement, reported in the issuing owner's own async context.
  observe?.(query);
  if(session.inFlight++===0)session.stats.flights++;
  const sent=driver.unsafe(query,params,options);
  return Promise.resolve(mode==='values'?sent.values():sent).finally(()=>{session.inFlight--;}).catch(error=>{
   const code=String((error as {code?:unknown})?.code??'unknown');
   if(code==='25006'&&learnedWriters.size<LEARNED_LIMIT)learnedWriters.add(query);
   session.failed(code);throw error;
  });
 };
 const execute=(query:string,params:unknown[]|undefined,options:unknown,mode:'rows'|'values'):Promise<unknown>=>{
  // The carrier's own identity statement, before any owner can join: never counted, classified or memoized.
  if(session.bootstrapping){const sent=driver.unsafe(query,params,options);return Promise.resolve(mode==='values'?sent.values():sent);}
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
