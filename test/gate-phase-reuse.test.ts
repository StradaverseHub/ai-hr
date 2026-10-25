// Prepared only: copy to test/gate-phase-reuse.test.ts after the frozen run/restoration.
import {describe, expect, it} from 'vitest';
import {databaseWitness, passedPhase, type DatabaseWitnessInput} from '../scripts/gate-phase-reuse';

const phase = (files = 1, tests = 2) => `\n Test Files  ${files} passed (${files})\n      Tests  ${tests} passed (${tests})\n   Duration  1.00s (tests 1s)\n`;
const witness = (): DatabaseWitnessInput => {
  const databaseFiles = Array.from({length: 8}, (_, i) => `test/db${i}.test.ts`);
  const noDatabaseFiles = ['test/home.test.ts'];
  return {
    chunks: 8, baseline: 'a'.repeat(40), databaseFiles, noDatabaseFiles,
    allFiles: [...databaseFiles, ...noDatabaseFiles].sort(),
    fullReceipt: {sha: 'a'.repeat(40), result: 'FAIL', tier: 'full'},
    chunkLogs: databaseFiles.map(() => phase()),
    controllerLog: databaseFiles.map((_, i) => `════ part (b) chunk ${i + 1}/8 — 1 DB files ════\n  exit=0  peak-disk=63%  wall=1s (rebuild+migrate+vitest)\n${phase()}`).join('\n')
      + '\n════ FINAL ════\n'
      + databaseFiles.map((_, i) => `  chunk ${i + 1}: exit=0  Test Files  1 passed (1)`).join('\n')
      + '\n  runs: 9   files counted: 9 of 9 in the suite (1 no-DB + 8 DB)\n',
  };
};

describe('strict counted successful phase', () => {
  it('counts a naturally completed phase', () => expect(passedPhase(phase(3, 12), 3)).toEqual({files: 3, tests: 12}));
  it.each([
    ['missing footer', phase().replace(/.*Duration.*\n/, '')],
    ['duplicate footer', phase() + phase()],
    ['skipped file', phase().replace('1 passed (1)', '1 passed | 1 skipped (2)')],
    ['failed file', phase().replace('1 passed (1)', '1 failed (1)')],
    ['skipped test', phase().replace('2 passed (2)', '1 passed | 1 skipped (2)')],
    ['todo test', phase().replace('2 passed (2)', '1 passed | 1 todo (2)')],
    ['zero tests', phase(1, 0)],
    ['unhandled error', phase() + '\nUnhandled Errors\n'],
    ['failure report before a misleading PASS', '\n FAIL test/something.test.ts\n' + phase()],
  ])('refuses %s', (_, log) => expect(() => passedPhase(log, 1)).toThrow('Phase reuse refused'));
  it('refuses asked/counted mismatch', () => expect(() => passedPhase(phase(), 2)).toThrow());
  it('refuses nonpositive/unsafe requested counts', () => {
    for (const asked of [0, -1, 1.5, NaN, Infinity]) expect(() => passedPhase(phase(), asked)).toThrow();
  });
});

describe('complete eight-chunk database witness', () => {
  it('retains a full RED baseline while proving every database phase passed', () => {
    const input = witness();
    expect(databaseWitness(input)).toEqual({files: 8, tests: 16});
    expect(input.fullReceipt.result).toBe('FAIL');
  });
  it.each(Array.from({length: 8}, (_, i) => i))('refuses a missing/failed chunk at position %s', index => {
    const missing = witness(); missing.chunkLogs.splice(index, 1);
    expect(() => databaseWitness(missing)).toThrow();
    const failed = witness(); failed.chunkLogs[index] = phase().replace('1 passed (1)', '1 failed (1)');
    expect(() => databaseWitness(failed)).toThrow();
  });
  it.each<[string, (x: DatabaseWitnessInput) => void]>([
    ['slice', (x: DatabaseWitnessInput) => { x.controllerLog = 'PARTIAL RUN\n' + x.controllerLog; }],
    ['proof', (x: DatabaseWitnessInput) => { x.controllerLog = 'PROOF\n' + x.controllerLog; }],
    ['timeout', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.split('════ FINAL')[0]; }],
    ['duplicate invocation', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog + '════ part (b) chunk 1/8 — 1 DB files ════\n'; }],
    ['body exit failure', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.replace('exit=0  peak', 'exit=1  peak'); }],
    ['final exit failure', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.replace('chunk 1: exit=0', 'chunk 1: exit=1'); }],
    ['wrong chunk number', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.replace('chunk 1/8', 'chunk 2/8'); }],
    ['wrong chunk size', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.replace('— 1 DB files', '— 2 DB files'); }],
    ['wrong run count', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.replace('runs: 9', 'runs: 8'); }],
    ['missing file', (x: DatabaseWitnessInput) => { x.controllerLog = x.controllerLog.replace('files counted: 9', 'files counted: 8'); }],
    ['another SHA', (x: DatabaseWitnessInput) => { x.fullReceipt.sha = 'b'.repeat(40); }],
    ['not a full attempt', (x: DatabaseWitnessInput) => { x.fullReceipt.tier = 'impact'; }],
    ['unknown result', (x: DatabaseWitnessInput) => { x.fullReceipt.result = 'RUNNING'; }],
    ['duplicate DB membership', (x: DatabaseWitnessInput) => { x.databaseFiles[1] = x.databaseFiles[0]; }],
    ['overlapping partition', (x: DatabaseWitnessInput) => { x.noDatabaseFiles[0] = x.databaseFiles[0]; }],
    ['extra uncovered file', (x: DatabaseWitnessInput) => { x.allFiles.push('test/uncovered.test.ts'); }],
    ['uncollected chunk', (x: DatabaseWitnessInput) => { x.chunkLogs[2] = 'RUN\n'; }],
  ])('refuses %s', (_, mutate) => {
    const input = witness(); mutate(input);
    expect(() => databaseWitness(input)).toThrow('Phase reuse refused');
  });
});

it('refuses controller/log test-count disagreement',()=>{const x=witness();x.controllerLog=x.controllerLog.replace('2 passed (2)','3 passed (3)');expect(()=>databaseWitness(x)).toThrow(/counts differ/);});


import {readsOnlyProcessStatus,planImpact} from '../scripts/gate-impact';
const monitor="import {readFile as read} from 'node:fs/promises'; import {spawn} from 'node:child_process'; const child=spawn('node',[]); async function rss(){return read(`/proc/${child.pid}/status`,'utf8');}";
it('proves an imported process monitor reads only its spawned PID status',()=>expect(readsOnlyProcessStatus('monitor.ts',monitor)).toBe(true));
it.each([
 monitor.replace('/proc/','./scripts/'),
 monitor.replace('child.pid','input'),
 monitor.replace('const child=spawn', 'const child=unknown'),
 monitor+'const leaked=read;',
 monitor.replace('read(`/proc/', 'const alias=read;return alias(`/proc/'),
 monitor+"async function shadow(child:any){return read(`/proc/${child.pid}/status`);}",
 monitor.replace("readFile as read", "readFile as read, readdir"),
 monitor+"read('scripts/gate.sh');",
 monitor+"read('/proc/self/cwd/scripts/status');",
 monitor+"const alias=child;alias.pid='unsafe';",
 monitor+"child.pid='unsafe';",
 monitor+'child.pid++;',
 monitor.replace('const child=spawn','let child=spawn'),
 monitor+"function spawn(){return {pid:'unsafe'};}",
 monitor+"const fs=require('node:fs');fs.readFileSync(input);",
 monitor+"export {readFile} from 'node:fs';",

])('keeps uncertain, escaped and repository readers broad',source=>expect(readsOnlyProcessStatus('monitor.ts',source)).toBe(false));
it('narrows only unchanged proven process reads, while still selecting an unknown repository reader',()=>{
 const files=new Map([['scripts/changed.ts','export const x=1;'],['monitor.ts',monitor],['test/process.test.ts',"import '../monitor';"],['reader.ts',"import {readFileSync} from 'node:fs';readFileSync(input);"],['test/reader.test.ts',"import '../reader';"]]);
 const change={path:'scripts/changed.ts',status:'M',headText:'export const x=1;',baseText:'export const x=0;',diffLines:[]};
 const broad=planImpact([change],files),precise=planImpact([change],files,[],undefined,true);
 expect(broad.run).toContain('test/process.test.ts');expect(precise.run).not.toContain('test/process.test.ts');expect(precise.run).toContain('test/reader.test.ts');
 const edited=planImpact([change,{path:'monitor.ts',status:'M',headText:monitor,baseText:monitor+' ',diffLines:[]}],files,[],undefined,true);
 expect(edited.run).toContain('test/process.test.ts');
});

import {readFileSync} from 'node:fs';
it('proves the actual unchanged evidence monitor reads only process status',()=>{const path='packs/performance/onehr/evidence-extraction.ts';expect(readsOnlyProcessStatus(path,readFileSync(path,'utf8'))).toBe(true);});
