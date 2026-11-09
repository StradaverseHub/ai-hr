/** Closed projections for the public focused artifact. Raw compiler files stay in the private owner. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

export const comparisonPhases=['original-list-only','producer','source-0','reference-0','reference-1','source-1','missing-reference'];
const terminalPhase='owned-declarations-and-context';
const targetRoute='app/payroll/transactions/tp1/[year]/page.tsx';
const date=['lib/calendar-date.ts','lib/date-time-formatter.ts','lib/hr-date.ts'];
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
 const phases=['identity','mounts','network','host-grant','protected-stock-next','protected-tp1-compare','protected-tp1-close-grant'];
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
function verifiedTp1Witness(report){
 const [inventory,producer,...rest]=report.phases;
 const [a0,b0,b1,a1,negative,context]=rest;
 assert.equal(inventory.edge.compilerSemanticsRequested,false);
 assert.equal(inventory.edge.from,'/project/.next/types/validator.ts');
 assert.equal(inventory.edge.to,'/project/'+targetRoute);
 const originalRoots=count(inventory.edge.configuredRoots,50000),originalLoaded=count(inventory.edge.loadedFiles,50000);
 assert(originalRoots>0&&originalLoaded>=originalRoots);
 assert.deepEqual(negative.diagnostics.map(row=>({file:row.file,line:row.line,code:row.code})),[
  {file:'/project/'+targetRoute,line:2,code:6305}]);
 const expectedDeclaration='/work/tp1/producer-output/lib/hr-date.d.ts';
 assert.deepEqual(context.overlap.sourceOnly,[...date.map(name=>'/project/'+name)].sort());
 assert.deepEqual(context.overlap.referenceOnly,[expectedDeclaration]);
 assert.equal(context.sourceAlias.selectedDeclaration,'/project/lib/hr-date.ts');
 assert.equal(context.referenceAlias.selectedDeclaration,expectedDeclaration);
 assert.equal(context.sourceAlias.mode,99);assert.equal(context.referenceAlias.mode,99);
 assert.equal(context.context.generatedPageProps,'/project/.next/types/routes.d.ts');
 assert.deepEqual([context.context.navigation.target.packageId.name,context.context.navigation.target.packageId.version],
  ['next','16.4.1']);
 assert.deepEqual([context.context.jsxRuntime.target.packageId.name,context.context.jsxRuntime.target.packageId.version],
  ['@types/react','19.2.16']);
 const signature=context.context.signature;
 assert.deepEqual(Object.keys(signature).sort(),['params','result','searchParams']);
 for(const value of Object.values(signature))assert(typeof value==='string'&&value.length>0&&value.length<=1024);
 assert.equal(context.validation.externalSemanticRequested,false);
 const declarations=date.map(name=>{
  const path='/work/tp1/producer-output/'+name.replace(/\.ts$/,'.d.ts');
  assert(context.validation.owned.includes(path));
  const outputs=producer.outputs.filter(row=>row.path===path);
  assert.equal(outputs.length,1);
  return {module:name,...seal(outputs[0])};
 });
 assert.equal(context.validation.owned.length,3);
 assert.equal(producer.outputs.length,7);
 const cells=[a0,b0,b1,a1].map(row=>{
  assert(Array.isArray(row.orderedFiles)&&row.orderedFiles.length===row.metrics.files);
  return {phase:row.phase,files:count(row.metrics.files,50000),
   compilerHeapUsedRoundedKB:count(row.metrics.compilerHeapUsedRoundedKB),orderedFilesSha256:hash(JSON.stringify(row.orderedFiles))};
 });
 return {originalInventory:{configuredRoots:originalRoots,loadedFiles:originalLoaded,validatorRootObserved:true,exactTp1EdgeObserved:true,
   validatorSemanticsRequested:false},producer:{declarations,emittedJavaScriptCount:3,buildInfoCount:1},cells,
  tp1:{route:targetRoute,generatedYearParamsBothDirections:true,optionalStringEmploymentId:true,
   signatureSha256:hash(JSON.stringify(signature)),dateSourceModules:date,nativeReferenceModule:'lib/hr-date.d.ts',
   commonInputCount:count(context.overlap.intersection,50000),bundlerResolutionMode:99,
   nextVersion:'16.4.1',reactTypesVersion:'19.2.16',ownedDeclarationSemanticsPassed:true},
  missingReference:{route:targetRoute,line:2,code:6305},pairedDateTs2345Run:false,wrongTp1ParamsNegativeRun:false};
}
export function publicTp1Comparison(directory,complete,source){
 const file=privateFile(join(directory,'report.json')),report=JSON.parse(file.bytes.toString('utf8'));
 assert.equal(report.kind,'PROTECTED_TP1_DATE_REFERENCE_COMPARISON');assert.equal(report.product,source);
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
 const result={kind:'PROTECTED_TP1_PUBLIC_EVIDENCE',productSource:source,complete:complete&&report.complete,nativeReportTerminal:report.complete,completedPhases,
  attempts:observed,privateReport:file.seal,ordinaryCompilerQualified:false,releaseAuthorized:false,
  generatedValidatorSemanticRequested:false,applicationAmbientEquivalenceQualified:false,originalApplicationFiveNegativesQualified:false};
 if(complete){
  assert(report.complete);assert.deepEqual(completedPhases,phaseOrder);assert.equal(attempts.length,comparisonPhases.length);
  for(const attempt of observed){
   assert(attempt.signal===null&&attempt.failureCode===null&&attempt.stopCategory===null&&attempt.samples>0&&attempt.peakRss>0);
   assert(attempt.phase==='missing-reference'?Number.isInteger(attempt.exit)&&attempt.exit>0:attempt.exit===0);
  }
  result.generated=publicGeneratedSeals(report.generated);
  result.witness=verifiedTp1Witness(report);
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
 const stages={'compiler-protected-docker':'PROTECTED_NEXT_TYPEGEN_A139','compiler-protected-tp1':'PROTECTED_TP1_DATE_COMPARISON_A139'};
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
