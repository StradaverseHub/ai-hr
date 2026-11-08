/** Pure native-layout/custody models, not compiler behavior evidence. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeOutputNames,outputOwnership,regularHash,assertOutputSeal} from './outputs.mjs';
import {planNativeReferences} from './graph.mjs';
import {writeNativeReferenceConfigs,assertNativeParsedConfig} from './config.mjs';
const file=(id,kind='implementation')=>({id,kind,sha256:'1'.repeat(64)});
test('native fixture mirror keeps ordinary JS/declarations and JSON paths without inventing a JSON declaration',()=>{
 for(const ext of ['ts','tsx','js','jsx'])assert.deepEqual(nativeOutputNames('producer/index.'+ext),['producer/index.js','producer/index.d.ts']);
 assert.deepEqual(nativeOutputNames('producer/data.json'),['producer/data.json']);assert.deepEqual(nativeOutputNames('producer/context.d.ts'),[]);
 assert.deepEqual(nativeOutputNames('index.mts'),['index.mjs','index.d.mts']);assert.deepEqual(nativeOutputNames('index.cts'),['index.cjs','index.d.cts']);
});
test('duplicate implementation writers and conflicting source identities refuse before any compiler can write',()=>{
 assert.throws(()=>outputOwnership({projects:[{index:0,owned:['same.ts','same.tsx'],context:[]}]},[file('same.ts'),file('same.tsx')]),/duplicate native implementation output/);
 assert.throws(()=>outputOwnership({projects:[{index:0,owned:['a.ts'],context:[]}]},[file('a.ts'),file('a.ts')]),/Duplicate native source identity/);
 const shared=file('data.json','json');const rows=outputOwnership({projects:[{index:0,owned:['a.ts'],context:['data.json']},{index:1,owned:['b.ts'],context:['data.json']}]},[file('a.ts'),file('b.ts'),shared]);
 assert.deepEqual(rows.find(r=>r.source==='data.json').projects,[0,1]);assert.equal(rows.filter(r=>r.path==='data.json').length,1);
});
test('real retained disk seals refuse stale or foreign bytes and retain the complete original after restoration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-reference-seal-')),path=join(dir,'owned.d.ts');try{writeFileSync(path,'export declare const literal: 7;\n');const seal=regularHash(path),original=readFileSync(path);assertOutputSeal([seal]);writeFileSync(path,'export declare const literal: string;\n');assert.throws(()=>assertOutputSeal([seal]),/Stale\/foreign/);writeFileSync(path,original);assertOutputSeal([seal]);}finally{rmSync(dir,{recursive:true});}
});
test('public native implementation and declaration phases never install a custom compiler host or resolution shim',()=>{
 const code=readFileSync(new URL('worker.mjs',import.meta.url),'utf8'),config=readFileSync(new URL('config.mjs',import.meta.url),'utf8');
 assert(!/createCompilerHost|host\s*:|\.resolveModuleNameLiterals\s*=|\.getSourceFile\s*=|\.fileExists\s*=|\.readFile\s*=|\.realpath\s*=/.test(code));
 assert(code.includes('ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences})'));
 assert(code.includes('program.getSemanticDiagnostics(source)'));assert(code.includes('Caller cannot omit/add owned native declarations'));assert(config.includes('emitDeclarationOnly:false'));assert(config.includes('const outDir=emitted'));
});
test('disk configuration independently recomputes every owned/nonroot/context input and refuses undersized or edited plans before publication',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-reference-config-budget-')));try{
  const source=join(dir,'source');mkdirSync(source);const names=['a.ts','global.d.ts','data.json'];
  for(const name of names)writeFileSync(join(source,name),name.endsWith('.json')?'{}':'export {};');
  const base=join(source,'base.json');writeFileSync(base,'{}');
  const files=[{...file('a.ts'),path:join(source,'a.ts')},{...file('global.d.ts','declaration'),ambient:true,path:join(source,'global.d.ts')},{...file('data.json','json'),path:join(source,'data.json')}];
  const inventory={roots:['a.ts'],buildRoots:['a.ts'],files,edges:[{from:'a.ts',to:'data.json'}]},plan=planNativeReferences(inventory,{roots:3,ownedClosure:1});
  const output=join(dir,'valid');mkdirSync(output);const written=writeNativeReferenceConfigs({base,source,output,plan,files});
  assert.deepEqual(JSON.parse(readFileSync(written.projects[0].config,'utf8')).files,names.map(name=>join(source,name)));assert.equal(written.projects[0].files.length,3);
  for(const [label,mutate]of [['undersized',p=>{p.limits.roots=2;}],['edited-membership',p=>{p.projects[0].configuredRoots.pop();}]]){
   const bad=structuredClone(plan);mutate(bad);const rejected=join(dir,label);mkdirSync(rejected);
   assert.throws(()=>writeNativeReferenceConfigs({base,source,output:rejected,plan:bad,files}));assert.equal(existsSync(join(rejected,'emitted')),false);
  }
  const wrong=files.map(row=>row.id==='a.ts'?{...row,path:join(source,'global.d.ts')}:row),rejected=join(dir,'wrong-identity');mkdirSync(rejected);
  assert.throws(()=>writeNativeReferenceConfigs({base,source,output:rejected,plan,files:wrong}),/Configured source identity differs/);
 }finally{rmSync(dir,{recursive:true});}
});
test('native parsed-file assertion refuses count, complete membership, order or duplicate drift under the same fixed cap',()=>{
 const names=['/private-model/a.ts','/private-model/nonroot.ts','/private-model/global.d.ts'];
 assert.doesNotThrow(()=>assertNativeParsedConfig({fileNames:names},names,{roots:3,ownedClosure:2}));
 assert.throws(()=>assertNativeParsedConfig({fileNames:names},names,{roots:2,ownedClosure:2}),/Actual parsed configured roots exceed/);
 assert.throws(()=>assertNativeParsedConfig({fileNames:[names[1],names[0],names[2]]},names,{roots:3,ownedClosure:2}),/Native parsed configured membership differs/);
 assert.throws(()=>assertNativeParsedConfig({fileNames:names.slice(0,2)},names,{roots:3,ownedClosure:2}),/Native parsed configured membership differs/);
 assert.throws(()=>assertNativeParsedConfig({fileNames:[names[0],names[0]]},[names[0],names[0]],{roots:3,ownedClosure:2}));
 const tooMany=Array.from({length:401},(_,i)=>'/private-model/input-'+i+'.ts');assert.throws(()=>assertNativeParsedConfig({fileNames:tooMany},tooMany),/Actual parsed configured roots exceed/);
});
