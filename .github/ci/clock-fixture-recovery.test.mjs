import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,renameSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,time} from './resume-test-fixtures.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {hash} from './manifest.mjs';
import {verifyRepairRecovery} from './repair-recovery-policy.mjs';
import {validateRepairDelta} from './repair-recovery.mjs';
import {validateClockFixtureSourceDelta,validateClockFixtureControllerDelta,wrapClockFixtureRecovery,assertClockFixtureRecoveryGrant,requireReviewedClockFixtureController,CLOCK_FIXTURE_SOURCE_CONTROLLER,CLOCK_FIXTURE_RECOVERY_POLICY} from './clock-fixture-recovery-policy.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),PATH='test/harness-ratchet/ratchet.test.ts';
const INSERTION=",clock:()=>new Date('2026-11-02T04:00:00Z')";
const FILES={'.github/ci/repair-recovery.mjs':'M','.github/ci/operator-release.mjs':'M','.github/ci/ci-install-grant.mjs':'M','.github/ci/clock-fixture-recovery-policy.mjs':'A','.github/ci/clock-fixture-recovery.test.mjs':'A','.github/workflows/alpha-staging.yml':'M','docs/CLOCK-FIXTURE-RECOVERY.md':'A'};
function repository(){
 const root=mkdtempSync(join(tmpdir(),'aihr-clock-recovery-'));
 execFileSync('git',['clone','--quiet','--shared','--no-checkout',ROOT,root],{stdio:'pipe'});
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Clock policy fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Clock policy fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
 const write=(path,value)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);};
 const commit=()=>{git('add','-A');git('commit','--quiet','-m','Isolated clock policy fixture');return git('rev-parse','HEAD');};
 const reset=()=>git('checkout','--quiet','--detach','--force',CLOCK_FIXTURE_SOURCE_CONTROLLER);
 reset();return {root,git,write,commit,reset,close:()=>rmSync(root,{recursive:true,force:true})};
}
function clockCandidate(repo,transform=value=>value){
 repo.reset();const text=readFileSync(join(repo.root,PATH),'utf8');repo.write(PATH,transform(text.replace('tools:provider','tools:provider'+INSERTION)));return repo.commit();
}
function controllerCandidate(repo,extra){
 repo.reset();for(const [path,status]of Object.entries(FILES))repo.write(path,status==='A'?'// Isolated externally reviewed controller fixture\n':readFileSync(join(repo.root,path),'utf8')+'\n// Isolated reviewed controller fixture\n');
 if(extra)extra(repo);return repo.commit();
}
function baseInput(){
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

function accountingFor(source,controller){
 const f=baseInput(),rehash=value=>{const {fingerprint,...body}=value;return {...body,fingerprint:hash(body)};};
 f.sourcePlan=rehash({...f.sourcePlan,sha:source.original,controller:controller.sourceController});
 f.plan=rehash({...f.plan,sha:source.candidate,controller:controller.sourceController});
 for(const report of f.reports){report.sha=source.original;report.fingerprint=f.sourcePlan.fingerprint;}
 f.sourceRun.head_sha=controller.sourceController;
 const observations=f.assessment.observations;
 f.assessment={...assessResumeCoverage({expectedPlan:f.sourcePlan,reports:f.reports,expected:{candidate:source.original,controller:controller.sourceController,baseline:f.plan.migrationBase,runId:f.sourceRun.id}}),sourceRun:{id:f.sourceRun.id},observations};
 for(const row of f.assessment.reusable)row.source={runId:f.sourceRun.id,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const impact={...f.impactContext.plan,changed:[PATH],classifications:[{path:PATH,risk:'moderate',uncertainties:[]}]};
 f.impactContext={...f.impactContext,base:source.original,head:source.candidate,baseTree:source.baseTree,headTree:source.headTree,controller:controller.verificationController,sourceInputsFingerprint:hash({baseTree:source.baseTree,headTree:source.headTree,controller:controller.verificationController,impactPolicy:3}),plan:rehash(impact)};
 f.verificationController=controller.verificationController;f.reviewedController=controller.reviewedController;
 f.verificationDiagnostic={controller:controller.verificationController,runId:900,resolveJobId:901,kind:'CONTROLLER_ONLY_NOT_APPLICATION_GATE'};
 for(const fresh of f.focused){fresh.run.head_sha=controller.sourceController;for(const job of fresh.jobs)job.head_sha=controller.sourceController;fresh.compiler.controller=controller.sourceController;fresh.report.sha=source.candidate;fresh.report.controller=controller.sourceController;fresh.artifact.workflow_run.head_sha=controller.sourceController;}
 f.buildRun.head_sha=controller.sourceController;f.build={...f.build,source:source.candidate,controller:controller.sourceController};
 return verifyRepairRecovery(f);
}
const envelope=(certificate,candidatePath)=>({...certificate,recovery:certificate,fingerprint:hash(certificate),candidatePath});
const producer=certificate=>({id:certificate.runId,head_sha:certificate.controller,conclusion:'success',status:'completed',run_attempt:1});
const reseal=value=>{const {fingerprint,...body}=value;return {...body,fingerprint:hash(body)};};

test('finite source insertion and controller review compose real v2 accounting without generic test admission',()=>{
 const repo=repository(),evidence=certificate=>envelope(certificate,repo.root);try{
  const candidate=clockCandidate(repo),source=validateClockFixtureSourceDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate});
  assert.equal(source.originalBlob,'0f3e0e7b4170f93b9dd18c725dd854e044c607e5');assert.equal(source.candidateBlob,'c39f78e49bf894d2802740076db6d647528e1ab8');
  assert.throws(()=>validateRepairDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate}),/Only existing product/);
  const verifier=controllerCandidate(repo),controller=validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:verifier});
  const accounting=accountingFor(source,controller),certificate=wrapClockFixtureRecovery({accounting,sourceProof:source,controllerProof:controller});
  assert.equal(certificate.kind,'AUTHENTICATED_CLOCK_FIXTURE_RECOVERY');assert.equal(certificate.recoveryPolicy,CLOCK_FIXTURE_RECOVERY_POLICY);assert.equal(assertClockFixtureRecoveryGrant(evidence(certificate),producer(certificate)),true);
  for(const change of [x=>x.sourceProof.originalSha256='0'.repeat(64),x=>x.sourceProof.insertion=",clock:()=>new Date('2026-11-03T04:00:00Z')",x=>x.controllerProof.blobs['.github/ci/repair-recovery.mjs'].candidateSha256='0'.repeat(64),x=>x.accounting.tests++,x=>x.units=[],x=>x.compilers=[],x=>x.originalSha=x.sha,x=>x.verificationDiagnostic.runId=0,x=>x.accountingFingerprint='0'.repeat(64),x=>x.reviewedController=CLOCK_FIXTURE_SOURCE_CONTROLLER]){
   const bad=structuredClone(certificate);change(bad);assert.throws(()=>assertClockFixtureRecoveryGrant(evidence(bad),producer(bad)));
  }
  const changed=structuredClone(certificate);changed.sourceProof.candidate=changed.sourceProof.original;changed.sourceProof=reseal(changed.sourceProof);changed.sourceProofFingerprint=changed.sourceProof.fingerprint;
  assert.throws(()=>assertClockFixtureRecoveryGrant(evidence(changed),producer(changed)));
  const rehashedMap=structuredClone(certificate);rehashedMap.controllerProof.blobs['.github/ci/repair-recovery.mjs'].candidateSha256='0'.repeat(64);rehashedMap.controllerProof=reseal(rehashedMap.controllerProof);rehashedMap.controllerProofFingerprint=rehashedMap.controllerProof.fingerprint;
  assert.throws(()=>assertClockFixtureRecoveryGrant(evidence(rehashedMap),producer(rehashedMap)),/Immutable reviewed controller bytes/);
  const wrongOuter=evidence(certificate);wrongOuter.tests++;assert.throws(()=>assertClockFixtureRecoveryGrant(wrongOuter,producer(certificate)));
  const wrongRun=producer(certificate);wrongRun.head_sha=verifier;assert.throws(()=>assertClockFixtureRecoveryGrant(evidence(certificate),wrongRun));
  const diagnostic=validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier});
  const pending=wrapClockFixtureRecovery({accounting:accountingFor(source,diagnostic),sourceProof:source,controllerProof:diagnostic});assert.equal(pending.pendingReview,true);
  assert.throws(()=>assertClockFixtureRecoveryGrant(evidence(pending),producer(pending)));
  assert.equal(requireReviewedClockFixtureController({execute:false,controller:verifier,reviewedController:null}),true);
  assert.throws(()=>requireReviewedClockFixtureController({execute:true,controller:verifier,reviewedController:null}));
  assert.throws(()=>requireReviewedClockFixtureController({execute:true,controller:verifier,reviewedController:CLOCK_FIXTURE_SOURCE_CONTROLLER}));
 }finally{repo.close();}
});
for(const [name,change]of [
 ['other date',text=>text.replace('2026-11-02T04:00:00Z','2026-11-03T04:00:00Z')],
 ['assertion change',text=>text.replace("expect(result.reply.trim(),id).not.toBe('')","expect(result.reply.trim(),id).toBe('')")],
 ['question change',text=>text.replace('question:item.question','question:"changed question"')],
 ['duplicate insertion',text=>text.replace(INSERTION,INSERTION+INSERTION)],
])test('source refuses '+name,()=>{
 const repo=repository();try{const candidate=clockCandidate(repo,change);assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate}));}finally{repo.close();}
});
test('source refuses extra paths, wrong old hash, preexisting clock, dirty checkout, rename and mutable refs',()=>{
 const repo=repository();try{
  let candidate=clockCandidate(repo);repo.write('core/clock-policy-extra.ts','export const extra=true;');candidate=repo.commit();assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate}));
  candidate=clockCandidate(repo);repo.write('dirty-untracked.txt','dirty');assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate}));rmSync(join(repo.root,'dirty-untracked.txt'));
  assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:'HEAD~1',candidate}));
  repo.reset();repo.write(PATH,readFileSync(join(repo.root,PATH),'utf8')+'\n// changed old assertion boundary\n');const wrongOriginal=repo.commit();repo.write(PATH,readFileSync(join(repo.root,PATH),'utf8').replace('tools:provider','tools:provider'+INSERTION));candidate=repo.commit();assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:wrongOriginal,candidate}));
  const already=clockCandidate(repo);repo.write(PATH,readFileSync(join(repo.root,PATH),'utf8')+'\n// already contains clock\n');candidate=repo.commit();assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:already,candidate}));
  candidate=clockCandidate(repo);chmodSync(join(repo.root,PATH),0o755);candidate=repo.commit();assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate}),/Regular immutable source blob/);
  repo.reset();renameSync(join(repo.root,PATH),join(repo.root,'test/harness-ratchet/renamed.test.ts'));candidate=repo.commit();assert.throws(()=>validateClockFixtureSourceDelta({cwd:repo.root,original:CLOCK_FIXTURE_SOURCE_CONTROLLER,candidate}));
 }finally{repo.close();}
});
test('controller refuses outside paths, missing implementation, replacement/rename, wrong trusted source, dirty state and changed review SHA',()=>{
 const repo=repository();try{
  let verifier=controllerCandidate(repo,r=>r.write('lib/clock-policy-outside.ts','export const changed=true;'));assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:verifier}));
  verifier=controllerCandidate(repo,r=>rmSync(join(r.root,'docs/CLOCK-FIXTURE-RECOVERY.md')));assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:verifier}));
  verifier=controllerCandidate(repo,r=>renameSync(join(r.root,'.github/ci/operator-release.mjs'),join(r.root,'.github/ci/operator-release-renamed.mjs')));assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:verifier}));
  verifier=controllerCandidate(repo,r=>chmodSync(join(r.root,'.github/ci/operator-release.mjs'),0o755));assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:verifier}),/Regular immutable source blob/);
  verifier=controllerCandidate(repo);assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:verifier,verificationController:verifier,reviewedController:verifier}));
  const reviewed=verifier;repo.write('.github/ci/operator-release.mjs',readFileSync(join(repo.root,'.github/ci/operator-release.mjs'),'utf8')+'\n// further unreviewed edit\n');verifier=repo.commit();assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:reviewed}));
  repo.write('dirty-untracked.txt','dirty');assert.throws(()=>validateClockFixtureControllerDelta({cwd:repo.root,sourceController:CLOCK_FIXTURE_SOURCE_CONTROLLER,verificationController:verifier,reviewedController:verifier}));
 }finally{repo.close();}
});
