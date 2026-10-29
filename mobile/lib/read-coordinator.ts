/** In-flight reads only: no HR response survives its last consumer or a completed request. */
const MAX_RETRY_AFTER=3600;
export function retryAfterSeconds(value:string|null,now=Date.now()):number|undefined{
  if(!value||value.length>128)return;
  value=value.trim();
  const seconds=/^\d+$/.test(value)?Number(value):Math.ceil((Date.parse(value)-now)/1000);
  return Number.isFinite(seconds)&&seconds>0&&seconds<=MAX_RETRY_AFTER?Math.ceil(seconds):undefined;
}
type Ports={unavailable:(seconds?:number)=>Error;obsolete:()=>Error;backoff:(error:unknown)=>number|undefined;now?:()=>number};
type Consumer={resolve:(value:unknown)=>void;reject:(error:unknown)=>void;signal?:AbortSignal;abort:()=>void};
type Read={controller:AbortController;consumers:Set<Consumer>};
export function createReadCoordinator(ports:Ports,capacity=64){
  const now=ports.now??(()=>performance.now());
  let scope:string|undefined;
  const reads=new Map<string,Read>(),cooldowns=new Map<string,number>();
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
          return load(owned.controller.signal);
        }).then(value=>finish(value,false),error=>finish(error,true));
      }
      return result;
    },
  };
}
