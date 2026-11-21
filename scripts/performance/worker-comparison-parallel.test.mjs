/** Pure models of the parallel worker courses. No runner, build or database. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createParallelWorkerCellModel,isWorkerComparisonCourse,PARALLEL_WORKER_CELL_FRONTIERS_MS,
 workerComparisonCellName,workerComparisonCourse,workerSetupFailureFact} from './worker-comparison.mjs';

const identity={candidateSha:'a'.repeat(40),controllerSha:'a'.repeat(40),runId:123,runAttempt:1};
const prerequisite={kind:'AUTHENTICATED_FULL_DEVELOPMENT_PREFLIGHT_SCOPE_ONLY',releaseEligible:false,source:identity.candidateSha,
 runId:111,resolveJobId:112,selectedJobId:113,artifactId:114,archiveSha256:'1'.repeat(64),captureSha256:'2'.repeat(64),
 renderedUnionSha256:'3'.repeat(64),harnessSha256:'4'.repeat(64),scenarioSha256:'5'.repeat(64)};
const host={effectiveCpus:4,memoryBytes:16*1024**3,nodeVersion:'v24.22.1',postgresProfile:2,
 cpuModel:'AMD EPYC 7763 64-Core Processor',logicalCpus:4,kernel:'6.11.0-1018-azure'};
const seal={buildId:'reviewed_build',entries:10,bytes:1000,sha256:'b'.repeat(64)};
const transport={seal,archiveSha256:'c'.repeat(64)};

function model({courseName='parallel-smoke',workers='4',build=seal,passed=true,settle=true,upstream,now}={}){
 let time=1000;
 const trace=[];
 const instance=createParallelWorkerCellModel({courseName,workers,identity,
  prerequisite:upstream===undefined?(courseName==='parallel-smoke'?null:prerequisite):upstream,host,transport,anchorMs:1000,
  now:now??(()=>time+=1000),
  async observeCell({cell}){
   trace.push('cell:'+cell.name);
   return {kind:'WORKER_COMPARISON_CELL_V1',scope:cell.scope,passed,build:{identity,seal:build,directory:{device:'20',inode:'101'}},
    fixture:{day:'2026-11-10',actors:500,tenants:2,companies:10,nativeGrants:544,claims:cell.claimsPerActor*500,attendance:90000,payslips:500}};
  },
  async settledForReuse({cell}){
   trace.push('settle:'+cell.ordinal);
   if(!settle)throw Error('family still exiting');
   return {kind:'WORKER_COMPARISON_CELL_SETTLEMENT_V1',...identity,ordinal:cell.ordinal,settledForReuse:true,directChildrenClosed:true,
    processFamilyEmpty:true,postgresBirthAbsent:true,portsAbsent:true,runtimeBuildRetired:true,focusedDirectoryRetired:true};
  },
  async verifySeed(){trace.push('verify');return seal;},
  async retireSeed(){trace.push('retire');return {kind:'WORKER_COMPARISON_SEED_RETIREMENT_V1',...identity,retired:true,privateDirectoryRetired:true};},
 });
 return {instance,trace};
}

test('courses keep the serial table and add one-runner parallel and smoke cells',()=>{
 assert.deepEqual(workerComparisonCourse('serial-2-4-8').map(cell=>[cell.name,cell.buildMode]),
  [['steady-2','comparison-first'],['steady-4','comparison-copy'],['functional-8','comparison-copy']]);
 const parallel=workerComparisonCourse('parallel-2-4-8');
 assert.deepEqual(parallel.map(cell=>[cell.name,cell.buildMode,cell.holdMs,cell.claimsPerActor]),
  [['steady-2','comparison-artifact',300000,2000],['steady-4','comparison-artifact',300000,2000],['functional-8','comparison-artifact',30000,200]]);
 // Matched steady budgets are unchanged from the serial course.
 for(const [index,cell] of parallel.entries()){
  const serial=workerComparisonCourse('serial-2-4-8')[index];
  for(const key of ['suite','scope','workers','heapMiBPerWorker','poolPerWorker','totalHeapMiB','totalPool','fixtureActors',
   'attendanceDays','thinkMs','driverMs','rampMs','holdMs','oversubscribed'])assert.equal(cell[key],serial[key],cell.name+' '+key);
 }
 const smoke=workerComparisonCourse('parallel-smoke');
 assert.deepEqual(smoke.map(cell=>[cell.name,cell.suite,cell.workers,cell.heapMiBPerWorker,cell.poolPerWorker,cell.holdMs,cell.oversubscribed]),
  [['smoke-2','workflow-preflight',2,2048,8,30000,false],['smoke-4','workflow-preflight',4,1024,4,30000,false],
   ['smoke-8','workflow-preflight',8,512,2,30000,true]]);
 assert.equal(workerComparisonCellName('workflow-preflight','4','parallel-smoke'),'smoke-4');
 assert.equal(workerComparisonCellName('workflow-preflight','4'),undefined);
 assert.equal(workerComparisonCellName('whole-system','4','parallel-2-4-8'),'steady-4');
 for(const name of ['off','preflight-2','toString','',undefined])assert.equal(isWorkerComparisonCourse(name),false);
});

test('a passed cell installs exactly the upstream seal, settles, then retires its seed',async()=>{
 const {instance,trace}=model();
 assert.equal(instance.cell.name,'smoke-4');
 const result=await instance.run();
 assert.equal(result.complete,true);
 assert.deepEqual(result.cell,{name:'smoke-4',scope:'smoke-harness-only',state:'passed',reason:null,fixtureDay:'2026-11-10',settlement:'settled'});
 assert.deepEqual(result.buildSeal,seal);assert.equal(result.seedSettlement,'settled');
 assert.deepEqual(trace,['cell:smoke-4','settle:2','verify','retire']);
 assert.equal(result.frontiers.activeEndMs-result.frontiers.anchorMs,PARALLEL_WORKER_CELL_FRONTIERS_MS.active);
 await assert.rejects(()=>instance.run(),/cannot reopen/);
});

test('another build, a failed measurement or an unsettled family fails the cell closed',async()=>{
 const other=await model({build:{...seal,sha256:'d'.repeat(64)}}).instance.run();
 assert.equal(other.cell.reason,'build-proof');assert.equal(other.complete,false);assert.equal(other.buildSeal,null);
 const measured=await model({passed:false}).instance.run();
 assert.equal(measured.cell.reason,'measurement');assert.equal(measured.complete,false);assert.equal(measured.seedSettlement,'settled');
 const {instance,trace}=model({settle:false});
 const unsettled=await instance.run();
 assert.equal(unsettled.cell.reason,'settlement');assert.equal(unsettled.seedSettlement,'unknown');
 assert.deepEqual(trace,['cell:smoke-4','settle:2']);
});

test('the full parallel course needs the authenticated preflight and the smoke refuses one',()=>{
 assert.throws(()=>model({courseName:'parallel-2-4-8',upstream:null}),/same-source full preflight/);
 assert.throws(()=>model({courseName:'parallel-smoke',upstream:prerequisite}),/no preflight authority/);
 assert.equal(model({courseName:'parallel-2-4-8',workers:'2'}).instance.cell.name,'steady-2');
 for(const workers of ['1','3','16',4])assert.throws(()=>model({workers}),/cell refused/);
 assert.throws(()=>model({courseName:'serial-2-4-8'}),/course refused/);
});

test('runner specification and host profile are both required',()=>{
 for(const change of [{cpuModel:''},{cpuModel:'x\n'},{logicalCpus:2},{kernel:'6.8 bad'},{effectiveCpus:8},{memoryBytes:8*1024**3}]){
  assert.throws(()=>createParallelWorkerCellModel({courseName:'parallel-smoke',workers:'2',identity,prerequisite:null,
   host:{...host,...change},transport,anchorMs:1000,now:()=>1000,observeCell(){},settledForReuse(){},verifySeed(){},retireSeed(){}}));
 }
});

test('a failed setup phase publishes closed facts and never raw log text',()=>{
 const secret='postgres://user:secret@10.0.0.1/payroll';
 assert.deepEqual(workerSetupFailureFact({label:'postgres',code:2,timedOut:false,exitSignal:null,
  log:secret+'\nAIHR_CI_POSTGRES_EXIT code=2 stage=development-lock-log-admission\n'}),
 {kind:'WORKER_COMPARISON_SETUP_FAILURE_V1',phase:'postgres',exitCode:2,timedOut:false,exitSignal:null,postgresStage:'development-lock-log-admission'});
 const foreign=workerSetupFailureFact({label:secret,code:'2;'+secret,timedOut:'yes',exitSignal:secret,log:'AIHR_CI_POSTGRES_EXIT code=2 stage=X '+secret});
 assert.deepEqual(foreign,{kind:'WORKER_COMPARISON_SETUP_FAILURE_V1',phase:'unavailable',exitCode:null,timedOut:false,exitSignal:null,postgresStage:null});
});

test('a cell that cannot fit its active frontier is not entered',async()=>{
 const late=model({now:(()=>{let calls=0;return()=>1000+(calls++===0?PARALLEL_WORKER_CELL_FRONTIERS_MS.active:0);})()});
 const result=await late.instance.run();
 assert.equal(result.cell.state,'not-entered');assert.equal(result.cell.reason,'budget');assert.deepEqual(late.trace,[]);
});
