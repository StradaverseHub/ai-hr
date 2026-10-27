/** Exact CI-only canonical advance; never relabels an original build controller. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {installHash,installJson} from './ci-install-grant.mjs';
export const BONUS_HELD_ALPHA='bab210d1eabe79d4da2b76f50a31e0070ac0711f';
const original='dc74b804fcecb4bab3207e82c9b9f099b9bf13be';
const action='.github/actions/setup-alpha/action.yml',workflow='.github/workflows/alpha-staging.yml',diagnostic='.github/workflows/alpha-staging-diagnostics.yml';
const paths=[action,diagnostic,workflow];
export function reconstructBonusNodePin(path,before){
 assert(typeof before==='string'&&Buffer.byteLength(before)>0&&Buffer.byteLength(before)<=128*1024&&paths.includes(path),'Bounded exact reviewed CI file required');
 const replace=(text,needle,value,count)=>{assert.equal(text.split(needle).length-1,count,'Exact original Node pin locations required');return text.replaceAll(needle,value);};
 if(path===action)return replace(replace(before,'description: Node major\n','description: Exact Node version (fingerprints bind it)\n',1),"default: '22'","default: '22.23.3'",1);
 return replace(before,"node-version: '22'","node-version: '22.23.3'",path===workflow?2:1);
}
export function proveBonusAlphaHold({repository,observedHead}){
 assert.equal(observedHead,BONUS_HELD_ALPHA,'Canonical alpha changed outside the exact reviewed CI-only advance');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:2*1024**2,timeout:10000}).trim();
 assert(['https://github.com/stradaversehub/ai-hr.git','https://github.com/stradaversehub/ai-hr'].includes(git('remote','get-url','origin').toLowerCase()),'Canonical source repository required');
 const parents=git('show','-s','--format=%P',BONUS_HELD_ALPHA).split(' ');assert(parents.length===2&&parents[0]===original,'Preserve original canonical history through the actual merge');
 git('merge-base','--is-ancestor',original,BONUS_HELD_ALPHA);
 assert.deepEqual(git('diff','--name-only',original,BONUS_HELD_ALPHA).split('\n'),paths,'Unrelated canonical inputs changed');
 const pins=paths.map(path=>{
  const identity=ref=>{const match=/^100644 blob ([a-f0-9]{40})\t/.exec(git('ls-tree',ref,'--',path));assert(match,'Exact regular CI blob required');return match[1];};
  const source=ref=>execFileSync('git',['-C',repository,'show',ref+':'+path],{encoding:'utf8',maxBuffer:128*1024,timeout:10000});
  const before=source(original),after=source(BONUS_HELD_ALPHA);assert.equal(after,reconstructBonusNodePin(path,before),'Only the reviewed Node pins and their description may change');
  return {path,beforeBlob:identity(original),afterBlob:identity(BONUS_HELD_ALPHA),beforeSha256:installHash(before),afterSha256:installHash(after)};
 });
 const body={format:1,kind:'EXACT_CI_NODE_PIN_ALPHA_ADVANCE_NOT_BUILD_OR_SOURCE_AUTHORITY',originalBuildController:original,heldCanonicalHead:BONUS_HELD_ALPHA,mergeParents:parents,pins,applicationAndMigrationGitInputsUnchanged:true,originalBuildControllerPreserved:true,releaseAuthorized:false,fullGatePassCreated:false};
 return {...body,proofSha256:installHash(installJson(body))};
}
