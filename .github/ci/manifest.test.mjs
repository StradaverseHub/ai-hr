import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUnits,requiredEvidence,DB_BATCH_FILES,NODB_BATCH_FILES} from './manifest.mjs';
const names=(kind,n)=>Array.from({length:n},(_,i)=>`test/${kind}-${String(i).padStart(4,'0')}.test.ts`);
const browsers=['test/layout.browser.test.tsx'];
function fixture(dbCount=981,nodbCount=963){const db=names('db',dbCount),nodb=names('nodb',nodbCount);const suite=[...db,...nodb].sort();return {suite,units:buildUnits(suite,{db,nodb},browsers)};}
test('Actual pilot scale produces complete bounded batches without a fixed unit count',()=>{
 const p=fixture(),db=p.units.filter(u=>u.kind==='db'),nodb=p.units.filter(u=>u.kind==='nodb');
 assert.equal(db.length,Math.ceil(981/DB_BATCH_FILES));assert.equal(nodb.length,Math.ceil(963/NODB_BATCH_FILES));
 assert.deepEqual(p.units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort(),p.suite);
 assert.ok(db.every(u=>u.files.length>0&&u.files.length<=64));
 assert.equal(requiredEvidence(p).units.length,23);assert.equal(requiredEvidence(p).jobs.length,31);assert.equal(requiredEvidence(p).artifacts.length,25);
});
test('Batch membership and content identity survive different input ordering',()=>{
 const p=fixture(),db=p.units.filter(u=>u.kind==='db').flatMap(u=>u.files),nodb=p.units.filter(u=>u.kind==='nodb').flatMap(u=>u.files);
 assert.deepEqual(buildUnits(p.suite.toReversed(),{db:db.toReversed(),nodb:nodb.toReversed()},browsers),p.units);
});
test('Small inventory derives fewer required jobs; growing suite adds coverage, not empty jobs',()=>{
 const small=fixture(1,1),larger=fixture(65,257);
 assert.equal(requiredEvidence(small).units.length,5);assert.equal(requiredEvidence(larger).units.length,7);
 assert.notDeepEqual(requiredEvidence(small).artifacts,requiredEvidence(larger).artifacts);
});
test('Content changes invalidate batch identities even when counts stay equal',()=>{
 const p=fixture(1,1),q=fixture(1,1);q.suite=q.suite.map(f=>f.replace('db-0000','db-changed'));
 q.units=buildUnits(q.suite,{db:q.suite.filter(f=>f.startsWith('test/db-')),nodb:q.suite.filter(f=>f.startsWith('test/nodb-'))},browsers);
 assert.notEqual(p.units.find(u=>u.kind==='db').id,q.units.find(u=>u.kind==='db').id);
});
for(const [label,mutate] of [
 ['omitted batch',p=>p.units.splice(0,1)],['duplicated batch',p=>p.units.push(p.units[0])],
 ['renamed content identity',p=>p.units[0].id='nodb-'+ '0'.repeat(16)],
 ['omitted browser engine',p=>p.units.pop()],['foreign engine',p=>p.units.at(-1).engine='other'],
 ['different browser files',p=>p.units.at(-1).files=['test/foreign.browser.test.tsx']],
 ['changed kind',p=>p.units[0].kind='other'],['missing inventory',p=>p.suite.pop()],
 ['duplicate inventory',p=>p.suite.push(p.suite[0])],['missing trusted plan',p=>{delete p.units;}],
])test('Manifest rejects '+label,()=>{const p=fixture(65,257);mutate(p);assert.throws(()=>requiredEvidence(p));});
test('Classifier omissions, duplicates and invented paths cannot reduce the trusted suite',()=>{
 const db=names('db',2),nodb=names('nodb',1),suite=[...db,...nodb];
 for(const groups of [{db:db.slice(1),nodb},{db:[...db,db[0]],nodb},{db:[db[0],'test/foreign.test.ts'],nodb}])assert.throws(()=>buildUnits(suite,groups,browsers));
 assert.throws(()=>buildUnits(['test/../bad.test.ts'],{db:['test/../bad.test.ts'],nodb:[]},browsers));
});
