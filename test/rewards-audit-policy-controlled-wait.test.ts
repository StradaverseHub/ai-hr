/** Pure ownership/outcome controls only; never native acceptance. */
import {expect,it} from 'vitest';
import {controlledPolicyWait} from './prototypes/rewards-audit-policy-controlled-wait';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
it('registers actual task creation before its first microtask and drains after release failure before unsubscribe',async()=>{
 const primary=Error('work'),release=Error('unlock'),native=Error('pending native'),pending=deferred<void>(),entered=deferred<void>(),poisoned:Error[]=[],events:string[]=[];let starts=0;
 const scope=controlledPolicyWait(error=>poisoned.push(error));
 const task=scope.start(()=>{starts++;events.push('native');entered.resolve();return pending.promise;});expect(starts).toBe(0);
 const result=scope.run(async()=>{await entered.promise;throw primary;},async()=>{events.push('release');throw release;},()=>{events.push('unsubscribed');});
 let settled=false;void result.catch(()=>{settled=true;});await entered.promise;await Promise.resolve();expect(settled).toBe(false);expect(events).not.toContain('unsubscribed');
 pending.reject(native);await expect(result).rejects.toMatchObject({errors:[primary,release,native],cause:primary});expect(events).toEqual(['native','release','unsubscribed']);expect(poisoned).toHaveLength(1);
 expect(()=>scope.start(async()=>{})).toThrow('admission closed');await expect(scope.run(async()=>{throw Error('must not run');},async()=>{})).rejects.toThrow('admission closed');
 // Holding a task token alone does not consume a native failure.
 expect(task).toBeDefined();
});
it('accepts an expected failure only through actual outcome consumption and refuses unobserved rejected work',async()=>{
 const native=Error('expected42501'),scope=controlledPolicyWait();const task=scope.start(()=>Promise.reject(native));
 await expect(scope.run(async()=>{await expect(task.value()).rejects.toBe(native);scope.consume(task,native);},async()=>{})).resolves.toBeUndefined();
 const missing=controlledPolicyWait(),unobserved=Error('unobserved');missing.start(()=>Promise.reject(unobserved));
 await expect(missing.run(async()=>{},async()=>{})).rejects.toBe(unobserved);
});
it('does not mark a Promise.race loser observed when readiness won and preserves later native failure with primary',async()=>{
 const pending=deferred<void>(),ready=deferred<void>(),entered=deferred<void>(),controller=new AbortController(),native=Error('loser rejected later'),primary=Error('early assertion'),scope=controlledPolicyWait();
 const task=scope.start(()=>{entered.resolve();return pending.promise;});
 const result=scope.run(async()=>{await scope.ready(ready.promise,task,controller.signal,'unexpected early exit');throw primary;},async()=>{pending.reject(native);});
 await entered.promise;ready.resolve();await expect(result).rejects.toMatchObject({errors:[primary,native],cause:primary});
});
it('preserves exact error identity without duplicate aggregation and retains distinct release/unsubscribe failures after abort drain',async()=>{
 const same=Error('same failure'),scope=controlledPolicyWait(),controller=new AbortController(),never=deferred<void>();const task=scope.start(()=>Promise.reject(same));
 await expect(scope.run(()=>scope.ready(never.promise,task,controller.signal,'early'),async()=>{throw same;})).rejects.toBe(same);
 const blocked=controlledPolicyWait(),body=deferred<void>(),started=deferred<void>(),aborted=new AbortController(),primary=Error('abort'),release=Error('release'),detach=Error('detach');
 const owned=blocked.start(()=>{started.resolve();return body.promise;});
 const result=blocked.run(async()=>{await blocked.ready(deferred<void>().promise,owned,aborted.signal,'early');},async()=>{body.resolve();throw release;},()=>{throw detach;});
 await started.promise;aborted.abort(primary);await expect(result).rejects.toMatchObject({errors:[primary,release,detach],cause:primary});
});
it('drains shared native work before instrument restoration and preserves nested primary/error identity once',async()=>{
 const pending=deferred<void>(),entered=deferred<void>(),primary=Error('controlled witness'),native=Error('late command'),scope=controlledPolicyWait(),events:string[]=[];
 scope.start(()=>{entered.resolve();return pending.promise;});
 const result=scope.run(async()=>{
  await controlledPolicyWait().run(()=>scope.run(async()=>{await entered.promise;throw primary;},async()=>{events.push('unlock');}),async()=>{events.push('restore');});
 },async()=>{events.push('outer release');},()=>{events.push('unsubscribe');});
 let settled=false;void result.catch(()=>{settled=true;});await entered.promise;await Promise.resolve();expect(settled).toBe(false);expect(events).not.toContain('restore');
 pending.reject(native);
 await expect(result).rejects.toMatchObject({errors:[primary,native],cause:primary});expect(events).toEqual(['unlock','restore','outer release','unsubscribe']);
});
it('does not consume a rejection merely because a value read began and validates exact explicit consumption',async()=>{
 const pending=deferred<void>(),native=Error('unobserved native'),primary=Error('early primary'),scope=controlledPolicyWait();
 const task=scope.start(()=>pending.promise);const read=task.value();void read.catch(()=>{});
 expect(()=>scope.consume(task,native)).toThrow('Exact settled');
 const result=scope.run(async()=>{throw primary;},async()=>{pending.reject(native);});
 await expect(result).rejects.toMatchObject({errors:[primary,native],cause:primary});
 expect(()=>scope.consume(task,Error('different identity'))).toThrow('Exact settled');
});
