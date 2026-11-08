/** Deterministic ownership controls, never native/database acceptance. */
import {expect,it} from 'vitest';
import {rewardsAuditPolicyLifetime} from './prototypes/rewards-audit-policy-lifetime';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function context(){const controller=new AbortController(),finish:(()=>Promise<void>)[]=[];return{controller,finish,value:{signal:controller.signal,onTestFinished:(hook:()=>Promise<void>)=>{finish.push(hook);}}};}
function clock(){let now=0;const events=new Map<()=>void,number>();return{value:{arm:(work:()=>void,ms:number)=>{events.set(work,now+ms);return()=>{events.delete(work);};}},tick(ms:number){now+=ms;for(const [work,at]of [...events])if(at<=now){events.delete(work);work();}}};}
it('owns deferred constructor before its first microtask and drains its late abort before refusing successors',async()=>{
 const entered=deferred(),construction=deferred(),stopped=deferred(),ctx=context(),events:string[]=[];
 const lifetime=rewardsAuditPolicyLifetime({work:async()=>{events.push('stop');construction.resolve();await stopped.promise;},cleanup:async()=>{}});
 const pending=lifetime.run(ctx.value,async()=>{entered.resolve();await construction.promise;expect(()=>lifetime.ownerPhase()).toThrow('aborted');events.push('drained');});
 await entered.promise;ctx.controller.abort(Error('fixed synthetic cancellation'));let finished=false;
 const finish=ctx.finish[0]().then(()=>{finished=true;});await Promise.resolve();expect(finished).toBe(false);expect(()=>lifetime.beforeCase()).toThrow();stopped.resolve();await Promise.all([pending,finish]);expect(events).toEqual(['stop','drained']);expect(()=>lifetime.beforeCase()).toThrow('successors refused');
});
it('unknown/uncertain constructor completion never authorizes guessed role/schema cleanup',async()=>{
 const events:string[]=[],lifetime=rewardsAuditPolicyLifetime({work:async()=>{events.push('work-stopped');},cleanup:async()=>{events.push('cleanup-stopped');}});
 await expect(lifetime.close(async()=>{events.push('DROP guessed object');},'uncertain')).rejects.toThrow('Unknown');expect(events).not.toContain('DROP guessed object');expect(()=>lifetime.beforeCase()).toThrow();
});
it('allows known owned guarded restoration after work abort but retains original failure and refuses new work',async()=>{
 const ctx=context(),wait=deferred(),entered=deferred(),lifetime=rewardsAuditPolicyLifetime({work:async()=>{wait.resolve();},cleanup:async()=>{}});
 const pending=lifetime.run(ctx.value,async()=>{entered.resolve();await wait.promise;});await entered.promise;ctx.controller.abort(Error('synthetic deadline'));await pending;await ctx.finish[0]();
 let restored=false;await expect(lifetime.close(async()=>{expect(lifetime.ownerPhase()).toBe('cleanup');restored=true;},'known')).rejects.toThrow('aborted');expect(restored).toBe(true);expect(()=>lifetime.beforeCase()).toThrow();
});
it('closes cleanup admission at one aggregate18s deadline across multiple queries and drains the actual stop before completion',async()=>{
 const timer=clock(),query=deferred(),stop=deferred(),entered=deferred(),events:string[]=[];
 const lifetime=rewardsAuditPolicyLifetime({work:async()=>{},cleanup:async()=>{events.push('stop');query.resolve();await stop.promise;}},timer.value);
 const cleanup=lifetime.close(async()=>{expect(lifetime.ownerPhase()).toBe('cleanup');events.push('query1');entered.resolve();await query.promise;expect(()=>lifetime.ownerPhase()).toThrow('deadline');events.push('refused-query2');},'known');
 await entered.promise;timer.tick(18000);let done=false;void cleanup.catch(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);stop.resolve();await expect(cleanup).rejects.toThrow('deadline');expect(events.slice(0,3)).toEqual(['query1','stop','refused-query2']);expect(()=>lifetime.beforeCase()).toThrow();
});
