import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('accepts only settled optional diagnostics in a successful archive', () => {
  const files = model();
  files['fixture-phases.json'] = json([{ status: 'passed' }]);
  files['server-native-failures.json'] = json({ failures: [] });
  files['postgres-lock-failures.json'] = json({ failures: [] });
  assert.equal(inspect(zip(files)).measurement.complete, true);
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
