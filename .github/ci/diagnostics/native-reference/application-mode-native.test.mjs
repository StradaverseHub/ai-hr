/** Genuine tiny default Programs on hosted Actions only. Metadata, not semantics
 * or the five actual application API negatives. No host/AST/binder overrides. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {compilerOwner} from './worker.mjs';
import {observeNativeUsageResolution} from './application-mode.mjs';
import {walkNativeApplicationSyntax} from './application-syntax.mjs';
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
 const rows=[],seen=new Set();const add=(literal,kind)=>{if(!seen.has(literal)){seen.add(literal);rows.push({literal,kind});}};
 const visit=node=>{
  observeNode(node);
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))add(node.moduleSpecifier,ts.isImportDeclaration(node)?'import':'export');
  else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression))add(node.moduleReference.expression,'import-equals');
  else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))add(node.argument.literal,'import-type');
  else if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0])){if(node.expression.kind===ts.SyntaxKind.ImportKeyword)add(node.arguments[0],'dynamic-import');else if(ts.isIdentifier(node.expression)&&node.expression.text==='require')add(node.arguments[0],'require');}
  if(ts.isJSDocImportTag(node)&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))add(node.moduleSpecifier,'jsdoc-import');
 };walkNativeApplicationSyntax(ts,file,visit);return rows;
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
