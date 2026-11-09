/** Fixed fictional miniature package and observed native identities, not a resolver. */
import assert from 'node:assert/strict';
import {join,dirname,relative,resolve,isAbsolute} from 'node:path';
import {realpathSync} from 'node:fs';
import {regularHash,digest} from './outputs.mjs';
export const FIXTURE_PACKAGE_BODY_SHA256='38a6bfb17b33b2a8c87daf3f85253e90be6b3ebcd30253a4c4d4de83a04a1cd9';
export const FIXTURE_PACKAGE_BODY_BYTES=93;
export const FIXTURE_PACKAGE_MANIFEST='{"name":"fixture-external","version":"1.0.0","types":"index.d.ts"}\n';
export function fixturePackageRoot(source){assert(isAbsolute(source)&&resolve(source)===source);return join(dirname(source),'node_modules/fixture-external');}
const within=(root,path)=>{const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
/** Caller flags MUST originate from the actual Program in worker.mjs. Pure
 * path models do not constitute a native SourceFile or package witness. */
export function nativeFixtureIdentity(path,{source,compilerLib,declaration,external,defaultLibrary}){
 for(const value of [path,source,compilerLib])assert(isAbsolute(value)&&resolve(value)===value,'Canonical native context path required');
 if(within(source,path))return relative(source,path).replaceAll('\\','/');
 if(path===join(fixturePackageRoot(source),'index.d.ts')){
  assert(declaration===true&&external===true&&defaultLibrary===false,'Native fictional package classification differs');
  return'external/fixture-external/index.d.ts';
 }
 assert(defaultLibrary===true&&declaration===true&&dirname(path)===compilerLib&&/^lib(?:\.[a-z0-9]+)*\.d\.ts$/.test(path.slice(compilerLib.length+1)),'Unknown outside-source native identity');
 return'external/typescript/'+path.slice(compilerLib.length+1);
}
export function assertNativeIdentityRows(files){assert(new Set(files.map(f=>f.id)).size===files.length&&new Set(files.map(f=>f.path)).size===files.length,'Duplicate native context identity');}
/** Observes a real unmodified Program plus an independent PUBLIC native resolver.
 * It cannot supply a resolution result, host or declaration to that Program. */
export function observedFixturePackage(ts,program,options,source,files){
 const root=fixturePackageRoot(source),path=join(root,'index.d.ts'),manifestPath=join(root,'package.json');
 assert.equal(realpathSync(root),root);assert.equal(realpathSync(path),path);assert.equal(realpathSync(manifestPath),manifestPath);
 const body=regularHash(path),manifest=regularHash(manifestPath);
 assert.equal(body.sha256,FIXTURE_PACKAGE_BODY_SHA256);assert.equal(body.bytes,FIXTURE_PACKAGE_BODY_BYTES);
 assert.equal(manifest.sha256,digest(Buffer.from(FIXTURE_PACKAGE_MANIFEST)));assert.equal(manifest.bytes,Buffer.byteLength(FIXTURE_PACKAGE_MANIFEST));
 const loaded=files.filter(file=>file.path===path);assert.equal(loaded.length,1,'Actual shared fictional package SourceFile required');
 assert.equal(loaded[0].sha256,body.sha256);assert.equal(loaded[0].bytes,body.bytes);assert.equal(loaded[0].declaration,true);assert.equal(loaded[0].external,true);assert.equal(loaded[0].defaultLibrary,false);assert.equal(loaded[0].readOnlyDependency,false);
 const references=[];
 for(const file of program.getSourceFiles()){
  const visit=node=>{if(ts.isImportDeclaration(node)&&ts.isStringLiteralLike(node.moduleSpecifier)&&node.moduleSpecifier.text==='fixture-external')references.push({file,literal:node.moduleSpecifier});ts.forEachChild(node,visit);};ts.forEachChild(file,visit);
 }
 assert.equal(references.length,1,'Exact real fictional-package import required');
 const {file,literal}=references[0],importer=realpathSync(file.fileName);assert([join(source,'producer/index.ts'),join(dirname(source),'projects/emitted/producer/index.d.ts')].includes(importer),'Unknown fictional-package importer');
 const mode=program.getModeForUsageLocation(file,literal),resolution=ts.resolveModuleName(literal.text,file.fileName,options,ts.sys,undefined,undefined,mode).resolvedModule;
 assert(resolution,'Actual public native package resolution required');assert.equal(realpathSync(resolution.resolvedFileName),path);assert.equal(resolution.extension,'.d.ts');
 assert(resolution.packageId);assert.equal(resolution.packageId.name,'fixture-external');assert.equal(resolution.packageId.subModuleName,'index.d.ts');assert.equal(resolution.packageId.version,'1.0.0');assert.equal(resolution.packageId.peerDependencies,undefined);
 return{path,body,manifest,loaded:loaded[0],importer,mode:mode??null,packageId:resolution.packageId,defaultHost:true,syntheticResolution:false};
}
