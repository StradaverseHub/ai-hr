import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EMPLOYEE_LIFECYCLE_PROFILE as profile,employeeLifecycleFile,employeeLifecycleStage,validateEmployeeLifecycleProfile,employeeLifecycleNormalBudget,employeeLifecycleFrontier,validateEmployeeLifecycleTestResult} from './employee-lifecycle-profile.mjs';
test('one complete closed registry retains all five independent case counts and native envelopes',()=>{
 assert.deepEqual(profile.files.map(row=>[row.file,row.stage,row.cases,row.stageSeconds,row.fileSeconds,row.planPhases,row.callPairs]),[
 ['test/employee-choice-native-purpose-plan.test.ts','benchmark',6,960,900,44,27],['test/employee-choice-benchmark-owner-native.test.ts','native-controls',2,180,0,0,0],['test/employee-choice-native-owner-factory.test.ts','native-factory',3,206,0,0,0],['test/employee-choice-exact-ascii-purpose.test.ts','ascii-purpose',9,960,900,0,0],['test/employee-choice-exact-ascii-plan.test.ts','ascii-plan',6,960,900,44,22]]);
 assert.equal(employeeLifecycleFile('test/foreign.test.ts'),undefined);assert.throws(()=>employeeLifecycleStage('foreign'));assert(Object.isFrozen(profile.files[0]));
});
test('complete normal stages refuse one microsecond beyond the unchanged job reserve',()=>{
 for(const row of profile.files){const last=1800-30-120-15-6-row.stageSeconds;assert.equal(employeeLifecycleNormalBudget(row.stage,last),row.stageSeconds);assert.throws(()=>employeeLifecycleNormalBudget(row.stage,last+0.000001));}
 assert.equal(employeeLifecycleNormalBudget('stop',1730),9);assert.throws(()=>employeeLifecycleNormalBudget('stop',1764));assert.throws(()=>employeeLifecycleNormalBudget('unknown',0));
});
test('registry malformed/duplicate/context and budget drift refuse rather than changing authority',()=>{
 for(const change of [value=>value.files.push({...value.files[0]}),value=>value.files[1].file=value.files[0].file,value=>value.files[2].stageSeconds=180,value=>value.files[3].fileSeconds=206,value=>value.files[4].cleanupSeconds=61,value=>value.normalJobSeconds=1801]){const copy=structuredClone(profile);change(copy);assert.throws(()=>validateEmployeeLifecycleProfile(copy));}
});
test('SQL order requires actual reset and migration and consumes each whole file once',()=>{
 const state=employeeLifecycleFrontier(profile.files[0].file);assert.throws(()=>state.authorize());assert.throws(()=>state.admit('migrate'));state.admit('reset');state.record('reset',true);assert.throws(()=>state.admit('reset'));state.admit('migrate');state.record('migrate',true);state.authorize();state.admit('benchmark');state.record('benchmark',true);assert.throws(()=>state.admit('benchmark'));state.close();state.admit('stop');assert.throws(()=>state.admit('evidence'));
});
test('a failed stage hard-closes later SQL but leaves observation and mandatory stop available',()=>{
 for(const stage of ['reset','migrate','benchmark']){const state=employeeLifecycleFrontier(profile.files[0].file);state.record(stage,false);for(const work of ['reset','migrate','benchmark'])assert.throws(()=>state.admit(work));for(const observation of ['evidence','stats','logs','inspect','stop'])state.admit(observation);assert.throws(()=>state.authorize());assert.equal(state.snapshot().poisoned,true);}
});
const passed=(row)=>({success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numTodoTests:0,numTotalTests:row.cases,numPassedTests:row.cases,testResults:[{name:'/source/'+row.file,status:'passed',assertionResults:Array.from({length:row.cases},()=>({status:'passed'}))}]});
test('every actual Vitest file count must match independently expected6/2/3/9/6 without skips or foreign members',()=>{
 for(const row of profile.files){assert.equal(validateEmployeeLifecycleTestResult(passed(row),row.file,'/source'),row.cases);for(const change of [value=>value.numTotalTests--,value=>value.numPendingTests++,value=>value.testResults[0].assertionResults[0].status='pending',value=>value.testResults[0].name='/source/test/foreign.test.ts']){const result=passed(row);change(result);assert.throws(()=>validateEmployeeLifecycleTestResult(result,row.file,'/source'));}}
});
test('all five entries call the actual shared admission before their hooks and contain no focused skip gate',()=>{
 const helper=readFileSync(new URL('../../test/performance/employee-choice-lifecycle-admission.ts',import.meta.url),'utf8');assert.match(helper,/const admission=admitSingletonTest\(file\)/);assert.match(helper,/employeeLifecycleProcess\(context.parent.pid\)/);assert.match(helper,/supervisor ancestor required/);
 for(const row of profile.files){const bytes=readFileSync(new URL('../../'+row.file,import.meta.url),'utf8');assert.match(bytes,/admitEmployeeChoiceLifecycle\(/);assert.doesNotMatch(bytes,/skipIf\(!requested\)|AIHR_FOCUSED_EVIDENCE_DIR|AIHR_CI_UNIT\?\?'db-1'/);}
});
test('normal adapter reuses the exact source kernel and preserves actual telemetry failure before mandatory stop',()=>{
 const source=readFileSync(new URL('./employee-lifecycle-supervisor.py',import.meta.url),'utf8');assert.match(source,/exec\(compile\(_kernel_path.read_bytes\(\)/);assert.match(source,/_kernel.supervise\(argv, seconds, event/);assert.match(source,/if stage != 'stop':\n            return 1/);assert.doesNotMatch(source,/os.killpg|Popen|start_new_session|AIHR_FOCUSED_.*=/);assert.match(source,/observed \+ 900 <= started \+ seconds/);
});
