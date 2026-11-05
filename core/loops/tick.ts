/** AI v2 P2-2a — the Pre-salary loop's frequent tick (owner decision 4: "daily or real time", at an interval each
 * company sets), and (Phase 2 hardening, 4 November 2026) the payroll loops' refresh between nightly sweeps.
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
 * Idempotent: running it again changes nothing that is not due. No model is called; the loop stays at Prepare.
 *
 * runPayrollTick (what scripts/payroll-loop-tick.ts runs) does the same Pre-salary step, then, under the same tenant lock,
 * refreshes the Salary payroll loop and the Audit loop for the companies whose payroll changed since each last ran there
 * (a run created, processed, reprocessed, closed, reopened or reset; for the Audit loop also a statutory or bank file):
 * core/loops/payroll-freshness.ts. A company with no change is left to the nightly sweep. Each loop's own switch, stop,
 * pause and sponsor checks apply exactly as in the sweep.
 *
 * Payroll history learning (P1, migration 2012): last, under the same tenant lock, the learned baselines of the companies
 * learning is on for and whose history changed since their last learning run (a run closed, unlocked or reset, a
 * payroll-history import confirmed or reverted, or learning switched on): core/payroll-learning/recompute.ts. The nightly
 * sweep is its backstop. Learning reads and writes under its sponsor's authority, never the agent principal's. */
import type postgres from 'postgres';
import {runLoop,type LoopRunOptions,type LoopRunResult} from './run';
import {runPayrollAuditLoop,type AuditRunResult} from '../payroll-audit/run';
import {runPayrollLearning,type LearningRunResult} from '../payroll-learning/recompute';

export const PRE_SALARY_TICK_LOOP='loop_payroll_inputs' as const;
export const preSalaryTickLockKey=(tenantId:string)=>`teras-pre-salary-tick:${tenantId}`;
export type PreSalaryTickResult=Readonly<{workerId:typeof PRE_SALARY_TICK_LOOP;status:'busy'}>|LoopRunResult;

/** Runs `work` holding the tenant's tick lock, or returns null when the previous tick still holds it. */
async function underTickLock<T>(lock:postgres.Sql,tenantId:string,work:()=>Promise<T>):Promise<T|null>{
 const key=preSalaryTickLockKey(tenantId);
 const connection=await lock.reserve();
 try{
  const [held]=await connection<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended(${key},0)) as ok`;
  if(held?.ok!==true)return null;
  try{return await work();}
  finally{await connection`select pg_advisory_unlock(hashtextextended(${key},0))`;}
 }finally{connection.release();}
}

/** One tick for one tenant. `lock` is any connection pool to the same database (the tick script's owner pool). */
export async function runPreSalaryTick(lock:postgres.Sql,options:LoopRunOptions):Promise<PreSalaryTickResult>{
 const result=await underTickLock(lock,options.tenantId,()=>runLoop(PRE_SALARY_TICK_LOOP,options));
 return result??Object.freeze({workerId:PRE_SALARY_TICK_LOOP,status:'busy' as const});
}

export type PayrollTickResult=Readonly<{status:'busy'}>|Readonly<{status:'ran';preSalary:LoopRunResult;salary:LoopRunResult;audit:AuditRunResult|null;
 /** Payroll history learning (P1): null when the learning run failed before it reached a company. */
 learning:LearningRunResult|null}>;
/** The full payroll tick for one tenant: the Pre-salary loop where due, then the Salary payroll and Audit loops for the
 * companies whose payroll changed since each last ran there. One loop's failure never stops the next. */
export async function runPayrollTick(lock:postgres.Sql,options:LoopRunOptions):Promise<PayrollTickResult>{
 const result=await underTickLock(lock,options.tenantId,async()=>{
  const failed=(workerId:'loop_payroll_inputs'|'loop_salary_payroll'):LoopRunResult=>Object.freeze({workerId,status:'failed' as const,runId:''});
  const preSalary=await runLoop(PRE_SALARY_TICK_LOOP,options).catch(()=>failed('loop_payroll_inputs'));
  const salary=await runLoop('loop_salary_payroll',{...options,onlyChanged:true}).catch(()=>failed('loop_salary_payroll'));
  const audit=await runPayrollAuditLoop({tenantId:options.tenantId,principalId:options.principalId,entitlements:options.entitlements,
   ...(options.today?{today:options.today}:{}),onlyChanged:true}).catch(()=>null);
  const learning=await runPayrollLearning({tenantId:options.tenantId,principalId:options.principalId,entitlements:options.entitlements,trigger:'tick',onlyChanged:true,
   ...(options.now?{now:options.now}:{})}).catch(()=>null);
  return Object.freeze({status:'ran' as const,preSalary,salary,audit,learning});
 });
 return result??Object.freeze({status:'busy' as const});
}
