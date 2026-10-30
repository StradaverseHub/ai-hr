import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {hash,buildUnits} from './manifest.mjs';
import {verifyRepairRecovery,repairDisposition,validateRepairFocusedMetadata,validateRepairBuildMetadata,validateRepairGrantEvidence} from './repair-recovery-policy.mjs';
import {createInstallGrant} from './ci-install-grant.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {validateRepairDelta,validateRepairArchiveInventory} from './repair-recovery.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
function input(){
 const f=fixture(),sourcePlan=f.expectedPlan,unit=sourcePlan.units.find(u=>u.kind==='nodb');
 for(const r of f.reports)for(const b of r.batches)for(const file of b.result.testResults)for(const a of file.assertionResults)a.fullName='unchanged behavioral case '+file.name;
 const failed=f.reports.find(r=>r.id===unit.id);failed.exitCode=1;failed.batches[0].exitCode=1;failed.batches[0].result.success=false;
 const assessment={...assessResumeCoverage({expectedPlan:sourcePlan,reports:f.reports,expected:f.expected}),sourceRun:{id:f.run.id},observations:[{id:unit.id,conclusion:'failure'},{name:'typecheck',conclusion:'failure'},{name:'build',conclusion:'failure'}]};
 for(const r of assessment.reusable)r.source={runId:f.run.id,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const candidate='d'.repeat(40),verificationController='e'.repeat(40),body={...sourcePlan,sha:candidate};delete body.fingerprint;const plan={...body,fingerprint:hash(body)};
 const impactBody={policyVersion:3,tier:'impact',risk:'moderate',changed:['core/lifecycle/service.ts'],classifications:[{path:'core/lifecycle/service.ts',risk:'moderate',uncertainties:[]}],reasons:[],run:unit.files,selection:Object.fromEntries(unit.files.map(p=>[p,['transitive consumer']])),browser:false};
 const baseTree='1'.repeat(40),headTree='2'.repeat(40),impactContext={base:sourcePlan.sha,head:candidate,controller:verificationController,baseTree,headTree,snapshotSource:'IMMUTABLE_GIT_OBJECTS',sourceInputsFingerprint:hash({baseTree,headTree,controller:verificationController,impactPolicy:3}),plan:{...impactBody,fingerprint:hash(impactBody)}};
 const run={...f.run,id:200,workflow_id:999,path:'.github/workflows/alpha-focused-checks.yml',conclusion:'success',created_at:time(4),updated_at:time(1)};
 const names=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
 const jobs=names.map((name,i)=>({id:300+i,name,run_id:run.id,run_attempt:1,head_sha:run.head_sha,head_branch:run.head_branch,status:'completed',conclusion:i<3?'success':'skipped',started_at:time(3),completed_at:time(2)}));
 const artifact={id:400,name:'focused-development-evidence',size_in_bytes:100,digest:'sha256:'+'b'.repeat(64),expired:false,created_at:time(2.5),expires_at:time(-60),workflow_run:{id:run.id,repository_id:1333414856,head_repository_id:1333414856,head_sha:run.head_sha,head_branch:run.head_branch}};
 const report={kind:'FOCUSED_ONLY',releaseEligible:false,schemaVersion:1,sha:candidate,controller:plan.controller,runId:String(run.id),attempt:'1',runtime:plan.runtime,files:unit.files,groups:{NODB:unit.files,DB:[]},manifestHash:hash(JSON.stringify(unit.files)),classifierHash:'classifier',startedAt:time(2.9),endedAt:time(2.1),exitCode:0,healthBefore:{ok:true},healthAfter:{ok:true},batches:[{kind:'NODB',files:unit.files,exitCode:0,processExitCode:0,signal:null,assertions:1}]};
 const result=structuredClone(failed.batches[0].result);result.success=true;result.testResults[0].name='/home/runner/work/ai-hr/ai-hr/source/'+unit.files[0];
 const buildRun={...f.run,id:500,conclusion:'success',created_at:time(4),updated_at:time(1),display_title:'Canonical build only · repair'};
 const buildJobs=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'].map((name,i)=>({id:600+i,name,run_id:500,head_sha:buildRun.head_sha,head_branch:buildRun.head_branch,run_attempt:1,status:'completed',conclusion:['resolve','build','deployment-hold'].includes(name)?'success':'skipped',started_at:time(3),completed_at:time(2)}));
 return {sourcePlan,plan,assessment,sourceRun:f.run,reports:f.reports,focused:[{run,jobs,artifact,producer:jobs[1],compiler:{runId:200,jobId:302,controller:run.head_sha},report,result}],impactContext,classifierHash:'classifier',verificationController,verificationDiagnostic:{controller:verificationController,runId:900},reviewedController:verificationController,buildRun,buildJobs,build:{canonicalCandidateInputsVerified:true,source:candidate,controller:plan.controller,runId:500},history:{kind:'AUTHENTICATED_COMPLETE_REPAIR_HISTORY',sourceRunId:f.run.id,runIds:[200,500]}};
}
test('v2 preserves failed source and retained report identities while replacing compiler/build and whole failed process',()=>{
 const f=input(),original=structuredClone(f.reports),c=verifyRepairRecovery(f);assert.deepEqual(f.reports,original);assert.equal(c.originalConclusion,'failure');assert.equal(c.originalSha,f.sourcePlan.sha);assert.equal(c.sha,f.plan.sha);assert.equal(c.runId,500);assert.equal(c.tests,5);assert.equal(c.units.filter(u=>u.kind==='retained').length,4);assert.equal(c.units.find(u=>u.kind==='retained').originalSha,f.sourcePlan.sha);
});
for(const [name,change] of [
 ['unfinished original',f=>f.sourceRun.status='in_progress'],['source run relabelled',f=>f.sourceRun.conclusion='success'],['old assessment',f=>f.assessment.sha='f'.repeat(40)],
 ['runtime drift',f=>f.plan.runtime={...f.plan.runtime,node:'24.0.0'}],['execution drift',f=>f.plan.execution={workers:4}],['unit drift',f=>f.plan.units=f.plan.units.slice(1)],['baseline drift',f=>f.plan.migrationBase='f'.repeat(40)],
 ['unbound Git trees',f=>f.impactContext.baseTree='3'.repeat(40)],['wrong verifier',f=>f.impactContext.controller='f'.repeat(40)],['forged impact',f=>f.impactContext.plan.run=[]],
 ['full impact cannot reuse browser/DB',f=>{const p=f.impactContext.plan;p.tier='full';const {fingerprint,...b}=p;p.fingerprint=hash(b);}],
 ['omitted affected unit',f=>{const p=f.impactContext.plan;p.run=[...p.run,'test/db.test.ts'];p.selection['test/db.test.ts']=['dependency'];const {fingerprint,...b}=p;p.fingerprint=hash(b);}],
 ['source reports omitted',f=>f.reports.pop()],['retained report tampered',f=>f.reports.find(r=>r.exitCode===0).cwd='/changed'],['relabelled retained report',f=>f.reports.find(r=>r.exitCode===0).sha=f.plan.sha],
 ['no compiler',f=>f.focused[0].compiler=null],['no focused',f=>f.focused=[]],['repeated focused',f=>f.focused.push(structuredClone(f.focused[0]))],['wrong fresh source',f=>f.focused[0].report.sha=f.sourcePlan.sha],
 ['wrong classifier',f=>f.focused[0].report.classifierHash='wrong'],['failed process',f=>f.focused[0].report.batches[0].processExitCode=1],['signalled process',f=>f.focused[0].report.batches[0].signal='SIGKILL'],['bad summary',f=>f.focused[0].report.batches[0].assertions++],
 ['dropped assertion',f=>f.focused[0].result.testResults[0].assertionResults=[]],['changed assertion',f=>f.focused[0].result.testResults[0].assertionResults[0].fullName='different'],['pending assertion',f=>f.focused[0].result.numPendingTests=1],
 ['empty original enumeration',f=>f.reports.find(r=>r.exitCode===1).batches[0].result.testResults=[]],['diagnostic substituted for build',f=>f.build={releaseAuthorized:false,kind:'CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE'}],['old-source build',f=>f.build.source=f.sourcePlan.sha],
 ['foreign build run',f=>f.build.runId=100],['unvalidated verifier',f=>delete f.verificationDiagnostic.runId],['missing latest history',f=>f.history=null],
])test('v2 refuses '+name,()=>{const f=input();change(f);assert.throws(()=>verifyRepairRecovery(f));});
function focusedMetadata(){const f=input(),p=f.focused[0];return {run:p.run,jobs:p.jobs,artifacts:[p.artifact],expected:{runId:200,controller:f.plan.controller,workflowId:999,after:time(5)},now};}
test('Fresh whole compiler is authenticated at its real focused producing job',()=>assert.equal(validateRepairFocusedMetadata(focusedMetadata()).compiler.jobId,302));
function dbInput(){
 const f=input(),unit=f.plan.units.find(u=>u.kind==='db'),original=f.reports.find(r=>r.id===unit.id),p=structuredClone(f.focused[0]);
 const impact=f.impactContext.plan;impact.run=[...impact.run,...unit.files].sort();impact.selection[unit.files[0]]=['transitive DB consumer'];const {fingerprint,...body}=impact;impact.fingerprint=hash(body);
 p.run.id=201;p.producer.run_id=201;p.report.runId='201';p.report.files=unit.files.slice().sort();p.report.manifestHash=hash(JSON.stringify(p.report.files));p.report.groups={NODB:[],DB:p.report.files};p.report.batches[0]={...p.report.batches[0],kind:'DB',files:p.report.files,startedAt:time(2.9)};
 p.report.databaseTerminalEvidence={...structuredClone(original.databaseTerminalEvidence),name:'aihr-ci-201-1-db-1',capturedAt:time(2.2)};
 p.result=structuredClone(original.batches[0].result);p.result.testResults[0].name='/home/runner/work/ai-hr/ai-hr/source/'+unit.files[0];p.compiler=null;
 f.focused.push(p);f.history.runIds.push(201);return f;
}
test('A changed DB consumer receives a complete fresh owned PG16 unit, with original resources and assertions',()=>{const c=verifyRepairRecovery(dbInput());assert.equal(c.units.filter(u=>u.kind==='repaired-source').length,2);assert.equal(c.tests,5);});
for(const [name,change] of [
 ['wrong database owner',f=>f.focused[1].report.databaseTerminalEvidence.name='foreign'],['database OOM',f=>f.focused[1].report.databaseTerminalEvidence.memoryEvents.oom_kill=1],['database budget drift',f=>f.focused[1].report.databaseTerminalEvidence.memoryMax=1073741824],['JIT drift',f=>f.focused[1].report.databaseTerminalEvidence.settings.jit='off'],['PG patch drift',f=>f.focused[1].report.databaseTerminalEvidence.settings.serverVersionNum='160099'],['DB capture before execution',f=>f.focused[1].report.databaseTerminalEvidence.capturedAt=time(10)],['mixed DB selection',f=>f.focused[1].report.groups.NODB=['test/plain.test.ts']],['wrong DB classifier',f=>f.focused[1].report.groups={DB:[],NODB:f.focused[1].report.files}],['missing DB resource evidence',f=>delete f.focused[1].report.databaseTerminalEvidence],
])test('DB repair refuses '+name,()=>{const f=dbInput();change(f);assert.throws(()=>verifyRepairRecovery(f));});
for(const [name,change] of [['compiler failure',f=>f.jobs[2].conclusion='failure'],['foreign compiler controller',f=>f.jobs[2].head_sha='f'.repeat(40)],['focused build is not canonical replacement',f=>f.jobs[3].conclusion='success'],['rerun',f=>f.run.run_attempt=2],['extra artifact',f=>f.artifacts.push({...f.artifacts[0],name:'production-build-v1'})],['early artifact',f=>f.artifacts[0].created_at=time(10)],['missing job',f=>f.jobs.pop()],['expired',f=>f.artifacts[0].expired=true]])test('Fresh metadata refuses '+name,()=>{const f=focusedMetadata();change(f);assert.throws(()=>validateRepairFocusedMetadata(f));});
function buildMetadata(){const f=input();return {run:f.buildRun,jobs:f.buildJobs,expected:{runId:500,controller:f.plan.controller,after:time(5),candidateBranch:'repair',now}};}
test('Only actual canonical build-only workflow is admitted',()=>assert.equal(validateRepairBuildMetadata(buildMetadata()).name,'build'));
for(const [name,change] of [['diagnostic run',f=>f.run.display_title='Runner diagnostics · repair'],['focused workflow',f=>f.run.path='.github/workflows/alpha-focused-checks.yml'],['old build',f=>f.run.created_at=time(10)],['build failure',f=>f.jobs.find(j=>j.name==='build').conclusion='failure'],['extra test execution',f=>f.jobs.find(j=>j.name==='test').conclusion='success']])test('Build metadata refuses '+name,()=>{const f=buildMetadata();change(f);assert.throws(()=>validateRepairBuildMetadata(f));});
test('v2 grant binds fresh canonical producer while retaining original failed run in certificate',()=>{
 const f=input(),c=verifyRepairRecovery(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,...f.build}};
 const run={...g.run,id:c.runId,head_sha:c.controller},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.equal(validateRepairGrantEvidence(e,run),true);const grant=createInstallGrant({...g,evidence:e,run,producer});assert.equal(grant.source,c.sha);assert.equal(grant.runId,500);assert.equal(grant.witnessFingerprint,hash(c));assert.equal(c.originalRunId,100);
 for(const change of [x=>x.recovery.originalConclusion='success',x=>x.recovery.tests++,x=>x.verificationController='a'.repeat(40),x=>delete x.recovery.compilers]){const bad=structuredClone(e);change(bad);assert.throws(()=>validateRepairGrantEvidence(bad,run));}
});
test('Successful read-only composition under hosted diagnostics is visibly noninstallable until exact review',()=>{
 const f=input();f.reviewedController=null;const c=verifyRepairRecovery(f);assert.equal(c.pendingReview,true);assert.equal(c.reviewedController,null);assert.equal(c.releaseAuthorized,false);
 const g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,...f.build}},run={...g.run,id:c.runId,head_sha:c.controller},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 // Even a forged outer PASS cannot turn the diagnostic certificate into a grant.
 assert.throws(()=>createInstallGrant({...g,evidence:e,run,producer}),/Pending-review/);
 const changed=structuredClone(f);changed.reviewedController='f'.repeat(40);assert.throws(()=>verifyRepairRecovery(changed),/Reviewed verifier/);
});
test('Repair delta independently rejects tests, SQL, workflow, lock, security-owner and added files',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-repair-delta-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Controller fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Controller fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
 const paths=['core/lifecycle/service.ts','test/guard.test.ts','db/migrations/0001.sql','.github/workflows/alpha-staging.yml','pnpm-lock.yaml','lib/permissions.ts'];
 const write=(path,text)=>{const p=join(root,path);mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,text);};
 try{
  git('init','-q');for(const p of paths)write(p,'original\n');git('add','.');git('commit','-qm','immutable base');const base=git('rev-parse','HEAD');
  for(const path of paths){write(path,'repaired\n');git('add',path);git('commit','-qm','repair '+path);const head=git('rev-parse','HEAD');
   if(path===paths[0])assert.deepEqual(validateRepairDelta({cwd:root,original:base,candidate:head}).changed,[path]);
   else assert.throws(()=>validateRepairDelta({cwd:root,original:base,candidate:head}));
  }
  const before=git('rev-parse','HEAD');write('core/new.ts','new\n');git('add','.');git('commit','-qm','new source');assert.throws(()=>validateRepairDelta({cwd:root,original:before,candidate:git('rev-parse','HEAD')}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Failure diagnostics remain their own bounded original namespace and cannot be a replacement build',()=>{
 const f=input(),run=f.sourceRun,j={name:'build',conclusion:'failure',started_at:time(19),completed_at:time(6)};
 const a={id:1,name:'next-application-build-failure',created_at:time(10),expires_at:time(-60),workflow_run:{id:run.id,repository_id:1333414856,head_repository_id:1333414856,head_sha:run.head_sha,head_branch:run.head_branch}};
 const m={run,jobs:[j],artifacts:[a]};assert.doesNotThrow(()=>validateRepairArchiveInventory(m,new Set([a.name]),()=> 'build',now));
 assert.throws(()=>validateRepairArchiveInventory(m,new Set(['production-build-v1','next-application-state-v1']),()=> 'build',now));
 for(const change of [m=>m.artifacts[0].workflow_run.id++,m=>m.artifacts[0].name='unknown',m=>m.artifacts[0].created_at=time(30),m=>m.artifacts.push(structuredClone(m.artifacts[0]))]){const bad=structuredClone(m);change(bad);assert.throws(()=>validateRepairArchiveInventory(bad,new Set([a.name]),()=> 'build',now));}
});

// Separately versioned finite fixture/browser successor; the v2 operator above remains unchanged.
import {verifyFixtureBrowserRecovery} from './fixture-browser-recovery-policy.mjs';
import {validateBrowserRepairMetadata,validateBrowserRepairImage,BROWSER_REPAIR_IMAGE} from './browser-repair-metadata.mjs';
function browserFixture(){
 const f=input(),stamp=Date.now(),at=n=>new Date(stamp-n*60000).toISOString();
 f.sourceRun.updated_at=at(8);
 const impact=f.impactContext.plan;impact.policyVersion=4;f.impactContext.sourceInputsFingerprint=hash({baseTree:f.impactContext.baseTree,headTree:f.impactContext.headTree,controller:f.verificationController,impactPolicy:4});impact.browser=true;const {fingerprint,...body}=impact;impact.fingerprint=hash(body);
 const run={...f.sourceRun,id:700,workflow_id:395862646,path:'.github/workflows/alpha-staging-browser-checks.yml',conclusion:'success',created_at:at(4),updated_at:at(1),display_title:'Tooling transport only · repair'};
 const names=['resolve','tooling','operator-transport','browser-image (chromium)','browser-image (firefox)','browser-image (webkit)'];
 const jobs=names.map((name,i)=>({id:800+i,name,run_id:700,run_attempt:1,head_sha:run.head_sha,head_branch:run.head_branch,status:'completed',conclusion:['tooling','operator-transport'].includes(name)?'skipped':'success',started_at:at(3),completed_at:at(2),steps:[{name:'Complete original browser unit in pinned image',conclusion:'success'},{name:'Native browser launch and multilingual raster with preinstalled dependencies',conclusion:'skipped'}]}));
 const artifacts=['chromium','firefox','webkit'].flatMap((engine,i)=>['diagnostic-complete-image-browser-','diagnostic-browser-image-'].map((prefix,j)=>({id:900+i*2+j,name:prefix+engine,size_in_bytes:100,digest:'sha256:'+'a'.repeat(64),expired:false,created_at:at(2.5),expires_at:at(-60),workflow_run:{id:700,repository_id:1333414856,head_repository_id:1333414856,head_sha:run.head_sha,head_branch:run.head_branch}})));
 const packets=f.plan.units.filter(u=>u.kind==='browser').map(u=>{
  const report=structuredClone(f.reports.find(r=>r.id===u.id));report.sha=f.plan.sha;report.fingerprint=f.plan.fingerprint;
  return {engine:u.engine,report,result:structuredClone(report.batches[0].result),binding:{kind:'PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS',image:BROWSER_REPAIR_IMAGE,playwrightVersion:'1.62.1',nodeVersion:f.plan.runtime.node,candidate:f.plan.sha,controller:f.plan.controller,releaseAuthorized:false},sourceText:f.plan.sha+'\n',lockText:'a'.repeat(64)+'  pnpm-lock.yaml\n'};
 });
 f.browsers=[{run,jobs,artifacts,packets,candidateBranch:'repair',lockSha256:'a'.repeat(64)}];f.history.runIds.push(700);return f;
}
test('v3 authenticates all three complete browser units and preserves original failures without installation authority',()=>{
 const f=browserFixture(),before=structuredClone(f.reports),c=verifyFixtureBrowserRecovery(f);
 assert.deepEqual(f.reports,before);assert.equal(c.tests,5);assert.equal(c.browserSources.length,3);assert.equal(c.units.filter(u=>u.kind==='repaired-source').length,4);assert.equal(c.originalConclusion,'failure');assert.equal(c.pendingReview,true);assert.equal(c.reviewedController,null);assert.equal(c.releaseAuthorized,false);assert.equal(c.recoveryPolicy,'aihr-fixture-browser-recovery/v3');
 const g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c)};assert.throws(()=>createInstallGrant({...g,evidence:e}));
});
for(const [name,change] of [
 ['missing browser execution',f=>f.browsers=[]],['duplicate browser execution',f=>f.browsers.push(structuredClone(f.browsers[0]))],['partial engine packets',f=>f.browsers[0].packets.pop()],['duplicate engine',f=>f.browsers[0].packets[2]=structuredClone(f.browsers[0].packets[0])],['original-source browser report',f=>f.browsers[0].packets[0].report.sha=f.sourcePlan.sha],['browser fingerprint drift',f=>f.browsers[0].packets[0].report.fingerprint='wrong'],['browser standalone result drift',f=>f.browsers[0].packets[0].result.success=false],['browser identity source drift',f=>f.browsers[0].packets[0].binding.candidate=f.sourcePlan.sha],['browser lock drift',f=>f.browsers[0].packets[0].lockText='wrong'],['browser runtime drift',f=>f.browsers[0].packets[0].binding.nodeVersion='24.0.0'],['browser image drift',f=>f.browsers[0].packets[0].binding.image='untrusted:latest'],['browser history omission',f=>f.history.runIds=f.history.runIds.filter(id=>id!==700)],['changed browser assertion',f=>{f.browsers[0].packets[0].result.testResults[0].assertionResults[0].fullName='changed';f.browsers[0].packets[0].report.batches[0].result=structuredClone(f.browsers[0].packets[0].result);}]
])test('v3 refuses '+name,()=>{const f=browserFixture();change(f);assert.throws(()=>verifyFixtureBrowserRecovery(f));});
function browserMetadata(){const f=browserFixture(),b=f.browsers[0];return {...b,expected:{runId:700,controller:f.plan.controller,candidateBranch:'repair',after:f.sourceRun.updated_at}};}
test('Browser archive identity binds actual three engine jobs and all six digests',()=>assert.equal(validateBrowserRepairMetadata(browserMetadata()).length,3));
for(const [name,change] of [
 ['foreign workflow',f=>f.run.workflow_id++],['foreign path',f=>f.run.path='.github/workflows/alpha-focused-checks.yml'],['foreign repository',f=>f.run.repository.id++],['foreign head repository',f=>f.run.head_repository.id++],['untrusted controller',f=>f.run.head_sha='f'.repeat(40)],['unpublished branch',f=>f.run.head_branch='codex/branch'],['rerun',f=>f.run.run_attempt=2],['failed workflow',f=>f.run.conclusion='failure'],['pending workflow',f=>f.run.status='in_progress'],['old workflow',f=>f.run.created_at='2020-01-01T00:00:00Z'],['foreign candidate title',f=>f.run.display_title='Tooling transport only · foreign'],['missing engine job',f=>f.jobs.pop()],['duplicate job',f=>f.jobs[5]=structuredClone(f.jobs[4])],['tooling probe substituted',f=>f.jobs[3].steps[0].conclusion='skipped'],['native probe mode',f=>f.jobs[3].steps[1].conclusion='success'],['extra active job',f=>f.jobs[1].conclusion='success'],['foreign producer',f=>f.jobs[3].head_sha='f'.repeat(40)],['omitted archive',f=>f.artifacts.pop()],['extra archive',f=>f.artifacts.push(structuredClone(f.artifacts[0]))],['foreign archive source',f=>f.artifacts[0].workflow_run.head_sha='f'.repeat(40)],['foreign archive producer',f=>f.artifacts[0].workflow_run.id++],['missing digest',f=>delete f.artifacts[0].digest],['oversize archive',f=>f.artifacts[0].size_in_bytes=64*1024**2+1],['expired archive',f=>f.artifacts[0].expired=true],['early archive',f=>f.artifacts[0].created_at='2020-01-01T00:00:00Z']
])test('Browser metadata refuses '+name,()=>{const f=browserMetadata();change(f);assert.throws(()=>validateBrowserRepairMetadata(f));});

function auxiliaryCompilerFixture(){
 const f=browserFixture(),p=structuredClone(f.focused[0]),stamp=Date.now(),at=n=>new Date(stamp-n*60000).toISOString(),db=f.plan.units.find(u=>u.kind==='db').files;
 p.run.id=201;p.run.created_at=at(4);p.run.updated_at=at(1);
 for(const job of p.jobs){job.run_id=201;job.started_at=at(3);job.completed_at=at(2);}
 p.artifact.workflow_run.id=201;p.artifact.created_at=at(2.5);p.artifact.expires_at=at(-60);
 const r=p.report;r.runId='201';r.startedAt=at(2.9);r.endedAt=at(2.1);r.groups.DB=db;r.files=[...r.groups.NODB,...db].sort();r.manifestHash=hash(JSON.stringify(r.files));r.batches.push({...structuredClone(r.batches[0]),kind:'DB',files:db});
 f.compilerAuxiliary={run:p.run,jobs:p.jobs,artifacts:[p.artifact],report:r,workflowId:999};f.focused[0].compiler=null;f.history.runIds.push(201);return f;
}
test('Mixed successful preflight authenticates a whole compiler without supplying or duplicating test replacement coverage',()=>{
 const f=auxiliaryCompilerFixture(),c=verifyFixtureBrowserRecovery(f);assert.equal(c.tests,5);assert.equal(c.compilers.length,1);assert.equal(c.compilers[0].runId,201);assert.equal(c.compilers[0].auxiliary,true);assert(!c.focusedSources.some(s=>s.runId===201));
});
for(const [name,change] of [['old source',f=>f.compilerAuxiliary.report.sha=f.sourcePlan.sha],['failed compiler',f=>f.compilerAuxiliary.jobs.find(j=>j.name==='typecheck').conclusion='failure'],['expired archive',f=>f.compilerAuxiliary.artifacts[0].expired=true],['unaccounted compiler',f=>f.history.runIds=f.history.runIds.filter(id=>id!==201)],['duplicate source file',f=>f.compilerAuxiliary.report.groups.DB.push(f.compilerAuxiliary.report.groups.NODB[0])],['failed preflight',f=>f.compilerAuxiliary.report.batches[0].exitCode=1],['unhealthy source',f=>f.compilerAuxiliary.report.healthAfter.ok=false],['report before job',f=>f.compilerAuxiliary.report.startedAt='2020-01-01T00:00:00Z']])test('Auxiliary compiler refuses '+name,()=>{const f=auxiliaryCompilerFixture();change(f);assert.throws(()=>verifyFixtureBrowserRecovery(f));});

function partialRetentionFixture(){
 const f=browserFixture(),unit=f.plan.units.find(u=>u.kind==='db'),selected=unit.files[0],unaffected='test/db-unaffected.test.ts',original=f.reports.find(r=>r.id===unit.id);
 unit.files.push(unaffected);f.plan.suite.push(unaffected);f.plan.suite.sort();
 const result=original.batches[0].result;result.testResults.push({name:'/candidate/'+unaffected,status:'passed',assertionResults:[{status:'passed',fullName:'unchanged behavioral case /candidate/'+unaffected}]});result.numTotalTests++;result.numPassedTests++;
 const oldId=unit.id,browserFiles=f.sourcePlan.units.find(u=>u.kind==='browser').files;
 const rebuilt=buildUnits(f.sourcePlan.suite,{db:[selected,unaffected],nodb:f.sourcePlan.suite.filter(p=>![selected,unaffected].includes(p))},browserFiles),rebuiltUnit=rebuilt.find(u=>u.kind==='db');
 f.sourcePlan.units=rebuilt;f.plan.units=rebuilt;original.id=rebuiltUnit.id;original.files=rebuiltUnit.files;
 for(const witness of f.assessment.reusable)if(witness.id===oldId)witness.id=rebuiltUnit.id;

 for(const plan of [f.sourcePlan,f.plan]){const {fingerprint,...body}=plan;plan.fingerprint=hash(body);}
 for(const report of f.reports)report.fingerprint=f.sourcePlan.fingerprint;
 f.assessment.fingerprint=f.sourcePlan.fingerprint;for(const witness of f.assessment.reusable)witness.reportHash=hash(f.reports.find(r=>r.id===witness.id));
 for(const p of f.browsers[0].packets)p.report.fingerprint=f.plan.fingerprint;
 const impact=f.impactContext.plan;impact.run=[...impact.run,selected].sort();impact.selection[selected]=['affected consumer'];const {fingerprint,...body}=impact;impact.fingerprint=hash(body);
 const p=structuredClone(f.focused[0]);p.run.id=201;p.producer.run_id=201;p.report.runId='201';p.report.files=[selected];p.report.manifestHash=hash(JSON.stringify(p.report.files));p.report.groups={NODB:[],DB:[selected]};p.report.batches[0]={...p.report.batches[0],kind:'DB',files:[selected],startedAt:time(2.9)};
 p.report.databaseTerminalEvidence={...structuredClone(original.databaseTerminalEvidence),name:'aihr-ci-201-1-db-1',capturedAt:time(2.2)};
 p.result=structuredClone(original.batches[0].result);p.result.testResults=p.result.testResults.filter(x=>x.name==='/candidate/'+selected);p.result.testResults[0].name='/home/runner/work/ai-hr/ai-hr/source/'+selected;p.result.numTotalTests=1;p.result.numPassedTests=1;p.compiler=null;
 f.focused.push(p);f.history.runIds.push(201);return {f,unit:rebuiltUnit,unaffected};
}
test('Successful original processes retain unaffected authenticated file assertions without relabelling; affected DB subset uses fresh owned resources',()=>{
 const {f,unit,unaffected}=partialRetentionFixture(),c=verifyFixtureBrowserRecovery(f),u=c.units.find(u=>u.id===unit.id);
 assert.equal(c.tests,6);assert.equal(u.kind,'mixed-source');assert.equal(u.files.find(x=>x.path===unaffected).kind,'retained-original');assert.equal(u.files.find(x=>x.path===unaffected).originalSha,f.sourcePlan.sha);assert.equal(u.files.find(x=>x.kind==='fresh').runId,201);assert.equal(c.originalConclusion,'failure');
});
for(const [name,change] of [['failed process cannot retain',({f,unit})=>f.assessment.reusable=f.assessment.reusable.filter(x=>x.id!==unit.id)],['unselected replacement',({f,unaffected})=>{const r=f.focused[1].report;r.files=[unaffected];r.groups.DB=[unaffected];r.manifestHash=hash(JSON.stringify(r.files));r.batches[0].files=r.files;}],['tampered original report',({f,unit})=>f.reports.find(r=>r.id===unit.id).batches[0].result.testResults[1].assertionResults[0].status='failed'],['missing selected subset',({f})=>f.focused.pop()]])test('File retention refuses '+name,()=>{const item=partialRetentionFixture();change(item);assert.throws(()=>verifyFixtureBrowserRecovery(item.f));});

import {validatePdfRepairMetadata,PDF_REPAIR_TITLE} from './pdf-repair-metadata.mjs';
function pdfMetadataFixture(){
 const f=browserFixture(),stamp=Date.now(),at=n=>new Date(stamp-n*60000).toISOString();
 const run={...f.sourceRun,id:8000,head_sha:f.verificationController,head_branch:'codex/browser-recovery-verifier-20261030',display_title:PDF_REPAIR_TITLE,conclusion:'success',created_at:at(4),updated_at:at(1)};
 const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
 const jobs=names.map((name,i)=>({id:8100+i,name,run_id:run.id,head_sha:run.head_sha,head_branch:run.head_branch,run_attempt:1,status:'completed',conclusion:['resolve','deployment-hold'].includes(name)?'success':'skipped',started_at:at(3),completed_at:at(2),steps:[{name:'Run complete audited PDF unit with pinned execution code',conclusion:'success'}]}));
 const artifacts=['controller-plan-diagnostics','fixture-impact-projection-diagnostic','fixture-pdf-unit-evidence'].map((name,i)=>({id:8200+i,name,size_in_bytes:100,digest:'sha256:'+'a'.repeat(64),expired:false,created_at:at(2.5),expires_at:at(-60),workflow_run:{id:run.id,repository_id:1333414856,head_repository_id:1333414856,head_sha:run.head_sha,head_branch:run.head_branch}}));
 return {run,jobs,artifacts,expected:{runId:8000,verificationController:f.verificationController,after:at(8)}};
}
test('Complete PDF execution records the actual independent verifier producer rather than relabelling it as the published code controller',()=>{const f=pdfMetadataFixture();assert.equal(validatePdfRepairMetadata(f).producer.id,8100);assert.equal(f.run.head_sha,f.expected.verificationController);});
for(const [name,change] of [['foreign controller',f=>f.run.head_sha='f'.repeat(40)],['foreign workflow',f=>f.run.workflow_id++],['wrong mode',f=>f.run.display_title='CI controller checks · verifier'],['native setup without tests',f=>f.jobs[0].steps[0].conclusion='skipped'],['failed tests',f=>f.jobs[0].conclusion='failure'],['extra test workflow job',f=>f.jobs[3].conclusion='success'],['missing archive',f=>f.artifacts.pop()],['foreign archive',f=>f.artifacts[2].workflow_run.head_sha='f'.repeat(40)],['missing digest',f=>delete f.artifacts[2].digest],['expired artifact',f=>f.artifacts[2].expired=true],['rerun',f=>f.run.run_attempt=2],['stale',f=>f.run.created_at='2020-01-01T00:00:00Z']])test('PDF metadata refuses '+name,()=>{const f=pdfMetadataFixture();change(f);assert.throws(()=>validatePdfRepairMetadata(f));});
