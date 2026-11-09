/** Closed, identity-free acceptance of observed application runtime diagnostics.
 * Successful browser requests alone cannot erase swallowed SQL or worker failures. */
import {admissionFailureMarkers} from './admission-failure-log.mjs';
const markerNames=Object.keys(admissionFailureMarkers(''));
export function runtimeAcceptance({workers,workerDiagnostics,nativeFailures,postgresFailures,
 postgresRuntimeScoped,profileShutdown,poolBudgetVerified}){
 const failures=[];
 const completeWorkers=rows=>Number.isInteger(workers)&&workers>0&&Array.isArray(rows)&&rows.length===workers
  &&new Set(rows.map(row=>row?.worker)).size===workers
  &&rows.every(row=>Number.isInteger(row?.worker)&&row.worker>=0&&row.worker<workers);
 if(!completeWorkers(workerDiagnostics))failures.push('worker-diagnostics-incomplete');
 else{
  if(workerDiagnostics.some(row=>row.v8HeapOutOfMemory!==false))failures.push('worker-memory-failure');
  if(workerDiagnostics.some(row=>!row.logMarkers||markerNames.some(name=>row.logMarkers[name]!==0)))failures.push('worker-runtime-failure');
 }
 if(!Array.isArray(nativeFailures))failures.push('native-failure-evidence-missing');
 else if(nativeFailures.length)failures.push('native-runtime-failure');
 if(postgresRuntimeScoped!==true||!Array.isArray(postgresFailures))failures.push('postgres-runtime-evidence-missing');
 else if(postgresFailures.length)failures.push('postgres-lock-failure');
 if(!completeWorkers(profileShutdown)||profileShutdown.some(row=>row.alreadyExited===true
  ||row.requestedSignal!=='SIGUSR2'||row.forced!==false||row.code!==0||row.signal!==null))failures.push('worker-exit-failure');
 if(poolBudgetVerified!==true)failures.push('pool-budget-unverified');
 return {pass:failures.length===0,failures};
}
