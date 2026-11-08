/** Pure native-layout/custody models, not compiler behavior evidence. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeOutputNames,outputOwnership,regularHash,assertOutputSeal} from './outputs.mjs';
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
