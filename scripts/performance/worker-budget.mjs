/** Fixed-cost hosted comparison; adding workers does not multiply DB connections or heap. */
import assert from 'node:assert/strict';
/** CPU oversubscription is a distinct diagnostic, never a production-sizing comparison. */
export function isolatedWorkerCpuAdmission({workers,availableCpus,oversubscriptionDiagnostic=false,suite}){
 assert(Number.isInteger(workers)&&workers>0&&Number.isInteger(availableCpus)&&availableCpus>0,'Verified positive CPU/worker counts required');
 const oversubscribed=workers>availableCpus;
 if(oversubscribed){
  assert(oversubscriptionDiagnostic===true&&suite==='workflow-preflight','Worker count exceeds available CPUs; explicit preflight-only oversubscription diagnostic required');
 }
 return {workers,availableCpus,oversubscribed,
  interpretation:oversubscribed?'CPU_OVERSUBSCRIPTION_DIAGNOSTIC':'WITHIN_CPU_STARTING_ENVELOPE'};
}
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
