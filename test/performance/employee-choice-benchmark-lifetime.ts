/** Verification lifetime only. No database, application or release authority. */
export const employeeChoiceBenchmarkBounds=Object.freeze({totalMs:900000,reserveMs:60000,workMs:840000});
type Clock={now:()=>number;schedule:(work:()=>void,ms:number)=>()=>void};
type RecordEvent=(event:{kind:string;phase?:string;elapsedMs:number;reason?:string})=>void;
const systemClock:Clock={now:()=>Number(process.hrtime.bigint())/1e6,schedule:(work,ms)=>{const timer=setTimeout(work,ms);return()=>clearTimeout(timer);}};
/** Record ownership before testing a signal that may have aborted during await.
 * The creator remains responsible for closing failures before it returns. */
export async function adoptEmployeeChoiceBenchmarkResource<T extends {close:()=>Promise<void>}>(create:()=>Promise<T>,signal:AbortSignal,record:(resource:T)=>void):Promise<T>{
 signal.throwIfAborted();const resource=await create();
 try{record(resource);signal.throwIfAborted();return resource;}
 catch(error){try{await resource.close();}catch(close){throw new AggregateError([error,close],'New benchmark resource and close both refused',{cause:error});}throw error;}
}
export function employeeChoiceBenchmarkLifetime(cancel:()=>Promise<void>,record:RecordEvent,clock:Clock=systemClock){
 const controller=new AbortController();let started:number|undefined,cancelWorkTimer:(()=>void)|undefined,cancelTotalTimer:(()=>void)|undefined;
 let pending:Promise<void>|undefined,cancelling:Promise<void>|undefined,finishing:Promise<void>|undefined,reason:string|undefined,uncertain=false,finished=false,cancellationSettled=false,recordFailure:unknown;
 const elapsed=()=>started===undefined?0:Math.max(0,clock.now()-started);
 const emit=(kind:string,phase?:string)=>{try{record({kind,phase,elapsedMs:elapsed(),...(reason?{reason}:{})});}catch(error){recordFailure??=error;uncertain=true;}};
 const stop=(why:'file-work-budget'|'case-aborted'|'setup-failed'|'owner-uncertain')=>{
  if(reason)return;reason=why;controller.abort(Error('Employee benchmark stopped: '+why));emit('work-stopped');
  cancelling=Promise.resolve().then(cancel).catch(error=>{uncertain=true;emit('cancellation-uncertain');throw error;}).finally(()=>{cancellationSettled=true;});
  // Retain the rejecting promise for drain, without an unhandled rejection.
  void cancelling.catch(()=>{});
 };
 const start=(frontier=clock.now())=>{
  if(started!==undefined)throw Error('Benchmark lifetime already started');if(!Number.isFinite(frontier)||frontier>clock.now()||clock.now()-frontier>3000)throw Error('Exact benchmark start frontier refused');started=frontier;emit('file-started');
  cancelWorkTimer=clock.schedule(()=>stop('file-work-budget'),Math.max(0,employeeChoiceBenchmarkBounds.workMs-elapsed()));
  cancelTotalTimer=clock.schedule(()=>{uncertain=true;emit('total-envelope-exhausted');stop('owner-uncertain');},Math.max(0,employeeChoiceBenchmarkBounds.totalMs-elapsed()));
 };
 const active=()=>{
  if(started===undefined)throw Error('Benchmark lifetime not started');
  if(uncertain&&!reason)stop('owner-uncertain');
  if(elapsed()>=employeeChoiceBenchmarkBounds.workMs)stop('file-work-budget');
  if(reason||finished||finishing)throw Error('Benchmark work refused: '+(reason??'finishing'));
 };
 const run=async(phase:string,work:()=>Promise<void>)=>{
  try{active();}catch(error){emit('phase-blocked',phase);throw error;}
  if(pending)throw Error('Previous benchmark phase has not drained');emit('phase-started',phase);
  const owned=Promise.resolve().then(()=>{active();return work();});pending=owned;
  try{await owned;
   if(elapsed()>=employeeChoiceBenchmarkBounds.workMs&&!reason)stop('file-work-budget');
   if(reason)throw Error('Benchmark phase completed after stop: '+reason);
   emit('phase-completed',phase);
  }catch(error){emit('phase-failed',phase);throw error;}
  finally{if(pending===owned)pending=undefined;}
 };
 const drain=async()=>{
  const owned=pending;await owned?.catch(()=>{});await cancelling;emit('owned-work-drained');
 };
 const clearWorkTimer=()=>{cancelWorkTimer?.();cancelWorkTimer=undefined;};
 const finish=(cleanup:()=>Promise<void>)=>{
  if(finishing)return finishing;
  // Register the completion promise BEFORE invoking cleanup or awaiting work.
  finishing=Promise.resolve().then(async()=>{
   let failure:unknown;const observedFailures=new Set<unknown>();
   const remember=(error:unknown,message:string)=>{
    if(observedFailures.has(error))return;observedFailures.add(error);
    failure=failure===undefined?error:new AggregateError([failure,error],message);
   };
   try{await drain();}catch(error){remember(error,'Benchmark drain failed');}failure??=recordFailure;
   if(failure!==undefined)observedFailures.add(failure);
   // New work was closed synchronously by finishing. Keep the840s cancellation
   // active while an owned phase drains; reserve time belongs only to cleanup.
   clearWorkTimer();
   try{await cleanup();}catch(error){uncertain=true;remember(error,'Benchmark drain and cleanup both failed');}
   // The900s guard can start cancellation DURING cleanup. Own that settlement too.
   try{await cancelling;}catch(error){remember(error,'Benchmark cleanup and deadline cancellation both failed');}
   finished=true;clearWorkTimer();cancelTotalTimer?.();
   if(elapsed()>employeeChoiceBenchmarkBounds.totalMs){uncertain=true;failure??=Error('Benchmark cleanup exceeded the fixed900-second envelope');}
   emit(uncertain?'cleanup-uncertain':'file-finished');failure??=recordFailure;if(failure)throw failure;
  });void finishing.catch(()=>{});return finishing;
 };
 return{start,active,run,stop,drain,finish,signal:controller.signal,
  snapshot:()=>({started:started!==undefined,elapsedMs:elapsed(),workBudgetMs:employeeChoiceBenchmarkBounds.workMs,totalBudgetMs:employeeChoiceBenchmarkBounds.totalMs,reserveMs:employeeChoiceBenchmarkBounds.reserveMs,stopped:reason!==undefined,reason:reason??null,pending:pending!==undefined,cancellationPending:cancelling!==undefined&&!cancellationSettled,finished,uncertain})};
}
