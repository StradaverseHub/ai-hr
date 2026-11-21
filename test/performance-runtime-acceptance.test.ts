import {describe,expect,it} from 'vitest';
import {runtimeAcceptance} from '../scripts/performance/runtime-acceptance.mjs';
import {admissionFailureMarkers} from '../scripts/performance/admission-failure-log.mjs';
function clean(){return {workers:2,workerDiagnostics:[0,1].map(worker=>({worker,v8HeapOutOfMemory:false,logMarkers:admissionFailureMarkers('')})),
 nativeFailures:[],postgresFailures:[],postgresRuntimeScoped:true,
 profileShutdown:[0,1].map(worker=>({worker,requestedSignal:'SIGUSR2',forced:false,code:0,signal:null})),poolBudgetVerified:true};}
describe('application runtime acceptance',()=>{
 it('accepts complete clean evidence without turning it into release authority',()=>{
  expect(runtimeAcceptance(clean())).toEqual({pass:true,failures:[]});
 });
 it.each(Object.keys(admissionFailureMarkers('')))('refuses a swallowed %s failure despite a completed browser journey',marker=>{
  const evidence=clean(),markers=evidence.workerDiagnostics[1].logMarkers;markers[marker as keyof typeof markers]=1;
  expect(runtimeAcceptance(evidence)).toEqual({pass:false,failures:['worker-runtime-failure']});
 });
 it('refuses a runtime PostgreSQL lock failure even without a public application error',()=>{
  const evidence={...clean(),postgresFailures:[{kind:'canceling statement due to lock timeout'}]};
  expect(runtimeAcceptance(evidence)).toEqual({pass:false,failures:['postgres-lock-failure']});
 });
 it('does not infer clean runtime from missing or unscoped diagnostics',()=>{
  for(const patch of [{workerDiagnostics:undefined},{nativeFailures:undefined},{postgresFailures:undefined},
   {postgresRuntimeScoped:false},{profileShutdown:undefined},{poolBudgetVerified:false}]){
   expect(runtimeAcceptance({...clean(),...patch}).pass).toBe(false);
  }
 });
 it('refuses incomplete, duplicate and out-of-range worker evidence',()=>{
  for(const ids of [[0],[0,0],[0,2]]){
   const evidence=clean();evidence.workerDiagnostics=ids.map(worker=>({...evidence.workerDiagnostics[0],worker}));
   expect(runtimeAcceptance(evidence).failures).toContain('worker-diagnostics-incomplete');
  }
 });
 it('refuses OOM, native errors, early exits and forced shutdown',()=>{
  const oom=clean();oom.workerDiagnostics[0].v8HeapOutOfMemory=true;
  expect(runtimeAcceptance(oom).failures).toContain('worker-memory-failure');
  expect(runtimeAcceptance({...clean(),nativeFailures:[{source:'public-error'}]}).failures).toContain('native-runtime-failure');
  for(const patch of [{alreadyExited:true},{forced:true},{code:1},{signal:'SIGKILL'}]){
   const evidence=clean();Object.assign(evidence.profileShutdown[0],patch);
   expect(runtimeAcceptance(evidence).failures).toContain('worker-exit-failure');
  }
 });
});
