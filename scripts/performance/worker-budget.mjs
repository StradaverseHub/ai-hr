/** Fixed-cost hosted comparison; adding workers does not multiply DB connections or heap. */
import assert from 'node:assert/strict';
export function isolatedWorkerBudget(workerValue='1',connectionValue='10',heapValue='4096') {
 assert(/^(1|2|4|8)$/.test(workerValue),'Unsupported isolated worker count');
 assert(/^(10|16)$/.test(connectionValue),'Unsupported isolated application connection budget');
 assert(/^(4096|8192)$/.test(heapValue),'Unsupported isolated application heap budget');
 const workers=Number(workerValue),totalApplicationPool=Number(connectionValue),totalHeapMiB=Number(heapValue);
 if(totalHeapMiB===8192)assert(workers>=2&&totalApplicationPool===16,'Larger diagnostic heap requires the 2/4/8 comparison and 16 total connections');
 assert.equal(totalApplicationPool%workers,0,'Divide the total connection budget evenly among workers');
 return {workers,totalApplicationPool,poolPerWorker:totalApplicationPool/workers,
  heapPerWorker:totalHeapMiB/workers,totalHeapMiB,totalWaitingBudget:2048};
}
