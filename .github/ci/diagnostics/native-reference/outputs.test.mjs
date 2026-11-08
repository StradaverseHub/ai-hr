/** Pure native-layout/custody models, not compiler behavior evidence. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync,existsSync,realpathSync,linkSync,symlinkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeOutputNames,outputOwnership,regularHash,dependencyInputHash,digest,assertOutputSeal} from './outputs.mjs';
import {planNativeReferences} from './graph.mjs';
import {writeNativeReferenceConfigs,assertNativeParsedConfig} from './config.mjs';
import {nativeFixtureIdentity,assertNativeIdentityRows,fixturePackageRoot,FIXTURE_PACKAGE_MANIFEST,FIXTURE_PACKAGE_BODY_SHA256,FIXTURE_PACKAGE_BODY_BYTES} from './package-context.mjs';
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

test('actual hard-linked dependency input is readable while the same inode remains forbidden as an owned output',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-dependency-links-'))),root=join(dir,'node_modules');mkdirSync(root);
 try{const file=join(root,'native.d.ts'),alias=join(dir,'store-entry'),body='export declare const literal: 7;\n';writeFileSync(file,body);linkSync(file,alias);assert.equal(lstatSync(file).nlink,2);const expected=digest(Buffer.from(body));
  assert.deepEqual(dependencyInputHash(file,root,expected),{path:file,sha256:expected,bytes:Buffer.byteLength(body)});assert.throws(()=>regularHash(file),/Native regular file custody refused/);assert.throws(()=>assertOutputSeal([{path:file,sha256:expected,bytes:Buffer.byteLength(body)}]),/Native regular file custody refused/);
  assert.equal(readFileSync(alias,'utf8'),body);assert.equal(lstatSync(file).nlink,2);
 }finally{rmSync(dir,{recursive:true});}
});
test('dependency input refuses outside paths, symlink files and a symlink dependency root',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-dependency-path-'))),root=join(dir,'node_modules');mkdirSync(root);
 try{const outside=join(dir,'foreign.d.ts'),body='export {};\n';writeFileSync(outside,body);const expected=digest(Buffer.from(body)),link=join(root,'link.d.ts');symlinkSync(outside,link);
  assert.throws(()=>dependencyInputHash(outside,root,expected),/outside canonical input tree/);assert.throws(()=>dependencyInputHash(link,root,expected),/outside canonical input tree/);
  const rootLink=join(dir,'foreign-root');symlinkSync(root,rootLink);assert.throws(()=>dependencyInputHash(outside,rootLink,expected));assert.equal(readFileSync(outside,'utf8'),body);
 }finally{rmSync(dir,{recursive:true});}
});
test('actual dependency alias mutation cannot match the native loaded byte hash and never changes output policy',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-dependency-change-'))),root=join(dir,'node_modules');mkdirSync(root);
 try{const path=join(root,'native.d.ts'),alias=join(dir,'store-entry'),original='export declare const literal: 7;\n';writeFileSync(path,original);linkSync(path,alias);const expected=digest(Buffer.from(original));
  writeFileSync(alias,'export declare const literal: 8;\n');assert.throws(()=>dependencyInputHash(path,root,expected),/Native loaded dependency bytes changed/);writeFileSync(alias,original);assert.equal(dependencyInputHash(path,root,expected).sha256,expected);assert.throws(()=>regularHash(path),/Native regular file custody refused/);
 }finally{rmSync(dir,{recursive:true});}
});
test('dependency inputs retain exact positive byte bounds and the worker excludes every configured, fixture and output owner',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-dependency-bound-'))),root=join(dir,'node_modules');mkdirSync(root);
 try{const path=join(root,'native.d.ts'),body='export {};\n';writeFileSync(path,body);const expected=digest(Buffer.from(body));assert.throws(()=>dependencyInputHash(path,root,expected,body.length-1),/Read-only dependency input refused/);assert.throws(()=>dependencyInputHash(path,root,'0'.repeat(63)));assert.throws(()=>dependencyInputHash(path,root,expected,0));assert.throws(()=>dependencyInputHash(path,root,expected,513*1024**2));assert.equal(dependencyInputHash(path,root,expected,body.length).bytes,body.length);const empty=join(root,'empty.d.ts');writeFileSync(empty,'');assert.equal(dependencyInputHash(empty,root,digest(Buffer.alloc(0))).bytes,0);
  const worker=readFileSync(new URL('worker.mjs',import.meta.url),'utf8');assert(worker.includes('(external||defaultLibrary)&&inside(dependencyRoot,path)&&!configured.has(path)&&!inside(source,path)&&!owned.has(path)'));assert(worker.includes("assert.equal(realpathSync(dependencyRoot),dependencyRoot,'External dependency tree refused')"));
  assert(worker.includes('assertOutputSeal(seals);assertOutputSeal(projectSeals);'));assert.equal(worker.split('assertOutputSeal(seals);').length-1,4);
  const layer=JSON.parse(readFileSync(new URL('package-context-inverse.json',import.meta.url),'utf8'));assert.equal(layer.base,'5c86c5630341c4ea17085b4f8bf8a8171b047b52');const restored=new Map();for(const[name,row]of Object.entries(layer.files)){let text=readFileSync(new URL('../../../../'+name,import.meta.url),'utf8');assert.equal(digest(Buffer.from(text)),row.currentSha256);let frontier=text.length;for(const edit of row.edits){assert(edit.start>=0&&edit.end<=frontier);assert.equal(text.slice(edit.start,edit.end),edit.current);text=text.slice(0,edit.start)+edit.original+text.slice(edit.end);frontier=edit.start;}assert.equal(digest(Buffer.from(text)),row.originalSha256);restored.set(name,text);}
  const inverse=JSON.parse(readFileSync(new URL('dependency-custody-inverse.json',import.meta.url),'utf8'));assert.equal(inverse.base,'7c6d847abdc44a49db179e1c848cea06e63661a3');for(const[name,row]of Object.entries(inverse.files)){let text=restored.get(name)??readFileSync(new URL('../../../../'+name,import.meta.url),'utf8');assert.equal(digest(Buffer.from(text)),row.currentSha256);let frontier=text.length;for(const edit of row.edits){assert(edit.start>=0&&edit.end<=frontier);assert.equal(text.slice(edit.start,edit.end),edit.current);text=text.slice(0,edit.start)+edit.original+text.slice(edit.end);frontier=edit.start;}assert.equal(digest(Buffer.from(text)),row.originalSha256);}
 }finally{rmSync(dir,{recursive:true});}
});

test('native identities distinguish the one common fictional package from actual pinned default libraries',()=>{
 const source='/private-fixture/source',compilerLib='/candidate/node_modules/typescript/lib',options={source,compilerLib,declaration:true,external:true,defaultLibrary:false};
 assert.equal(fixturePackageRoot(source),'/private-fixture/node_modules/fixture-external');
 assert.equal(nativeFixtureIdentity(source+'/producer/index.ts',{...options,declaration:false,external:false}),'producer/index.ts');
 assert.equal(nativeFixtureIdentity(fixturePackageRoot(source)+'/index.d.ts',options),'external/fixture-external/index.d.ts');
 assert.equal(nativeFixtureIdentity(compilerLib+'/lib.esnext.d.ts',{...options,defaultLibrary:true}),'external/typescript/lib.esnext.d.ts');
 for(const path of ['/foreign/index.d.ts','/foreign/lib.esnext.d.ts',compilerLib+'/index.d.ts',compilerLib+'/sub/lib.esnext.d.ts'])assert.throws(()=>nativeFixtureIdentity(path,{...options,defaultLibrary:true}),/Unknown outside-source/);
 for(const changed of [{declaration:false},{external:false},{defaultLibrary:true}])assert.throws(()=>nativeFixtureIdentity(fixturePackageRoot(source)+'/index.d.ts',{...options,...changed}),/classification differs/);
 assert.throws(()=>nativeFixtureIdentity('/private-fixture/source/../unknown.d.ts',options),/Canonical/);
});
test('complete native identity rows refuse duplicate IDs or aliased paths rather than mislabel another package',()=>{
 assertNativeIdentityRows([{id:'producer/index.ts',path:'/private/source/producer/index.ts'},{id:'external/fixture-external/index.d.ts',path:'/private/node_modules/fixture-external/index.d.ts'}]);
 for(const rows of [[{id:'a',path:'/one'},{id:'a',path:'/two'}],[{id:'a',path:'/one'},{id:'b',path:'/one'}]])assert.throws(()=>assertNativeIdentityRows(rows),/Duplicate native context identity/);
});
test('one owned fictional package lives at the common ancestor and both manifest and original declaration stay strictly sealed',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-common-package-'))),source=join(dir,'source'),emitted=join(dir,'projects/emitted');mkdirSync(source);mkdirSync(emitted,{recursive:true});const root=fixturePackageRoot(source);mkdirSync(root,{recursive:true});
 try{const body=readFileSync(new URL('../../../../test/fixtures/compiler-native-reference/external/index.d.ts.fixture',import.meta.url));assert.equal(body.length,FIXTURE_PACKAGE_BODY_BYTES);assert.equal(digest(body),FIXTURE_PACKAGE_BODY_SHA256);writeFileSync(join(root,'package.json'),FIXTURE_PACKAGE_MANIFEST,{flag:'wx'});writeFileSync(join(root,'index.d.ts'),body,{flag:'wx'});const seals=['package.json','index.d.ts'].map(name=>regularHash(join(root,name)));
  assert.equal(existsSync(join(source,'node_modules')),false);assert.equal(existsSync(join(emitted,'node_modules')),false);
  for(const row of seals){const original=readFileSync(row.path);try{writeFileSync(row.path,Buffer.concat([original,Buffer.from('changed')]));assert.throws(()=>assertOutputSeal(seals));}finally{writeFileSync(row.path,original);}assertOutputSeal(seals);}
  const alias=join(dir,'foreign-package-alias');linkSync(join(root,'index.d.ts'),alias);assert.throws(()=>regularHash(join(root,'index.d.ts')),/Native regular file custody refused/);
 }finally{rmSync(dir,{recursive:true});}
});
test('every real native observation checks exact shared package membership and fixed default host without introducing resolution shims',()=>{
 const worker=readFileSync(new URL('worker.mjs',import.meta.url),'utf8'),fixture=readFileSync(new URL('fixture.mjs',import.meta.url),'utf8'),owner=readFileSync(new URL('package-context.mjs',import.meta.url),'utf8');
 assert.equal(worker.split('fixtureExternal:observedFixturePackage(').length-1,3);assert(worker.includes("dirname(realpathSync(owner.api))"));assert(worker.includes('assertNativeIdentityRows(files)'));
 assert(owner.includes('program.getSourceFiles()'));assert(owner.includes('ts.resolveModuleName(literal.text,file.fileName,options,ts.sys'));assert(owner.includes('syntheticResolution:false'));
 assert(fixture.includes('const external=fixturePackageRoot(source)'));assert(fixture.includes('packageContext(validated)'));assert(fixture.includes('packageContext(externalControl)'));
 assert(!fixture.includes("join(source,'node_modules/fixture-external')"));assert(!owner.includes('createCompilerHost'));assert(!owner.includes('resolveModuleNames:'));
});
