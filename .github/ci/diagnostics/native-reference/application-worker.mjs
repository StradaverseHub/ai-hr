/** Actual candidate default Program, public AST/resolvers, metadata ONLY.
 * No custom host, semantic diagnostics, emission, options override or cache API. */
import assert from 'node:assert/strict';
import {writeFileSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compilerOwner,parsedConfig} from './worker.mjs';
import {admitCompilerApplicationInventory,readCompilerApplicationInventoryClock} from './admission.mjs';
import {observeLoadedNativeInput,stableNativeInput,withinInputRoot,APPLICATION_INPUT_LIMITS} from './application-inputs.mjs';
import {assertFixedInventoryConfig} from './application-protocol.mjs';
import {REFERENCE_LIMITS} from './graph.mjs';

function observeNativeApplication(ts,source,config,check){
 assertFixedInventoryConfig(source,config);check();const dependencyRoot=join(source,'node_modules');assert.equal(realpathSync(dependencyRoot),dependencyRoot);
 const configBefore=stableNativeInput(config,{root:source,check}).record,parsed=parsedConfig(ts,config);
 // Exactly the original options, roots and reference order. No host property.
 const program=ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences});check();
 const nativeRoots=program.getRootFileNames();assert.deepEqual(nativeRoots,parsed.fileNames,'Actual configured root order differs');const loaded=program.getSourceFiles();assert(loaded.length>0&&loaded.length<=APPLICATION_INPUT_LIMITS.files);
 const configured=new Set(parsed.fileNames.map(path=>realpathSync(path))),files=[],gaps=[],observations=[],ambient=[],globals=[];let bytes=0;
 for(const file of loaded){check();const record=observeLoadedNativeInput(ts,program,file,{source,dependencyRoot,configured,check});bytes+=record.bytes;assert(bytes<=REFERENCE_LIMITS.totalBytes);record.externalModule=ts.isExternalModule(file);files.push(record);
  if(!ts.isExternalModule(file)){globals.push(record.logicalPath);if(!file.isDeclarationFile&&!record.defaultLibrary)gaps.push({kind:'global-implementation-native-ownership-open',file:record.logicalPath});}
 }
 const loadedNames=new Set(files.map(row=>row.logicalPath)),add=row=>{assert(observations.length<1000000,'Native edge metadata bound');observations.push(row);};
 const target=value=>{
  if(!value)return null;const logicalPath=resolve(value.resolvedFileName),path=realpathSync(logicalPath);assert(withinInputRoot(source,path),'Public native resolution outside candidate');
  if(!loadedNames.has(logicalPath))gaps.push({kind:'public-resolution-not-native-loaded-membership',logicalPath,path});
  return{logicalPath,path,extension:value.extension??null,packageId:value.packageId??null,isExternalLibraryImport:value.isExternalLibraryImport??null,resolvedUsingTsExtension:value.resolvedUsingTsExtension??null};
 };
 for(const file of loaded){check();const from=resolve(file.fileName),seen=new WeakSet();
  const module=(literal,kind)=>{
   const mode=program.getModeForUsageLocation(file,literal),resolved=ts.resolveModuleName(literal.text,file.fileName,parsed.options,ts.sys,undefined,undefined,mode);
   const result=target(resolved.resolvedModule);add({from,kind,specifier:literal.text,position:literal.pos,end:literal.end,mode:mode??null,target:result});
   if(!result)gaps.push({kind:'unresolved-public-module-or-ambient-provider',from,specifier:literal.text,position:literal.pos});
  };
  function visit(node){
   check();if(seen.has(node))return;seen.add(node);
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){if(ts.isStringLiteralLike(node.moduleSpecifier))module(node.moduleSpecifier,ts.isImportDeclaration(node)?'import':'export');else gaps.push({kind:'nonliteral-module-specifier',from,position:node.pos});}
   else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression){const value=node.moduleReference.expression;if(ts.isStringLiteralLike(value))module(value,'import-equals');else gaps.push({kind:'nonliteral-import-equals',from,position:node.pos});}
   else if(ts.isImportTypeNode(node)){if(ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))module(node.argument.literal,'import-type');else gaps.push({kind:'nonliteral-import-type',from,position:node.pos});}
   else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
    if(node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0]))module(node.arguments[0],node.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require');
    else gaps.push({kind:'opaque-dynamic-module-operation',from,position:node.pos,end:node.end});
   }
   if(ts.isModuleDeclaration(node)){
    const name=ts.isStringLiteralLike(node.name)?node.name.text:node.name.text;
    ambient.push({from,name,position:node.pos,end:node.end,globalAugmentation:(node.flags&ts.NodeFlags.GlobalAugmentation)!==0,externalSource:ts.isExternalModule(file)});
    gaps.push({kind:'ambient-or-augmentation-native-order-controls-open',from,name,position:node.pos});
   }
   for(const tag of ts.getJSDocTags(node))if(ts.isJSDocImportTag(tag)&&tag.moduleSpecifier&&ts.isStringLiteralLike(tag.moduleSpecifier))module(tag.moduleSpecifier,'jsdoc-import');
   ts.forEachChild(node,visit);
  }
  visit(file);
  for(const ref of file.referencedFiles){const logicalPath=resolve(dirname(from),ref.fileName);add({from,kind:'path-reference',specifier:ref.fileName,position:ref.pos,end:ref.end,target:loadedNames.has(logicalPath)?{logicalPath,path:realpathSync(logicalPath)}:null});if(!loadedNames.has(logicalPath))gaps.push({kind:'path-reference-native-target-open',from,reference:ref});}
  for(const ref of file.typeReferenceDirectives){const mode=ref.resolutionMode??file.impliedNodeFormat,value=ts.resolveTypeReferenceDirective(ref.fileName,file.fileName,parsed.options,ts.sys,undefined,undefined,mode);const result=target(value.resolvedTypeReferenceDirective);add({from,kind:'type-reference',specifier:ref.fileName,position:ref.pos,end:ref.end,mode:mode??null,target:result});if(!result)gaps.push({kind:'unresolved-public-type-reference',from,reference:ref});}
  for(const ref of file.libReferenceDirectives)add({from,kind:'lib-reference',specifier:ref.fileName,position:ref.pos,end:ref.end,target:null});
  if(file.libReferenceDirectives.length)gaps.push({kind:'native-lib-reference-target-reconciliation-open',from,references:file.libReferenceDirectives});
  if(file.languageVariant===ts.LanguageVariant.JSX)gaps.push({kind:'implicit-jsx-native-edge-reconciliation-open',from,jsx:parsed.options.jsx,jsxImportSource:parsed.options.jsxImportSource??null});
 }
 const automaticTypes=ts.getAutomaticTypeDirectiveNames(parsed.options,ts.sys).map(name=>{check();const value=ts.resolveTypeReferenceDirective(name,undefined,parsed.options,ts.sys);return{name,target:target(value.resolvedTypeReferenceDirective)};});
 if(automaticTypes.length)gaps.push({kind:'automatic-type-native-origin-and-order-reconciliation-open',names:automaticTypes.map(row=>row.name)});
 // Complete parsed config provenance is retained; parsed options are evidence,
 // never serialized into a different compiler configuration.
 const buildConfig=join(source,'tsconfig.build.json'),buildBefore=stableNativeInput(buildConfig,{root:source,check}).record,buildParsed=parsedConfig(ts,buildConfig);assert.deepEqual(stableNativeInput(buildConfig,{root:source,check}).record,buildBefore);
 assert.deepEqual(stableNativeInput(config,{root:source,check}).record,configBefore);check();
 return{kind:'ACTUAL_UNMODIFIED_DEFAULT_APPLICATION_PROGRAM_METADATA',config,configSeal:configBefore,roots:nativeRoots,parsedRoots:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences??[],files,observations,ambient,globals,automaticTypes,gaps,
  buildConfiguration:{config:buildConfig,configSeal:buildBefore,roots:buildParsed.fileNames,options:buildParsed.options,projectReferences:buildParsed.projectReferences??[],freshProgramObserved:false},
  rawLoadedInputBytes:bytes,semanticRequested:false,diagnosticsRequested:false,emissionRequested:false,customHost:false,originalOptionsUnmodified:true,
  resolutionMethod:'Unmodified public createProgram plus independent public resolveModuleName/resolveTypeReferenceDirective(ts.sys); independent observations are not native cache provenance'};
}
export function nativeApplicationWorker(){
 assert.equal(process.argv.length,2);const proof=admitCompilerApplicationInventory('inventory-worker'),clock=readCompilerApplicationInventoryClock(proof),started=process.hrtime.bigint();
 const check=()=>{assert(process.hrtime.bigint()-BigInt(clock.startNs)<BigInt(718000000000),'Aggregate inventory frontier closed');assert(process.hrtime.bigint()-started<BigInt(APPLICATION_INPUT_LIMITS.phaseMs)*1000000n,'Native metadata phase cap');};
 const config=join(proof.source,'tsconfig.json'),owner=compilerOwner(proof.source),value=observeNativeApplication(owner.ts,proof.source,config,check);
 const output=join(proof.destination,'compiler-native-application-inventory','original-api.json');check();const raw=JSON.stringify({...value,typescript:owner.version,apiSha256:owner.apiSha256,ordinaryCompilerQualified:false,releaseAuthorized:false},null,2)+'\n';assert(Buffer.byteLength(raw)<=REFERENCE_LIMITS.fileBytes);assert.equal(compilerOwner(proof.source).apiSha256,owner.apiSha256);writeFileSync(output,raw,{flag:'wx',mode:0o600});check();
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))nativeApplicationWorker();
