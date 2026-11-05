/** One reviewed deterministic-clock insertion; ordinary v2 product repair admission stays unchanged. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {hash} from './manifest.mjs';
import {validateRepairGrantEvidence,REPAIR_RECOVERY_POLICY} from './repair-recovery-policy.mjs';
export const CLOCK_FIXTURE_RECOVERY_POLICY='aihr-clock-fixture-recovery/v1';
export const CLOCK_FIXTURE_SOURCE_CONTROLLER='74db3bb7621c33de256372162a1961ee320baf6e';
const PATH='test/harness-ratchet/ratchet.test.ts';
const INSERTION=",clock:()=>new Date('2026-11-02T04:00:00Z')";
const ORIGINAL_BLOB='0f3e0e7b4170f93b9dd18c725dd854e044c607e5',CANDIDATE_BLOB='c39f78e49bf894d2802740076db6d647528e1ab8';
const ORIGINAL_SHA256='e642f5ba07683de7ce883fac37d934c03243a94b9e390f242c7c2e4a0913243e',CANDIDATE_SHA256='e766a0dd870749bfad7a9a6d9dd5538feb4439c9eb454e7ee87d78b199ebd25f';
const ANCHOR="  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:caller(item.persona),conversationId:item.id,question:item.question,scope:{companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'},\n   model,memory:new InMemoryTaskMemoryStore(),tools:provider});";
const CONTROLLER_FILES=Object.freeze({
 '.github/ci/repair-recovery.mjs':'M',
 '.github/ci/operator-release.mjs':'M',
 '.github/ci/ci-install-grant.mjs':'M',
 '.github/ci/clock-fixture-recovery-policy.mjs':'A',
 '.github/ci/clock-fixture-recovery.test.mjs':'A',
 '.github/workflows/alpha-staging.yml':'M',
 'docs/CLOCK-FIXTURE-RECOVERY.md':'A',
});
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2,timeout:60000});
function commit(cwd,id){assert(sha(id),'Immutable full commit SHA required');assert(git(cwd,'cat-file','-t',id).trim()==='commit'&&git(cwd,'rev-parse',id+'^{commit}').trim()===id,'Exact immutable commit required');return id;}
function clean(cwd,head){assert(git(cwd,'rev-parse','HEAD').trim()===head&&git(cwd,'status','--porcelain=v1','--untracked-files=all')==='','Exact clean verification checkout required');}
function ancestor(cwd,base,head){execFileSync('git',['merge-base','--is-ancestor',base,head],{cwd,stdio:'ignore'});}
function delta(cwd,base,head){
 const words=git(cwd,'diff','--name-status','--no-renames','-z',base,head).split('\0');assert(words.pop()==='','Complete Git delta required');
 assert(words.length%2===0,'Malformed Git delta');
 const records=[];for(let i=0;i<words.length;i+=2)records.push({status:words[i],path:words[i+1]});return records.sort((a,b)=>a.path.localeCompare(b.path));
}
function blob(cwd,ref,path){
 const listing=git(cwd,'ls-tree',ref,'--',path).trim();assert(/^100644 blob [a-f0-9]{40}\t/.test(listing),'Regular immutable source blob required');
 const id=git(cwd,'rev-parse',ref+':'+path).trim();assert(sha(id),'Source blob missing');
 const bytes=execFileSync('git',['cat-file','blob',id],{cwd,maxBuffer:64*1024**2,timeout:60000});return {blob:id,sha256:sha256(bytes),bytes};
}
function seal(value){return {...value,fingerprint:hash(value)};}
function proofShape(value,keys){assert(value&&typeof value==='object'&&!Array.isArray(value),'Recovery proof required');same(Object.keys(value).sort(),[...keys,'fingerprint'].sort(),'Exact recovery proof fields required');const {fingerprint,...body}=value;assert(digest(fingerprint)&&fingerprint===hash(body),'Recovery proof fingerprint differs');}
function sourceProof(proof){
 proofShape(proof,['kind','recoveryPolicy','original','candidate','baseTree','headTree','changed','status','path','originalBlob','candidateBlob','originalSha256','candidateSha256','insertion','anchorSha256']);
 assert(proof.kind==='EXACT_CLOCK_FIXTURE_SOURCE_DELTA'&&proof.recoveryPolicy===CLOCK_FIXTURE_RECOVERY_POLICY&&sha(proof.original)&&sha(proof.candidate)&&proof.original!==proof.candidate&&sha(proof.baseTree)&&sha(proof.headTree)&&proof.baseTree!==proof.headTree,'Invalid source identity');
 same(proof.changed,[PATH],'Clock fixture must be the sole source change');
 assert(proof.status==='M'&&proof.path===PATH&&proof.originalBlob===ORIGINAL_BLOB&&proof.candidateBlob===CANDIDATE_BLOB&&proof.originalSha256===ORIGINAL_SHA256&&proof.candidateSha256===CANDIDATE_SHA256&&proof.insertion===INSERTION&&proof.anchorSha256===sha256(ANCHOR),'Exact trusted clock insertion differs');
 return proof;
}
export function validateClockFixtureSourceDelta({cwd,original,candidate}){
 commit(cwd,original);commit(cwd,candidate);clean(cwd,candidate);ancestor(cwd,CLOCK_FIXTURE_SOURCE_CONTROLLER,original);ancestor(cwd,original,candidate);
 same(delta(cwd,original,candidate),[{status:'M',path:PATH}],'Exactly one existing clock fixture modification required');
 const before=blob(cwd,original,PATH),after=blob(cwd,candidate,PATH);
 assert(before.blob===ORIGINAL_BLOB&&before.sha256===ORIGINAL_SHA256,'Original fixture is not the exact trusted fixture');
 const text=before.bytes.toString('utf8');assert(text.split(ANCHOR).length===2&&text.split('tools:provider').length===2,'Unique complete trusted runTurn options required');
 const expected=Buffer.from(text.replace(ANCHOR,ANCHOR.replace('tools:provider','tools:provider'+INSERTION)),'utf8');
 assert(after.bytes.equals(expected)&&after.blob===CANDIDATE_BLOB&&after.sha256===CANDIDATE_SHA256,'Candidate changes more than the exact deterministic clock insertion');
 return sourceProof(seal({kind:'EXACT_CLOCK_FIXTURE_SOURCE_DELTA',recoveryPolicy:CLOCK_FIXTURE_RECOVERY_POLICY,original,candidate,baseTree:git(cwd,'rev-parse',original+'^{tree}').trim(),headTree:git(cwd,'rev-parse',candidate+'^{tree}').trim(),changed:[PATH],status:'M',path:PATH,originalBlob:before.blob,candidateBlob:after.blob,originalSha256:before.sha256,candidateSha256:after.sha256,insertion:INSERTION,anchorSha256:sha256(ANCHOR)}));
}
function controllerProof(proof){
 proofShape(proof,['kind','recoveryPolicy','sourceController','verificationController','reviewedController','pendingReview','baseTree','headTree','changed','blobs']);
 assert(proof.kind==='EXACT_CLOCK_FIXTURE_CONTROLLER_DELTA'&&proof.recoveryPolicy===CLOCK_FIXTURE_RECOVERY_POLICY&&proof.sourceController===CLOCK_FIXTURE_SOURCE_CONTROLLER&&sha(proof.verificationController)&&sha(proof.baseTree)&&sha(proof.headTree)&&proof.baseTree!==proof.headTree,'Invalid trusted controller identity');
 assert((proof.reviewedController===null||proof.reviewedController===proof.verificationController)&&proof.pendingReview===(proof.reviewedController===null),'Exact independent controller review required');
 same(proof.changed,Object.keys(CONTROLLER_FILES).sort(),'Exact finite controller file inventory required');same(Object.keys(proof.blobs).sort(),proof.changed,'Complete controller blob map required');
 for(const [path,status] of Object.entries(CONTROLLER_FILES)){
  const row=proof.blobs[path];same(Object.keys(row).sort(),['status','originalBlob','candidateBlob','originalSha256','candidateSha256'].sort(),'Exact controller blob fields required');
  assert(row.status===status&&sha(row.candidateBlob)&&digest(row.candidateSha256),'Invalid candidate controller blob');
  assert(status==='A'?row.originalBlob===null&&row.originalSha256===null:sha(row.originalBlob)&&digest(row.originalSha256)&&row.originalBlob!==row.candidateBlob&&row.originalSha256!==row.candidateSha256,'Invalid trusted controller delta');
 }
 return proof;
}
export function validateClockFixtureControllerDelta({cwd,sourceController,verificationController,reviewedController=null}){
 assert(sourceController===CLOCK_FIXTURE_SOURCE_CONTROLLER,'Only the exact trusted source controller is supported');commit(cwd,sourceController);commit(cwd,verificationController);clean(cwd,verificationController);ancestor(cwd,sourceController,verificationController);
 const changed=delta(cwd,sourceController,verificationController);same(changed,Object.entries(CONTROLLER_FILES).map(([path,status])=>({path,status})).sort((a,b)=>a.path.localeCompare(b.path)),'Controller delta is outside the exact finite reviewed implementation');
 const blobs={};for(const {path,status} of changed){const before=status==='A'?null:blob(cwd,sourceController,path),after=blob(cwd,verificationController,path);blobs[path]={status,originalBlob:before?.blob??null,candidateBlob:after.blob,originalSha256:before?.sha256??null,candidateSha256:after.sha256};}
 return controllerProof(seal({kind:'EXACT_CLOCK_FIXTURE_CONTROLLER_DELTA',recoveryPolicy:CLOCK_FIXTURE_RECOVERY_POLICY,sourceController,verificationController,reviewedController,pendingReview:reviewedController===null,baseTree:git(cwd,'rev-parse',sourceController+'^{tree}').trim(),headTree:git(cwd,'rev-parse',verificationController+'^{tree}').trim(),changed:changed.map(row=>row.path).sort(),blobs}));
}
export function requireReviewedClockFixtureController({execute,controller,reviewedController}){
 assert(typeof execute==='boolean'&&sha(controller),'Exact controller execution intent required');
 assert(reviewedController===null||reviewedController===undefined||reviewedController===controller,'Reviewed controller identity differs');
 if(execute)assert(reviewedController===controller,'Exact independently reviewed clock-fixture controller required for installation');
 return true;
}
const IDENTITIES=['sha','controller','verificationController','verificationDiagnostic','reviewedController','pendingReview','releaseAuthorized','baseline','runId','policyVersion','originalRunId','originalSha','originalConclusion','originalFingerprint','candidateFingerprint','suiteFiles','browserFiles','tests'];
function bind(accounting,source,controller){
 sourceProof(source);controllerProof(controller);
 assert(accounting?.kind==='AUTHENTICATED_CROSS_SOURCE_RECOVERY'&&accounting.recoveryPolicy===REPAIR_RECOVERY_POLICY&&accounting.originalConclusion==='failure'&&accounting.releaseAuthorized===false,'Real successful v2 repair accounting required');
 assert(accounting.originalSha===source.original&&accounting.sha===source.candidate&&accounting.controller===controller.sourceController&&accounting.verificationController===controller.verificationController&&accounting.reviewedController===controller.reviewedController&&accounting.pendingReview===controller.pendingReview,'Source/controller accounting differs');
 assert(sha(accounting.baseline)&&digest(accounting.originalFingerprint)&&digest(accounting.candidateFingerprint)&&positive(accounting.runId)&&positive(accounting.originalRunId)&&accounting.runId!==accounting.originalRunId&&positive(accounting.tests)&&positive(accounting.suiteFiles)&&positive(accounting.browserFiles),'Incomplete v2 accounting identities');
 assert(Array.isArray(accounting.compilers)&&accounting.compilers.length>0&&Array.isArray(accounting.focusedSources)&&accounting.focusedSources.length>0&&Array.isArray(accounting.units)&&accounting.units.some(unit=>unit.kind==='repaired-source'),'Complete v2 replacement accounting required');
 assert(accounting.verificationDiagnostic?.controller===controller.verificationController&&positive(accounting.verificationDiagnostic.runId)&&accounting.verificationDiagnostic.kind==='CONTROLLER_ONLY_NOT_APPLICATION_GATE'&&positive(accounting.verificationDiagnostic.resolveJobId),'Exact hosted controller diagnostic required');
 if(!accounting.pendingReview)validateRepairGrantEvidence({...accounting,recovery:accounting,fingerprint:hash(accounting)},{id:accounting.runId,head_sha:accounting.controller,conclusion:'success',status:'completed',run_attempt:1});
 return true;
}
export function wrapClockFixtureRecovery({accounting,sourceProof:source,controllerProof:controller}){
 bind(accounting,source,controller);
 return {...accounting,kind:'AUTHENTICATED_CLOCK_FIXTURE_RECOVERY',recoveryPolicy:CLOCK_FIXTURE_RECOVERY_POLICY,accounting,sourceProof:source,controllerProof:controller,accountingFingerprint:hash(accounting),sourceProofFingerprint:source.fingerprint,controllerProofFingerprint:controller.fingerprint};
}
function assertImmutableProofObjects(cwd,source,controller){
 // Fingerprints are not signatures. Re-read immutable Git objects at grant time so an
 // altered blob map cannot be legitimized merely by recomputing JSON fingerprints.
 for(const ref of [source.original,source.candidate,controller.sourceController,controller.verificationController])commit(cwd,ref);
 ancestor(cwd,CLOCK_FIXTURE_SOURCE_CONTROLLER,source.original);ancestor(cwd,source.original,source.candidate);ancestor(cwd,controller.sourceController,controller.verificationController);
 for(const [ref,tree]of [[source.original,source.baseTree],[source.candidate,source.headTree],[controller.sourceController,controller.baseTree],[controller.verificationController,controller.headTree]])assert(git(cwd,'rev-parse',ref+'^{tree}').trim()===tree,'Immutable proof tree differs');
 same(delta(cwd,source.original,source.candidate),[{status:'M',path:PATH}],'Immutable source delta differs');
 const before=blob(cwd,source.original,PATH),after=blob(cwd,source.candidate,PATH);
 assert(before.blob===source.originalBlob&&before.sha256===source.originalSha256&&after.blob===source.candidateBlob&&after.sha256===source.candidateSha256,'Immutable source blob differs');
 same(delta(cwd,controller.sourceController,controller.verificationController),Object.entries(CONTROLLER_FILES).map(([path,status])=>({path,status})).sort((a,b)=>a.path.localeCompare(b.path)),'Immutable controller delta differs');
 for(const [path,status]of Object.entries(CONTROLLER_FILES)){
  const old=status==='A'?null:blob(cwd,controller.sourceController,path),current=blob(cwd,controller.verificationController,path);
  same(controller.blobs[path],{status,originalBlob:old?.blob??null,candidateBlob:current.blob,originalSha256:old?.sha256??null,candidateSha256:current.sha256},'Immutable reviewed controller bytes differ');
 }
}
export function assertClockFixtureRecoveryGrant(evidence,run){
 const certificate=evidence?.recovery;
 assert(certificate?.kind==='AUTHENTICATED_CLOCK_FIXTURE_RECOVERY'&&certificate.recoveryPolicy===CLOCK_FIXTURE_RECOVERY_POLICY&&evidence.fingerprint===hash(certificate),'Exact clock fixture recovery certificate required');
 const {accounting,sourceProof:source,controllerProof:controller}=certificate;bind(accounting,source,controller);
 same(certificate,wrapClockFixtureRecovery({accounting,sourceProof:source,controllerProof:controller}),'Clock wrapper differs from its exact embedded accounting and proofs');
 assert(certificate.accountingFingerprint===hash(accounting)&&certificate.sourceProofFingerprint===source.fingerprint&&certificate.controllerProofFingerprint===controller.fingerprint,'Embedded proof fingerprint differs');
 for(const key of IDENTITIES){same(certificate[key],accounting[key],'Clock accounting identity differs: '+key);same(evidence[key],certificate[key],'Clock grant identity differs: '+key);}
 for(const key of ['kind','recoveryPolicy','accounting','sourceProof','controllerProof','accountingFingerprint','sourceProofFingerprint','controllerProofFingerprint'])same(evidence[key],certificate[key],'Clock grant proof differs: '+key);
 requireReviewedClockFixtureController({execute:true,controller:certificate.verificationController,reviewedController:certificate.reviewedController});
 assert(certificate.pendingReview===false,'Pending-review clock diagnostic cannot install');
 assert(typeof evidence.candidatePath==='string'&&evidence.candidatePath.length>0,'Immutable source/controller object checkout required');
 assertImmutableProofObjects(evidence.candidatePath,source,controller);
 return validateRepairGrantEvidence({...evidence,...accounting,recovery:accounting,fingerprint:hash(accounting)},run);
}
