import {HOME_CARD_READ_HARD_CAP_MS} from '@/lib/employee-home-delivery';
import {withDatabaseReadCancellation,withDatabaseReadDeadline} from '@/db/workload';

/** The server's half of the Home card hard cap (the value and its reasoning live in
 * lib/employee-home-delivery.ts). It never retries. Readers, queries and permissions are unchanged; the
 * cap only bounds how long one read may hold a connection or a queue place. */
export class HomeCardReadCapError extends Error {
 constructor(){super('Home card read reached its hard cap.');this.name='HomeCardReadCapError';}
}

/** Start one cap. Its signal aborts HOME_CARD_READ_HARD_CAP_MS after this call; `stop` once reads settle. */
export function startHomeCardReadCap(){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(new HomeCardReadCapError()),HOME_CARD_READ_HARD_CAP_MS);
 return {signal:controller.signal,stop:()=>clearTimeout(timer)};
}

/** Run one read under `cap`. Until then `lifetime` (the response's own cancellation) still prevents new
 * checkouts. At the cap, new checkouts are refused, the running statement is cancelled so its connection
 * is released, and the result settles even if a reader ignores its signal. */
export function runCappedHomeCardRead<T>(lifetime:AbortSignal,cap:AbortSignal,read:()=>Promise<T>):Promise<T>{
 cap.throwIfAborted();
 return new Promise<T>((resolve,reject)=>{
  const expire=()=>reject(cap.reason);
  cap.addEventListener('abort',expire,{once:true});
  withDatabaseReadCancellation(lifetime,()=>withDatabaseReadDeadline(cap,read)).then(resolve,reject)
   .finally(()=>cap.removeEventListener('abort',expire));
 });
}

/** One standalone Home card read with its own cap, started when the read starts. */
export async function capHomeCardRead<T>(request:AbortSignal,read:()=>Promise<T>):Promise<T>{
 const cap=startHomeCardReadCap();
 try{return await runCappedHomeCardRead(request,cap.signal,read);}
 finally{cap.stop();}
}
