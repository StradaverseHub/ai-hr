import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicRefusal} from './v9-hosted-refusal.mjs';
test('retains only known refusal and tracked relative locations',()=>{
 const raw='SECRET_TOKEN=private\nValueError: Unsafe or duplicate artifact filename\n File "/home/runner/work/private/reader/.github/ci/extract-artifact.py", line 17\n at collect (/home/runner/work/private/reader/.github/ci/v9-db-resource-assessment.mjs:25:9)';
 const r=publicRefusal(raw,['.github/ci/extract-artifact.py','.github/ci/v9-db-resource-assessment.mjs']);assert.equal(r.reason,'Unsafe or duplicate artifact filename');assert.equal(r.frames.length,2);assert(r.errorClasses.includes('ValueError'));assert(!JSON.stringify(r).includes('SECRET_TOKEN'));assert(!JSON.stringify(r).includes('/home/'));assert.match(r.diagnosticSha256,/^[a-f0-9]{64}$/);
});
test('unknown text, foreign files and arbitrary locations never publish',()=>{
 const r=publicRefusal('secret /source/.github/ci/untracked.mjs:5:9 /etc/passwords:9\nENCRYPTION_KEY=value',[]);assert.equal(r.reason,'ASSESSMENT_REFUSED');assert.deepEqual(r.frames,[]);assert.deepEqual(r.errorClasses,[]);assert(!JSON.stringify(r).includes('ENCRYPTION'));
});
test('locations are bounded and duplicate frames removed',()=>{
 const script='.github/ci/reader.mjs';const r=publicRefusal(Array.from({length:100},(_,i)=>` at f (/a/reader/${script}:${i+1}:2)`).join('\n'),[script]);assert.equal(r.frames.length,16);assert.deepEqual(publicRefusal(`/a/reader/${script}:1:2 /a/reader/${script}:1:2`,[script]).frames,[{script,line:1}]);
});

test('transport diagnostics reveal fixed status/code values without raw responses',()=>{
 const r=publicRefusal('gh: private payload TOKEN=secret (HTTP 403) ENOBUFS');assert.deepEqual(r.httpStatuses,[403]);assert.deepEqual(r.transportCodes,['ENOBUFS']);assert(!JSON.stringify(r).includes('TOKEN'));assert(!JSON.stringify(r).includes('private payload'));
});
