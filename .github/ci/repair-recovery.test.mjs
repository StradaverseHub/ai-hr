import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {hash} from './manifest.mjs';
import {verifyRepairRecovery,repairDisposition,validateRepairFocusedMetadata,validateRepairBuildMetadata,validateRepairGrantEvidence,REPAIR_RECOVERY_POLICY} from './repair-recovery-policy.mjs';
import {createInstallGrant} from './ci-install-grant.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {validateRepairDelta,validateRepairArchiveInventory} from './repair-recovery.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,unlinkSync,symlinkSync,renameSync} from 'node:fs';
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


// Source admission only: private Git fixtures, no parser/app/compiler/database execution.
const closedFixtures=['test/ai-retention-extended-custody.test.ts','test/assistant-own-leave-store.test.ts'];
function fixtureDeltaRepo(t,{symlinkBase=false,executableBase=false}={}){
 const root=mkdtempSync(join(tmpdir(),'aihr-fixture-repair-v3-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const environment={...process.env,GIT_AUTHOR_NAME:'Controller fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Controller fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:environment}).trim();
 const write=(path,text)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);};
 const paths=[...closedFixtures,'test/unknown.test.ts','test/view.dom.test.tsx','test/route.browser.test.tsx','test/harness.ts','test/helpers/owner.ts','test/env.ts','test/global-setup.ts','test/dom-setup.ts','test/browser-setup.ts','test/db-names.ts','test/fixtures/sample.json','core/lifecycle/service.ts','lib/permissions.ts','db/migrations/0001.sql','db/migrations/meta/_journal.json','package.json','pnpm-lock.yaml','scripts/helper.ts','.github/workflows/alpha-staging.yml'];
 git('init','-q');git('config','core.filemode','true');for(const path of paths)write(path,'original '+path+'\n');
 if(executableBase)chmodSync(join(root,closedFixtures[0]),0o755);
 if(symlinkBase){unlinkSync(join(root,closedFixtures[0]));symlinkSync('../unknown.test.ts',join(root,closedFixtures[0]));}
 git('add','.');git('commit','-qm','immutable source');const base=git('rev-parse','HEAD');
 const commit=()=>{git('add','-A');git('commit','-qm','bounded proposed repair');return git('rev-parse','HEAD');};
 return{root,git,write,base,commit,paths};
}
for(const selected of [[closedFixtures[0]],[closedFixtures[1]],closedFixtures])test('v3 admits only existing regular fixture blobs: '+selected.join(' + '),t=>{
 const f=fixtureDeltaRepo(t);for(const path of selected)f.write(path,'independently reviewed fixture correction '+path+'\n');const candidate=f.commit();
 const delta=validateRepairDelta({cwd:f.root,original:f.base,candidate});assert.equal(delta.kind,'fixture-only');assert.deepEqual(delta.changed,selected.slice().sort());
 assert.equal(delta.baseTree,f.git('rev-parse',f.base+'^{tree}'));assert.equal(delta.headTree,f.git('rev-parse',candidate+'^{tree}'));
 assert.equal(delta.unchangedTrackedPaths,f.paths.length-selected.length);assert.match(delta.unchangedTreeFingerprint,/^[a-f0-9]{64}$/);assert.match(delta.diffSha256,/^[a-f0-9]{64}$/);
 for(const fixture of delta.fixtures){assert.equal(fixture.mode,'100644');assert.equal(fixture.beforeBlob,f.git('rev-parse',f.base+':'+fixture.path));assert.equal(fixture.afterBlob,f.git('rev-parse',candidate+':'+fixture.path));assert.notEqual(fixture.beforeBlob,fixture.afterBlob);}
 assert.equal(f.git('show',candidate+':core/lifecycle/service.ts'),'original core/lifecycle/service.ts');
});
for(const path of ['test/unknown.test.ts','test/view.dom.test.tsx','test/route.browser.test.tsx','test/harness.ts','test/helpers/owner.ts','test/env.ts','test/global-setup.ts','test/dom-setup.ts','test/browser-setup.ts','test/db-names.ts','test/fixtures/sample.json','core/lifecycle/service.ts','lib/permissions.ts','db/migrations/0001.sql','db/migrations/meta/_journal.json','package.json','pnpm-lock.yaml','scripts/helper.ts','.github/workflows/alpha-staging.yml'])test('v3 refuses fixture mixed with '+path,t=>{
 const f=fixtureDeltaRepo(t);f.write(closedFixtures[0],'reviewed correction\n');f.write(path,'unreviewed extra delta\n');const candidate=f.commit();
 // Posted/extra allowlist fields never become authority.
 assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate,allowedPaths:[...closedFixtures,path]}));
});
for(const [name,change]of [
 ['addition',f=>f.write('test/new.test.ts','new fixture\n')],
 ['deletion',f=>unlinkSync(join(f.root,closedFixtures[0]))],
 ['rename',f=>renameSync(join(f.root,closedFixtures[0]),join(f.root,'test/renamed.test.ts'))],
 ['mode-only',f=>chmodSync(join(f.root,closedFixtures[0]),0o755)],
 ['content-and-mode',f=>{f.write(closedFixtures[0],'different body\n');chmodSync(join(f.root,closedFixtures[0]),0o755);} ],
 ['regular-to-symlink',f=>{unlinkSync(join(f.root,closedFixtures[0]));symlinkSync('../unknown.test.ts',join(f.root,closedFixtures[0]));}],
])test('v3 refuses fixture '+name,t=>{const f=fixtureDeltaRepo(t);change(f);const candidate=f.commit();assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate}));});
test('v3 refuses modified existing symlink despite an M name-status record',t=>{
 const f=fixtureDeltaRepo(t,{symlinkBase:true});unlinkSync(join(f.root,closedFixtures[0]));symlinkSync('../another.test.ts',join(f.root,closedFixtures[0]));const candidate=f.commit();
 assert.match(f.git('diff','--name-status','--no-renames',f.base,candidate),/^M\s/);assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate}));
});
test('v3 refuses existing executable fixture blobs even without a mode change',t=>{
 const f=fixtureDeltaRepo(t,{executableBase:true});f.write(closedFixtures[0],'new executable fixture content\n');const candidate=f.commit();assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate}));
});
test('v3 refuses a third unreviewed file beside both closed fixture edits',t=>{
 const f=fixtureDeltaRepo(t);for(const path of [...closedFixtures,'test/unknown.test.ts'])f.write(path,'changed\n');const candidate=f.commit();assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate}));
});
test('v3 requires clean exact committed candidate and nonempty ancestor delta',t=>{
 const f=fixtureDeltaRepo(t);assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate:f.base}));f.write(closedFixtures[0],'reviewed correction\n');const candidate=f.commit();
 for(const original of ['HEAD~1','bad','0'.repeat(40),f.git('rev-parse',f.base+'^{tree}')])assert.throws(()=>validateRepairDelta({cwd:f.root,original,candidate}));
 assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate:f.base}));
 f.write('test/untracked.test.ts','not committed\n');assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate}));unlinkSync(join(f.root,'test/untracked.test.ts'));
 f.write('test/harness.ts','dirty harness\n');assert.throws(()=>validateRepairDelta({cwd:f.root,original:f.base,candidate}));
});
test('v3 refuses nonancestor fixture branches',t=>{
 const f=fixtureDeltaRepo(t);f.write(closedFixtures[0],'first branch\n');const original=f.commit();f.git('checkout','-q','--detach',f.base);f.write(closedFixtures[1],'second branch\n');const candidate=f.commit();
 assert.throws(()=>validateRepairDelta({cwd:f.root,original,candidate}));
});
test('v3 certificate identity cannot relabel a v2 certificate even with a recomputed outer fingerprint',()=>{
 assert.equal(REPAIR_RECOVERY_POLICY,'aihr-cross-source-recovery/v3');const f=input(),c=verifyRepairRecovery(f);assert.equal(c.recoveryPolicy,REPAIR_RECOVERY_POLICY);
 const g=installationFixture(),old={...c,recoveryPolicy:'aihr-cross-source-recovery/v2'},e={...g.evidence,...old,recovery:old,fingerprint:hash(old),build:{...g.evidence.build,...f.build}},run={...g.run,id:c.runId,head_sha:c.controller};
 assert.throws(()=>validateRepairGrantEvidence(e,run),/Cross-source recovery certificate/);
});
