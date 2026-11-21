/** Pure complete-operation/frontier models; no database authority. */
import {expect,it} from 'vitest';
import {employeeChoiceNativeCaseOwner,employeeChoiceNativeControlBounds} from './performance/employee-choice-native-case-owner';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function clock(){let now=0;const tasks=new Set<{at:number;work:()=>void}>();return{now:()=>now,schedule:(work:()=>void,ms:number)=>{const row={at:now+ms,work};tasks.add(row);return()=>{tasks.delete(row);};},advance(ms:number){now+=ms;for(const row of [...tasks])if(row.at<=now){tasks.delete(row);row.work();}},pending:()=>tasks.size};}
function context(){const signal=new AbortController(),hooks:(()=>Promise<void>)[]=[];return{signal,hooks,value:{signal:signal.signal,onTestFinished:(hook:()=>Promise<void>)=>{hooks.push(hook);}}};}
it('registers ownership before work microtask and drains a cancelled deferred operation before any successor',async()=>{
 const time=clock(),cases=employeeChoiceNativeCaseOwner(time),c=context();let called=false;
 const operation=cases.run(c.value,async()=>{called=true;});c.signal.abort(Error('fixed model cancellation'));
 await expect(operation).rejects.toThrow('stopped');await c.hooks[0]!();await cases.drain();expect(called).toBe(false);expect(time.pending()).toBe(0);
 expect(()=>cases.run(context().value,async()=>{})).toThrow('stopped');
});
it('retains the18s work frontier and full26s cleanup ownership even after the case aborts',async()=>{
 const time=clock(),cases=employeeChoiceNativeCaseOwner(time),c=context(),entered=deferred(),work=deferred(),cleanup=deferred();let aborted=false,deadline=0;
 const operation=cases.run(c.value,async owned=>{owned.signal.addEventListener('abort',()=>{aborted=true;});deadline=owned.cleanupDeadline;entered.resolve();try{await work.promise;}finally{owned.enterCleanup();await cleanup.promise;}});
 await entered.promise;expect(employeeChoiceNativeControlBounds).toEqual({workMs:18000,totalMs:26000});time.advance(18000);expect(aborted).toBe(true);expect(deadline).toBe(26000);
 let drained=false;const hook=c.hooks[0]!().then(()=>{drained=true;});work.resolve();await Promise.resolve();expect(drained).toBe(false);time.advance(8000);cleanup.resolve();await expect(operation).rejects.toThrow('complete-operation');await hook;expect(drained).toBe(true);expect(time.pending()).toBe(0);
 expect(()=>cases.run(context().value,async()=>{})).toThrow('stopped');
});
it('stops the work timer when actual cleanup begins and preserves a successful complete reserve inside26s',async()=>{
 const time=clock(),cases=employeeChoiceNativeCaseOwner(time),c=context(),entered=deferred(),release=deferred();let aborted=false;
 const operation=cases.run(c.value,async owned=>{time.advance(17000);owned.enterCleanup();owned.signal.addEventListener('abort',()=>{aborted=true;});entered.resolve();await release.promise;});
 await entered.promise;time.advance(8000);expect(aborted).toBe(false);release.resolve();await operation;await c.hooks[0]!();expect(time.pending()).toBe(0);
 const next=context();await cases.run(next.value,async owned=>{owned.enterCleanup();});await next.hooks[0]!();
});
