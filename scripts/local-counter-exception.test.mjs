import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPassingReport, exactInventory, plainReport, reviewCounterController, COUNTER_EXCEPTION} from './local-counter-exception.mjs';
const names = ['test/a.test.ts', 'test/b.dom.test.tsx'];
const report = ' RUN v4.1.8 /private/candidate\n ✓ node test/a.test.ts (2 tests) 3ms\n ✓ dom test/b.dom.test.tsx (1 test) 5ms\n\n Test Files  2 passed (2)\n      Tests  3 passed (3)\n   Duration  0.50s (tests 8ms)\n\n';
test('plain and actual CSI-coloured reports retain exact scope and unknown exit', () => {
  for (const raw of [report, report.replaceAll('Test Files', '\x1b[2mTest Files\x1b[22m').replaceAll('(2)\n', '(2)\x1b[39m\n').replaceAll('✓', '\x1b[32m✓\x1b[39m')]) {
    const proof = reviewPassingReport(raw, names);
    assert.equal(proof.files, 2); assert.equal(proof.cases, 3);
    assert.equal(proof.rawVitestExit, 'UNKNOWN_NOT_SEPARATELY_RECORDED'); assert.equal(proof.releaseAuthorized, false);
  }
});
test('failed, skipped, todo or incomplete summaries cannot become passing evidence', () => {
  for (const replacement of ['1 failed | 2 passed (3)', '2 passed | 1 skipped (3)', '2 passed | 1 todo (3)', '2 passed (3)'])
    assert.throws(() => reviewPassingReport(report.replace('3 passed (3)', replacement), names));
});
test('missing, duplicate and substituted file reports refuse', () => {
  for (const raw of [report.replace(' ✓ node test/a.test.ts (2 tests) 3ms\n', ''), report.replace('test/b.dom.test.tsx', 'test/a.test.ts'), report.replace('test/b.dom.test.tsx', 'test/c.dom.test.tsx')])
    assert.throws(() => reviewPassingReport(raw, names));
});
test('repeated summaries, missing footer and output after footer refuse', () => {
  for (const raw of [report + ' Test Files  2 passed (2)\n', report.replace(/   Duration[^\n]*\n/, ''), report + 'ELIFECYCLE Command failed with exit code 1\n'])
    assert.throws(() => reviewPassingReport(raw, names));
});
test('actual failure markers and mismatched per-file totals refuse', () => {
  for (const raw of [report.replace(' RUN', ' FAIL test/a.test.ts\n RUN'), report.replace(' RUN', ' Unhandled Errors\n RUN'), report.replace('(2 tests)', '(1 test)')])
    assert.throws(() => reviewPassingReport(raw, names));
});
test('inventories reject traversal, duplicates, unsorted and empty lists', () => {
  for (const files of [[], ['test/../a.test.ts'], [names[0], names[0]], [...names].reverse()]) assert.throws(() => exactInventory(files));
});
test('colour stripping removes CSI only and preserves original report content', () => {
  assert.equal(plainReport('\x1b[38;5;12mTest Files\x1b[0m'), 'Test Files');
  assert.throws(() => reviewPassingReport(report.replace(' Test Files', '\x1b]0;hidden\x07 Test Files'), names));
});

const db = Array.from({length:981}, (_, i) => `test/db${String(i).padStart(4,'0')}.test.ts`);
const nodb = Array.from({length:963}, (_, i) => `test/no${String(i).padStart(4,'0')}.test.ts`);
const inventory = {db, nodb, all:[...db,...nodb].sort()};
const section = (count, db = false) => `  ASKED FOR ${count} FILES, VITEST COUNTED NOTHING\n  exit=1 ${db?'peak-disk=0% ':''}wall=1s${db?' (rebuild+migrate+vitest)':''}\n`;
const controller = `head: ${COUNTER_EXCEPTION.candidate.slice(0,9)}\n▸ test lock: both slots held\n════ part (a) — 963 no-DB files, one run, 2 workers, no cluster, DB URLs on a closed port ════\n${section(963)}`
 + Array.from({length:16}, (_, i) => `════ part (b) chunk ${i+1}/16 — ${db.filter((_,n)=>n%16===i).length} DB files ════\n${section(db.filter((_,n)=>n%16===i).length,true)}`).join('')
 + '════ FINAL ════\n  part a (no-DB): exit=1 <no summary>\n'
 + Array.from({length:16},(_,i)=>`  chunk ${i+1}: exit=1 <no summary>\n`).join('')
 + '  runs: 17   files counted: 0 of 1944 in the suite (963 no-DB + 981 DB)\n  GATE RED — read the logs\n  receipt: .gate-receipt.json  result=FAIL tier=full\n';
test('terminal counter-only failure stays FAIL and never grants release',()=>{
  const p=reviewCounterController(controller,inventory);assert.equal(p.canonicalResult,'FAIL');assert.equal(p.phases,17);assert.equal(p.releaseAuthorized,false);
});
test('controller rejects interruption, missing batch, relabelled receipt and changed counts',()=>{
  for(const t of [controller.replace('════ FINAL ════',''),controller.replace('chunk 16/16','chunk 15/16'),controller.replace('result=FAIL','result=PASS'),controller.replace('files counted: 0','files counted: 1944'),controller+'PARTIAL RUN\n',controller.replace('exit=1 peak-disk','exit=0 peak-disk')])assert.throws(()=>reviewCounterController(t,inventory));
});
