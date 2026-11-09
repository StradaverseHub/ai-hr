/** Actual candidate default Program metadata. No custom host, semantic
 * diagnostics, emission, options override or native cache mutations. */
import assert from 'node:assert/strict';
import {writeFileSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compilerOwner,parsedConfig,API_SHA256,CLI_SHA256} from './worker.mjs';
import {admitCompilerApplicationInventory,readCompilerApplicationInventoryClock} from './admission.mjs';
import {observeLoadedNativeInput,stableNativeInput,withinInputRoot,APPLICATION_INPUT_LIMITS} from './application-inputs.mjs';
import {assertFixedInventoryConfig} from './application-protocol.mjs';
import {REFERENCE_LIMITS} from './graph.mjs';
import {observeNativeUsageResolution} from './application-mode.mjs';
import {walkNativeApplicationSyntax,captureNativeApplicationAttachments} from './application-syntax.mjs';

const storedMode=mode=>{assert(mode===undefined||mode===1||mode===99,'Unexpected TS5.9.3 resolution mode');return mode??null;};
const checkedIndex=(array,index)=>{assert(Array.isArray(array)&&Number.isSafeInteger(index)&&index>=0&&index<array.length&&Object.hasOwn(array,index),'Native reason index outside original roster');return array[index];};

// The pinned mode-aware cache's get() writes its reverse-key map. Only its
// native forEach is read-only. The stock formatter also calls that getter, so
// the stock CLI explanation remains a separate observation from this Program.
export function observeNativeInclusion(owner,program,check){
 assert.equal(owner.version,'5.9.3');assert.equal(owner.apiSha256,API_SHA256);assert.equal(owner.cliSha256,CLI_SHA256);
 const loaded=program.getSourceFiles(),options=program.getCompilerOptions(),roots=program.getRootFileNames(),fileIndices=new Map(),byPath=new Map();
 assert(loaded.length>0&&loaded.length<=APPLICATION_INPUT_LIMITS.files);
 let entries=0;const admit=()=>{check();assert(++entries<=APPLICATION_INPUT_LIMITS.metadataEntries,'Native inclusion metadata bound');};
 for(let index=0;index<loaded.length;index++){
  admit();const file=loaded[index];assert(isAbsolute(file.path)&&!byPath.has(file.path)&&!fileIndices.has(file));
  byPath.set(file.path,index);fileIndices.set(file,index);
 }
 const loadedIndex=file=>fileIndices.get(file)??null;
 const positiveTargets=new Map();
 const resolved=value=>{
  if(!value)return null;
  const logicalPath=value.resolvedFileName;assert(isAbsolute(logicalPath));
  if(!positiveTargets.has(logicalPath))positiveTargets.set(logicalPath,loadedIndex(program.getSourceFile(logicalPath)));
  const loadedFile=positiveTargets.get(logicalPath),id=value.packageId;
  return{logicalPath,loadedFile,status:loadedFile===null?'RESOLVED_NOT_LOADED':'RESOLVED_LOADED',originalPath:value.originalPath??null,extension:value.extension??null,
   packageId:id?{name:id.name,subModuleName:id.subModuleName,version:id.version,peerDependencies:id.peerDependencies??null}:null,
   isExternalLibraryImport:value.isExternalLibraryImport??null,resolvedUsingTsExtension:value.resolvedUsingTsExtension??null};
 };
 const stores=[],moduleKeys=new Map(),typeKeys=new Map();
 const key=(file,name,mode)=>JSON.stringify([file,name,mode]);
 const addStored=(keys,field)=>(result,name,mode,path)=>{
  admit();const file=byPath.get(path),observedMode=storedMode(mode),identity=key(file,name,observedMode);
  assert(file!==undefined&&typeof name==='string'&&result&&!keys.has(identity),'Unowned or duplicate native stored-resolution key');
  keys.set(identity,stores.length);stores.push({kind:field,file,name,mode:observedMode,target:resolved(result[field])});
 };
 program.forEachResolvedModule(addStored(moduleKeys,'resolvedModule'));
 program.forEachResolvedTypeReferenceDirective(addStored(typeKeys,'resolvedTypeReferenceDirective'));
 const automaticNames=program.getAutomaticTypeDirectiveNames(),automaticTargets=new Map();
 program.getAutomaticTypeDirectiveResolutions().forEach((result,name,mode)=>{
  admit();assert(mode===undefined&&result&&!automaticTargets.has(name));automaticTargets.set(name,resolved(result.resolvedTypeReferenceDirective));
 });
 const automaticTypes=automaticNames.map(name=>{admit();assert(automaticTargets.has(name));return{name,target:automaticTargets.get(name)};});
 const automaticIndices=new Map(automaticNames.map((name,index)=>[name,index]));
 assert.equal(automaticTargets.size,automaticIndices.size,'Native automatic type roster and store disagree');
 const inclusions=program.getFileIncludeReasons();
 for(const [path,rows]of inclusions){admit();assert(byPath.has(path)&&Array.isArray(rows)&&rows.length>0,'Unowned native inclusion roster');}
 const files=loaded.map((file,target)=>{
  check();const reasons=inclusions.get(file.path);assert(reasons?.length,'Loaded file lacks native inclusion reasons');
  const sourceRows=reasons.map(reason=>{
   admit();assert(reason&&Number.isSafeInteger(reason.kind)&&reason.kind>=0&&reason.kind<=8,'Unexpected TS5.9.3 file inclusion kind');
   const{kind,index}=reason;
   if(kind===0)return{kind,index,root:checkedIndex(roots,index)};
   if(kind===1||kind===2){const ref=checkedIndex(program.getResolvedProjectReferences(),index);assert(ref?.sourceFile);return{kind,index,project:ref.sourceFile.fileName};}
   if(kind===6)return{kind,index:index??null,library:index===undefined?null:checkedIndex(options.lib,index)};
   if(kind===8){const automatic=automaticIndices.get(reason.typeReference);assert(automatic!==undefined);return{kind,automatic,storedTargetMatchesReason:automaticTypes[automatic].target?.loadedFile===target};}
   const from=byPath.get(reason.file);assert(from!==undefined);const original=loaded[from];assert.strictEqual(program.getSourceFileByPath(reason.file),original);
   const array=kind===3?original.imports:kind===4?original.referencedFiles:kind===5?original.typeReferenceDirectives:original.libReferenceDirectives;
   const ref=checkedIndex(array,index),{pos,end}=ref,synthetic=kind===3&&pos===-1&&end===-1;
   assert(synthetic||Number.isSafeInteger(pos)&&Number.isSafeInteger(end)&&pos>=0&&pos<end&&end<=original.text.length,'Unexpected native reference position');
   const name=kind===3?ref.text:ref.fileName;assert(typeof name==='string');
   const row={kind,from,index,name,pos,end,synthetic};
   if(kind===3||kind===5){
    if(kind===3){assert(owner.ts.isStringLiteralLike(ref)&&ref.parent);row.literalKind=ref.kind;row.parentKind=ref.parent.kind;}
    const mode=kind===3?program.getModeForResolutionAtIndex(original,index):ref.resolutionMode||program.getDefaultResolutionModeForFile(original);
    const observedMode=storedMode(mode),stored=(kind===3?moduleKeys:typeKeys).get(key(from,name,observedMode));
    assert(stored!==undefined,'Indexed native reference lacks its mode-aware stored key');
    return{...row,mode:observedMode,stored,storedTargetMatchesReason:stores[stored].target?.loadedFile===target};
   }
   const selected=kind===4?program.getSourceFileFromReference(original,ref):program.getLibFileFromReference(ref);
   return{...row,selectedLoadedFile:loadedIndex(selected),selectedTargetMatchesReason:selected===file};
  });
  const redirect=file.redirectInfo?.redirectTarget,packageScope=file.packageJsonScope;
  const packageType=packageScope?.contents.packageJsonContent.type;
  assert(isAbsolute(file.resolvedPath));
  return{logicalPath:resolve(file.fileName),canonicalPath:file.path,resolvedPath:file.resolvedPath,originalFileName:file.originalFileName,
   redirect:redirect?{loadedFile:loadedIndex(redirect),logicalPath:resolve(redirect.fileName),canonicalPath:redirect.path}:null,
   impliedNodeFormat:storedMode(file.impliedNodeFormat),impliedEmitFormat:storedMode(program.getImpliedNodeFormatForEmit(file)),
   packageScope:packageScope?{directory:packageScope.packageDirectory,type:packageType===undefined?'MISSING':packageType==='module'||packageType==='commonjs'?packageType:'OTHER'}:null,
   reasons:sourceRows};
 });
 assert.strictEqual(program.getSourceFiles(),loaded);assert.strictEqual(program.getCompilerOptions(),options);check();
 return{kind:'PINNED_TS593_READ_ONLY_PROGRAM_INCLUSION',files,stores,automaticOrigin:options.types===undefined?'IMPLICIT':'COMPILER_OPTIONS',automaticTypes};
}

function observeNativeApplication(owner,source,config,check){
 const{ts}=owner;
 assertFixedInventoryConfig(source,config);check();const dependencyRoot=join(source,'node_modules');assert.equal(realpathSync(dependencyRoot),dependencyRoot);
 const configBefore=stableNativeInput(config,{root:source,check}).record,parsed=parsedConfig(ts,config);
 // Exactly the original options, roots and reference order. No host property.
 const program=ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences});check();
 const nativeRoots=program.getRootFileNames();assert.deepEqual(nativeRoots,parsed.fileNames,'Actual configured root order differs');const loaded=program.getSourceFiles();assert(loaded.length>0&&loaded.length<=APPLICATION_INPUT_LIMITS.files);
 const configured=new Set(parsed.fileNames.map(path=>realpathSync(path))),files=[],gaps=[],observations=[],ambient=[],globals=[];let bytes=0;
 for(const file of loaded){check();const record=observeLoadedNativeInput(ts,program,file,{source,dependencyRoot,configured,check});bytes+=record.bytes;assert(bytes<=REFERENCE_LIMITS.totalBytes);record.externalModule=ts.isExternalModule(file);files.push(record);
  if(!ts.isExternalModule(file)){globals.push(record.logicalPath);if(!file.isDeclarationFile&&!record.defaultLibrary)gaps.push({kind:'global-implementation-native-ownership-open',file:record.logicalPath});}
 }
 const attachmentIntegrity=captureNativeApplicationAttachments(ts,loaded,check);
 const loadedNames=new Set(files.map(row=>row.logicalPath)),add=row=>{assert(observations.length<1000000,'Native edge metadata bound');observations.push(row);};
 const target=value=>{
  if(!value)return null;const logicalPath=resolve(value.resolvedFileName),path=realpathSync(logicalPath);assert(withinInputRoot(source,path),'Public native resolution outside candidate');
  if(!loadedNames.has(logicalPath))gaps.push({kind:'public-resolution-not-native-loaded-membership',logicalPath,path});
  return{logicalPath,path,extension:value.extension??null,packageId:value.packageId??null,isExternalLibraryImport:value.isExternalLibraryImport??null,resolvedUsingTsExtension:value.resolvedUsingTsExtension??null};
 };
 for(const file of loaded){check();const from=resolve(file.fileName);
  const module=(literal,kind)=>{
   const native=observeNativeUsageResolution(ts,program,file,literal,parsed.options),result=native.resolutionAttempted?target(native.resolvedModule):null;
   add({from,kind,specifier:literal.text,position:literal.pos,end:literal.end,literalKind:literal.kind,mode:native.mode,modeObserved:native.modeObserved,resolutionAttempted:native.resolutionAttempted,nativeParentKind:native.nativeParentKind,target:result});
   if(!native.modeObserved)gaps.push({kind:'native-usage-parent-unavailable',from,referenceKind:kind,specifier:literal.text,position:literal.pos,end:literal.end,literalKind:literal.kind});
   else if(!result)gaps.push({kind:'unresolved-public-module-or-ambient-provider',from,specifier:literal.text,position:literal.pos});
  };
  function observe(node){
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
   if(ts.isJSDocImportTag(node)&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))module(node.moduleSpecifier,'jsdoc-import');
  }
  walkNativeApplicationSyntax(ts,file,node=>{attachmentIntegrity.observe(file,node);observe(node);},check);
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
 const nativeInclusion=observeNativeInclusion(owner,program,check);
 assert.deepEqual(stableNativeInput(config,{root:source,check}).record,configBefore);check();attachmentIntegrity.verify();check();
 return{kind:'ACTUAL_UNMODIFIED_DEFAULT_APPLICATION_PROGRAM_METADATA',config,configSeal:configBefore,roots:nativeRoots,parsedRoots:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences??[],files,observations,ambient,globals,automaticTypes,gaps,nativeInclusion,
  buildConfiguration:{config:buildConfig,configSeal:buildBefore,roots:buildParsed.fileNames,options:buildParsed.options,projectReferences:buildParsed.projectReferences??[],freshProgramObserved:false},
  rawLoadedInputBytes:bytes,semanticRequested:false,diagnosticsRequested:false,emissionRequested:false,customHost:false,originalOptionsUnmodified:true,
  resolutionMethod:'PINNED_PARSER_OWN_DATA TS5.9.3 attachment metadata with complete original attachment identity/descriptor integrity; unmodified public createProgram plus independent public resolveModuleName/resolveTypeReferenceDirective(ts.sys); independent observations are not native cache provenance'};
}
export function nativeApplicationWorker(){
 assert.equal(process.argv.length,2);const proof=admitCompilerApplicationInventory('inventory-worker');assert(proof.sourceHashes['.github/ci/diagnostics/native-reference/application-syntax.mjs'],'Complete original native syntax source owner required');const clock=readCompilerApplicationInventoryClock(proof),started=process.hrtime.bigint();
 const check=()=>{assert(process.hrtime.bigint()-BigInt(clock.startNs)<BigInt(718000000000),'Aggregate inventory frontier closed');assert(process.hrtime.bigint()-started<BigInt(APPLICATION_INPUT_LIMITS.phaseMs)*1000000n,'Native metadata phase cap');};
 const config=join(proof.source,'tsconfig.json'),owner=compilerOwner(proof.source),value=observeNativeApplication(owner,proof.source,config,check);
 const output=join(proof.destination,'compiler-native-application-inventory','original-api.json');check();const raw=JSON.stringify({...value,typescript:owner.version,apiSha256:owner.apiSha256,ordinaryCompilerQualified:false,releaseAuthorized:false},null,2)+'\n';assert(Buffer.byteLength(raw)<=REFERENCE_LIMITS.fileBytes);assert.equal(compilerOwner(proof.source).apiSha256,owner.apiSha256);writeFileSync(output,raw,{flag:'wx',mode:0o600});check();
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))nativeApplicationWorker();
