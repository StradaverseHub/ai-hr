/** AI v2 P2-2a — the Pre-salary loop's frequent tick (owner decision 4: "daily or real time", at an interval each
 * company sets).
 *
 * The nightly sweep (scripts/review-sweep.ts, 03:00) runs every loop once a day. A company that checks hourly or twice a
 * day needs more: scripts/payroll-loop-tick.ts runs this every 15 minutes (deploy/systemd/aihr-payroll-loop-tick.*),
 * and each tick runs ONLY the Pre-salary loop, and only for the companies its due check says are due
 * (core/loops/payroll-loop-settings.ts payrollLoopDueTx): a daily company is checked once a day however often the
 * tick comes round.
 *
 * Overlap-safe twice over:
 *  - one tick per tenant at a time: a session advisory lock on a reserved connection, tried, never waited for, so a
 *    tick that finds the previous one still running for the tenant skips it and says so;
 *  - one run per company per interval whoever runs the loop: the runner checks again, under its own per-loop write
 *    lock, that each company is still due before it writes (core/loops/run.ts), so a tick that overlaps the nightly
 *    sweep, or a second process, writes nothing for a company the other already checked.
 * Idempotent: running it again changes nothing that is not due. No model is called; the loop stays at Prepare. */
import type postgres from 'postgres';
import {runLoop,type LoopRunOptions,type LoopRunResult} from './run';

export const PRE_SALARY_TICK_LOOP='loop_payroll_inputs' as const;
export const preSalaryTickLockKey=(tenantId:string)=>`teras-pre-salary-tick:${tenantId}`;
export type PreSalaryTickResult=Readonly<{workerId:typeof PRE_SALARY_TICK_LOOP;status:'busy'}>|LoopRunResult;

/** One tick for one tenant. `lock` is any connection pool to the same database (the tick script's owner pool). */
export async function runPreSalaryTick(lock:postgres.Sql,options:LoopRunOptions):Promise<PreSalaryTickResult>{
 const key=preSalaryTickLockKey(options.tenantId);
 const connection=await lock.reserve();
 try{
  const [held]=await connection<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended(${key},0)) as ok`;
  if(held?.ok!==true)return Object.freeze({workerId:PRE_SALARY_TICK_LOOP,status:'busy' as const});
  try{return await runLoop(PRE_SALARY_TICK_LOOP,options);}
  finally{await connection`select pg_advisory_unlock(hashtextextended(${key},0))`;}
 }finally{connection.release();}
}
