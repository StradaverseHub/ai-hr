import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectMeasuredPreflightArchiveBytes, readAuthenticatedMeasuredPreflightArchive } from './measured-browser-preflight-archive.mjs';

const source = 'a'.repeat(40);
const runId = 100;
const identity = { candidateSha: source, controllerSha: source, runId, runAttempt: 1 };
const digests = { harnessSha256: 'b'.repeat(64), scenarioSha256: 'c'.repeat(64) };
const receiptName = 'browser-preflight-measurement.json';
const captureName = 'navigation-browser-capture.json';
const unionName = 'development-rendered-route-union.json';
const protocol = 'aihr-navigation-development/v2';
const json = value => JSON.stringify(value) + '\n';
const seal = value => ({ sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) });

function model() {
  const capture = json({
    schemaVersion: 1, protocol, releaseAuthorized: false,
    baseline: {
      schemaVersion: 1, protocol, releaseAuthorized: false, ...identity, ...digests, complete: true,
      phase: 'baseline', engine: 'chromium', fixture: 'system-load-v1', observations: [{ example: true }],
    },
  });
  const renderedUnion = json({
    kind: 'DEVELOPMENT_RENDERED_ROUTE_UNION_V1', ...identity, ...digests, complete: true,
    releaseEligible: false, protectedNative: false, dynamicNavigationComplete: false, observations: [{ example: true }],
  });
  return {
    [receiptName]: json({
      kind: 'DEVELOPMENT_BROWSER_MEASURED_COURSE_V2', version: 2, course: 'preflight-2', suite: 'workflow-preflight',
      complete: true, releaseEligible: false, courseOutcome: 'success', terminalReceipt: 'observed', driverReceipt: 'observed',
      source: identity, capture: { ...seal(capture), ...digests }, renderedUnion: seal(renderedUnion),
      postgresWaitLogCoverage: {
        kind: 'development-heavyweight-lock-log', thresholdMs: 100, retainedFailures: 0, databaseBackendsSettled: true,
      },
    }),
    [captureName]: capture, [unionName]: renderedUnion,
    'fixture.json': json({ fictional: true, claimsPerEmployee: 200, counts: { claims: 100000 } }),
    'actor-tenancy.json': json({ fictional: true, trafficActors: 500, nativeSelectedRows: 500, nativeGrants: 544 }),
    'postgres-lock-failures.json': json({ failures: [] }),
    'server-native-failures.json': json({ failures: [] }),
  };
}

const writeZip = String.raw`
import io, json, stat, sys, zipfile

class Streaming(io.BytesIO):
    def seek(self, *args):
        raise OSError('stream is not seekable')

settings = json.load(sys.stdin)
output = Streaming() if settings['streaming'] else io.BytesIO()
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, text, mode in settings['rows']:
        info = zipfile.ZipInfo(name)
        info.compress_type = zipfile.ZIP_DEFLATED if settings['deflate'] else zipfile.ZIP_STORED
        info.external_attr = ((stat.S_IFLNK if mode == 'symlink' else stat.S_IFREG) | 0o600) << 16
        archive.writestr(info, text)
sys.stdout.buffer.write(output.getvalue())
`;

function zip(files, { extra = [], streaming = false, deflate = true } = {}) {
  const rows = [...Object.entries(files).map(([name, text]) => [name, text, 'regular']), ...extra];
  return execFileSync('/usr/bin/python3', ['-I', '-B', '-c', writeZip], {
    input: JSON.stringify({ rows, streaming, deflate }), maxBuffer: 8 * 1024 ** 2, timeout: 5000, killSignal: 'SIGKILL',
  });
}

const inspect = bytes => inspectMeasuredPreflightArchiveBytes(bytes, { source, runId });
function changeReceipt(files, patch) {
  files[receiptName] = json({ ...JSON.parse(files[receiptName]), ...patch });
  return files;
}

test('reads bounded stored and publisher-style streaming ZIP members without a path', () => {
  for (const options of [{ deflate: false }, { streaming: true }]) {
    const files = model();
    const data = inspect(zip(files, options));
    assert.equal(data.measurement.capture.sha256, seal(files[captureName]).sha256);
    assert.equal(data.renderedUnion.runId, runId);
    assert.equal(data.actors.nativeGrants, 544);
    assert.equal(readAuthenticatedMeasuredPreflightArchive(data), undefined);
  }
});

test('refuses missing, mixed raw or failed archive members and path aliases', () => {
  const withoutUnion = model();
  delete withoutUnion[unionName];
  assert.throws(() => inspect(zip(withoutUnion)), /ZIP refused/);
  for (const name of ['runner.json', 'http-browser.json', 'browser-preflight-failure.json', './fixture.json', 'nested/fixture.json']) {
    assert.throws(() => inspect(zip(model(), { extra: [[name, '{}', 'regular']] })), /ZIP refused/);
  }
  assert.throws(() => inspect(zip(model(), { extra: [['fixture.json', '{}', 'regular']] })), /ZIP refused/);
  assert.throws(() => inspect(zip(withoutUnion, { extra: [[unionName, 'elsewhere', 'symlink']] })), /ZIP refused/);
});

test('requires both empty native failure members and admits only settled optional fixture phases', () => {
  const files = model();
  files['fixture-phases.json'] = json([{ status: 'passed' }]);
  files['server-native-failures.json'] = json({ failures: [] });
  files['postgres-lock-failures.json'] = json({ failures: [] });
  const result = inspect(zip(files));
  assert.equal(result.measurement.complete, true);
  assert.deepEqual(result.postgresFailures.failures, []);
  assert.deepEqual(result.workerFailures.failures, []);
  for (const name of ['postgres-lock-failures.json', 'server-native-failures.json']) {
    const missing = { ...files };
    delete missing[name];
    assert.throws(() => inspect(zip(missing)), /ZIP refused/);
  }
  assert.throws(() => inspect(zip({ ...files, 'postgres-lock-failures.json': json({ failures: [{}] }) })), /ZIP refused/);
  assert.throws(() => inspect(zip({ ...files, 'fixture-phases.json': json([{ status: 'running' }]) })), /ZIP refused/);
});

test('refuses trailing, prefixed and concatenated ZIPs and corrupt compressed bytes', () => {
  const original = zip(model(), { streaming: true });
  assert.throws(() => inspect(Buffer.concat([original, Buffer.from('trailing')])), /ZIP refused/);
  assert.throws(() => inspect(Buffer.concat([Buffer.from('prefix'), original])), /ZIP refused/);
  assert.throws(() => inspect(Buffer.concat([original, original])), /ZIP refused/);
  const changed = Buffer.from(original);
  changed[30 + changed.readUInt16LE(26) + 1] ^= 255;
  assert.throws(() => inspect(changed), /ZIP refused/);
});

test('requires bounded strict JSON without duplicate keys or nonfinite numbers', () => {
  const dup = model();
  dup[receiptName] = dup[receiptName].replace('"complete":true', '"complete":false,"complete":true');
  assert.throws(() => inspect(zip(dup)), /ZIP refused/);
  const infinite = model();
  infinite['fixture.json'] = '{"fictional":true,"invalid":1e999}';
  assert.throws(() => inspect(zip(infinite)), /ZIP refused/);
  const oversized = model();
  oversized[receiptName] = json({ large: 'x'.repeat(8192) });
  assert.throws(() => inspect(zip(oversized)), /ZIP refused/);
});

test('rejects V1, downstream, incomplete and failed or unqualified terminal envelopes', () => {
  for (const patch of [
    { kind: 'DEVELOPMENT_BROWSER_PREFLIGHT_MEASUREMENT_V1', version: 1 },
    { course: 'functional-8' }, { course: 'steady-2' }, { complete: false }, { courseOutcome: 'failure' },
    { terminalReceipt: 'absent' }, { driverReceipt: 'refused' }, { releaseEligible: true },
  ]) assert.throws(() => inspect(zip(changeReceipt(model(), patch))), /terminal receipt refused/);
  for (const postgresWaitLogCoverage of [null, {
    kind: 'development-heavyweight-lock-log', thresholdMs: 100, retainedFailures: 1, databaseBackendsSettled: true,
  }]) assert.throws(() => inspect(zip(changeReceipt(model(), { postgresWaitLogCoverage }))), /log envelope refused/);
});

test('checks exact seals before trusting either baseline or route union', () => {
  for (const name of [captureName, unionName]) {
    const files = model();
    files[name] = files[name].replace('"example":true', '"changed":true');
    assert.throws(() => inspect(zip(files)), /byte seal refused/);
  }
  const files = model();
  changeReceipt(files, { renderedUnion: { ...seal(files[unionName]), bytes: Buffer.byteLength(files[unionName]) + 1 } });
  assert.throws(() => inspect(zip(files)), /byte seal refused/);
});

test('refuses mixed source or run even when replacement seals match the bytes', () => {
  const files = model();
  files[unionName] = json({ ...JSON.parse(files[unionName]), runId: runId + 1 });
  changeReceipt(files, { renderedUnion: seal(files[unionName]) });
  assert.throws(() => inspect(zip(files)), /capture source refused/);
  assert.throws(() => inspectMeasuredPreflightArchiveBytes(zip(model()), { source: 'd'.repeat(40), runId }), /terminal receipt refused/);
});

test('failure-only projection closes first-probe lock categories, workload stages and monotonic gap durations', () => {
  // Compile only the actual pure Python projection functions from the workflow.
  const control = String.raw`
import ast, re, sys, textwrap
from pathlib import Path

workflow = Path(sys.argv[1]).read_text()
script = next(block for block in re.findall(r"<<'PYTHON'\n(.*?)^          PYTHON$", workflow, re.S | re.M)
              if 'def project_first_app_lock_wait_categories' in block)
definitions = ast.parse(textwrap.dedent(script))
names = {'record', 'closed', 'choice', 'number', 'project_first_app_lock_wait_categories', 'project_private_preflight_timing',
         'project_lock_workload_stage', 'project_sampled_waiter', 'project_sampled_blocker'}
constants = {'lock_families', 'sampled_advisory_families', 'sampled_advisory_modes', 'sampled_audit_query_categories'}
body = [node for node in definitions.body
        if isinstance(node, ast.FunctionDef) and node.name in names
        or isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in constants]
assert {node.name for node in body if isinstance(node, ast.FunctionDef)} == names
assert {node.targets[0].id for node in body if isinstance(node, ast.Assign)} == constants
exec(compile(ast.Module(body=body, type_ignores=[]), 'workflow-projections', 'exec'))
kinds = dict(advisory=1, transactionid=2, tuple=0, relation=1, other=1)
assert project_first_app_lock_wait_categories(kinds, 5) == kinds
for malformed in (None, dict(kinds, other=0), dict(kinds, advisory=True), dict(kinds, other=-1),
                  dict(kinds, native_id=123), dict(kinds, advisory=6), dict(kinds, other=1.0)):
    assert project_first_app_lock_wait_categories(malformed, 5) is None
assert project_first_app_lock_wait_categories(kinds, True) is None
assert project_first_app_lock_wait_categories(kinds, 0) is None
assert project_first_app_lock_wait_categories(kinds, 1025) is None
for valid in ('payroll-close-pair', 'ai-baseline', 'transition'):
    assert project_lock_workload_stage(valid, 'browser-workflows') == valid
    assert project_lock_workload_stage(valid, 'pilot-http') is None
    assert project_lock_workload_stage(valid, 'transition') is None
for unsafe in (None, 'payroll-close-pair/tenant123', '/admin/personnel', 'select * from hr', {'actor': 1}):
    assert project_lock_workload_stage(unsafe, 'browser-workflows') is None

waiter = dict(family='audit-chain', mode='ExclusiveLock')
edge = dict(source='original-sample', family='audit-chain', waiterMode='ExclusiveLock', blockerMode='ExclusiveLock',
            blockerState='granted', waiterCategory='auth-audit-append', blockerCategory='rewards-access-observe')
for category in ('auth-audit-append', 'rewards-access-observe', 'audit-append'):
    assert project_sampled_waiter(dict(waiter, category=category, pid=123)) == dict(waiter, category=category)
assert project_sampled_waiter(dict(waiter, category='private SQL')) == waiter
assert project_sampled_waiter(dict(waiter, family='access-configuration', category='auth-audit-append')) == dict(waiter, family='access-configuration')
assert project_sampled_blocker(dict(edge, query='private SQL', pid=123)) == edge
assert project_sampled_blocker(dict(edge, source='recheck')) is None
assert project_sampled_blocker(dict(edge, family='access-configuration')) is None
assert project_sampled_blocker(dict(edge, blockerCategory='private SQL')) is None

timing = dict(attemptIntervalMs=200, gapUs=508264, openingGapUs=209731, tailGapUs=130623,
              launchSpacingUs=496000, serialWaitPastDueUs=0, timerAfterReadyUs=296000,
              callbackToProbeUs=1, activityRoundTripUs=4000, betweenProbesUs=1, advisoryRoundTripUs=8263)
cadence = dict(interiorGapUs=508264, openingGapUs=209731, tailGapUs=130623)
assert project_private_preflight_timing(timing, cadence) == timing
fast_timing = dict(timing, attemptIntervalMs=125)
assert project_private_preflight_timing(fast_timing, cadence) == fast_timing
assert project_private_preflight_timing(dict(timing, attemptIntervalMs=126), cadence) is None
assert project_private_preflight_timing(dict(timing, advisoryRoundTripUs=8266), cadence) is not None
for malformed in (None, dict(timing, timestamp=1700000000000), dict(timing, activityRoundTripUs=-1),
                  dict(timing, advisoryRoundTripUs=8267), dict(timing, advisoryRoundTripUs=8261),
                  dict(timing, gapUs=500000), dict(timing, attemptIntervalMs=250),
                  dict(timing, betweenProbesUs=True), dict(timing, timerAfterReadyUs=910000001)):
    assert project_private_preflight_timing(malformed, cadence) is None
assert project_private_preflight_timing(timing, dict(cadence, interiorGapUs=None)) is None
assert project_private_preflight_timing(timing, dict(cadence, openingGapUs=209732)) is None

historical = dict(attemptIntervalMs=125, gapUs=582628, openingGapUs=132376, tailGapUs=75333,
                  launchSpacingUs=125442, serialWaitPastDueUs=0, timerAfterReadyUs=447, callbackToProbeUs=21,
                  activityRoundTripUs=122668, betweenProbesUs=1, advisoryRoundTripUs=334518)
assert project_private_preflight_timing(historical, dict(interiorGapUs=582628, openingGapUs=132376, tailGapUs=75333)) == historical

combined = dict(attemptIntervalMs=125, gapUs=500001, openingGapUs=125000, tailGapUs=375001,
                launchSpacingUs=125000, serialWaitPastDueUs=0, timerAfterReadyUs=0,
                callbackToProbeUs=0, probeMode='combined-statement', combinedRoundTripUs=375001)
combined_cadence = dict(interiorGapUs=500001, openingGapUs=125000, tailGapUs=375001)
assert project_private_preflight_timing(combined, combined_cadence) == combined
for rounding in (375000, 375002):
    assert project_private_preflight_timing(dict(combined, combinedRoundTripUs=rounding), combined_cadence) is not None
for malformed in (dict(combined, combinedRoundTripUs=374999), dict(combined, combinedRoundTripUs=375003),
                  dict(combined, combinedRoundTripUs=True), dict(combined, probeMode='two-statements'),
                  dict(combined, probeMode='/private/source'), dict(combined, activityRoundTripUs=375001),
                  dict(combined, advisoryRoundTripUs=0), {k: v for k, v in combined.items() if k != 'probeMode'}):
    assert project_private_preflight_timing(malformed, combined_cadence) is None
assert project_private_preflight_timing(combined, dict(combined_cadence, interiorGapUs=500000)) is None
assert project_private_preflight_timing(combined, None) is None
`;
  execFileSync('/usr/bin/python3', ['-I', '-B', '-c', control,
    fileURLToPath(new URL('../workflows/alpha-focused-checks.yml', import.meta.url))], { timeout: 5000 });
});
