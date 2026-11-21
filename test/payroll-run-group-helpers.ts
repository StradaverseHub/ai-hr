/** The Payroll Process wizard's run as its result screen sees it once every company's background processing job
 * (core/payroll-processing-job.ts) has finished: start the run group, drive the real worker ticks, and return the
 * settled result (core/payroll-run-group-store.ts). */
import type {SessionContext} from '../db/client';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {payrollProcessJobHandler} from '../core/payroll-processing-job';
import {startMultiCompanyPayroll,type RunGroupResult,type RunMultiCompanyInput} from '../core/payroll-run-group';
import {owner} from './harness';

export async function drainRunGroup(groupId:string,max=4000):Promise<RunGroupResult>{
 for(let i=0;i<max;i++){
  const [row]=await owner.client<{ended:boolean;result:RunGroupResult|null}[]>`select ended_at is not null as ended,result from payroll_run_group where id=${groupId}::uuid`;
  if(row?.ended&&row.result)return row.result;
  if(!await runBulkJobTick(owner.client,{handlers:[payrollProcessJobHandler]}))await new Promise(resolve=>setTimeout(resolve,30));
 }
 throw new Error('payroll run group did not settle');
}
export async function runMultiCompanyPayrollToEnd(ctx:SessionContext,input:RunMultiCompanyInput):Promise<RunGroupResult>{
 const {groupId}=await startMultiCompanyPayroll(ctx,input);
 return drainRunGroup(groupId);
}
