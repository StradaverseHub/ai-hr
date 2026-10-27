import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {EMAIL,proveEmailController,proveEmailRepairSource,validateEmailControllerProof} from './email-repair-source.mjs';
const repository=fileURLToPath(new URL('../..',import.meta.url));
test('reconstructs the actual complete three-pin controller and two-test-only repair from Git',()=>{
 const p=proveEmailController({repository});assert.equal(p.releaseAuthorized,false);assert.equal(p.pins.length,2);
 const s=proveEmailRepairSource({repository});assert.equal(s.files.length,2);assert.equal(s.applicationSqlAndJournalUnchanged,true);assert.equal(s.releaseAuthorized,false);
});
for(const delta of [{controller:EMAIL.controllerParent},{branch:'alpha'},{branch:'codex/unreviewed'}])test('refuses changed controller or branch '+JSON.stringify(delta),()=>assert.throws(()=>proveEmailController({repository,...delta})));
test('refuses a caller self-hash, altered pins and broader repair head',()=>{
 const p=structuredClone(proveEmailController({repository}));p.pins[0].sha256='0'.repeat(64);
 assert.throws(()=>validateEmailControllerProof(p,{controller:EMAIL.controller,branch:EMAIL.controllerBranch}));
 assert.throws(()=>proveEmailRepairSource({repository,candidate:EMAIL.original}));
 assert.throws(()=>validateEmailControllerProof({}, {controller:EMAIL.controller,branch:EMAIL.controllerBranch}));
});
