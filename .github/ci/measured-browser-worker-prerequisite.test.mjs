import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readMeasuredPreflightArchiveRefusalStage } from './measured-browser-preflight-archive.mjs';
import { encodeMeasuredWorkerPrerequisite } from './measured-browser-worker-prerequisite.mjs';

const row = {
  kind: 'AUTHENTICATED_FULL_DEVELOPMENT_PREFLIGHT_SCOPE_ONLY', releaseEligible: false,
  source: 'a'.repeat(40), runId: 100, resolveJobId: 200, selectedJobId: 201, artifactId: 300,
  archiveSha256: 'b'.repeat(64), captureSha256: 'c'.repeat(64), renderedUnionSha256: 'd'.repeat(64),
  harnessSha256: 'e'.repeat(64), scenarioSha256: 'f'.repeat(64),
};

test('worker prerequisite transport carries a canonical single line with an exact byte seal', () => {
  const reversed = Object.fromEntries(Object.entries(row).reverse());
  const transport = encodeMeasuredWorkerPrerequisite(reversed);
  assert.deepEqual(transport, encodeMeasuredWorkerPrerequisite(row));
  const bytes = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
  assert.deepEqual(Buffer.from(transport.admission, 'base64'), bytes);
  assert.match(transport.admission, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(transport.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('worker prerequisite transport refuses extra data, incomplete scope or unbounded values', () => {
  const { archiveSha256, ...incomplete } = row;
  for (const refused of [incomplete, ...[
    { token: 'secret' }, { url: 'https://example.invalid' }, { releaseEligible: true }, { runId: 0 },
    { artifactId: Number.MAX_SAFE_INTEGER + 1 }, { source: 'a'.repeat(39) + '\n' },
    { captureSha256: 'a'.repeat(63) + '\n' }, { selectedJobId: row.resolveJobId },
  ].map(patch => ({ ...row, ...patch }))]) {
    assert.throws(() => encodeMeasuredWorkerPrerequisite(refused), /summary refused/);
  }
});

test('unbound CLI exits without a transport or exposed provider diagnostics', () => {
  const path = fileURLToPath(new URL('./measured-browser-worker-prerequisite.mjs', import.meta.url));
  const env = { PATH: '/usr/bin:/bin', GH_TOKEN: 'fictional-token-must-stay-private' };
  for (const [args, expectedStage] of [[[], 'provider archive (runner-directory)'], [['--alternate-api'], 'dispatch']]) {
    assert.throws(() => execFileSync(process.execPath, [path, ...args], {
      env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }), error => error.status === 1 && error.stdout === ''
      && error.stderr === `Measured worker prerequisite refused during ${expectedStage}\n`);
  }
});

test('provider refusal stages distinguish event custody and contract without accepting forged tags', () => {
  const path = fileURLToPath(new URL('./measured-browser-worker-prerequisite.mjs', import.meta.url));
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'worker-prerequisite-test-'));
  try {
    const events = join(temp, '_github_workflow');
    const eventPath = join(events, 'event.json');
    const env = { PATH: '/usr/bin:/bin', GH_TOKEN: 'fictional-token-must-stay-private', RUNNER_TEMP: temp, GITHUB_EVENT_PATH: eventPath };
    function refuses(stage) {
      assert.throws(() => execFileSync(process.execPath, [path], {
        env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      }), error => error.status === 1 && error.stdout === ''
        && error.stderr === `Measured worker prerequisite refused during provider archive (${stage})\n`);
    }
    refuses('event-custody');
    mkdirSync(events, { mode: 0o700 });
    writeFileSync(eventPath, '{"private":"must-stay-private"}', { mode: 0o600 });
    refuses('dispatch-contract');
    assert.equal(readMeasuredPreflightArchiveRefusalStage({ stage: 'archive-transfer' }), null);
    assert.equal(readMeasuredPreflightArchiveRefusalStage(new Error('Measured preflight provider archive refused')), null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
