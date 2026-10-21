/** A deadline belongs to one read, never to the whole Home or to a business command.
 * Readers must forward the supplied signal to their transport. An ignored signal cannot cancel
 * an upstream query, but its late value/error still cannot replace the settled card result.
 */
export const HOME_CARD_READ_TIMEOUT_MS = 2800;

export type HomeCardDelivery<T> =
  | {state:'ready';value:T}
  | {state:'failed';reason:'timeout'|'unavailable'}
  | {state:'cancelled'};
export type HomeCardReader<T> = (signal:AbortSignal)=>Promise<T>;

/** Invoke exactly one non-mutating reader. No sibling reads, automatic retry, error body or cache. */
export function deliverHomeCard<T>(
  read:HomeCardReader<T>,
  options:{signal?:AbortSignal;timeoutMs?:number}={},
):Promise<HomeCardDelivery<T>>{
  const timeoutMs=options.timeoutMs??HOME_CARD_READ_TIMEOUT_MS;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000)throw new RangeError('Invalid Home read deadline.');
  if(options.signal?.aborted)return Promise.resolve({state:'cancelled'});
  return new Promise(resolve=>{
    const controller=new AbortController();
    let settled=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const finish=(result:HomeCardDelivery<T>)=>{
      if(settled)return;
      settled=true;
      if(timer!==undefined)clearTimeout(timer);
      options.signal?.removeEventListener('abort',cancel);
      if(result.state!=='ready')controller.abort();
      resolve(result);
    };
    const cancel=()=>finish({state:'cancelled'});
    options.signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>finish({state:'failed',reason:'timeout'}),timeoutMs);
    Promise.resolve().then(()=>{
      if(!settled)return read(controller.signal);
    }).then(value=>{
      if(!settled)finish({state:'ready',value:value as T});
    },()=>finish({state:'failed',reason:'unavailable'}));
  });
}
