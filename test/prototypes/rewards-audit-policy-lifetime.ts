/** Test-owner lifetime; no database or framework import. Actual callers supply real socket stops. */
type Context={signal:AbortSignal;onTestFinished:(finish:()=>Promise<void>)=>void};
type Clock={arm:(work:()=>void,ms:number)=>()=>void};
const realClock:Clock={arm:(work,ms)=>{const timer=setTimeout(work,ms);return()=>clearTimeout(timer);}};
export function rewardsAuditPolicyLifetime(stops:{work:()=>Promise<void>;cleanup:()=>Promise<void>},clock:Clock=realClock){
 let phase:'idle'|'work'|'cleanup'|'closed'='idle',blocked:Error|undefined,cleanupBlocked:Error|undefined,context:Context|undefined,active:Promise<unknown>|undefined;
 const pending=new Set<Promise<unknown>>(),stopPending=new Set<Promise<void>>(),stopOwned=new Map<'work'|'cleanup',Promise<void>>();
 const poison=(error:Error)=>{blocked??=error;};
 function stop(kind:'work'|'cleanup'){
  const previous=stopOwned.get(kind);if(previous)return previous;
  const owned=Promise.resolve().then(()=>stops[kind]());stopOwned.set(kind,owned);stopPending.add(owned);owned.catch(error=>poison(Error('Owned policy socket stop refused',{cause:error}))).finally(()=>stopPending.delete(owned));return owned;
 }
 async function drain(){await Promise.all([...pending].map(work=>work.catch(()=>{})));await Promise.all([...stopPending].map(work=>work.catch(()=>{})));}
 function assertWork(){if(blocked)throw blocked;if(phase!=='work'||!context)throw Error('No owned policy proof work admission');context.signal.throwIfAborted();}
 return{
  poison,drain,
  ownerPhase(){if(phase==='cleanup'){if(cleanupBlocked)throw cleanupBlocked;return'cleanup' as const;}assertWork();return'work' as const;},
  beforeCase(){if(blocked)throw blocked;if(phase!=='idle'||pending.size||stopPending.size)throw Error('Previous policy proof work has not drained');},
  async run<T>(ctx:Context,work:()=>Promise<T>):Promise<T>{
   if(blocked)throw blocked;if(phase!=='idle')throw Error('Overlapping native policy proof phase');phase='work';context=ctx;
   const abort=()=>{poison(Error('Native policy proof aborted; successors refused',{cause:ctx.signal.reason}));void stop('work');};
   ctx.signal.addEventListener('abort',abort,{once:true});if(ctx.signal.aborted)abort();
   // Registration and stop listener precede the first application/SQL microtask.
   const owned=Promise.resolve().then(()=>{assertWork();return work();});active=owned;pending.add(owned);
   const settled=()=>{if(active===owned){active=undefined;context=undefined;phase='idle';}};owned.then(settled,settled);
   ctx.onTestFinished(async()=>{await owned.catch(()=>{});await drain();ctx.signal.removeEventListener('abort',abort);pending.delete(owned);if(active===owned){active=undefined;context=undefined;phase='idle';}});
   return owned;
  },
  async close(work:()=>Promise<void>,ownership:'known'|'uncertain'){
   await drain();if(pending.size)throw Error('Native policy finish hooks have not retired their ownership');
   if(phase!=='idle')throw Error('Native policy owner still active');
   // A failed/aborted constructor cannot authorize guessed object cleanup.
   if(ownership!=='known'){poison(Error('Unknown native policy constructor COMMIT/ownership; object cleanup refused'));await Promise.allSettled([stop('work'),stop('cleanup')]);phase='closed';throw blocked;}
   phase='cleanup';
   const cancelTimer=clock.arm(()=>{cleanupBlocked=Error('Owned policy cleanup18s admission deadline');poison(cleanupBlocked);void stop('cleanup');},18000);
   const cleanup=Promise.resolve().then(work);pending.add(cleanup);
   try{await cleanup;await drain();if(blocked)throw blocked;}
   catch(error){poison(error instanceof Error?error:Error('Native policy cleanup refused',{cause:error}));throw error;}
   finally{cancelTimer();pending.delete(cleanup);await Promise.allSettled([stop('work'),stop('cleanup')]);phase='closed';}
  },
 };
}
