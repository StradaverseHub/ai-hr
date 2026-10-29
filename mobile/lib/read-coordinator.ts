/** In-flight reads only: no HR response survives its last consumer or a completed request. */
const MAX_RETRY_AFTER=3600;
export function retryAfterSeconds(value:string|null,now=Date.now()):number|undefined{
  if(!value||value.length>128)return;
  value=value.trim();
  const seconds=/^\d+$/.test(value)?Number(value):Math.ceil((Date.parse(value)-now)/1000);
  return Number.isFinite(seconds)&&seconds>0&&seconds<=MAX_RETRY_AFTER?Math.ceil(seconds):undefined;
}
/**
 * `retry`: milliseconds to wait before ONE more attempt of a failed read, or undefined for none. Only for a short,
 * server-stated refusal (a 429 from the per-user in-flight admission): the read is retried once, in its own slot.
 */
type Ports={unavailable:(seconds?:number)=>Error;obsolete:()=>Error;backoff:(error:unknown)=>number|undefined;now?:()=>number;retry?:(error:unknown)=>number|undefined};
const MAX_RETRY_DELAY_MS=5000;
type Consumer={resolve:(value:unknown)=>void;reject:(error:unknown)=>void;signal?:AbortSignal;abort:()=>void};
type Read={controller:AbortController;consumers:Set<Consumer>};
/**
 * `concurrency` bounds reads IN FLIGHT; the rest queue in arrival order. The server admits a bounded number of
 * concurrent requests per user (lib/mobile-api/handler.ts admitActor) and refuses the excess with 429, so a screen
 * that mounts many cards at once must not send them all together. A queued read whose last consumer leaves never starts.
 */
export function createReadCoordinator(ports:Ports,capacity=64,concurrency=Number.POSITIVE_INFINITY){
  const now=ports.now??(()=>performance.now());
  let scope:string|undefined;
  const reads=new Map<string,Read>(),cooldowns=new Map<string,number>();
  let active=0;
  const waiting:{start:()=>void;signal:AbortSignal}[]=[];
  function release(){
    active--;
    while(active<concurrency&&waiting.length){const next=waiting.shift()!;if(next.signal.aborted)continue;active++;next.start();}
  }
  /** Waits for a slot; rejects (holding none) when the read is cancelled while it waits. */
  function queued(signal:AbortSignal):Promise<void>{
    return new Promise((resolve,reject)=>{
      const entry={signal,start:()=>{signal.removeEventListener('abort',cancel);resolve();}};
      const cancel=()=>{const i=waiting.indexOf(entry);if(i>=0)waiting.splice(i,1);reject(ports.unavailable());};
      waiting.push(entry);signal.addEventListener('abort',cancel,{once:true});
    });
  }
  /** One attempt in one slot. With a free slot the load starts synchronously, as it always did. */
  function attempt<T>(load:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
    const go=():Promise<T>=>{
      let pending:Promise<T>;
      try{if(signal.aborted)throw ports.unavailable();pending=Promise.resolve(load(signal));}
      catch(error){release();return Promise.reject(error);}
      return pending.finally(release);
    };
    if(signal.aborted)return Promise.reject(ports.unavailable());
    if(active<concurrency){active++;return go();}
    return queued(signal).then(go);
  }
  function pause(ms:number,signal:AbortSignal):Promise<void>{
    return new Promise((resolve,reject)=>{
      if(signal.aborted){reject(ports.unavailable());return;}
      const cancel=()=>{clearTimeout(timer);reject(ports.unavailable());};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
      signal.addEventListener('abort',cancel,{once:true});
    });
  }
  /** At most one retry, after the delay the port names, and only while someone still wants the answer. */
  function run<T>(load:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
    return attempt(load,signal).catch((error:unknown)=>{
      const delay=signal.aborted?undefined:ports.retry?.(error);
      if(delay===undefined||!Number.isFinite(delay)||delay<0||delay>MAX_RETRY_DELAY_MS)throw error;
      return pause(delay,signal).then(()=>attempt(load,signal));
    });
  }
  function cancel(read:Read,error:Error){
    read.controller.abort();
    for(const consumer of read.consumers){consumer.signal?.removeEventListener('abort',consumer.abort);consumer.reject(error);}
    read.consumers.clear();
  }
  function clear(){for(const read of reads.values())cancel(read,ports.obsolete());reads.clear();cooldowns.clear();scope=undefined;}
  return {
    clear,
    read<T>(owner:string,key:string,load:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
      if(signal?.aborted)return Promise.reject(ports.unavailable());
      if(scope!==owner){clear();scope=owner;}
      for(const [id,until]of cooldowns)if(until<=now())cooldowns.delete(id);
      const until=cooldowns.get(key);
      if(until&&until>now())return Promise.reject(ports.unavailable(Math.ceil((until-now())/1000)));
      let read=reads.get(key),created=false;
      if(!read){
        if(reads.size>=capacity)return Promise.reject(ports.unavailable());
        read={controller:new AbortController(),consumers:new Set()};reads.set(key,read);created=true;
      }
      const owned=read;
      const result=new Promise<T>((resolve,reject)=>{
        const consumer:Consumer={resolve:value=>resolve(value as T),reject,signal,abort:()=>{
          if(!owned.consumers.delete(consumer))return;
          signal?.removeEventListener('abort',consumer.abort);reject(ports.unavailable());
          if(!owned.consumers.size){owned.controller.abort();if(reads.get(key)===owned)reads.delete(key);}
        }};
        owned.consumers.add(consumer);signal?.addEventListener('abort',consumer.abort,{once:true});
        if(signal?.aborted)consumer.abort();
      });
      if(created){
        const finish=(value:unknown,failed:boolean)=>{
          if(reads.get(key)===owned){
            reads.delete(key);
            const seconds=failed?ports.backoff(value):undefined;
            if(seconds&&Number.isFinite(seconds)&&seconds<=MAX_RETRY_AFTER){
              if(cooldowns.size>=capacity)cooldowns.delete(cooldowns.keys().next().value!);
              cooldowns.set(key,now()+Math.ceil(seconds)*1000);
            }
          }
          for(const consumer of owned.consumers){
            consumer.signal?.removeEventListener('abort',consumer.abort);
            if(failed)consumer.reject(value);else consumer.resolve(value);
          }
          owned.consumers.clear();
        };
        void Promise.resolve().then(()=>{
          if(owned.controller.signal.aborted)throw ports.unavailable();
          return run(load,owned.controller.signal);
        }).then(value=>finish(value,false),error=>finish(error,true));
      }
      return result;
    },
  };
}
