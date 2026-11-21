/** Entire fixture/setup/body promises remain owned through async cleanup. */
type Context={signal:AbortSignal;onTestFinished:(finish:()=>Promise<void>)=>void};
export function rewardAuditPrototypeOwnership(){
 let blocked:Error|undefined;
 const operations=new Map<Promise<void>,{settled:boolean}>(),poison=(error:Error)=>{blocked??=error;};
 const active=()=>{if(blocked)throw blocked;};
 return{
  poison,
  beforeSetup(){active();if(operations.size)throw Error('Previous Rewards prototype case has not drained');},
  async drain(){await Promise.all(Array.from(operations.keys(),work=>work.catch(()=>{})));},
  async phase(context:Context,work:()=>Promise<void>){
   active();if(Array.from(operations.values()).some(operation=>!operation.settled))throw Error('Overlapping Rewards prototype phase');
   const abort=()=>poison(Error('Rewards prototype aborted; successor setup refused',{cause:context.signal.reason}));context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
   const operation=Promise.resolve().then(()=>{active();context.signal.throwIfAborted();return work();}),state={settled:false};operations.set(operation,state);
   operation.then(()=>{state.settled=true;},()=>{state.settled=true;});
   context.onTestFinished(async()=>{try{await operation.catch(()=>{});}finally{context.signal.removeEventListener('abort',abort);operations.delete(operation);}});
   return operation;
  },
 };
}
