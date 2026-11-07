import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildUnits,requiredEvidence,CI_EXECUTION} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {SINGLETON_FILES,singletonDescriptor,singletonKind,singletonSources,protocolHash,validateSingletonBinding,validateSingletonHost,validateSingletonDatabaseUrls,assertNoSingletonHints,assertSingletonCoverage,assertSingletonSelection} from './singleton-protocol.mjs';
import {requiredHostedSingletons} from '../../scripts/gate-singleton-scope.mjs';
const browser=['test/fictional.browser.test.tsx'];
function fixture(file='test/runtime-ready-admission-native.test.ts'){
 const kind=singletonKind(singletonDescriptor(file).profile),units=buildUnits([file],{db:kind==='db'?[file]:[],nodb:kind==='nodb'?[file]:[]},browser),unit=units[0];
 const body={schemaVersion:2,policyVersion:'aihr-staging-ci/v19',sha:'a'.repeat(40),controller:'b'.repeat(40),migrationBase:'d'.repeat(40),runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite:[file],units,
  singletonSources:{[unit.id]:Object.fromEntries(singletonSources(unit).map(path=>[path,'c'.repeat(64)]))}};
 const plan={...body,fingerprint:protocolHash(body)},witness={runId:123,attempt:1};
 const prerequisites=kind==='db'?{kind:'fresh-job-postgres-cluster',workers:1,database:{schemaVersion:2,profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,errors:{},memoryLimit:2113929216,memorySwap:2113929216,memoryMax:2113929216,memorySwapMax:0,memoryPeak:1500000000,memoryEvents:{max:0,oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'},name:`aihr-ci-123-1-${unit.id}`}}:
  {kind:'actual-job-systemd-nginx',platform:'linux',pid1:'systemd',sudoUid:'0',nginxPath:'/usr/sbin/nginx',nginxSha256:'e'.repeat(64),nginxVersion:'nginx version: nginx/1.24.0',systemdVersion:'systemd 255'};
 const binding={schemaVersion:1,mode:'full-ci-singleton',candidate:plan.sha,controller:plan.controller,runId:'123',attempt:'1',unit:unit.id,fingerprint:plan.fingerprint,file,profile:unit.singleton.profile,sourceHashes:plan.singletonSources[unit.id],evidenceDirectory:'/tmp/fixture/aihr-ci',prerequisites};
 const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_WORKFLOW:'alpha-staging-ci',GITHUB_JOB:'test',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',AIHR_CI_HEAD:plan.sha,AIHR_CI_CONTROL_HEAD:plan.controller,GITHUB_SHA:plan.controller,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main'};
 const event={repository:{full_name:'StradaverseHub/ai-hr',id:1333414856},inputs:{expected_sha:plan.sha}};
 const layout={platform:'linux',workspace:'/fixture',temp:'/tmp/fixture',source:'/fixture/source',automation:'/fixture/automation',cwd:'/fixture/source',evidence:'/tmp/fixture/aihr-ci',sourceHead:plan.sha,controllerHead:plan.controller,sourceClean:true,controllerClean:true};
 return {plan,unit,witness,binding,env,event,layout};
}
test('every registered infrastructure file remains exactly once in its native class and a dedicated bounded job',()=>{
 const native=Object.keys(SINGLETON_FILES),ordinary=['test/ordinary-db.test.ts','test/ordinary-nodb.test.ts'];
 const db=native.filter(f=>singletonKind(singletonDescriptor(f).profile)==='db').concat(ordinary[0]),nodb=native.filter(f=>!db.includes(f)).concat(ordinary[1]),suite=[...db,...nodb].sort();
 const units=buildUnits(suite,{db,nodb},browser),special=units.filter(u=>u.singleton);
 assert.equal(special.length,15);assert.deepEqual(units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort(),suite);
 assert(special.every(u=>u.files.length===1&&u.singleton.workers===1));assert.equal(requiredEvidence({suite,units}).units.length,units.length);
 for(const unit of special){const changed=structuredClone(units);changed.find(u=>u.id===unit.id).singleton.workers=2;assert.throws(()=>requiredEvidence({suite,units:changed}));}
 assert.throws(()=>buildUnits([native[0]],{db:[],nodb:[native[0]]},browser));
 assert.deepEqual(requiredHostedSingletons(suite).sort(),native.sort());
});
test('actual full-CI host context, complete plan and closed native prerequisites admit',()=>{
 for(const file of ['test/runtime-ready-admission-native.test.ts','test/notification-worker-lifecycle.test.ts','test/analytics-termination-lateral.test.ts']){
  const f=fixture(file);validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness);
 }
});
for(const [name,mutate]of [
 ['foreign source',f=>f.binding.candidate='f'.repeat(40)],['foreign controller',f=>f.binding.controller='f'.repeat(40)],
 ['wrong unit',f=>f.binding.unit='other'],['wrong file',f=>f.binding.file='test/ordinary.test.ts'],['wrong profile',f=>f.binding.profile='unknown'],
 ['claimed focused mode',f=>f.binding.mode='focused'],['second attempt',f=>f.binding.attempt='2'],['wrong producing run',f=>f.binding.runId='456'],
 ['missing source proof',f=>delete f.binding.sourceHashes],['source byte drift',f=>f.binding.sourceHashes={...f.binding.sourceHashes,[f.unit.files[0]]:'f'.repeat(64)}],
 ['wrong plan fingerprint',f=>f.binding.fingerprint='f'.repeat(64)],['expanded workers',f=>f.unit.singleton.workers=2],['batched file',f=>f.unit.files.push('test/ordinary.test.ts')],
 ['not systemd',f=>f.binding.prerequisites.pid1='init'],['sudo not root',f=>f.binding.prerequisites.sudoUid='1000'],['missing nginx',f=>delete f.binding.prerequisites.nginxVersion],
 ['changed nginx bytes',f=>f.binding.prerequisites.nginxSha256='claimed'],['unknown proof key',f=>f.binding.accepted=true],
 ['absent authenticated witness',f=>f.witness=undefined],
])test('refuses singleton proof: '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validateSingletonBinding(f.binding,f.plan,f.unit,f.witness));});
for(const [name,mutate]of [
 ['forged focused selection',f=>f.env.AIHR_FOCUSED_TESTS='[]'],['empty focused hint',f=>f.env.AIHR_FOCUSED_SUITE_CAPACITY=''],
 ['foreign repository',f=>f.env.GITHUB_REPOSITORY='other/repo'],['other workflow',f=>f.env.GITHUB_WORKFLOW='alpha-focused-checks'],
 ['not hosted',f=>f.env.RUNNER_ENVIRONMENT='self-hosted'],['wrong job',f=>f.env.GITHUB_JOB='selected-tests'],['rerun',f=>f.env.GITHUB_RUN_ATTEMPT='2'],
 ['dirty candidate',f=>f.layout.sourceClean=false],['dirty controller',f=>f.layout.controllerClean=false],['symlinked source layout',f=>f.layout.source='/elsewhere/source'],
 ['foreign evidence path',f=>f.layout.evidence='/tmp/unowned'],['wrong actual source',f=>f.layout.sourceHead='f'.repeat(40)],
 ['wrong event source',f=>f.event.inputs.expected_sha='f'.repeat(40)],['foreign event repository',f=>f.event.repository.id=1],['unsupported event',f=>f.env.GITHUB_EVENT_NAME='schedule'],
])test('refuses singleton host: '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validateSingletonHost(f));});
test('cluster receipt is bound to the physical job/run/attempt/unit, not a worker database namespace',()=>{
 const f=fixture('test/notification-worker-lifecycle.test.ts');f.binding.prerequisites.database.name='aihr-ci-123-1-db-other';assert.throws(()=>validateSingletonBinding(f.binding,f.plan,f.unit,f.witness));
 assertNoSingletonHints({});for(const env of [{AIHR_CI_SINGLETON_BINDING:'/tmp/forged'},{AIHR_CI_SINGLETON_UNKNOWN:''}])assert.throws(()=>assertNoSingletonHints(env));
});
test('database tests bind every actual URL to the canonical owned loopback worker before their bodies run',()=>{
 const names={DATABASE_URL:'ai_hr_app',TEST_DATABASE_URL:'ai_hr_app',MIGRATION_DATABASE_URL:'postgres',TEST_MIGRATION_DATABASE_URL:'postgres'},env=Object.fromEntries(Object.entries(names).map(([key,user])=>[key,`postgres://${user}@127.0.0.1:5433/ai_hr_test_w1`]));
 validateSingletonDatabaseUrls(env,'ai_hr_test_w1');
 for(const key of Object.keys(names))for(const value of ['postgres://postgres@production:5433/ai_hr_test_w1','postgres://postgres@127.0.0.1:5432/ai_hr_test_w1','postgres://postgres@127.0.0.1:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5433/ai_hr_test_w1?options=unsafe'])assert.throws(()=>validateSingletonDatabaseUrls({...env,[key]:value},'ai_hr_test_w1'));
});
test('strict unit verifier requires the complete source-bound singleton invocation and refuses skipped/missing proof',()=>{
 const f=fixture(),report={schemaVersion:1,sha:f.plan.sha,fingerprint:f.plan.fingerprint,id:f.unit.id,cwd:'/fixture/source',files:f.unit.files,exitCode:0,singleton:f.binding,batches:[{exitCode:0,result:{success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numPendingTestSuites:0,numTodoTests:0,numTotalTests:1,numPassedTests:1,testResults:[{name:'/fixture/source/'+f.unit.files[0],status:'passed',assertionResults:[{status:'passed'}]}]}}]};
 assert.equal(verifyUnitReport(f.plan,report,f.witness).tests,1);
 for(const mutate of [r=>delete r.singleton,r=>r.batches.push(r.batches[0]),r=>r.batches[0].result.numPendingTests=1,r=>r.batches[0].result.testResults[0].assertionResults[0].status='skipped']){const changed=structuredClone(report);mutate(changed);assert.throws(()=>verifyUnitReport(f.plan,changed,f.witness));}
 assert.throws(()=>verifyUnitReport(f.plan,report));
});
test('source admissions and full workflow never manufacture focused variables or omit controlled cases',()=>{
 const run=readFileSync(new URL('./run-unit.mjs',import.meta.url),'utf8'),admission=readFileSync(new URL('../../test/helpers/ci-singleton-admission.ts',import.meta.url),'utf8');
 assert(run.includes('env.AIHR_CI_SINGLETON_BINDING=singleton.path'));assert(!/env\.AIHR_FOCUSED_[A-Z_]+\s*=/.test(run));assert(admission.includes('execFileSync(process.execPath,[script]'));
 const root=fileURLToPath(new URL('../../',import.meta.url)),tracked=new Set(execFileSync('git',['ls-files','test'],{cwd:root,encoding:'utf8'}).trim().split('\n'));
 for(const [file,profile]of Object.entries(SINGLETON_FILES))if(profile==='controlled-database-v1'&&tracked.has(file)){
  const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');assert(text.includes('admitSingletonTest('));assert(!text.includes('.skipIf('));assert(!text.includes('AIHR_FOCUSED_EVIDENCE_DIR'));
 }
});
test('discovered future focused-only guards fail planning until their actual full admission is implemented',()=>{
 const future='test/employee-choice-unified-plan.test.ts',legacy="const requested=JSON.parse(process.env.AIHR_FOCUSED_TESTS);it.skipIf(!requested)('required',()=>{});";
 assert.throws(()=>assertSingletonCoverage([future],()=>legacy));assert.throws(()=>assertSingletonCoverage(['test/analytics-termination-lateral.test.ts'],()=>legacy));
 assert.throws(()=>assertSingletonCoverage(['test/analytics-termination-lateral.test.ts'],()=>"it('required',()=>{});"));
 const root=fileURLToPath(new URL('../../',import.meta.url)),files=execFileSync('git',['ls-files','test'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>/\.test\.ts$|\.dom\.test\.tsx$/.test(f));
 assertSingletonCoverage(files,file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8'));
 assertSingletonSelection(['test/runtime-ready-admission-native.test.ts']);assertSingletonSelection(['test/ordinary-a.test.ts','test/ordinary-b.test.ts']);
 for(const file of Object.keys(SINGLETON_FILES))assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));
});
test('the real local scope guard refuses a complete native inventory rather than executing a narrowed gate',()=>{
 const script=fileURLToPath(new URL('../../scripts/gate-singleton-scope.mjs',import.meta.url));
 const ordinary=spawnSync(process.execPath,[script],{encoding:'utf8',input:'test/ordinary.test.ts\n'});assert.equal(ordinary.status,0);
 const native=spawnSync(process.execPath,[script],{encoding:'utf8',input:'test/ordinary.test.ts\ntest/runtime-ready-admission-native.test.ts\n'});assert.equal(native.status,2);assert(native.stderr.includes('authenticated hosted singleton units'));assert(native.stderr.includes('test/runtime-ready-admission-native.test.ts'));
 const scriptSource=readFileSync(new URL('../../scripts/gate-chunked.sh',import.meta.url),'utf8');assert(scriptSource.indexOf('node scripts/gate-singleton-scope.mjs')<scriptSource.indexOf('node --import tsx scripts/gate-db-classify.ts'));
});
