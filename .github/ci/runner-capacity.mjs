/** Capacity policy only. Never delete files, change runner size or authorize a test/release. */
import assert from 'node:assert/strict';
import {assertCiCandidateBuildInvocation} from './build-production.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const BOUNDED_DB_KIB=8*1024**2;
export const SUITE_SETUP_KIB=24*1024**2;
export const SUITE_READY_KIB=21*1024**2; // Existing test admission stays20GiB; reserve1GiB before a possible image pull.
export const BOUNDED_COMPILER_SETUP_KIB=12*1024**2;
export function capacityDecision(profile,availableKiB){
 assert(['legacy','bounded-db-diagnostic','bounded-compiler-diagnostic','bounded-whole-compiler','bounded-next-build-diagnostic','bounded-canonical-build','bounded-suite-setup','bounded-suite-ready'].includes(profile),'Unknown runner capacity profile');
 assert(Number.isSafeInteger(availableKiB)&&availableKiB>=0,'Missing runner disk capacity');
 const floor=profile==='bounded-suite-setup'?SUITE_SETUP_KIB:profile==='bounded-suite-ready'?SUITE_READY_KIB:['bounded-compiler-diagnostic','bounded-whole-compiler','bounded-next-build-diagnostic','bounded-canonical-build'].includes(profile)?BOUNDED_COMPILER_SETUP_KIB:BOUNDED_DB_KIB;
 return {profile,availableKiB,targetKiB:profile==='legacy'?null:floor,decision:profile==='legacy'||availableKiB<floor?'clean':'enough',releaseAuthorized:false};
}
export function validateCapacityScope(profile,e){
 if(profile==='legacy')return true;
 if(profile==='bounded-canonical-build')return assertCiCandidateBuildInvocation(e);
 if(['bounded-suite-setup','bounded-suite-ready'].includes(profile)){
  const prefix='StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/';
  const normal=['test','browser','controller-tests'].includes(e.GITHUB_JOB)&&e.GITHUB_WORKFLOW_REF?.startsWith(prefix)&&['workflow_dispatch','push','pull_request'].includes(e.GITHUB_EVENT_NAME);
  const pilot=e.GITHUB_JOB==='runner-diagnostics'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_WORKFLOW_REF===prefix+'heads/codex/test-suite-efficiency-review-20261025'&&e.AIHR_SUITE_CAPACITY_PILOT==='true';
  const impactRef=typeof e.GITHUB_WORKFLOW_REF==='string'&&e.GITHUB_WORKFLOW_REF.match(/^StradaverseHub\/ai-hr\/\.github\/workflows\/alpha-staging\.yml@refs\/heads\/(codex\/[A-Za-z0-9][A-Za-z0-9/_-]{0,180})$/);
  const impact=e.GITHUB_JOB==='runner-diagnostics'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&impactRef
   &&e.GITHUB_REF==='refs/heads/'+impactRef[1]&&e.AIHR_DIAGNOSTICS_ONLY==='true'&&e.AIHR_CONTROLLER_ONLY==='false'&&e.AIHR_BUILD_ONLY==='false'
   &&/^[a-f0-9]{40}$/.test(e.AIHR_REPAIR_IMPACT_BASE??'')&&/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??'')&&e.AIHR_REPAIR_IMPACT_BASE!==e.AIHR_CI_HEAD;
  const focused=e.GITHUB_JOB==='selected-tests'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_WORKFLOW_REF?.startsWith('StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/')&&e.AIHR_FOCUSED_SUITE_CAPACITY==='true';
  assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_RUN_ATTEMPT==='1'&&(normal||pilot||focused||impact),'Suite capacity requires exact first-attempt managed suite or explicit standard-runner pilot');
  if(focused)for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])assert(e[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Focused capacity preparation must precede any database access');
  if(impact)for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])assert(e[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Repair impact selection cannot reach a database');
  assert(/^[a-f0-9]{40}$/.test(e.GITHUB_SHA??'')&&e.AIHR_CI_CONTROL_HEAD===e.GITHUB_SHA,'Suite capacity controller differs');
  return true;
 }
 assert(['bounded-db-diagnostic','bounded-compiler-diagnostic','bounded-whole-compiler','bounded-next-build-diagnostic','bounded-canonical-build'].includes(profile)
  &&e.GITHUB_ACTIONS==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&(profile==='bounded-whole-compiler'?['workflow_dispatch','push','pull_request'].includes(e.GITHUB_EVENT_NAME):e.GITHUB_EVENT_NAME==='workflow_dispatch'),'Bounded capacity requires actual managed context');
 const prefix='StradaverseHub/ai-hr/.github/workflows/',suffix='@refs/heads/codex/test-suite-efficiency-review-20261025';
 if(profile==='bounded-next-build-diagnostic'){
  assert(e.GITHUB_WORKFLOW_REF===prefix+'alpha-staging-diagnostics.yml'+suffix&&e.GITHUB_JOB==='next-build-cache'&&e.GITHUB_RUN_ATTEMPT==='1'&&['cold','warm','recover'].includes(e.AIHR_NEXT_BUILD_CACHE_MODE)&&e.AIHR_BUILD_DIAGNOSTIC==='transport-producer','Only the explicit bounded application build diagnostic');
  for(const k of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])assert(e[k]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Build diagnostic cannot reach a database');
  return true;
 }
 if(profile==='bounded-db-diagnostic')assert(e.GITHUB_WORKFLOW_REF===prefix+'alpha-staging-db-diagnostics.yml'+suffix,'Bounded DB capacity scope differs');
 else{
  if(profile==='bounded-compiler-diagnostic')assert(e.GITHUB_WORKFLOW_REF===prefix+'alpha-staging-diagnostics.yml'+suffix
   &&e.AIHR_COMPILER_TRANSPORT==='consumer'&&e.AIHR_COMPILER_COMPATIBLE_CHILD==='true','Bounded compiler capacity is only the explicit compatible-child consumer');
  else{
   const normal=e.GITHUB_JOB==='typecheck'&&e.GITHUB_WORKFLOW_REF?.startsWith(prefix+'alpha-staging.yml@refs/');
   const pilot=e.GITHUB_JOB==='compiler-cache-pilot'&&e.GITHUB_WORKFLOW_REF===prefix+'alpha-staging-diagnostics.yml'+suffix&&e.AIHR_COMPILER_CACHE_PILOT==='true';
   assert((normal||pilot)&&e.AIHR_COMPILER_CACHE_MODE==='whole'&&e.GITHUB_RUN_ATTEMPT==='1','Exact first-attempt whole compiler capacity context required');
  }
  for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])
   assert(e[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Compiler capacity cannot reach a database');
 }
 return true;
}
export function compilerSwapFloorKiB(profile,e){
 validateCapacityScope(profile,e);
 assert(['legacy','bounded-compiler-diagnostic','bounded-whole-compiler'].includes(profile),'Compiler swap capacity profile differs');
 // No application build/tests/DB: reserve4GiB swap and leave4GiB for bounded compiler/cache/log output.
 return (profile==='legacy'?20:8)*1024**2;
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
