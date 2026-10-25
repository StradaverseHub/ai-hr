/** Source parsing and private fake reports only. Never import application fixtures or launch Vitest. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createPlanCopies,validatePlanSelection,staticRegistry,VISIBILITY,PRINCIPAL,REUSED_CASE} from './visibility-plan-copies.mjs';
import {PROFILE_FILE} from './attendance-sql-profile.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),ts=createRequire(join(process.env.AIHR_TEST_TYPESCRIPT_ROOT??root,'package.json'))('typescript');
function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'visibility-plan-copy-')));mkdirSync(join(dir,'test'));
 for(const name of [PROFILE_FILE,VISIBILITY,PRINCIPAL])cpSync(join(root,name),join(dir,name));return dir;
}
function result(source,proof){
 return {success:true,numTotalTests:Object.values(proof.registry).flat().length,numPassedTests:proof.selected.length,numFailedTests:0,numFailedTestSuites:0,numTodoTests:0,numPendingTests:Object.values(proof.registry).flat().length-proof.selected.length,
 testResults:proof.files.map(file=>({name:join(source,file),status:'passed',assertionResults:proof.registry[file].map(fullName=>({fullName,status:proof.selected.includes(fullName)?'passed':'skipped'}))}))};
}
test('actual tracked cases keep byte-identical registrations/assertions and imports while adding one labelled connection control',()=>{
 const dir=fixture();
 try{
  const p=createPlanCopies(dir,ts);assert.equal(p.files.length,3);assert.equal(p.selected.length,37);
  assert.equal(Object.values(p.registry).flat().length,125);assert(p.selected.includes(REUSED_CASE));
  const filter=new RegExp(p.pattern);for(const n of Object.values(p.registry).flat())assert.equal(filter.test(n),p.selected.includes(n),'Actual CLI regexp selection differs');assert(!filter.test('foreign '+p.selected[0]));
  assert.equal(p.selected.filter(n=>n.startsWith('r395 (i)/(ii)')).length,25);
  assert.equal(p.selected.filter(n=>n.startsWith('r395 — non-vacuity:')).length,5);
  assert.equal(p.selected.filter(n=>n.startsWith('canonical current principal snapshot foundation ')).length,5);
  assert(Object.values(p.sources).every(s=>s.originalCallsAndAssertionsUnchanged&&s.relativeImportsResolveIdentically));
  for(const [path,detail]of Object.entries(p.sources)){assert.equal(readFileSync(join(dir,path),'utf8'),readFileSync(join(root,path),'utf8'));assert(readFileSync(join(dir,detail.copy),'utf8').includes('__planInstall'));}
  assert.throws(()=>createPlanCopies(dir,ts));
 }finally{rmSync(dir,{recursive:true});}
});
test('selected-scope accounting refuses omission, extra execution, skipped selected case and foreign file',()=>{
 const dir=fixture();
 try{
  const p=createPlanCopies(dir,ts),r=result(dir,p);assert.deepEqual(validatePlanSelection(r,dir,p),{registered:125,selectedPassed:37,deliberatelyUnselected:88,fullSuitePassed:false,releaseAuthorized:false});
  for(const edit of [r=>r.numPassedTests=125,r=>r.numPendingTests=0,r=>r.testResults.pop(),r=>r.testResults[0].name='/foreign/file.ts',r=>r.testResults[1].assertionResults.find(a=>p.selected.includes(a.fullName)).status='skipped',r=>r.testResults[0].assertionResults.find(a=>!p.selected.includes(a.fullName)).status='passed']){const next=structuredClone(r);edit(next);assert.throws(()=>validatePlanSelection(next,dir,p));}
  assert.throws(()=>staticRegistry("describe('x',()=>{it.each(getUnknownData())('case %s',()=>{});});",ts));
 }finally{rmSync(dir,{recursive:true});}
});
