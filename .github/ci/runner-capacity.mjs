/** Capacity policy only. Never delete files, change runner size or authorize a test/release. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const BOUNDED_DB_KIB=8*1024**2;
export const BOUNDED_COMPILER_SETUP_KIB=12*1024**2;
export function capacityDecision(profile,availableKiB){
 assert(['legacy','bounded-db-diagnostic','bounded-compiler-diagnostic'].includes(profile),'Unknown runner capacity profile');
 assert(Number.isSafeInteger(availableKiB)&&availableKiB>=0,'Missing runner disk capacity');
 const floor=profile==='bounded-compiler-diagnostic'?BOUNDED_COMPILER_SETUP_KIB:BOUNDED_DB_KIB;
 return {profile,availableKiB,targetKiB:profile==='legacy'?null:floor,decision:profile==='legacy'||availableKiB<floor?'clean':'enough',releaseAuthorized:false};
}
export function validateCapacityScope(profile,e){
 if(profile==='legacy')return true;
 assert(['bounded-db-diagnostic','bounded-compiler-diagnostic'].includes(profile)
  &&e.GITHUB_ACTIONS==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch','Bounded capacity requires actual managed manual context');
 const prefix='StradaverseHub/ai-hr/.github/workflows/',suffix='@refs/heads/codex/test-suite-efficiency-review-20261025';
 if(profile==='bounded-db-diagnostic')assert(e.GITHUB_WORKFLOW_REF===prefix+'alpha-staging-db-diagnostics.yml'+suffix,'Bounded DB capacity scope differs');
 else{
  assert(e.GITHUB_WORKFLOW_REF===prefix+'alpha-staging-diagnostics.yml'+suffix
   &&e.AIHR_COMPILER_TRANSPORT==='consumer'&&e.AIHR_COMPILER_COMPATIBLE_CHILD==='true','Bounded compiler capacity is only the explicit compatible-child consumer');
  for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])
   assert(e[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Compiler capacity cannot reach a database');
 }
 return true;
}
export function compilerSwapFloorKiB(profile,e){
 validateCapacityScope(profile,e);
 assert(['legacy','bounded-compiler-diagnostic'].includes(profile),'Compiler swap capacity profile differs');
 // No application build/tests/DB: reserve4GiB swap and leave4GiB for bounded compiler/cache/log output.
 return (profile==='bounded-compiler-diagnostic'?8:20)*1024**2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args[0]==='compiler-swap-floor'){
  assert(args.length===2,'Exact compiler capacity arguments required');console.log(compilerSwapFloorKiB(args[1],process.env));
 }else{
  const [profile,available]=args;assert(args.length===2,'Exact capacity arguments required');validateCapacityScope(profile,process.env);
  assert(/^\d+$/.test(available??''),'Missing numeric filesystem capacity');
  console.log(capacityDecision(profile,Number(available)).decision);
 }
}
