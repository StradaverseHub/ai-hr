/** Closed hosted metadata operation. No compiler semantics, AI, DB or release. */
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,dirname,parse} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem} from 'node:os';
import {admitCompilerApplicationInventory,readCompilerApplicationInventoryClock,boundedCompilerBytes} from './admission.mjs';
import {compilerOwner} from './worker.mjs';
import {nativeReferenceProcess,requireNativeSuccess} from './process.mjs';
import {REFERENCE_LIMITS} from './graph.mjs';
import {assertArtifactBudget} from './outputs.mjs';
import {stableNativeInput,candidatePackageContext,withinInputRoot,APPLICATION_INPUT_LIMITS} from './application-inputs.mjs';
import {APPLICATION_PHASES,parseNativeExplanation,reconcileNativeMembership,compareAvailableContext} from './application-protocol.mjs';
const closed='postgres://nobody:nothing@127.0.0.1:1/no_database';
const keys=['PATH','HOME','RUNNER_TEMP','GITHUB_WORKSPACE','GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT','RUNNER_OS','GITHUB_REPOSITORY','GITHUB_WORKFLOW','GITHUB_JOB','GITHUB_EVENT_NAME','GITHUB_RUN_ATTEMPT','GITHUB_RUN_ID','AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD','AIHR_FOCUSED_TESTS','AIHR_FOCUSED_EVIDENCE_DIR'];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const namedExists=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function noExternalLookupDirectories(source){
 let current=dirname(source);for(;;){assert(!namedExists(join(current,'node_modules')),'Unexpected ancestor dependency lookup context');const parent=dirname(current);if(parent===current)break;current=parent;}
 // Also bind the exact filesystem root. No foreign directory contents are read.
 assert.equal(current,parse(source).root);
}
function generatedTypes(source,check){
 const rows=[];let bytes=0;const add=path=>{check();const row=stableNativeInput(path,{root:source,check}).record;bytes+=row.bytes;assert(rows.length<50000&&bytes<=REFERENCE_LIMITS.totalBytes);rows.push(row);};
 add(join(source,'next-env.d.ts'));
 const visit=directory=>{check();assert(realpathSync(directory)===directory&&lstatSync(directory).isDirectory());for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);assert(!stat.isSymbolicLink(),'Foreign generated type link');if(stat.isDirectory())visit(path);else{assert(stat.isFile());add(path);}}};
 visit(join(source,'.next'));assert(rows.some(row=>row.path===join(source,'.next/types/routes.d.ts'))&&rows.some(row=>row.path===join(source,'.next/types/validator.ts')),'Actual ordinary Next generated route types required');
 return rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export async function nativeApplicationInventory(){
 const signalOwner=new AbortController();let activeNative,timer,primary;
 const interrupted=()=>signalOwner.abort(Error('Application inventory owner interrupted'));process.on('SIGTERM',interrupted);process.on('SIGINT',interrupted);
 try{
  const proof=admitCompilerApplicationInventory('fixture'),clock=readCompilerApplicationInventoryClock(proof),startNs=BigInt(clock.startNs),elapsed=()=>Number(process.hrtime.bigint()-startNs)/1e6;
  const deadline=performance.now()+REFERENCE_LIMITS.aggregateMs-elapsed();
  const check=()=>{signalOwner.signal.throwIfAborted();assert(elapsed()<718000,'Application inventory aggregate frontier closed');};
  timer=setTimeout(()=>signalOwner.abort(Error('Application inventory aggregate exhausted')),Math.max(0,718000-elapsed()));check();
  assert.equal(cpus().length,4);assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3);
  const source=proof.source,out=join(proof.destination,'compiler-native-application-inventory');mkdirSync(out,{mode:0o700});const logs=join(out,'logs');mkdirSync(logs,{mode:0o700});
  const report={kind:'CURRENT_APPLICATION_NATIVE_METADATA_NOT_COMPILER_QUALIFICATION',source:proof.sourceHead,controller:proof.controllerHead,runId:proof.run,attempt:proof.attempt,
   complete:false,applicationInventoryComplete:false,graphComplete:false,planFeasible:false,ordinaryCompilerQualified:false,originalApplicationFiveNegativesQualified:false,releaseAuthorized:false,
   limits:{...REFERENCE_LIMITS,...APPLICATION_INPUT_LIMITS},plannedPhases:APPLICATION_PHASES,phases:[],inventories:[],adoption:'Diagnostic only; ordinary singleton registration and complete current-policy witness OPEN'};
  const write=(path,value,exclusive=true)=>{check();const raw=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(raw)<=REFERENCE_LIMITS.fileBytes);writeFileSync(path,raw,{flag:exclusive?'wx':'w',mode:0o600});assertArtifactBudget(out);};
  const save=()=>{const raw=JSON.stringify({...report,elapsedMs:elapsed()},null,2)+'\n';assert(Buffer.byteLength(raw)<=REFERENCE_LIMITS.fileBytes);writeFileSync(join(out,'report.json'),raw,{mode:0o600});assertArtifactBudget(out);};
  save();
  try{
   noExternalLookupDirectories(source);assert(!namedExists(join(source,'.next'))&&!namedExists(join(source,'next-env.d.ts')),'Fresh ordinary typegen input required; preexisting generated context refused');
   for(const name of ['.env','.env.production','.env.production.local','.env.development','.env.development.local'])assert(!namedExists(join(source,name)),'Unexpected dotenv input refused');
   const environment=stableNativeInput(join(source,'.env.local'),{root:source,maximum:4*1024*1024,check}),example=stableNativeInput(join(source,'.env.example'),{root:source,maximum:4*1024*1024,check});assert(environment.bytes.equals(example.bytes),'Only exact fictional setup-alpha dotenv input allowed');
   const originals=['package.json','pnpm-lock.yaml','tsconfig.json','tsconfig.build.json','next.config.ts','mobile/package.json','mobile/package-lock.json','.env.example','.env.local'].map(name=>stableNativeInput(join(source,name),{root:source,check}).record);report.originalConfiguration=originals;
   const verifyOriginals=()=>{for(const row of originals)assert.deepEqual(stableNativeInput(row.path,{root:source,check}).record,row,'Original config/package bytes changed');};
   const metadataCheck=()=>{check();assert(performance.now()<metadataDeadline,'Package metadata phase cap');};let metadataDeadline=performance.now()+APPLICATION_INPUT_LIMITS.phaseMs;
   const before=candidatePackageContext(source,{check:metadataCheck});write(join(out,'available-package-context-before.json'),before);
   const owner=compilerOwner(source),require=createRequire(join(source,'package.json')),nextPackage=realpathSync(require.resolve('next/package.json')),nextSeal=stableNativeInput(nextPackage,{root:source,readOnlyDependency:true,check}).record;
   assert(withinInputRoot(join(source,'node_modules'),nextPackage));const nextJSON=JSON.parse(stableNativeInput(nextPackage,{root:source,readOnlyDependency:true,maximum:4*1024*1024,check}).bytes);assert.equal(nextJSON.version,'16.4.1');const nextCLI=realpathSync(require.resolve('next/dist/bin/next')),nextCLISeal=stableNativeInput(nextCLI,{root:source,readOnlyDependency:true,check}).record;
   const nativeToolInputs=[owner.api,owner.cli].map(path=>stableNativeInput(realpathSync(path),{root:source,readOnlyDependency:true,check}).record);
   report.nativeToolInputs=nativeToolInputs;report.compiler={typescript:owner.version,node:process.versions.node,apiSha256:owner.apiSha256,cliSha256:owner.cliSha256};report.framework={version:nextJSON.version,package:nextSeal,cli:nextCLISeal};
   const env={LANG:'C',LC_ALL:'C',TZ:'UTC',NEXT_TELEMETRY_DISABLED:'1'};for(const key of keys)if(process.env[key]!==undefined)env[key]=process.env[key];for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])env[key]=closed;
   let generated,originalAPI;const nativeInputs=new Map();
   async function run(label,args){
    check();verifyOriginals();for(const row of [...nativeToolInputs,nextSeal,nextCLISeal])assert.deepEqual(stableNativeInput(row.path,{root:source,readOnlyDependency:true,check}).record,row);if(generated)assert.deepEqual(generatedTypes(source,check),generated,'Fresh generated route context changed');
    const log=join(logs,label+'.log'),pending=nativeReferenceProcess(args,{cwd:source,env,deadline:Math.min(deadline,performance.now()+APPLICATION_INPUT_LIMITS.phaseMs),log,signal:signalOwner.signal,checkBudget:()=>assertArtifactBudget(out)});activeNative=pending;
    let result;try{result=await pending;}finally{if(activeNative===pending)activeNative=undefined;}
    report.phases.push({label,...result});save();requireNativeSuccess(result);check();verifyOriginals();for(const row of [...nativeToolInputs,nextSeal,nextCLISeal])assert.deepEqual(stableNativeInput(row.path,{root:source,readOnlyDependency:true,check}).record,row);if(generated)assert.deepEqual(generatedTypes(source,check),generated);return stableNativeInput(log,{root:out,maximum:REFERENCE_LIMITS.logBytes,check}).bytes.toString('utf8');
   }
   await run('next-typegen',[nextCLI,'typegen']);generated=generatedTypes(source,check);write(join(out,'fresh-generated-inputs.json'),generated);
   for(const mode of ['original','build']){
    const config=join(source,mode==='original'?'tsconfig.json':'tsconfig.build.json'),text=await run(mode+'-cli',[owner.cli,'--project',config,'--listFilesOnly','--explainFiles','--pretty','false','--tsBuildInfoFile',join(out,mode+'.tsbuildinfo')]);
    const cli=parseNativeExplanation(text,source);let value,files,roots,gapCount;
    if(mode==='original'){
     await run('original-api',[join(source,'.github/ci/diagnostics/native-reference/application-worker.mjs')]);
     originalAPI=JSON.parse(boundedCompilerBytes(join(out,'original-api.json'),REFERENCE_LIMITS.fileBytes));const reconciled=reconcileNativeMembership(cli,originalAPI);
     value={kind:'ORDERED_NATIVE_APPLICATION_MEMBERSHIP_AND_EXPLICIT_GRAPH_GAPS',mode,config,cli,...reconciled};files=originalAPI.files;roots=originalAPI.roots;gapCount=reconciled.gaps.length;
    }else{
     const build=originalAPI.buildConfiguration;assert.equal(build.config,config);assert.deepEqual(stableNativeInput(config,{root:source,check}).record,build.configSeal);const names=new Set(cli.map(row=>row.logicalPath));assert(build.roots.every(path=>names.has(path)),'Actual build configured root absent from native CLI');
     const originalByLogical=new Map(originalAPI.files.map(row=>[row.logicalPath,row])),gaps=[{kind:'build-cli-membership-only-no-fresh-build-program-or-effective-graph'}];
     files=cli.map(row=>{check();const prior=originalByLogical.get(row.logicalPath);if(prior)return prior;const path=realpathSync(row.logicalPath);assert(withinInputRoot(source,path),'Build CLI source outside candidate');const input=stableNativeInput(path,{root:source,readOnlyDependency:withinInputRoot(join(source,'node_modules'),path),check}).record;gaps.push({kind:'build-cli-member-unmapped-to-original-program',logicalPath:row.logicalPath,path});return{...input,logicalPath:row.logicalPath,nativeSourceFileObserved:false};});roots=build.roots;gapCount=gaps.length;
     value={kind:'COMPLETE_NATIVE_BUILD_CLI_MEMBERSHIP_WITH_SEPARATELY_PARSED_ROOTS',mode,config,configSeal:build.configSeal,cli,roots,options:build.options,projectReferences:build.projectReferences,files,gaps,orderedInventoryComplete:true,configuredRootsAllLoaded:true,freshBuildProgramObserved:false,graphComplete:false,planFeasible:false,compilerQualified:false};
    }
    for(const row of files){const prior=nativeInputs.get(row.path);if(prior)assert.equal(prior.sha256,row.sha256,'Source differs between actual native observations');nativeInputs.set(row.path,row);}
    write(join(out,mode+'-reconciliation.json'),value);
    report.inventories.push({mode,configuredRoots:roots.length,loadedFiles:files.length,loadedRawBytes:files.reduce((sum,row)=>sum+row.bytes,0),gaps:gapCount,orderedInventoryComplete:true,freshProgramObserved:mode==='original',graphComplete:false,planFeasible:false});
   }
   metadataDeadline=performance.now()+APPLICATION_INPUT_LIMITS.phaseMs;const after=candidatePackageContext(source,{check:metadataCheck});write(join(out,'available-package-context-after.json'),after);compareAvailableContext(before,after);
   verifyOriginals();for(const row of nativeInputs.values()){const current=stableNativeInput(row.path,{root:source,readOnlyDependency:row.readOnlyDependency,check}).record;assert.deepEqual(current,{path:row.path,sha256:row.sha256,bytes:row.bytes,identity:row.identity,readOnlyDependency:row.readOnlyDependency},'Actual native loaded input changed before completion');}assert.deepEqual(generatedTypes(source,check),generated);assert(same(readCompilerApplicationInventoryClock(admitCompilerApplicationInventory('fixture')),clock),'Original native clock changed');
   assert.deepEqual(report.phases.map(row=>row.label),APPLICATION_PHASES);report.availablePackageContextStable=true;report.applicationInventoryComplete=true;report.complete=true;report.artifactBudget=assertArtifactBudget(out);check();
  }catch(error){primary=error;report.complete=false;report.applicationInventoryComplete=false;report.failure={name:error.name,message:error.message};report.blocked=APPLICATION_PHASES.filter(label=>!report.phases.some(row=>row.label===label)).map(label=>({label,status:'blocked',reason:'failed-or-exhausted-native-metadata-prerequisite'}));throw error;}
  finally{try{save();}catch(error){if(primary)throw new AggregateError([primary,error],'Inventory and partial report refused');throw error;}}
  return report;
 }catch(error){primary=error;throw error;}
 finally{
  if(activeNative&&!signalOwner.signal.aborted)signalOwner.abort(Error('Application inventory settlement required'));
  try{await activeNative;}catch(error){if(primary&&primary!==error)throw new AggregateError([primary,error],'Inventory and native child settlement refused');throw error;}
  finally{if(timer)clearTimeout(timer);process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);}
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,2);await nativeApplicationInventory();}
