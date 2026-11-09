import assert from 'node:assert/strict';
import {test} from 'node:test';
import {APP_URL,BASE,BRANCH,CANDIDATE,IMAGE,OWNER_URL,SOURCE_PINS,validateCanonicalAdmission} from './fictional-ai-upgrade-canonical-admission.mjs';

const control = 'c'.repeat(40), run = '12345', repo = 'StradaverseHub/ai-hr';
function fixture(phase) {
  const source = phase === 'prepare' ? BASE : CANDIDATE;
  const env = {
    AIHR_CI_HEAD:source,AIHR_CI_CONTROL_HEAD:control,GITHUB_SHA:control,GITHUB_WORKFLOW_SHA:control,GITHUB_RUN_ID:run,
    GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
    GITHUB_REPOSITORY:repo,GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',
    GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',GITHUB_RUN_ATTEMPT:'1',
    GITHUB_REF:'refs/heads/'+BRANCH,GITHUB_WORKFLOW_REF:repo+'/.github/workflows/alpha-focused-checks.yml@refs/heads/'+BRANCH,
    AIHR_AI_UPGRADE_STAGING_ENABLED:'false',AIHR_AI_UPGRADE_PRODUCTION_ENABLED:'false',
    TEST_DATABASE_URL:APP_URL,TEST_MIGRATION_DATABASE_URL:OWNER_URL,NODE_ENV:'test',
  };
  const witnessSha256='1'.repeat(64), admissionSha256='2'.repeat(64), prerequisiteSha256=(phase === 'prepare' ? '3' : '4').repeat(64);
  const host={containerId:'b'.repeat(64),containerName:'aihr-ci-'+run+'-1-db-1',image:IMAGE,
    networkPolicy:'docker-none-loopback-v1',netNamespace:'net:[4026532456]',
    postmasterEpoch:'1794300000.123456',postgresSystemId:'7559430318764467066',uid:47001};
  const packet={kind:'AIHR_FICTIONAL_AI_UPGRADE_DISPOSABLE_CUSTODY',version:1,releaseAuthorized:false,phase,source,
    baseline:BASE,candidate:CANDIDATE,controller:control,runId:run,attempt:1,witnessSha256,admissionSha256,prerequisiteSha256,host};
  const prerequisite={kind:'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES',phase:'before_initial_candidate_migration',
    candidate:source,controller:control,runId:run,attempt:'1',...SOURCE_PINS[phase],
    fixture:{mode:'focused_disposable',postgres:{session:'postgres',current:'postgres'}}};
  return {env,phase,uid:47001,platform:'linux',source,witnessSha256,admissionSha256,packet,prerequisite,prerequisiteSha256};
}
test('accepts only matching baseline and candidate phase identities',()=>{
  for (const phase of ['prepare','compare']) assert.equal(validateCanonicalAdmission(fixture(phase)).runId,run);
});
for (const [name,mutate] of [
  ['wrong source',x=>{x.source=BASE;}],
  ['mixed workflow controller',x=>{x.env.GITHUB_WORKFLOW_SHA=BASE;}],
  ['retry',x=>{x.env.GITHUB_RUN_ATTEMPT='2';}],
  ['public database',x=>{x.env.TEST_DATABASE_URL='postgres://ai_hr_app@external.example:5433/ai_hr_dev';}],
  ['changed local database',x=>{x.env.TEST_MIGRATION_DATABASE_URL=x.env.TEST_MIGRATION_DATABASE_URL.replace('ai_hr_dev','ai_hr_test');}],
  ['production enabled',x=>{x.env.AIHR_AI_UPGRADE_PRODUCTION_ENABLED='true';}],
  ['foreign controller branch',x=>{x.env.GITHUB_REF='refs/heads/alpha';}],
  ['reused baseline role receipt',x=>{x.prerequisite=fixture('prepare').prerequisite;}],
  ['wrong role source bytes',x=>{x.prerequisite.wrapperSha256='d'.repeat(64);}],
  ['wrong witness bytes',x=>{x.packet.witnessSha256='f'.repeat(64);}],
  ['unfenced network',x=>{x.packet.host.networkPolicy='internet';}],
  ['unsealed network namespace',x=>{x.packet.host.netNamespace='net:[0]';}],
  ['wrong process owner',x=>{x.packet.host.uid=47002;}],
  ['wrong container birth marker',x=>{x.packet.host.postmasterEpoch='unknown';}],
  ['unknown custody payload',x=>{x.packet.extra=true;}],
]) test('refuses '+name,()=>{const x=fixture('compare');mutate(x);assert.throws(()=>validateCanonicalAdmission(x));});
