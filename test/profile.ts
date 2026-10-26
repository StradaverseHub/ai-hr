/** Opt-in timing only: never records SQL, inputs, identities, results or error messages. */
import {appendFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
export type TestProfilePhase = 'reset' | 'seed' | 'close' | 'template-setup' | 'template-migrate' | 'worker-clone';
let warned = false;
export async function profileTestPhase<T>(phase: TestProfilePhase, operation: () => Promise<T>): Promise<T> {
  const directory = process.env.AIHR_TEST_PROFILE_DIR;
  if (!directory) return operation();
  const started = performance.now(); let status: 'passed' | 'failed' = 'passed';
  try { return await operation(); }
  catch (error) { status = 'failed'; throw error; }
  finally {
    const durationMs = performance.now() - started;
    try {
      mkdirSync(directory, {recursive: true, mode: 0o700});
      const worker = String(process.env.VITEST_POOL_ID ?? 'setup').replace(/[^a-zA-Z0-9_-]/g, '_');
      appendFileSync(join(directory, `profile-${process.pid}-${worker}.jsonl`), JSON.stringify({
        schemaVersion: 1, phase, status, durationMs, pid: process.pid, worker,
        label: process.env.AIHR_TEST_PROFILE_LABEL ?? 'selected-tests',
        candidate: process.env.AIHR_CI_HEAD ?? null,
      }) + '\n', {encoding: 'utf8', mode: 0o600});
    } catch {
      if (!warned) { warned = true; console.warn('[test-profile] Timing output unavailable; measurement is incomplete.'); }
    }
  }
}
