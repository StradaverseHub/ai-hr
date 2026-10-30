/** Fabricated pure test data; never a CI witness or release grant. */
import {createInstallGrant} from './ci-install-grant.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE} from './build-production.mjs';
const sha=c=>c.repeat(40),digest=c=>c.repeat(64),uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export function installationFixture(now=Date.now()){
 const iso=delta=>new Date(now+delta).toISOString();
 const build={format:2,capacityProfile:{...BUILD_CAPACITY_PROFILE},source:sha('a'),controller:sha('b'),runId:123,canonicalCandidateInputsVerified:true,nextBuildId:'new-ci-build',buildRecordId:uuid(1),
  buildSourcePath:'/runner/candidate',runtime:{...STAGING_BUILD_RUNTIME},archiveBytes:100,...Object.fromEntries(['provenanceSha256','archiveSha256','manifestSha256','preparedSha256','successfulObservationSha256','lockSha256','packageSha256'].map(k=>[k,digest('c')]))};
 const evidence={policyVersion:CI_POLICY,result:'PASS',tier:'ci',sha:sha('a'),controller:sha('b'),controllerBranch:'alpha',baseline:sha('d'),runId:123,fingerprint:digest('e'),build,artifacts:[{name:BUILD_ARTIFACT,id:456,digest:'sha256:'+digest('f')}]};
 const run={id:123,head_sha:sha('b'),status:'completed',conclusion:'success',run_attempt:1,repository:{id:1333414856},head_repository:{id:1333414856},created_at:iso(-240000)};
 const producer={name:'build',run_id:123,run_attempt:1,head_sha:sha('b'),conclusion:'success',started_at:iso(-220000),completed_at:iso(-1000)};
 const input={evidence,run,producer,baselineBuildId:'previous-build',environmentSha256:digest('0'),now};
 return {...input,grant:createInstallGrant(input)};
}
