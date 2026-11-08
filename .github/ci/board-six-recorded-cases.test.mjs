import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateSixRecordedCaseIdentity,SIX_METADATA_PROFILE as P,METADATA_RECOVERY_POLICY} from './board-six-metadata-recovery.mjs';
const fixtures=JSON.parse(readFileSync(new URL('./testdata/board-six-recorded-case-inventories.json',import.meta.url),'utf8'));
const input=r=>({...structuredClone(r),originalSha:P.original,candidate:P.candidate});
test('v2 records exactly four literal fixture-valued name pairs in two unchanged source files; all53 assertions remain',()=>{
 assert.equal(METADATA_RECOVERY_POLICY,'aihr-cross-source-metadata-recovery/v2');assert.equal(fixtures.length,2);assert.equal(fixtures.reduce((n,r)=>n+r.originalCases.length,0),53);assert.equal(fixtures.reduce((n,r)=>n+r.mappings.length,0),4);
 for(const row of fixtures){const proof=validateSixRecordedCaseIdentity(input(row));assert.equal(proof.record.caseCount,row.originalCases.length);assert.deepEqual(proof.record.mappings,row.mappings);}
});
for(const [name,change] of [['dropped original',x=>x.originalCases.pop()],['dropped fresh',x=>x.replacementCases.pop()],['changed unchanged name',x=>x.replacementCases[0]+=' changed'],['other random value',x=>x.replacementCases=x.replacementCases.map(s=>s.replace('ff6979a3-ec50-40e4-a219-1e003af03562','00000000-0000-4000-8000-000000000001'))],['wrong run',x=>x.replacementRunId++],['wrong original run',x=>x.originalRunId++],['foreign file',x=>x.path='test/other.test.ts'],['other source',x=>x.originalSha='a'.repeat(40)],['other candidate',x=>x.candidate='b'.repeat(40)]])test('recorded names refuse '+name,()=>{const x=input(fixtures[0]);change(x);assert.throws(()=>validateSixRecordedCaseIdentity(x));});
test('same-count renaming in both inventories and any new time value still refuse',()=>{
 const x=input(fixtures[1]);x.originalCases[0]+=' changed';x.replacementCases[0]+=' changed';assert.throws(()=>validateSixRecordedCaseIdentity(x));
 const y=input(fixtures[1]);y.replacementCases=y.replacementCases.map(s=>s.replace('1794166503','1794166504'));assert.throws(()=>validateSixRecordedCaseIdentity(y));
});
test('the recorded time table retains expired, future-not-before and400-day cases at exactly the original relative offsets',()=>{
 const row=fixtures.find(r=>r.path.includes('mobile-company'));
 for(const key of ['original','replacement']){const values=row.mappings.map(m=>JSON.parse(m[key].slice(m[key].indexOf('{'))));const expires=values.filter(x=>'expiresAt' in x).map(x=>x.expiresAt).sort((a,b)=>a-b),notBefore=values.find(x=>'notBefore' in x).notBefore;assert.equal(notBefore-expires[0],61);assert.equal(expires[1]-expires[0],400*86400+1);}
});
test('the recorded SMTP invalid tenant and sole random client-id retain their exact shape',()=>{
 const row=fixtures.find(r=>r.path.includes('microsoft365'));
 for(const key of ['original','replacement']){const suffix=row.mappings[0][key],value=JSON.parse(suffix.slice(suffix.indexOf('{')));assert.deepEqual(Object.keys(value),['oauth2']);assert.deepEqual(Object.keys(value.oauth2),['tenantId','clientId']);assert.equal(value.oauth2.tenantId,'../common');assert.match(value.oauth2.clientId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);}
});
