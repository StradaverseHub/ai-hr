/** Fixed-cost hosted comparison; adding workers does not multiply DB connections or heap. */
import assert from 'node:assert/strict';
export function isolatedWorkerBudget(workerValue='1',connectionValue='10') {
 assert(/^(1|2|4|8)$/.test(workerValue),'Unsupported isolated worker count');
 assert(/^(10|16)$/.test(connectionValue),'Unsupported isolated application connection budget');
 const workers=Number(workerValue),totalApplicationPool=Number(connectionValue);
 assert.equal(totalApplicationPool%workers,0,'Divide the total connection budget evenly among workers');
 return {workers,totalApplicationPool,poolPerWorker:totalApplicationPool/workers,
  heapPerWorker:4096/workers,totalHeapMiB:4096,totalWaitingBudget:2048};
}
