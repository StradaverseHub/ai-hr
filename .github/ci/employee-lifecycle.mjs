/** Normal-only private lifecycle owner. Inert until root operational hooks register
 * the actual complete unit, first-step anchor, native prerequisites and stop owner.
 * No caller context/JSON can manufacture the opaque live owner returned here. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {realpathSync,readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan} from './plan.mjs';
import {validatePostgresEvidence,postgresProfileFromEnv} from './postgres-evidence.mjs';
import {actualSingletonHost} from './singleton-profiles.mjs';
import {validateSingletonBinding,singletonSources,singletonSourceMaximum} from './singleton-protocol.mjs';
import {EMPLOYEE_LIFECYCLE_PROFILE_SHA256,employeeLifecycleFile,employeeLifecycleNormalBudget,employeeLifecycleFrontier,validateEmployeeLifecycleTestResult} from './employee-lifecycle-profile.mjs';
import {employeeLifecycleRead,employeeLifecycleHash,employeeLifecycleProcess,assertEmployeeLifecycleAnchor,assertEmployeeLifecycleParent,EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES} from './employee-lifecycle-context.mjs';
const owners=new WeakMap(),here=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),supervisor=join(here,'.github/ci/employee-lifecycle-supervisor.py');

const hashes=()=>Object.fromEntries(EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES.map(path=>[path,employeeLifecycleHash(employeeLifecycleRead(join(here,path),1048576,false))]));
function live(owner){const state=owners.get(owner);assert(state,'Foreign lifecycle owner');return state;}
function elapsed(state){return assertEmployeeLifecycleAnchor(state.anchor,state.identity,process.hrtime.bigint(),readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim());}
function publish(path,value){writeFileSync(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});}
export function prepareEmployeeLifecycle(file){
 const profile=employeeLifecycleFile(file),env=process.env;assert(profile,'Unknown closed employee lifecycle file');assert.equal(process.platform,'linux');assert.equal(env.GITHUB_WORKFLOW,'alpha-staging-ci');assert.equal(env.GITHUB_JOB,'test');assert.equal(env.GITHUB_RUN_ATTEMPT,'1');assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');assert(!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')||key.startsWith('AIHR_EMPLOYEE_LIFECYCLE_')),'Inherited/mixed lifecycle intent');
 const temp=realpathSync(env.RUNNER_TEMP),directory=join(temp,'aihr-ci');assert.equal(realpathSync(directory),directory);const [unitId,destination]=process.argv.slice(2);assert.equal(process.argv.length,4);assert(/^db-[0-9a-f]{16}(?![\s\S])/.test(unitId));for(const key of ['AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD'])assert(/^[0-9a-f]{40}(?![\s\S])/.test(env[key]??''));assert(/^[1-9][0-9]{0,19}(?![\s\S])/.test(env.GITHUB_RUN_ID??''));assert.equal(destination,directory);assert.equal(realpathSync(process.argv[1]),join(here,'.github/ci/run-unit.mjs'));
 const identity={run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,unit:unitId,source:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD};
 const anchorPath=join(directory,`${unitId}-employee-job-anchor.json`);assert.equal(env.AIHR_EMPLOYEE_JOB_ANCHOR,anchorPath);const anchor=JSON.parse(employeeLifecycleRead(anchorPath,16384));assertEmployeeLifecycleAnchor(anchor,identity,process.hrtime.bigint(),readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim());
 // Existing actual owner reconstructs ALL plan/host/source checks before SQL.
 const plan=createPlan(),unit=plan.units.find(row=>row.id===unitId);assert(unit);assert.deepEqual(unit.files,[file]);assert.equal(unit.kind,'db');assert.equal(unit.singleton?.profile,'controlled-database-v1');const layout=actualSingletonHost(plan,unit,directory);assert.equal(layout.automation,here);
 const parent=employeeLifecycleProcess(process.pid);assert.equal(parent.exe,realpathSync(process.execPath));assert.deepEqual(parent.argv,[process.execPath,join(here,'.github/ci/run-unit.mjs'),unitId,directory]);
 const privateRoot=join(temp,'aihr-employee-private');try{mkdirSync(privateRoot,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}const privateStat=lstatSync(privateRoot);assert(privateStat.isDirectory()&&!privateStat.isSymbolicLink()&&privateStat.uid===process.getuid()&&(privateStat.mode&0o077)===0&&realpathSync(privateRoot)===privateRoot);
 const privateDirectory=join(privateRoot,unitId);mkdirSync(privateDirectory,{mode:0o700});assert.equal(realpathSync(privateDirectory),privateDirectory);
 const resourceNonce=randomBytes(32).toString('hex'),resourceContext=join(privateDirectory,'resource.json');
 const privateResource={version:1,kind:'EMPLOYEE_NORMAL_CI_RESOURCE_CUSTODY',mode:'full-ci-singleton',...identity,file,fingerprint:plan.fingerprint,registrySha256:EMPLOYEE_LIFECYCLE_PROFILE_SHA256,sourceRoot:layout.source,automation:here,evidenceDirectory:directory,anchorPath,anchorSha256:employeeLifecycleHash(employeeLifecycleRead(anchorPath,16384)),parent,expectedPostgres:plan.execution.postgres,resourceNonce,createdMonotonicNs:String(process.hrtime.bigint())};publish(resourceContext,privateResource);
 const preparation={version:1,mode:'full-ci-singleton',...identity,file,stage:profile.stage,fingerprint:plan.fingerprint,registrySha256:EMPLOYEE_LIFECYCLE_PROFILE_SHA256,sourceRoot:layout.source,automation:here,evidenceDirectory:directory,anchorPath,parent,resourceContextSha256:employeeLifecycleHash(employeeLifecycleRead(resourceContext,65536)),resourceNonceSha256:employeeLifecycleHash(resourceNonce),controllerSources:hashes(),releaseAuthorized:false};
 const path=join(directory,`${unitId}-employee-preparation.json`);publish(path,preparation);const owner=Object.freeze({});const state={profile,identity,anchor,plan,unit,layout,preparation,path,directory,resourceContext,poisoned:false,testContext:undefined,sequence:0,closed:false,closeFailure:undefined,reports:[],frontier:employeeLifecycleFrontier(file)};owners.set(owner,state);elapsed(state);return owner;
}
export function employeeLifecycleResourceEnvironment(owner){const state=live(owner);assert.equal(employeeLifecycleHash(employeeLifecycleRead(state.resourceContext,65536)),state.preparation.resourceContextSha256);return Object.freeze({AIHR_EMPLOYEE_RESOURCE_CONTEXT:state.resourceContext});}
export function authorizeEmployeeLifecycleTest(owner,bindingPath){
 const state=live(owner);try{state.frontier.authorize();assert(!state.closed&&!state.poisoned&&!state.testContext);const layout=actualSingletonHost(state.plan,state.unit,state.directory);assert.equal(layout.source,state.layout.source);assert.deepEqual(hashes(),state.preparation.controllerSources);assertEmployeeLifecycleParent(employeeLifecycleProcess(process.pid),state.preparation.parent);
 const expected=join(state.directory,`${state.unit.id}-singleton.json`);assert.equal(bindingPath,expected);const bindingBytes=employeeLifecycleRead(expected,1048576),binding=JSON.parse(bindingBytes);validateSingletonBinding(binding,state.plan,state.unit,{runId:state.identity.run,attempt:state.identity.attempt},layout.source);
 for(const path of singletonSources(state.unit,layout.source))assert.equal(employeeLifecycleHash(employeeLifecycleRead(join(state.layout.source,path),singletonSourceMaximum(path),false)),binding.sourceHashes[path]);
 employeeLifecycleNormalBudget(state.profile.stage,elapsed(state));
 const context={...state.preparation,preparationSha256:employeeLifecycleHash(employeeLifecycleRead(state.path,65536)),singletonPath:expected,singletonSha256:employeeLifecycleHash(bindingBytes)};
 const path=join(state.directory,`${state.unit.id}-employee-test-context.json`);publish(path,context);state.testContext=path;return Object.freeze({AIHR_EMPLOYEE_LIFECYCLE_CONTEXT:path});
 }catch(error){state.poisoned=true;state.frontier.record('authorization',false);throw error;}
}
/** Fixed opcodes only. Caller environment may carry the actual role handshake,
 * but cannot alter any run/source/unit/anchor/native stage identity. */
export function runEmployeeLifecycleStage(owner,stage,environment=process.env){
 const state=live(owner);try{state.frontier.admit(stage);const test=stage===state.profile.stage,observations=['git-head','git-status','git-tracked','controller-head','controller-status','evidence','classifier','stats','stop'];assert(test||['reset','migrate',...observations].includes(stage),'Unknown/cross-file lifecycle stage');assert(!state.closed||stage==='stop');
 if(!['reset','stats','stop'].includes(stage))assert(!Object.hasOwn(environment,'AIHR_EMPLOYEE_RESOURCE_CONTEXT'),'Private resource context cannot enter application stages');
 if(!observations.includes(stage))assert(!state.poisoned,'Poisoned lifecycle forbids later SQL');if(test)assert(state.testContext,'Actual singleton prerequisites not yet admitted');
 for(const key of ['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_WORKFLOW','GITHUB_JOB','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD','GITHUB_WORKSPACE','RUNNER_TEMP','AIHR_EMPLOYEE_JOB_ANCHOR','PATH','NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME','LD_PRELOAD','LD_LIBRARY_PATH','DOCKER_HOST','DOCKER_CONTEXT','HOME'])assert.equal(environment[key],process.env[key]);assert(!Object.keys(environment).some(key=>key.startsWith('AIHR_FOCUSED_')));
 assertEmployeeLifecycleParent(employeeLifecycleProcess(process.pid),state.preparation.parent);assert.deepEqual(hashes(),state.preparation.controllerSources);const seconds=employeeLifecycleNormalBudget(stage,elapsed(state)),sequence=++state.sequence;
 const request={stage,file:state.profile.file,node:realpathSync(process.execPath),controller:here,destination:state.directory,preparation:state.path,testContext:test?state.testContext:null,sequence};
 const child=spawnSync('/usr/bin/python3',['-I','-B',supervisor,JSON.stringify(request)],{cwd:state.layout.source,env:{...environment,...(['reset','stats','stop'].includes(stage)?employeeLifecycleResourceEnvironment(owner):{}),...(test?{AIHR_EMPLOYEE_LIFECYCLE_CONTEXT:state.testContext}:{})},encoding:'utf8',maxBuffer:16*1024*1024,timeout:Math.ceil((seconds+6)*1000),killSignal:'SIGTERM'});
 // Python owns actual pidfd/session teardown. A wrapper timeout is uncertainty,
 // never proof that its native descendants/backend have settled.
 let proof,qualified=true;try{proof=JSON.parse(employeeLifecycleRead(join(state.directory,`${state.unit.id}-employee-stage-${sequence}.json`),16384));assert.deepEqual(Object.keys(proof).sort(),['source','controller','run','attempt','unit','file','fingerprint','mode','releaseAuthorized','stage','sequence','version','result'].sort());for(const key of ['source','controller','run','attempt','unit','file','fingerprint'])assert.equal(proof[key],state.preparation[key]);assert.equal(proof.mode,'full-ci-singleton');assert.equal(proof.releaseAuthorized,false);assert.equal(proof.version,1);assert.equal(proof.stage,stage);assert.equal(proof.sequence,sequence);assert.deepEqual(Object.keys(proof.result).sort(),['reason','commandExit','admitted','reaped','groupQuiescent','escapedSession','releaseAuthorized'].sort());assert.equal(proof.result.releaseAuthorized,false);assert.equal(proof.result.reason,'complete');assert.equal(proof.result.commandExit,0);assert.equal(proof.result.admitted,true);assert.equal(proof.result.reaped,true);assert.equal(proof.result.groupQuiescent,true);assert.equal(proof.result.escapedSession,false);}catch{qualified=false;state.poisoned=true;}
 if(child.error||child.signal||child.status!==0)state.poisoned=true;
 const passed=qualified&&!child.error&&!child.signal&&child.status===0;state.frontier.record(stage,passed);
 let resourceEvidence=null;if(stage==='evidence'&&passed){try{const value=JSON.parse(child.stdout);validatePostgresEvidence(value,{postgres:postgresProfileFromEnv(environment)});const filename=`${state.unit.id}-employee-resource-${sequence}.json`,bytes=JSON.stringify(value)+'\n';writeFileSync(join(state.directory,filename),bytes,{flag:'wx',mode:0o600});resourceEvidence={filename,sha256:employeeLifecycleHash(bytes)};}catch{state.poisoned=true;state.frontier.record(stage,false);qualified=false;}}
 state.reports.push({stage,sequence,resourceEvidence,filename:`${state.unit.id}-employee-stage-${sequence}.json`,sha256:proof?employeeLifecycleHash(employeeLifecycleRead(join(state.directory,`${state.unit.id}-employee-stage-${sequence}.json`),16384)):null,exit:child.status,signal:child.signal,settled:!!proof&&proof.result?.groupQuiescent===true,complete:qualified&&!!proof&&proof.result?.reason==='complete'&&!child.error&&!child.signal&&child.status===0});
 return !qualified&&child.status===0?{...child,status:1}:child;
 }catch(error){state.poisoned=true;state.frontier.record(stage,false);throw error;}
}
export function closeEmployeeLifecycle(owner){
 const state=live(owner);if(state.closed){if(state.closeFailure)throw state.closeFailure;return state.terminal;}state.closed=true;state.frontier.close();
 const errors=[],failures=[];const attempt=(kind,work)=>{try{return work();}catch(error){errors.push(error);failures.push(kind);return null;}};
 // NOTHING that reads/writes the terminal report may precede this mandatory stop.
 const stop=attempt('mandatory-stop',()=>{const result=runEmployeeLifecycleStage(owner,'stop');assert(!result.error&&!result.signal&&result.status===0,'Mandatory lifecycle stop uncertain');return true;});
 const member=(filename,maximum,privateFile=true)=>{const bytes=employeeLifecycleRead(join(state.directory,filename),maximum,privateFile);return {filename,sha256:employeeLifecycleHash(bytes)};};
 const anchor=attempt('anchor',()=>({...member(`${state.unit.id}-employee-job-anchor.json`,16384),value:state.anchor}));
 const preparation=attempt('preparation',()=>member(`${state.unit.id}-employee-preparation.json`,65536));
 const singleton=state.testContext?attempt('singleton',()=>member(`${state.unit.id}-singleton.json`,1048576)):null;
 const testContext=state.testContext?attempt('test-context',()=>member(`${state.unit.id}-employee-test-context.json`,65536)):null;
 const monitor=state.testContext?attempt('monitor',()=>{const record=member(`${state.unit.id}-employee-monitor.json`,16384);return {...record,value:JSON.parse(employeeLifecycleRead(join(state.directory,record.filename),16384))};}):null;
 const supervisorLog=attempt('supervisor-log',()=>member(`${state.unit.id}-employee-supervisor.jsonl`,1048576));
 const testResult=state.testContext?attempt('test-result',()=>{const record=member(`${state.unit.id}-batch-0.json`,16*1024*1024,false),value=JSON.parse(employeeLifecycleRead(join(state.directory,record.filename),16*1024*1024,false));return {...record,passedCases:validateEmployeeLifecycleTestResult(value,state.profile.file,state.layout.source)};}):null;
 const fileClock=state.profile.clockDirectory&&state.testContext?attempt('file-clock',()=>{const clock=member(state.profile.clockDirectory+'/benchmark-clock.json',512),ack=member(state.profile.clockDirectory+'/benchmark-clock-ack.json',512);assert.equal(clock.sha256,ack.sha256);return {clock,ack,requiredSeconds:900};}):null;
 const testIndex=state.reports.findIndex(row=>row.stage===state.profile.stage),preStopResource=state.reports.findLast((row,index)=>index>testIndex&&testIndex>=0&&row.stage==='evidence'&&row.complete&&row.resourceEvidence)?.resourceEvidence??null;
 const containerCustody=attempt('container-custody',()=>{
  const records=Object.fromEntries(['created','started','observed','stopped','stats'].map(kind=>{const name=`${state.unit.id}-employee-container-${kind}.json`;return[kind,{...member(name,16384),value:JSON.parse(employeeLifecycleRead(join(state.directory,name),16384))}];}));
  const created=records.created.value,started=records.started.value,observed=records.observed.value,stopped=records.stopped.value;
  for(const value of [created,started,observed,stopped]){
   for(const key of ['source','controller','run','attempt','unit','file','fingerprint','registrySha256','resourceContextSha256','resourceNonceSha256'])assert.equal(value[key],state.preparation[key]);
   assert.equal(value.version,1);assert.equal(value.mode,'full-ci-singleton');assert.equal(value.releaseAuthorized,false);
  }
  for(const value of [started,observed,stopped])for(const key of ['cid','imageId','created','volume'])assert.equal(value[key],created[key]);
  assert(/^[0-9a-f]{64}$/.test(created.cid)&&/^[0-9a-f]{64}$/.test(created.volume)&&/^sha256:[0-9a-f]{64}$/.test(created.imageId));
  assert(Number.isSafeInteger(started.pid)&&started.pid>1&&typeof started.startedAt==='string');
  assert.equal(observed.pid,started.pid);assert.equal(observed.startedAt,started.startedAt);assert.equal(observed.complete,true);assert.equal(observed.sampledBirthUnchanged,true);
  assert.deepEqual(observed.native,{running:true,restarting:false,dead:false,oomKilled:false,errorEmpty:true});
  assert.deepEqual(observed.snapshot,{filename:records.stats.filename,sha256:records.stats.sha256});
  assert.equal(stopped.complete,true);assert.equal(stopped.createdResource,true);assert.equal(stopped.reconciledLostCreateReply,false);
  for(const key of ['containerAbsent','nameAbsent','volumeAbsent'])assert.equal(stopped[key],true);
  return Object.fromEntries(Object.entries(records).map(([key,{value,...record}])=>[key,record]));
 });
 const complete=errors.length===0&&stop===true&&containerCustody!==null&&!state.poisoned&&testResult?.passedCases===state.profile.cases&&monitor!==null&&preStopResource!==null&&(!state.profile.clockDirectory||fileClock!==null)&&['reset','migrate',state.profile.stage].every(stage=>state.reports.some(row=>row.stage===stage&&row.complete));
 const proof={version:1,mode:'full-ci-singleton',...state.identity,file:state.profile.file,fingerprint:state.plan.fingerprint,registrySha256:EMPLOYEE_LIFECYCLE_PROFILE_SHA256,resourceContextSha256:state.preparation.resourceContextSha256,resourceNonceSha256:state.preparation.resourceNonceSha256,releaseAuthorized:false,complete,scope:'Owned lifecycle and actual fixed-stage results; no inferred semantic restoration or release authority',expectedCases:state.profile.cases,expectedPlanPhases:state.profile.planPhases,expectedCallPairs:state.profile.callPairs,anchor,preparation,singleton,testContext,monitor,fileClock,supervisorLog,testResult,preStopResource,containerCustody,mandatoryStopCompleted:stop===true,poisoned:state.poisoned,actualStageOutcomes:state.reports,failures};
 const path=join(state.directory,`${state.unit.id}-employee-lifecycle.json`);attempt('terminal-publication',()=>publish(path,proof));state.terminal=Object.freeze({proof,path,complete});
 if(errors.length){state.closeFailure=new AggregateError(errors,'Owned lifecycle stop or terminal evidence refused');throw state.closeFailure;}return state.terminal;
}
