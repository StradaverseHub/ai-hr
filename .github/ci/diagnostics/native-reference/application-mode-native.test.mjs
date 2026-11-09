/** Genuine tiny default Programs on hosted Actions only. Metadata, not semantics
 * or the five actual application API negatives. No host/AST/binder overrides. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {compilerOwner} from './worker.mjs';
import {observeNativeUsageResolution} from './application-mode.mjs';
import {walkNativeApplicationSyntax,captureNativeApplicationAttachments} from './application-syntax.mjs';
import {observeNativeInclusion} from './application-worker.mjs';
const fixtures=Object.freeze({
 'dep.ts':'export const value=1; export type Kind={ok:true};\n',
 'static.ts':'import {value} from "./dep"; export {value} from "./dep";\n',
 'dynamic.ts':'export const later=import("./dep");\n',
 'type.ts':'export type K=import("./dep").Kind;\n',
 'equals.ts':'import chosen=require("./dep"); export {chosen};\n',
 'attributes.ts':'import type {Kind} from "./dep" with {"resolution-mode":"import"}; export type K=import("./dep",{with:{"resolution-mode":"require"}}).Kind;\n',
 'jsdoc.js':'/** @import {Kind} from "./dep" */\nexport const tagged=1;\n',
 'require.ts':'export const raw=require("./dep");\n',
});
function owned(work){const root=realpathSync(mkdtempSync(join(tmpdir(),'compiler-native-mode-')));try{for(const[name,body]of Object.entries(fixtures))writeFileSync(join(root,name),body,{flag:'wx',mode:0o600});return work(root);}finally{rmSync(root,{recursive:true,force:true});}}
function references(ts,file,observeNode=()=>{}){
 const integrity=captureNativeApplicationAttachments(ts,[file]);
 const rows=[],seen=new Set();const add=(literal,kind)=>{if(!seen.has(literal)){seen.add(literal);rows.push({literal,kind});}};
 const visit=node=>{
  integrity.observe(file,node);observeNode(node);
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))add(node.moduleSpecifier,ts.isImportDeclaration(node)?'import':'export');
  else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression))add(node.moduleReference.expression,'import-equals');
  else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))add(node.argument.literal,'import-type');
  else if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0])){if(node.expression.kind===ts.SyntaxKind.ImportKeyword)add(node.arguments[0],'dynamic-import');else if(ts.isIdentifier(node.expression)&&node.expression.text==='require')add(node.arguments[0],'require');}
  if(ts.isJSDocImportTag(node)&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))add(node.moduleSpecifier,'jsdoc-import');
 };walkNativeApplicationSyntax(ts,file,visit);integrity.verify();return rows;
}
/** Integrity observation only: reflect native own descriptors BEFORE the public
 * traversal, including attached docs and arrays. No getters or cache APIs. */
function parentImage(ts,files){
 const objects=new Map(),nodes=new WeakSet();
 const capture=object=>{let row=objects.get(object);if(!row){row={keys:Reflect.ownKeys(object),descriptors:Object.getOwnPropertyDescriptors(object)};objects.set(object,row);}return row;};
 const visit=node=>{
  if(nodes.has(node))return;nodes.add(node);const row=capture(node);
  for(const key of row.keys){const descriptor=row.descriptors[key];if('value' in descriptor&&Array.isArray(descriptor.value))capture(descriptor.value);}
  const docs=row.descriptors.jsDoc?.value;if(Array.isArray(docs))for(const doc of docs)visit(doc);
  ts.forEachChild(node,visit);
 };
 for(const file of files)visit(file);
 const unchanged=()=>{for(const[object,row]of objects){
  const keys=Reflect.ownKeys(object);assert.equal(keys.length,row.keys.length);for(let index=0;index<keys.length;index++)assert.strictEqual(keys[index],row.keys[index]);
  for(const key of row.keys){const before=row.descriptors[key],after=Object.getOwnPropertyDescriptor(object,key);assert(after);assert.equal(Object.hasOwn(after,'value'),Object.hasOwn(before,'value'));for(const field of ['value','writable','get','set','enumerable','configurable'])if(!Object.is(after[field],before[field]))assert.fail('Original native own descriptor changed: '+String(key)+'.'+field);}
 }};
 Object.defineProperty(unchanged,'hasNativeNode',{value:node=>nodes.has(node)});return unchanged;
}
function checkNativeInclusion(root){
 const sources={
  'package.json':'{"type":"module"}',
  'carrier.ts':'/// <reference path="./path.d.ts" />\n/// <reference types="demo" />\n/// <reference lib="es2015.promise" />\nimport {kind} from "./dep.js"; export {kind} from "./dep.js";\nimport "./missing.js"; import "./outside-membership.js";\n',
  'path.d.ts':'declare const fromPath: true;\n',
  'dep.ts':'export const kind=1; export type Kind=1;\n',
  'outside-membership.js':'export const value=1;\n',
  'mode.ts':'import type {Kind} from "./dep.js" with {"resolution-mode":"import"};\nexport type Other=import("./dep.js",{with:{"resolution-mode":"require"}}).Kind;\n',
  'types.d.ts':'/** @param input {import("./dep.js").Kind} */\nexport declare function use(input: import("./dep.js").Kind): void;\n',
  'asset.json':'{"value":1}',
  'node_modules/react/package.json':'{"name":"react","version":"1.0.0","type":"module","exports":{"./jsx-runtime":{"types":"./jsx-runtime.d.ts"}}}',
  'node_modules/react/jsx-runtime.d.ts':'export declare function jsx(): unknown;\n',
  'node_modules/@types/demo/package.json':'{"name":"@types/demo","version":"1.0.0","types":"index.d.ts"}',
  'node_modules/@types/demo/index.d.ts':'declare const demo: true;\n',
 };
 for(const dir of ['one','two']){
  sources[dir+'/entry.ts']='export type {Item} from "peer-package";\n';
  sources[dir+'/node_modules/peer-package/package.json']='{"name":"peer-package","version":"1.0.0","type":"module","types":"index.d.ts","peerDependencies":{"actual-peer":"*"}}';
  sources[dir+'/node_modules/peer-package/index.d.ts']='export interface Item { value: true }\n';
  sources[dir+'/node_modules/actual-peer/package.json']='{"name":"actual-peer","version":"2.3.4"}';
 }
 const context=join(root,'inclusion');
 for(const[name,body]of Object.entries(sources)){const path=join(context,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,body,{flag:'wx',mode:0o600});}
 const owner=compilerOwner(process.cwd()),{ts}=owner,roots=['carrier.ts','mode.ts','types.d.ts','asset.json','one/entry.ts','two/entry.ts'].map(name=>join(context,name));
 const options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,jsx:ts.JsxEmit.ReactJSX,isolatedModules:true,resolveJsonModule:true,allowJs:false,lib:['lib.es5.d.ts'],typeRoots:[join(context,'node_modules/@types')],noEmit:true};
 const program=ts.createProgram({rootNames:roots,options}),unchanged=parentImage(ts,program.getSourceFiles());
 const docs=references(ts,program.getSourceFile(roots[2]));assert.deepEqual(docs.map(row=>row.literal.text),['./dep.js','./dep.js']);
 const syntheticImages=[roots[0],roots[3]].flatMap(path=>{
  const literal=program.getSourceFile(path).imports.find(ref=>ref.text==='react/jsx-runtime');assert(literal?.parent);
  return[literal,literal.parent].map(node=>[node,Object.getOwnPropertyDescriptors(node)]);
 });
 const native=observeNativeInclusion(owner,program,()=>{}),fileIndex=name=>{const index=native.files.findIndex(row=>row.logicalPath===join(context,name));assert(index>=0,name);return index;};
 const reasons=(name,kind)=>native.files[fileIndex(name)].reasons.filter(row=>row.kind===kind);
 const dependency=reasons('dep.ts',3),carrier=fileIndex('carrier.ts'),same=dependency.filter(row=>row.from===carrier);
 assert.equal(same.length,2);assert.notEqual(same[0].pos,same[1].pos);assert.equal(same[0].stored,same[1].stored);
 assert(same.every(row=>row.name==='./dep.js'&&!row.synthetic&&row.storedTargetMatchesReason));
 const modes=native.stores.filter(row=>row.file===fileIndex('mode.ts')&&row.name==='./dep.js').map(row=>row.mode).sort((a,b)=>a-b);
 assert.deepEqual(modes,[ts.ModuleKind.CommonJS,ts.ModuleKind.ESNext]);
 const documented=dependency.filter(row=>row.from===fileIndex('types.d.ts'));
 assert.equal(documented.length,1);assert.equal(documented[0].pos,docs[1].literal.pos);assert.notEqual(documented[0].pos,docs[0].literal.pos);
 assert.deepEqual(native.stores.filter(row=>row.file===carrier&&row.name==='./missing.js').map(row=>row.target),[null]);
 const outside=native.stores.find(row=>row.file===carrier&&row.name==='./outside-membership.js').target;
 assert.deepEqual([outside.status,outside.loadedFile,outside.logicalPath],['RESOLVED_NOT_LOADED',null,join(context,'outside-membership.js')]);
 const jsx=reasons('node_modules/react/jsx-runtime.d.ts',3);
 for(const name of ['carrier.ts','asset.json']){const rows=jsx.filter(row=>row.from===fileIndex(name));assert.equal(rows.length,1);assert.deepEqual([rows[0].name,rows[0].synthetic,rows[0].pos,rows[0].end,rows[0].storedTargetMatchesReason],['react/jsx-runtime',true,-1,-1,true]);}
 assert(reasons('path.d.ts',4).some(row=>row.from===carrier&&row.name==='./path.d.ts'&&row.selectedTargetMatchesReason));
 assert(reasons('node_modules/@types/demo/index.d.ts',5).some(row=>row.from===carrier&&row.name==='demo'&&row.storedTargetMatchesReason));
 assert.equal(native.automaticOrigin,'IMPLICIT');assert.deepEqual(native.automaticTypes.map(row=>row.name),['demo']);
 assert(reasons('node_modules/@types/demo/index.d.ts',8).some(row=>row.automatic===0&&row.storedTargetMatchesReason));
 const lib=native.files.find(row=>basename(row.logicalPath)==='lib.es2015.promise.d.ts');assert(lib?.reasons.some(row=>row.kind===7&&row.from===carrier&&row.name==='es2015.promise'&&row.selectedTargetMatchesReason));
 const first=fileIndex('one/node_modules/peer-package/index.d.ts'),second=fileIndex('two/node_modules/peer-package/index.d.ts');
 assert.equal(native.files[first].redirect,null);assert.equal(native.files[second].redirect?.loadedFile,first);
 assert.equal(native.files[second].packageScope.type,'module');assert.equal(native.files[second].impliedEmitFormat,ts.ModuleKind.ESNext);
 assert.deepEqual(native.stores.filter(row=>row.name==='peer-package').map(row=>row.target.packageId.peerDependencies),['+actual-peer@2.3.4','+actual-peer@2.3.4']);
 for(const[node,before]of syntheticImages)assert.deepEqual(Object.getOwnPropertyDescriptors(node),before);
 unchanged();assert.strictEqual(program.getCompilerOptions(),options);assert.deepEqual(program.getRootFileNames(),roots);
 for(const[name,body]of Object.entries(sources))assert.equal(readFileSync(join(context,name),'utf8'),body);
}
test('actual unchanged default Program retains all syntax forms while unparented TS require remains an explicit unresolved-context observation',()=>owned(root=>{
 const{ts}=compilerOwner(process.cwd()),options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowJs:true,noEmit:true};
 const names=Object.keys(fixtures).filter(name=>name!=='dep.ts'),roots=names.map(name=>join(root,name)),program=ts.createProgram({rootNames:roots,options});assert.deepEqual(program.getRootFileNames(),roots);
 const files=roots.map(path=>program.getSourceFile(path));assert(files.every(Boolean));const unchanged=parentImage(ts,program.getSourceFiles()),refs=files.flatMap(file=>references(ts,file,node=>assert(unchanged.hasNativeNode(node))).map(row=>({...row,file})));
 // Independent expected syntax membership, including BOTH attribute expressions.
 assert.deepEqual(refs.map(row=>[basename(row.file.fileName),row.kind]),[['static.ts','import'],['static.ts','export'],['dynamic.ts','dynamic-import'],['type.ts','import-type'],['equals.ts','import-equals'],['attributes.ts','import'],['attributes.ts','import-type'],['jsdoc.js','jsdoc-import'],['require.ts','require']]);
 const observed=refs.map(row=>({...row,observation:observeNativeUsageResolution(ts,program,row.file,row.literal,options)}));assert.equal(observed.length,9);
 const jsdocRow=observed.find(row=>row.kind==='jsdoc-import'),tag=jsdocRow.literal.parent;assert(tag&&ts.isJSDocImportTag(tag));assert.strictEqual(tag.moduleSpecifier,jsdocRow.literal);
 // Native tag.parent may be absent. Bind the ORIGINAL host/document/tag through
 // independent DATA descriptors and the real document.tags identity instead.
 const attachments=[];const attached=node=>{const documents=Object.getOwnPropertyDescriptor(node,'jsDoc')?.value;if(Array.isArray(documents))for(const document of documents){const tags=Object.getOwnPropertyDescriptor(document,'tags')?.value;if(Array.isArray(tags)&&tags.includes(tag))attachments.push({host:node,document,tags});}ts.forEachChild(node,attached);};attached(jsdocRow.file);
 assert.equal(attachments.length,1);const{host,document,tags}=attachments[0];assert(ts.isJSDoc(document));assert(unchanged.hasNativeNode(host)&&unchanged.hasNativeNode(document)&&unchanged.hasNativeNode(tag));assert.strictEqual(tags.find(value=>value===tag),tag);assert.equal(host.parent,undefined);assert.equal(jsdocRow.file.text.slice(document.pos,document.end),'/** @import {Kind} from "./dep" */');assert.equal(jsdocRow.literal.getStart(jsdocRow.file),jsdocRow.file.text.indexOf('"./dep"'));
 const requireRow=observed.find(row=>row.kind==='require');assert.equal(requireRow.literal.parent,undefined);assert.throws(()=>program.getModeForUsageLocation(requireRow.file,requireRow.literal),error=>error instanceof TypeError&&error.message.includes('kind'));assert.deepEqual(requireRow.observation,{mode:null,modeObserved:false,resolutionAttempted:false,nativeParentKind:null,resolvedModule:null});
 for(const row of observed.filter(row=>row!==requireRow)){assert.equal(row.observation.modeObserved,true);assert.equal(row.observation.resolutionAttempted,true);assert(row.literal.parent);assert.equal(realpathSync(row.observation.resolvedModule.resolvedFileName),join(root,'dep.ts'));}
 assert.equal(observed.find(row=>basename(row.file.fileName)==='attributes.ts'&&row.kind==='import').observation.mode,ts.ModuleKind.ESNext);
 assert.equal(observed.find(row=>basename(row.file.fileName)==='attributes.ts'&&row.kind==='import-type').observation.mode,ts.ModuleKind.CommonJS);
 unchanged();assert.equal(program.getCompilerOptions(),options);assert.deepEqual(readdirSync(root).sort(),Object.keys(fixtures).sort());for(const[name,body]of Object.entries(fixtures))assert.equal(readFileSync(join(root,name),'utf8'),body);
}));
test('actual public native undefined mode is observed rather than treated as unavailable or replaced by a guessed fallback',()=>owned(root=>{
 const{ts}=compilerOwner(process.cwd()),options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,noEmit:true},path=join(root,'static.ts'),program=ts.createProgram({rootNames:[path],options});
 const file=program.getSourceFile(path),unchanged=parentImage(ts,program.getSourceFiles()),refs=references(ts,file,node=>assert(unchanged.hasNativeNode(node)));assert.deepEqual(refs.map(row=>row.kind),['import','export']);
 for(const row of refs){assert(row.literal.parent);assert.equal(program.getModeForUsageLocation(file,row.literal),undefined);const observed=observeNativeUsageResolution(ts,program,file,row.literal,options);assert.equal(observed.mode,null);assert.equal(observed.modeObserved,true);assert.equal(observed.resolutionAttempted,true);assert.equal(realpathSync(observed.resolvedModule.resolvedFileName),join(root,'dep.ts'));}
 unchanged();assert.equal(program.getCompilerOptions(),options);
}));
test('retains actual leading, nested, adjacent and EOF JSDoc attachments and import types without admitting marker text or service nodes',()=>owned(root=>{
 const sources={
  'doc-hosts.js':[
   '/** Leading native documentation. */',
   'export const before=0;',
   'function nested(){',
   ' /** @import {Kind as Nested} from "./dep" with {"resolution-mode":"require"} */',
   ' let value;',
   ' /** @type {import("./dep",{with:{"resolution-mode":"require"}}).Kind} */',
   ' let typed;',
   '}',
   'function inline(/** @type {import("./dep").Kind} */ parameter){return parameter;}',
   '/** @import {Kind as First} from "./dep" */',
   '/** @import {Kind as Second} from "./dep" */',
   'export const adjacent=1;',
   '/* Ordinary block contains a marker /** @import {Fake} from "./absent" */',
   'export const marker="/** @import {Fake} from ./absent */";',
   '/** @import {Kind as Tail} from "./dep" */','',
  ].join('\n'),
  'doc-only.js':'/** @import {Kind as Only} from "./dep" */\n',
 };
 for(const[name,body]of Object.entries(sources))writeFileSync(join(root,name),body,{flag:'wx',mode:0o600});
 const{ts}=compilerOwner(process.cwd()),options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowJs:true,noEmit:true},roots=Object.keys(sources).map(name=>join(root,name)),program=ts.createProgram({rootNames:roots,options});assert.deepEqual(program.getRootFileNames(),roots);
 const files=roots.map(path=>program.getSourceFile(path));assert(files.every(Boolean));const unchanged=parentImage(ts,program.getSourceFiles()),nativeDocuments=new Map(),seen=new WeakSet();
 // Independent native attachment inventory, using own descriptors only for
 // fixture integrity. It does not reuse the production trivia gate or walker.
 const original=node=>{if(seen.has(node))return;seen.add(node);const docs=Object.getOwnPropertyDescriptor(node,'jsDoc')?.value;if(Array.isArray(docs))for(const document of docs){assert(ts.isJSDoc(document));assert(!nativeDocuments.has(document));nativeDocuments.set(document,node);}ts.forEachChild(node,original);};for(const file of files)original(file);
 assert.equal(nativeDocuments.size,8);assert.equal([...nativeDocuments.values()].filter(node=>node.kind===ts.SyntaxKind.EndOfFileToken).length,2);
 const observedDocuments=new Set(),visited=new WeakSet(),refs=files.flatMap(file=>references(ts,file,node=>{assert(unchanged.hasNativeNode(node),'Service-created node cannot be a native AST observation');assert(!visited.has(node),'Duplicate native node');visited.add(node);assert.notEqual(node.kind,ts.SyntaxKind.SyntaxList);if(ts.isJSDoc(node))observedDocuments.add(node);}).map(row=>({...row,file})));
 assert.deepEqual(observedDocuments,new Set(nativeDocuments.keys()));
 const expected=[
  ['doc-hosts.js','jsdoc-import','@import {Kind as Nested} from '],
  ['doc-hosts.js','import-type','@type {import('],
  ['doc-hosts.js','import-type','function inline(/** @type {import('],
  ['doc-hosts.js','jsdoc-import','@import {Kind as First} from '],
  ['doc-hosts.js','jsdoc-import','@import {Kind as Second} from '],
  ['doc-hosts.js','jsdoc-import','@import {Kind as Tail} from '],
  ['doc-only.js','jsdoc-import','@import {Kind as Only} from '],
 ];
 assert.equal(refs.length,expected.length);
 for(let index=0;index<expected.length;index++){
  const[name,kind,anchor]=expected[index],row=refs[index],text=sources[name],position=text.indexOf(anchor)+anchor.length;assert(text.includes(anchor));assert.deepEqual([basename(row.file.fileName),row.kind,row.literal.getStart(row.file)],[name,kind,position]);assert.equal(text.slice(position,row.literal.end),'"./dep"');assert(unchanged.hasNativeNode(row.literal));
  const observation=observeNativeUsageResolution(ts,program,row.file,row.literal,options);assert.equal(observation.modeObserved,true);assert.equal(observation.resolutionAttempted,true);assert.equal(realpathSync(observation.resolvedModule.resolvedFileName),join(root,'dep.ts'));if(index<2)assert.equal(observation.mode,ts.ModuleKind.CommonJS);
 }
 unchanged();assert.strictEqual(program.getCompilerOptions(),options);for(const[name,body]of Object.entries(sources))assert.equal(readFileSync(join(root,name),'utf8'),body);assert.deepEqual(readdirSync(root).sort(),[...Object.keys(fixtures),...Object.keys(sources)].sort());
}));
test('the genuine default Program retains complete original attachment closure across binary JSX and template syntax without trivia or service getter assumptions',()=>owned(root=>{
 const sources={
  'operators.js':'/** @import {Kind} from "./dep" */\nexport function calculate(/** @type {import("./dep").Kind} */ value){return (1 + 2) * (3 - (4 / 2));}\n',
  'view.tsx':'/** Original native JSX and template control. */\nexport const expression=(1 + 2) * (3 - (4 / 2));\nexport const view=<section title={"/** ordinary string marker */"}>{`${expression}`}</section>;\n/* ordinary marker /** is not a parsed JSDoc attachment */\n',
 };
 for(const[name,body]of Object.entries(sources))writeFileSync(join(root,name),body,{flag:'wx',mode:0o600});
 const{ts}=compilerOwner(process.cwd()),options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.Preserve,allowJs:true,noEmit:true},roots=Object.keys(sources).map(name=>join(root,name)),program=ts.createProgram({rootNames:roots,options});assert.deepEqual(program.getRootFileNames(),roots);
 const files=program.getSourceFiles(),rootFiles=roots.map(name=>program.getSourceFile(name));assert(rootFiles.every(Boolean));const unchanged=parentImage(ts,files),integrity=captureNativeApplicationAttachments(ts,files),expected=new Set(),seen=new WeakSet();
 const census=node=>{if(seen.has(node))return;seen.add(node);const descriptor=Object.getOwnPropertyDescriptor(node,'jsDoc');if(descriptor&&'value'in descriptor&&Array.isArray(descriptor.value))for(let index=0;index<descriptor.value.length;index++){const document=Object.getOwnPropertyDescriptor(descriptor.value,String(index))?.value;assert(ts.isJSDoc(document));expected.add(document);}ts.forEachChild(node,census);};for(const file of rootFiles)census(file);assert.equal(expected.size,3);
 const docs=new Set(),references=[],rootsSet=new Set(rootFiles);let binary=0,jsx=0,template=0;
 for(const file of files)walkNativeApplicationSyntax(ts,file,node=>{
  integrity.observe(file,node);assert(unchanged.hasNativeNode(node));assert.notEqual(node.kind,ts.SyntaxKind.SyntaxList);
  if(rootsSet.has(file)){
   if(ts.isJSDoc(node))docs.add(node);if(ts.isBinaryExpression(node))binary++;if(ts.isJsxElement(node))jsx++;if(ts.isTemplateExpression(node))template++;
   if(ts.isJSDocImportTag(node)&&node.moduleSpecifier)references.push(['jsdoc-import',node.moduleSpecifier]);
   if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))references.push(['import-type',node.argument.literal]);
  }
 });
 assert.deepEqual(docs,expected);assert(binary>=6);assert.equal(jsx,1);assert.equal(template,1);assert.deepEqual(references.map(([kind,literal])=>[kind,literal.text]),[['jsdoc-import','./dep'],['import-type','./dep']]);for(const[,literal]of references)assert(unchanged.hasNativeNode(literal));
 integrity.verify();unchanged();assert.strictEqual(program.getCompilerOptions(),options);assert.deepEqual(program.getRootFileNames(),roots);for(const[name,body]of Object.entries(sources))assert.equal(readFileSync(join(root,name),'utf8'),body);
 checkNativeInclusion(root);
}));
