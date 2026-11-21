/** Own the complete async case INCLUDING capture/restoration after cancellation.
 * A timed-out/uncertain case permanently refuses successor setup in this process. */
type CaseContext={signal:AbortSignal;onTestFinished:(finished:()=>Promise<void>)=>void};
export function notificationDiagnosticOwnership(){
 let blocked:Error|undefined,pending:Promise<void>|undefined;
 const poison=(error:Error)=>{blocked??=error;};
 const active=()=>{if(blocked)throw blocked;};
 return{
  poison,
  get poisoned(){return blocked!==undefined;},
  beforeCase(){active();if(pending)throw Error('Previous native diagnostic work has not drained');},
  async drain(){if(pending)await pending.catch(()=>{});},
  async run(context:CaseContext,work:()=>Promise<void>){
   active();if(pending)throw Error('Overlapping native diagnostic work');
   const abort=()=>poison(new Error('Native diagnostic aborted; successor mutation refused',{cause:context.signal.reason}));
   context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
   const operation=Promise.resolve().then(()=>{active();context.signal.throwIfAborted();return work();});pending=operation;
   // Attach the drain before any owned async work starts. The case's returned
   // promise reports its error; this hook only settles ownership after cleanup.
   context.onTestFinished(async()=>{try{await operation.catch(()=>{});}finally{context.signal.removeEventListener('abort',abort);if(pending===operation)pending=undefined;}});
   return operation;
  },
 };
}
