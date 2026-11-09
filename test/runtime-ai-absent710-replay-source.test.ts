/** Focused hosted selector for the existing filesystem-only replay controls. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const expectedResults = [
  'ok 1 - reads the whole selected alpha prefix with the two exact installation originals',
  'ok 2 - refuses drifted ordering, changed canonical or archived bytes and a linked source path',
];
const expectedSummary = [
  '1..2', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
];

it('executes both fixed absent-role replay source controls in one bounded Node process', () => {
  const result = spawnSync(process.execPath, [
    '--test', '--experimental-test-isolation=none', '--test-reporter=tap',
    '.github/ci/ai-absent710-replay-source.test.mjs',
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    killSignal: 'SIGKILL',
    maxBuffer: 65536,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr.length).toBe(0);

  const lines = result.stdout.split('\n');
  expect(lines[0]).toBe('TAP version 13');
  const outcomes = lines.filter(line => /^\s*(?:not )?ok\b/.test(line));
  const summary = lines.filter(line => /^\s*(?:\d+\.\.\d+|# (?:tests|suites|pass|fail|cancelled|skipped|todo)\b)/.test(line));
  expect(outcomes).toEqual(expectedResults);
  expect(summary).toEqual(expectedSummary);
  process.stdout.write([...outcomes, ...summary].join('\n') + '\n');
}, 20000);
