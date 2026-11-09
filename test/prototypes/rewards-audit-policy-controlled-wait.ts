/** Test-only outcome/lifetime owner. No DB, framework or authority imports. */
type Outcome<T>={ok:true;value:T}|{ok:false;error:unknown};
type State={completion:Promise<Outcome<unknown>>;observed:boolean;outcome?:Outcome<unknown>};
export type ControlledPolicyTask<T>=Readonly<{value:()=>Promise<T>}>;
export function controlledPolicyWait(poison:(error:Error)=>void=()=>{}){
 const states=new Set<State>(),byTask=new WeakMap<object,State>(),detach=new Set<()=>void>();let closed=false;
 function contains(value:unknown,target:unknown,seen=new Set<unknown>()):boolean{
  if(Object.is(value,target))return true;if(seen.has(value))return false;seen.add(value);
  return value instanceof AggregateError&&value.errors.some(error=>contains(error,target,seen))||value instanceof Error&&Object.hasOwn(value,'cause')&&contains(value.cause,target,seen);
 }
 function add(errors:unknown[],error:unknown){if(!errors.some(value=>contains(value,error)))errors.push(error);}
 function failure(errors:unknown[],primary:Outcome<unknown>){return errors.length===1?errors[0]:new AggregateError(errors,'Controlled policy work and cleanup failed',{cause:primary.ok?errors[0]:primary.error});}
 return{
  start<T>(work:()=>PromiseLike<T>):ControlledPolicyTask<T>{
   if(closed)throw Error('Controlled policy task admission closed');
   // Native/process creation is deferred until AFTER this state is registered.
   const completion:Promise<Outcome<T>>=Promise.resolve().then(work).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
   const state:State={completion,observed:false};states.add(state);void completion.then(outcome=>{state.outcome=outcome;});
   const task:ControlledPolicyTask<T>=Object.freeze({async value(){const result=await completion;if(!result.ok)throw result.error;return result.value;}});byTask.set(task,state);return task;
  },
  consume(task:object,error:unknown){
   const state=byTask.get(task);if(!state||!state.outcome||state.outcome.ok||!Object.is(state.outcome.error,error))throw Error('Exact settled native failure required for consumption');state.observed=true;
  },
  async ready(ready:Promise<void>,task:object,signal:AbortSignal,label:string){
   const state=byTask.get(task);if(!state)throw Error('Foreign controlled policy task');
   let aborted:(()=>void)|undefined;
   const stop=new Promise<{kind:'abort';error:unknown}>(resolve=>{aborted=()=>resolve({kind:'abort',error:signal.reason??Error('Controlled policy wait aborted')});signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});
   const listener=aborted;if(listener)detach.add(()=>signal.removeEventListener('abort',listener));
   {
    const result=await Promise.race([ready.then(()=>({kind:'ready' as const})),state.completion.then(outcome=>({kind:'task' as const,outcome})),stop]);
    if(result.kind==='abort')throw result.error;
    if(result.kind==='ready')return;
    // Only the WINNING actual settlement is observed. A race loser remains
    // unobserved until exact explicit consume() or final drain records it.
    state.observed=true;if(!result.outcome.ok)throw result.outcome.error;throw Error(label);
   }
  },
  async run<T>(work:()=>Promise<T>,release:()=>Promise<void>,unsubscribe:()=>void|Promise<void>=()=>{}):Promise<T>{
   if(closed)throw Error('Controlled policy work admission closed');
   let outcome:Outcome<T>;try{outcome={ok:true,value:await work()};}catch(error){outcome={ok:false,error};}
   const errors:unknown[]=outcome.ok?[]:[outcome.error];let uncertain=false;closed=true;
   try{await release();}catch(error){uncertain=true;add(errors,error);}
   // Release may fail or abort; neither can skip the actual owned task drain.
   const entries=[...states],settled=await Promise.allSettled(entries.map(state=>state.completion));
   for(let i=0;i<settled.length;i++){
    const result=settled[i];
    if(result.status==='rejected'){uncertain=true;add(errors,result.reason);}
    else if(!entries[i].observed&&!result.value.ok){uncertain=true;add(errors,result.value.error);}
   }
   for(const remove of [...detach,unsubscribe]){try{await remove();}catch(error){uncertain=true;add(errors,error);}}detach.clear();
   if(uncertain){try{poison(Error('Controlled policy cleanup uncertain; successors refused',{cause:failure(errors,outcome)}));}catch(error){add(errors,error);}}
   if(errors.length)throw failure(errors,outcome);
   if(!outcome.ok)throw outcome.error;return outcome.value;
  },
 };
}
