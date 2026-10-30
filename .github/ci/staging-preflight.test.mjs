/** Execute the actual candidate guard body with private fixture environment; no SSH or app runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,constants} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {customerEnvironmentErrors} from '../../deploy/check-customer-env.mjs';
import {STAGING_BUILD_RUNTIME as runtime} from './build-production.mjs';
import {stagingProfileProbeCommand,validateStagingProfile,DEPLOY_RUNTIME_SELECTION,validateCandidateRuntimeSelection} from './staging-preflight.mjs';
const fixture={NODE_ENV:'production',AUTH_PROVIDER:'internal',ALLOW_DEMO_SESSION:'false',AUTH_PUBLIC_ORIGIN:'https://hr.customer.org',AUTH_SESSION_KEY:'a'.repeat(64),AI_CONFIG_SECRET:'private-fixture-config-value',AUDIT_HASH_CHAIN_ENABLED:'true',DATABASE_URL:'postgres://ai_hr_app:private-fixture-db@127.0.0.1/hr',MIGRATION_DATABASE_URL:'postgres://ai_hr_owner:private-fixture-owner@127.0.0.1/hr'};
function observe(changes={},observedRuntime=runtime){
 const command=stagingProfileProbeCommand(customerEnvironmentErrors),delimiter="<<'AIHR_PROFILE_PREFLIGHT_NODE'\n";
 assert.equal(command.split(delimiter).length,2);const source=command.split(delimiter)[1].split('\nAIHR_PROFILE_PREFLIGHT_NODE')[0];
 assert(source.startsWith("import {accessSync,constants,realpathSync,readFileSync} from 'node:fs';import path from 'node:path';\n"));
 let output;
 runInNewContext(source.slice(source.indexOf('\n')+1),{URL,path,constants,accessSync:()=>{const e=new Error('absent fixture file');e.code='ENOENT';throw e;},readFileSync:()=>JSON.stringify({version:observedRuntime.next}),process:{env:{...fixture,...changes},cwd:()=>'/private-fixture',platform:observedRuntime.platform,arch:observedRuntime.arch,versions:{node:observedRuntime.node,modules:observedRuntime.abi},report:{getReport:()=>({header:{glibcVersionRuntime:observedRuntime.glibc}})}},console:{log:value=>{assert.equal(output,undefined);output=value;}}});
 assert(typeof output==='string');return {command,report:JSON.parse(output),output};
}
test('actual Node20/customer gap is reproduced before artifact or source work',()=>{
 const {report,output}=observe({DEV_TENANT_ID:'fixture-tenant',DEV_USER_ID:'fixture-user',AUDIT_HASH_CHAIN_ENABLED:undefined},{...runtime,node:'20.20.2',abi:'115'});
 assert.equal(report.ok,false);assert.equal(report.profile,'customer');
 assert(report.errors.some(e=>e.includes('Node.js 22.13+')));assert(report.errors.some(e=>e.includes('DEV_TENANT_ID')));assert(report.errors.some(e=>e.includes('DEV_USER_ID')));assert(report.errors.some(e=>e.includes('AUDIT_HASH_CHAIN_ENABLED')));
 assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors),/before CI archive download\/source transfer/);
 for(const secret of [fixture.DATABASE_URL,fixture.MIGRATION_DATABASE_URL,fixture.AUTH_SESSION_KEY,fixture.AI_CONFIG_SECRET])assert(!output.includes(secret));
});
test('demo branch matches actual default deploy predicate and never grants release authority',()=>{
 const {command,report}=observe({ALLOW_DEMO_SESSION:'true'});assert.equal(report.profile,'demo');assert.equal(report.ok,true);assert.equal(report.releaseAuthorized,false);
 assert.equal(validateStagingProfile(report,customerEnvironmentErrors),report);
 assert(command.includes('set -a\n. ./.env.production\nset +a\nnode'));assert(command.includes(DEPLOY_RUNTIME_SELECTION));assert(command.startsWith("bash -s <<'AIHR_PROFILE_PREFLIGHT_SHELL'"));assert(!command.includes('--env-file'));assert(!command.includes('deploy-state.sh'));
});
for(const [name,change] of [['unknown field',r=>r.secret='bad'],['wrong checker',r=>r.checkerSha256='f'.repeat(64)],['wrong native runtime',r=>r.runtime.abi='115'],['invented pass',r=>{r.errors=['actual refusal'];r.ok=true;}],['invented release',r=>r.releaseAuthorized=true],['unknown profile',r=>r.profile='bypass']])test('refuse '+name,()=>{const {report}=observe({ALLOW_DEMO_SESSION:'true'});change(report);assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors));});
test('normal, unchanged-source and repaired-source operators await profile before archives and repeat it before launch',()=>{
 const source=readFileSync(new URL('./operator-release.mjs',import.meta.url),'utf8');
 const early='const profilePreflight=await probeStagingProfile({candidatePath,ssh});',verify='const evidence=repair?await verifyRepairedCi({...repair,candidatePath,runId,baseline}):recovering?await verifyRecoveredCi({candidatePath,runId,baseline,focusedRunIds:recoveryRunIds}):await verifyCi({candidatePath,runId,baseline});';
 assert.equal(source.split(early).length,2);assert.equal(source.split(verify).length,2);assert(source.indexOf(early)>=0&&source.indexOf(early)<source.indexOf(verify));
 assert(source.includes('const revalidate=async({announced=false}={})=>{await probeStagingProfile({candidatePath,ssh});await (repair?revalidateRepairedCi(evidence):recovering?revalidateRecoveredCi(evidence):revalidateCi(evidence));'));
});

test('CI runtime branch is line-anchored and refuses a default-only substring match',()=>{const source=readFileSync(new URL('../../deploy/deploy.sh',import.meta.url),'utf8');assert.doesNotThrow(()=>validateCandidateRuntimeSelection(source));const marker='if [ -n "$AIHR_SELECTED_CI_BUILD_INSTALL" ]; then';assert(source.includes(marker));assert.throws(()=>validateCandidateRuntimeSelection(source.replace(marker,'elif [ -n "$AIHR_SELECTED_CI_BUILD_INSTALL" ]; then')));});
test('early probe mirrors the CI-specific pinned runtime branch, not the default runtime preference',()=>{const command=stagingProfileProbeCommand(customerEnvironmentErrors);assert(command.includes('CI build installation requires its pinned Node22 runtime'));});

test('valid customer fixture accepts only the exact future native target',()=>{const {report}=observe();assert.equal(report.profile,'customer');assert.equal(report.ok,true);assert.equal(validateStagingProfile(report,customerEnvironmentErrors),report);});
