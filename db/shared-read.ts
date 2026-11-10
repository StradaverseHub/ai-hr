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

export type SharedReadStats={joins:number;fallbacks:number;statements:number;memoHits:number;refused:Record<string,number>;failures:Record<string,number>;carriers:number};
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
 /** True only while a carrier sets its own transaction-local identity, before any owner can join it. */
 bootstrapping=false;
 readonly stats:SharedReadStats={joins:0,fallbacks:0,statements:0,memoHits:0,refused:{},failures:{},carriers:0};
 constructor(private readonly owner:object,readonly identity:string,private readonly open:()=>SharedReadCarrier<Tx>){}

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
 private leave(){this.active--;if(this.active===0&&this.waitingOwn>0)this.release();}
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
 const unsafe=(query:string,params?:unknown[],options?:unknown):Pending=>{
  let mode:'rows'|'values'='rows',started:Promise<unknown>|undefined;
  const run=()=>started??=execute(query,params,options,mode);
  const pending:Pending={values(){mode='values';return pending;},
   then:(resolve,reject)=>run().then(resolve,reject),catch:reject=>run().catch(reject),finally:done=>run().finally(done)};
  return pending;
 };
 const send=(query:string,params:unknown[]|undefined,options:unknown,mode:'rows'|'values')=>{
  session.stats.statements++;
  const sent=driver.unsafe(query,params,options);
  return Promise.resolve(mode==='values'?sent.values():sent).catch(error=>{
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
