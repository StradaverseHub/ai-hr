/** Read-only report recovery for one direct owner exception. Never a gate receipt. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const COUNTER_EXCEPTION = Object.freeze({
  version: 1, kind: 'OWNER_EXCEPTION_REPORT_EVIDENCE_NOT_GATE_RECEIPT',
  repository: 'StradaverseHub/ai-hr',
  candidate: '3c51317ea43ded103e782c37b55eccf9fdeae05c',
  baseline: 'f20275ffa150ecc41b745f625f085308ea283379',
  run: 'ai-local-20261026-final-02', chunks: 16,
  wrapperSha256: 'db5c7196b056990304618c2d45aec195ab6da6aee283fe07048353d963ecebd3',
  authorizationThread: '01a16f03-759a-7630-ab49-3fe0c7d69699',
  authorizationTurn: '01a17427-5b92-7513-8d5e-6c2a175bb83a',
  authorization: 'And only repair and retest those that fail, dont need to rerun. I give full permission for the exception',
});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireEvidence = (condition, reason) => assert(condition, 'Counter exception refused: ' + reason);
export function plainReport(raw) {
  requireEvidence(typeof raw === 'string', 'report must be text');
  return raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}
export function exactInventory(files) {
  requireEvidence(Array.isArray(files) && files.length > 0, 'empty inventory');
  requireEvidence(files.every((p, i) => typeof p === 'string' && /^test\/[A-Za-z0-9_./-]+\.(?:test\.ts|dom\.test\.tsx)$/.test(p)
    && !p.split('/').some(part => part === '.' || part === '..') && (i === 0 || files[i - 1] < p)), 'unsafe, unsorted or duplicated inventory');
  return files;
}
const one = (text, regex, reason) => {
  const matches = [...text.matchAll(regex)]; requireEvidence(matches.length === 1, reason); return matches[0];
};
/** The real process status was overwritten by the old counter: it stays UNKNOWN. */
export function reviewPassingReport(raw, asked) {
  exactInventory(asked);
  const text = plainReport(raw);
  const fileLine = one(text, /^\s*Test Files\s+([^\r\n]+)\s*$/gm, 'one file summary required');
  const testLine = one(text, /^\s*Tests\s+([^\r\n]+)\s*$/gm, 'one test summary required');
  const files = /^(\d+) passed \((\d+)\)$/.exec(fileLine[1].trim());
  const tests = /^(\d+) passed \((\d+)\)$/.exec(testLine[1].trim());
  requireEvidence(files && +files[1] === asked.length && +files[2] === asked.length, 'nonpassing or incomplete files');
  requireEvidence(tests && +tests[1] > 0 && tests[1] === tests[2], 'failed, skipped or incomplete tests');
  const footer = one(text, /^\s*Duration\s+\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\([^\r\n]*\))?[ \t]*$/gm, 'natural completion footer required');
  requireEvidence(footer.index > fileLine.index && footer.index > testLine.index && !text.slice(footer.index + footer[0].length).trim(), 'output follows completion footer');
  requireEvidence(!/^\s*(?:FAIL\s|Errors?\s|Unhandled\s|⎯[^\r\n]*(?:Failed Tests|Failed Suites|Unhandled Errors)|ELIFECYCLE\b|Test run (?:cancelled|canceled))/m.test(text), 'failure or unhandled-error marker');
  const passing = [...text.matchAll(/^\s*✓\s+(?:\|?(?:node|dom)\|?\s+)?(test\/[A-Za-z0-9_./-]+\.(?:test\.ts|dom\.test\.tsx))[ \t]+\((\d+) tests?\)[^\r\n]*$/gm)];
  requireEvidence(passing.length === asked.length, 'missing or repeated passing file reports');
  const names = passing.map(m => m[1]).sort();
  requireEvidence(isDeepStrictEqual(names, asked), 'passing file membership differs');
  requireEvidence(passing.every(m => +m[2] > 0 && m.index < fileLine.index), 'empty or misplaced file report');
  requireEvidence(passing.reduce((n, m) => n + +m[2], 0) === +tests[1], 'per-file case total differs');
  return {files: asked.length, cases: +tests[1], reportResult: 'PASS', rawVitestExit: 'UNKNOWN_NOT_SEPARATELY_RECORDED',
    rawSha256: sha256(raw), releaseAuthorized: false};
}

export function reviewCounterController(raw, inventory) {
  const all = exactInventory(inventory.all), nodb = exactInventory(inventory.nodb), db = exactInventory(inventory.db);
  requireEvidence(all.length === 1944 && nodb.length === 963 && db.length === 981 && isDeepStrictEqual([...nodb, ...db].sort(), all), 'wrong full partition');
  const text = plainReport(raw), P = COUNTER_EXCEPTION;
  requireEvidence(text.includes('head: ' + P.candidate.slice(0, 9)) && text.includes('▸ test lock: both slots held'), 'wrong source or admission');
  requireEvidence(!text.includes('PARTIAL RUN') && !text.includes('PROOF GREEN') && !text.includes('GATE GREEN'), 'partial/proof/relabelled controller');
  one(text, /^════ FINAL ════$/gm, 'controller is not terminal');
  const headers = [...text.matchAll(/^════ part \(b\) chunk (\d+)\/16 — (\d+) DB files ════$/gm)];
  requireEvidence(headers.length === P.chunks, 'missing or repeated DB batch');
  const nodbStart = one(text, /^════ part \(a\) — 963 no-DB files, one run, 2 workers, no cluster, DB URLs on a closed port ════$/gm, 'wrong no-DB invocation');
  const sections = [text.slice(nodbStart.index, headers[0].index)];
  const finalAt = text.indexOf('════ FINAL ════');
  for (let i = 0; i < headers.length; i++) {
    const asked = db.filter((_, n) => n % P.chunks === i).length;
    requireEvidence(+headers[i][1] === i + 1 && +headers[i][2] === asked, 'DB batch partition differs');
    sections.push(text.slice(headers[i].index, headers[i + 1]?.index ?? finalAt));
  }
  sections.forEach((section, index) => {
    const asked = index ? db.filter((_, n) => n % P.chunks === index - 1).length : nodb.length;
    one(section, new RegExp('ASKED FOR ' + asked + ' FILES, VITEST COUNTED NOTHING', 'g'), 'different counter failure');
    one(section, /^\s*exit=1\s+(?:peak-disk=\S+\s+)?wall=\d+s(?: \(rebuild\+migrate\+vitest\))?[ \t]*$/gm, 'wrong canonical phase exit');
    requireEvidence(!section.includes('cluster rebuild FAILED') && !section.includes('migrate FAILED'), 'setup failure');
  });
  one(text, /^\s*runs: 17\s+files counted: 0 of 1944 in the suite \(963 no-DB \+ 981 DB\)[ \t]*$/gm, 'wrong original full totals');
  one(text, /^\s*part a \(no-DB\): exit=1 <no summary>[ \t]*$/gm, 'wrong no-DB terminal summary');
  for (let i = 1; i <= P.chunks; i++) one(text, new RegExp('^\\s*chunk ' + i + ': exit=1 <no summary>[ \\t]*$', 'gm'), 'wrong DB terminal summary');
  requireEvidence(text.includes('GATE RED — read the logs') && text.includes('receipt: .gate-receipt.json  result=FAIL tier=full'), 'original failure not preserved');
  return {canonicalResult: 'FAIL', phases: 17, rawVitestExit: 'UNKNOWN_NOT_SEPARATELY_RECORDED', releaseAuthorized: false};
}
