import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUnits,requiredEvidence,DB_BATCH_FILES,NODB_BATCH_FILES,CI_EXECUTION} from './manifest.mjs';
import {balanceDatabaseFiles} from './db-scheduling.mjs';
import {readFileSync} from 'node:fs';
const names=(kind,n)=>Array.from({length:n},(_,i)=>`test/${kind}-${String(i).padStart(4,'0')}.test.ts`);
const browsers=['test/layout.browser.test.tsx'];
function fixture(dbCount=981,nodbCount=963){const db=names('db',dbCount),nodb=names('nodb',nodbCount);const suite=[...db,...nodb].sort();return {suite,units:buildUnits(suite,{db,nodb},browsers)};}
test('Actual pilot scale produces complete bounded batches without a fixed unit count',()=>{
 const p=fixture(),db=p.units.filter(u=>u.kind==='db'),nodb=p.units.filter(u=>u.kind==='nodb');
 assert.equal(db.length,Math.ceil(981/DB_BATCH_FILES));assert.equal(nodb.length,Math.ceil(963/NODB_BATCH_FILES));
 assert.deepEqual(p.units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort(),p.suite);
 assert.ok(db.every(u=>u.files.length>0&&u.files.length<=DB_BATCH_FILES));
 const count=db.length+nodb.length+3;assert.equal(requiredEvidence(p).units.length,count);assert.equal(requiredEvidence(p).jobs.length,count+8);assert.equal(requiredEvidence(p).artifacts.length,count+3);
});
test('Batch membership and content identity survive different input ordering',()=>{
 const p=fixture(),db=p.units.filter(u=>u.kind==='db').flatMap(u=>u.files),nodb=p.units.filter(u=>u.kind==='nodb').flatMap(u=>u.files);
 assert.deepEqual(buildUnits(p.suite.toReversed(),{db:db.toReversed(),nodb:nodb.toReversed()},browsers),p.units);
});
test('Small inventory derives fewer required jobs; growing suite adds coverage, not empty jobs',()=>{
 const small=fixture(1,1),larger=fixture(65,257);
 assert.equal(requiredEvidence(small).units.length,5);assert.equal(requiredEvidence(larger).units.length,Math.ceil(65/DB_BATCH_FILES)+Math.ceil(257/NODB_BATCH_FILES)+3);
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

test('measured 993-file database inventory changes isolation boundaries without removing any case file or increasing per-job resources',()=>{
 const p=fixture(993,972),units=p.units.filter(u=>u.kind==='db'),files=names('db',993),before=balanceDatabaseFiles(files,64);
 assert.equal(DB_BATCH_FILES,24);assert.equal(before.length,16);assert.equal(units.length,42);
 assert.deepEqual(units.flatMap(u=>u.files).sort(),before.flat().sort());
 assert(units.every(u=>u.files.length>0&&u.files.length<=24));
 assert.equal(p.units.filter(u=>u.kind==='nodb').length,4);assert.equal(p.units.filter(u=>u.kind==='browser').length,3);
 assert.equal(requiredEvidence(p).jobs.length,57);assert.equal(requiredEvidence(p).artifacts.length,52);
 assert.equal(CI_EXECUTION.workers,2);assert.deepEqual(CI_EXECUTION.postgres,{profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,jit:'on'});
});
test('increased matrix admission keeps every job on a free standard runner and refuses an old wider unit as current coverage',()=>{
 const yaml=readFileSync(new URL('../workflows/alpha-staging.yml',import.meta.url),'utf8');
 const runners=[...yaml.matchAll(/^    runs-on: (.+)$/gm)].map(m=>m[1]);assert(runners.length>=10);assert(runners.every(r=>r==='ubuntu-24.04'));
 assert(yaml.includes("options: ['4', '8', '16', '20', '32', '40', '48']")&&yaml.includes("default: '48'")&&yaml.includes("fromJSON(inputs.test_parallelism || '48')"));
 const p=fixture(993,972),db=names('db',993),old=balanceDatabaseFiles(db,64);p.units=p.units.filter(u=>u.kind!=='db').concat(old.map(files=>({id:'db-old',kind:'db',files})));
 assert.throws(()=>requiredEvidence(p));
});

test('dedicated PDF suite moves complete files only, preserving all ordinary, database and browser coverage',()=>{
 const pdf=['test/payslip-pdf.test.ts','test/r379-pcb2ii-pdf.test.ts'],db=names('db',65),nodb=[...names('nodb',257),...pdf],suite=[...db,...nodb].sort();
 const units=buildUnits(suite,{db,nodb},browsers),special=units.filter(u=>u.pdfTools);assert.equal(special.length,1);assert.equal(special[0].kind,'nodb');assert.deepEqual(special[0].files,pdf);assert(units.filter(u=>!u.pdfTools).every(u=>!u.files.some(f=>pdf.includes(f))));
 assert.deepEqual(units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort(),suite);assert.equal(units.filter(u=>u.kind==='db').length,Math.ceil(65/DB_BATCH_FILES));assert.equal(units.filter(u=>u.kind==='nodb').length,3);assert.equal(units.filter(u=>u.kind==='browser').length,3);assert.equal(requiredEvidence({suite,units}).units.length,units.length);
 const altered=structuredClone(units);altered.find(u=>u.pdfTools).pdfTools=false;assert.throws(()=>requiredEvidence({suite,units:altered}));assert.throws(()=>buildUnits(suite,{db:[...db,pdf[0]],nodb:nodb.filter(f=>f!==pdf[0])},browsers));
});
