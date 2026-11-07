/** Pinned TypeScript API child. Never imported by ordinary compiler/release tooling. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {resolve,relative,dirname,join,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BOUNDARY_SOURCE,sha256,planBoundary,validateDeclarationCoverage,assertDeclarationBytes,contractSource,NEGATIVE_CONTRACTS,expectContractRefusals} from './compiler-boundary-policy.mjs';

export async function boundaryWorker(mode,out,index){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.CI==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Hosted diagnostic child required');
 assert(['inventory','producer','declarations','consumer','source-negative','declaration-negative'].includes(mode));
 const cwd=realpathSync(process.cwd()),temp=realpathSync(process.env.RUNNER_TEMP);
 assert.equal(out,join(temp,'diagnostic-compiler-boundary'));assert.equal(realpathSync(out),out);assert.equal(lstatSync(out).uid,process.getuid());
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}).trim();
 assert.equal(git('rev-parse','HEAD'),BOUNDARY_SOURCE);assert.equal(process.env.AIHR_CI_HEAD,BOUNDARY_SOURCE);assert.equal(git('status','--porcelain'),'');
 assert.equal(process.versions.node,'22.23.3');
 const require=createRequire(join(cwd,'package.json')),ts=require('typescript');assert.equal(ts.version,'5.9.3');
 const apiHash=sha256(readFileSync(require.resolve('typescript')));
 const id=path=>{const value=relative(cwd,resolve(path)).split(sep).join('/');assert(value&&!value.startsWith('../')&&!value.startsWith('/'),'Compiler source outside exact checkout');return value;};
 const config=path=>{
  const file=ts.readConfigFile(join(cwd,path),ts.sys.readFile);assert(!file.error,'Cannot read exact compiler config');
  const parsed=ts.parseJsonConfigFileContent(file.config,ts.sys,cwd,undefined,join(cwd,path));assert.equal(parsed.errors.length,0);return parsed;
 };
  const compilerHash=sha256(readFileSync(join(dirname(require.resolve('typescript')),'_tsc.js')));
  assert.equal(compilerHash,'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419');
  const parsed=config('tsconfig.json'),identity={source:BOUNDARY_SOURCE,node:process.versions.node,typescript:ts.version,apiHash,compilerHash,configHash:sha256(readFileSync(join(cwd,'tsconfig.json'))),buildConfigHash:sha256(readFileSync(join(cwd,'tsconfig.build.json'))),
  lockHash:sha256(readFileSync(join(cwd,'pnpm-lock.yaml')))};
 const result={kind:'DIAGNOSTIC_CHECKED_DECLARATION_PHASE_NOT_RELEASE',releaseAuthorized:false,mode,index,identity,complete:false};
 const resultFile=join(out,mode+(index===undefined?'':'-'+index)+'.json');
 const save=()=>writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 const diagnostic=error=>({code:error.code,category:ts.DiagnosticCategory[error.category],message:ts.flattenDiagnosticMessageText(error.messageText,'\n'),
  file:error.file?id(error.file.fileName):null,line:error.file&&error.start!==undefined?error.file.getLineAndCharacterOfPosition(error.start).line+1:null});
 const check=(program,ownedDeclarations)=>{
  const errors=[...program.getOptionsDiagnostics(),...program.getGlobalDiagnostics(),...program.getSyntacticDiagnostics()];
  if(ownedDeclarations)for(const file of ownedDeclarations)errors.push(...program.getSemanticDiagnostics(file));
  else errors.push(...program.getSemanticDiagnostics());
  return errors.map(diagnostic);
 };
 function compilerHost(options,access){
  const host=ts.createCompilerHost(options,true),edges=[],packages=new Map(),cache=ts.createModuleResolutionCache(cwd,path=>path,options);
  host.getModuleResolutionCache=()=>cache;
  if(access){host.fileExists=access.fileExists;host.readFile=access.readFile;host.realpath=access.realpath;}
  const read=host.readFile;host.readFile=path=>{
   const text=read(path);if(text!==undefined&&path.endsWith('/package.json'))packages.set(id(path),{id:id(path),real:id(realpathSync(path)),sha256:sha256(text)});return text;
  };
  host.resolveModuleNameLiterals=(literals,from,redirected,options,sourceFile)=>literals.map(literal=>{
   const resolutionMode=ts.getModeForUsageLocation(sourceFile,literal,options);
   const value=ts.resolveModuleName(literal.text,from,options,host,cache,redirected,resolutionMode),target=value.resolvedModule;
   edges.push({kind:'import',from:id(from),specifier:literal.text,mode:resolutionMode??null,to:target?id(target.resolvedFileName):null,
    extension:target?.extension??null,packageId:target?.packageId??null,external:target?.isExternalLibraryImport??null});return value;
  });
  host.resolveTypeReferenceDirectiveReferences=(references,from,redirected,options,sourceFile)=>references.map(reference=>{
   const name=typeof reference==='string'?reference:reference.fileName;
   const resolutionMode=typeof reference==='string'?sourceFile?.impliedNodeFormat:reference.resolutionMode??sourceFile?.impliedNodeFormat;
   const value=ts.resolveTypeReferenceDirective(name,from,options,host,redirected,undefined,resolutionMode),target=value.resolvedTypeReferenceDirective;
   edges.push({kind:'typeDirective',from:id(from),specifier:name,mode:resolutionMode??null,to:target?id(target.resolvedFileName):null,
    packageId:target?.packageId??null,external:target?.isExternalLibraryImport??null});return value;
  });
  return {host,edges,packages};
 }
 try{
  if(mode==='inventory'){
   const {host,edges,packages}=compilerHost(parsed.options),program=ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,host});
   const files=program.getSourceFiles().map(file=>{
    let augmentation=false;const visit=node=>{if(ts.isModuleDeclaration(node)&&(ts.isStringLiteral(node.name)||(node.flags&ts.NodeFlags.GlobalAugmentation)!==0))augmentation=true;ts.forEachChild(node,visit);};visit(file);
    const json=file.scriptKind===ts.ScriptKind.JSON;
    return{id:id(file.fileName),real:id(realpathSync(file.fileName)),sha256:sha256(readFileSync(file.fileName)),declaration:file.isDeclarationFile,json,
     external:program.isSourceFileFromExternalLibrary(file)||program.isSourceFileDefaultLibrary(file),
     ambient:!json&&(!ts.isExternalModule(file)||augmentation||file.isDeclarationFile&&!program.isSourceFileFromExternalLibrary(file)),augmentation};
   });
   const all=new Set(files.map(file=>file.id));
   for(const file of program.getSourceFiles()){
    for(const ref of file.referencedFiles){const path=resolve(dirname(file.fileName),ref.fileName),native=program.getSourceFile(path);
     const to=native?id(native.fileName):existsSync(path)?files.find(row=>row.real===id(realpathSync(path)))?.id:null;
     edges.push({kind:'pathDirective',from:id(file.fileName),specifier:ref.fileName,to:to&&all.has(to)?to:null});}
    for(const ref of file.libReferenceDirectives){const suffix='/lib.'+ref.fileName.toLowerCase()+'.d.ts',to=files.find(row=>('/'+row.id).endsWith(suffix))?.id??null;edges.push({kind:'libDirective',from:id(file.fileName),specifier:ref.fileName,to});}
   }
   const inventoryText=program.getSourceFiles().map(file=>file.fileName).join('\n')+'\n';
   assert.equal(parsed.fileNames.length,8823,'Original root set changed');assert.equal(files.length,11268,'Original resolved graph changed');
   assert.equal(sha256(inventoryText),'64150993b2990e6b4b405a1211037cca665887fb5068f97bebfb3e1e54a5dbbd','Exact original ordered program inventory changed');
   assert.equal(identity.configHash,'0ee72fb11a698bad9b18c39223569adf5758727272b35bfa99ec7bfa57c3530a');
   assert.equal(identity.lockHash,'0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd');
   const inventory={kind:'EXACT_TS593_SOURCE_GRAPH',identity,roots:parsed.fileNames.map(id),files,edges,packages:[...packages.values()],
    options:parsed.options,buildRoots:config('tsconfig.build.json').fileNames.map(id)};
   const plan=planBoundary(inventory);
   writeFileSync(join(out,'inventory.json'),JSON.stringify(inventory,null,2)+'\n',{flag:'wx',mode:0o600});
   writeFileSync(join(out,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
   result.rootNames=inventory.roots.length;result.resolvedFiles=files.length;result.ambient=plan.ambient.length;result.consumers=plan.consumers.length;
   // inventory.json is the phase result itself; preserve its complete graph instead of overwriting it.
   result.complete=true;writeFileSync(join(out,'inventory-phase.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return;
  }
  const inventory=JSON.parse(readFileSync(join(out,'inventory.json'),'utf8')),plan=JSON.parse(readFileSync(join(out,'plan.json'),'utf8'));
  assert.deepEqual(identity,inventory.identity);assert.deepEqual(plan,planBoundary(inventory),'Graph plan differs from exact original inventory');
  const original=new Map(inventory.files.map(file=>[file.id,file])),metadata=new Map(inventory.packages.map(file=>[file.id,file]));
  const originalReal=new Map(inventory.files.map(file=>[file.real,file])),metadataReal=new Map(inventory.packages.map(file=>[file.real,file]));
  const producer=new Set(plan.producerSourceIds),sourceNegative=mode==='source-negative',isProducer=mode==='producer';
  const declarationPhase=mode==='declarations',negative=sourceNegative||mode==='declaration-negative';
  const batch=mode==='consumer'?plan.consumers[index]:undefined;if(mode==='consumer')assert(batch,'Unregistered consumer partition');
  const contractId='__aihr_boundary_contract__.ts',declarationControlId='__aihr_boundary_declaration_refusal__.d.ts';
  for(const key of [contractId,declarationControlId])assert(!original.has(key)&&!existsSync(join(cwd,key)),'Contract virtual name already owned');
  const declarationControl='export declare const rejected: __AIHR_UNDECLARED_GENERATED_TYPE__;\n';
  const positive=contractSource('.'),contract=positive+(negative?NEGATIVE_CONTRACTS.map(row=>row.line).join('\n')+'\n':'');
  let declarations=[];
  const declarationBytes=row=>{const path=join(out,row.output);assert.equal(realpathSync(path),path);assert(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink());
   const bytes=readFileSync(path);assertDeclarationBytes(row,bytes);return bytes;};
  if(!isProducer&& !sourceNegative){
   declarations=JSON.parse(readFileSync(join(out,'declarations-map.json'),'utf8'));
   validateDeclarationCoverage(plan,inventory,declarations);
   for(const row of declarations)declarationBytes(row);
  }
  const virtuals=new Map(declarations.map(row=>[row.virtual,row])),byDeclarationSource=new Map(declarations.map(row=>[row.source,row]));assert.equal(virtuals.size,declarations.length);
  const allowedSources=new Set(isProducer?[...plan.producerSourceIds]:sourceNegative?inventory.files.map(file=>file.id):batch?.sourceIds??[]);
  const shared=new Set([...plan.ambient,...plan.external]);
  const mapped=id=>virtuals.get(id);
  const locate=path=>{
   let key;try{key=id(path);}catch{return undefined;}
   if(key===contractId)return {contract:true};if(declarationPhase&&key===declarationControlId)return {declarationControl:true};if(mapped(key))return {output:mapped(key)};
   // Native pnpm resolution first probes symlink aliases, then canonicalizes them.
   // Admit an alias only through the exact original real-file identity and bytes.
   let real;try{real=id(realpathSync(path));}catch{return undefined;}
   const file=original.get(key)??originalReal.get(real);
   if(file){if(!isProducer&&!sourceNegative&&producer.has(file.id)&&!file.declaration&&!file.json)return undefined;
    if(file.external||file.json||file.declaration||shared.has(file.id)||allowedSources.has(file.id))return {file};return undefined;}
   const meta=metadata.get(key)??metadataReal.get(real);return meta?{file:meta}:undefined;
  };
  const allowed=path=>locate(path)!==undefined;
  const readFile=path=>{
   const location=locate(path);if(!location)return undefined;if(location.contract)return contract;if(location.declarationControl)return declarationControl;
   if(location.output)return declarationBytes(location.output).toString('utf8');
   const bytes=readFileSync(path);assert.equal(sha256(bytes),location.file.sha256,'Original source changed during diagnostic');return bytes.toString('utf8');
  };
  const options={...parsed.options,incremental:false};
  if(isProducer)Object.assign(options,{noEmit:false,declaration:true,emitDeclarationOnly:true,noEmitOnError:true,sourceMap:false,declarationMap:false,rootDir:cwd,outDir:join(out,'emitted')});
  if(declarationPhase)options.skipLibCheck=false; // Below checks only owned emitted declarations, not skipped third-party declarations.
  const {host,edges}=compilerHost(options,{readFile,fileExists:allowed,
   realpath:path=>[contractId,declarationControlId].includes(id(path))||mapped(id(path))?resolve(path):realpathSync(path)});
  if(!isProducer&&!sourceNegative){
   const row=declarations.find(row=>row.source==='core/employee-choice.ts');assert(row,'Real public API declaration required');
   assert.equal(host.fileExists(join(cwd,row.source)),false);assert.equal(host.readFile(join(cwd,row.source)),undefined);
   const native=ts.resolveModuleName('./core/employee-choice',join(cwd,contractId),options,host).resolvedModule;
   assert.equal(native?.resolvedFileName,join(cwd,row.virtual),'Native resolver must bind actual emitted API, not source');
   assert.throws(()=>assertDeclarationBytes(row,Buffer.concat([declarationBytes(row),Buffer.from('\nforeign')])));
   const foreign=join(cwd,'__aihr_unregistered_source__.ts');assert(!existsSync(foreign));assert.equal(host.fileExists(foreign),false);assert.equal(host.readFile(foreign),undefined);
   result.receiverControls={nativeDeclarationResolved:row.virtual,runtimeSourceDenied:true,foreignSourceDenied:true,mutatedBytesRefused:true};
  }
  const contextIds=[...plan.ambient,...plan.external];
  const redirected=key=>{
   if(isProducer||sourceNegative)return key;
   const row=byDeclarationSource.get(key);return row?.virtual??key;
  };
  let primary=isProducer?plan.producerRoots:batch?.roots??[];
  if(declarationPhase)primary=declarations.map(row=>row.virtual);
  const rootNames=[...new Set([...contextIds.map(redirected),...primary.map(redirected),...(!declarationPhase?[contractId]:[declarationControlId])])].map(key=>join(cwd,key));
  const program=ts.createProgram({rootNames,options,host});
  const programFiles=program.getSourceFiles(),back=new Map(declarations.map(row=>[row.virtual,row.source]));
  const observed=programFiles.map(file=>back.get(id(file.fileName))??id(file.fileName));
  result.observedOriginalIds=observed.filter(key=>original.has(key));
  result.actualRootNames=rootNames.map(id);result.resolutions=edges;
  const actualAmbient=observed.filter(key=>plan.ambient.includes(key));
  assert.deepEqual(actualAmbient,plan.ambient,'Original ordered ambient/global/module-augmentation context changed');
  for(const file of programFiles){
   const key=id(file.fileName);assert(allowed(file.fileName),'Unadmitted source or foreign declaration');
   if(!isProducer&&!sourceNegative&&producer.has(key)&&!original.get(key)?.declaration)assert.fail('Consumer fell back to runtime implementation source');
   if(![contractId,declarationControlId].includes(key)&&!back.has(key))assert(original.has(key),'Compiler loaded a file outside original resolved graph');
  }
  if(batch)for(const root of batch.roots)assert(observed.includes(root),'Consumer original root was not checked');
  const owned=declarationPhase?programFiles.filter(file=>virtuals.has(id(file.fileName))||id(file.fileName)===declarationControlId):undefined;
  if(declarationPhase){assert.equal(owned.length,declarations.length+1);assert(owned.every(file=>file.isDeclarationFile));
   result.declarationValidation={ownedChecked:declarations.length,diagnosticOnlyControl:declarationControlId,skipLibCheck:false,externalSemanticDiagnosticsRequested:false,
    originalDependencyPolicy:'Original skipLibCheck=true retained: only NEW owned generated declarations get additional direct semantic checks.'};}
  const errors=check(program,owned);result.diagnostics=errors;
  if(declarationPhase){assert.equal(errors.length,1,'Every actual emitted declaration must be valid; one sentinel refusal is required');
   assert.deepEqual(errors.map(({code,file,line})=>({code,file,line})),[{code:2304,file:declarationControlId,line:1}]);
  }else if(negative)expectContractRefusals(errors,contract,contractId);else assert.equal(errors.length,0,'Native compiler diagnostics; retained in phase artifact');
  if(isProducer){
   const emitted=[];mkdirSync(join(out,'emitted'),{mode:0o700});
   const emission=program.emit(undefined,(path,text,bom,onError,sources)=>{
    assert(sources?.length===1,'Declaration requires exact single-source provenance');const source=id(sources[0].fileName);
    if(source===contractId)return; // Additional diagnostic-only positive fixture, never an original API output.
    assert(producer.has(source),'Emitter attempted foreign source');const output=relative(out,path).split(sep).join('/');
    assert(output.startsWith('emitted/')&&!output.includes('../'));assert(/\.d\.(?:ts|mts|cts)$/.test(output),'Only actual declaration outputs admitted');
    mkdirSync(dirname(path),{recursive:true,mode:0o700});const bytes=(bom?'\ufeff':'')+text;writeFileSync(path,bytes,{flag:'wx',mode:0o600});
    emitted.push({source,virtual:output.slice('emitted/'.length),output,sha256:sha256(bytes)});
   });
   result.emitDiagnostics=emission.diagnostics.map(diagnostic);assert.equal(emission.emitSkipped,false);assert.equal(emission.diagnostics.length,0);
   // The positive-only diagnostic contract is not an original source and must not become a published API.
   validateDeclarationCoverage(plan,inventory,emitted);
   writeFileSync(join(out,'declarations-map.json'),JSON.stringify(emitted,null,2)+'\n',{flag:'wx',mode:0o600});result.declarations=emitted.length;
  }
  result.complete=true;save();
 }catch(error){result.error=String(error);if(!existsSync(resultFile))save();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 boundaryWorker(process.argv[2],process.argv[3],process.argv[4]===undefined?undefined:Number(process.argv[4])).catch(error=>{console.error(error);process.exitCode=1;});
}
