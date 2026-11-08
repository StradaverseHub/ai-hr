/** Closed source-owned employee test topology; no host or execution authority. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const path=new URL('./employee-lifecycle-profile.json',import.meta.url),bytes=readFileSync(path);
const exact=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),[...keys].sort());
const exactFiles=Object.freeze([
 ['test/employee-choice-native-purpose-plan.test.ts','benchmark',6,960,900,'employee-choice-native-purpose',44,27],
 ['test/employee-choice-benchmark-owner-native.test.ts','native-controls',2,180,0,null,0,0],
 ['test/employee-choice-native-owner-factory.test.ts','native-factory',3,206,0,null,0,0],
 ['test/employee-choice-exact-ascii-purpose.test.ts','ascii-purpose',9,960,900,'employee-choice-exact-ascii-purpose',0,0],
 ['test/employee-choice-exact-ascii-plan.test.ts','ascii-plan',6,960,900,'employee-choice-exact-ascii',44,22],
]);

export function validateEmployeeLifecycleProfile(value){
 exact(value,['version','normalJobSeconds','focusedJobSeconds','preAnchorSeconds','artifactTailSeconds','mandatoryStopSeconds','settlementSeconds','files']);
 assert.equal(value.version,1);assert.equal(value.normalJobSeconds,1800);assert.equal(value.focusedJobSeconds,1170);assert.equal(value.preAnchorSeconds,30);assert.equal(value.artifactTailSeconds,120);assert.equal(value.mandatoryStopSeconds,15);assert.equal(value.settlementSeconds,6);
 assert(Array.isArray(value.files)&&value.files.length===5);assert.deepEqual(value.files.map(row=>[row.file,row.stage,row.cases,row.stageSeconds,row.fileSeconds,row.clockDirectory,row.planPhases,row.callPairs]),exactFiles,'Only the five exact reviewed lifecycle units are admitted');const files=new Set(),stages=new Set();
 for(const row of value.files){
  exact(row,['file','stage','cases','stageSeconds','fileSeconds','workSeconds','cleanupSeconds','clockDirectory','planPhases','callPairs']);
  assert(/^test\/employee-choice-[a-z-]+\.test\.ts$/.test(row.file)&&!files.has(row.file));files.add(row.file);
  assert(/^[a-z-]+$/.test(row.stage)&&!stages.has(row.stage));stages.add(row.stage);
  assert(Number.isSafeInteger(row.cases)&&row.cases>0&&row.cases<=9);assert([180,206,960].includes(row.stageSeconds));
  if(row.clockDirectory===null){assert.equal(row.fileSeconds,0);assert.equal(row.stageSeconds,128+26*row.cases);assert.equal(row.workSeconds,18);assert.equal(row.cleanupSeconds,8);}
  else{assert(/^[a-z-]+$/.test(row.clockDirectory));assert.equal(row.stageSeconds,960);assert.equal(row.fileSeconds,900);assert.equal(row.workSeconds,840);assert.equal(row.cleanupSeconds,60);}
  assert([0,44].includes(row.planPhases));assert([0,22,27].includes(row.callPairs));assert.equal(row.planPhases===0,row.callPairs===0);
 }
 return Object.freeze({...value,files:Object.freeze(value.files.map(row=>Object.freeze({...row})))});
}
export const EMPLOYEE_LIFECYCLE_PROFILE=validateEmployeeLifecycleProfile(JSON.parse(bytes));
export const EMPLOYEE_LIFECYCLE_PROFILE_SHA256=createHash('sha256').update(bytes).digest('hex');
export function employeeLifecycleFile(file){return EMPLOYEE_LIFECYCLE_PROFILE.files.find(row=>row.file===file);}
export function employeeLifecycleStage(stage){const value=EMPLOYEE_LIFECYCLE_PROFILE.files.find(row=>row.stage===stage);assert(value,'Unknown closed employee lifecycle stage');return value;}
export const EMPLOYEE_LIFECYCLE_STAGES=Object.freeze({'git-head':10,'git-status':10,'git-tracked':10,'controller-head':10,'controller-status':10,evidence:30,classifier:15,reset:60,migrate:60,stats:10,stop:9,...Object.fromEntries(EMPLOYEE_LIFECYCLE_PROFILE.files.map(row=>[row.stage,row.stageSeconds]))});
/** Pure arithmetic only. Real owners corroborate native anchors/processes. */
export function employeeLifecycleNormalBudget(stage,elapsed){
 assert(Object.hasOwn(EMPLOYEE_LIFECYCLE_STAGES,stage)&&Number.isFinite(elapsed)&&elapsed>=0);
 const profile=EMPLOYEE_LIFECYCLE_PROFILE,reserve=stage==='stop'?profile.preAnchorSeconds:profile.preAnchorSeconds+profile.artifactTailSeconds+profile.mandatoryStopSeconds;
 const remaining=profile.normalJobSeconds-elapsed-reserve-profile.settlementSeconds,maximum=EMPLOYEE_LIFECYCLE_STAGES[stage];
 // Native stages require their ENTIRE original external envelope. Never borrow
 // native setup allowance or shorten900s clocks to make late work fit.
 if(profile.files.some(row=>row.stage===stage))assert(remaining>=maximum,'Complete employee stage no longer fits actual job');
 assert(remaining>0,'Normal lifecycle job envelope exhausted');return Math.min(maximum,remaining);
}
/** Pure stage order; this state grants no host/resource authority by itself. */
export function employeeLifecycleFrontier(file){
 const profile=employeeLifecycleFile(file);assert(profile);let reset=false,migrated=false,test=false,poisoned=false,closed=false;
 const observations=['git-head','git-status','git-tracked','controller-head','controller-status','evidence','classifier','stats','stop'];
 return Object.freeze({
  admit(stage){assert(observations.includes(stage)||['reset','migrate',profile.stage].includes(stage),'Unknown/cross-file stage');if(stage==='stop')return;assert(!closed,'Lifecycle closed');if(observations.includes(stage))return;assert(!poisoned,'Poisoned lifecycle forbids SQL');if(stage==='reset'){assert(!reset&&!migrated&&!test,'Reset already consumed');return;}if(stage==='migrate'){assert(reset&&!migrated&&!test,'Actual owned reset required');return;}assert(migrated&&!test,'Actual owned migration required');},
  record(stage,success){assert(typeof success==='boolean');if(!success)poisoned=true;if(stage==='reset')reset=true;if(stage==='migrate')migrated=true;if(stage===profile.stage)test=true;},
  authorize(){assert(reset&&migrated&&!poisoned&&!test&&!closed,'Native prerequisites not yet owned');},
  close(){closed=true;},
  snapshot(){return Object.freeze({reset,migrated,test,poisoned,closed});},
 });
}
export function validateEmployeeLifecycleTestResult(result,file,source){
 const profile=employeeLifecycleFile(file);assert(profile);assert.equal(result.success,true);for(const key of ['numFailedTests','numFailedTestSuites','numPendingTests','numTodoTests'])assert.equal(result[key],0);
 assert.equal(result.numTotalTests,profile.cases);assert.equal(result.numPassedTests,profile.cases);assert.equal(result.testResults.length,1);
 const suite=result.testResults[0];assert([file,source+'/'+file].includes(suite.name));assert.equal(suite.status,'passed');assert.equal(suite.assertionResults.length,profile.cases);for(const row of suite.assertionResults)assert.equal(row.status,'passed');return profile.cases;
}

/** Pure classification of an already reconstructed complete unit, never authority. */
export function employeeLifecycleUnit(unit){
 const matched=Array.isArray(unit?.files)?unit.files.filter(file=>employeeLifecycleFile(file)):[];
 if(!matched.length)return undefined;
 assert.equal(matched.length,1);assert.deepEqual(unit.files,matched);assert.equal(unit.kind,'db');
 assert.deepEqual(unit.singleton,{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'});
 return employeeLifecycleFile(matched[0]);
}
export function employeeLifecycleMatrixRow(unit){return Object.freeze({unit:unit.id,employeeLifecycle:employeeLifecycleUnit(unit)!==undefined});}
