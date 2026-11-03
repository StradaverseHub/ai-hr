import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SELECTION, canonicalJson, digest } from './cleanup-only-recovery-policy.mjs';
import { runCleanupOnlySession } from './cleanup-only-recovery-session.mjs';
import { acquireNormalCleanupLock, durableCleanupRecord, readSingleCleanupCommit } from './normal-cleanup-io.mjs';

const journalNames = [
  'cleanup-authorized.json', 'cleanup-intent.json', 'cleanup-result.json',
  ...['ready', 'commit', 'consumed', 'owned-cleanup'].map(name => 'normal-cleanup-' + name + '.json'),
  ...['ready', 'commit', 'consumed', 'owned-cleanup', 'result', 'failure'].map(name => 'replan-recovery-' + name + '.json'),
];

export async function runJournaledRecovery({directory, input, output, assertLease, ...ports}) {
  assertLease(SELECTION);
  const release = acquireNormalCleanupLock(join(directory, 'normal-cleanup.lock'), {
    source: SELECTION.source, installId: SELECTION.installId, pid: process.pid,
  });
  const persist = (name, value) => durableCleanupRecord(join(directory, 'replan-recovery-' + name + '.json'), value);
  let admitted = false;
  try {
    for (const name of journalNames) {
      assert(!lstatSync(join(directory, name), {throwIfNoEntry: false}), 'Prior cleanup journal requires reconciliation');
    }
    admitted = true;
    const result = await runCleanupOnlySession({
      ...ports,
      fences: async () => {
        assertLease(SELECTION);
        return ports.fences();
      },
      audit: async () => {
        assertLease(SELECTION);
        const runtime = await ports.audit();
        assertLease(SELECTION);
        return runtime;
      },
      persist,
      consume: async ready => persist('consumed', {readySha256: digest(ready)}),
      io: {
        ready: ready => new Promise((resolve, reject) => {
          output.write(canonicalJson(ready) + '\n', error => error ? reject(error) : resolve());
        }),
        commit: () => readSingleCleanupCommit(input),
      },
    });
    return result;
  } catch (error) {
    if (admitted) {
      try {
        persist('failure', {kind: 'RECONCILE_BEFORE_RETRY', certificateSha256: digest(ports.certificate)});
      } catch (journalError) {
        throw new AggregateError([error, journalError], 'Recovery and failure journaling failed');
      }
    }
    throw error;
  } finally {
    release();
  }
}
