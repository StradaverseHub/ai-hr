/** Controller-only regressions; no app imports, database, compiler or provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSelection, partitionSelection, verifyFocusedResult, isEmployeeChoiceBenchmark, employeeBenchmarkFile} from './focused-checks.mjs';

const files = ['test/example.test.ts', 'test/screen.dom.test.tsx'];
test('Manifest retains exact file identities and sorts a copied selection', () => {
  assert.deepEqual(parseSelection(JSON.stringify(files.toReversed())), files);
});
for (const value of ['{}', 'null', '[]', 'invalid', JSON.stringify(Array(65).fill(files[0])),
  JSON.stringify([files[0], files[0]]), JSON.stringify([null]), JSON.stringify([2]),
  ...['../test/example.test.ts', '/test/example.test.ts', 'test/../example.test.ts',
    'test//example.test.ts', 'test/./example.test.ts', 'test/example.browser.test.tsx',
    'test/*.test.ts', 'test/example.test.ts\nother', 'test/$(whoami).test.ts'].map(file => JSON.stringify([file]))]) {
  test('Reject invalid or ambiguous manifest: ' + value.slice(0, 100), () => assert.throws(() => parseSelection(value)));
}
test('Manifest rejects oversized input before parsing', () => {
  assert.throws(() => parseSelection(' '.repeat(16_385)));
});
test('Actual classifier owns the complete, disjoint selected partition', () => {
  assert.deepEqual(partitionSelection(files, `DB\t${files[0]}\treason\nNODB\t${files[1]}\tno DB\n`),
    {DB: [files[0]], NODB: [files[1]]});
});
for (const output of ['', `DB\t${files[0]}`, `DB\t${files[0]}\nNODB\t${files[0]}`,
  `UNKNOWN\t${files[0]}\nNODB\t${files[1]}`, `DB\t${files[0]}\nDB\ttest/foreign.test.ts`]) {
  test('Reject classifier omission, duplicate, foreign file or category: ' + output, () => {
    assert.throws(() => partitionSelection(files, output));
  });
}

function result() {
  return {success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 2, numPassedTests: 2,
    testResults: files.map(name => ({name: '/candidate/' + name, status: 'passed', assertionResults: [{status: 'passed'}]}))};
}
test('A focused result proves execution of every selected file and assertion', () => {
  assert.equal(verifyFocusedResult(result(), files, '/candidate'), 2);
});
for (const [name, mutate] of [
  ['false success', r => { r.success = false; }],
  ['failed count', r => { r.numFailedTests = 1; }],
  ['failed suite count', r => { r.numFailedTestSuites = 1; }],
  ['omitted file', r => { r.testResults.pop(); }],
  ['duplicate file', r => { r.testResults[1] = r.testResults[0]; }],
  ['foreign file', r => { r.testResults[0].name = '/candidate/test/foreign.test.ts'; }],
  ['outside checkout', r => { r.testResults[0].name = '/other/test/example.test.ts'; }],
  ['failed suite', r => { r.testResults[0].status = 'failed'; }],
  ['empty assertions', r => { r.testResults[0].assertionResults = []; }],
  ['skipped assertion', r => { r.testResults[0].assertionResults[0].status = 'pending'; }],
  ['todo assertion', r => { r.testResults[0].assertionResults[0].status = 'todo'; }],
  ['invented total', r => { r.numTotalTests = 3; }],
  ['invented passed total', r => { r.numPassedTests = 3; }],
  ['no tests', r => { r.testResults = []; r.numTotalTests = 0; r.numPassedTests = 0; }],
]) test('Reject incomplete/false focused execution: ' + name, () => {
  const value = result(); mutate(value);
  assert.throws(() => verifyFocusedResult(value, files, '/candidate'));
});


test('database consumer requires exact v15 cap/budget identity and refuses legacy or mixed selectors', async () => {
  const {assertFocusedPostgresProfile} = await import('./focused-checks.mjs');
  const env = {AIHR_CI_PG_PROFILE: '2', AIHR_CI_PG_CONFIGURED_CAP_BYTES: '2113929216',
    AIHR_CI_PG_PEAK_BUDGET_BYTES: '2147483648', AIHR_CI_PG_JIT: 'on'};
  assert.deepEqual(assertFocusedPostgresProfile(env), {profileVersion: 2, configuredCapBytes: 2113929216, peakBudgetBytes: 2147483648, jit: 'on'});
  for (const changes of [{AIHR_CI_PG_PROFILE: undefined}, {AIHR_CI_PG_PROFILE: '1'},
    {AIHR_CI_PG_CONFIGURED_CAP_BYTES: '2147483648'}, {AIHR_CI_PG_PEAK_BUDGET_BYTES: '2147483649'},
    {AIHR_CI_PG_MEMORY_GIB: '2'}, {AIHR_CI_PG_JIT: 'off'}, {AIHR_CI_PG_JIT: undefined}])
    assert.throws(() => assertFocusedPostgresProfile({...env, ...changes}));
  assert.throws(() => assertFocusedPostgresProfile({AIHR_CI_PG_PROFILE: 'legacy-2g', AIHR_CI_PG_MEMORY_GIB: '2', AIHR_CI_PG_JIT: 'on'}));
});


test('focused plan identity binds cap and peak budget independently of selected file identity', async () => {
  const {focusedPlanIdentity} = await import('./focused-checks.mjs');
  const input = {sha: 'a'.repeat(40), controller: 'c'.repeat(40), files, groups: {DB: files, NODB: []},
    classifierHash: 'b'.repeat(64), execution: {workers: 2, postgres: {profileVersion: 2,
      configuredCapBytes: 2113929216, peakBudgetBytes: 2147483648, jit: 'on'}}};
  const original = focusedPlanIdentity(input);
  for (const change of [{configuredCapBytes: 2147483648}, {peakBudgetBytes: 2147483649}, {profileVersion: 1}]) {
    const altered = focusedPlanIdentity({...input, execution: {...input.execution, postgres: {...input.execution.postgres, ...change}}});
    assert.notEqual(altered.fingerprint, original.fingerprint);
    assert.deepEqual(altered.files, original.files);
  }
});

test('only the exact sole experimental employee plan takes the supervised execution seam',()=>{
 assert.equal(isEmployeeChoiceBenchmark([employeeBenchmarkFile]),true);
 for(const selected of [[],files,[employeeBenchmarkFile,files[0]],['test/employee-choice-benchmark-owner-native.test.ts'],['test/employee-choice-native-purpose.test.ts']])assert.equal(isEmployeeChoiceBenchmark(selected),false);
});

test('partial evidence failure cannot prevent mandatory cleanup or erase its independent failure',async()=>{
 const {finalizeFocusedBenchmark}=await import('./focused-checks.mjs');let cleaned=0,refused=0;
 finalizeFocusedBenchmark(()=>{throw Error('PRIVATE_PAYLOAD');},()=>{cleaned++;},()=>{refused++;});assert.equal(cleaned,1);assert.equal(refused,1);
 const cleanup=Error('fixed independent cleanup refusal');let failure;
 try{finalizeFocusedBenchmark(()=>{throw Error('PRIVATE_PAYLOAD');},()=>{cleaned++;throw cleanup;},()=>{refused++;});}catch(error){failure=error;}
 assert(failure instanceof AggregateError);assert.equal(failure.errors[1],cleanup);assert(!failure.errors[0].message.includes('PRIVATE'));assert.equal(cleaned,2);
 assert.throws(()=>finalizeFocusedBenchmark(()=>{throw Error('private');},()=>{cleaned++;},()=>{throw Error('private refusal callback');}));assert.equal(cleaned,3);
});
test('uncertain process owner permanently refuses further reset/migration/test SQL while safe stop remains available',async()=>{
 const {focusedBenchmarkStageFrontier}=await import('./focused-checks.mjs');
 for(const failed of ['benchmark','native-controls','native-factory','ascii-purpose','ascii-plan','compiler-reference']){
  const calls=[],stage=focusedBenchmarkStageFrontier(name=>{calls.push(name);return{status:name===failed?1:0};});
  stage(failed);for(const name of ['reset','migrate','benchmark','native-controls','native-factory','ascii-purpose','ascii-plan','compiler-reference'])assert.throws(()=>stage(name));
  for(const name of ['evidence','stats','stop'])stage(name);assert.deepEqual(calls,[failed,'evidence','stats','stop']);
 }
});

test('new native owner controls alone use their separate fixed outer command and retain strict selection',async()=>{
 const {isEmployeeChoiceNativeControls,employeeNativeControlFile}=await import('./focused-checks.mjs');
 assert.equal(isEmployeeChoiceNativeControls([employeeNativeControlFile]),true);
 for(const selected of [[],files,[employeeNativeControlFile,files[0]],[employeeBenchmarkFile]])assert.equal(isEmployeeChoiceNativeControls(selected),false);
});


test('only the exact sole three-case native factory uses its own supervised route and mandatory workflow cleanup',async()=>{
 const {isEmployeeChoiceNativeFactory,employeeNativeFactoryFile,isEmployeeChoiceNativeControls,employeeNativeControlFile}=await import('./focused-checks.mjs');
 assert.equal(isEmployeeChoiceNativeFactory([employeeNativeFactoryFile]),true);
 for(const selected of [[],files,[employeeNativeFactoryFile,files[0]],[employeeNativeControlFile],[employeeBenchmarkFile],[employeeNativeFactoryFile+'.extra']])assert.equal(isEmployeeChoiceNativeFactory(selected),false);
 assert.equal(isEmployeeChoiceNativeControls([employeeNativeControlFile]),true);assert.equal(isEmployeeChoiceNativeControls([employeeNativeFactoryFile]),false);assert.equal(isEmployeeChoiceBenchmark([employeeNativeFactoryFile]),false);
 const workflow=readFileSync(new URL('../workflows/alpha-focused-checks.yml',import.meta.url),'utf8'),anchor=workflow.indexOf('- name: Anchor first executable focused job step'),checkout=workflow.indexOf('- uses: actions/checkout@',anchor);
 assert(anchor>=0&&checkout>anchor);assert(workflow.includes("'[\"test/employee-choice-native-owner-factory.test.ts\"]'"));
 const owner=readFileSync(new URL('./focused-checks.mjs',import.meta.url),'utf8');assert(owner.includes("stage(compiler?'compiler-reference':nativeFactory?'native-factory':nativeControls?'native-controls':asciiPurpose?'ascii-purpose':asciiPlan?'ascii-plan':'benchmark'"));
 assert(owner.includes('!isEmployeeChoiceNativeFactory(files)'));
});

test('ASCII purpose and plan have separate sole closed commands and mandatory cleanup, never mixed selections',async()=>{
 const {isEmployeeChoiceAsciiPurpose,isEmployeeChoiceAsciiPlan,employeeAsciiPurposeFile,employeeAsciiPlanFile,employeeNativeFactoryFile}=await import('./focused-checks.mjs');
 for(const [accept,file,other]of [[isEmployeeChoiceAsciiPurpose,employeeAsciiPurposeFile,employeeAsciiPlanFile],[isEmployeeChoiceAsciiPlan,employeeAsciiPlanFile,employeeAsciiPurposeFile]]){
  assert.equal(accept([file]),true);
  for(const selected of [[],[other],[file,other],[file,file],[file+'.extra'],[employeeBenchmarkFile],[employeeNativeFactoryFile]])assert.equal(accept(selected),false);
 }
 const workflow=readFileSync(new URL('../workflows/alpha-focused-checks.yml',import.meta.url),'utf8');
 for(const file of [employeeAsciiPurposeFile,employeeAsciiPlanFile])assert(workflow.includes(`'["${file}"]'`));
});

test('compiler fixture alone uses closed NODB supervision and read-only CPU settlement, never employee DB cleanup',async()=>{
 const {isCompilerReferenceFixture,compilerReferenceFile,focusedBenchmarkStageFrontier}=await import('./focused-checks.mjs');
 assert(isCompilerReferenceFixture([compilerReferenceFile]));
 for(const selected of [[],files,[compilerReferenceFile,files[0]],[employeeBenchmarkFile],[compilerReferenceFile+'.extra']])assert.equal(isCompilerReferenceFixture(selected),false);
 const workflow=readFileSync(new URL('../workflows/alpha-focused-checks.yml',import.meta.url),'utf8');
 assert(workflow.includes(`if [ "$AIHR_RESOLVED_FOCUSED_TESTS" = '["${compilerReferenceFile}"]' ]; then`));
 assert(workflow.includes('focused-checks.mjs compiler-settled'));assert(workflow.includes('AIHR_RESOLVED_FOCUSED_TESTS: ${{ needs.resolve.outputs.tests }}'));
 const calls=[],stage=focusedBenchmarkStageFrontier(name=>{calls.push(name);return{status:name==='classifier'?1:0};});
 stage('classifier');assert.throws(()=>stage('compiler-reference'));assert.deepEqual(calls,['classifier']);
});

const compilerContext={source:'1'.repeat(40),controller:'2'.repeat(40),run:'123'};
function compilerRows(){
 const rows=[];for(const[index,stage]of ['git-head','git-status','git-tracked','controller-head','controller-status','classifier','compiler-reference','git-head','git-status'].entries()){
  const common={...compilerContext,attempt:'1',operation:String(index+1).padStart(32,'0'),stage,writer:{pid:500+index,start:100+index},owner:{pid:400,start:90},releaseAuthorized:false};
  for(const value of [{kind:'stage-started'},{kind:'session-admitted',pid:600+index,start:200+index},{kind:'group-stop-before-reap',reason:'complete'},
   {kind:'group-quiescent-then-reaped',escapedSession:false},{kind:'stage-ended',reason:'complete',commandExit:0,admitted:true,reaped:true,groupQuiescent:true,escapedSession:false}])rows.push({...common,...value});
 }return rows;
}
const compilerStream=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
test('compiler stream model requires all nine ordered native ownership stages without claiming live proof',async()=>{
 const {parseCompilerSettlementRows}=await import('./focused-checks.mjs');
 assert.deepEqual(parseCompilerSettlementRows(compilerStream(compilerRows()),compilerContext),Array.from({length:9},(_,index)=>({pid:600+index,start:200+index})));
});
test('compiler stream refuses coherent foreign context, missing/duplicated/reordered stages and incomplete cleanup',async()=>{
 const {parseCompilerSettlementRows}=await import('./focused-checks.mjs');
 for(const mutate of [rows=>rows.forEach(row=>row.source='3'.repeat(40)),rows=>rows.splice(30,5),rows=>rows.push({...rows.at(-1)}),
  rows=>{[rows[6],rows[8]]=[rows[8],rows[6]];},rows=>rows[4].reaped=false,rows=>rows[3].escapedSession=true,rows=>rows[2].reason='deadline',
  rows=>rows[1].start='200',rows=>rows[7].writer={pid:9,start:9},rows=>rows[0].kind='arbitrary',rows=>rows.splice(7,0,{...rows[0]})]){
  const rows=compilerRows();mutate(rows);assert.throws(()=>parseCompilerSettlementRows(compilerStream(rows),compilerContext));
 }
 assert.throws(()=>parseCompilerSettlementRows(compilerStream(compilerRows()).trimEnd(),compilerContext));
});
test('actual same native PID/start refuses settlement while different historical start never signals the reused PID',async()=>{
 const {requireCompilerMonitorsAbsent}=await import('./focused-checks.mjs');
 const {compilerProcIdentity}=await import('./diagnostics/native-reference/admission.mjs');const actual=compilerProcIdentity(process.pid);
 assert.throws(()=>requireCompilerMonitorsAbsent([{pid:actual.pid,start:actual.start}]),/native monitor remains/);
 requireCompilerMonitorsAbsent([{pid:actual.pid,start:actual.start+1}]);
 for(const row of [{pid:0,start:1},{pid:actual.pid,start:'1'},null])assert.throws(()=>requireCompilerMonitorsAbsent([row]));
 assert.equal(compilerProcIdentity(process.pid).start,actual.start);
});
