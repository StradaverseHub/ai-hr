import {expect,it} from 'vitest';
import {isolatedWorkerBudget} from '../scripts/performance/worker-budget.mjs';
import {applicationDatabaseBudget} from '../db/capacity';
it.each([2,4,8])('holds connection, waiting and heap totals fixed for %i workers',workers=>{
 const budget=isolatedWorkerBudget(String(workers),'16');
 expect(budget.poolPerWorker*workers).toBe(16);expect(budget.heapPerWorker*workers).toBe(4096);
 const admitted=applicationDatabaseBudget({AIHR_APP_WORKERS:String(workers),AIHR_DB_POOL_MAX:String(budget.poolPerWorker),AIHR_DB_TOTAL_CONNECTIONS:'16'});
 expect(admitted.maxWaiting*workers).toBe(budget.totalWaitingBudget);
});
it.each([['4','10'],['8','10'],['3','16'],['16','16'],['2','32'],['02','16']])('rejects unsupported or fractional topology %s/%s',(workers,total)=>{
 expect(()=>isolatedWorkerBudget(workers,total)).toThrow();
});
