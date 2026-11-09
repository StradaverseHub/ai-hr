/** Closed projections for the public focused artifact. Raw compiler files stay in the private owner. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

export const comparisonPhases=['original-list-only','producer','source-0','reference-0','reference-1','source-1','source-negative','reference-negative','missing-reference'];
const terminalPhase='owned-declarations-and-context';
const producerModules=['db/client.ts','db/admission.ts','db/background-read-admission.ts','db/tenant-write-admission.ts',
 'db/workload.ts','db/capacity.ts','core/audit-chain-arming.ts','core/entitlement-types.ts'];
const realTests=['test/payroll-tax-basis-read.test.ts','test/personnel-import-browser-key.test.ts','test/runner-control.test.ts'];
const negativeCodes=[2322,2322,2339,2322];
const generatedNames=['next-env.d.ts','.next/types/cache-life.d.ts','.next/types/root-params.d.ts','.next/types/routes.d.ts','.next/types/validator.ts'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const count=(value,max=1e10)=>{assert(Number.isSafeInteger(value)&&value>=0&&value<=max);return value;};
const duration=value=>{assert(Number.isFinite(value)&&value>=0&&value<=720000);return Math.round(value);};
const digest=value=>{assert(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));return value;};
const seal=(value,max=16*1024**2)=>({bytes:count(value.bytes,max),sha256:digest(value.sha256)});
const codeNames=['ERR_ASSERTION','ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','EIO','ENOSPC','ESRCH','EPIPE','PIPE','SPAWN','KILL'];
export const safeProbeError=value=>value==null?null:codeNames.includes(value)?value:'other';
const signal=value=>value==null?null:['SIGKILL','SIGTERM','SIGINT','SIGABRT'].includes(value)?value:'other';
const stop=value=>value==null?null:['phase-deadline','aborted','child-error','pipe-drain','output-bound','missing-process-identity','missing-pipe','pipe-error'].includes(value)?value:'other';
const status=value=>value==null?null:count(value,255);

export function publicInnerRefusal(value){
 const phases=['identity','mounts','network','host-grant','protected-stock-next','protected-db-client-compare','protected-db-client-close-grant'];
 return {phase:phases.includes(value?.phase)?value.phase:'other',code:safeProbeError(value?.code)};
}
export function publicTypegenExecution(value){
 assert.equal(value.invoked,true);
 return {invoked:true,exit:status(value.exit),signal:signal(value.signal),errorCode:safeProbeError(value.errorCode),
  elapsedMs:duration(value.elapsedMs),outputBytes:count(value.outputBytes,512*1024),outputSha256:digest(value.outputSha256)};
}
export function publicGeneratedSeals(value){
 assert.deepEqual(Object.keys(value).sort(),[...generatedNames].sort());
 return Object.fromEntries(generatedNames.map(name=>[name,seal(value[name])]));
}
export function publicTypegenResult(value,source,tree){
 assert.deepEqual([value.kind,value.source,value.tree,value.routeSemanticCoverage,value.releaseEligible],
  ['PROTECTED_STOCK_NEXT_TYPEGEN',source,tree,false,false]);
 assert(value.trackedProductWrites===0&&value.packageDownloads===false&&value.strictCompilerInvoked===false);
 const d=value.dependencies;
 assert(d.gnuElfLoaded===true&&d.nextVersion==='16.4.1'&&d.swcVersion==='16.4.1'&&d.installedArtifactTarballIndependentlyVerified===false);
 assert.match(d.swcLockIntegrity,/^sha512-[A-Za-z0-9+/]{86}==$/);
 const types=[['typescript','5.9.3'],['@types/node','20.19.41'],['@types/react','19.2.16'],['@types/react-dom','19.2.3']];
 assert.deepEqual(d.typescriptInputs.map(row=>[row.name,row.version]),types);
 const dependencySeals=Object.fromEntries(['nextPackage','nextCli','nextSwcLoader','swcPackage','nativeSwc'].map(name=>[name,seal(d[name],name==='nativeSwc'?256*1024**2:16*1024**2)]));
 return {kind:'PROTECTED_STOCK_NEXT_TYPEGEN',source,tree,...publicTypegenExecution(value),
  dependencies:{...dependencySeals,nextVersion:'16.4.1',swcVersion:'16.4.1',gnuElfLoaded:true,swcLockIntegrity:d.swcLockIntegrity,
   installedArtifactTarballIndependentlyVerified:false,typescriptInputs:types.map(([name,version],index)=>({
    name,version,packageJson:seal(d.typescriptInputs[index].packageJson),entry:seal(d.typescriptInputs[index].entry)}))},
  generated:publicGeneratedSeals(value.generated),trackedProductWrites:0,packageDownloads:false,
  strictCompilerInvoked:false,routeSemanticCoverage:false,releaseEligible:false};
}
function privateFile(path){
 const before=lstatSync(path);
 assert(before.isFile()&&before.nlink===1&&before.uid===process.getuid()&&(before.mode&0o022)===0&&
  realpathSync(path)===path&&before.size>=0&&before.size<=16*1024**2);
 const bytes=readFileSync(path),after=lstatSync(path);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key]);
 assert.equal(bytes.length,before.size);
 return {bytes,seal:{bytes:before.size,sha256:hash(bytes)}};
}
const phaseOrder=[...comparisonPhases,terminalPhase];
function verifiedDbClientWitness(report){
 const [inventory,producer,a0,b0,b1,a1,an,bn,missing,context]=report.phases;
 assert(inventory.compilerSemanticsRequested===false&&inventory.validatorObserved===true);
 const originalRoots=count(inventory.configuredRoots,50000),originalLoaded=count(inventory.loadedFiles,50000);
 assert(originalRoots>9000&&originalLoaded>=originalRoots);
 const tooling=count(inventory.secondToolingRoots,5000);
 assert(tooling>2000&&tooling<3000);
 assert.deepEqual(an.diagnostics,bn.diagnostics);
 assert.deepEqual(an.diagnostics.map(row=>row.code),negativeCodes);
 assert.deepEqual(context.matchedNegativeCodes,negativeCodes);
 assert.deepEqual(missing.diagnostics.map(({file,line,code})=>({file,line,code})),[
  {file:'/work/db-client/missing-db-client.ts',line:1,code:6305}]);
 assert.deepEqual(context.sourceOnly,[...producerModules.map(name=>'/project/'+name)].sort());
 assert.equal(context.sourceAlias,'/project/db/client.ts');
 assert.equal(context.referenceAlias,'/work/db-client/producer-output/db/client.d.ts');
 assert(context.referenceOnly.includes(context.referenceAlias));
 assert(context.referenceOnly.every(path=>context.ownedDeclarations.includes(path)));
 assert.equal(context.externalSemanticRequested,false);
 assert.deepEqual(context.packageIds.map(row=>[row.specifier,row.mode,row.target.packageId.version]),[
  ['drizzle-orm',99,'0.45.2'],['drizzle-orm/postgres-js',99,'0.45.2'],['drizzle-orm/pg-core',99,'0.45.2'],['postgres',99,'3.4.9']]);
 assert(context.packageIds.slice(0,3).every(row=>row.target.packageId.peerDependencies==='+postgres@3.4.9'));
 assert.equal(context.ambient.length,3);
 assert(context.ambient.every(row=>row.module==='node:async_hooks'&&row.symbol==='AsyncLocalStorage'&&
  row.providerSha256==='8c0bcd6c6b67b4b503c11e91a1fb91522ed585900eab2ab1f61bba7d7caa9d6f'));
 assert(context.automaticTypes.some(row=>row.name==='node'&&row.target.packageId.version==='20.19.41'));
 assert(['drizzle-orm/postgres-js','postgres'].every(name=>context.emittedPackageUses.some(row=>row.specifier===name)));
 const declarations=producerModules.map(name=>{
  const path='/work/db-client/producer-output/'+name.replace(/\.ts$/,'.d.ts');
  assert(context.ownedDeclarations.includes(path));
  const selected=producer.outputs.filter(row=>row.path===path);
  assert.equal(selected.length,1);
  return {module:name,...seal(selected[0])};
 });
 assert.equal(context.ownedDeclarations.length,producerModules.length);
 assert.equal(producer.outputs.length,producerModules.length+1);
 const cells=[a0,b0,b1,a1].map(row=>{
  assert(Array.isArray(row.orderedFiles)&&row.orderedFiles.length===row.metrics.files);
  return {phase:row.phase,files:count(row.metrics.files,50000),
   compilerHeapUsedRoundedKB:count(row.metrics.compilerHeapUsedRoundedKB),orderedFilesSha256:hash(JSON.stringify(row.orderedFiles))};
 });
 return {originalInventory:{configuredRoots:originalRoots,loadedFiles:originalLoaded,validatorObserved:true,
   validatorSemanticsRequested:false,secondToolingRoots:tooling,secondToolingSeal:digest(inventory.secondToolingSeal)},
  producer:{declarations,emittedJavaScriptCount:0,buildInfoCount:1},cells,
  dbClient:{tests:realTests,nativeReferenceModule:'db/client.d.ts',noSourceFallback:true,
   ownedDeclarationSemanticsPassed:true,commonInputCount:count(context.commonInputCount,50000),
   packageIdentitySha256:hash(JSON.stringify(context.packageIds)),nodeVersion:'20.19.41',
   asyncHooksProviderSha256:context.ambient[0].providerSha256,producerAmbientImports:2,
   pairedNegativeCodes:[...negativeCodes],missingReferenceCode:6305}};
}
export function publicDbClientComparison(directory,complete,source){
 const file=privateFile(join(directory,'report.json')),report=JSON.parse(file.bytes.toString('utf8'));
 assert.equal(report.kind,'PROTECTED_DB_CLIENT_REFERENCE_COMPARISON');assert.equal(report.product,source);
 for(const name of ['ordinaryCompilerQualified','releaseAuthorized','generatedValidatorSemanticRequested','applicationAmbientEquivalenceQualified',
  'originalApplicationFiveNegativesQualified'])assert.equal(report[name],false);
 assert(typeof report.complete==='boolean');
 const attempts=report.attempts;
 assert(Array.isArray(attempts)&&attempts.length<=comparisonPhases.length);
 assert.deepEqual(attempts.map(row=>row.phase),comparisonPhases.slice(0,attempts.length));
 assert(Array.isArray(report.phases)&&report.phases.length<=phaseOrder.length);
 const completedPhases=report.phases.map(row=>row.phase);
 assert.deepEqual(completedPhases,phaseOrder.slice(0,completedPhases.length));
 let total=file.seal.bytes;
 const observed=attempts.map(row=>{
  const log=privateFile(join(directory,row.phase+'.log')).seal;
  total+=log.bytes;assert(total<=48*1024**2);
  assert.deepEqual(log,seal(row.log));
  return {phase:row.phase,availableMemory:count(row.availableMemory),exit:status(row.exitCode),signal:signal(row.exitSignal),
   failureCode:safeProbeError(row.failure),stopCategory:stop(row.stopped),samples:count(row.samples,100000),peakRss:count(row.peakRss),
   elapsedMs:duration(row.elapsedMs),log};
 });
 const result={kind:'PROTECTED_DB_CLIENT_PUBLIC_EVIDENCE',productSource:source,complete:complete&&report.complete,nativeReportTerminal:report.complete,completedPhases,
  attempts:observed,privateReport:file.seal,ordinaryCompilerQualified:false,releaseAuthorized:false,
  generatedValidatorSemanticRequested:false,applicationAmbientEquivalenceQualified:false,originalApplicationFiveNegativesQualified:false};
 if(complete){
  assert(report.complete);assert.deepEqual(completedPhases,phaseOrder);assert.equal(attempts.length,comparisonPhases.length);
  for(const attempt of observed){
   assert(attempt.signal===null&&attempt.failureCode===null&&attempt.stopCategory===null&&attempt.samples>0&&attempt.peakRss>0);
   assert(['source-negative','reference-negative','missing-reference'].includes(attempt.phase)?Number.isInteger(attempt.exit)&&attempt.exit>0:attempt.exit===0);
  }
  result.generated=publicGeneratedSeals(report.generated);
  result.witness=verifiedDbClientWitness(report);
 }else{
  const last=observed.at(-1);
  const category=last?.stopCategory==='phase-deadline'?'compiler-timeout':last?.signal?'compiler-signalled':
   last?.failureCode?'compiler-child-refused':last?.exit?'native-diagnostic-or-witness-refused':'protected-input-or-witness-refused';
  result.failure={category,code:safeProbeError(report.failure?.code)};
 }
 return result;
}

/** Final branch-scoped uploader frontier, after the selected reporter and resource owners have closed. */
export function closeProtectedArtifactTree(directory){
 assert.equal(realpathSync(directory),directory);
 const owned=(path,isDirectory)=>{
  const row=lstatSync(path);
  assert(row.uid===process.getuid()&&(row.mode&0o022)===0&&realpathSync(path)===path);
  assert(isDirectory?row.isDirectory():row.isFile()&&row.nlink===1);
 };
 owned(directory,true);
 const entries=readdirSync(directory),raw='nodb.vitest.json';
 if(entries.includes(raw)){
  const path=join(directory,raw);
  owned(path,false);unlinkSync(path);
 }
 const files=['compiler-reference-preflight.json','compiler-reference-clock.json','compiler-reference-clock-ack.json',
  'compiler-supervisor.jsonl','focused.json','focused-partial.json','compiler-settlement.json','protected-docker-settlement.json'];
 const stages={'compiler-protected-docker':'PROTECTED_NEXT_TYPEGEN_6C05','compiler-protected-db-client':'PROTECTED_DB_CLIENT_COMPARISON_6C05'};
 const reportFields=new Set(['kind','source','controller','run','attempt','role','productSource','productTree','transportQualified',
  'productInputsMounted','stockNextInvoked','strictCompilerInvoked','ordinaryCompilerQualified','releaseAuthorized','productProjection',
  'sameRunGeneratedSeals','sameRunPrivateHandoffConsumed','createDiagnostic','innerRefusal','observed','comparison','typegenExecution',
  'typegen','typegenLaunchIntent','refusal','partialComparison','settlementRefused','settlement']);
 const markers=['compiler-reference-clock.json.ready','compiler-reference-clock-ack.json.ready'];
 let structured=0;
 for(const name of readdirSync(directory)){
  const path=join(directory,name);
  if(files.includes(name)){owned(path,false);structured++;continue;}
  assert(Object.hasOwn(stages,name)||markers.includes(name),'Unexpected protected artifact member');
  owned(path,true);
  const members=readdirSync(path);
  assert(Object.hasOwn(stages,name)?members.every(member=>member==='report.json'):members.length===0,
   'Unexpected protected artifact directory member');
  for(const member of members){
   const report=join(path,member);
   owned(report,false);
   assert(lstatSync(report).size>0&&lstatSync(report).size<=256*1024);
   const value=JSON.parse(readFileSync(report,'utf8'));
   assert(value.kind===stages[name]&&value.releaseAuthorized===false&&value.ordinaryCompilerQualified===false);
   assert(Object.keys(value).every(key=>reportFields.has(key)),'Unexpected protected report field');
   structured++;
  }
 }
 assert(structured>0,'No structured protected evidence to publish');
}
