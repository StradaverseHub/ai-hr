/** Verification-only owned cleanup. No database/application/release authority. */
export const accessCleanupBounds=Object.freeze({workMs:18000,totalMs:26000,statementMs:2000,connectSeconds:2,lockMs:300});
type Clock={now:()=>number;schedule:(callback:()=>void,ms:number)=>()=>void};
const systemClock:Clock={now:()=>performance.now(),schedule:(callback,ms)=>{const timer=setTimeout(callback,ms);return()=>clearTimeout(timer);}};
/** Unknown commit/identity cannot turn an internally generated name into DROP authority. */
export function requireAccessCleanupOid(observed:number|null,expected:number|undefined,label:string){
 if(observed===null)return false;
 if(expected===undefined||!Number.isSafeInteger(expected)||expected<=0||observed!==expected)throw Error('Uncertain owned Access '+label+' identity; refusing cleanup');
 return true;
}
export function accessCleanupLifetime(startedAt:number,cancelWork:()=>Promise<void>,cancelFinal:()=>Promise<void>,poison:(error:Error)=>void,clock:Clock=systemClock){
 let pending:Promise<unknown>|undefined,finishing:Promise<void>|undefined,workCancellation:Promise<void>|undefined,finalCancellation:Promise<void>|undefined,stopped:Error|undefined,finalizing=false;
 const elapsed=()=>Math.max(0,clock.now()-startedAt),failures:unknown[]=[];
 const remember=(error:unknown)=>{if(!failures.includes(error))failures.push(error);poison(error instanceof Error?error:Error('Access cleanup uncertainty',{cause:error}));};
 const cancel=(final:boolean)=>{
  if(!workCancellation){workCancellation=Promise.resolve().then(cancelWork);void workCancellation.catch(remember);}
  if(final&&!finalCancellation){finalCancellation=Promise.resolve().then(cancelFinal);void finalCancellation.catch(remember);}
 };
 const stop=(final:boolean)=>{stopped??=Error(final?'Access cleanup total deadline exhausted':'Access cleanup work deadline exhausted');remember(stopped);cancel(final);};
 const cancelWorkTimer=clock.schedule(()=>stop(false),Math.max(0,accessCleanupBounds.workMs-elapsed()));
 const cancelTotalTimer=clock.schedule(()=>stop(true),Math.max(0,accessCleanupBounds.totalMs-elapsed()));
 const active=(final:boolean)=>{
  if(elapsed()>=(final?accessCleanupBounds.totalMs:accessCleanupBounds.workMs))stop(final);
  if((!final&&stopped)||(!final&&finalizing)||finalCancellation)throw stopped??Error('Access cleanup admission closed');
 };
 const step=async<T>(work:()=>Promise<T>,final=false):Promise<T>=>{
  active(final);if(pending)throw Error('Previous Access cleanup phase has not drained');
  // Register ownership BEFORE native connection construction/query microtasks.
  const owned=Promise.resolve().then(()=>{active(final);return work();});pending=owned;
  try{const result=await owned;active(final);return result;}finally{if(pending===owned)pending=undefined;}
 };
 const finish=(observe:(step:<T>(work:()=>Promise<T>)=>Promise<T>)=>Promise<void>)=>{
  if(finishing)return finishing;finalizing=true;
  finishing=Promise.resolve().then(async()=>{
   try{
    await pending?.catch(remember);await workCancellation?.catch(remember);cancelWorkTimer();
    try{await observe(work=>step(work,true));}catch(error){remember(error);}
    await finalCancellation?.catch(remember);
   }finally{
    // Always own BOTH connection closures, including a failed observer path. A
    // timer never detaches a cancellation rejection or admits a successor.
    cancel(true);await Promise.all([workCancellation?.catch(remember),finalCancellation?.catch(remember)]);
    cancelWorkTimer();cancelTotalTimer();
   }
   if(elapsed()>=accessCleanupBounds.totalMs)remember(Error('Access cleanup did not complete inside26seconds'));
   if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'Access cleanup refused; successor poisoned');
  });void finishing.catch(()=>{});return finishing;
 };
 return{step,finish,refuse:remember,snapshot:()=>({elapsedMs:elapsed(),pending:pending!==undefined,stopped:stopped!==undefined,finalizing,uncertain:failures.length>0})};
}
