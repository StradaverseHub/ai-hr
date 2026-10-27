/** A verifier extension may authenticate the original controller without relabeling its run. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export const ORIGINAL_AUTHORITY_ROOTS=['compiler-cache-protocol.mjs','policy-version.mjs','plan.mjs','manifest.mjs','db-scheduling.mjs','db-duration-hints.json','pdf-tool-scope.mjs','release-policy.mjs','verify-shards.mjs','postgres-evidence.mjs','pdf-tools.mjs','build-artifact.mjs','build-production.mjs','next-application-cache-protocol.mjs','extract-artifact.py','build-transport-extract.py'];
export function bindOriginalController({repository,verifier,controller}){
 for(const value of [verifier,controller])assert(/^[a-f0-9]{40}$/.test(value??''),'Exact verifier/original controller required');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{maxBuffer:16*1024**2,timeout:10000});
 git('merge-base','--is-ancestor',controller,verifier);
 const pins=[];
 for(const path of [...ORIGINAL_AUTHORITY_ROOTS.map(p=>'.github/ci/'+p),'scripts/gate-db-classify.ts']){
  const original=git('show',controller+':'+path),current=git('show',verifier+':'+path);
  assert(original.equals(current),'Original CI authority primitive differs: '+path);
  pins.push({path,sha256:createHash('sha256').update(original).digest('hex')});
 }
 return {kind:'ORIGINAL_CI_CONTROLLER_BINDING_NOT_RELEASE',format:1,controller,verifier,originalControllerPreserved:true,pins,releaseAuthorized:false};
}
