/** Capacity policy only. Never delete files, change runner size or authorize a test/release. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const BOUNDED_DB_KIB=8*1024**2;
export function capacityDecision(profile,availableKiB){
 assert(['legacy','bounded-db-diagnostic'].includes(profile),'Unknown runner capacity profile');
 assert(Number.isSafeInteger(availableKiB)&&availableKiB>=0,'Missing runner disk capacity');
 return {profile,availableKiB,targetKiB:profile==='legacy'?null:BOUNDED_DB_KIB,decision:profile==='legacy'||availableKiB<BOUNDED_DB_KIB?'clean':'enough',releaseAuthorized:false};
}
export function validateCapacityScope(profile,e){
 if(profile==='legacy')return true;
 assert(profile==='bounded-db-diagnostic'&&e.GITHUB_ACTIONS==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'
  &&e.GITHUB_WORKFLOW_REF==='StradaverseHub/ai-hr/.github/workflows/alpha-staging-db-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025','Bounded capacity is only reviewed manual DB diagnostics');
 return true;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [profile,available]=process.argv.slice(2);validateCapacityScope(profile,process.env);
 assert(/^\d+$/.test(available??''),'Missing numeric filesystem capacity');
 console.log(capacityDecision(profile,Number(available)).decision);
}
