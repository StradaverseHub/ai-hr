import {expect,it} from 'vitest';
import {rewardAuditPrototypeOwnership} from './prototypes/rewards-audited-read-ownership';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function context(){const controller=new AbortController(),finished:(()=>Promise<void>)[]=[];return{controller,finished,value:{signal:controller.signal,onTestFinished:(hook:()=>Promise<void>)=>{finished.push(hook);}}};}
it('owns setup and body phases through delayed cleanup before releasing the next case',async()=>{
 const owner=rewardAuditPrototypeOwnership(),ctx=context(),setup=deferred(),started=deferred();owner.beforeSetup();
 const preparation=owner.phase(ctx.value,async()=>{started.resolve();await setup.promise;});await started.promise;
 await expect(owner.phase(ctx.value,async()=>{})).rejects.toThrow('Overlapping');setup.resolve();await preparation;
 const release=deferred(),entered=deferred(),body=owner.phase(ctx.value,async()=>{entered.resolve();await release.promise;});await entered.promise;
 let drained=false;const drain=owner.drain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);expect(()=>owner.beforeSetup()).toThrow('not drained');
 await ctx.finished[0]();expect(()=>owner.beforeSetup()).toThrow('not drained');release.resolve();await Promise.all([body,drain]);await ctx.finished[1]();expect(()=>owner.beforeSetup()).not.toThrow();
});
it('timeout preserves ownership until restoration settles and permanently refuses successor writes',async()=>{
 const owner=rewardAuditPrototypeOwnership(),ctx=context(),release=deferred(),entered=deferred(),events:string[]=[];
 const body=owner.phase(ctx.value,async()=>{entered.resolve();try{await release.promise;}finally{events.push('restored');}});await entered.promise;ctx.controller.abort(Error('Fixed synthetic deadline'));
 let done=false;const finish=ctx.finished[0]().then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);expect(()=>{owner.beforeSetup();events.push('reset');}).toThrow('successor setup refused');release.resolve();await Promise.all([body,finish]);expect(events).toEqual(['restored']);expect(()=>owner.beforeSetup()).toThrow('successor setup refused');
});
it('retains restoration refusal after all promises settle',async()=>{
 const owner=rewardAuditPrototypeOwnership(),ctx=context(),failure=Error('Fixed profile restoration refusal');await expect(owner.phase(ctx.value,async()=>{owner.poison(failure);throw failure;})).rejects.toBe(failure);await owner.drain();await ctx.finished[0]();expect(()=>owner.beforeSetup()).toThrow(failure.message);
});
