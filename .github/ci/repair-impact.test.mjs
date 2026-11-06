import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCommittedBlobs,assertRepairRepositoryOrigin} from './repair-impact.mjs';
import {impactDiagnosticRequest} from './repair-impact-diagnostic.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40);
const blob = (id, value) => Buffer.concat([Buffer.from(`${id} blob ${Buffer.byteLength(value)}\n`), Buffer.from(value), Buffer.from('\n')]);
test('Repair impact accepts only the two exact same-repository HTTPS checkout origins',()=>{
  for(const value of ['https://github.com/StradaverseHub/ai-hr','https://github.com/stradaversehub/ai-hr.git'])
    assert.doesNotThrow(()=>assertRepairRepositoryOrigin(value));
  for(const value of [undefined,'','http://github.com/stradaversehub/ai-hr',
    'git@github.com:StradaverseHub/ai-hr.git','https://user@github.com/stradaversehub/ai-hr',
    'https://github.com:443/stradaversehub/ai-hr','https://github.com/stradaversehub/ai-hr/',
    'https://github.com/stradaversehub/ai-hr.git/','https://github.com/stradaversehub/ai-hr?ref=alpha',
    'https://github.com/stradaversehub/ai-hr#ref','https://github.com/stradaversehub/ai-hr-fork',
    'https://example.invalid/stradaversehub/ai-hr.git','https://github.com/stradaversehub/other.git'])
    assert.throws(()=>assertRepairRepositoryOrigin(value));
});
test('Git blob parser binds exact requested identities and UTF-8 byte lengths', () => {
  assert.deepEqual([...decodeCommittedBlobs([a, b], Buffer.concat([blob(a, 'alpha'), blob(b, '中文\nend')]))], [[a, 'alpha'], [b, '中文\nend']]);
});
test('Hosted impact selection requires explicit diagnostic mode and exact first-attempt identities',()=>{
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',AIHR_DIAGNOSTICS_ONLY:'true',
    AIHR_CONTROLLER_ONLY:'false',AIHR_BUILD_ONLY:'false',AIHR_REPAIR_IMPACT_BASE:a,AIHR_CI_HEAD:b,
    AIHR_CI_CONTROL_HEAD:'c'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RUNNER_TEMP:'/tmp/owned-runner'};
  assert.deepEqual(impactDiagnosticRequest(env),{base:a,head:b,controller:'c'.repeat(40),runId:'123',output:'/tmp/owned-runner/repair-impact-diagnostic.json'});
  for(const change of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'pull_request'},{AIHR_DIAGNOSTICS_ONLY:'false'},
    {AIHR_CONTROLLER_ONLY:'true'},{AIHR_BUILD_ONLY:'true'},{AIHR_REPAIR_IMPACT_BASE:b},{AIHR_CI_HEAD:'alpha'},
    {AIHR_CI_CONTROL_HEAD:'C'.repeat(40)},{GITHUB_RUN_ID:'0'},{GITHUB_RUN_ATTEMPT:'2'},{RUNNER_TEMP:'relative'}])
    assert.throws(()=>impactDiagnosticRequest({...env,...change}));
});
test('Missing, reordered, duplicated, non-blob, truncated and appended input refuse', () => {
  for (const [ids, bytes] of [
    [[a, b], blob(a, 'alpha')], [[a, b], Buffer.concat([blob(b, 'beta'), blob(a, 'alpha')])],
    [[a, a], Buffer.concat([blob(a, 'alpha'), blob(a, 'alpha')])],
    [[a], Buffer.from(`${a} commit 0\n\n`)], [[a], blob(a, 'alpha').subarray(0, -2)],
    [[a], Buffer.concat([blob(a, 'alpha'), Buffer.from('unexpected')])],
  ]) assert.throws(() => decodeCommittedBlobs(ids, bytes));
});
