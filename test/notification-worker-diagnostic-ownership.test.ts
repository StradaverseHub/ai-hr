import {expect,it} from 'vitest';
import {notificationDiagnosticOwnership} from './fixtures/notification-worker/diagnostic-ownership';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function context(){const controller=new AbortController(),finished:(()=>Promise<void>)[]=[];return{controller,finished,value:{signal:controller.signal,onTestFinished:(hook:()=>Promise<void>)=>{finished.push(hook);}}};}
it('aborted case owns async restoration until both teardown drains finish and permanently blocks successor writes',async()=>{
 const owner=notificationDiagnosticOwnership(),ctx=context(),entered=deferred(),release=deferred(),events:string[]=[];
 const work=owner.run(ctx.value,async()=>{entered.resolve();try{await release.promise;}finally{events.push('restore');}});await entered.promise;ctx.controller.abort(Error('Fixed synthetic deadline'));
 let hookDrained=false,teardownDrained=false;const hook=ctx.finished[0]().then(()=>{hookDrained=true;}),teardown=owner.drain().then(()=>{teardownDrained=true;});
 await Promise.resolve();expect(hookDrained).toBe(false);expect(teardownDrained).toBe(false);expect(()=>{owner.beforeCase();events.push('reset');}).toThrow('successor mutation refused');
 release.resolve();await Promise.all([work,hook,teardown]);expect(events).toEqual(['restore']);expect(hookDrained&&teardownDrained).toBe(true);expect(()=>owner.beforeCase()).toThrow('successor mutation refused');
});
it('refuses overlapping setup and releases a healthy case only after its registered finish drain',async()=>{
 const owner=notificationDiagnosticOwnership(),ctx=context(),entered=deferred(),release=deferred();const work=owner.run(ctx.value,async()=>{entered.resolve();await release.promise;});await entered.promise;
 expect(()=>owner.beforeCase()).toThrow('not drained');release.resolve();await work;await owner.drain();expect(()=>owner.beforeCase()).toThrow('not drained');await ctx.finished[0]();expect(()=>owner.beforeCase()).not.toThrow();
 const next=context(),ready=deferred(),done=deferred(),second=owner.run(next.value,async()=>{ready.resolve();await done.promise;});await ready.promise;await ctx.finished[0]();expect(()=>owner.beforeCase()).toThrow('not drained');done.resolve();await second;await next.finished[0]();expect(()=>owner.beforeCase()).not.toThrow();
});
it('restoration uncertainty poisons later setup while the original owned error remains rejected',async()=>{
 const owner=notificationDiagnosticOwnership(),ctx=context(),failure=Error('Fixed restoration refusal');const work=owner.run(ctx.value,async()=>{owner.poison(failure);throw failure;});
 await expect(work).rejects.toBe(failure);await owner.drain();await ctx.finished[0]();expect(()=>owner.beforeCase()).toThrow('Fixed restoration refusal');
});
