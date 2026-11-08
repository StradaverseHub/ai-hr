/** Pure case ownership only; native sockets and their close remain their owner. */
type Context={signal:AbortSignal;onTestFinished:(hook:()=>Promise<void>)=>void};
export function asciiProofLifetime(){
 let pending:Promise<void>|undefined,blocked:Error|undefined;
 const active=()=>{if(blocked)throw blocked;};
 const poison=(cause:unknown)=>{blocked??=new Error('ASCII proof ownership uncertain; successor refused',{cause});};
 return{
  poison,
  beforeCase(){active();if(pending)throw Error('Previous ASCII proof has not drained');},
  async drain(){if(pending)await pending.catch(()=>{});},
  run(context:Context,work:()=>Promise<void>){
   active();if(pending)throw Error('Overlapping ASCII proof');
   const abort=()=>poison(context.signal.reason);context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
   const operation=Promise.resolve().then(()=>{active();context.signal.throwIfAborted();return work();});pending=operation;
   context.onTestFinished(async()=>{try{await operation.catch(()=>{});}finally{context.signal.removeEventListener('abort',abort);if(pending===operation)pending=undefined;}});
   return operation;
  },
 };
}
