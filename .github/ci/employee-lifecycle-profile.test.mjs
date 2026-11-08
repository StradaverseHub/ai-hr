import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {EMPLOYEE_LIFECYCLE_PROFILE as profile,employeeLifecycleFile,employeeLifecycleStage,validateEmployeeLifecycleProfile,employeeLifecycleNormalBudget,employeeLifecycleFrontier,validateEmployeeLifecycleTestResult,employeeLifecycleUnit,employeeLifecycleMatrixRow} from './employee-lifecycle-profile.mjs';
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
 for(const stage of ['reset','migrate','benchmark']){const state=employeeLifecycleFrontier(profile.files[0].file);state.record(stage,false);for(const work of ['reset','migrate','benchmark'])assert.throws(()=>state.admit(work));for(const observation of ['git-head','controller-head','controller-status','evidence','stats','stop'])state.admit(observation);assert.throws(()=>state.authorize());assert.equal(state.snapshot().poisoned,true);}
});
const passed=(row)=>({success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numTodoTests:0,numTotalTests:row.cases,numPassedTests:row.cases,testResults:[{name:'/source/'+row.file,status:'passed',assertionResults:Array.from({length:row.cases},()=>({status:'passed'}))}]});
test('every actual Vitest file count must match independently expected6/2/3/9/6 without skips or foreign members',()=>{
 for(const row of profile.files){assert.equal(validateEmployeeLifecycleTestResult(passed(row),row.file,'/source'),row.cases);for(const change of [value=>value.numTotalTests--,value=>value.numPendingTests++,value=>value.testResults[0].assertionResults[0].status='pending',value=>value.testResults[0].name='/source/test/foreign.test.ts']){const result=passed(row);change(result);assert.throws(()=>validateEmployeeLifecycleTestResult(result,row.file,'/source'));}}
});
test('all five entries call the actual shared admission before their hooks and contain no focused skip gate',()=>{
 const helper=readFileSync(new URL('../../test/performance/employee-choice-lifecycle-admission.ts',import.meta.url),'utf8');assert.match(helper,/const admission=admitSingletonTest\(file\)/);assert.match(helper,/employeeLifecycleProcess\(context.parent.pid\)/);assert.match(helper,/supervisor ancestor required/);
 const shared=readFileSync(new URL('../../test/performance/employee-choice-benchmark-harness.ts',import.meta.url),'utf8');
 const contract=readFileSync(new URL('../../test/performance/employee-choice-benchmark-contract.ts',import.meta.url),'utf8');
 const delegated={'test/employee-choice-native-purpose-plan.test.ts':'classic','test/employee-choice-exact-ascii-plan.test.ts':'exact-ascii'};
 const prefix="export function registerEmployeeChoiceBenchmark(purpose:EmployeeChoiceBenchmarkPurpose){\nconst contract=employeeChoiceBenchmarkContract(purpose),ascii=purpose==='exact-ascii',prototype=ascii?exactAscii:classic;\nconst file=contract.file;\nconst lifecycle=admitEmployeeChoiceLifecycle(file);\nbeforeAll(async()=>{initializeEvidence();";
 function verifyDelegation(file,purpose,entry,harness,contracts){
  assert.equal(delegated[file],purpose);assert(['classic','exact-ascii'].includes(purpose));
  assert.equal(entry,`/** Fixed existing native benchmark entry. The shared owner admits its exact\n * real lifecycle profile before any hooks, constructors or SQL. */\nimport {registerEmployeeChoiceBenchmark} from './performance/employee-choice-benchmark-harness';\nregisterEmployeeChoiceBenchmark('${purpose}');\n`);
  assert.equal(createHash('sha256').update(harness).digest('hex'),'e4cc3c70a7c3e39a6bcc0294a9bd623e48d4c097395a804860e4eefa47973c5f');
  assert.equal(createHash('sha256').update(contracts).digest('hex'),'b19775a87ccab9951d8ab49bf1807e38cea1efb7fbba91d6d7731d19f0ee16b5');
  assert(harness.startsWith("import {admitEmployeeChoiceLifecycle} from './employee-choice-lifecycle-admission';"));assert.equal(harness.split(prefix).length,2);
  assert(harness.indexOf('const lifecycle=admitEmployeeChoiceLifecycle(file);')<harness.indexOf('beforeAll('));
  assert(contracts.includes("if(!Object.hasOwn(contracts,purpose))throw Error('Unknown closed employee benchmark purpose')"));
  assert(contracts.includes((purpose==='classic'?'classic':"'exact-ascii'")+":Object.freeze({file:'"+file+"'"));
  assert.doesNotMatch(harness,/skipIf\(!requested\)|AIHR_FOCUSED_EVIDENCE_DIR|AIHR_CI_UNIT\?\?'db-1'/);
 }
 for(const row of profile.files){const bytes=readFileSync(new URL('../../'+row.file,import.meta.url),'utf8');assert.doesNotMatch(bytes,/skipIf\(!requested\)|AIHR_FOCUSED_EVIDENCE_DIR|AIHR_CI_UNIT\?\?'db-1'/);
  if(!Object.hasOwn(delegated,row.file)){assert.match(bytes,/admitEmployeeChoiceLifecycle\(/);continue;}
  const purpose=delegated[row.file];verifyDelegation(row.file,purpose,bytes,shared,contract);
  assert.throws(()=>verifyDelegation(row.file,purpose,bytes.replace("registerEmployeeChoiceBenchmark('"+purpose+"')","registerEmployeeChoiceBenchmark('foreign')"),shared,contract));
  assert.throws(()=>verifyDelegation(row.file,purpose,bytes.replace('employee-choice-benchmark-harness','foreign-harness'),shared,contract));
  for(const changed of [shared.replace('const lifecycle=admitEmployeeChoiceLifecycle(file);',''),shared.replace('const lifecycle=admitEmployeeChoiceLifecycle(file);\nbeforeAll','beforeAll\nconst lifecycle=admitEmployeeChoiceLifecycle(file);'),shared+"\nskipIf(!requested)"])assert.throws(()=>verifyDelegation(row.file,purpose,bytes,changed,contract));
  assert.throws(()=>verifyDelegation(row.file,purpose,bytes,shared,contract.replace("file:'"+row.file+"'","file:'test/foreign.test.ts'")));
 }
});
test('normal adapter reuses the exact source kernel and preserves actual telemetry failure before mandatory stop',()=>{
 const source=readFileSync(new URL('./employee-lifecycle-supervisor.py',import.meta.url),'utf8');assert.match(source,/exec\(compile\(_kernel_path.read_bytes\(\)/);assert.match(source,/_kernel.supervise\(argv, seconds, event/);assert.match(source,/if stage != 'stop':\n            return 1/);assert.doesNotMatch(source,/os.killpg|Popen|start_new_session|AIHR_FOCUSED_.*=/);assert.match(source,/observed \+ 900 <= started \+ seconds/);
});

test('only five actual complete controlled units receive a30min matrix hint and mixed/foreign profiles refuse',()=>{
 for(const row of profile.files){const unit={id:'db-'+String(row.cases).repeat(16),kind:'db',files:[row.file],singleton:{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'}};
  assert.equal(employeeLifecycleUnit(unit),row);assert.deepEqual(employeeLifecycleMatrixRow(unit),{unit:unit.id,employeeLifecycle:true});
  for(const change of [value=>value.files.push('test/ordinary.test.ts'),value=>value.kind='nodb',value=>value.singleton.workers=2,value=>value.singleton.profile='notification-cluster-v1']){const bad=structuredClone(unit);change(bad);assert.throws(()=>employeeLifecycleMatrixRow(bad));}
 }
 assert.deepEqual(employeeLifecycleMatrixRow({id:'ordinary',files:['test/ordinary.test.ts']}),{unit:'ordinary',employeeLifecycle:false});
 for(const change of [value=>value.files[0].file='test/employee-choice-foreign.test.ts',value=>value.files[0].stage='foreign',value=>value.files.reverse()]){const bad=structuredClone(profile);change(bad);assert.throws(()=>validateEmployeeLifecycleProfile(bad));}
});
test('normal opcodes exclude unsafe unused name-only diagnostics and keep controller metadata fixed',()=>{
 const frontier=employeeLifecycleFrontier(profile.files[0].file);for(const stage of ['logs','inspect','arbitrary']){assert.throws(()=>frontier.admit(stage));assert.throws(()=>employeeLifecycleNormalBudget(stage,0));}
 for(const stage of ['controller-head','controller-status'])assert.equal(employeeLifecycleNormalBudget(stage,0),10);
});
