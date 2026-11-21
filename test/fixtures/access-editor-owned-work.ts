/** Same proven pending/drain ownership protocol as notification dd6/Rewards00779.
 * The owned promise includes constructor, real work and full async cleanup. */
type Context={signal:AbortSignal;onTestFinished:(finish:()=>Promise<void>)=>void};
export function accessEditorOwnedWork(){
 let blocked:Error|undefined,pending:Promise<void>|undefined;
 const poison=(error:Error)=>{blocked??=error;},active=()=>{if(blocked)throw blocked;};
 return{
  poison,
  beforeCase(){active();if(pending)throw Error('Previous Access native work has not drained');},
  async drain(){if(pending)await pending.catch(()=>{});},
  async run(context:Context,work:()=>Promise<void>){
   active();if(pending)throw Error('Overlapping Access native work');
   const abort=()=>poison(Error('Access native work aborted; successor refused',{cause:context.signal.reason}));
   context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
   const operation=Promise.resolve().then(()=>{active();context.signal.throwIfAborted();return work();});pending=operation;
   context.onTestFinished(async()=>{try{await operation.catch(()=>{});}finally{context.signal.removeEventListener('abort',abort);if(pending===operation)pending=undefined;}});
   return operation;
  },
 };
}
