import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);const {writesOnlyFilesystem,planImpact}=require('../../scripts/gate-impact.ts');
const writer="import {appendFileSync,mkdirSync} from 'node:fs';export function record(){mkdirSync('/tmp/timing',{recursive:true});appendFileSync('/tmp/timing/run.jsonl','timing');}";
function fixture(helper=writer){return new Map([['app/value.ts','export const value=2;'],['test/timing.ts',helper],['test/affected.test.ts',"import {value} from '../app/value';"],['test/unrelated.test.ts',"import './timing';"]]);}
const change={path:'app/value.ts',status:'M',baseText:'export const value=1;',headText:'export const value=2;'};
const bounded=(changes,files)=>planImpact(changes,files,[],undefined,false,'bounded-repair-v1');
test('named direct write-only filesystem operations are proven',()=>assert.equal(writesOnlyFilesystem('test/timing.ts',writer),true));
for(const [name,source] of [
 ['real read',writer.replace('appendFileSync,mkdirSync','readFileSync,mkdirSync').replace("appendFileSync('/tmp/timing/run.jsonl','timing')","readFileSync('app/value.ts')")],
 ['namespace fs',"import * as fs from 'node:fs';fs.appendFileSync('/tmp/x','x');"],
 ['escaped writer',writer+"const escaped=appendFileSync;"],
 ['shadowed writer',writer+"function hidden(appendFileSync){appendFileSync('x');}"],
 ['computed import',writer+"import(process.env.LOADER);"],
 ['module require',writer+"module.require('node:fs').readFileSync('secret');"],
 ['builtin loader',writer+"process.getBuiltinModule('fs').readFileSync('secret');"],
 ['createRequire loader',"import {createRequire} from 'node:module';"+writer],
 ['evaluation',writer+"const run=eval;"],
 ['computed invocation',writer+"globalThis['loader']('fs');"],
])test('write proof refuses '+name,()=>assert.equal(writesOnlyFilesystem('test/timing.ts',source),false));
test('version4 omits only unchanged writer fanout, version3 remains byte-contract unchanged',()=>{
 const files=fixture(),old=planImpact([change],files),next=bounded([change],files);
 assert.equal(old.policyVersion,3);assert(old.run.includes('test/unrelated.test.ts'));
 assert.equal(next.policyVersion,4);assert.equal(next.selectionMode,'bounded-repair-v1');assert(!next.run.includes('test/unrelated.test.ts'));assert(next.run.includes('test/affected.test.ts'));
 assert.equal(next.nonRepositoryIo['test/timing.ts'].kind,'write-only-filesystem');assert.notEqual(old.fingerprint,next.fingerprint);
});
test('changed writer and actual source reads stay conservative',()=>{
 const files=fixture();const delta={path:'test/timing.ts',status:'M',baseText:writer+' ',headText:writer};assert(bounded([change,delta],files).run.includes('test/unrelated.test.ts'));
 const source="import {readFileSync} from 'node:fs';export const value=readFileSync('app/value.ts','utf8');";assert(bounded([change],fixture(source)).run.includes('test/unrelated.test.ts'));
});
test('unchanged literal process status does not imply a repository read',()=>{
 const source="import {readFile} from 'node:fs/promises';export const memory=()=>readFile('/proc/self/status','utf8');";
 const p=bounded([change],fixture(source));assert(!p.run.includes('test/unrelated.test.ts'));assert.equal(p.nonRepositoryIo['test/timing.ts'].kind,'process-status-only');
});
test('unknown child process loaders remain broad even when parent reads only proc',()=>{
 const source="import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';export const memory=()=>{const child=spawn('node',[process.env.SCRIPT]);return readFile(`/proc/${child.pid}/status`,'utf8');};";
 assert(bounded([change],fixture(source)).run.includes('test/unrelated.test.ts'));
});
test('reviewed extractor binds its child runtime asset and broadens when that asset changes',()=>{
 const path='packs/performance/onehr/evidence-extraction.ts',asset='packs/performance/onehr/evidence-extractor.cjs',source=readFileSync(new URL('../../'+path,import.meta.url),'utf8');
 const files=fixture();files.delete('test/timing.ts');files.set(path,source);files.set(asset,'module.exports=1;');files.set('packs/performance/onehr/evidence-file-model.ts','export const evidenceFileMaxBytes=1000;');files.set('test/unrelated.test.ts',"import '../"+path+"';");
 const plan=bounded([change],files);assert.equal(plan.nonRepositoryIo[path]?.kind,'process-status-only');assert(!plan.run.includes('test/unrelated.test.ts'));
 const changed={path:asset,status:'M',baseText:'module.exports=0;',headText:'module.exports=1;'};assert(bounded([change,changed],files).run.includes('test/unrelated.test.ts'));
});
