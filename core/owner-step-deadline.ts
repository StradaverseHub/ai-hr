/** Deadline for the queue-owner connection's own steps in the import worker's ticks: the Bank & Statutory tick
 * (core/bank-import-worker.ts), the Individual Transaction tick (core/individual-import-worker.ts) and the bulk-job
 * tick (core/bulk-job-worker.ts). Those steps are reserving the connection, the owner proof, the queue lock, the claim,
 * the job-state writes and the unlock. Each is one short statement (milliseconds); a fresh connection adds at most
 * connect_timeout (30 s) and its type fetch.
 *
 * Past the deadline the owner connection is not answering. No server timeout bounds that while the client never sends
 * the statement: on 24 November the payroll lane waited in reserve() for 1,822 s with nothing running in PostgreSQL
 * (patches/README.md). The tick then fails with OwnerConnectionUnresponsive and the worker exits for systemd to
 * restart it (scripts/lib/worker-lane-process.ts). A reservation whose statement missed its deadline is never
 * returned to the pool: the statement may still be outstanding, and process exit closes the socket, which ends its
 * session advisory locks and rolls back its transaction. The import work itself (decoding, validating, writing rows
 * under the creator's authority) is not bounded here; the stall watchdog (lib/import-worker-watchdog.ts, at least
 * 1,200 s) stays its backstop. */
import type postgres from 'postgres';

export const OWNER_STEP_DEADLINE_SECONDS=120;

export class OwnerConnectionUnresponsive extends Error{
 constructor(readonly step:string,readonly seconds:number){
  super(`The import worker's queue-owner connection did not complete ${step} within ${seconds} s.`);
  this.name='OwnerConnectionUnresponsive';
 }
}

/** The deadline in milliseconds: a test's override, or OWNER_STEP_DEADLINE_SECONDS. */
export const ownerDeadlineMs=(override?:number)=>override??OWNER_STEP_DEADLINE_SECONDS*1000;

/** `work`, or OwnerConnectionUnresponsive once `ms` pass. The timer is deliberately referenced: a call that can never
 * settle must still end the tick rather than let the process drain its event loop. `late` receives a value that
 * arrives after the deadline. */
export async function ownerStep<T>(work:Promise<T>,step:string,ms:number,late?:(value:T)=>void):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OwnerConnectionUnresponsive(step,Math.round(ms/1000))),ms);});
 try{return await Promise.race([work,expired]);}
 catch(error){if(error instanceof OwnerConnectionUnresponsive)work.then(value=>late?.(value),()=>undefined);throw error;}
 finally{clearTimeout(timer);}
}

/** Steps that share one deadline starting now: a tick's claim, from the reservation to the claimed job. */
export function ownerClaimDeadline(ms:number){
 const by=Date.now()+ms;
 return <T>(work:Promise<T>,step:string)=>ownerStep(work,step,Math.max(0,by-Date.now()));
}

/** The pending owner reservation, within `ms`; one that arrives later is released at once. The caller reserves
 * itself, so a reserved connection stays confined to the worker files test/pooler-compatibility-drift.test.ts allows. */
export function reservedWithin(reservation:Promise<postgres.ReservedSql>,ms:number):Promise<postgres.ReservedSql>{
 return ownerStep(reservation,'the connection reservation',ms,late=>late.release());
}
