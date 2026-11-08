/** Pure lifecycle models only; no native DB/worker performance claim. */
import {expect,it} from 'vitest';
import {employeeChoiceSqlFrontier,employeeChoiceCloseRegistry,employeeChoiceReadFrontier} from './performance/employee-choice-sql-frontier';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
it('checks every tagged/unsafe/transaction statement and callback before admitting work after stop',async()=>{
 let stopped=false,calls=0;const active=()=>{if(stopped)throw Error('stopped');};
 type Native=(()=>string)&{unsafe:()=>string;begin:(work:(tx:Native)=>Promise<void>)=>Promise<void>};
 const native:Native=Object.assign(()=>{calls++;return'row';},{unsafe(){calls++;return'row';},async begin(work:(tx:Native)=>Promise<void>){calls++;await work(native);}});
 const guarded=employeeChoiceSqlFrontier(native,active),entered=deferred(),release=deferred();
 expect(guarded()).toBe('row');expect(guarded.unsafe()).toBe('row');
 const work=guarded.begin(async tx=>{expect(tx()).toBe('row');entered.resolve();await release.promise;expect(()=>tx()).toThrow('stopped');expect(()=>tx.unsafe()).toThrow('stopped');});
 await entered.promise;const before=calls;stopped=true;expect(()=>guarded()).toThrow();expect(()=>guarded.unsafe()).toThrow();expect(()=>guarded.begin(async()=>{})).toThrow();release.resolve();await work;expect(calls).toBe(before);
});
it('owns late constructor close before returning, caches one close, and drains all failures rather than detaching cleanup',async()=>{
 const registry=employeeChoiceCloseRegistry(),pending=deferred(),entered=deferred();let first=0,late=0;
 const one=registry.register(async()=>{first++;throw Error('first refused');});
 await expect(registry.stop()).rejects.toThrow('settlement');
 const close=registry.register(async()=>{late++;entered.resolve();await pending.promise;throw Error('late refused');});
 await entered.promise;expect(late).toBe(1);expect(close()).toBe(close());expect(one()).toBe(one());
 let finished=false;const settled=registry.settle().finally(()=>{finished=true;});await Promise.resolve();expect(finished).toBe(false);pending.resolve();
 const failure=await settled.catch((error:unknown)=>error);expect(failure).toBeInstanceOf(AggregateError);if(!(failure instanceof AggregateError))throw Error('compound required');
 expect(failure.errors.map(value=>(value as Error).message)).toEqual(['first refused','late refused']);expect(first).toBe(1);expect(late).toBe(1);
});

it('guards lazy Drizzle-shaped execution at the synchronous clock frontier and returns exact native DTO objects',async()=>{
 let time=0,statements=0;const rows=[{id:'fixed retained native DTO'}];
 const native={select(){return{getSQL(){return'fixed';},from(){
  const query:PromiseLike<typeof rows>&{getSQL:()=>string}={
   then<TResult1=typeof rows,TResult2=never>(fulfilled?:((value:typeof rows)=>TResult1|PromiseLike<TResult1>)|null,rejected?:((reason:unknown)=>TResult2|PromiseLike<TResult2>)|null){statements++;return Promise.resolve(rows).then(fulfilled,rejected);},
   getSQL(){return'fixed';},
  };return query;
 }};}};
 const tx=employeeChoiceReadFrontier(native,()=>{if(time>=840000)throw Error('clock stopped');});
 const first=await tx.select().from();expect(first).toBe(rows);expect(statements).toBe(1);
 const lazy=tx.select().from();time=840000;await expect(Promise.resolve(lazy)).rejects.toThrow('clock stopped');expect(statements).toBe(1);expect(()=>tx.select()).toThrow('clock stopped');
});
