import {expect,it} from 'vitest';
import {isolatedWorkerBudget,isolatedWorkerCpuAdmission} from '../scripts/performance/worker-budget.mjs';
import {applicationDatabaseBudget} from '../db/capacity';
it('separates a correctly sized CPU comparison from explicit oversubscription diagnostics',()=>{
 expect(isolatedWorkerCpuAdmission({workers:4,availableCpus:4,suite:'whole-system'})).toMatchObject({oversubscribed:false});
 expect(isolatedWorkerCpuAdmission({workers:8,availableCpus:16,suite:'whole-system'})).toMatchObject({oversubscribed:false});
 expect(()=>isolatedWorkerCpuAdmission({workers:8,availableCpus:4,suite:'whole-system'})).toThrow(/exceeds/);
 expect(()=>isolatedWorkerCpuAdmission({workers:8,availableCpus:4,oversubscriptionDiagnostic:true,suite:'whole-system'})).toThrow(/exceeds/);
 expect(isolatedWorkerCpuAdmission({workers:8,availableCpus:4,oversubscriptionDiagnostic:true,suite:'workflow-preflight'}))
  .toMatchObject({oversubscribed:true,interpretation:'CPU_OVERSUBSCRIPTION_DIAGNOSTIC'});
});
it.each([2,4,8].flatMap(workers=>[4096,8192].map(heap=>[workers,heap] as const)))('holds connection, waiting and heap totals fixed for %i workers and %i MiB', (workers,heap)=>{
 const budget=isolatedWorkerBudget(String(workers),'16',String(heap));
 expect(budget.poolPerWorker*workers).toBe(16);expect(budget.heapPerWorker*workers).toBe(heap);
 const admitted=applicationDatabaseBudget({AIHR_APP_WORKERS:String(workers),AIHR_DB_POOL_MAX:String(budget.poolPerWorker),AIHR_DB_TOTAL_CONNECTIONS:'16'});
 expect(admitted.maxWaiting*workers).toBe(budget.totalWaitingBudget);
});
it.each([['4','10'],['8','10'],['3','16'],['16','16'],['2','32'],['02','16']])('rejects unsupported or fractional topology %s/%s',(workers,total)=>{
 expect(()=>isolatedWorkerBudget(workers,total)).toThrow();
});

it.each([['1','16','8192'],['2','10','8192'],['8','16','8193'],['8','16','']])('refuses a mismatched or unbounded heap profile %s/%s/%s',(workers,total,heap)=>{
 expect(()=>isolatedWorkerBudget(workers,total,heap)).toThrow();
});
