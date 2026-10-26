import test from 'node:test';
import assert from 'node:assert/strict';
import {balanceDatabaseFiles,validateDurationHints,DB_SCHEDULING} from './db-scheduling.mjs';
import {buildUnits,requiredEvidence,DB_BATCH_FILES,CI_EXECUTION} from './manifest.mjs';
const files=n=>Array.from({length:n},(_,i)=>`test/db-${String(i).padStart(4,'0')}.test.ts`);
test('duration grouping separates the old alphabetical expensive cluster without extra jobs or missing files',()=>{
 const inventory=files(12),durations=Object.fromEntries(inventory.map((f,i)=>[f,i<3?100:1]));
 const old=[inventory.slice(0,4),inventory.slice(4,8),inventory.slice(8)],fresh=balanceDatabaseFiles(inventory,4,durations,1);
 const total=group=>group.reduce((n,f)=>n+durations[f],0);
 assert.equal(fresh.length,old.length);assert.equal(Math.max(...old.map(total)),301);assert.equal(Math.max(...fresh.map(total)),103);
 assert.deepEqual(fresh.flat().sort(),inventory);assert(fresh.every(group=>group.length===4));
 assert.deepEqual(balanceDatabaseFiles(inventory.toReversed(),4,durations,1),fresh);
});
test('unknown and renamed files remain mandatory with positive fallback; hints never supply coverage',()=>{
 const inventory=files(131),groups=balanceDatabaseFiles(inventory,64,{},15000);
 assert.equal(groups.length,3);assert(groups.every(g=>g.length>0&&g.length<=64));assert.deepEqual(groups.flat().sort(),inventory);
 const withForeignHint=balanceDatabaseFiles(inventory,64,{'test/foreign.test.ts':3600000},15000);assert.deepEqual(withForeignHint,groups);
 assert.deepEqual(balanceDatabaseFiles([],64,{},15000),[]);
});
test('oversized, nonfinite, zero and malformed hints or inventories fail closed',()=>{
 const valid={schemaVersion:1,kind:'DURATION_HINTS_ONLY_NEVER_COVERAGE_OR_PASS',unknownDurationMs:15000,durationsMs:{'test/one.test.ts':10}};
 assert.equal(validateDurationHints(valid)['test/one.test.ts'],10);
 for(const ms of [0,-1,NaN,Infinity,1.5,3600001]){
  assert.throws(()=>validateDurationHints({...valid,durationsMs:{'test/one.test.ts':ms}}));
  assert.throws(()=>balanceDatabaseFiles(['test/one.test.ts'],64,{'test/one.test.ts':ms}));
 }
 for(const file of ['test/../one.test.ts','test//one.test.ts','outside.test.ts'])assert.throws(()=>validateDurationHints({...valid,durationsMs:{[file]:10}}));
 for(const max of [0,65,Infinity,1.5])assert.throws(()=>balanceDatabaseFiles(files(2),max));
 assert.throws(()=>balanceDatabaseFiles([files(1)[0],files(1)[0]]));
});
test('normal manifest reconstructs complete exact topology and binds the advisory dataset identity',()=>{
 const db=files(981),nodb=['test/pure.test.ts'],suite=[...db,...nodb].sort(),browser=['test/layout.browser.test.tsx'];
 const plan={suite,units:buildUnits(suite,{db,nodb},browser)};
 assert.equal(plan.units.filter(u=>u.kind==='db').length,Math.ceil(db.length/DB_BATCH_FILES));
 assert.deepEqual(plan.units.filter(u=>u.kind==='db').flatMap(u=>u.files).sort(),db);
 assert.equal(CI_EXECUTION.scheduling,DB_SCHEDULING);assert.match(DB_SCHEDULING.hintsSha256,/^[a-f0-9]{64}$/);
 requiredEvidence(plan);
 const changed=structuredClone(plan);changed.units.find(u=>u.kind==='db').files.pop();assert.throws(()=>requiredEvidence(changed));
});
