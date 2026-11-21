/** Own one complete native control, including restoration after cancellation.
 * File-local poison; a sole disposable cluster is required at its source entry.
 * No production, normal-CI singleton or cross-file quiescence authority. */
export const employeeChoiceNativeControlBounds=Object.freeze({workMs:18000,totalMs:26000});
type Context={signal:AbortSignal;onTestFinished:(finished:()=>Promise<void>)=>void};
type Clock={now:()=>number;schedule:(work:()=>void,ms:number)=>()=>void};
const clock:Clock={now:()=>Number(process.hrtime.bigint())/1e6,schedule:(work,ms)=>{const timer=setTimeout(work,ms);return()=>clearTimeout(timer);}};
export function employeeChoiceNativeCaseOwner(time:Clock=clock){
 let pending:Promise<void>|undefined,blocked:Error|undefined;
 const poison=(error:Error)=>{blocked??=error;};
 const active=()=>{if(blocked)throw blocked;if(pending)throw Error('Native control predecessor has not drained');};
 return{poison,async drain(){await pending?.catch(()=>{});},
  run(context:Context,work:(owned:{signal:AbortSignal;cleanupDeadline:number;enterCleanup:()=>void})=>Promise<void>){
   active();const controller=new AbortController(),started=time.now();
   const stop=(reason:unknown)=>{poison(Error('Native control stopped; successor refused',{cause:reason}));controller.abort(reason);};
   const abort=()=>stop(context.signal.reason??Error('Native control case aborted'));
   context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
   const cancelWork=time.schedule(()=>stop(Error('Native control18s work deadline')),employeeChoiceNativeControlBounds.workMs);
   const cancelTotal=time.schedule(()=>stop(Error('Native control26s complete-operation deadline')),employeeChoiceNativeControlBounds.totalMs);
   // Ownership/hook registration precede the first work microtask.
   const operation=Promise.resolve().then(()=>{if(blocked)throw blocked;controller.signal.throwIfAborted();return work({signal:controller.signal,cleanupDeadline:started+employeeChoiceNativeControlBounds.totalMs,enterCleanup(){if(time.now()>=started+employeeChoiceNativeControlBounds.workMs&&!controller.signal.aborted)stop(Error('Native control work frontier elapsed'));cancelWork();}});}).then(()=>{
    if(controller.signal.aborted||time.now()>=started+employeeChoiceNativeControlBounds.totalMs)throw Error('Native control exceeded complete-operation deadline');
   }).finally(()=>{cancelWork();cancelTotal();});
   pending=operation;void operation.catch(()=>{});
   context.onTestFinished(async()=>{try{await operation.catch(()=>{});}finally{context.signal.removeEventListener('abort',abort);if(pending===operation)pending=undefined;}});
   return operation;
  },
 };
}
