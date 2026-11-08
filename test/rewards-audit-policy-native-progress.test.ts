/** Deferred lifecycle models only; native SQL/body/wait evidence remains required. */
import {expect,it} from 'vitest';
import {controlledPolicyWait} from './prototypes/rewards-audit-policy-controlled-wait';
import {waitRewardPolicyNativeProgress} from './prototypes/rewards-audit-policy-native-progress';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
it('publishes progress only after the actual observer returns true and owns the held task through release',async()=>{
 const control=controlledPolicyWait(),receipt=deferred<void>(),observed=deferred<boolean>(),started=deferred<void>();let calls=0,finished=false;
 const task=control.start(()=>receipt.promise);
 const work=control.run(async()=>{const wait=waitRewardPolicyNativeProgress(control,task,new AbortController().signal,async()=>{calls++;started.resolve();return observed.promise;}).then(()=>{finished=true;});await started.promise;await Promise.resolve();expect(finished).toBe(false);observed.resolve(true);await wait;expect(finished).toBe(true);expect(calls).toBe(1);},async()=>{receipt.resolve();});await work;
});
it('an early actual receipt failure cannot finish until the late native observation drains or start another observation',async()=>{
 const control=controlledPolicyWait(),receipt=deferred<void>(),query=deferred<boolean>(),started=deferred<void>(),primary=Error('exact receipt failure');let calls=0,settled=false;
 const task=control.start(()=>receipt.promise),work=control.run(()=>waitRewardPolicyNativeProgress(control,task,new AbortController().signal,async()=>{calls++;started.resolve();return query.promise;}),async()=>{});
 const outcome=work.then(()=>undefined,error=>{settled=true;return error;});await started.promise;receipt.reject(primary);await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);query.resolve(true);expect(await outcome).toBe(primary);expect(calls).toBe(1);
});
it('a failed native observation preserves its original identity while the actual receipt still requires release/drain',async()=>{
 const control=controlledPolicyWait(),receipt=deferred<void>(),query=deferred<boolean>(),started=deferred<void>(),native=Error('exact native observer error');let released=false;
 const task=control.start(()=>receipt.promise),work=control.run(()=>waitRewardPolicyNativeProgress(control,task,new AbortController().signal,()=>{started.resolve();return query.promise;}),async()=>{released=true;receipt.resolve();});
 const result=work.then(()=>undefined,error=>error);await started.promise;query.reject(native);expect(await result).toBe(native);expect(released).toBe(true);
});
it('distinct receipt and native observation failures during final drain are both retained without another poll',async()=>{
 const control=controlledPolicyWait(),receipt=deferred<void>(),query=deferred<boolean>(),started=deferred<void>(),primary=Error('receipt'),drain=Error('native drain');let calls=0;
 const task=control.start(()=>receipt.promise),work=control.run(()=>waitRewardPolicyNativeProgress(control,task,new AbortController().signal,()=>{calls++;started.resolve();return query.promise;}),async()=>{});
 const result=work.then(()=>undefined,error=>error);await started.promise;receipt.reject(primary);await Promise.resolve();await Promise.resolve();query.reject(drain);const failure=await result;expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toContain(primary);expect(failure.errors).toContain(drain);expect(failure.errors).toHaveLength(2);expect(calls).toBe(1);
});
