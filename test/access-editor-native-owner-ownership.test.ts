/** Deferred ownership models only, never native migration/permission proof. */
import {expect,it} from 'vitest';
import {accessEditorOwnedWork} from './fixtures/access-editor-owned-work';
import {accessCleanupLifetime,requireAccessCleanupOid} from './fixtures/access-editor-cleanup-lifetime';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function context(){const control=new AbortController(),hooks:Array<()=>Promise<void>>=[];return{control,hooks,context:{signal:control.signal,onTestFinished:(hook:()=>Promise<void>)=>{hooks.push(hook);}}};}
it('registers pending construction before its first microtask and refuses pre-start cancellation',async()=>{
 const owner=accessEditorOwnedWork(),c=context();let started=false;const work=owner.run(c.context,async()=>{started=true;});
 expect(()=>owner.beforeCase()).toThrow('not drained');c.control.abort(Error('model timeout'));await expect(work).rejects.toThrow('aborted');await Promise.all(c.hooks.map(hook=>hook()));expect(started).toBe(false);expect(()=>owner.beforeCase()).toThrow('aborted');
});
it('drains constructor and full restoration/drop finally after timeout before a framework finish hook settles',async()=>{
 const owner=accessEditorOwnedWork(),c=context(),entered=deferred(),release=deferred(),restoring=deferred(),restored=deferred();const order:string[]=[];
 const work=owner.run(c.context,async()=>{order.push('constructor');entered.resolve();try{await release.promise;}finally{order.push('restoring');restoring.resolve();await restored.promise;order.push('owned-db-and-roles-dropped');}});await entered.promise;
 c.control.abort(Error('model timeout'));let finished=false;const hook=Promise.all(c.hooks.map(finish=>finish())).then(()=>{finished=true;});
 release.resolve();await restoring.promise;expect(finished).toBe(false);await expect(owner.run(c.context,async()=>{})).rejects.toThrow('aborted');restored.resolve();await work;await hook;
 expect(order).toEqual(['constructor','restoring','owned-db-and-roles-dropped']);expect(finished).toBe(true);expect(()=>owner.beforeCase()).toThrow('aborted');
});
it('keeps cleanup uncertainty poisoned and refuses any reset while owned cleanup is pending',async()=>{
 const owner=accessEditorOwnedWork(),c=context(),entered=deferred(),release=deferred(),failure=Error('Owned drop uncertain');
 const work=owner.run(c.context,async()=>{entered.resolve();try{await release.promise;}finally{owner.poison(failure);throw failure;}});await entered.promise;
 expect(()=>owner.beforeCase()).toThrow('not drained');release.resolve();await expect(work).rejects.toBe(failure);await Promise.all(c.hooks.map(hook=>hook()));expect(()=>owner.beforeCase()).toThrow('Owned drop uncertain');
});

function cleanupClock(){
 let at=0,next=0;const timers=new Map<number,{due:number;work:()=>void}>();
 return{now:()=>at,schedule(work:()=>void,ms:number){const id=++next;timers.set(id,{due:at+ms,work});return()=>{timers.delete(id);};},advance(to:number){at=to;for(const[id,timer]of [...timers].sort((a,b)=>a[1].due-b[1].due))if(timer.due<=at&&timers.delete(id))timer.work();}};
}
it('bounds multiple cleanup phases together and drains an aborted second phase before refusing any later DROP',async()=>{
 const time=cleanupClock(),entered=deferred(),release=deferred(),closed=deferred(),poison:Error[]=[];let cancelled=false,laterDrop=false,finished=false;
 const life=accessCleanupLifetime(0,async()=>{cancelled=true;await closed.promise;},async()=>{},error=>poison.push(error),time);
 await life.step(async()=>{time.advance(16000);});const phase=life.step(async()=>{entered.resolve();await release.promise;});void phase.catch(()=>{});await entered.promise;
 time.advance(18000);const finish=life.finish(async()=>{});void finish.catch(()=>{});void finish.finally(()=>{finished=true;}).catch(()=>{});
 await Promise.resolve();expect(cancelled).toBe(true);expect(finished).toBe(false);release.resolve();await expect(phase).rejects.toThrow('work deadline');
 await expect(life.step(async()=>{laterDrop=true;})).rejects.toThrow('work deadline');expect(finished).toBe(false);closed.resolve();await expect(finish).rejects.toThrow('work deadline');
 expect(laterDrop).toBe(false);expect(poison.length).toBeGreaterThan(0);expect(life.snapshot()).toMatchObject({pending:false,uncertain:true});
});
it('allows bounded final observation after completed cleanup while retaining the26-second aggregate',async()=>{
 const time=cleanupClock(),entered=deferred(),release=deferred(),poison:Error[]=[];let workClosed=false,observerClosed=false;
 const life=accessCleanupLifetime(0,async()=>{workClosed=true;},async()=>{observerClosed=true;},error=>poison.push(error),time);
 await life.step(async()=>{time.advance(17000);});const finish=life.finish(async step=>{await step(async()=>{entered.resolve();await release.promise;});});await entered.promise;
 time.advance(22000);release.resolve();await finish;expect(poison).toEqual([]);expect(workClosed&&observerClosed).toBe(true);expect(life.snapshot()).toMatchObject({elapsedMs:22000,pending:false,stopped:false,uncertain:false});
});
it('cancels and drains final native observation at26seconds instead of claiming absence from a detached timeout',async()=>{
 const time=cleanupClock(),entered=deferred(),release=deferred(),poison:Error[]=[];let observerCancelled=false,finished=false;
 const life=accessCleanupLifetime(0,async()=>{},async()=>{observerCancelled=true;},error=>poison.push(error),time);
 const finish=life.finish(async step=>{await step(async()=>{entered.resolve();await release.promise;});});void finish.catch(()=>{});void finish.finally(()=>{finished=true;}).catch(()=>{});await entered.promise;
 time.advance(26000);await Promise.resolve();expect(observerCancelled).toBe(true);expect(finished).toBe(false);release.resolve();await expect(finish).rejects.toThrow();expect(poison.length).toBeGreaterThan(0);expect(life.snapshot()).toMatchObject({pending:false,uncertain:true});
});
it('refuses unknown commit, mismatched or invalid OIDs before DROP and poisons cleanup rather than guessing ownership from a name',async()=>{
 for(const [observed,expected]of [[101,undefined],[102,101],[0,0]]as const){
  const poison:Error[]=[],time=cleanupClock();let dropped=false;const life=accessCleanupLifetime(0,async()=>{},async()=>{},error=>poison.push(error),time);
  try{await life.step(async()=>{requireAccessCleanupOid(observed,expected,'database');dropped=true;});}catch(error){life.refuse(error);}
  await expect(life.finish(async()=>{})).rejects.toThrow('Uncertain owned Access');expect(dropped).toBe(false);expect(poison.length).toBeGreaterThan(0);expect(life.snapshot().uncertain).toBe(true);
 }
});
