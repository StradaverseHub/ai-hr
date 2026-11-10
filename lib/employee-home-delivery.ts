/** Home card read limits. This module is the single owner of both numbers: the browser cards, the
 * streamed Home cohort and the server read routes all import them from here, so the alert a person
 * sees and the server's abort can never use different values.
 *
 * A card keeps its loading state while its read is making progress. It shows its existing timeout
 * alert only when one of these limits is reached, and never retries on its own:
 */
/** Hard cap on one card read, measured from when that read starts. In the browser it ends the card's
 * wait with the timeout alert. On the server it refuses further connection checkouts and cancels the
 * statement that is still running, so a stuck read releases its connection. The browser starts its
 * timer before the request reaches the server, so the browser always reaches the cap first. It stays
 * below the database admission queue wait (30 s, db/capacity.ts) so a capped read leaves that queue
 * before the queue would time it out. */
export const HOME_CARD_READ_HARD_CAP_MS = 20_000;
/** The streamed Home cohort counts as stalled when no new frame arrives within this window (measured
 * from the request, then from each delivered frame). The cards still waiting on that stream then show
 * their timeout alert and the stream is cancelled. Reads outside the stream have only the hard cap. */
export const HOME_CARD_STREAM_STALL_MS = 8_000;

export type HomeCardDelivery<T> =
  | {state:'ready';value:T}
  | {state:'failed';reason:'timeout'|'unavailable'}
  | {state:'cancelled'};
export type HomeCardReader<T> = (signal:AbortSignal)=>Promise<T>;

/** A read that ended because a Home read limit was reached, not because its owner refused or failed. */
export class HomeCardReadTimeoutError extends Error {
  constructor(){
    super('The Home card read reached its time limit.');
    this.name='HomeCardReadTimeoutError';
  }
}

/** Focus and visibility can report the same tab activation separately, and an automatic refresh replaces
 * the card's current read. Allow another automatic refresh only after the previous one could have
 * reached the hard cap, so it is never cancelled and restarted while it is still within its limits. */
export function createHomeCardRefreshGate(now:()=>number=()=>performance.now()){
  let lastRefresh=-Infinity;
  return ()=>{
    const at=now();
    if(at-lastRefresh<HOME_CARD_READ_HARD_CAP_MS)return false;
    lastRefresh=at;
    return true;
  };
}

/** Invoke exactly one non-mutating reader. No sibling reads, automatic retry, error body or cache.
 * Readers must forward the supplied signal to their transport. A late value or error cannot replace the
 * settled card result. An error observed at or after the limit is that limit, whichever side saw it first.
 */
export function deliverHomeCard<T>(
  read:HomeCardReader<T>,
  options:{signal?:AbortSignal;timeoutMs?:number}={},
):Promise<HomeCardDelivery<T>>{
  const timeoutMs=options.timeoutMs??HOME_CARD_READ_HARD_CAP_MS;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>HOME_CARD_READ_HARD_CAP_MS)throw new RangeError('Invalid Home read deadline.');
  if(options.signal?.aborted)return Promise.resolve({state:'cancelled'});
  return new Promise(resolve=>{
    const controller=new AbortController();
    const startedAt=performance.now();
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
    },error=>finish({state:'failed',reason:error instanceof HomeCardReadTimeoutError||performance.now()-startedAt>=timeoutMs?'timeout':'unavailable'}));
  });
}
