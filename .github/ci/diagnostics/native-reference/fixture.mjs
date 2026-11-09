/** Small actual native-reference experiment ONLY. No whole-graph/release switch. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,existsSync,renameSync} from 'node:fs';
import {join,dirname,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem} from 'node:os';
import {planNativeReferences,REFERENCE_LIMITS} from './graph.mjs';
import {writeNativeReferenceConfigs,NATIVE_REFERENCE_OVERRIDES,assertNativeParsedConfig} from './config.mjs';
import {outputOwnership,regularHash,assertOutputSeal,emittedTree,digest,assertArtifactBudget} from './outputs.mjs';
import {compilerOwner,parsedConfig} from './worker.mjs';
import {nativeReferenceProcess,requireNativeSuccess} from './process.mjs';
import {admitCompilerReference,readCompilerReferenceClock} from './admission.mjs';
import {fixturePackageRoot,FIXTURE_PACKAGE_MANIFEST,FIXTURE_PACKAGE_BODY_SHA256,FIXTURE_PACKAGE_BODY_BYTES} from './package-context.mjs';
import {NEGATIVE_CONTRACTS} from '../compiler-boundary-policy.mjs';
const fixtureFiles=['base.json','ambient.d.ts','producer/index.ts','producer/math.js','producer/labels.json','consumer/index.ts'];
const FIXTURE_SELECTOR='test/compiler-native-reference-fixture.test.ts';
const PLANNED_PHASES=Object.freeze(['inventory','native-solution-graph','missing-native-output','native-project-000','inspect-project-000','native-project-001','inspect-project-001','owned-declarations','external-preexisting-control','missing-ambient','source-api-negative','emitted-api-negative','owned-unresolved-sentinel']);
const diagnosticCodes=text=>[...text.matchAll(/error TS([0-9]+):/g)].map(match=>Number(match[1]));
export async function nativeReferenceFixture(){
 const controller=new AbortController();let activeNative,deadlineTimer,primary;
 const interrupted=()=>controller.abort(Error('Native compiler fixture owner interrupted'));
 process.on('SIGTERM',interrupted);process.on('SIGINT',interrupted);
 try{
 const proof=admitCompilerReference('fixture'),clock=readCompilerReferenceClock(proof),startNs=BigInt(clock.startNs);
 const elapsed=()=>Number(process.hrtime.bigint()-startNs)/1e6;
 const started=performance.now()-elapsed(),deadline=started+REFERENCE_LIMITS.aggregateMs;
 const active=()=>{controller.signal.throwIfAborted();assert(performance.now()<deadline-2000,'Native fixture work frontier closed');};
 deadlineTimer=setTimeout(()=>controller.abort(Error('Native fixture aggregate budget exhausted')),Math.max(0,deadline-performance.now()-2000));
 active();
 assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(process.env.GITHUB_JOB,'selected-tests');assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');assert(/^[1-9][0-9]{0,19}$/.test(process.env.GITHUB_RUN_ID??''));assert.deepEqual(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'null'),[FIXTURE_SELECTOR]);
 assert.equal(cpus().length,4);assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3);
 const cwd=proof.source,sourceHead=proof.sourceHead;assert.equal(process.env.AIHR_CI_HEAD,sourceHead);assert.equal(process.env.AIHR_CI_CONTROL_HEAD,proof.controllerHead);
 const temp=realpathSync(process.env.RUNNER_TEMP),evidence=join(temp,'aihr-focused');assert.equal(realpathSync(evidence),evidence);assert.equal(process.env.AIHR_FOCUSED_EVIDENCE_DIR,evidence);
 const out=join(evidence,'compiler-native-reference');mkdirSync(out,{mode:0o700});const source=join(out,'source');mkdirSync(source,{mode:0o700});const logs=join(out,'logs');mkdirSync(logs,{mode:0o700});
 const report={kind:'SMALL_NATIVE_REFERENCE_FIXTURES_NOT_APPLICATION',source:sourceHead,controller:process.env.AIHR_CI_CONTROL_HEAD,runId:process.env.GITHUB_RUN_ID,ordinaryCompilerQualified:false,releaseAuthorized:false,applicationInventoryComplete:false,originalApplicationFiveNegativesQualified:false,complete:false,limits:REFERENCE_LIMITS,plannedPhases:PLANNED_PHASES,phases:[],controls:[]};
 const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify({...report,elapsedMs:elapsed()},null,2)+'\n',{mode:0o600});
 const input=[];for(const name of fixtureFiles){const bytes=readFileSync(join(cwd,'test/fixtures/compiler-native-reference',name+'.fixture')),path=join(source,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,bytes,{flag:'wx',mode:0o600});input.push(regularHash(path));}
 const external=fixturePackageRoot(source);mkdirSync(external,{recursive:true,mode:0o700});const externalBytes=readFileSync(join(cwd,'test/fixtures/compiler-native-reference/external/index.d.ts.fixture'));assert.equal(externalBytes.length,FIXTURE_PACKAGE_BODY_BYTES);assert.equal(digest(externalBytes),FIXTURE_PACKAGE_BODY_SHA256);writeFileSync(join(external,'package.json'),FIXTURE_PACKAGE_MANIFEST,{flag:'wx',mode:0o600});writeFileSync(join(external,'index.d.ts'),externalBytes,{flag:'wx',mode:0o600});input.push(regularHash(join(external,'package.json')),regularHash(join(external,'index.d.ts')));
 const owner=compilerOwner(cwd),worker=fileURLToPath(new URL('worker.mjs',import.meta.url));report.compiler={typescript:owner.version,node:process.versions.node,apiSha256:owner.apiSha256,cliSha256:owner.cliSha256};report.inputs=input;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C',LC_ALL:'C',TZ:'UTC',RUNNER_TEMP:temp};let sequence=0;
 async function run(label,args,expectation='success'){
  active();assertOutputSeal(input);
  const log=join(logs,String(sequence++).padStart(2,'0')+'-'+label+'.log');
  const pending=nativeReferenceProcess(args,{cwd,env,deadline,log,signal:controller.signal,checkBudget:()=>assertArtifactBudget(out)});activeNative=pending;
  let result;try{result=await pending;}finally{if(activeNative===pending)activeNative=undefined;}
  const row={label,expectation,...result};report.phases.push(row);save();controller.signal.throwIfAborted();
  assert.equal(result.signal,null);assert.equal(result.stoppedBecause,null);assert.equal(result.error,null);assertArtifactBudget(out);if(expectation==='success')requireNativeSuccess(result);return{...result,text:readFileSync(log,'utf8')};
 }
 async function api(label,mode,job,expectation='success'){active();const stem=join(out,label),input=stem+'.input.json',output=stem+'.json';writeFileSync(input,JSON.stringify({...job,source,configSeal:regularHash(job.config)},null,2)+'\n',{flag:'wx',mode:0o600});const result=await run(label,[worker,mode,input,output],expectation);return{result,value:existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null};}
 const cli=(config)=>[owner.cli,'-p',config,'--pretty','false','--listFiles','--listEmittedFiles'];
 const list=text=>text.split(/\r?\n/).filter(line=>line.startsWith('/')).map(path=>realpathSync(path));
 try{
  const inventory=(await api('inventory','inventory',{config:join(source,'base.json')})).value;assert(inventory);report.inventory=inventory;
  const packageInput=input.filter(row=>row.path.startsWith(external+'/'));assert.equal(packageInput.length,2);
  const packageContext=value=>{assert.equal(value.fixtureExternal.path,join(external,'index.d.ts'));for(const row of packageInput)assert.deepEqual(row,row.path.endsWith('/package.json')?value.fixtureExternal.manifest:value.fixtureExternal.body);};packageContext(inventory);
  assert.throws(()=>planNativeReferences(inventory,{roots:2,ownedClosure:2}),/Oversized native SCC or required context/,'The original two-root claim omits actual native context roots');
  const plan=planNativeReferences(inventory,{roots:4,ownedClosure:2});assert.equal(plan.projects.length,2,'Fixture must exercise a genuine boundary');report.plan=plan;
  assert.equal(plan.projects[0].roots.length,2);assert.equal(plan.projects[0].owned.length,2);assert.equal(plan.projects[0].configuredRoots.length,4,'Producer requires index, math, JSON and ambient configured roots');
  report.controls.push({kind:'undersized-original-root-budget',status:'expected-planner-refusal',refusedRootCap:2,actualProducerConfiguredRoots:4,ownedProducerImplementations:2});
  const outputs=outputOwnership(plan,inventory.files);report.outputOwnership=outputs;
  const configRoot=join(out,'projects');mkdirSync(configRoot,{mode:0o700});const configs=writeNativeReferenceConfigs({base:join(source,'base.json'),source,output:configRoot,plan,files:inventory.files});report.configs=configs;
  const configSeals=[...configs.projects.map(p=>regularHash(p.config)),regularHash(configs.solution)];report.configSeals=configSeals;
  // Precomputed ownership must agree with the pinned public native output API.
  report.nativeParsedConfiguredRoots=[];
  for(const project of configs.projects){const parsed=parsedConfig(owner.ts,project.config);assertNativeParsedConfig(parsed,project.files,plan.limits);report.nativeParsedConfiguredRoots.push({project:project.id,originalImplementationRoots:project.roots.length,ownedImplementations:project.owned.length,configuredRoots:parsed.fileNames.length,rootCap:plan.limits.roots});const native=parsed.fileNames.flatMap(path=>owner.ts.getOutputFileNames(parsed,path,false)).sort();const predicted=outputs.filter(row=>row.projects.includes(project.index)).map(row=>join(configs.emitted,row.path)).sort();assert.deepEqual(native,predicted);assert.equal(parsed.options.strict,true);assert.equal(parsed.options.skipLibCheck,true);assert.equal(parsed.options.emitDeclarationOnly,false);}
  const solutionOrder=await run('native-solution-graph',[owner.cli,'-b',configs.solution,'--dry','--verbose','--pretty','false']);const nativeOrder=[...solutionOrder.text.matchAll(/^\s+\* (.+)$/gm)].map(match=>resolve(cwd,match[1]));assert.deepEqual(nativeOrder,[...configs.projects.map(p=>p.config),configs.solution],'Native solution order differs from owned dependency graph');report.nativeSolutionOrder=nativeOrder;
  const missingRoot=join(out,'missing-reference');mkdirSync(missingRoot,{mode:0o700});const missing=writeNativeReferenceConfigs({base:join(source,'base.json'),source,output:missingRoot,plan,files:inventory.files});
  const missingResult=await run('missing-native-output',cli(missing.projects[1].config),'expected-native-refusal');assert.notEqual(missingResult.code,0);assert(diagnosticCodes(missingResult.text).includes(6305)&&diagnosticCodes(missingResult.text).every(code=>[6305,7006].includes(code)),'Only actual native missing-reference output refusal/cascades are accepted');report.controls.push({kind:'missing-native-output',status:'expected-native-refusal',codes:diagnosticCodes(missingResult.text),rawCode:missingResult.code});
  let seals=[];
  for(const project of configs.projects){assertOutputSeal(configSeals);if(seals.length)assertOutputSeal(seals);const before=emittedTree(configs.emitted);assert(!existsSync(project.buildInfo),'Cold project build-info must be absent');
   const result=await run('native-'+project.id,cli(project.config));assert.deepEqual(diagnosticCodes(result.text),[]);const emitted=result.text.split(/\r?\n/).filter(line=>line.startsWith('TSFILE: ')).map(line=>realpathSync(line.slice(8)));
   const expected=[project.buildInfo,...outputs.filter(row=>row.projects.includes(project.index)).map(row=>join(configs.emitted,row.path))].sort();assert.deepEqual([...new Set(emitted)].sort(),expected,'Complete actual native emitted membership');assert.equal(new Set(emitted).size,emitted.length);
   const after=emittedTree(configs.emitted);for(const prior of before){const owned=outputs.find(row=>join(configs.emitted,row.path)===prior.path);assert(owned,'Foreign prior output');const actual=after.find(row=>row.path===prior.path);assert(actual);assert.equal(actual.sha256,prior.sha256,'Conflicting native output rewrite');if(emitted.includes(prior.path))assert.equal(owned.kind,'json','Duplicate declaration/JS writer');}
   seals=[...after,...configs.projects.filter(p=>existsSync(p.buildInfo)).map(p=>regularHash(p.buildInfo))];const allowed=project.owned.map(id=>inventory.files.find(f=>f.id===id).path);
   const observed=(await api('inspect-'+project.id,'inspect',{config:project.config,allowedImplementations:allowed,seals})).value;assert(observed);packageContext(observed);assert.deepEqual(observed.files.map(row=>row.path).sort(),[...new Set(list(result.text))].sort(),'Actual CLI and fresh default-host loaded membership differ');report.controls.push({kind:'native-project',project:project.id,status:'native-zero-exit-with-complete-emission',owned:allowed,observed});
  }
  const all=emittedTree(configs.emitted);assert.deepEqual(all.map(row=>row.path).sort(),outputs.map(row=>join(configs.emitted,row.path)).sort());report.nativeOutputs=seals;
  const json=join(configs.emitted,'producer/labels.json');assert(all.some(row=>row.path===json));assert.deepEqual(JSON.parse(readFileSync(json,'utf8')),JSON.parse(readFileSync(join(source,'producer/labels.json'),'utf8')));
  const consumer=report.controls.find(row=>row.kind==='native-project'&&row.project==='project-001').observed;// TypeScript5.9.3 keeps referenced JSON as original source context; only
  // implementation files redirect to native declarations. Both copies stay sealed.
  const sourceJson=join(source,'producer/labels.json'),sourceJsonSeal=input.find(row=>row.path===sourceJson),emittedJsonSeal=seals.find(row=>row.path===json);assert(sourceJsonSeal&&emittedJsonSeal);
  const nativeJson=consumer.files.filter(row=>row.path.endsWith('.json'));assert.deepEqual(nativeJson.map(row=>row.path),[sourceJson],'Exact native original JSON context required');
  assert.equal(nativeJson[0].sha256,sourceJsonSeal.sha256);assert.equal(nativeJson[0].bytes,sourceJsonSeal.bytes);assert.equal(nativeJson[0].readOnlyDependency,false);assert.equal(nativeJson[0].external,false);assert.equal(nativeJson[0].defaultLibrary,false);
  assert.deepEqual(regularHash(sourceJson),sourceJsonSeal);assert.deepEqual(regularHash(json),emittedJsonSeal);assert.deepEqual(JSON.parse(readFileSync(sourceJson,'utf8')),JSON.parse(readFileSync(json,'utf8')),'Native JSON semantic values differ');
  report.controls.push({kind:'native-json-source-context',source:sourceJsonSeal,emitted:emittedJsonSeal,loaded:nativeJson[0],nativeOriginalSource:true});assert(consumer.files.some(row=>row.path===join(configs.emitted,'producer/index.d.ts')));assert(!consumer.files.some(row=>row.path===join(source,'producer/index.ts')));
  const owned=all.filter(row=>/\.d\.[cm]?ts$/.test(row.path)).map(row=>row.path),projectConfigs=configs.projects.map(p=>p.config),projectSeals=configSeals.filter(row=>projectConfigs.includes(row.path)),ambient=join(source,'ambient.d.ts');
  function validator(name,extra=[],includeAmbient=true){active();const path=join(configRoot,name+'.json'),names=[...owned,...extra,...(includeAmbient?[ambient]:[])];writeFileSync(path,JSON.stringify({extends:join(source,'base.json'),files:names,include:[],references:projectConfigs.map(path=>({path})),compilerOptions:{...NATIVE_REFERENCE_OVERRIDES,noEmit:true,skipLibCheck:false,rootDir:source,outDir:configs.emitted,tsBuildInfoFile:join(configRoot,name+'.tsbuildinfo')}},null,2)+'\n',{flag:'wx',mode:0o600});assertNativeParsedConfig(parsedConfig(owner.ts,path),names);return path;}
  const validation=validator('validate-owned');const validated=(await api('owned-declarations','declarations',{config:validation,owned,seals,projectConfigs,projectSeals})).value;assert(validated&&validated.externalSemanticRequested===false);packageContext(validated);report.ownedDeclarationValidation=validated;
  const externalControl=(await api('external-preexisting-control','external-control',{config:validation,owned,seals,projectConfigs,projectSeals})).value;assert(externalControl);assert.deepEqual(externalControl.externalControl.map(d=>({code:d.code,file:d.file})),[{code:2304,file:join(external,'index.d.ts')}]);packageContext(externalControl);report.externalControl=externalControl;
  const noAmbient=validator('negative-ambient',[],false),ambientControl=await api('missing-ambient','declarations-negative',{config:noAmbient,owned,seals,projectConfigs,projectSeals},'expected-native-refusal');assert.notEqual(ambientControl.result.code,0);assert(ambientControl.value);assert.deepEqual(ambientControl.value.optionsGlobalSyntax,[]);assert.deepEqual(ambientControl.value.ownedSemantic.map(d=>({code:d.code,file:d.file})),[{code:2304,file:join(configs.emitted,'producer/index.d.ts')}],'Exact actual owned global-context loss refusal required');report.controls.push({kind:'ambient-loss',status:'expected-native-refusal',result:ambientControl.value});
  // Same EXACT five historical refusal expressions, against miniature fixture
  // APIs only. Real application contracts remain a separate mandatory gate.
  const positive=readFileSync(join(source,'consumer/index.ts'),'utf8'),negative=positive+'\n'+NEGATIVE_CONTRACTS.map(row=>row.line).join('\n')+'\n',negativePath=join(source,'consumer/negative.ts');writeFileSync(negativePath,negative,{flag:'wx',mode:0o600});report.negativeSource=regularHash(negativePath);
  const apiConfig=(name,files,references=[])=>{active();const path=join(out,name+'.json');writeFileSync(path,JSON.stringify({extends:join(source,'base.json'),files,include:[],references,compilerOptions:{...NATIVE_REFERENCE_OVERRIDES,rootDir:source,outDir:join(out,name+'-emitted'),tsBuildInfoFile:join(out,name+'.tsbuildinfo')}},null,2)+'\n',{flag:'wx',mode:0o600});assertNativeParsedConfig(parsedConfig(owner.ts,path),files);return path;};
  const sourceNegative=apiConfig('negative-source',[ambient,join(source,'producer/index.ts'),join(source,'producer/math.js'),join(source,'producer/labels.json'),negativePath]);
  const declarationNegative=apiConfig('negative-native-api',[ambient,negativePath],[{path:configs.projects[0].config}]);
  for(const[label,config]of [['source-api-negative',sourceNegative],['emitted-api-negative',declarationNegative]]){const result=await run(label,cli(config),'expected-native-refusal');assert.notEqual(result.code,0);assert.deepEqual(diagnosticCodes(result.text),NEGATIVE_CONTRACTS.map(row=>row.code));const actual=[...result.text.matchAll(/^(.+)\(([0-9]+),[0-9]+\): error TS([0-9]+):/gm)].map(match=>({file:resolve(cwd,match[1]),line:Number(match[2]),code:Number(match[3])}));assert.deepEqual(actual,NEGATIVE_CONTRACTS.map(row=>({file:negativePath,line:negative.slice(0,negative.indexOf(row.line)).split('\n').length,code:row.code})),'Expected native refusals must belong to all exact expression/source lines');report.controls.push({kind:label,status:'expected-native-refusal',rawCode:result.code,codes:diagnosticCodes(result.text)});}
  const invalid=join(configs.emitted,'producer/__owned_invalid.d.ts');writeFileSync(invalid,'export type InvalidOwned = CompilerReferenceMissingOwned;\n',{flag:'wx',mode:0o600});const invalidSeal=regularHash(invalid);report.negativeOwned=invalidSeal;const invalidConfig=validator('negative-owned',[invalid]);
  const sentinel=await api('owned-unresolved-sentinel','declarations-negative',{config:invalidConfig,owned,seals:[...seals,invalidSeal],projectConfigs,projectSeals,negativeOwned:invalid},'expected-native-refusal');assert.notEqual(sentinel.result.code,0);assert(sentinel.value);assert.deepEqual(sentinel.value.optionsGlobalSyntax,[]);assert.deepEqual(sentinel.value.ownedSemantic.map(d=>({code:d.code,file:d.file})),[{code:2304,file:invalid}]);report.controls.push({kind:'owned-unresolved-sentinel',status:'expected-native-refusal',result:sentinel.value});
  // Real disk custody negatives; neither may be consumed by any compiler.
  const first=seals.find(row=>/\.d\.ts$/.test(row.path)),original=readFileSync(first.path);try{writeFileSync(first.path,Buffer.concat([original,Buffer.from('\n// stale custody control\n')]));assert.throws(()=>assertOutputSeal(seals));}finally{writeFileSync(first.path,original);}assertOutputSeal(seals);report.controls.push({kind:'stale-declaration',status:'expected-custody-refusal'});
  const configOriginal=readFileSync(configs.projects[1].config);try{writeFileSync(configs.projects[1].config,JSON.stringify({...JSON.parse(configOriginal),references:[{path:join(out,'foreign-project.json')}]}));assert.throws(()=>assertOutputSeal(configSeals));}finally{writeFileSync(configs.projects[1].config,configOriginal);}assertOutputSeal(configSeals);report.controls.push({kind:'foreign-reference-config',status:'expected-custody-refusal'});
  for(const[role,path,ownedSeals]of [['original-source',sourceJson,input],['native-emitted-mirror',json,seals]]){const original=readFileSync(path);try{writeFileSync(path,Buffer.from('{"title":"changed native JSON context"}\n'));assert.throws(()=>assertOutputSeal(ownedSeals),'Changed JSON custody must refuse before another compiler phase');}finally{writeFileSync(path,original);}assertOutputSeal(ownedSeals);report.controls.push({kind:'changed-json-'+role,status:'expected-custody-refusal'});}
  for(const name of ['package.json','index.d.ts']){const path=join(external,name),original=readFileSync(path);try{writeFileSync(path,Buffer.concat([original,Buffer.from('\n// changed owned package custody\n')]));assert.throws(()=>assertOutputSeal(input),'Changed shared package input must refuse');}finally{writeFileSync(path,original);}assertOutputSeal(input);report.controls.push({kind:'changed-shared-package-'+name,status:'expected-custody-refusal'});}
  const collisionFiles=[{id:'collision.ts',kind:'implementation',sha256:'1'.repeat(64)},{id:'collision.tsx',kind:'implementation',sha256:'2'.repeat(64)}];assert.throws(()=>outputOwnership({projects:[{index:0,owned:collisionFiles.map(f=>f.id),context:[]}]},collisionFiles));report.controls.push({kind:'duplicate-output-writer',status:'expected-planner-refusal'});
  assert.deepEqual(report.phases.map(p=>p.label),PLANNED_PHASES);
  assertOutputSeal(input);assertOutputSeal(seals);assertOutputSeal(configSeals);assert.equal(JSON.stringify(readCompilerReferenceClock(admitCompilerReference('fixture'))),JSON.stringify(clock));assert(performance.now()<=deadline);report.artifactBudget=assertArtifactBudget(out);report.complete=true;
 }catch(error){primary=error;report.failure={name:error.name,message:error.message};report.blocked=PLANNED_PHASES.filter(label=>!report.phases.some(p=>p.label===label)).map(label=>({label,status:'blocked',reason:performance.now()>=deadline-2000?'aggregate-budget':'failed-fixture-prerequisite-or-control'}));throw error;}finally{try{save();}catch(error){if(primary)throw new AggregateError([primary,error],'Native fixture and partial report both refused');throw error;}}
 return report;
 }catch(error){primary=error;throw error;}
 finally{
  if(activeNative&&!controller.signal.aborted)controller.abort(Error('Native fixture settlement required'));
  try{await activeNative;}catch(error){if(primary&&primary!==error)throw new AggregateError([primary,error],'Native fixture and process settlement both refused');throw error;}
  finally{if(deadlineTimer)clearTimeout(deadlineTimer);process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);}
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  assert.equal(process.argv.length,2);
  const {protectedDockerCanary}=await import('./protected-docker-canary.mjs');
  await protectedDockerCanary();
 }catch{
  process.exitCode=1;
 }
}
