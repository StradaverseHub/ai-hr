/** Deferred ownership models only, never native migration/permission proof. */
import {expect,it} from 'vitest';
import {accessEditorOwnedWork} from './fixtures/access-editor-owned-work';
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
