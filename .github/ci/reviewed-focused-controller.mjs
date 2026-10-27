/** Exact repair-only controller boundary. It grants no application or release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {installHash,installJson} from './ci-install-grant.mjs';
export const FOCUSED_REPAIR_PARENT='67be2710c35035af433bdb2fcdfb2cb30277ceda';
export const FOCUSED_REPAIR_CONTROLLER='482ee86a0a5f9b8c3b549157f9141c2132447787';
export const FOCUSED_REPAIR_BRANCH='claude/letters-repair-controller-20261027';
export const FOCUSED_TOOLING_CONTROLLER='abd8d5b462e984f80cb5bdf8ef471d048fe7437b';
export const FOCUSED_TOOLING_BRANCH='codex/letters-repair-tooling-20261027';
export const FOCUSED_TOOLING_SHA256='d19bf2ee709c909918654918652c68f248e16ca9ab569cb53eee5706c5b67270';
const path='.github/workflows/alpha-focused-checks.yml';
export function withIndependentRepairQueue(before){
 assert(typeof before==='string'&&Buffer.byteLength(before)<128*1024,'Bounded trusted focused workflow required');
 const old='  group: alpha-focused-${{ inputs.candidate_ref }}\n';
 assert(before.split(old).length===2,'Exactly one original concurrency declaration required');
 return before.replace(old,'  group: alpha-focused-${{ inputs.candidate_ref }}-${{ github.run_id }}\n');
}
export function validateReviewedFocusedControllerProof(proof,{controller,branch}){
 const {proofSha256,...body}=proof??{};
 if(controller===FOCUSED_TOOLING_CONTROLLER){
  assert(proofSha256===installHash(installJson(body))&&body.format===1&&body.kind==='EXACT_FOCUSED_TOOLING_CONTROLLER_SOURCE_NOT_RELEASE'
   &&body.parent===FOCUSED_REPAIR_CONTROLLER&&body.controller===controller&&body.branch===FOCUSED_TOOLING_BRANCH&&branch===body.branch
   &&body.path===path&&body.afterSha256===FOCUSED_TOOLING_SHA256&&body.onlyReviewedToolingChanged===true
   &&body.releaseAuthorized===false&&/^[a-f0-9]{64}$/.test(body.beforeSha256),'Exact independently reconstructed tooling controller proof required');
  return proof;
 }
 assert(proofSha256===installHash(installJson(body))&&body.format===1&&body.kind==='EXACT_FOCUSED_QUEUE_CONTROLLER_SOURCE_NOT_RELEASE'
  &&body.parent===FOCUSED_REPAIR_PARENT&&body.controller===FOCUSED_REPAIR_CONTROLLER&&body.controller===controller
  &&body.branch===FOCUSED_REPAIR_BRANCH&&body.branch===branch&&body.path===path&&body.onlyConcurrencyChanged===true
  &&body.releaseAuthorized===false&&/^[a-f0-9]{64}$/.test(body.beforeSha256)&&/^[a-f0-9]{64}$/.test(body.afterSha256),'Exact independently reconstructed repair controller proof required');
 return proof;
}
/** Authenticate actual immutable source; never accept a caller's self-hashed proof as source authority. */
export function proveReviewedFocusedController({repository,controller,branch}){
 const tooling=controller===FOCUSED_TOOLING_CONTROLLER&&branch===FOCUSED_TOOLING_BRANCH;
 assert(tooling||(controller===FOCUSED_REPAIR_CONTROLLER&&branch===FOCUSED_REPAIR_BRANCH),'Unreviewed focused controller');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:2*1024**2,timeout:10000}).trim();
 assert(['https://github.com/stradaversehub/ai-hr.git','https://github.com/stradaversehub/ai-hr'].includes(git('remote','get-url','origin').toLowerCase()),'Foreign source repository');
 if(tooling){
  proveReviewedFocusedController({repository,controller:FOCUSED_REPAIR_CONTROLLER,branch:FOCUSED_REPAIR_BRANCH});
  assert(git('rev-parse',controller+'^')===FOCUSED_REPAIR_CONTROLLER,'Unexpected tooling controller parent');
  assert(git('diff','--name-only',FOCUSED_REPAIR_CONTROLLER,controller)===path,'Tooling controller changed other inputs');
  assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',controller,'--',path)),'Regular immutable tooling workflow required');
  const source=ref=>execFileSync('git',['-C',repository,'show',ref+':'+path],{encoding:'utf8',maxBuffer:128*1024});
  const beforeSha256=installHash(source(FOCUSED_REPAIR_CONTROLLER)),afterSha256=installHash(source(controller));
  assert(afterSha256===FOCUSED_TOOLING_SHA256,'Tooling workflow differs from independently reviewed exact bytes');
  const body={format:1,kind:'EXACT_FOCUSED_TOOLING_CONTROLLER_SOURCE_NOT_RELEASE',parent:FOCUSED_REPAIR_CONTROLLER,controller,branch,path,beforeSha256,afterSha256,onlyReviewedToolingChanged:true,releaseAuthorized:false};
  return validateReviewedFocusedControllerProof({...body,proofSha256:installHash(installJson(body))},{controller,branch});
 }
 execFileSync('git',['-C',repository,'merge-base','--is-ancestor',FOCUSED_REPAIR_PARENT,controller],{stdio:'pipe'});
 assert(git('diff','--name-only',FOCUSED_REPAIR_PARENT,controller)===path,'Repair controller changed other inputs');
 for(const ref of [FOCUSED_REPAIR_PARENT,controller])assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',ref,'--',path)),'Regular immutable workflow source required');
 const text=ref=>execFileSync('git',['-C',repository,'show',ref+':'+path],{encoding:'utf8',maxBuffer:128*1024});
 const before=text(FOCUSED_REPAIR_PARENT),after=text(controller);assert(withIndependentRepairQueue(before)===after,'Only the exact queue isolation may change');
 const body={format:1,kind:'EXACT_FOCUSED_QUEUE_CONTROLLER_SOURCE_NOT_RELEASE',parent:FOCUSED_REPAIR_PARENT,controller,branch,path,beforeSha256:installHash(before),afterSha256:installHash(after),onlyConcurrencyChanged:true,releaseAuthorized:false};
 return validateReviewedFocusedControllerProof({...body,proofSha256:installHash(installJson(body))},{controller,branch});
}
