import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compilerInputFingerprint,controllerOnlyMembers,nativeListedFiles} from './compiler-bounded-input-fingerprint.mjs';

const regular=(name,id='a')=>`100644 blob ${id.repeat(40)}\t${name}\0`;
const fixture=(...rows)=>({tracked:Buffer.from([regular('tsconfig.json'),regular('app/f.ts'),...rows].join('')),
 configured:['app/f.ts','.next/types/validator.ts'],loaded:['node_modules/typescript/lib/lib.d.ts','app/f.ts','.next/types/validator.ts'],
 generatedSha256:'b'.repeat(64),toolSha256:'c'.repeat(64),nodeSha256:'d'.repeat(64),argvSha256:'e'.repeat(64)});

test('same compiler inputs survive only exact listed controller alignment changes',()=>{
 const prior=compilerInputFingerprint(fixture(regular(controllerOnlyMembers.at(-1),'b')));
 const aligned=compilerInputFingerprint(fixture(...controllerOnlyMembers.map(name=>regular(name,'c'))));
 assert.deepEqual(aligned,prior);
 assert.notEqual(compilerInputFingerprint(fixture(regular('docs/source.md'))).inputFingerprintSha256,prior.inputFingerprintSha256);
 const changed=fixture(regular(controllerOnlyMembers.at(-1),'b'));
 changed.tracked=Buffer.from(changed.tracked.toString().replace(regular('app/f.ts'),regular('app/f.ts','f')));
 assert.notEqual(compilerInputFingerprint(changed).inputFingerprintSha256,prior.inputFingerprintSha256);
});

test('refuses an excluded native root or a loaded excluded source, and binds generated and ordered load identity',()=>{
 const source=fixture();
 for(const key of ['configured','loaded']){
  const wrong={...source,[key]:[...source[key],controllerOnlyMembers[0]]};
  assert.throws(()=>compilerInputFingerprint(wrong),/belongs to the native compiler/);
 }
 assert.throws(()=>compilerInputFingerprint({...source,loaded:source.loaded.slice(0,2)}),/omitted a configured root/);
 assert.throws(()=>compilerInputFingerprint({...source,loaded:[...source.loaded,source.loaded[0]]}));
 for(const changed of [{loaded:source.loaded.slice().reverse()},{generatedSha256:'1'.repeat(64)},{toolSha256:'2'.repeat(64)},
  {nodeSha256:'3'.repeat(64)},{argvSha256:'4'.repeat(64)}]){
  assert.notEqual(compilerInputFingerprint({...source,...changed}).inputFingerprintSha256,compilerInputFingerprint(source).inputFingerprintSha256);
 }
});

test('accepts only canonical absolute compiler load rows in the owned source',()=>{
 const source='/home/runner/work/ai-hr/ai-hr/source';
 const native=rows=>nativeListedFiles(source,Buffer.from(rows.join('\n')+'\n'));
 assert.deepEqual(native([source+'/app/(main)/f.ts',source+'/node_modules/@types/node/index.d.ts']),
  ['app/(main)/f.ts','node_modules/@types/node/index.d.ts']);
 for(const row of ['warning: source','/outside/x.ts',source+'/../external.ts',source+'2/f.ts','app/f.ts',source+'/.git/index']){
  assert.throws(()=>native([row]));
 }
});
