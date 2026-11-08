/** Fresh pinned public TypeScript API. NO custom CompilerHost or resolver. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,dirname,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {regularHash,dependencyInputHash,digest,assertOutputSeal} from './outputs.mjs';
export const API_SHA256='3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675';
export const CLI_SHA256='e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419';
export function compilerOwner(cwd){const require=createRequire(join(cwd,'package.json')),ts=require('typescript'),api=require.resolve('typescript'),cli=join(dirname(api),'_tsc.js');assert.equal(ts.version,'5.9.3');assert.equal(process.versions.node,'22.23.3');assert.equal(digest(readFileSync(api)),API_SHA256);assert.equal(digest(readFileSync(cli)),CLI_SHA256);return{ts,api,cli,version:ts.version,apiSha256:API_SHA256,cliSha256:CLI_SHA256};}
export function parsedConfig(ts,path){const raw=ts.readConfigFile(path,ts.sys.readFile);assert.equal(raw.error,undefined);const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,dirname(path),undefined,path);assert.deepEqual(parsed.errors,[]);return parsed;}
const diagnostics=(ts,rows)=>rows.map(d=>({code:d.code,category:ts.DiagnosticCategory[d.category],file:d.file?.fileName??null,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:null,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
function programFor(ts,config){const parsed=parsedConfig(ts,config);return{parsed,program:ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences})};}
function sourceHasher(program,source,ownedOutputs=[]){
 const dependencyRoot=join(process.cwd(),'node_modules');assert.equal(realpathSync(dependencyRoot),dependencyRoot,'External dependency tree refused');assert.equal(realpathSync(source),source);
 const configured=new Set(program.getRootFileNames().map(path=>realpathSync(path))),owned=new Set(ownedOutputs.map(row=>row.path));
 const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
 return file=>{const path=realpathSync(file.fileName),expected=digest(Buffer.from(file.text)),external=program.isSourceFileFromExternalLibrary(file),defaultLibrary=program.isSourceFileDefaultLibrary(file);
  const readOnlyDependency=(external||defaultLibrary)&&inside(dependencyRoot,path)&&!configured.has(path)&&!inside(source,path)&&!owned.has(path);
  const record=readOnlyDependency?dependencyInputHash(path,dependencyRoot,expected):regularHash(path);assert.equal(expected,record.sha256,'Native loaded bytes changed');
  return{...record,declaration:file.isDeclarationFile,external,defaultLibrary,readOnlyDependency};};
}
function observedFiles(program,source,ownedOutputs=[]){return program.getSourceFiles().map(sourceHasher(program,source,ownedOutputs));}
export function inspectNativeProject(ts,{config,source,allowedImplementations,seals=[]}){
 assertOutputSeal(seals);const{parsed,program}=programFor(ts,config),files=observedFiles(program,source,seals),allowed=new Set(allowedImplementations);
 const fallback=files.filter(f=>!f.declaration&&!f.external&&!f.defaultLibrary&&!f.path.endsWith('.json')&&!allowed.has(f.path));assert.deepEqual(fallback,[],'Referenced implementation fallback refused');
 const errors=[...program.getConfigFileParsingDiagnostics(),...program.getOptionsDiagnostics(),...program.getGlobalDiagnostics(),...program.getSyntacticDiagnostics()];
 assertOutputSeal(seals);
 return{kind:'ACTUAL_DEFAULT_HOST_REFERENCE_INPUTS',config,roots:parsed.fileNames,files,diagnostics:diagnostics(ts,errors),semanticRequested:false,projectReferences:parsed.projectReferences??[],implementationFallback:false};
}
export function validateOwnedDeclarations(ts,{config,source,owned,seals,projectConfigs,projectSeals,negativeOwned=null,externalControl=false}){
 assert(Array.isArray(projectConfigs)&&projectConfigs.length>0&&new Set(projectConfigs).size===projectConfigs.length);assertOutputSeal(projectSeals);assert.deepEqual(projectSeals.map(row=>row.path).sort(),[...projectConfigs].sort(),'Native reference config identities differ');
 const expected=projectConfigs.flatMap(path=>{const parsed=parsedConfig(ts,path);assert.equal(parsed.options.noEmit,false);assert.equal(parsed.options.composite,true);return parsed.fileNames.filter(file=>!(/\.d\.[cm]?ts$/.test(file)||file.endsWith('.json'))).flatMap(file=>ts.getOutputFileNames(parsed,file,false).filter(out=>/\.d\.[cm]?ts$/.test(out)));}).sort();
 assert(expected.length>0&&new Set(expected).size===expected.length,'Duplicate/missing native declaration output ownership');assert.deepEqual([...owned].sort(),expected,'Caller cannot omit/add owned native declarations');
 const required=new Set(projectConfigs.flatMap(path=>{const parsed=parsedConfig(ts,path);return[parsed.options.tsBuildInfoFile,...parsed.fileNames.flatMap(file=>ts.getOutputFileNames(parsed,file,false))];}));if(negativeOwned!==null)required.add(negativeOwned);assert.deepEqual(seals.map(row=>row.path).sort(),[...required].sort(),'Complete native output/build-info seal required');
 if(negativeOwned!==null)assert.equal(negativeOwned,join(dirname(config),'emitted','producer','__owned_invalid.d.ts'),'Only fixed retained negative declaration is accepted');
 const targets=negativeOwned?[...owned,negativeOwned]:owned;
 assert(owned.length>0&&new Set(owned).size===owned.length&&owned.every(p=>/\.d\.[cm]?ts$/.test(p)),'Exact nonempty owned declaration membership required');assertOutputSeal(seals);
 const{parsed,program}=programFor(ts,config);assert.equal(parsed.options.skipLibCheck,false);assert.equal(parsed.options.noEmit,true);assert.equal(parsed.options.disableSourceOfProjectReferenceRedirect,true);
 const files=observedFiles(program,source,seals),byPath=new Map(program.getSourceFiles().map(f=>[realpathSync(f.fileName),f]));
 const missing=targets.filter(p=>!byPath.has(p));assert.deepEqual(missing,[],'Owned emitted declaration missing');
 assert(files.every(f=>f.declaration||f.path.endsWith('.json')||f.external),'Implementation fallback during native declaration validation');
 const all=[...program.getConfigFileParsingDiagnostics(),...program.getOptionsDiagnostics(),...program.getGlobalDiagnostics(),...program.getSyntacticDiagnostics()];
 const semantic=[];for(const path of targets){const source=byPath.get(path);assert(source.isDeclarationFile&&!program.isSourceFileFromExternalLibrary(source));semantic.push(...program.getSemanticDiagnostics(source));}
 const external=[];if(externalControl)for(const source of program.getSourceFiles())if(program.isSourceFileFromExternalLibrary(source)&&source.fileName.endsWith('/fixture-external/index.d.ts'))external.push(...program.getSemanticDiagnostics(source));
 assertOutputSeal(seals);assertOutputSeal(projectSeals);
 return{kind:'ACTUAL_DEFAULT_HOST_OWNED_DECLARATION_VALIDATION',config,owned,semanticTargets:targets,optionsGlobalSyntax:diagnostics(ts,all),ownedSemantic:diagnostics(ts,semantic),externalControl:diagnostics(ts,external),externalSemanticRequested:externalControl,files,implementationFallback:false};
}
export function nativeInventory(ts,{config,source}){
 const{parsed,program}=programFor(ts,config);const errors=ts.getPreEmitDiagnostics(program);assert.deepEqual(diagnostics(ts,errors),[],'Native fixture baseline diagnostics');
 const loaded=program.getSourceFiles(),byPath=new Map(loaded.map(f=>[realpathSync(f.fileName),f])),files=[],edges=[],nativeHash=sourceHasher(program,source);
 const id=path=>{const rel=relative(source,path).replaceAll('\\','/');return !rel.startsWith('../')&&!isAbsolute(rel)?rel:'external/typescript/'+path.split('/').at(-1);};
 const add=(path,kind)=>{path=realpathSync(path);if(files.some(f=>f.path===path))return id(path);const native=byPath.get(path);files.push({...(native?nativeHash(native):regularHash(path)),id:id(path),kind:kind??(native?.isDeclarationFile?(program.isSourceFileFromExternalLibrary(native)||program.isSourceFileDefaultLibrary(native)?'external':'declaration'):path.endsWith('.json')?'json':'implementation'),ambient:native?.isDeclarationFile&&!ts.isExternalModule(native),defaultLibrary:native?program.isSourceFileDefaultLibrary(native):false});return id(path);};
 for(const file of loaded)add(file.fileName);
 for(const file of loaded){const from=add(file.fileName);const literals=[];
  const visit=node=>{if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))literals.push(node.moduleSpecifier);
   else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))literals.push(node.argument.literal);
   else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0]))literals.push(node.arguments[0]);ts.forEachChild(node,visit);};ts.forEachChild(file,visit);
  for(const literal of literals){const mode=program.getModeForUsageLocation(file,literal),value=ts.resolveModuleName(literal.text,file.fileName,parsed.options,ts.sys,undefined,undefined,mode),target=value.resolvedModule;assert(target,'Unresolved native inventory import');const path=realpathSync(target.resolvedFileName);edges.push({from,to:add(path,byPath.has(path)?undefined:'opaque'),specifier:literal.text,mode:mode??null,packageId:target.packageId??null,extension:target.extension});}
  for(const ref of file.referencedFiles){const target=ts.resolveTripleslashReference(ref.fileName,file.fileName);assert(byPath.has(realpathSync(target)),'Missing native triple-slash context');edges.push({from,to:add(target),kind:'path-reference'});}
 }
 return{kind:'NATIVE_SMALL_FIXTURE_INVENTORY_NOT_APPLICATION',roots:parsed.fileNames.map(path=>id(realpathSync(path))),buildRoots:[id(realpathSync(join(source,'producer/index.ts')))],files,edges,options:parsed.options,originalSourceOrder:loaded.map(f=>id(realpathSync(f.fileName))),resolutionMethod:'unmodified native Program + independent public resolveModuleName(ts.sys); no host interception',applicationInventoryComplete:false};
}
export async function nativeReferenceWorker(mode,input,output){assert(['inventory','inspect','declarations','declarations-negative','external-control'].includes(mode));const job=JSON.parse(readFileSync(input,'utf8')),owner=compilerOwner(process.cwd());const source=realpathSync(job.source),temp=realpathSync(process.env.RUNNER_TEMP);assert(!relative(temp,source).startsWith('../'));assert.equal(realpathSync(job.config),job.config);assert.deepEqual(regularHash(job.config),job.configSeal,'Native config changed before parse');
 const value=mode==='inventory'?nativeInventory(owner.ts,job):mode==='inspect'?inspectNativeProject(owner.ts,job):validateOwnedDeclarations(owner.ts,{...job,externalControl:mode==='external-control'});
 writeFileSync(output,JSON.stringify({...value,typescript:owner.version,apiSha256:owner.apiSha256,ordinaryCompilerQualified:false,releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});
 if(mode==='inspect')assert.equal(value.diagnostics.length,0);if(mode==='declarations'||mode==='declarations-negative')assert.equal(value.optionsGlobalSyntax.length+value.ownedSemantic.length,0,'Owned native declaration diagnostics');if(mode==='external-control'){assert.equal(value.optionsGlobalSyntax.length+value.ownedSemantic.length,0);assert(value.externalControl.length>0&&value.externalControl.every(d=>d.code===2304),'Actual preexisting external semantic error control required');}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,5);await nativeReferenceWorker(process.argv[2],process.argv[3],process.argv[4]);}
