import test from 'node:test';
import {mkdtempSync as modelMkdtemp,mkdirSync as modelMkdir,readdirSync as modelReaddir,writeFileSync as modelWrite,rmSync as modelRemove} from 'node:fs';
import {tmpdir as modelTmpdir} from 'node:os';

import {realpathSync,readFileSync as readModelSource} from 'node:fs';
import {fileURLToPath as modelFileURLToPath} from 'node:url';
import {createHash as modelCreateHash} from 'node:crypto';
import {buildUnits as buildDatabaseModelUnits} from './manifest.mjs';
import {singletonSources} from './singleton-protocol.mjs';
import {join as modelJoin} from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CI_POLICY,REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH,validateRun,validateJobs,validateArtifacts,verifyArtifactBytes,validateProof,digest} from './release-policy.mjs';
import {verifyReports} from './verify-shards.mjs';
import {hash} from './plan.mjs';
import {buildUnits,requiredEvidence,CI_EXECUTION} from './manifest.mjs';
import {assessHealth} from './host-health.mjs';
import {bindStaging,STAGING} from './operator-release.mjs';


function differentDatabaseRoot(){
 const root=realpathSync(modelMkdtemp(modelJoin(modelTmpdir(),'shared-prerequisite-other-source-'))),journal='db/migrations/meta/_journal.json';
 modelMkdir(modelJoin(root,'db/migrations/meta'),{recursive:true});
 for(const file of modelReaddir(modelJoin(modelRoot,'db/migrations')).filter(file=>file.endsWith('.sql')))modelWrite(modelJoin(root,'db/migrations',file),'-- fictional source input\n');
 const data=JSON.parse(readModelSource(modelJoin(modelRoot,journal),'utf8'));
 data.entries.push({...data.entries.at(-1),idx:data.entries.length,tag:'9999_distinct_current_model'});
 modelWrite(modelJoin(root,journal),JSON.stringify(data));modelWrite(modelJoin(root,'db/migrations/9999_distinct_current_model.sql'),'-- fictional new source input\n');return root;
}
// Source-data model only: actual hosted/source authentication belongs to the real adapters.
const modelRoot=realpathSync(modelFileURLToPath(new URL('../../',import.meta.url)));
function databaseModel(f,root=modelRoot){
 const plan=f.expectedPlan,old=plan.units.find(unit=>unit.kind==='db'),oldId=old.id,file='test/notification-worker-lifecycle.test.ts';
 const browser=plan.units.find(unit=>unit.kind==='browser');assert(browser,'Existing model browser inventory required');
 const unit=buildDatabaseModelUnits([file],{db:[file],nodb:[]},browser.files)[0],report=f.reports.find(report=>report.id===oldId),runId=f.expected.runId??100;
 f.expected.runId=runId;plan.suite=[...plan.suite.filter(path=>!old.files.includes(path)),file].sort();plan.units=plan.units.map(row=>row.id===oldId?unit:row);
 const journal='db/migrations/meta/_journal.json',journalHash=modelCreateHash('sha256').update(readModelSource(modelJoin(root,journal))).digest('hex');
 plan.singletonSources={[unit.id]:Object.fromEntries(singletonSources(unit,root).map(path=>[path,path===journal?journalHash:'c'.repeat(64)]))};
 const {fingerprint,...body}=plan;plan.fingerprint=modelCreateHash('sha256').update(JSON.stringify(body)).digest('hex');
 report.id=unit.id;report.files=unit.files;report.batches[0].result.testResults=[{name:report.cwd+'/'+file,status:'passed',assertionResults:[{status:'passed'}]}];
 report.batches[0].result.numTotalTests=1;report.batches[0].result.numPassedTests=1;
 const resource=report.databaseTerminalEvidence;resource.name=`aihr-ci-${runId}-1-${unit.id}`;report.batches[0].databaseEvidence=structuredClone(resource);
 report.singleton={schemaVersion:1,mode:'full-ci-singleton',candidate:plan.sha,controller:plan.controller,runId:String(runId),attempt:'1',unit:unit.id,fingerprint:plan.fingerprint,file,profile:unit.singleton.profile,sourceHashes:plan.singletonSources[unit.id],evidenceDirectory:'/tmp/model/aihr-ci',prerequisites:{kind:'fresh-job-postgres-cluster',workers:1,database:structuredClone(resource)}};
 for(const row of f.reports)row.fingerprint=plan.fingerprint;
 if(f.jobs)f.jobs.find(job=>job.name===`test (${oldId})`).name=`test (${unit.id})`;
 return f;
}
const candidate='a'.repeat(40),controller='c'.repeat(40),baseline='b'.repeat(40),runId=123,now=Date.now();
const expected={candidate,controller,baseline,runId,now};
function run(){return {id:runId,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},head_repository:{id:REPOSITORY_ID},workflow_id:WORKFLOW_ID,path:WORKFLOW_PATH,event:'workflow_dispatch',head_branch:'main',head_sha:controller,status:'completed',conclusion:'success',run_attempt:1,created_at:new Date(now).toISOString()};}
function jobs(){return requiredEvidence(proof().expectedPlan).jobs.map(name=>({name,status:'completed',conclusion:'success',run_attempt:1}));}
function artifacts(){return requiredEvidence(proof().expectedPlan).artifacts.map((name,n)=>({id:n+1,name,size_in_bytes:2,digest:digest(Buffer.from('{}')),expired:false,workflow_run:{id:runId,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:controller,head_branch:'main'}}));}
function databaseEvidence(){return {schemaVersion:2,profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,errors:{},memoryLimit:2113929216,memorySwap:2113929216,memoryMax:2113929216,memorySwapMax:0,memoryPeak:500000000,memoryEvents:{oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'}};}
function proof(){
 const suite=Array.from({length:8},(_,n)=>`test/example-${n}.test.ts`);
 const units=buildUnits(suite,{nodb:suite.slice(0,4),db:suite.slice(4)},['test/layout.browser.test.tsx']);
 const body={schemaVersion:2,policyVersion:CI_POLICY,sha:candidate,controller,migrationBase:baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite,units};
 const plan={...body,fingerprint:hash(body)};
 const reports=units.map(u=>({schemaVersion:1,sha:candidate,fingerprint:plan.fingerprint,id:u.id,cwd:'/candidate',files:u.files,exitCode:0,...(u.kind==='db'?{databaseTerminalEvidence:databaseEvidence()}:{}),batches:[{exitCode:0,...(u.kind==='db'?{databaseEvidence:databaseEvidence()}:{}),result:{success:true,numFailedTests:0,numFailedTestSuites:0,numTotalTests:u.files.length,numPassedTests:u.files.length,testResults:u.files.map(file=>({name:'/candidate/'+file,status:'passed',assertionResults:[{status:'passed'}]}))}}]}));
 return {plan,reports,receipt:verifyReports(plan,reports),expectedPlan:structuredClone(plan),p:expected};
}
test('A complete same-policy witness validates without creating any local full receipt',()=>{assert.equal(validateRun(run(),expected),true);assert.equal(validateJobs(jobs(),proof().expectedPlan),true);assert.equal(validateArtifacts(artifacts(),expected,proof().expectedPlan),true);const v=validateProof(proof());assert.equal(v.tier,'ci');assert.equal(v.tests,11);assert.equal(v.suiteFiles,8);
 const p=proof();databaseModel({expectedPlan:p.plan,reports:p.reports,expected:p.p});p.expectedPlan=structuredClone(p.plan);p.receipt=verifyReports(p.plan,p.reports,{runId,attempt:1},modelRoot);
 assert.equal(validateProof(p,modelRoot).tests,p.receipt.tests);assert.throws(()=>validateProof(p));assert.throws(()=>validateProof({...p,candidateRoot:modelRoot}));
 const other=differentDatabaseRoot();try{assert.throws(()=>validateProof(p,other),/Canonical journal bytes differ|deep/);}finally{modelRemove(other,{recursive:true,force:true});}
});
for(const [name,change] of [
 ['wrong controller',r=>r.head_sha=candidate],['wrong workflow',r=>r.workflow_id=99],['fork',r=>r.head_repository.id=99],['wrong repository',r=>r.repository.id=99],['PR event',r=>r.event='pull_request'],['other controller branch',r=>r.head_branch='feature'],['partial rerun',r=>r.run_attempt=2],['unfinished run',r=>r.status='in_progress'],['failed run',r=>r.conclusion='failure'],['old run',r=>r.created_at='2020-01-01T00:00:00Z']
])test('Refuse '+name,()=>{const r=run();change(r);assert.throws(()=>validateRun(r,expected));});
test('Missing, skipped, duplicate, rerun and unknown jobs refuse',()=>{for(const mutate of [j=>j.pop(),j=>j[0].conclusion='skipped',j=>j.push(j[0]),j=>j[0].run_attempt=2,j=>j.push({name:'unknown'})]){const j=jobs();mutate(j);assert.throws(()=>validateJobs(j,proof().expectedPlan));}});
test('Missing, expired, duplicate and foreign artifacts refuse',()=>{for(const mutate of [a=>a.pop(),a=>a[0].expired=true,a=>a[1].name=a[0].name,a=>a[0].workflow_run.id=99,a=>a[0].digest=null]){const a=artifacts();mutate(a);assert.throws(()=>validateArtifacts(a,expected,proof().expectedPlan));}});
test('Archive digest is checked before extraction',()=>{const a=artifacts()[0];assert.equal(verifyArtifactBytes(a,Buffer.from('{}')),true);assert.throws(()=>verifyArtifactBytes(a,Buffer.from('{"tampered":true}')));});
for(const [name,change] of [
 ['missing worker',p=>p.reports.pop()],['old policy',p=>p.plan.policyVersion='unknown'],['wrong migration baseline',p=>p.plan.migrationBase=candidate],['changed classification',p=>p.plan.suite.pop()],['foreign result',p=>p.reports[0].sha=baseline],['false receipt totals',p=>p.receipt.tests++],['skipped assertion',p=>p.reports[0].batches[0].result.testResults[0].assertionResults[0].status='pending'],['non-Linux environment',p=>p.plan.runtime.platform='darwin']
])test('Refuse evidence with '+name,()=>{const p=proof();change(p);assert.throws(()=>validateProof(p));});
test('Report arrival order does not change verified receipt',()=>{const p=proof();p.reports.reverse();assert.equal(validateProof(p).tests,11);});
test('Measured insufficient space refuses; sufficient post-cleanup space admits; unknown space refuses',()=>{assert.equal(assessHealth({platform:'linux',availableDiskBytes:11491446784}).ok,false);assert.equal(assessHealth({platform:'linux',availableDiskBytes:32*1024**3}).ok,true);assert.equal(assessHealth({platform:'linux',availableDiskBytes:null}).ok,false);});
test('SDK cleanup and swap helper refuse outside disposable GitHub runner',()=>{for(const name of ['prepare-runner.sh','typecheck.sh']){const file=fileURLToPath(new URL(name,import.meta.url));const r=spawnSync('bash',[file],{env:{...process.env,GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'github-hosted'}});assert.equal(r.status,2);}});
test('Operator target is staging only and rejects a different host',()=>{const env={};bindStaging(env);assert.equal(env.IMPROVE_SSH_HOST,STAGING.host);assert.throws(()=>bindStaging({IMPROVE_SSH_HOST:'new-live.example.com'}));});
test('Artifact extraction rejects path traversal and non-JSON content',()=>{for(const name of ['../escape.json','payload.sh']){const dir=mkdtempSync(join(tmpdir(),'aihr-ci-zip-'));try{const archive=join(dir,'input.zip');const create=spawnSync('python3',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],"{}"); z.close()',archive,name]);assert.equal(create.status,0);const r=spawnSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),archive,join(dir,'out')]);assert.notEqual(r.status,0);}finally{rmSync(dir,{recursive:true,force:true});}}});

test('Normal alpha push can bind candidate and controller to the same exact commit; main push cannot',()=>{const r=run();r.event='push';r.head_branch='alpha';r.head_sha=candidate;assert.equal(validateRun(r,{...expected,controller:candidate}),true);r.head_branch='main';assert.throws(()=>validateRun(r,{...expected,controller:candidate}));});

test('Artifact extraction accepts a bounded ordinary JSON report',()=>{const dir=mkdtempSync(join(tmpdir(),'aihr-ci-zip-ok-'));try{const archive=join(dir,'input.zip');assert.equal(spawnSync('python3',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("unit-db-1.json","{}"); z.close()',archive]).status,0);const out=join(dir,'out');const r=spawnSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),archive,out]);assert.equal(r.status,0,r.stderr?.toString());assert.deepEqual(JSON.parse(readFileSync(join(out,'unit-db-1.json'),'utf8')),{});}finally{rmSync(dir,{recursive:true,force:true});}});

test('A self-consistent reduced manifest cannot authorize omission from independently reconstructed coverage',()=>{
 const p=proof();p.plan.units=p.plan.units.filter(u=>u.kind!=='db');p.plan.suite=p.plan.units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort();
 const {fingerprint:old,...body}=p.plan;p.plan.fingerprint=hash(body);
 p.reports=p.reports.filter(r=>p.plan.units.some(u=>u.id===r.id)).map(r=>({...r,fingerprint:p.plan.fingerprint}));
 p.receipt=verifyReports(p.plan,p.reports);
 assert.throws(()=>validateProof(p));
 assert.throws(()=>validateJobs(jobs().filter(j=>!j.name.startsWith('test (db-')),p.expectedPlan));
 assert.throws(()=>validateArtifacts(artifacts().filter(a=>!a.name.startsWith('unit-db-')),expected,p.expectedPlan));
});
test('A v1 witness cannot be relabelled as v2 by topology or receipt edits',()=>{const p=proof();p.plan.policyVersion='aihr-staging-ci/v1';assert.throws(()=>validateProof(p));});

test('v21 refuses a coherently rehashed v20 plan and a retained v20 receipt',()=>{
 assert.equal(CI_POLICY,'aihr-staging-ci/v21');
 const current=proof();assert.equal(validateProof(current).policyVersion,CI_POLICY);
 const legacy=proof();legacy.plan.policyVersion='aihr-staging-ci/v20';
 const {fingerprint:old,...body}=legacy.plan;legacy.plan.fingerprint=hash(body);
 legacy.reports=legacy.reports.map(report=>({...report,fingerprint:legacy.plan.fingerprint}));
 legacy.receipt=verifyReports(legacy.plan,legacy.reports);
 legacy.expectedPlan=structuredClone(legacy.plan);
 assert.equal(legacy.receipt.policyVersion,'aihr-staging-ci/v20');
 assert.throws(()=>validateProof(legacy),/plan policy/);
 const mixed=proof();mixed.receipt.policyVersion='aihr-staging-ci/v20';
 assert.throws(()=>validateProof(mixed),/receipt differs/);
 // Changing the plan version and recomputing its digest cannot authenticate
 // the old reports/receipt under the current independently reconstructed plan.
 legacy.plan.policyVersion=CI_POLICY;
 const {fingerprint:legacyFingerprint,...relabelled}=legacy.plan;
 legacy.plan.fingerprint=hash(relabelled);legacy.expectedPlan=structuredClone(legacy.plan);
 assert.throws(()=>validateProof(legacy));
});

for(const [name,change] of [
 ['missing terminal',r=>{delete r.databaseTerminalEvidence;}],
 ['null terminal',r=>{r.databaseTerminalEvidence=null;}],
 ['unhealthy terminal',r=>{r.databaseTerminalEvidence.state.Running=false;}],
 ['terminal OOM',r=>{r.databaseTerminalEvidence.memoryEvents.oom_kill=1;}],
 ['terminal settings mismatch',r=>{r.databaseTerminalEvidence.settings.jit='off';}],
 ['terminal missing cgroup peak',r=>{r.databaseTerminalEvidence.memoryPeak=null;}],
])test('Independent release verification refuses '+name+' even with passing batch evidence',()=>{
 const p=proof(),r=p.reports.find(r=>r.id.startsWith('db-'));change(r);
 assert.throws(()=>verifyReports(p.plan,p.reports));assert.throws(()=>validateProof(p));
});

test('v3 authenticates one supplemental compiler graph artifact without replacing required test evidence',()=>{
 const p=proof().expectedPlan,a=artifacts(),aux={...a[0],id:9999,name:'whole-compiler-state-v1'};
 assert.equal(validateArtifacts([...a,aux],expected,p),true);
 assert.throws(()=>validateArtifacts([...a.slice(1),aux],expected,p));
 assert.throws(()=>validateArtifacts([...a,{...aux,name:'arbitrary-cache'}],expected,p));
 assert.throws(()=>validateArtifacts([...a,aux,{...aux,id:9998}],expected,p));
 assert.throws(()=>validateArtifacts([...a,{...aux,workflow_run:{...aux.workflow_run,head_sha:'d'.repeat(40)}}],expected,p));
});

for(const branch of ['main','alpha'])test('Successful '+branch+' commissioning API run cannot authorize release',()=>{
 const r={...run(),head_branch:branch,display_title:'Singleton commissioning only · frozen-source'};
 assert.throws(()=>validateRun(r,expected),/commissioning is incomplete/);
 const incomplete=jobs().map(j=>['typecheck','migrations','controller-tests','build','verify'].includes(j.name)?{...j,conclusion:'skipped'}:j);
 assert.throws(()=>validateJobs(incomplete,proof().expectedPlan));
 const selected=artifacts().map(a=>({...a,name:a.name.startsWith('unit-')?'commission-'+a.name:a.name==='gate-plan'?'commission-plan':a.name}));
 assert.throws(()=>validateArtifacts(selected,expected,proof().expectedPlan));
});
test('Only a skipped commissioning summary is compatible with a complete ordinary release witness',()=>{
 const plan=proof().expectedPlan,skipped={name:'commission-summary',status:'completed',conclusion:'skipped',run_attempt:1};
 assert.equal(validateJobs([...jobs(),skipped],plan),true);
 assert.throws(()=>validateJobs([...jobs(),{...skipped,conclusion:'success'}],plan));
});
