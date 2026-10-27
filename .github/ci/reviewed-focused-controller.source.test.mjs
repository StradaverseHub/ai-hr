import assert from 'node:assert/strict';
import {proveReviewedFocusedController,validateReviewedFocusedControllerProof,FOCUSED_REPAIR_CONTROLLER,FOCUSED_REPAIR_BRANCH,FOCUSED_TOOLING_CONTROLLER,FOCUSED_TOOLING_BRANCH,withIndependentRepairQueue,FOCUSED_PINNED_CONTROLLER,FOCUSED_PINNED_BRANCH,withPinnedRepairRuntime} from './reviewed-focused-controller.mjs';
import {fileURLToPath} from 'node:url';
const repository=fileURLToPath(new URL('../..',import.meta.url));
let checks=0;
for(const [controller,branch] of [[FOCUSED_REPAIR_CONTROLLER,FOCUSED_REPAIR_BRANCH],[FOCUSED_TOOLING_CONTROLLER,FOCUSED_TOOLING_BRANCH],[FOCUSED_PINNED_CONTROLLER,FOCUSED_PINNED_BRANCH]]){
 const proof=proveReviewedFocusedController({repository,controller,branch});assert.equal(proof.releaseAuthorized,false);checks++;
 for(const key of ['controller','branch','parent','afterSha256','releaseAuthorized']){const forged={...proof,[key]:'forged'};assert.throws(()=>validateReviewedFocusedControllerProof(forged,{controller,branch}));checks++;}
 assert.throws(()=>proveReviewedFocusedController({repository,controller,branch:'main'}));checks++;
}
assert.throws(()=>withIndependentRepairQueue('unrelated'));checks++;
assert.throws(()=>proveReviewedFocusedController({repository,controller:'0'.repeat(40),branch:FOCUSED_REPAIR_BRANCH}));checks++;
assert.throws(()=>withPinnedRepairRuntime('unrelated'));checks++;
console.log(JSON.stringify({kind:'PRIVATE_CONTROLLER_SOURCE_CHECKS_NOT_APPLICATION_TESTS',checks,passed:true,releaseAuthorized:false}));
