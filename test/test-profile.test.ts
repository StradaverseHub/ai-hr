import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {profileTestPhase} from './profile';
const original = process.env.AIHR_TEST_PROFILE_DIR;
const directories: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.AIHR_TEST_PROFILE_DIR; else process.env.AIHR_TEST_PROFILE_DIR = original;
  vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});
const prepare = () => { const directory = mkdtempSync(join(tmpdir(), 'aihr-test-profile-')); directories.push(directory); process.env.AIHR_TEST_PROFILE_DIR = directory; return directory; };
it('disabled instrumentation calls the operation once and preserves its exact result', async () => {
  delete process.env.AIHR_TEST_PROFILE_DIR; const value = {result: 'unchanged'}, operation = vi.fn(async () => value);
  expect(await profileTestPhase('reset', operation)).toBe(value); expect(operation).toHaveBeenCalledTimes(1);
});
it('enabled instrumentation records durations without recording returned or private operation data', async () => {
  const directory = prepare(), value = {privateMarker: 'MUST_NOT_BE_RECORDED'};
  expect(await profileTestPhase('seed', async () => value)).toBe(value);
  const contents = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('');
  const row = JSON.parse(contents); expect(row.phase).toBe('seed'); expect(row.status).toBe('passed');
  expect(Number.isFinite(row.durationMs)).toBe(true); expect(row.durationMs).toBeGreaterThanOrEqual(0);
  expect(contents).not.toContain('MUST_NOT_BE_RECORDED');
});
it('an operation failure keeps the original error identity and does not write its message', async () => {
  const directory = prepare(), error = new Error('PRIVATE_ERROR_NOT_FOR_PROFILE');
  await expect(profileTestPhase('reset', async () => {throw error;})).rejects.toBe(error);
  const contents = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('');
  expect(JSON.parse(contents).status).toBe('failed'); expect(contents).not.toContain(error.message);
});
it('unavailable measurement output cannot replace a successful result or original failure', async () => {
  const directory = prepare(), blocked = join(directory, 'not-a-directory'); writeFileSync(blocked, 'blocked');
  process.env.AIHR_TEST_PROFILE_DIR = blocked; const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const value = {}; expect(await profileTestPhase('seed', async () => value)).toBe(value);
  const error = new Error('original'); await expect(profileTestPhase('reset', async () => {throw error;})).rejects.toBe(error);
  expect(warning).toHaveBeenCalledWith('[test-profile] Timing output unavailable; measurement is incomplete.');
});
