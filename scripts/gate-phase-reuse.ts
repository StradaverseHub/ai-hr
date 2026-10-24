import { createHash } from 'node:crypto';

export const PHASE_REUSE_POLICY_VERSION = 2;
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('Phase reuse refused: ' + reason);
}
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

export interface PassedPhase {
  files: number;
  tests: number;
}

/** A last-line-only match could accept a failed invocation followed by an unrelated PASS.
 * Require one complete summary, positive test/file counts, and no skipped/todo/failed suites. */
export function passedPhase(log: string, asked: number): PassedPhase {
  const text = plain(log);
  const files = [...text.matchAll(/^\s*Test Files\s+(.+)$/gm)];
  const tests = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)];
  requireProof(Number.isSafeInteger(asked) && asked > 0, 'invalid requested file count');
  requireProof(files.length === 1 && tests.length === 1, 'missing or repeated phase summary');
  const fileMatch = /^(\d+) passed \((\d+)\)\s*$/.exec(files[0][1]);
  const testMatch = /^(\d+) passed \((\d+)\)\s*$/.exec(tests[0][1]);
  requireProof(fileMatch && +fileMatch[1] === asked && +fileMatch[2] === asked, 'incomplete or non-passing file coverage');
  requireProof(testMatch && +testMatch[1] > 0 && testMatch[1] === testMatch[2], 'incomplete or non-passing test coverage');
  requireProof(!/^\s*(?:FAIL\s|Errors?\s|Unhandled\s)/m.test(text), 'failure or unhandled-error report');
  requireProof(/^\s*Duration\s+\S/m.test(text), 'missing natural completion footer');
  return {files: asked, tests: +testMatch[1]};
}

export interface DatabaseWitnessInput {
  chunks: number;
  databaseFiles: string[];
  allFiles: string[];
  noDatabaseFiles: string[];
  controllerLog: string;
  chunkLogs: string[];
  fullReceipt: {sha: string; result: string; tier: string};
  baseline: string;
}

const uniqueSorted = (files: string[]) => files.length > 0 && files.every((f, i) => /^test\/.+\.(?:test\.ts|dom\.test\.tsx)$/.test(f) && (i === 0 || files[i - 1] < f));

/** The complete run may be RED solely because part (a) failed. Every DB chunk must
 * nevertheless have a natural exit=0, exact membership/counts and a positive PASS footer.
 * A slice, timeout, duplicated chunk or hand-summed partial run is never a witness. */
export function databaseWitness(input: DatabaseWitnessInput): PassedPhase {
  const {chunks, databaseFiles, allFiles, noDatabaseFiles, fullReceipt: receipt, baseline} = input;
  requireProof(chunks === 8 && input.chunkLogs.length === chunks, 'all eight DB chunks are required');
  requireProof(/^[0-9a-f]{40}$/.test(baseline) && receipt.sha === baseline && receipt.tier === 'full', 'baseline receipt identity');
  requireProof(['PASS', 'FAIL'].includes(receipt.result), 'baseline is not a completed full attempt');
  requireProof(uniqueSorted(allFiles) && uniqueSorted(databaseFiles) && uniqueSorted(noDatabaseFiles), 'invalid inventory');
  const partition = [...databaseFiles, ...noDatabaseFiles].sort();
  requireProof(partition.length === allFiles.length && partition.every((f, i) => f === allFiles[i]), 'inventory is not an exact partition');
  const controller = plain(input.controllerLog);
  requireProof(!controller.includes('PARTIAL RUN') && !controller.includes('PROOF') && /^════ FINAL ════$/m.test(controller), 'partial, proof or interrupted controller');
  const totals = [...controller.matchAll(/^\s*runs: (\d+)\s+files counted: (\d+) of (\d+) in the suite \((\d+) no-DB \+ (\d+) DB\)\s*$/gm)];
  requireProof(totals.length === 1 && +totals[0][1] === chunks + 1 && +totals[0][2] === allFiles.length && +totals[0][3] === allFiles.length && +totals[0][4] === noDatabaseFiles.length && +totals[0][5] === databaseFiles.length, 'incomplete full-attempt totals');
  const headers = [...controller.matchAll(/^════ part \(b\) chunk (\d+)\/(\d+) — (\d+) DB files ════$/gm)];
  requireProof(headers.length === chunks, 'missing or duplicated chunk invocation');
  const summaries = [...controller.matchAll(/^\s*chunk (\d+): exit=(\d+)\s+Test Files\s+(\d+) passed \((\d+)\)\s*$/gm)];
  requireProof(summaries.length === chunks, 'missing or failed final chunk summaries');
  let files = 0, tests = 0;
  for (let i = 0; i < chunks; i++) {
    const membership = databaseFiles.filter((_, offset) => offset % chunks === i);
    const header = headers[i], summary = summaries[i];
    requireProof(+header[1] === i + 1 && +header[2] === chunks && +header[3] === membership.length, 'wrong chunk partition');
    const section = controller.slice(header.index! + header[0].length, headers[i + 1]?.index ?? controller.indexOf('════ FINAL ════'));
    const exits = [...section.matchAll(/^\s*exit=(\d+)\s+peak-disk=\S+\s+wall=\d+s \(rebuild\+migrate\+vitest\)\s*$/gm)];
    requireProof(exits.length === 1 && exits[0][1] === '0', 'chunk did not naturally exit successfully');
    requireProof(+summary[1] === i + 1 && summary[2] === '0' && +summary[3] === membership.length && +summary[4] === membership.length, 'chunk exit/count mismatch');
    const phase = passedPhase(input.chunkLogs[i], membership.length);
    const bodyPhase=passedPhase(section,membership.length);
    requireProof(bodyPhase.files===phase.files&&bodyPhase.tests===phase.tests,'controller and chunk log counts differ');
    files += phase.files; tests += phase.tests;
  }
  requireProof(files === databaseFiles.length, 'database coverage is incomplete');
  return {files, tests};
}
