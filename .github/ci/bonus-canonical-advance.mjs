/** Exact CI-only canonical advancement; never changes the original build controller identity. */
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {installHash,installJson} from './ci-install-grant.mjs';
export const BONUS_HELD_CANONICAL='bab210d1eabe79d4da2b76f50a31e0070ac0711f';
const parent='dc74b804fcecb4bab3207e82c9b9f099b9bf13be',paths=['.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging-diagnostics.yml','.github/workflows/alpha-staging.yml'];
export function pinCanonicalRuntime(path,before){
 assert(paths.includes(path)&&typeof before==='string'&&Buffer.byteLength(before)<128*1024,'Exact bounded canonical CI input required');
 if(path===paths[0]){assert.equal(before.split('description: Node major').length,2);assert.equal(before.split("default: '22'").length,2);return before.replace('description: Node major','description: Exact Node version (fingerprints bind it)').replace("default: '22'","default: '22.23.3'");}
 const count=path===paths[1]?1:2;assert.equal(before.split("node-version: '22'").length,count+1);return before.replaceAll("node-version: '22'","node-version: '22.23.3'");
}
export function proveBonusCanonicalAdvance({repository,head}){
 assert.equal(head,BONUS_HELD_CANONICAL,'Only the independently reviewed canonical CI pin advancement is allowed');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:2*1024**2}).trim();assert.equal(git('rev-parse',head+'^1'),parent);execFileSync('git',['-C',repository,'merge-base','--is-ancestor',parent,head],{stdio:'pipe'});assert.deepEqual(git('diff','--name-only',parent,head).split('\n').sort(),paths.slice().sort(),'Canonical advancement changed application or unrelated inputs');
 const pins=paths.map(path=>{assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',head,'--',path)));const source=ref=>execFileSync('git',['-C',repository,'show',ref+':'+path],{encoding:'utf8',maxBuffer:128*1024}),before=source(parent),after=source(head);assert.equal(pinCanonicalRuntime(path,before),after,'Canonical CI pin has additional changes');return {path,beforeSha256:installHash(before),afterSha256:installHash(after)};});
 const body={format:1,kind:'EXACT_CANONICAL_CI_NODE_PIN_ADVANCE_NOT_BUILD_OR_RELEASE',parent,head,originalBuildController:parent,pins,applicationMigrationAndGateInputsUnchanged:true,releaseAuthorized:false};return {...body,proofSha256:installHash(installJson(body))};
}
