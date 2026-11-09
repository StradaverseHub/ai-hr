/** Private development-only admission. The reviewed controller must produce both root-owned receipts. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, realpathSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const BASE = 'f07f32dcd0ccaeb6b49d40f2b6c64307b9bf80fc';
export const CANDIDATE = 'f152a15891d1e17d45093b4a1a20bc09b103f532';
export const BASE_ROWS = 726;
export const CANDIDATE_ROWS = 769;
export const BRANCH = 'codex/architecture-streamline-ai-upgrade-witness-20261110';
export const IMAGE = 'postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
export const APP_URL = 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev';
export const OWNER_URL = 'postgres://postgres@127.0.0.1:5433/ai_hr_dev';
export function installFictionalServerOnlyResolution() {
  // The standalone witness needs the real server marker and ordinary React for UI dependencies.
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, specifier === 'server-only'
        ? {...context,conditions:[...context.conditions,'react-server']}
        : context);
    },
  });
}
export function assertPristineAuthTenant(rows,systemTenantId) {
  // Exact fresh migration 0151 sentinel. Demo, lookalike and additional tenants all refuse.
  assert.deepEqual([...rows],[{id:systemTenantId,workosOrgId:'org_system_auth_audit',name:'System (auth audit)'}],
    'Pristine migration-created auth tenant required');
}
export const SOURCE_PINS = Object.freeze({
  prepare: Object.freeze({
    helperSha256: '32aaff3dc2f8a80bfe3e69769422b234e0f607a5dad7c0f4b4cb27e5946a3c54',
    wrapperSha256: '3050abc60faa490cdab416f9aeffc80b0b042daf3891ce2e34fbb42071bc7eec',
    orchestrationSha256: '61f528c2570c90204e739a37652e7e79d6c3fc5905bbf849209d20c66709492a',
  }),
  compare: Object.freeze({
    helperSha256: '188119d957e9a4c074f5070e59a5c616feb4e79e673b289f4bb5957a9c00af1b',
    wrapperSha256: 'eba0c4ce074c5a75a4afaa8c5ed8574223eb21dd557396d92ef3e8abe7e3144b',
    orchestrationSha256: '049d86857e876410905d94f13f717a0a00a5956c9e0166ba4d00376451884504',
  }),
});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = 'StradaverseHub/ai-hr';
const root = '/var/lib/aihr-fictional-upgrade';

export function validateCanonicalAdmission({env, phase, uid, platform, source, witnessSha256, admissionSha256, packet, prerequisite, prerequisiteSha256}) {
  assert((phase === 'prepare' || phase === 'compare') && platform === 'linux' && Number.isSafeInteger(uid) && uid > 0,
    'Dedicated unprivileged Linux witness required');
  const expectedSource = phase === 'prepare' ? BASE : CANDIDATE;
  assert(source === expectedSource && env.AIHR_CI_HEAD === expectedSource, 'Witness source mismatch');
  const controller = env.AIHR_CI_CONTROL_HEAD, run = env.GITHUB_RUN_ID;
  assert(sha(controller) && controller === env.GITHUB_SHA && controller === env.GITHUB_WORKFLOW_SHA && id(run),
    'Reviewed controller/run identity required');
  const required = {
    GITHUB_ACTIONS:'true', CI:'true', RUNNER_ENVIRONMENT:'github-hosted', RUNNER_OS:'Linux', RUNNER_ARCH:'X64',
    GITHUB_REPOSITORY:repository, GITHUB_REPOSITORY_ID:'1333414856', GITHUB_EVENT_NAME:'workflow_dispatch',
    GITHUB_WORKFLOW:'alpha-focused-checks', GITHUB_JOB:'selected-tests', GITHUB_RUN_ATTEMPT:'1',
    GITHUB_REF:'refs/heads/'+BRANCH, GITHUB_WORKFLOW_REF:repository+'/.github/workflows/alpha-focused-checks.yml@refs/heads/'+BRANCH,
    AIHR_AI_UPGRADE_STAGING_ENABLED:'false', AIHR_AI_UPGRADE_PRODUCTION_ENABLED:'false',
    TEST_DATABASE_URL:APP_URL, TEST_MIGRATION_DATABASE_URL:OWNER_URL, NODE_ENV:'test',
  };
  for (const [key,value] of Object.entries(required)) assert.equal(env[key],value,'Witness host or target differs: '+key);
  const expectedKeys = ['admissionSha256','attempt','baseline','candidate','controller','host','kind','phase',
    'prerequisiteSha256','releaseAuthorized','runId','source','version','witnessSha256'].sort();
  assert(packet && Object.keys(packet).sort().join() === expectedKeys.join(), 'Closed owner receipt required');
  assert.deepEqual({
    kind:packet.kind,version:packet.version,releaseAuthorized:packet.releaseAuthorized,phase:packet.phase,
    source:packet.source,baseline:packet.baseline,candidate:packet.candidate,controller:packet.controller,runId:packet.runId,attempt:packet.attempt,
  },{
    kind:'AIHR_FICTIONAL_AI_UPGRADE_DISPOSABLE_CUSTODY',version:1,releaseAuthorized:false,phase,
    source:expectedSource,baseline:BASE,candidate:CANDIDATE,controller,runId:run,attempt:1,
  });
  assert([witnessSha256,admissionSha256,prerequisiteSha256].every(digest)
    && packet.witnessSha256 === witnessSha256 && packet.admissionSha256 === admissionSha256
    && packet.prerequisiteSha256 === prerequisiteSha256, 'Owned source or prerequisite receipt changed');
  const host = packet.host;
  assert(host && Object.keys(host).sort().join() === [
    'containerId','containerName','image','networkPolicy','netNamespace','postmasterEpoch','postgresSystemId','uid',
  ].sort().join(), 'Closed PostgreSQL and network owner required');
  assert(digest(host.containerId) && host.containerName === 'aihr-ci-'+run+'-1-db-1' && host.image === IMAGE
    && host.uid === uid && host.networkPolicy === 'docker-none-loopback-v1'
    && typeof host.netNamespace === 'string' && /^net:\[[1-9][0-9]{0,19}\]$/.test(host.netNamespace)
    && id(host.postgresSystemId) && typeof host.postmasterEpoch === 'string' && /^[1-9][0-9]{9}\.[0-9]{1,6}$/.test(host.postmasterEpoch),
  'PostgreSQL container, birth, UID or egress custody differs');
  assert(prerequisite && prerequisite.kind === 'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES'
    && prerequisite.phase === 'before_initial_candidate_migration' && prerequisite.candidate === expectedSource
    && prerequisite.controller === controller && prerequisite.runId === run && prerequisite.attempt === '1'
    && prerequisite.fixture?.mode === 'focused_disposable' && prerequisite.fixture?.postgres?.session === 'postgres'
    && prerequisite.fixture?.postgres?.current === 'postgres', 'Unrelated role prerequisite receipt');
  for (const [key,value] of Object.entries(SOURCE_PINS[phase])) assert.equal(prerequisite[key],value,'Role prerequisite source differs: '+key);
  return Object.freeze({controller,runId:run,host:Object.freeze({...host}),prerequisiteSha256});
}

export function readCanonicalAdmission({env, phase, uid, platform, source, witnessSha256}) {
  assert((phase === 'prepare' || phase === 'compare') && id(env.GITHUB_RUN_ID), 'Invalid fixed receipt path');
  const dir = join(root,env.GITHUB_RUN_ID);
  for (const path of [root,dir]) {
    const st = lstatSync(path);
    assert(realpathSync(path) === path && st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0,
      'Root-owned receipt directory required');
  }
  const read = suffix => {
    const path = join(dir,phase+suffix), st = lstatSync(path);
    assert(realpathSync(path) === path && st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1
      && (st.mode & 0o777) === 0o444 && st.size > 0 && st.size <= 65536, 'Bounded immutable phase receipt required');
    return readFileSync(path);
  };
  const receiptBytes = read('-roles.json');
  return validateCanonicalAdmission({env,phase,uid,platform,source,witnessSha256,
    admissionSha256:hash(readFileSync(fileURLToPath(import.meta.url))),packet:JSON.parse(read('-custody.json')),
    prerequisite:JSON.parse(receiptBytes),prerequisiteSha256:hash(receiptBytes)});
}
