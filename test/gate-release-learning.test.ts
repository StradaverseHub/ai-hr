import { afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,rmSync,readdirSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveGate,saveRelease,gateHistory,releaseHistory,failureHistory,fullRegressionDue,queueReleaseMirror,pendingReleaseMirrors,acknowledgeReleaseMirror,riskKnowledge } from '../scripts/gate-learning';
import { planImpact } from '../scripts/gate-impact';
const dirs:string[]=[];const dir=()=>{const d=mkdtempSync(join(tmpdir(),'impact-learning-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const sha='a'.repeat(40),base='b'.repeat(40),plan=()=>planImpact([{path:'lib/new.ts',status:'A',baseText:null,headText:'export const a=1;',diffLines:[]}],new Map([['lib/new.ts','export const a=1;']]));
describe('persistent release learning',()=>{
 it('saves unknown impact, its reasons and source/dependency evidence, rather than promoting it on a pass',()=>{
  const d=dir(),p=plan(),g=saveGate({sha,base,environmentHash:'env',result:'PASS',tier:'full',plan:p,failed:[],wallSeconds:40},d);
  saveRelease({sha,buildId:'build',gate:g,classifications:p.classifications},d);
  const saved=releaseHistory(d)[0];expect(saved.unknowns).toHaveLength(1);expect(saved.classifications[0].sourceHash).toBeTruthy();
  expect(saved.activeServiceVerified).toBe(false);expect(saved.classifications[0].risk).toBe('unknown');
 });
 it('records an explained category transition after executable test coverage is added',()=>{
  const d=dir(),p=plan();saveRelease({sha,buildId:'one',gate:null,classifications:p.classifications},d);
  const known={...p.classifications[0],risk:'moderate' as const,reason:'executable consumer now resolves',uncertainties:[]};
  const next=saveRelease({sha:'c'.repeat(40),buildId:'two',gate:null,classifications:[known]},d);
  expect(next.transitions).toEqual([{path:'lib/new.ts',from:'unknown',to:'moderate',reason:known.reason}]);
  expect(releaseHistory(d)).toHaveLength(2);
 });
 it('retains failed-test associations and exact run timings across processes',()=>{
  const d=dir();saveGate({sha,base,environmentHash:'env',result:'FAIL',tier:'impact',plan:plan(),failed:['test/hidden.test.ts'],wallSeconds:3},d);
  expect(failureHistory(d)).toEqual([{changed:['lib/new.ts'],failed:['test/hidden.test.ts']}]);expect(gateHistory(d)[0].wallSeconds).toBe(3);
 });
 it('is idempotent per release/build and never overwrites the earlier evidence',()=>{
  const d=dir(),input={sha,buildId:'same',gate:null,classifications:plan().classifications};const first=saveRelease(input,d);
  expect(saveRelease(input,d)).toEqual(first);expect(readdirSync(join(d,'releases'))).toHaveLength(1);
 });
 it('refuses corrupt evidence rather than silently treating it as learned certainty',()=>{
  const d=dir();mkdirSync(join(d,'gates'));writeFileSync(join(d,'gates','bad.json'),'{}');expect(()=>gateHistory(d)).toThrow('Invalid saved verification evidence');
 });
});


describe('periodic full regression',()=>{
 it('requires an initial full witness, rejects missing counts, and expires it after seven days',()=>{
  const d=dir();expect(fullRegressionDue([],[],'env')).toContain('first');
  const g=saveGate({sha,base,environmentHash:'env',result:'PASS',tier:'full',plan:plan(),failed:[],wallSeconds:1,fullReceipt:{sha,result:'PASS',tier:'full',files:1,suiteFiles:1}},d);
  expect(fullRegressionDue([g],[],'env',Date.parse(g.at)+1000)).toBeNull();
  expect(fullRegressionDue([g],[],'env',Date.parse(g.at)+8*86400000)).toContain('seven-day');
  expect(fullRegressionDue([{...g,fullReceipt:{sha,result:'PASS',tier:'full'}}],[],'env')).toContain('first');
 });
});


describe('release evidence retry and accumulated knowledge',()=>{
 it('keeps an outbox copy until acknowledgement and retains immutable evidence afterwards',()=>{
  const d=dir(),record=saveRelease({sha,buildId:'outbox',gate:null,classifications:plan().classifications},d);
  queueReleaseMirror(record,d);expect(pendingReleaseMirrors(d)).toEqual([record]);acknowledgeReleaseMirror(record,d);
  expect(pendingReleaseMirrors(d)).toEqual([]);expect(releaseHistory(d)).toEqual([record]);
 });
 it('retains unknown modules in the knowledge base when later releases touch other modules',()=>{
  const d=dir();saveRelease({sha,buildId:'one',gate:null,classifications:plan().classifications},d);
  saveRelease({sha:'c'.repeat(40),buildId:'two',gate:null,classifications:[]},d);
  expect(riskKnowledge(d)[0].classification.risk).toBe('unknown');
 });
});
