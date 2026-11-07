import {expect,it,vi} from 'vitest';
import {settleReadGroup} from '../lib/settle-read-group';
import {createBackgroundReadAdmission} from '../db/background-read-admission';

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}

it('retains result order when children finish out of order',async()=>{
 const first=deferred<number>(),second=deferred<string>();
 const result=settleReadGroup([()=>first.promise,()=>second.promise]);
 second.resolve('second');first.resolve(1);
 expect(await result).toEqual([1,'second']);
});

it('owns later IO phases and preserves the first observed failure until all children settle',async()=>{
 const gate=createBackgroundReadAdmission({capacity:1,maxWaiting:2,waitMs:1000});
 const earlierIndex=deferred<void>(),laterIndex=deferred<void>(),phase=deferred<void>(),tail=deferred<void>();
 const original=new Error('first observed'),later=new Error('later observed');
 let registered=false,phaseEntered=false,finished=false,nextEntered=false;
 const first=gate.run('a',()=>settleReadGroup([
  ()=>{registered=true;return earlierIndex.promise;},()=>laterIndex.promise,
  async()=>{await phase.promise;phaseEntered=true;await tail.promise;},
 ]));
 const observed=first.then(()=>{finished=true;},error=>{finished=true;return error;});
 const next=gate.run('b',async()=>{nextEntered=true;});
 await vi.waitFor(()=>expect(registered).toBe(true));
 laterIndex.reject(original);await Promise.resolve();earlierIndex.reject(later);
 phase.resolve();await vi.waitFor(()=>expect(phaseEntered).toBe(true));
 expect(finished).toBe(false);expect(nextEntered).toBe(false);
 expect(gate.snapshot()).toMatchObject({active:1,waiting:1});
 tail.resolve();expect(await observed).toBe(original);await next;
 expect(gate.snapshot()).toMatchObject({active:0,waiting:0});
});

it.each([undefined,null,false,0])('drains a later shared promise after a synchronous throw (%s)',async reason=>{
 const shared=deferred<void>();let observed=false,registered=false;
 const result=settleReadGroup([()=>{throw reason;},()=>{registered=true;return shared.promise;}]);
 const failure=result.then(()=>{throw new Error('expected failure');},error=>{observed=true;return {error};});
 await Promise.resolve();expect(registered).toBe(true);expect(observed).toBe(false);
 shared.resolve();expect(await failure).toEqual({error:reason});
});
