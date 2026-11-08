/** Genuine tiny default Programs on hosted Actions only. Metadata, not semantics
 * or the five actual application API negatives. No host/AST/binder overrides. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {compilerOwner} from './worker.mjs';
import {observeNativeUsageResolution} from './application-mode.mjs';
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
function references(ts,file){
 const rows=[],seen=new Set();const add=(literal,kind)=>{if(!seen.has(literal)){seen.add(literal);rows.push({literal,kind});}};
 const visit=node=>{
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))add(node.moduleSpecifier,ts.isImportDeclaration(node)?'import':'export');
  else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression))add(node.moduleReference.expression,'import-equals');
  else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))add(node.argument.literal,'import-type');
  else if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0])){if(node.expression.kind===ts.SyntaxKind.ImportKeyword)add(node.arguments[0],'dynamic-import');else if(ts.isIdentifier(node.expression)&&node.expression.text==='require')add(node.arguments[0],'require');}
  for(const tag of ts.getJSDocTags(node))if(ts.isJSDocImportTag(tag)&&tag.moduleSpecifier&&ts.isStringLiteralLike(tag.moduleSpecifier))add(tag.moduleSpecifier,'jsdoc-import');
  ts.forEachChild(node,visit);
 };visit(file);return rows;
}
function parentImage(ts,files,refs){
 const rows=[],seen=new Set();const visit=node=>{if(seen.has(node))return;seen.add(node);rows.push({node,parent:node.parent,own:Object.hasOwn(node,'parent')});ts.forEachChild(node,visit);};
 for(const file of files)visit(file);for(const row of refs){let node=row.literal;while(node&&!seen.has(node)){visit(node);node=node.parent;}}
 return()=>{for(const row of rows){assert.equal(row.node.parent,row.parent);assert.equal(Object.hasOwn(row.node,'parent'),row.own);}};
}
test('actual unchanged default Program retains all syntax forms while unparented TS require remains an explicit unresolved-context observation',()=>owned(root=>{
 const{ts}=compilerOwner(process.cwd()),options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowJs:true,noEmit:true};
 const names=Object.keys(fixtures).filter(name=>name!=='dep.ts'),roots=names.map(name=>join(root,name)),program=ts.createProgram({rootNames:roots,options});assert.deepEqual(program.getRootFileNames(),roots);
 const files=roots.map(path=>program.getSourceFile(path));assert(files.every(Boolean));const refs=files.flatMap(file=>references(ts,file).map(row=>({...row,file}))),unchanged=parentImage(ts,files,refs);
 // Independent expected syntax membership, including BOTH attribute expressions.
 assert.deepEqual(refs.map(row=>[basename(row.file.fileName),row.kind]),[['static.ts','import'],['static.ts','export'],['dynamic.ts','dynamic-import'],['type.ts','import-type'],['equals.ts','import-equals'],['attributes.ts','import'],['attributes.ts','import-type'],['jsdoc.js','jsdoc-import'],['require.ts','require']]);
 const observed=refs.map(row=>({...row,observation:observeNativeUsageResolution(ts,program,row.file,row.literal,options)}));assert.equal(observed.length,9);
 const requireRow=observed.find(row=>row.kind==='require');assert.equal(requireRow.literal.parent,undefined);assert.throws(()=>program.getModeForUsageLocation(requireRow.file,requireRow.literal),error=>error instanceof TypeError&&error.message.includes('kind'));assert.deepEqual(requireRow.observation,{mode:null,modeObserved:false,resolutionAttempted:false,nativeParentKind:null,resolvedModule:null});
 for(const row of observed.filter(row=>row!==requireRow)){assert.equal(row.observation.modeObserved,true);assert.equal(row.observation.resolutionAttempted,true);assert(row.literal.parent);assert.equal(realpathSync(row.observation.resolvedModule.resolvedFileName),join(root,'dep.ts'));}
 assert.equal(observed.find(row=>basename(row.file.fileName)==='attributes.ts'&&row.kind==='import').observation.mode,ts.ModuleKind.ESNext);
 assert.equal(observed.find(row=>basename(row.file.fileName)==='attributes.ts'&&row.kind==='import-type').observation.mode,ts.ModuleKind.CommonJS);
 unchanged();assert.equal(program.getCompilerOptions(),options);assert.deepEqual(readdirSync(root).sort(),Object.keys(fixtures).sort());for(const[name,body]of Object.entries(fixtures))assert.equal(readFileSync(join(root,name),'utf8'),body);
}));
test('actual public native undefined mode is observed rather than treated as unavailable or replaced by a guessed fallback',()=>owned(root=>{
 const{ts}=compilerOwner(process.cwd()),options={target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,noEmit:true},path=join(root,'static.ts'),program=ts.createProgram({rootNames:[path],options});
 const file=program.getSourceFile(path),refs=references(ts,file),unchanged=parentImage(ts,[file],refs);assert.deepEqual(refs.map(row=>row.kind),['import','export']);
 for(const row of refs){assert(row.literal.parent);assert.equal(program.getModeForUsageLocation(file,row.literal),undefined);const observed=observeNativeUsageResolution(ts,program,file,row.literal,options);assert.equal(observed.mode,null);assert.equal(observed.modeObserved,true);assert.equal(observed.resolutionAttempted,true);assert.equal(realpathSync(observed.resolvedModule.resolvedFileName),join(root,'dep.ts'));}
 unchanged();assert.equal(program.getCompilerOptions(),options);
}));
