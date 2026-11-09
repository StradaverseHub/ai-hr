/** Lifetime helpers for the fixed development driver. Native handles stay with that driver. */
import {performance} from 'node:perf_hooks';
import {createGunzip} from 'node:zlib';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

const knownCodes=new Set(['ERR_ASSERTION','ABORT_ERR','ECONNRESET','ETIMEDOUT','EPIPE','ERR_STREAM_PREMATURE_CLOSE',
 'Z_DATA_ERROR','Z_BUF_ERROR','57014','55P03','53300','08006','42501','23514','25P02','57P01']);
const knownNames=new Set(['Error','AssertionError','TimeoutError','AbortError','TypeError','AggregateError']);

export function driverErrorFact(reason){
 try{
  const {name,code}=reason??{};
  return {kind:knownNames.has(name)?name:'unclassified',code:knownCodes.has(code)?code:null};
 }catch{return {kind:'unclassified',code:null};}
}

export function createDriverFailures(){
 let primary={failed:false,reason:undefined};
 let signalFailure;
 const whenFailed=new Promise(resolve=>{signalFailure=resolve;});
 const secondary=[];
 const record=(stage,reason)=>{
  secondary.push({stage,reason});
  signalFailure();
  return {state:'failed',reason};
 };
 return {
  primary:()=>primary,
  whenFailed,
  notePrimary(reason){if(!primary.failed){primary={failed:true,reason};signalFailure();}},
  record,
  async attempt(stage,work){try{return {state:'settled',value:await work()};}catch(reason){return record(stage,reason);}},
  evidence(work){try{return {state:'settled',value:work()};}catch(reason){return record('evidence',reason);}},
  failed:()=>primary.failed||secondary.length>0,
  resourceFailed:()=>secondary.length>0,
  privateFailures:()=>({primary,secondary}),
  publicFailures:()=>({primary:primary.failed?driverErrorFact(primary.reason):null,
   secondary:secondary.map(({stage,reason})=>({stage,...driverErrorFact(reason)}))}),
 };
}

export function acquireDriverResource(states,name,make){
 try{const handle=make();states[name]='acquired';return handle;}
 catch(reason){states[name]='failed';throw reason;}
}

export function settleDriverResources(failures,{browser,https,database}){
 return Promise.all([
  failures.attempt('browser-settlement',browser),
  failures.attempt('https-settlement',https),
  failures.attempt('database-settlement',database),
 ]);
}

/** Register before a launch callback can start. Draining owns the real promises. */
export function createDriverWork(){
 const pending=new Set();
 let open=true;
 return {
  run(work){
   if(!open)throw Error('Driver work admission is closed');
   let resolve,reject;
   const running=new Promise((yes,no)=>{resolve=yes;reject=no;});
   pending.add(running);
   const settled=()=>pending.delete(running);
   void running.then(settled,settled);
   try{void Promise.resolve(work()).then(resolve,reject);}catch(reason){reject(reason);}
   return running;
  },
  seal(){open=false;},
  async drain(){while(pending.size)await Promise.allSettled([...pending]);},
 };
}

/** Preserve temporal failure order when replacing an early fail-fast join. */
export async function settleDriverLanes(values,run,failures){
 const results=await Promise.allSettled(values.map(async value=>{
  try{return await run(value);}catch(reason){failures.notePrimary(reason);throw reason;}
 }));
 if(results.some(result=>result.status==='rejected'))throw failures.primary().reason;
 return results;
}

export async function drainDriverLanes(lanes,requests){
 lanes.seal();
 await lanes.drain();
 requests.seal();
}

export function startDriverInterval(interval,run,recordFailure){
 let pending,stopped=false;
 const timer=setInterval(()=>{
  if(stopped||pending)return;
  pending=Promise.resolve().then(run).catch(recordFailure).finally(()=>{pending=undefined;});
 },interval);
 return {stop(){stopped=true;clearInterval(timer);return pending??Promise.resolve();}};
}

// The external 250ms cadence target and actual 500ms bound stay unchanged.
// A 600s measured preflight admits at most 2,800 fast + 1,250 standard starts.
export const MEASURED_PREFLIGHT_LOCK_ATTEMPT_MS=200;
const preflightFastAttemptMs=125,preflightFastStarts=2800;
export const measuredPreflightLockAttemptMs=started=>started<preflightFastStarts?preflightFastAttemptMs:MEASURED_PREFLIGHT_LOCK_ATTEMPT_MS;

/** One real probe at a time. After an overrun, use the next available timer turn. */
export function startMeasuredLockInterval(interval,run,recordFailure,now=()=>performance.now()){
 let timer,pending,stopped=false,starts=0;
 function schedule(after){
  if(stopped)return;
  const attemptIntervalMs=typeof interval==='function'?interval(starts):interval;
  const due=after+attemptIntervalMs;
  function arm(){timer=setTimeout(fire,Math.max(0,Math.ceil(due-now())));}
  function fire(){
   if(stopped)return;
   const started=now();
   if(started<due){arm();return;}
   starts++;
   pending=Promise.resolve().then(()=>run({dueMs:due,timerStartedMs:started,attemptIntervalMs})).catch(recordFailure).finally(()=>{
    pending=undefined;
    schedule(started);
   });
  }
  arm();
 }
 schedule(now());
 return {stop(){stopped=true;clearTimeout(timer);return pending??Promise.resolve();}};
}

export function lockSampleEvidence(samples,window){
 const completed=samples.filter(sample=>sample.state==='complete');
 const qualified=window?completed.filter(sample=>sample.startedMs>=window.startMs&&sample.completedMs<=window.endMs):[];
 const failures=samples.length-completed.length;
 const observed=completed.filter(sample=>Number.isSafeInteger(sample.blockingAppSessions)&&sample.blockingAppSessions>=0);
 const invalidBlockingCounts=completed.length-observed.length;
 const blockingSamples=observed.filter(sample=>sample.blockingAppSessions>0).length;
 const coveragePass=qualified.length>0&&failures===0&&invalidBlockingCounts===0;
 return {window:window??null,completed:completed.length,qualified:qualified.length,failures,
  validEmpty:qualified.filter(sample=>sample.locks===0&&sample.blockingAppSessions===0).length,
  invalidBlockingCounts,blockingSamples,coveragePass,pass:coveragePass&&blockingSamples===0,samples};
}

const lockCadenceMs=Object.freeze({preflight:250,loaded:1000});
const maxProtectedLockSamples=4096;
const lockCount=value=>Number.isSafeInteger(value)&&value>=0;

/** Private timing context for the widest observed preflight gap. Round trips
 * include the client and event-loop continuation. Never supplies coverage facts. */
export function measuredPreflightLockTiming(samples,window){
 const {startMs,endMs}=window??{};
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs||!Array.isArray(samples)||samples.length>maxProtectedLockSamples)return null;
 let first,previous,widest;
 for(const row of samples){
  if(row?.state!=='complete'||!Number.isFinite(row.startedMs)||!Number.isFinite(row.completedMs)
   ||row.startedMs<startMs||row.completedMs<row.startedMs||row.completedMs>endMs)continue;
  first??=row;
  if(previous){
   if(row.startedMs<=previous.startedMs||row.startedMs<previous.completedMs)return null;
   const gapUs=Math.ceil((row.completedMs-startMs)*1000)-Math.floor((previous.startedMs-startMs)*1000);
   if(!widest||gapUs>widest.gapUs)widest={previous,row,gapUs};
  }
  previous=row;
 }
 if(!widest)return null;
 const {row,gapUs}=widest;
 const {dueMs,timerStartedMs,startedMs,activityCompletedMs,advisoryStartedMs,completedMs,attemptIntervalMs}=row;
 if(attemptIntervalMs!==preflightFastAttemptMs&&attemptIntervalMs!==MEASURED_PREFLIGHT_LOCK_ATTEMPT_MS)return null;
 const readyMs=Math.max(dueMs,widest.previous.completedMs);
 const points=[readyMs,timerStartedMs,startedMs,activityCompletedMs,advisoryStartedMs,completedMs];
 if(points.some((point,index)=>!Number.isFinite(point)||index>0&&point<points[index-1]))return null;
 const elapsed=(from,to)=>Math.ceil((to-from)*1000);
 return {attemptIntervalMs,gapUs,openingGapUs:elapsed(startMs,first.completedMs),
  tailGapUs:elapsed(startMs,endMs)-Math.floor((previous.startedMs-startMs)*1000),
  launchSpacingUs:elapsed(widest.previous.startedMs,startedMs),serialWaitPastDueUs:elapsed(dueMs,readyMs),
  timerAfterReadyUs:elapsed(readyMs,timerStartedMs),
  callbackToProbeUs:elapsed(timerStartedMs,startedMs),activityRoundTripUs:elapsed(startedMs,activityCompletedMs),
  betweenProbesUs:elapsed(activityCompletedMs,advisoryStartedMs),advisoryRoundTripUs:elapsed(advisoryStartedMs,completedMs)};
}

/** Qualify a closed work window from serial legacy query rows. Cadence bounds
 * sampled observations. Skipped timer ticks and waits between queries are unmeasured. */
export function qualifyLockSampleCadence(phase,samples,window){
 const intervalMs=typeof phase==='string'&&Object.hasOwn(lockCadenceMs,phase)?lockCadenceMs[phase]:null;
 const maxGapUs=intervalMs===null?null:intervalMs*2000;
 const {startMs,endMs}=window??{};
 const time=value=>Number.isFinite(value)&&value>=0;
 const unknown={phase:intervalMs===null?null:phase,intervalMs,maxGapUs,state:'unknown',coveragePass:false,pass:false,blockingSamples:null,
  observedBlockingSamples:null,qualifiedSamples:null,openingGapUs:null,interiorGapUs:null,tailGapUs:null};
 if(intervalMs===null||!time(startMs)||!time(endMs)||endMs<=startMs)
  return {...unknown,reason:'window-unknown'};
 const durationUs=Math.ceil((endMs-startMs)*1000);
 if(!Number.isSafeInteger(durationUs))
  return {...unknown,reason:'window-unknown'};
 if(!Array.isArray(samples)||samples.length>maxProtectedLockSamples)
  return {...unknown,reason:'samples-unknown'};

 let previousStartMs=-1,previousEndMs=-1,previousStartUs=null;
 let observedBlockingSamples=0,qualifiedSamples=0,openingGapUs=null,interiorGapUs=null,problem=null;
 for(const row of samples){
  if(row?.state!=='complete'){
   problem??=row?.state==='failed'?'sample-failed':'sample-unknown';
   continue;
  }
  const {startedMs,completedMs,locks,blockingAppSessions}=row;
  if(!time(startedMs)||!time(completedMs)||completedMs<startedMs||!lockCount(locks)||!lockCount(blockingAppSessions)){
   problem??='sample-unknown';
   continue;
  }
  if(blockingAppSessions>0)observedBlockingSamples++;
  if(startedMs<=previousStartMs||startedMs<previousEndMs)problem??='sample-order';
  previousStartMs=startedMs;
  previousEndMs=completedMs;
  if(startedMs<startMs||completedMs>endMs)continue;

  // The server observation may occur anywhere inside the query. Round outward.
  const startedUs=Math.floor((startedMs-startMs)*1000);
  const completedUs=Math.ceil((completedMs-startMs)*1000);
  if(previousStartUs===null)openingGapUs=completedUs;
  else interiorGapUs=Math.max(interiorGapUs??0,completedUs-previousStartUs);
  previousStartUs=startedUs;
  qualifiedSamples++;
 }
 if(problem!==null)return {...unknown,reason:problem,observedBlockingSamples};

 const tailGapUs=previousStartUs===null?null:durationUs-previousStartUs;
 const facts={...unknown,observedBlockingSamples,qualifiedSamples,openingGapUs,interiorGapUs,tailGapUs};
 if(Math.max(openingGapUs??0,interiorGapUs??0,tailGapUs??0)>maxGapUs)
  return {...facts,state:'missed',reason:'coverage-gap'};
 if(interiorGapUs===null)return {...facts,reason:'cadence-unobserved'};

 // Keep the legacy veto for a known blocking observation anywhere in the sampler.
 return {...facts,state:'complete',reason:observedBlockingSamples===0?null:'blocking-observed',
  coveragePass:true,pass:observedBlockingSamples===0,blockingSamples:observedBlockingSamples};
}

// Development only. A drained, completed work window is required before an observed zero can qualify.
export function developmentLockWindowEvidence(phase,samples,window,closed){
 const evidence=qualifyLockSampleCadence(phase,samples,window);
 const observed=(Array.isArray(samples)?samples.slice(0,maxProtectedLockSamples+1):[]).filter(row=>row?.state==='complete'
  &&Number.isFinite(row.startedMs)&&row.startedMs>=0&&Number.isFinite(row.completedMs)&&row.completedMs>=row.startedMs
  &&lockCount(row.locks)&&lockCount(row.blockingAppSessions));
 const observedBlockingSamples=observed.length?observed.filter(row=>row.blockingAppSessions>0).length:null;
 const appWitness=evidence.coveragePass&&observed.some(row=>row.startedMs>=window.startMs&&row.completedMs<=window.endMs
  &&lockCount(row.appSessions)&&row.appSessions>0);
 if(closed&&(!evidence.coveragePass||appWitness))return {...evidence,observedBlockingSamples};
 return {...evidence,state:'unknown',reason:closed?'application-unobserved':'window-unsettled',
  coveragePass:false,pass:false,blockingSamples:null,observedBlockingSamples};
}

export const DEVELOPMENT_DOCKER_COMMAND='/usr/bin/docker';
export const DEVELOPMENT_DOCKER_SOCKET='unix:///var/run/docker.sock';

export function developmentDockerContext(privateDir){
 const config=join(privateDir,'docker-config'),parent=lstatSync(privateDir),directory=lstatSync(config);
 const own=stat=>stat.isDirectory()&&stat.uid===process.getuid()&&(stat.mode&0o7777)===0o700;
 if(!own(parent)||!own(directory)||realpathSync(privateDir)!==privateDir||realpathSync(config)!==config||readdirSync(config).length)
  throw Error('Owned development Docker configuration refused');
 return {args:['--config',config,'--host',DEVELOPMENT_DOCKER_SOCKET],
  env:{PATH:'/usr/bin:/bin',HOME:privateDir,LANG:'C',LC_ALL:'C',DOCKER_CONFIG:config,DOCKER_HOST:DEVELOPMENT_DOCKER_SOCKET}};
}

export function developmentPostgresBirthId(raw){
 if(!Buffer.isBuffer(raw)||raw.length!==65||raw[64]!==10)return null;
 const id=raw.subarray(0,64).toString('latin1');
 return /^[a-f0-9]{64}(?![\s\S])/.test(id)?id:null;
}

export function developmentPostgresSettlement(reset,remove,physicalAbsent){
 const postgresAbsent=reset==='unknown'||remove!=='settled'?null:physicalAbsent;
 const postgres=remove==='failed'||postgresAbsent===false?'failed':
  remove==='settled'&&postgresAbsent===true?'settled':'unknown';
 return {postgresReset:reset,postgresRemoveApi:remove,postgresAbsent,postgres};
}

const developmentTerminalKind='DEVELOPMENT_BROWSER_MEASUREMENT_V1';
const developmentPoolEvidence='postgres-js-end-api-acknowledgement';
export const DEVELOPMENT_RENDERED_CAPTURE_MAX_BYTES=4*1024**2;
const developmentNotLoaded=Object.freeze({phase:'loaded',intervalMs:1000,maxGapUs:2000000,state:'not-applicable',reason:null,
 coveragePass:false,pass:false,blockingSamples:null,observedBlockingSamples:null,qualifiedSamples:null,
 openingGapUs:null,interiorGapUs:null,tailGapUs:null});
const closedFields=(row,names)=>row!==null&&typeof row==='object'&&!Array.isArray(row)
 &&Object.keys(row).length===names.length&&names.every(name=>Object.hasOwn(row,name));
const boundedInteger=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const knownCount=(value,max)=>value===null||boundedInteger(value,max);
const exactHex=(value,length)=>typeof value==='string'&&value.length===length&&/^[0-9a-f]+(?![\s\S])/.test(value);
const validRenderedCapture=value=>closedFields(value,['sha256','bytes'])&&exactHex(value.sha256,64)
 &&boundedInteger(value.bytes,DEVELOPMENT_RENDERED_CAPTURE_MAX_BYTES)&&value.bytes>0;
const settlementState=value=>['settled','failed','absent','unknown'].includes(value);
const observedEventCount=value=>boundedInteger(value,1000000)?value:null;
const developmentPagesFields=['censusComplete','observedPages','closedPages','observedCrashes','qualifiedCrashes',
 'aborted','transport','http5xx','pageError','consoleError'];
const developmentLockFields=Object.keys(developmentNotLoaded);
const developmentSettlementFields=['browser','https','diagnostics','auditPool','observerPool'];
const developmentLoadFields=['holdMs','windowElapsed','firstFullConcurrencyUs','launched','peakActive','completed','failed',
 'activeAtSettlement','earlyLaneExits','iterations'];

function validDevelopmentSteadyLoad(load){
 return closedFields(load,developmentLoadFields)&&[30000,300000].includes(load.holdMs)
  &&typeof load.windowElapsed==='boolean'&&knownCount(load.firstFullConcurrencyUs,Number.MAX_SAFE_INTEGER)
  &&['launched','peakActive','completed','failed','activeAtSettlement','earlyLaneExits'].every(key=>boundedInteger(load[key],500))
  &&load.completed+load.failed+load.activeAtSettlement===load.launched
  &&load.activeAtSettlement<=load.peakActive&&load.peakActive<=load.launched&&load.earlyLaneExits<=load.completed+load.failed
  &&(load.firstFullConcurrencyUs!==null)===(load.peakActive===500)
  &&boundedInteger(load.iterations,Number.MAX_SAFE_INTEGER)&&load.iterations>=load.completed;
}

export function developmentSteadyLoadPass(load){
 return validDevelopmentSteadyLoad(load)&&load.holdMs===300000&&load.windowElapsed
  &&load.firstFullConcurrencyUs!==null&&load.firstFullConcurrencyUs<=10000000
  &&load.launched===500&&load.peakActive===500&&load.completed===500
  &&load.failed===0&&load.activeAtSettlement===0&&load.earlyLaneExits===0;
}

function cleanDevelopmentMeasurement({suite,identity,workCompleted,busyResponses,pageEvents,locks,settlement,load}){
 return workCompleted&&busyResponses===0&&exactHex(identity.harnessSha256,64)&&exactHex(identity.scenarioSha256,64)
  &&pageEvents.censusComplete&&pageEvents.qualifiedCrashes===0&&pageEvents.aborted!==null
  &&['transport','http5xx','pageError','consoleError'].every(key=>pageEvents[key]===0)
  &&locks.preflight.pass===true&&(suite==='workflow-preflight'||locks.loaded.pass===true&&developmentSteadyLoadPass(load))
  &&developmentSettlementFields.every(key=>settlement[key]==='settled');
}

export function buildDevelopmentMeasurement({suite,identity,workCompleted,clean,busyResponses,pages,preflight,loaded,shutdown,renderedCapture,load=/** @type {unknown} */ (null)}){
 const observedPages=knownCount(pages.observedPages,4096)?pages.observedPages:null;
 const closedPages=knownCount(pages.closedPages,4096)
  &&(observedPages!==null?pages.closedPages<=observedPages:pages.closedPages===null)?pages.closedPages:null;
 const observedCrashes=observedPages>0?observedEventCount(pages.crash):null;
 const censusComplete=pages.censusComplete===true&&shutdown.browser?.close==='settled'&&observedPages>0&&observedPages===closedPages&&observedCrashes!==null;
 const pageEvents={censusComplete,observedPages,closedPages,observedCrashes,qualifiedCrashes:censusComplete?observedCrashes:null};
 for(const name of ['aborted','transport','http5xx','pageError','consoleError'])
  pageEvents[name]=observedPages>0?observedEventCount(pages[name]):null;
 const http=shutdown.http;
 const settlement={
  browser:shutdown.browser?.close??'unknown',
  https:http?.state==='settled'&&!(http.assigned>0&&http.assigned===http.closed&&http.pending===0&&http.queued===0)?'failed':http?.state??'unknown',
  diagnostics:shutdown.diagnostics??'unknown',auditPool:shutdown.database?.audit??'unknown',observerPool:shutdown.database?.observer??'unknown',
 };
 const busy=observedEventCount(busyResponses);
 const evidence={kind:developmentTerminalKind,suite,workCompleted,identity,busyResponses:workCompleted||busy>0?busy:null,
  poolEvidence:developmentPoolEvidence,pageEvents,
  locks:{preflight,loaded:suite==='workflow-preflight'?developmentNotLoaded:loaded},settlement,
  load:suite==='whole-system'&&validDevelopmentSteadyLoad(load)?{...load}:null};
 const complete=clean&&validRenderedCapture(renderedCapture)&&cleanDevelopmentMeasurement(evidence);
 return {...evidence,complete,renderedCapture:complete?{sha256:renderedCapture.sha256,bytes:renderedCapture.bytes}:null};
}

/**
 * The runner decides the course before receiving any child message.
 * @param {{candidateSha:string,controllerSha:string,runId:number,runAttempt:number,suite:string,requireRenderedUnion?:boolean}} expected
 */
export function validateDevelopmentMeasurement(value,expected){
 const requireRenderedUnion=Object.hasOwn(expected,'requireRenderedUnion')?expected.requireRenderedUnion:false;
 if(typeof requireRenderedUnion!=='boolean'||(requireRenderedUnion&&expected.suite!=='workflow-preflight'))return false;
 const fields=['kind','suite','workCompleted','identity','busyResponses','poolEvidence','pageEvents','locks','settlement','load','complete','renderedCapture'];
 if(requireRenderedUnion)fields.push('renderedUnion');
 if(!closedFields(value,fields)
  ||value.kind!==developmentTerminalKind||value.poolEvidence!==developmentPoolEvidence||!['workflow-preflight','whole-system'].includes(value.suite)||value.suite!==expected.suite
  ||typeof value.workCompleted!=='boolean'||typeof value.complete!=='boolean'||!knownCount(value.busyResponses,1000000)
  ||(!value.workCompleted&&value.busyResponses===0))return false;
 const {identity,pageEvents,locks,settlement,load}=value;
 if(load!==null&&(value.suite!=='whole-system'||!validDevelopmentSteadyLoad(load)))return false;
 if(!closedFields(identity,['candidateSha','controllerSha','runId','runAttempt','harnessSha256','scenarioSha256'])
  ||!exactHex(identity.candidateSha,40)||!exactHex(identity.controllerSha,40)||!Number.isSafeInteger(identity.runId)||identity.runId<1
  ||identity.runAttempt!==1||!['candidateSha','controllerSha','runId','runAttempt'].every(key=>identity[key]===expected[key])
  ||(requireRenderedUnion&&identity.candidateSha!==identity.controllerSha)
  ||!['harnessSha256','scenarioSha256'].every(key=>identity[key]===null||exactHex(identity[key],64)))return false;
 if(!closedFields(pageEvents,developmentPagesFields)||typeof pageEvents.censusComplete!=='boolean'
  ||!knownCount(pageEvents.observedPages,4096)||!knownCount(pageEvents.closedPages,4096)
  ||(pageEvents.closedPages!==null&&(pageEvents.observedPages===null||pageEvents.closedPages>pageEvents.observedPages))
  ||!developmentPagesFields.slice(3).every(key=>knownCount(pageEvents[key],1000000))
  ||(pageEvents.censusComplete?!(pageEvents.observedPages>0&&pageEvents.observedPages===pageEvents.closedPages
    &&pageEvents.observedCrashes!==null&&pageEvents.qualifiedCrashes===pageEvents.observedCrashes):pageEvents.qualifiedCrashes!==null)
  ||(!pageEvents.observedPages&&developmentPagesFields.slice(3).some(key=>pageEvents[key]!==null)))return false;
 if(!closedFields(locks,['preflight','loaded'])||!closedFields(settlement,developmentSettlementFields)
  ||!Object.values(settlement).every(settlementState)
  ||(pageEvents.censusComplete&&settlement.browser!=='settled'))return false;
 for(const [phase,intervalMs] of [['preflight',250],['loaded',1000]]){
  const lock=locks[phase];
  if(!closedFields(lock,developmentLockFields)||lock.phase!==phase||lock.intervalMs!==intervalMs||lock.maxGapUs!==intervalMs*2000)return false;
  if(phase==='loaded'&&value.suite==='workflow-preflight'){
   if(!developmentLockFields.every(key=>lock[key]===developmentNotLoaded[key]))return false;
   continue;
  }
  if(!['unknown','missed','complete'].includes(lock.state)
   ||![null,'window-unknown','samples-unknown','sample-failed','sample-unknown','sample-order','coverage-gap','cadence-unobserved','blocking-observed','window-unsettled','application-unobserved'].includes(lock.reason)
   ||!['blockingSamples','observedBlockingSamples','qualifiedSamples'].every(key=>knownCount(lock[key],4097))
   ||!['openingGapUs','interiorGapUs','tailGapUs'].every(key=>knownCount(lock[key],1000000000))
   ||lock.coveragePass!==(lock.state==='complete')
   ||lock.pass!==(lock.coveragePass&&lock.blockingSamples===0))return false;
  if(lock.coveragePass){
   if(!boundedInteger(lock.qualifiedSamples,maxProtectedLockSamples)||lock.qualifiedSamples<2||lock.blockingSamples===null||lock.blockingSamples!==lock.observedBlockingSamples
    ||lock.reason!==(lock.blockingSamples===0?null:'blocking-observed')
    ||!['openingGapUs','interiorGapUs','tailGapUs'].every(key=>boundedInteger(lock[key],lock.maxGapUs)))return false;
  }else if(lock.blockingSamples!==null||lock.reason===null)return false;
 }
 if(!value.complete)return value.renderedCapture===null&&(!requireRenderedUnion||value.renderedUnion===null);
 if(!validRenderedCapture(value.renderedCapture)||!cleanDevelopmentMeasurement(value))return false;
 return !requireRenderedUnion||(validRenderedCapture(value.renderedUnion)&&value.renderedUnion.sha256!==value.renderedCapture.sha256);
}

export function createProtectedWorkAdmission({assertIngress,sealIngress,noteFailure,noteSealFailure}){
 let closed=false;
 return {
  requireOpen(){
   if(closed)throw Error('Protected workload admission is closed');
   assertIngress();
  },
  close(reason){
   if(closed)return;
   closed=true;
   noteFailure(reason);
   try{sealIngress();}catch(error){noteSealFailure(error);}
  },
 };
}

const claimScopes=Object.freeze({
 browser:['create','edit','delete'],http:['create','delete'],
 'same-company':['create','foreign-own','foreign-other','delete'],
 'other-company':['create','foreign-own','foreign-other','delete'],
 'other-tenant':['create','foreign-own','foreign-other','delete'],
});
const claimUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Own each fixed fictional Claims lifecycle until verified absence or private handoff. */
export function createProtectedClaimCustody(persist){
 if(typeof persist!=='function')throw Error('Protected Claims handoff writer required');
 const entries=new Map();
 let sealed=false,refused=false;
 function retain(frame){
  if(refused)throw Error('Protected Claims handoff already refused');
  try{persist(frame);}catch(reason){refused=true;throw reason;}
 }
 const disposition=entry=>entry.pending||entry.draft?'unconfirmed':entry.last==='delete'?'restored':'not-dispatched';
 const publicFacts=()=>[...entries.values()].map(entry=>({scope:entry.scope,
  stage:entry.pending??(entry.restorationReserved?'delete':entry.last??'create'),disposition:disposition(entry)}));
 return {
  register(scope,{actorIndex,employmentId,marker}){
   if(sealed||refused||!Object.hasOwn(claimScopes,scope)||entries.has(scope)||!Number.isSafeInteger(actorIndex)||actorIndex<0||actorIndex>=500||
      !claimUuid.test(employmentId)||!/^PERF_(?:BROWSER_DRAFT|HTTP_PREFLIGHT|BOUNDARY_[0-9]{1,3})$/.test(marker))
    throw Error('Protected Claims custody refused');
   const entry={scope,actorIndex,employmentId,marker,draft:null,pending:null,last:null,senderIndex:null,restorationReserved:false,attempted:new Set()};
   entries.set(scope,entry);
   const canRestore=()=>!sealed&&!refused&&entry.draft!==null&&entry.pending===null&&!entry.restorationReserved;
   return {
    reserveRestore(draft){
     if(!canRestore()||draft!==entry.draft)throw Error('Protected Claims restoration state refused');
     entry.restorationReserved=true;
    },
    begin(stage,senderIndex=actorIndex){
     const allowed=claimScopes[scope];
     const foreign=stage==='foreign-own'||stage==='foreign-other';
     if(sealed||refused||!allowed.includes(stage)||entry.pending||entry.attempted.has(stage)||
        !Number.isSafeInteger(senderIndex)||senderIndex<0||senderIndex>=500||(foreign?senderIndex===actorIndex:senderIndex!==actorIndex)||
        (stage==='delete'?!entry.restorationReserved:entry.restorationReserved)||
        (stage==='create'?entry.last!==null:entry.draft===null)||
        (stage!=='delete'&&stage!=='create'&&allowed[allowed.indexOf(stage)-1]!==entry.last))
      throw Error('Protected Claims mutation state refused');
     entry.attempted.add(stage);entry.pending=stage;entry.senderIndex=senderIndex;
     retain({kind:'attempt',scope,stage,actorIndex,employmentId,marker,draft:entry.draft,senderIndex});
    },
    /**
     * @param {string} stage
     * @param {string} [draft]
     */
    verify(stage,draft){
     if(sealed||entry.pending!==stage||(stage==='create'&&!claimUuid.test(draft))||(stage!=='create'&&draft!==undefined))
      throw Error('Protected Claims mutation proof refused');
     retain({kind:'verified',scope,stage,draft:stage==='create'?draft:entry.draft});
     if(stage==='create')entry.draft=draft;
     if(stage==='delete')entry.draft=null;
     entry.last=stage;entry.pending=null;entry.senderIndex=null;
    },
    canRestore,
   };
  },
  seal(){
   if(sealed)throw Error('Protected Claims handoff already sealed');
   sealed=true;
   const entries=publicFacts();
   retain({kind:'driver-sealed',entries,ownerStopRequired:entries.some(entry=>entry.disposition==='unconfirmed')});
  },
  publicFacts,
  privateUnconfirmed:()=>[...entries.values()].filter(entry=>disposition(entry)==='unconfirmed').map(
   ({scope,actorIndex,employmentId,marker,draft,pending,last,senderIndex,restorationReserved})=>
    ({scope,actorIndex,employmentId,marker,draft,pending,last,senderIndex,restorationReserved})),
 };
}

export function createProtectedLockSampler({phase,deadline,observe,onFailure,now=()=>performance.now()}){
 const interval=Object.hasOwn(lockCadenceMs,phase)?lockCadenceMs[phase]:null;
 const origin=now(),cutoffUs=Math.floor((deadline-origin)*1000);
 if(interval===null||!Number.isSafeInteger(cutoffUs)||cutoffUs<=0)throw Error('Protected lock observation window refused');
 const sampleLimit=Math.min(maxProtectedLockSamples,Math.ceil(cutoffUs/(interval*1000))+2);
 const maxGapUs=interval*2000,stamp=(round=Math.floor)=>round((now()-origin)*1000);
 const samples=[];
 let state='not-started',startUs=null,endUs=null,timer,watchdog,gapWatchdog,pending,closing,live,missedTicks=0,reason=null;
 let lastObservedStartUs=null;
 let observerSettlement='not-entered';

 function fail(code,error){
  if(reason!==null)return;
  reason=code;
  clearInterval(timer);
  clearTimeout(watchdog);
  clearTimeout(gapWatchdog);
  try{onFailure(error);}finally{live?.abort();}
 }
 function checkDeadline(){
  if(now()<deadline)return true;
  fail('deadline',Error('Protected lock observer deadline closed'));
  return false;
 }
 function watchDeadline(){
  if(!checkDeadline())return;
  watchdog=setTimeout(watchDeadline,Math.min(2**31-1,Math.max(1,Math.ceil(deadline-now()))));
 }
 function checkGap(){
  if(lastObservedStartUs===null||stamp(Math.ceil)-lastObservedStartUs<=maxGapUs)return true;
  fail('coverage-gap',Error('Protected lock observation gap exceeded'));
  return false;
 }
 function watchGap(){
  clearTimeout(gapWatchdog);
  if(reason!==null||!checkDeadline()||!checkGap())return;
  const gapEnd=origin+(lastObservedStartUs+maxGapUs)/1000;
  gapWatchdog=setTimeout(watchGap,Math.max(1,Math.ceil(gapEnd-now())));
 }
 function sample(position){
  if(samples.length>=sampleLimit){
   fail('sample-limit',Error('Protected lock sample bound exceeded'));
   return;
  }
  pending=Promise.resolve().then(async()=>{
   if((position==='opening'&&state!=='opening')||(position==='periodic'&&state!=='active'))return;
   if(reason!==null||!checkGap())return;
   const startedUs=stamp();
   if(!lockCount(startedUs)||startedUs>=cutoffUs){
    fail('deadline',Error('Protected lock observer deadline closed'));
    return;
   }
   let outcome;
   live=new AbortController();
   observerSettlement='pending';
   try{
    outcome=await observe({activeUntilMs:deadline,signal:live.signal});
   }catch(error){
    outcome={settlement:'uncertain',reason:error};
   }finally{live=undefined;}
   const completedUs=stamp(Math.ceil);
   const validCompletion=lockCount(completedUs)&&completedUs>=startedUs;
   observerSettlement=outcome?.settlement==='settled'||outcome?.settlement==='stopped'?outcome.settlement:'uncertain';
   if(observerSettlement!=='settled'||outcome.failed===true){
    samples.push({position,startedUs,completedUs:validCompletion?completedUs:null,state:'failed'});
    fail(observerSettlement==='settled'?'observer-failed':'observer-'+observerSettlement,
     outcome?.reason??Error('Protected lock observer settlement refused'));
    return;
   }
   if(!validCompletion||now()>=deadline){
    samples.push({position,startedUs,completedUs:null,state:'failed'});
    fail('deadline',Error('Protected lock observer returned outside its window'));
    return;
   }
   const {appSessions,blockingAppSessions}=outcome;
   if(!lockCount(appSessions)||!lockCount(blockingAppSessions)||blockingAppSessions>appSessions){
    samples.push({position,startedUs,completedUs,state:'failed'});
    fail('sample-invalid',Error('Protected lock observation counts refused'));
    return;
   }
   const previous=samples.at(-1);
   samples.push({position,startedUs,completedUs,state:'observed',appSessions,blockingAppSessions});
   if(blockingAppSessions>0)fail(position==='opening'?'opening-blocking':'blocking-observed',Error('Protected lock observation found blocking'));
   else if(previous&&completedUs-previous.startedUs>maxGapUs)fail('coverage-gap',Error('Protected lock observation gap exceeded'));
   else if(reason===null&&position!=='closing'){
    lastObservedStartUs=startedUs;
    watchGap();
   }
  }).finally(()=>{pending=undefined;});
  return pending;
 }

 function evidence(){
  const rows=Object.freeze(samples.map(row=>Object.freeze({...row}))),observed=rows.filter(row=>row.state==='observed');
  const observedBlockingSamples=observed.filter(row=>row.blockingAppSessions>0).length;
  const appObservedDuringWork=observed.some(row=>row.position==='periodic'&&row.appSessions>0
   &&row.startedUs>=startUs&&row.completedUs<=endUs);
  const ordered=observed.every((row,i)=>i===0||observed[i-1].completedUs<=row.startedUs);
  const observedGapUs=ordered&&observed.length>=2?Math.max(...observed.slice(1).map((row,i)=>row.completedUs-observed[i].startedUs)):null;
  const coveragePass=state==='sealed'&&(reason===null||reason==='blocking-observed')&&ordered&&rows.length===observed.length&&appObservedDuringWork
   &&lockCount(startUs)&&lockCount(endUs)&&startUs<=endUs
   &&observed[0]?.position==='opening'&&observed[0].completedUs<=startUs
   &&observed.at(-1)?.position==='closing'&&endUs<=observed.at(-1).startedUs
   &&observedGapUs!==null&&observedGapUs<=maxGapUs;
  const coverageReason=state==='sealed'&&!coveragePass?(appObservedDuringWork?'coverage-gap':'app-unobserved'):null;
  return Object.freeze({phase,state:coveragePass?'complete':state==='not-started'?'not-started':'incomplete',reason:reason??coverageReason,
   intervalMs:interval,maxGapUs,observedGapUs,cutoffUs,sampleLimit,window:startUs===null?null:Object.freeze({startUs,endUs}),missedTicks,observerSettlement,
   observedBlockingSamples,blockingSamples:coveragePass?observedBlockingSamples:null,coveragePass,
   pass:coveragePass&&observedBlockingSamples===0,samples:rows});
 }

 return {
  requireOpen(){
   if(state!=='active'||reason!==null||!checkDeadline()||!checkGap())throw Error('Protected lock coverage no longer admits work');
  },
  async start(){
   if(state!=='not-started')throw Error('Protected lock observation already started');
   state='opening';
   watchDeadline();
   await sample('opening');
   if(reason!==null||state!=='opening')throw Error('Protected lock opening observation refused');
   startUs=stamp(Math.ceil);
   if(!lockCount(startUs)||now()>=deadline){
    const error=Error('Protected lock phase deadline closed before ingress');
    fail('deadline',error);
    throw error;
   }
   state='active';
   timer=setInterval(()=>{
    if(!checkDeadline()||!checkGap())return;
    if(pending){missedTicks++;return;}
    void sample('periodic');
   },interval);
  },
  close(workSettled){
   if(closing)return closing;
   const active=state==='active';
   if(active)endUs=stamp();
   state='closing';
   clearInterval(timer);
   if(workSettled!==true){reason??='work-incomplete';clearTimeout(gapWatchdog);live?.abort();}
   closing=(async()=>{
    await pending;
    if(active&&workSettled===true&&reason===null){
     await sample('closing');
     state='sealed';
    }else{
     reason??='work-incomplete';
     state='incomplete';
    }
    return evidence();
   })().finally(()=>{clearTimeout(watchdog);clearTimeout(gapWatchdog);});
   return closing;
  },
  evidence,
 };
}

export function closedChromiumEnvironment(source,runnerHome){
 if(source.SELENIUM_REMOTE_URL)throw Error('Remote Chromium launch is outside the owned development driver');
 if(typeof runnerHome!=='string'||!runnerHome.startsWith('/'))throw Error('Runner account home is unavailable');
 const env={PATH:'/usr/bin:/bin',HOME:runnerHome,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
 if(source.TZ!==undefined){
  if(source.TZ!=='UTC'&&source.TZ!=='Asia/Kuala_Lumpur')throw Error('Unsupported Chromium time zone');
  env.TZ=source.TZ;
 }
 return env;
}

export function createDriverContexts(failures){
 const entries=new Map();
 const register=context=>{
  if(!entries.has(context))entries.set(context,{state:'acquired',pending:null});
  return context;
 };
 const close=context=>{
  register(context);
  const entry=entries.get(context);
  if(!entry.pending){
   entry.state='attempted';
   let settle;
   entry.pending=new Promise(resolve=>{settle=resolve;});
   void failures.attempt('context-close',()=>context.close()).then(outcome=>{
    entry.state=outcome.state;
    settle(outcome);
   });
  }
  return entry.pending;
 };
 // A failed lifetime may release the lane's wait, while the registry still
 // owns the native close promise and the final browser sweep still awaits it.
 const waitForClose=context=>Promise.race([close(context),failures.whenFailed]);
 const withContext=async(context,work)=>{
  try{return await work();}
  catch(reason){failures.notePrimary(reason);throw reason;}
  finally{await waitForClose(context);}
 };
 return {register,close,waitForClose,withContext,
  hasPendingClose:()=>[...entries.values()].some(entry=>entry.state==='attempted'),
  closeAll:()=>Promise.all([...entries.keys()].map(close)),summary:()=>{
  const counts={acquired:entries.size,attempted:0,settled:0,failed:0};
  for(const entry of entries.values()){
   if(entry.pending)counts.attempted++;
   if(entry.state==='settled'||entry.state==='failed')counts[entry.state]++;
  }
  return counts;
 }};
}

export function observeDriverBrowser(browser,failures){
 let expectedClose=false,unexpectedDisconnect=false;
 const checkDisconnect=()=>{
  if(expectedClose||unexpectedDisconnect)return;
  unexpectedDisconnect=true;
  failures.record('browser-disconnected',Error('Owned Chromium disconnected before its close attempt'));
 };
 browser.once('disconnected',checkDisconnect);
 if(!browser.isConnected())checkDisconnect();
 return {unexpectedDisconnect:()=>unexpectedDisconnect,async close(){
  try{if(!browser.isConnected())checkDisconnect();}
  catch(reason){failures.record('browser-connection-state',reason);}
  expectedClose=true;
  return failures.attempt('browser-close',()=>browser.close());
 }};
}

export async function settleDriverBrowser(browser,owned,contexts,failures){
 try{for(const context of browser?.contexts()??[])contexts.register(context);}
 catch(reason){failures.record('context-inventory',reason);}
 // Initiate every outstanding context attempt before the browser close. The two
 // promises settle independently, even if a context close needs the browser to exit.
 const contextDrain=contexts.closeAll();
 const browserClose=owned?owned.close():browser?failures.attempt('browser-close',()=>browser.close()):Promise.resolve({state:'absent'});
 const [,result]=await Promise.all([contextDrain,browserClose]);
 return {close:result.state,unexpectedDisconnect:owned?.unexpectedDisconnect()??false,contexts:contexts.summary()};
}

/** Only the real sockets assigned to this driver's one agent, including keep-alive reuse. */
export function createDriverSockets(failures){
 const seen=new WeakSet(),live=new Map();
 let assigned=0,closed=0,closing=false;
 const bind=socket=>{
  if(seen.has(socket))return;
  seen.add(socket);assigned++;
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  live.set(socket,pending);
  socket.once('close',()=>{live.delete(socket);closed++;finish();});
 };
 const observe=socket=>{
  bind(socket);
  if(closing){
   failures.record('late-socket',Error('A socket was assigned after agent shutdown began'));
   failures.evidence(()=>socket.destroy());
  }
 };
 return {observe,summary:()=>({assigned,closed,pending:live.size}),async closeAgent(agent){
  closing=true;
  const queued=Object.values(agent.requests).flat();
  if(queued.length){
   failures.record('agent-queue',Error('Owned HTTPS requests were still queued at shutdown'));
   for(const request of queued)await failures.attempt('request-destroy',()=>request.destroy());
  }
  for(const socket of [...Object.values(agent.sockets).flat(),...Object.values(agent.freeSockets).flat()])bind(socket);
  const outcome=await failures.attempt('agent-destroy',()=>agent.destroy());
  if(outcome.state==='failed')await Promise.all([...live.keys()].map(socket=>failures.attempt('socket-destroy',()=>socket.destroy())));
  while(live.size)await Promise.all([...live.values()]);
  return {state:outcome.state,queued:queued.length,assigned,closed,pending:live.size};
 }};
}

/** Distinct body result and native terminal promises keep latency and teardown separate. */
export function openDriverResponse({start,body,startedMs,onHeaders,observeSocket,recordFailure}){
 let request,response,decoder,requestClosed=false,responseClosed=true,decoderClosed=true;
 let finished=false,failed=false,decodedEnded=false,resolveResult,rejectResult,resolveTerminal;
 const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
 const terminal=new Promise(resolve=>{resolveTerminal=resolve;});
 const settle=()=>{if(requestClosed&&responseClosed&&decoderClosed)resolveTerminal();};
 const premature=()=>Object.assign(Error('Owned HTTP transport closed before its response completed'),{code:'ERR_STREAM_PREMATURE_CLOSE'});
 const fail=reason=>{
  if(failed)return;
  failed=true;
  if(finished)recordFailure('http-late-failure',reason);
  else{finished=true;rejectResult(reason);}
  for(const handle of [decoder,response,request]){
   if(!handle)continue;
   try{handle.destroy();}catch(error){recordFailure('request-destroy',error);}
  }
 };
 const accept=res=>{
  response=res;responseClosed=false;
  res.on('error',fail);
  res.once('aborted',()=>fail(premature()));
  res.once('close',()=>{responseClosed=true;if(!res.complete)fail(premature());settle();});
  if(failed){
   try{res.destroy();}catch(error){recordFailure('request-destroy',error);}
   return;
  }
  try{
   let wireBytes=0,decodedBytes=0,content='';
   const ttfbMs=performance.now()-startedMs;
   onHeaders(res,ttfbMs);
   res.on('data',chunk=>{wireBytes+=chunk.length;});
   if(res.headers['content-encoding']==='gzip'){
    decoder=createGunzip();decoderClosed=false;
    decoder.on('error',fail);
    decoder.once('close',()=>{decoderClosed=true;if(!decodedEnded)fail(premature());settle();});
   }
   const stream=decoder??res;
   stream.on('data',chunk=>{
    if(failed)return;
    decodedBytes+=chunk.length;
    if(decodedBytes>12*1024*1024){fail(Error('Decoded response exceeded the 12MiB measurement ceiling'));return;}
    content+=chunk.toString();
   });
   stream.once('end',()=>{
    decodedEnded=true;
    if(finished)return;
    finished=true;
    resolveResult({status:res.statusCode,headers:res.headers,content,wireBytes,decodedBytes,ttfbMs});
   });
   if(decoder)res.pipe(decoder);
  }catch(reason){fail(reason);}
 };
 try{
  request=start();
  request.on('error',fail);
  request.once('response',accept);
  request.once('close',()=>{requestClosed=true;if(!response)fail(premature());settle();});
  request.once('socket',observeSocket);
  if(request.socket)observeSocket(request.socket);
  request.end(body);
 }catch(reason){
  if(!request)requestClosed=true;
  fail(reason);settle();
 }
 return {result,terminal};
}

/** Independent five-second API attempts after the exact driver DB work is drained. */
export async function closePerformanceDbPools(nativeAuditClient,driver,failures,measuredLockObserver){
 const close=(client,stage)=>client?failures.attempt(stage,()=>client.end({timeout:5})):Promise.resolve({state:'absent'});
 const [audit,observer,locks]=await Promise.all([close(nativeAuditClient,'audit-pool-end'),close(driver,'observer-pool-end'),
  close(measuredLockObserver,'measured-lock-pool-end')]);
 return {audit:audit.state,observer:locks.state==='failed'?'failed':observer.state};
}

/** tsx can expose destructured TS exports through CommonJS default on the hosted Node runtime. */
export function performanceNativeDbClient(module){
 const client=module.client??module.default?.client;
 if(!client||typeof client.end!=='function')throw Error('Canonical native database client export unavailable');
 return client;
}
