import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildUnits,CI_EXECUTION} from './manifest.mjs';
import {protocolHash,singletonDescriptor,singletonKind,singletonSources} from './singleton-protocol.mjs';
import {employeeLifecycleMatrixRow} from './employee-lifecycle-profile.mjs';
import {COMMISSION_TITLE,commissioningIntent,selectCommissioning,summarizeCommissioning} from './singleton-commissioning.mjs';
const browser=['test/fictional.browser.test.tsx'];
function fixture(file='test/runtime-ready-admission-native.test.ts'){
 const kind=singletonKind(singletonDescriptor(file).profile),units=buildUnits([file],{db:kind==='db'?[file]:[],nodb:kind==='nodb'?[file]:[]},browser),unit=units[0];
 const body={schemaVersion:2,policyVersion:'aihr-staging-ci/v20',sha:'a'.repeat(40),controller:'b'.repeat(40),migrationBase:'d'.repeat(40),runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite:[file],units,
  singletonSources:{[unit.id]:Object.fromEntries(singletonSources(unit).map(path=>[path,'c'.repeat(64)]))}};
 const plan={...body,fingerprint:protocolHash(body)},witness={runId:123,attempt:1};
 const prerequisites=kind==='db'?{kind:'fresh-job-postgres-cluster',workers:1,database:{schemaVersion:2,profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,errors:{},memoryLimit:2113929216,memorySwap:2113929216,memoryMax:2113929216,memorySwapMax:0,memoryPeak:1500000000,memoryEvents:{max:0,oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'},name:`aihr-ci-123-1-${unit.id}`}}:
  {kind:'actual-job-systemd-nginx',platform:'linux',pid1:'systemd',sudoUid:'0',nginxPath:'/usr/sbin/nginx',nginxSha256:'e'.repeat(64),nginxVersion:'nginx version: nginx/1.24.0',systemdVersion:'systemd 255'};
 const binding={schemaVersion:1,mode:'full-ci-singleton',candidate:plan.sha,controller:plan.controller,runId:'123',attempt:'1',unit:unit.id,fingerprint:plan.fingerprint,file,profile:unit.singleton.profile,sourceHashes:plan.singletonSources[unit.id],evidenceDirectory:'/tmp/fixture/aihr-ci',prerequisites};
 return {plan,unit,witness,binding};
}

function selectedFixture(file){
 const f=fixture(file),selection=selectCommissioning(f.plan,[f.unit.id]);
 const result={success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numPendingTestSuites:0,numTodoTests:0,numTotalTests:1,numPassedTests:1,testResults:[{name:'/fixture/source/'+f.unit.files[0],status:'passed',assertionResults:[{status:'passed'}]}]};
 const report={schemaVersion:1,sha:f.plan.sha,fingerprint:f.plan.fingerprint,id:f.unit.id,cwd:'/fixture/source',files:f.unit.files,exitCode:0,singleton:f.binding,batches:[{exitCode:0,result,...(f.unit.kind==='db'?{databaseEvidence:f.binding.prerequisites.database}:{})}],...(f.unit.kind==='db'?{databaseTerminalEvidence:f.binding.prerequisites.database}:{})};
 const entries=[{bytes:JSON.stringify(report),report}];return {...f,selection,entries};
}
test('explicit first-attempt commissioning selects a bounded exact JSON set; blank preserves ordinary intent',()=>{
 const {unit}=fixture(),raw=JSON.stringify([unit.id]);
 assert.deepEqual(commissioningIntent('workflow_dispatch',{commission_singleton_units:raw},'1'),[unit.id]);
 assert.equal(commissioningIntent('push',{},'1'),null);
 for(const input of [null,true,123,' ', '[]','null','{}','[true]','["test/runtime-ready-admission-native.test.ts"]','["db-*"]',JSON.stringify([unit.id,unit.id]),'a'.repeat(1025),JSON.stringify(Array.from({length:17},(_,i)=>'db-'+i.toString(16).padStart(16,'0')))])assert.throws(()=>commissioningIntent('workflow_dispatch',{commission_singleton_units:input},'1'));
 for(const name of ['build_only','diagnostics_only','controller_only'])for(const truth of [true,'true'])assert.throws(()=>commissioningIntent('workflow_dispatch',{commission_singleton_units:raw,[name]:truth},'1'));
 for(const event of ['push','pull_request','schedule'])assert.throws(()=>commissioningIntent(event,{commission_singleton_units:raw},'1'));
 assert.throws(()=>commissioningIntent('workflow_dispatch',{commission_singleton_units:raw},'2'));
});
test('selection is scheduling-only over the complete plan, never a shortened plan or ordinary unit escape',()=>{
 const f=fixture(),before=structuredClone(f.plan),selection=selectCommissioning(f.plan,[f.unit.id]);
 assert.deepEqual(f.plan,before);assert.equal(selection.fingerprint,f.plan.fingerprint);assert.equal(selection.completeSuite,false);assert.equal(selection.releaseAuthorized,false);assert.deepEqual(selection.omitted,f.plan.units.filter(u=>u.id!==f.unit.id).map(u=>u.id).sort());
 assert.throws(()=>selectCommissioning(f.plan,['db-'+'f'.repeat(16)]));assert.throws(()=>selectCommissioning(f.plan,['browser-chromium']));
 for(const mutate of [p=>p.units.push(p.units[0]),p=>delete p.units[0].singleton,p=>p.units[0].singleton.workers=2,p=>p.units[0].files.push('test/ordinary.test.ts')]){const plan=structuredClone(f.plan);mutate(plan);assert.throws(()=>selectCommissioning(plan,[f.unit.id]));}
});
test('selected host and database reports retain actual native/source/run proofs but produce no release receipt',()=>{
 for(const file of ['test/runtime-ready-admission-native.test.ts','test/leave-inquiry-read-cost.test.ts']){
  const f=selectedFixture(file),summary=summarizeCommissioning(f.plan,f.selection,f.entries,f.witness);
  assert.equal(summary.selectedProfilesVerified,true);assert.equal(summary.completeSuite,false);assert.equal(summary.releaseAuthorized,false);assert.equal(summary.outcomes[0].tests,1);assert.match(summary.outcomes[0].reportHash,/^[0-9a-f]{64}$/);assert.equal(summary.result,undefined);assert.equal(summary.tier,undefined);assert(summary.omitted.length>0);
 }
});
test('native failures, skipped assertions, omitted or stale reports cannot be counted as verified',()=>{
 for(const change of [f=>f.entries=[],f=>f.entries[0].report.exitCode=1,f=>f.entries[0].report.sha='f'.repeat(40),f=>f.entries[0].report.fingerprint='f'.repeat(64),f=>f.entries[0].report.batches[0].result.numPendingTests=1,f=>f.entries[0].report.batches[0].result.testResults[0].assertionResults[0].status='skipped',f=>f.entries[0].report.singleton.prerequisites.pid1='init',f=>f.entries[0].report.singleton.sourceHashes={},f=>f.entries[0].report.singleton.controller='f'.repeat(40),f=>f.witness.runId=999]){
  const f=selectedFixture();change(f);for(const e of f.entries)e.bytes=JSON.stringify(e.report);assert.equal(summarizeCommissioning(f.plan,f.selection,f.entries,f.witness).selectedProfilesVerified,false);
 }
 const f=selectedFixture('test/leave-inquiry-read-cost.test.ts');f.entries[0].report.databaseTerminalEvidence.memoryEvents.oom_kill=1;f.entries[0].bytes=JSON.stringify(f.entries[0].report);assert.equal(summarizeCommissioning(f.plan,f.selection,f.entries,f.witness).selectedProfilesVerified,false);
});
test('extra/duplicate reports, altered selection or source identity refuse the development summary',()=>{
 for(const change of [f=>f.entries.push(f.entries[0]),f=>f.entries[0].report.id='db-'+'f'.repeat(16),f=>f.selection.fingerprint='f'.repeat(64),f=>f.selection.omitted=[],f=>f.selection.completeSuite=true,f=>f.selection.releaseAuthorized=true,f=>f.witness.attempt=2,f=>f.witness.runId=undefined]){const f=selectedFixture();change(f);for(const e of f.entries)e.bytes=JSON.stringify(e.report);assert.throws(()=>summarizeCommissioning(f.plan,f.selection,f.entries,f.witness));}
});
test('mismatched raw bytes cannot authenticate a different parsed report',()=>{const f=selectedFixture();f.entries[0].bytes='{}';assert.throws(()=>summarizeCommissioning(f.plan,f.selection,f.entries,f.witness),/raw report bytes differ/);});
test('commissioning keeps the real test job/prerequisites and skips every release-producing job',()=>{
 const source=readFileSync(new URL('../workflows/alpha-staging.yml',import.meta.url),'utf8');
 assert(source.includes("'"+COMMISSION_TITLE+"'"));
 const section=name=>source.split('  '+name+':\n')[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
 for(const name of ['typecheck','migrations','controller-tests','build','browser','verify'])assert.match(section(name),/if:.*!inputs\.commission_singleton_units/);
 assert.match(section('test'),/fail-fast: false/);assert.match(section('test'),/timeout-minutes: \$\{\{ matrix\.employeeLifecycle && 30 \|\| 120 \}\}/);assert.match(section('test'),/run-unit\.mjs/);assert.match(section('test'),/commission-unit/);assert(!section('test').includes('AIHR_FOCUSED'));
 const summary=section('commission-summary');assert.match(summary,/always\(\)/);assert.match(summary,/needs: \[resolve, plan, test, native-test\]/);assert.match(summary,/commission-plan/);assert.match(summary,/commission-unit-\*/);assert(!/verify-shards|ci-receipt|gate-evidence/.test(summary));
 assert.match(section('deployment-hold'),/test "\$PRODUCTION_ENABLED" = false/);
});

test('the real matrix command retains the full input plan and writes a separate commissioning record',()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'aihr-commissioning-'));
 try{
  const event=join(dir,'event.json'),plan=join(dir,'ci-plan.json'),selection=join(dir,'selection.json'),output=join(dir,'output');
  const bytes=JSON.stringify(f.plan);writeFileSync(plan,bytes);writeFileSync(output,'');
  writeFileSync(event,JSON.stringify({inputs:{commission_singleton_units:JSON.stringify([f.unit.id])}}));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./singleton-commissioning.mjs',import.meta.url)),'matrix',plan,selection],{encoding:'utf8',timeout:5000,env:{...process.env,GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output}});
  assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(plan,'utf8'),bytes);
  assert.deepEqual(JSON.parse(readFileSync(selection,'utf8')),selectCommissioning(f.plan,[f.unit.id]));
  assert.equal(readFileSync(output,'utf8'),'test_matrix='+JSON.stringify({include:[employeeLifecycleMatrixRow(f.unit)]})+'\n'+'native_matrix={"unit":[]}\n'+'has_tests=true\n'+'has_native=false\n');
  writeFileSync(event,JSON.stringify({inputs:{commission_singleton_units:'[]'}}));
  const bad=spawnSync(process.execPath,[fileURLToPath(new URL('./singleton-commissioning.mjs',import.meta.url)),'matrix',plan,selection],{encoding:'utf8',timeout:5000,env:{...process.env,GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output}});
  assert.notEqual(bad.status,0);assert.equal(readFileSync(plan,'utf8'),bytes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('actual matrix subprocess keeps hybrid, ordinary and mixed selections separate without dropping the frozen plan',()=>{
 const ordinary=fixture(),native=fixture('test/runtime-next-admission-native.test.ts');
 const units=[ordinary.unit,native.unit],body={...ordinary.plan,suite:units.flatMap(u=>u.files),units,
  singletonSources:{...ordinary.plan.singletonSources,...native.plan.singletonSources}};
 delete body.fingerprint;const full={...body,fingerprint:protocolHash(body)};
 const dir=mkdtempSync(join(tmpdir(),'aihr-hybrid-matrix-'));
 try{
  const event=join(dir,'event.json'),plan=join(dir,'ci-plan.json'),bytes=JSON.stringify(full);writeFileSync(plan,bytes);
  for(const [label,ids,ordinaryIds,nativeIds]of [
   ['ordinary',[ordinary.unit.id],[ordinary.unit.id],[]],
   ['native',[native.unit.id],[],[native.unit.id]],
   ['mixed',units.map(u=>u.id),[ordinary.unit.id],[native.unit.id]],
   ['complete',null,[ordinary.unit.id],[native.unit.id]],
  ]){
   const selection=join(dir,label+'-selection.json'),output=join(dir,label+'-output');writeFileSync(output,'');
   writeFileSync(event,JSON.stringify({inputs:{commission_singleton_units:ids?JSON.stringify(ids):''}}));
   const child=spawnSync(process.execPath,[fileURLToPath(new URL('./singleton-commissioning.mjs',import.meta.url)),'matrix',plan,selection],
    {encoding:'utf8',timeout:5000,env:{...process.env,GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output}});
   assert.equal(child.status,0,child.stderr);assert.equal(readFileSync(plan,'utf8'),bytes);
   assert.equal(readFileSync(output,'utf8'),'test_matrix='+JSON.stringify({include:ordinaryIds.map(id=>employeeLifecycleMatrixRow(full.units.find(u=>u.id===id)))})+'\n'+'native_matrix='+JSON.stringify({unit:nativeIds})+'\n'+'has_tests='+String(ordinaryIds.length>0)+'\n'+'has_native='+String(nativeIds.length>0)+'\n');
   if(ids)assert.deepEqual(JSON.parse(readFileSync(selection,'utf8')),selectCommissioning(full,ids));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('native hybrid commissioning consumes one canonical build while ordinary units remain independent',()=>{
 const w=readFileSync(new URL('../workflows/alpha-staging.yml',import.meta.url),'utf8');
 const section=name=>w.slice(w.indexOf('  '+name+':\n'),w.indexOf('\n  ',w.indexOf('  '+name+':\n')+3));
 const native=w.slice(w.indexOf('  native-test:\n'),w.indexOf('  browser:\n'));
 const ordinary=w.slice(w.indexOf('  test:\n'),w.indexOf('  native-test:\n'));
 assert(native.includes('needs: [resolve, plan, build]'));assert(native.includes('needs.plan.outputs.native_matrix'));
 assert(native.includes("GH_TOKEN: '${{ github.token }}'"));
 // Chromium moved behind the protected pre-package owner. Prove that complete
 // source wiring rather than requiring a stale direct workflow shell command.
 assert(native.includes("native_controller: 'true'"));
 assert(native.includes('automation/.github/ci/native-controller-owner.mjs\" run-unit'));
 const setup=readFileSync(new URL('../actions/setup-alpha/action.yml',import.meta.url),'utf8');
 const bootstrapAt=setup.indexOf('name: Protect native CI owner before package invocations');
 const setupAt=setup.indexOf('name: Install native dependencies through the protected owner');
 assert(bootstrapAt>=0&&setupAt>bootstrapAt);
 const protectedSetup=setup.slice(setupAt,setup.indexOf('name: Install native SDK dependencies',setupAt));
 assert(protectedSetup.includes("inputs.native_controller == 'true'"));
 assert(protectedSetup.includes('automation/.github/ci/native-controller-owner.mjs\" setup'));
 const launcher=readFileSync(new URL('./native-controller-owner.mjs',import.meta.url),'utf8');
 const setupBranch=launcher.slice(launcher.indexOf("if(operation==='setup')"),launcher.indexOf("if(operation==='ensure-main')"));
 assert(setupBranch.includes("execFileSync('pnpm',['install','--frozen-lockfile'],{env:child"));
 assert(setupBranch.includes("execFileSync('pnpm',['exec','playwright','install','--with-deps','chromium'],{env:child"));
 assert(native.includes('fail-fast: false'));assert(native.includes('timeout-minutes: 120'));assert(!native.includes('AIHR_FOCUSED'));
 assert(ordinary.includes('needs: [resolve, plan]'));assert(!ordinary.includes('needs: [resolve, plan, build]'));
 assert(w.includes("needs.plan.outputs.has_native == 'true'"));assert(w.includes('test, native-test, browser]'));
 const owner=readFileSync(new URL('./run-unit.mjs',import.meta.url),'utf8');
 assert(owner.includes('await provisionNativeNextBuild(plan,unit,dir,process.env,installation)'));
 const captureAt=owner.indexOf('const installation=captureNativeNextInstallation();');
 const classifyAt=owner.indexOf('plan = createPlan()');
 assert(captureAt>=0&&classifyAt>captureAt,'Retained installation capture must precede candidate classification');
 assert(owner.includes('delete env.GH_TOKEN;delete env.GITHUB_TOKEN'));
 assert(owner.includes("nativeNextUnit(unit)?'native-test':'test'"));
});
