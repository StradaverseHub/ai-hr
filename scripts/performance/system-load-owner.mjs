/** Real HTTPS requests + Chromium against the isolated production server; no auth/test route bypass. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHomeHttpReplay} from './home-http.mjs';
import {browserFailureLocation,browserPreflightClickObstruction,browserPreflightErrorFingerprint,browserPreflightFailureLocation} from './browser-failure.ts';
import {routeLatency} from './route-latency.mjs';
import {centreTabsFor} from '../../lib/ai-centre/centre-nav.ts';
import {createSteadyRouteScheduler,planSteadyRouteCoverage,navigationProtocol} from './route-scheduling.mjs';
import {createNavigationCaptureCollector,writeNavigationCaptureBundle,writeDevelopmentRenderedRouteUnion,
 installNativePrimaryFailureObserver,createNativeBrowserFailureObservation,legacyNavigationFailureFacts} from './navigation-browser-capture.ts';
import {fullDevelopmentBrowserRouteCourse} from './development-browser-route-course.mjs';
import {NATIVE_HIDDEN_SHELL_CASES} from './navigation-protocol.ts';
import {requireNativePreflightFixtureDay,verifyNativePreflightContent} from './native-preflight-content.ts';
import {performanceFixtureCalendar} from './fixture-workload.mjs';
import {prepareMixedWorkflows} from './mixed-workflows.mjs';
import {attendanceRejectionProbeEnabled,prepareAttendanceRejection} from './attendance-rejection-browser.mjs';
import {exerciseMovement} from './movement-browser.mjs';
import {exerciseLetterDraft} from './letter-draft-browser.mjs';
import {exerciseOrgExplorer} from './org-explorer-browser.mjs';
import {exerciseSavedReport} from './reports-browser.mjs';
import {exercisePayrollBrowser,payrollReadinessSurfaces} from './payroll-browser.mjs';
import {exercisePayrollRegister,verifyPayrollRegisterBoundary} from './payroll-register-browser.mjs';
import {exercisePersonnelSwitcher} from './personnel-switcher-browser.mjs';
import {exerciseLivePersonnelProfile} from './personnel-live-profile-browser.mjs';
import {verifyAssistantHistoryBrowser} from './assistant-history-browser.mjs';
import {actionFormData} from './action-form.ts';
import {closeSync,constants as fsFlags,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import {userInfo} from 'node:os';
import {inspect} from 'node:util';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';
import {chromium} from 'playwright';
import postgres from 'postgres';
import {generate} from 'otplib';
import {closePerformanceDbPools,performanceNativeDbClient,closedChromiumEnvironment,createDriverContexts,
 createDriverFailures,createDriverSockets,createDriverWork,createProtectedClaimCustody,createProtectedLockSampler,createProtectedWorkAdmission,driverErrorFact,lockSampleEvidence,
 developmentLockWindowEvidence,developmentSteadyLoadPass,buildDevelopmentMeasurement,developmentDockerContext,DEVELOPMENT_DOCKER_COMMAND,
 observeDriverBrowser,openDriverResponse,settleDriverLanes,startDriverInterval,acquireDriverResource,
 drainDriverLanes,settleDriverBrowser,settleDriverResources} from './driver-shutdown.mjs';
import {protectedLockObserverObservedCounts,protectedLockObserverQuery} from './protected-lock-observer.mjs';
import {mergeAdvisoryEdges,observeSampledAdvisoryBlockers,originalAdvisoryAttribution} from './lock-sample-attribution.mjs';
import {readRouteForMeasurement,routePools,wholeSystemRouteCount,additionalBrowserRoutes,architectureHrReadRoutes,
 nativePreflightRoutePlan,nativePreflightRouteFor,nativePreflightContentWitness,nativePreflightReadiness,
 assertNativePreflightRedirect,assertNativeRenderedVisit,nativeRenderedVisitFailureRule,requireNativeRenderedUnion,readManifestRoute} from './system-route-manifest.mjs';
function createDevelopmentPageCensus(){
 const observation=createNativeBrowserFailureObservation(),contexts=new Map();
 let observedPages=0,closedPages=0,incomplete=false;
 const observe=work=>{try{work();}catch{incomplete=true;}};
 return {
  attach(context){
   observe(()=>{
    assert(!contexts.has(context)&&context.pages().length===0);
    const live=new Set();contexts.set(context,live);
    context.on('page',page=>observe(()=>{
     assert(page.context()===context&&!page.isClosed()&&context.pages().includes(page));
     observation.observe(page);
     live.add(page);observedPages++;
    }));
    // Playwright emits pageclose after removing the Page from the context's list.
    context.on('pageclose',page=>observe(()=>{
     assert(page.context()===context&&page.isClosed()&&live.delete(page));
     closedPages++;
    }));
   });
  },
  // V2 records Chromium cancellations separately. A canceled owned document
  // still fails its exact response/navigation checks before rendered evidence.
  pageCount:page=>observation.pageCount(page,{includeAborted:false}),
  pageFacts:observation.pageFacts,
  finish(shutdown,strict,recordFailure){
   observe(()=>{for(const [context,live] of contexts)assert(live.size===0&&context.pages().length===0);});
   const settled=shutdown.contexts,events=observation.facts();
   const censusComplete=!incomplete&&shutdown.browserClosed===true&&shutdown.browser?.unexpectedDisconnect===false
    &&settled?.acquired===contexts.size&&settled.attempted===contexts.size&&settled.settled===contexts.size&&settled.failed===0
    &&observedPages>0&&observedPages===closedPages;
   if(strict&&!censusComplete)recordFailure('development-page-census',Error('Development Page event census incomplete'));
   if(strict&&events.crash>0)recordFailure('development-page-crash',Error('Development Page crashed'));
   return {scope:'owned-development-page-events-through-browser-settlement',censusComplete,observedPages,closedPages,...events};
  },
 };
}

export async function runDevelopmentSystemLoad(){
 return runSystemLoad();
}

function protectedClaimHandoff(directory){
 let fd,frames=0;
 return {
  persist(frame){
   // Seventeen fixed mutation attempts and their verified transitions, plus one seal.
   const raw=Buffer.from(JSON.stringify(frame)+'\n');
   assert(frames<35&&raw.length<=1024,'Protected Claims handoff bound refused');
   if(fd===undefined){
    const privateDir=lstatSync(directory);
    assert(realpathSync(directory)===directory&&privateDir.isDirectory()&&privateDir.uid===process.getuid()&&
     (privateDir.mode&0o7777)===0o700,'Protected Claims private directory refused');
    fd=openSync(join(directory,'protected-claim-attempts.jsonl'),fsFlags.O_WRONLY|fsFlags.O_CREAT|fsFlags.O_EXCL|fsFlags.O_NOFOLLOW,0o600);
    const held=fstatSync(fd);
    assert(held.isFile()&&held.uid===process.getuid()&&(held.mode&0o7777)===0o600&&held.nlink===1&&held.size===0,
     'Protected Claims handoff descriptor refused');
   }
   assert.equal(writeSync(fd,raw),raw.length,'Protected Claims handoff write incomplete');
   fsyncSync(fd);
   frames++;
  },
  close(){if(fd!==undefined)closeSync(fd);},
 };
}

// No native issuer is installed by this source slice. A future protected
// launcher must bind its admitted course at an audited private call site.
// The public development entry has no way to supply it.
async function runSystemLoad(nativeCourse){
const driverStarted=performance.now();
const base='https://localhost:3443',out=process.env.PERF_EVIDENCE_DIR;
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(new URL(process.env.DATABASE_URL).pathname,'/ai_hr_dev');
const nativePreflight=nativeCourse!==undefined,nativeDeadline=nativeCourse?.deadline;
const nativeIngress=nativeCourse?.ingress,nativeLockObserver=nativeCourse?.lockObserver;
if(nativePreflight){
 assert(Number.isFinite(nativeDeadline)&&nativeDeadline>performance.now(),'Owned native preflight deadline required');
 // No caller is installed. The protected issuer must fence actual browser
 // ingress with the rolling lock frontier independently of JS timer delivery,
 // and own the reserved native query through cancellation and drain.
 assert(typeof nativeIngress?.assertBusinessOpen==='function'&&typeof nativeIngress?.sealBusiness==='function'
  &&typeof nativeIngress?.assertClaimRestoration==='function'&&typeof nativeLockObserver?.sql==='function'
  &&nativeLockObserver.identity&&typeof nativeLockObserver.settleFixedSample==='function',
  'Protected ingress and owned lock observer settlement capabilities are required');
 nativePreflightRoutePlan();
}
const fixture=JSON.parse(readFileSync(join(process.env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
let db,agent,browser,ownedBrowser,chromiumEnv,nativeAuditClient;
const acquired={observer:'absent',agent:'absent',browser:'absent',audit:'absent'};
const failures=createDriverFailures(),contexts=createDriverContexts(failures),sockets=createDriverSockets(failures);
const lanes=createDriverWork(),requests=createDriverWork(),transports=createDriverWork(),diagnostics=createDriverWork();
const lifecycleRefused=Error('An owned development driver resource failed');
const claimHandoff=nativePreflight?protectedClaimHandoff(process.env.PERF_PRIVATE_DIR):undefined;
const claimCustody=claimHandoff?createProtectedClaimCustody(claimHandoff.persist):undefined;
const nativeAdmission=nativePreflight?createProtectedWorkAdmission({
 assertIngress(){
  protectedSampler?.requireOpen();nativeRemaining(nativeDeadline);
  assert.equal(nativeIngress.assertBusinessOpen(),true,'Owned protected business ingress refused');
 },
 sealIngress(){assert.equal(nativeIngress.sealBusiness(),true,'Owned protected business ingress did not seal');},
 noteFailure:failures.notePrimary,noteSealFailure:reason=>failures.record('native-ingress-seal',reason),
}):undefined;
function requireNativeBusiness(){
 if(!nativeAdmission)return;
 try{nativeAdmission.requireOpen();}catch(reason){nativeAdmission.close(reason);throw reason;}
}
function requireNativeClaimRestoration(user,draft){
 if(!nativePreflight)return;
 nativeRemaining(nativeDeadline);
 assert.equal(nativeIngress.assertClaimRestoration(user.index,draft),true,'Owned claim restoration refused');
}
const requireCleanDriver=()=>{
 if(failures.resourceFailed()||contexts.hasPendingClose()){
  nativeAdmission?.close(lifecycleRefused);throw lifecycleRefused;
 }
 requireNativeBusiness();
};
const {waitForClose:closeContext}=contexts;
const withContext=(context,work)=>contexts.withContext(context,()=>{requireNativeBusiness();return work();});
const {notePrimary,evidence:noteEvidence}=failures;
const runLane=async work=>{try{requireNativeBusiness();return await work();}catch(reason){failures.notePrimary(reason);throw reason;}};
const runLanes=(values,run)=>lanes.run(()=>Promise.allSettled(values.map(value=>runLane(()=>run(value)))));
const errorLabel=reason=>{const {kind,code}=driverErrorFact(reason);return code??kind;};
const suite=nativePreflight?'workflow-preflight':process.env.PERF_HTTP_SUITE||'claims-heavy';assert(['claims-heavy','whole-system','workflow-preflight'].includes(suite));
const fullDevelopmentRoutes=!nativePreflight&&fullDevelopmentBrowserRouteCourse(process.env);
const strictRenderedPreflight=nativePreflight||fullDevelopmentRoutes;
// The parent retains its earlier 600-second development child stop.
const renderedDeadline=nativePreflight?nativeDeadline:fullDevelopmentRoutes?driverStarted+600000:undefined;
if(fullDevelopmentRoutes)nativePreflightRoutePlan();
const baselineNavigation=suite==='claims-heavy'?undefined:createNavigationCaptureCollector({phase:'baseline'});
const loadedNavigation=suite==='whole-system'?createNavigationCaptureCollector({phase:'loaded'}):undefined;
const nativeShell=strictRenderedPreflight?baselineNavigation.nativeHiddenShell(renderedDeadline):undefined;
// Keep complete role routes for baseline and whole-system browser pilots.
const routePool=user=>routePools[user.role];
const measuredRoutePools=suite==='whole-system'?routePools:{employee:['/me','/claims','/leave'],manager:['/approvals','/claims','/performance/home'],companyHR:['/admin/personnel','/payroll','/claims'],groupHR:['/admin/personnel','/payroll','/claims']};
const thinkTimeMs=Number(process.env.PERF_HTTP_THINK_MS||1000);assert([1000,5000].includes(thinkTimeMs));
const steadyHoldMs=Number(process.env.PERF_HTTP_HOLD_MS||30000);assert([30000,300000].includes(steadyHoldMs));
const report={suite,kind:nativePreflight?'NATIVE_RENDERED_UNION_WORKFLOW_SLICE':suite==='workflow-preflight'?'HTTP_WORKFLOW_PREFLIGHT_ONLY':'HTTP_AND_CHROMIUM_DEVELOPMENT_ONLY',releaseEligible:false,users:suite==='workflow-preflight'?0:500,fixtureUsers:500,tenants:2,companies:10,startedAt:new Date().toISOString(),
 assumptions:{arrivalWindowMs:10000,thinkTimeMs,steadyHoldMs,navigation:'full-document HTTP stress, observed subject-bound Home GETs and real server actions',navigationProtocol:suite==='whole-system'?navigationProtocol:'unchanged-claims-cycle',navigationScheduling:'shared per-role pending/inflight/completed steady obligations; minimum seven, maximum twelve group-HR reads per cycle; three other reads; same complete mutations and activity pauses; higher read share lowers write iteration frequency; compare only identical frozen v2 protocols',driverMaxSockets:4000,preflightHttpActorLanes:4,browserVisitReadiness:'domcontentloaded followed by unchanged heading, fixture data and complete Home card assertions',tls:'fixture-only self-signed localhost',browserContexts:6,loadedBrowserSignIns:4,preflightBrowserSignIns:4,persistenceObserverPrincipals:6,persistencePollIntervalMs:100,loginEnrollmentLoad:false,performanceFixture:'enabled dashboard; no assigned review cycle; task-gated tabs excluded'},
 workloadManifest:{readRoutes:wholeSystemRouteCount,mutations:['Claims draft create/edit/delete','Leave request create/edit/withdraw','Personnel draft create/edit/delete','Attendance correction and authorized approval'],browserMutations:suite==='claims-heavy'?[]:['Generic Reports saved-definition create/edit/delete (group HR, baseline'+(suite==='whole-system'?' and loaded':'')+')','Service Movement Secondment (group HR, '+(suite==='whole-system'?'loaded':'preflight')+')'],preflightOnly:suite==='workflow-preflight'?['Active Personnel contact edit/restore','E-Letter draft create/edit/withdraw','Concurrent Payroll close/publish','Performance review-cycle draft creation','Rewards annual unit draft creation']:[],processing:['Payroll calculation','Payroll close/employee publication preflight','scoped Payroll CSV generation','clocking-file validation/import'],notCovered:['Navigation destinations outside the reviewed scenario plan',...(suite==='workflow-preflight'?[]:['concurrent Payroll close/publish','active Personnel contact edit/restore','E-Letter draft mutations']),'Lifecycle mutations',...(suite==='workflow-preflight'?['Performance and Rewards mutations beyond draft creation']:['Performance mutations','Rewards mutations']),'large Personnel imports',...(suite==='claims-heavy'?['report-definition CRUD']:['Employee Master and Payroll Comparison definition CRUD','500-principal Reports write mix']),'long-running document jobs','external email delivery'],productionEquivalent:false},
 coverage:[],boundaries:[],browser:[],homeCardFailures:[],browserHomeRequests:[],phases:[],functionalErrors:[],browserErrors:[],persistenceObservers:[],latencyTargetMet:false};
const save=()=>writeFileSync(join(out,'http-browser.json'),JSON.stringify(report,null,2));
const nativeBrowserFailures=nativePreflight?createNativeBrowserFailureObservation():null;
const measureDevelopment=!nativePreflight&&suite!=='claims-heavy';
const developmentPageCensus=measureDevelopment?createDevelopmentPageCensus():null;
let developmentNavigationBinding,developmentRenderedCapture,developmentWorkCompleted=false,developmentLoad=null;
if(measureDevelopment)report.postgresWaitLogging={scope:'driver-observer-session-settings-only',
 serverLogCoverage:'unqualified',start:null,end:null};
let developmentUnionFacts;
const nativePrimaryDocuments=[];
if(nativePreflight)report.nativeRenderedPreflight={kind:'NATIVE_PRIMARY_ROUTE_UNION',observations:[],union:null,workflowAndRenderedSlicePassed:false,
 pendingHiddenShellCases:NATIVE_HIDDEN_SHELL_CASES.map(row=>row.id),
 nativeShellBaseline:null,exactShellScenarioPlanComplete:false,dynamicNavigationComplete:false,releaseEligible:false};
const renderedReport=nativePreflight?report.nativeRenderedPreflight:fullDevelopmentRoutes?{observations:[],union:null}:undefined;
const renderedPageEvents=nativePreflight?nativeBrowserFailures:developmentPageCensus;
function nativeRemaining(deadline){const remaining=Math.floor(deadline-performance.now());assert(remaining>0,'Owned native preflight route deadline closed');return remaining;}
function processCpu(ids){
 const ticks=Number(process.env.PERF_CLOCK_TICKS);
 if(!/^\d+(,\d+)*$/.test(ids??'')||!Number.isFinite(ticks)||ticks<=0)return null;
 try{return ids.split(',').reduce((total,pid)=>{const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);return total+(Number(fields[11])+Number(fields[12]))/ticks;},0);}catch{return null;}
}
const appCpu=()=>processCpu(process.env.PERF_APP_PIDS??process.env.PERF_APP_PID);
function resourceCpu(){
 const ticks=Number(process.env.PERF_CLOCK_TICKS),name=process.env.PERF_POSTGRES_CONTAINER;
 assert.equal(name,`aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.AIHR_CI_UNIT}`);
 assert(/^aihr-ci-\d+-\d+-db-(?:[1-4]|[0-9a-f]{16})$/.test(name));
 // Only this workflow's labelled disposable container may be inspected.
 let usage;
 if(measureDevelopment){
  const id=process.env.PERF_POSTGRES_CONTAINER_ID;
  assert(/^[a-f0-9]{64}(?![\s\S])/.test(id),'Owned development PostgreSQL driver identity refused');
  const context=developmentDockerContext(process.env.PERF_PRIVATE_DIR);
  const query=(...args)=>execFileSync(DEVELOPMENT_DOCKER_COMMAND,[...context.args,...args],
   {env:context.env,encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:4096});
  const format='{{.Id}} {{.Name}} {{index .Config.Labels "aihr-owner"}} {{.State.Running}}';
  assert(query('inspect','--type','container','--format',format,id).trim()===id+' /'+name+' '+name+' true',
   'Owned development PostgreSQL driver container refused');
  usage=query('exec',id,'cat','/sys/fs/cgroup/cpu.stat');
 }else{
  assert.equal(execFileSync('docker',['inspect','--format','{{index .Config.Labels "aihr-owner"}}',name],{encoding:'utf8',timeout:5000}).trim(),name);
  usage=execFileSync('docker',['exec',name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:5000});
 }
 const fields=Object.fromEntries(usage.trim().split('\n').map(line=>{const [key,value]=line.trim().split(/\s+/);return [key,Number(value)];}));
 for(const key of ['usage_usec','user_usec','system_usec','throttled_usec'])assert(Number.isSafeInteger(fields[key])&&fields[key]>=0,'missing PostgreSQL CPU counter');
 const host=readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
 assert(host.length>=8&&host.every(value=>Number.isSafeInteger(value)&&value>=0)&&ticks>0);
 return {postgresCpuSeconds:fields.usage_usec/1e6,postgresUserSeconds:fields.user_usec/1e6,postgresSystemSeconds:fields.system_usec/1e6,
  postgresThrottledSeconds:fields.throttled_usec/1e6,proxyCpuSeconds:processCpu(process.env.PERF_PROXY_PID),
  hostUserSystemSeconds:(host[0]+host[1]+host[2]+host[5]+host[6])/ticks,hostIoWaitSeconds:host[4]/ticks,hostStealSeconds:host[7]/ticks};
}
function appMemory(){
 const ids=process.env.PERF_APP_PIDS??process.env.PERF_APP_PID;
 if(!/^\d+(,\d+)*$/.test(ids??''))return null;
 try{return ids.split(',').map((pid,worker)=>{const status=readFileSync('/proc/'+pid+'/status','utf8');
  const rss=status.match(/^VmRSS:\s+(\d+) kB$/m),peak=status.match(/^VmHWM:\s+(\d+) kB$/m);
  if(!rss||!peak)throw Error('process memory unavailable');
  return {worker,rssMiB:Number(rss[1])/1024,peakRssMiB:Number(peak[1])/1024};
 });}catch{return null;}
}
const samples=[],pageInteractions=[];
const busyScreenSelector='main[data-personnel-busy], main[data-page-busy], main [data-personnel-busy], main [data-page-busy]';
report.pageBusyResponses=[];
function rejectBusyPage(user,path,channel){
 try{assert.fail('A page returned a Busy response before becoming usable');}
 catch(reason){
  notePrimary(reason);
  noteEvidence(()=>{report.pageBusyResponses.push({role:user.role,route:readRouteForMeasurement(path),channel});save();});
  throw reason;
 }
}

const claimRestorationKey=Symbol('owned claim restoration');
const homeHttp=createHomeHttpReplay({base,request,report});
function request(...args){requireNativeBusiness();return requests.run(()=>requestBody(...args));}
function readRoute(user,route){return readManifestRoute(route,(path,status)=>request(user,path,undefined,status));}
async function requestBody(user,path,fields,expectedStatus=200,record=true,actionHeaders={},fieldOrder=[],action,claimAttempt){
 assert(path.startsWith('/')&&!path.startsWith('//'));const started=performance.now();let body,contentType;
 if(Array.isArray(fields)){body=Buffer.from(JSON.stringify(fields));contentType='text/plain;charset=UTF-8';}
 else if(fields){const encoded=new Response(actionFormData(fields,fieldOrder));contentType=encoded.headers.get('content-type');body=Buffer.from(await encoded.arrayBuffer());}
 let responseHeaders;
 const transport=openDriverResponse({body,startedMs:started,observeSocket:sockets.observe,recordFailure:failures.record,
  start:()=>{
   const checkAdmission=()=>{
    if(claimAttempt?.key===claimRestorationKey)requireNativeClaimRestoration(user,claimAttempt.draft);
    else requireNativeBusiness();
   };
   checkAdmission();
   if(claimAttempt){claimAttempt.beforeDispatch();checkAdmission();}
   return https.request(base+path,{agent,signal:AbortSignal.timeout(nativePreflight?Math.min(90000,nativeRemaining(nativeDeadline)):90000),method:fields?'POST':'GET',headers:{Host:'localhost:3443',Origin:base,
    Cookie:`__Host-aihr_internal=${user?.token??''}; NEXT_LOCALE=en`,'Accept-Encoding':'gzip',...actionHeaders,...(body?{'Content-Type':contentType,'Content-Length':body.length}:{})}});
  },
  onHeaders:(res,ttfbMs)=>{responseHeaders={status:res.statusCode,ttfbMs,hasActionRedirect:Boolean(res.headers['x-action-redirect'])};},
 });
 transports.run(()=>transport.terminal);
 const response=await transport.result.catch(error=>{
  noteEvidence(()=>{(report.requestErrors??=[]).push({user:user?.index??null,role:user?.role??'anonymous',route:readRouteForMeasurement(path),method:fields?'POST':'GET',action,startedMs:started,elapsedMs:performance.now()-started,responseHeaders:responseHeaders??null,error:errorLabel(error)});});
  throw error;
 });
 response.durationMs=performance.now()-started;
 if(record)samples.push({user:user?.index??null,role:user?.role??'anonymous',route:readRouteForMeasurement(path),method:fields?'POST':'GET',action,status:response.status,startedMs:started,durationMs:response.durationMs,ttfbMs:response.ttfbMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes});
 assert.equal(response.status,expectedStatus,`Unexpected HTTP status for ${path.split('?')[0]}`);
 const ownPayslipPdf=/^\/me\/payslip\/[0-9a-f-]{36}\/pdf$/.test(path.split('?')[0]);
 if(!fields&&expectedStatus===200&&ownPayslipPdf){
  assert(String(response.headers['content-type']).includes('application/pdf'),'personal document returned a non-PDF response');
  assert(response.content.startsWith('%PDF-'),'personal document PDF header missing');
  assert(String(response.headers['cache-control']).includes('private')&&String(response.headers['cache-control']).includes('no-store'),'personal document cache policy');
  assert(String(response.headers['content-disposition']).includes('attachment'),'personal document download disposition');
 }else if(!fields&&expectedStatus===200&&!path.startsWith('/api/')&&!String(response.headers['content-type']).includes('text/csv')){
  assert(!/NEXT_HTTP_ERROR_FALLBACK;(404|500)/.test(response.content)&&!/<h1[^>]*>\s*404(?:\s|<)/.test(response.content),'streamed error boundary');
  if(/<[a-z][^<>]*\sdata-(?:personnel|page)-busy(?:\s|=|>)/i.test(response.content))rejectBusyPage(user,path,'http');
  assert(response.content.includes(user.name),'signed-in principal marker missing');
  assert(!response.content.includes('PERF Person '+String(user.tenant?0:250).padStart(4,'0')),'cross-tenant person leaked');
 }
 return response;
}
// Six fictional principals only. Reads are indexed and stop as soon as the changed
// state is visible. Observation time is an upper bound on commit visibility, not
// an exact transaction duration; it is kept separate from HTTP latency samples.
async function observedMutation(user,operation,visible,send){
 if(![0,1,2,4,250,254].includes(user.index))return send();
 let stopped=false;const started=performance.now();
 const observation=(async()=>{
  let polls=0;
  try{
   while(!stopped){polls++;if(await visible())return {visible:true,visibleByMs:performance.now()-started,polls};await pause(100);}
   return {visible:false,visibleByMs:null,polls};
  }catch{return {visible:false,visibleByMs:null,polls,observerError:true};}
 })();
 let response;
 try{response=await send();return response;}
 finally{
  stopped=true;const httpFinishedMs=performance.now()-started,result=await observation;
  report.persistenceObservers.push({user:user.index,role:user.role,operation,...result,httpDurationMs:response?.durationMs??null,httpFinishedMs});
 }
}
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1]??null,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null,p99Ms:sorted[Math.ceil(sorted.length*.99)-1]??null,maxMs:sorted.at(-1)??null};};
async function observePostgresWaitLogging(edge){
 try{
  const [row]=await db`select current_setting('log_lock_waits')='on' as "logLockWaits",
    (select setting::int from pg_catalog.pg_settings where name='deadlock_timeout' and unit='ms') as "deadlockTimeoutMs"
    where session_user='postgres' and current_user='postgres' and current_database()='ai_hr_dev'`;
  if(typeof row?.logLockWaits==='boolean'&&Number.isSafeInteger(row.deadlockTimeoutMs)&&row.deadlockTimeoutMs>0)
   report.postgresWaitLogging[edge]={logLockWaits:row.logLockWaits,deadlockTimeoutMs:row.deadlockTimeoutMs};
 }catch{/* Unknown settings cannot qualify server-log coverage. */}
}
async function databaseSnapshot(label){
 const settings=await db`select current_setting('fsync')as fsync,current_setting('synchronous_commit')as synchronous_commit,current_setting('jit')as jit,current_setting('server_version')as server_version,current_setting('shared_buffers')as shared_buffers,current_setting('work_mem')as work_mem,current_setting('max_connections')as max_connections`;
 assert.equal(settings[0].fsync,'on');assert.equal(settings[0].synchronous_commit,'on');
 const statements=await db`select queryid::text,calls,total_exec_time,total_plan_time,mean_exec_time,rows,shared_blks_hit,shared_blks_read,temp_blks_written,
 jit_generation_time,jit_inlining_time,jit_optimization_time,jit_emission_time,left(query,1800)as normalized_query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
 and query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 35`;
 const active=await db`select pid,state,wait_event_type,wait_event,extract(epoch from(clock_timestamp()-query_start))as age_seconds,left(query,4000)as query from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid()`;
 const written=noteEvidence(()=>writeFileSync(join(out,'database-'+label+'.json'),JSON.stringify({settings,statements,active},null,2)));
 if(written.state==='failed')throw written.reason;
}
async function verifyAudit(){
 try{
  nativeAuditClient=performanceNativeDbClient(await import('../../db/client.ts'));
  acquired.audit='acquired';
 }catch(reason){acquired.audit='failed';throw reason;}
 const {verifyTenantChain}=await import('../../core/audit-chain.ts');
 report.auditVerification=[];
 for(const actor of fixture.users.filter(user=>user.role==='groupHR')){
  const [principal]=await db`select tenant_id,grants from app.principal(${actor.userId}::uuid)`;
  assert(principal&&Array.isArray(principal.grants),'actual native audit principal missing');
  const result=await verifyTenantChain({tenantId:principal.tenant_id,userId:actor.userId,personId:actor.personId,
   roles:[...new Set(principal.grants.map(grant=>grant.role))],grants:principal.grants});
  report.auditVerification.push({tenant:actor.tenant,...result});save();
  const expectedPrefix=fixture.tenants[actor.tenant]?.auditUnchainedPrefix;
  assert.equal(expectedPrefix,1,'fixture initialization prefix must be independently checked before load');
  assert(result.valid&&result.checked>0&&result.unchained===expectedPrefix&&result.unchainedInsideChain===0,'native audit chain coverage or integrity failure');
 }
 assert.equal(report.auditVerification.length,2);
}
const employee=fixture.users.find(u=>u.role==='employee'),hr=fixture.users.find(u=>u.role==='companyHR'),group=fixture.users.find(u=>u.role==='groupHR'),manager=fixture.users.find(u=>u.role==='manager');
const primaryActors=[employee,manager,hr,group];
const roleCounts=new Map(),roleOrdinals=new Map(fixture.users.map(user=>{const ordinal=roleCounts.get(user.role)??0;roleCounts.set(user.role,ordinal+1);return [user.index,ordinal];}));
const pendingBrowserRequests=new WeakMap(),browserPdfRequests=new WeakMap();
let progressTimer,sqlProgress,browserDiagnosticTimer,contextTemplates,lastPage,mixedWorkflows;
let preflightSampler,loadedSampler,preflightWindow,loadedWindow,protectedSampler,preflightComplete=false;
let preflightCadenceClosed=false,loadedCadenceClosed=false;
const slowPilotTimers=new Set();
const samplingRequired=suite!=='claims-heavy';
function recordLockSampling(){
 if(nativePreflight){
  report.lockSampling={strict:true,scope:'Sampled application heavyweight lock waits, including advisory waits. Unobserved waits are outside this evidence.',
   preflight:protectedSampler?.evidence()??{phase:'preflight',state:'not-started',blockingSamples:null,pass:false},
   loaded:{phase:'loaded',state:'not-applicable',blockingSamples:null}};
  return;
 }
 const preflight=lockSampleEvidence(preflightSampler?.samples??[],preflightWindow);
 const loaded=lockSampleEvidence(loadedSampler?.samples??[],loadedWindow);
 const qualified=(phase,legacy,closed)=>{
  const cadence=developmentLockWindowEvidence(phase,legacy.samples,legacy.window,closed);
  return {...legacy,cadence,coveragePass:cadence.coveragePass,pass:cadence.pass,blockingSamples:cadence.blockingSamples};
 };
 report.lockSampling={strict:samplingRequired,scope:'Sampled application heavyweight lock waits, including advisory waits. Unobserved waits are outside this evidence.',
  preflight:measureDevelopment?qualified('preflight',preflight,preflightCadenceClosed):preflight,
  loaded:measureDevelopment?qualified('loaded',loaded,loadedCadenceClosed):loaded};
}
function startPreflightLockSampling(lockScope){
 preflightWindow={startMs:performance.now()};
 preflightSampler=sampleDatabaseLocks(lockScope,'preflight',250);
}
async function finishPreflightLockSampling(){
 preflightWindow.endMs??=performance.now();
 await preflightSampler.stop();
 if(measureDevelopment)preflightCadenceClosed=true;
 recordLockSampling();
 if(samplingRequired)assert(report.lockSampling.preflight.pass,'Preflight lock samples were incomplete or observed blocking');
}
async function startProtectedPreflightLockSampling(){
 // The issuer retains the held connection. Its terminal result must reflect
 // the actual query/transport drain or its own stop. Uncertainty poisons reuse.
 const {sql,identity}=nativeLockObserver;
 const expected=Object.freeze({pid:identity.pid,backendStart:identity.backendStart,databaseOid:identity.databaseOid});
 protectedSampler=createProtectedLockSampler({phase:'preflight',deadline:nativeDeadline,
  async observe(lease){
   const query=protectedLockObserverQuery(sql);
   const terminal=await nativeLockObserver.settleFixedSample(query,lease);
   if(terminal?.settlement!=='settled'||terminal.failed===true)return terminal;
   try{
    assert.equal(terminal.rows.length,1,'Protected lock observer result differs');
    // The sampler still owns count validation after its completion-time gate.
    return {settlement:'settled',...protectedLockObserverObservedCounts(terminal.rows,expected)};
   }catch(reason){return {settlement:'settled',failed:true,reason};}
  },onFailure(reason){
   nativeAdmission.close(reason);
   recordLockSampling();noteEvidence(save);
  }});
 await protectedSampler.start();
}
function stopDiagnosticAdmission(){
 for(const timer of slowPilotTimers)clearTimeout(timer);
 slowPilotTimers.clear();
 clearInterval(progressTimer);clearInterval(browserDiagnosticTimer);
 if(preflightWindow&&preflightWindow.endMs===undefined)preflightWindow.endMs=performance.now();
 const pending=[preflightSampler?.stop(),loadedSampler?.stop(),sqlProgress?.stop()];
 diagnostics.seal();
 return Promise.allSettled([...pending,diagnostics.drain()]);
}
async function prepareDatabaseLockScope(){
 const lockKeys=[];
 for(const [index,tenant]of fixture.tenants.entries()){
  for(const [kind,key]of [['access-configuration','access-configuration:'+tenant.tenantId],['payroll-history','payroll-history:'+tenant.tenantId],['pay-component-catalog',tenant.tenantId+':pay-component-catalog']])lockKeys.push({label:kind+':fixture-tenant-'+index,key});
 }
 for(const user of fixture.users)lockKeys.push({label:'employment:fixture-user-'+user.index,key:fixture.tenants[user.tenant].tenantId+':'+user.employmentId});
 const hashedLocks=await db`select k,((hashtextextended(k,0)>>32)&4294967295)::text as classid,(hashtextextended(k,0)&4294967295)::text as objid, (select oid::text from pg_database where datname=current_database()) as dbid from unnest(${lockKeys.map(row=>row.key)}::text[])k`;
 const labelsByKey=new Map(lockKeys.map(row=>[row.key,row.label])),lockLabels=new Map(hashedLocks.map(row=>[row.classid+':'+row.objid+':1',labelsByKey.get(row.k)]));
 // Audit's native key uses hashtext (int4), unlike the other bigint advisory namespaces.
 for(const [index,tenant]of fixture.tenants.entries()){
  const [row]=await db`select ((hashtext(${'audit-chain:'+tenant.tenantId})::bigint>>32)&4294967295)::text as classid,
    (hashtext(${'audit-chain:'+tenant.tenantId})::bigint&4294967295)::text as objid,
    (hashtext('ai-control')::bigint&4294967295)::text as ai_classid,
    (hashtext(${tenant.tenantId})::bigint&4294967295)::text as ai_objid`;
  lockLabels.set(row.classid+':'+row.objid+':1','audit-chain:fixture-tenant-'+index);
  lockLabels.set(row.ai_classid+':'+row.ai_objid+':2','ai-control:fixture-tenant-'+index);
 }
 const accessLocks=[...lockLabels].filter(([,label])=>label.startsWith('access-configuration:')).map(([key])=>key);
 if(measureDevelopment){
  const databaseOid=hashedLocks[0]?.dbid;
  const familyKeys=[...lockLabels].map(([key,label])=>[databaseOid+':'+key,label.split(':',1)[0]]);
  if(/^\d{1,10}$/.test(databaseOid)&&familyKeys.length<=1024)try{
   writeFileSync(join(process.env.PERF_PRIVATE_DIR,'diagnostic-lock-families.json'),JSON.stringify(familyKeys),{flag:'wx',mode:0o600});
  }catch{/* Optional topology labels never determine acceptance. */}
 }
 return {lockLabels,accessLocks};
}

const waits=[];
let preflightAttributionPhase='pilot-http';
function sampleDatabaseLocks({lockLabels,accessLocks},phase,interval){
 const rootStatements=new Map(),samples=[];
 let attributedSamples=0;
 const retain=row=>{
  // A sentinel makes over-cap evidence ineligible without growing the ledger indefinitely.
  if(!measureDevelopment||samples.length<=4096)samples.push(row);
 };
 const timer=startDriverInterval(interval,async()=>{
  const startedMs=performance.now();
  const attributionPhase=preflightAttributionPhase;
  let coreComplete=false;
  try{
   const activity=await db`select state,coalesce(wait_event_type,'CPU-or-ready') as kind,count(*)::int as connections,
      (count(*) filter(where usename='ai_hr_app'))::int as app_connections
     from pg_stat_activity where datname=current_database() and backend_type='client backend' group by 1,2`;
   const rows=activity.filter(row=>row.state==='active').map(({kind,connections})=>({kind,connections}));
   const appConnections={
    open:activity.reduce((total,row)=>total+row.app_connections,0),
    active:activity.filter(row=>row.state==='active').reduce((total,row)=>total+row.app_connections,0),
    idleInTransaction:activity.filter(row=>row.state?.startsWith('idle in transaction')).reduce((total,row)=>total+row.app_connections,0),
    waitingOnLock:activity.filter(row=>row.state==='active'&&row.kind==='Lock').reduce((total,row)=>total+row.app_connections,0),
   };
   const locks=await db`select a.pid,case when not l.granted then pg_blocking_pids(a.pid) end as blockers,l.mode,l.granted,l.classid::text,l.objid::text,l.objsubid,
     a.usename='ai_hr_app' as app_session from pg_locks l join pg_stat_activity a on a.pid=l.pid
     where a.datname=current_database()and l.database=(select oid from pg_database where datname=current_database())
       and l.locktype='advisory' and (not l.granted or (
       concat(l.classid,':',l.objid,':',l.objsubid)=any(${accessLocks}::text[])
       and (${phase==='loaded'}::boolean or l.mode='ExclusiveLock')
       )) order by l.granted,a.pid limit 40`;
   const queuedLocks=locks.filter(row=>!row.granted);
   appConnections.sampledAdvisoryWaiters=new Set(queuedLocks.filter(row=>row.app_session).map(row=>row.pid)).size;
   const pids=[...new Set([
    ...queuedLocks.flatMap(row=>row.blockers??[]),
    ...(phase==='preflight'?locks.filter(row=>row.granted).map(row=>row.pid):[]),
   ])].filter(pid=>Number.isSafeInteger(pid)&&pid>0).slice(0,20);
   // Native holder state and normalized query IDs only; never capture statement parameters.
   const holders=pids.length?await db.unsafe('select pid,state,wait_event_type,wait_event,query_id::text,extract(epoch from(clock_timestamp()-xact_start))as transaction_age_seconds from pg_stat_activity where datname=current_database()and pid in('+pids.map((_,i)=>'$'+(i+1)).join(',')+')',pids):[];
   const blockingAppSessions=Math.max(appConnections.waitingOnLock,appConnections.sampledAdvisoryWaiters);
   const wait=phase!=='preflight'||locks.length||blockingAppSessions?{at:Date.now(),phase,rows,appConnections,blockingSessions:holders,
     grantedAccessHolders:locks.filter(row=>row.granted).map(row=>({pid:row.pid,mode:row.mode,namespace:lockLabels.get(row.classid+':'+row.objid+':'+row.objsubid)})),
     advisoryWaiters:queuedLocks.map(row=>({pid:row.pid,blockers:row.blockers,mode:row.mode,namespace:lockLabels.get(row.classid+':'+row.objid+':'+row.objsubid)??'unclassified'}))}:null;
   if(wait)waits.push(wait);
   retain({state:'complete',startedMs,completedMs:performance.now(),locks:locks.length,blockingAppSessions,
    holdersRequested:pids.length,holdersObserved:holders.length,...(measureDevelopment?{appSessions:appConnections.open}:{})});
   coreComplete=true;
   if(wait&&fullDevelopmentRoutes&&phase==='preflight'&&blockingAppSessions>0&&attributedSamples<6){
    attributedSamples++;
    const attribution={phase:attributionPhase===preflightAttributionPhase?attributionPhase:'transition',...originalAdvisoryAttribution(locks,lockLabels)};
    wait.appAdvisoryAttribution=attribution;
    // Schedule separately after retaining the original sample. An attribution error cannot erase or fail it.
    try{void diagnostics.run(async()=>{
     attribution.edges=mergeAdvisoryEdges(attribution.edges,await observeSampledAdvisoryBlockers(db,queuedLocks,lockLabels));
    }).catch(()=>{});}catch{/* Optional work may already be sealed. */}
   }
   // The top-statement summary can omit rare root holders. Resolve only sampled root IDs,
   // never queued waiters or parameters; all data belongs to the fictional runner fixture.
   const queued=new Set(queuedLocks.map(row=>row.pid));
   const missing=[...new Set(holders.filter(row=>!queued.has(row.pid)&&/^-?[0-9]+$/.test(row.query_id??'')&&!rootStatements.has(row.query_id)).map(row=>row.query_id))].slice(0,128-rootStatements.size);
   if(missing.length)try{
    const statements=await db`select queryid::text,left(query,2400) as normalized_query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and queryid=ANY(${missing}::bigint[])`;
    for(const row of statements)rootStatements.set(row.queryid,{...row,firstSeenAt:Date.now()});
    noteEvidence(()=>writeFileSync(join(out,phase==='preflight'?'preflight-blocking-statements.json':'blocking-statements.json'),JSON.stringify({scope:'Normalized sampled root advisory-lock-holder queries only; no parameters; correlation is not exclusive causal attribution',maxQueries:128,statements:[...rootStatements.values()]},null,2)));
   }catch{report.blockingStatementCaptureUnavailable=true;}
  }catch(reason){
   if(coreComplete)failures.record('lock-sample-diagnostic',reason);
   else retain({state:'failed',startedMs,completedMs:performance.now(),...driverErrorFact(reason)});
  }
 },reason=>failures.record('lock-sample-diagnostic',reason));
 return {samples,stop:timer.stop};
}

async function main(){
 requireNativeBusiness();
 if(measureDevelopment)await observePostgresWaitLogging('start');
 save();await db`select pg_stat_statements_reset()`;
 const lockScope=nativePreflight?undefined:await prepareDatabaseLockScope();
 if(nativePreflight)await startProtectedPreflightLockSampling();
 else if(samplingRequired)startPreflightLockSampling(lockScope);
 const anonymous=await request(null,'/claims',undefined,307,false);assert(String(anonymous.headers.location).includes('/login'));report.boundaries.push({kind:'anonymous',passed:true});
 const claimsFormsBookmark='/admin/claims/forms';
 const claimsFormsWire=!nativePreflight&&suite==='workflow-preflight';
 if(claimsFormsWire){
  for(const actor of [employee,manager,null]){
   const response=await request(actor,claimsFormsBookmark,undefined,307,false);
   const destination=actor?'/':'/login?returnTo=%2Fadmin%2Fclaims%2Fforms';
   assert(response.headers.location===destination||response.headers.location===base+destination,'Unexpected Claims Forms denial redirect');
   report.boundaries.push({kind:'claims-forms-bookmark-denied',role:actor?.role??'anonymous',
    httpStatus:response.status,destination:actor?'home':'login',passed:true});
  }
 }
 // Bound independent preflight roles to four lanes; every role still visits its full route pool.
 const pilotResults=await runLanes(primaryActors,async user=>{
  const routes=routePool(user);
  for(const route of routes){
   const diagnostic=setTimeout(()=>{
    slowPilotTimers.delete(diagnostic);
    if(nativePreflight)return;
    diagnostics.run(async()=>{
     try{await databaseSnapshot('slow-pilot');report.slowPilotSnapshots=(report.slowPilotSnapshots??0)+1;}
     catch{report.slowPilotSnapshotFailures=(report.slowPilotSnapshotFailures??0)+1;}
    });
   },10000);
   slowPilotTimers.add(diagnostic);
   try{
    const intended=nativePreflight?nativePreflightRouteFor(user.role,user.index,route):null;
    const response=await readRoute(user,route);
    if(claimsFormsWire&&route===claimsFormsBookmark){
     assert.equal(response.content,'','Claims Forms redirect must have no response body');
     assert.equal(response.headers['cache-control'],'private, no-store','Claims Forms redirect must be private and uncached');
     report.boundaries.push({kind:'claims-forms-bookmark-admitted',role:user.role,httpStatus:response.status,
      destination:'claims',emptyBody:true,privateNoStore:true,passed:true});
    }
    report.coverage.push({role:user.role,route,status:'passed',durationMs:response.durationMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes,
     ...(intended?{actorIndex:user.index,httpStatus:response.status,redirectStatus:intended.redirectStatus}:{})});
   }
   catch(error){noteEvidence(()=>{report.coverage.push({role:user.role,route,status:'failed',reason:errorLabel(error)});save();});throw error;}
   finally{clearTimeout(diagnostic);slowPilotTimers.delete(diagnostic);}
   save();
  }
 });
 const pilotFailure=pilotResults.find(result=>result.status==='rejected');
 if(pilotFailure)throw pilotFailure.reason;
 requireCleanDriver();
 // Direct record and search fences exercise ordinary web authorization, not a test-only endpoint.
 for(const [actor,target]of [[hr,fixture.users[50]],[group,fixture.users[250]]]){
  const response=await request(actor,'/api/personnel/search?q='+encodeURIComponent(target.name));
  assert.deepEqual(JSON.parse(response.content).rows,[]);report.boundaries.push({kind:'company-or-tenant-search',role:actor.role,passed:true});
 }
 preflightAttributionPhase='browser-sign-in-navigation';
 try{
  requireNativeBusiness();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,
   args:['--host-resolver-rules=MAP localhost 127.0.0.1'],env:closedChromiumEnvironment(process.env,chromiumEnv.HOME)});
  acquired.browser='acquired';
 }catch(reason){acquired.browser='failed';throw reason;}
 ownedBrowser=observeDriverBrowser(browser,failures);
 requireCleanDriver();
 report.browserVersion=browser.version();
 browserDiagnosticTimer=setInterval(()=>noteEvidence(()=>{
  if(!lastPage||lastPage.isClosed())return;
  report.browserPendingSnapshot={at:new Date().toISOString(),requests:[...(pendingBrowserRequests.get(lastPage)?.values()??[])].slice(0,50).map(row=>({...row,elapsedMs:performance.now()-row.startedMs}))};save();
 }),5000);
 async function context(user,locale='en',signIn=false){
  let context;
  try{
  requireNativeBusiness();
  context=contexts.register(await browser.newContext({ignoreHTTPSErrors:!nativePreflight,locale}));
  developmentPageCensus?.attach(context);
  await context.addCookies([{name:'NEXT_LOCALE',value:locale,url:base}]);
  if(!signIn)await context.addCookies([{name:'__Host-aihr_internal',value:user.token,url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
  context.on('page',page=>noteEvidence(()=>{
   nativeBrowserFailures?.observe(page);
   const observe=(name,callback)=>page.on(name,(...args)=>noteEvidence(()=>callback(...args)));
   const pending=new Map(),pdfRequests=[];pendingBrowserRequests.set(page,pending);browserPdfRequests.set(page,pdfRequests);
   const pdfRequest=req=>new URL(req.url()).origin===base&&new URL(req.url()).pathname.endsWith('/pdf');
   const pdfResult=(req,outcome,extra={})=>{if(!pdfRequest(req))return;const row=pending.get(req);pdfRequests.push({path:new URL(req.url()).pathname,type:req.resourceType(),outcome,elapsedMs:row?performance.now()-row.startedMs:null,...extra});if(pdfRequests.length>40)pdfRequests.shift();};
   // Keep bounded transport facts only: no cookies, queries, file names or document bytes.
   observe('requestfinished',req=>pdfResult(req,'finished'));
   observe('requestfailed',req=>pdfResult(req,'failed',{error:req.failure()?.errorText}));
   observe('response',response=>{if(pdfRequest(response.request()))pdfResult(response.request(),'response',{status:response.status(),contentType:response.headers()['content-type'],contentLength:response.headers()['content-length']});});
   observe('request',req=>{const url=new URL(req.url());pending.set(req,{method:req.method(),path:url.origin===base?url.pathname:'<external>',sameOrigin:url.origin===base,type:req.resourceType(),startedMs:performance.now()});});
   observe('requestfinished',req=>pending.delete(req));page.on('requestfailed',req=>pending.delete(req));
   observe('response',response=>{const row=pending.get(response.request());if(row)row.status=response.status();});
   const started=new WeakMap();
   const homeRequest=req=>{const url=new URL(req.url());return url.origin===base&&url.pathname.startsWith('/api/home/')&&req.method()==='GET';};
   observe('request',req=>{if(homeRequest(req))started.set(req,performance.now());});
   observe('requestfinished',req=>{if(homeRequest(req))report.browserHomeRequests.push({role:user.role,path:new URL(req.url()).pathname,elapsedMs:performance.now()-(started.get(req)??performance.now()),outcome:'finished'});});
   observe('requestfailed',req=>{if(homeRequest(req))report.browserHomeRequests.push({role:user.role,path:new URL(req.url()).pathname,elapsedMs:performance.now()-(started.get(req)??performance.now()),outcome:'failed',error:req.failure()?.errorText});});
   observe('response',response=>{if(homeRequest(response.request())&&!response.ok())report.browserHomeRequests.push({role:user.role,path:new URL(response.url()).pathname,status:response.status(),outcome:'http-error'});});
   // Associate failures with a route and monotonic time without publishing query parameters.
   const errorContext=()=>{let path='<unavailable>';try{const url=new URL(page.url());path=url.origin===base?url.pathname:'<external>';}catch{}return {role:user.role,locale,path,atMs:performance.now()};};
   const recordError=(kind,message,error)=>report.browserErrors.push({...errorContext(),kind,error,
    ...(fullDevelopmentRoutes?{fingerprint:browserPreflightErrorFingerprint(message)}:{})});
   observe('pageerror',error=>recordError('pageerror',error.message,error.name+': '+error.message.slice(0,300)));
   observe('console',message=>{if(message.type()==='error'){const value=message.text();recordError('console',value,value.slice(0,300));}});
  }));
  return context;
  }catch(reason){notePrimary(reason);if(context)await closeContext(context);throw reason;}
 }
 async function signInToHome(page,user){
  requireNativeBusiness();
  await page.goto(base+'/login?returnTo=%2F',{waitUntil:'domcontentloaded',timeout:90000});
  const username=page.locator('input[name="username"]');
  if(!await username.isVisible()){
   const workspace=page.locator('input[name="organization"]:visible');
   await workspace.fill(user.organization);
   requireNativeBusiness();
   await page.locator('form').filter({has:workspace}).locator('button[type="submit"]').click();
  }
  await username.fill(user.username);
  const password=page.locator('input[name="password"]');
  await password.fill(user.password);
  const passwordSubmittedAt=performance.now();
  requireNativeBusiness();
  await page.locator('form').filter({has:password}).locator('button[type="submit"]').click();
  const code=page.locator('input[name="code"]');
  await code.waitFor({state:'visible',timeout:90000});
  await code.fill(await generate({strategy:'totp',secret:user.secret}));
  const mfaTransport={};
  // Embedded authentication posts to the MFA API before navigating to Home.
  function observeMfaResponse(response){
   const request=response.request(),url=new URL(request.url());
   if(url.origin!==base)return;
   if(url.pathname==='/login/api/mfa'&&request.method()==='POST'){
    mfaTransport.loginPostResponseMs??=performance.now()-mfaSubmittedAt;
   }else if(url.pathname==='/'&&request.method()==='GET'){
    mfaTransport.homeGetResponseMs??=performance.now()-mfaSubmittedAt;
   }
  }
  page.on('response',observeMfaResponse);
  const mfaSubmittedAt=performance.now();
  try{
   requireNativeBusiness();
   await page.locator('form').filter({has:code}).locator('button[type="submit"]').click();
   await page.waitForURL(url=>url.origin===base&&url.pathname==='/',{timeout:90000});
  }finally{
   page.off('response',observeMfaResponse);
  }
  const homeUrlSettledAt=performance.now();
  const session=(await page.context().cookies()).find(cookie=>cookie.name==='__Host-aihr_internal');
  assert(session&&session.value!==user.token,'browser sign-in did not establish a new session');
  return {passwordSubmittedAt,mfaSubmittedAt,homeUrlSettledAt,mfaTransport};
 }
 async function visit(page,user,path,phase='baseline',signIn=false,loadState,nativeRoute,nativeDom){
  lastPage=page;const stopHomeTracking=homeHttp.track(page,user,path);
  const trackHomePrefetch=path==='/'&&phase==='baseline'&&!signIn;
  let rscRequests=0,prefetchRequests=0;
  const observePrefetch=request=>{
   if(new URL(request.url()).origin!==base)return;
   const headers=request.headers();
   if(headers.rsc==='1')rscRequests++;
   if(headers['next-router-prefetch']!==undefined||headers['next-router-segment-prefetch']!==undefined)prefetchRequests++;
  };
  if(trackHomePrefetch)page.on('request',observePrefetch);
  const start=performance.now();let response,signInTiming,visitFailed=false,visitStage=signIn?'sign-in':'navigation';
  const contentWitness=nativeRoute?nativePreflightContentWitness(user.role,path):null;
  const deadline=nativeRoute?Math.min(renderedDeadline,start+90000):null;
  const timeout=(limit=90000)=>deadline===null?limit:Math.min(limit,nativeRemaining(deadline));
  let witness=null,redirectStatus=null,nativeEvidenceRule=null,nativeEvidenceDom=null,browserFactsBefore=null;
  const startedWith=loadState?.();
  try{
   requireNativeBusiness();
   const browserFailuresBefore=nativeRoute?renderedPageEvents.pageCount(page):0;
   if(nativeRoute){
    browserFactsBefore=renderedPageEvents.pageFacts(page);
    nativeEvidenceRule='document';
    assert(!signIn&&nativeDom);
    requireNativePreflightFixtureDay(contentWitness,fixture.today);
    nativeDom.beforeNavigation();
   }
   if(signIn)signInTiming=await signInToHome(page,user);
   // Readiness is proved below. Network-idle adds an unrelated500ms quiet window.
   else response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:timeout()});
  visitStage='page-content';
  if(nativeRoute)nativeEvidenceRule='status';
  if(response)assert.equal(response.status(),200);
   if(nativeRoute){
    nativeEvidenceRule='route';
    assert(response&&response.url()===base+nativeRoute.final,'Native rendered response address differs');
    const request=response.request(),prior=request.redirectedFrom();
    const exactDevelopmentDocument=(reply,url)=>{
     const navigation=reply.request();
     return reply.url()===url&&!reply.fromServiceWorker()&&navigation.url()===url&&navigation.method()==='GET'
      &&navigation.isNavigationRequest()&&navigation.resourceType()==='document'&&navigation.frame()===page.mainFrame();
    };
    if(fullDevelopmentRoutes)assert(exactDevelopmentDocument(response,base+nativeRoute.final),
     'Full development rendered response is not the exact document');
    nativeEvidenceRule='redirect';
    if(nativeRoute.redirectStatus!==null){
     assert(prior&&!prior.redirectedFrom()&&prior.url()===base+path,'Native compatibility redirect chain differs');
     const redirect=await prior.response();assert(redirect,'Native compatibility redirect response missing');
     if(fullDevelopmentRoutes)assert(prior.redirectedTo()===request&&exactDevelopmentDocument(redirect,base+path),
      'Full development rendered redirect is not the exact document');
     assertNativePreflightRedirect(path,redirect.status(),redirect.headers().location);redirectStatus=redirect.status();
    }else assert(!prior,'Unexpected native preflight route redirect');
    nativeEvidenceRule=null;
   }
   assert(!new URL(page.url()).pathname.startsWith('/login'));
   if(nativeRoute)await page.locator('main').waitFor({timeout:timeout(30000)});else await page.locator('main').waitFor();
   assert((await page.locator('body').innerText(nativeRoute?{timeout:timeout(30000)}:undefined)).includes(user.name));
  visitStage='heading';
  const headingElement=page.locator('main h1:visible').first();
   await headingElement.waitFor({state:'visible',timeout:timeout()});
   const heading=(await headingElement.innerText(nativeRoute?{timeout:timeout(30000)}:undefined)).trim();assert(heading.length>0&&!/^404\b/.test(heading),'missing or not-found page heading');
  const skip=page.getByRole('dialog').getByRole('button',{name:'Skip',exact:true});
   if(await skip.isVisible()){requireNativeBusiness();await skip.click(nativeRoute?{timeout:timeout(30000)}:undefined);await skip.waitFor({state:'hidden',...(nativeRoute?{timeout:timeout(30000)}:{})});report.onboardingTourDismissals=(report.onboardingTourDismissals??0)+1;}
  visitStage='table-data';
  if(await page.locator(busyScreenSelector).count())rejectBusyPage(user,path,'browser');
  if(['/claims','/admin/personnel','/payroll'].includes(path)){
   // Next can attach the streamed table in a hidden subtree before replacing
   // the loading shell. Only rendered rows establish user-visible readiness.
   const rows=page.locator('main tbody tr:visible');
   if(path==='/admin/personnel'){
    const busy=page.locator(busyScreenSelector);
    await rows.or(busy).first().waitFor({state:'attached',timeout:timeout()});
    if(await busy.count()){
     const reason=await busy.first().getAttribute('data-personnel-busy');
     visitStage=reason==='access-lock'?'personnel-access-lock':'personnel-statement-timeout';
     rejectBusyPage(user,path,'browser');
    }
   }
   await rows.first().waitFor({state:'visible',timeout:timeout()});
   if(await page.locator(busyScreenSelector).count())rejectBusyPage(user,path,'browser');
  }
  if(path==='/me/payslip'){
   visitStage='payslip-statement';
   // The heading can stream before the actual statement. Keep the existing90s ceiling
   // and prove the real document control exists before taking identity/readiness snapshots.
   await page.getByRole('link',{name:'Download PDF',exact:true}).waitFor({state:'visible',timeout:timeout()});
  }
  if(path==='/analytics'){
   visitStage='analytics-metrics';
   const metrics=page.locator('main [data-analytics-metric]');
   const metricKeys=['activeHeadcount','newHires','terminations','turnoverRate'],observed={};
   for(const key of metricKeys){
    const value=page.locator('main [data-analytics-metric="'+key+'"] [data-analytics-value]');
    await value.waitFor({state:'visible',timeout:timeout()});
    observed[key]=(await value.innerText()).trim();
    assert((key==='turnoverRate'?/^-?\d+(?:\.\d+)?%$/:/^\d+$/).test(observed[key]),'Analytics '+key+' must display a usable value');
   }
   assert.deepEqual(await metrics.evaluateAll(rows=>rows.map(row=>row.getAttribute('data-analytics-metric')).sort()),[...metricKeys].sort(),'Analytics metric inventory incomplete');
   const rewardDraft=fixture.tenants[user.tenant].rewardDraft;
   const rewardEmployee=rewardDraft&&(user.role==='groupHR'||rewardDraft.companyId===user.companyId)?1:0;
   const expected=fixture.users.filter(actor=>actor.tenant===user.tenant&&(user.role==='groupHR'||actor.companyId===user.companyId)).length+rewardEmployee;
   assert.equal(observed.activeHeadcount,String(expected),'Analytics headcount must match the independently seeded company/tenant population');
   await page.locator('main form[method="get"] select[name="companyId"]').waitFor({state:'visible',timeout:timeout()});
   assert.equal(await page.locator('main [role="alert"], main [data-read-unavailable]').count(),0,'Analytics rendered an unavailable state');
   witness='analytics-fixture-metrics';
   (report.analyticsReadiness??=[]).push({role:user.role,phase,expectedHeadcount:expected,renderedMetrics:Object.keys(observed).length,startedWith,usableWith:loadState?.()});save();
  }
  if(path==='/roster'){
   visitStage='roster-scoped-grid';
   const rows=page.locator('main [data-roster-grid] tbody tr[data-roster-employment-id]:visible');
   await rows.first().waitFor({state:'visible',timeout:timeout()});
   const rendered=await rows.evaluateAll(elements=>elements.map(row=>({id:row.getAttribute('data-roster-employment-id'),text:row.textContent??''})));
   assert(rendered.length>0&&rendered.length<=25,'default Roster must render a bounded nonempty employee page');
   assert.equal(new Set(rendered.map(row=>row.id)).size,rendered.length,'Roster employee rows must be unique');
   const allowed=fixture.users.filter(actor=>actor.tenant===user.tenant&&(user.role==='groupHR'||actor.companyId===user.companyId));
   const reward=fixture.tenants[user.tenant].rewardDraft;
   for(const row of rendered){
    const actor=allowed.find(actor=>actor.employmentId===row.id);
    const rewardAllowed=reward&&row.id===reward.employmentId&&(user.role==='groupHR'||reward.companyId===user.companyId);
    assert(actor||rewardAllowed,'Roster rendered an employee outside its independently seeded company/tenant scope');
    if(actor)assert(row.text.includes(actor.name),'Roster row omitted the expected employee name');
   }
   assert.equal(await page.locator('main [role="alert"], main [data-read-unavailable]').count(),0,'Roster rendered an unavailable state');
   witness='roster-scoped-employments';
   (report.rosterReadiness??=[]).push({role:user.role,phase,renderedEmployees:rendered.length,scopeVerified:true,startedWith,usableWith:loadState?.()});save();
  }
  if(path==='/admin/job-descriptions'){
   visitStage='job-description-read-controls';
   const filter=page.locator('main form input[name="q"]'),create=page.locator('main a[href="/admin/job-descriptions/new"]');
   await filter.waitFor({state:'visible',timeout:timeout()});
   await create.waitFor({state:'visible',timeout:timeout()});
   assert(await page.locator('main table thead th:visible').count()>=7,'Job Description listing did not render its complete table');
   assert.equal(await page.locator('main [role="alert"], main [data-read-unavailable]').count(),0,'Job Description listing rendered an unavailable state');
   if(nativeRoute)assert(await filter.isEnabled({timeout:timeout()})&&await create.isEnabled({timeout:timeout()}),'Job Description controls are unavailable');
   witness='job-description-controls';
   (report.jobDescriptionReadiness??=[]).push({role:user.role,phase,filterReady:true,createReady:true,startedWith,usableWith:loadState?.()});save();
  }
  if((suite==='whole-system'||fullDevelopmentRoutes&&nativeRoute)&&path==='/lifecycle'&&['companyHR','groupHR'].includes(user.role)){
   visitStage='lifecycle-staff-tiles';
   const open=user.role==='groupHR'?2:user.company<2?1:0,pending=user.role==='groupHR'||user.company===0?1:0;
   for(const [href,count] of [['/lifecycle/requisitions',open],['/lifecycle/requisitions?approval=pending',pending]]){
    await page.locator('main a[href="'+href+'"]').getByText(String(count),{exact:true}).waitFor({state:'visible',timeout:timeout()});
   }
   (report.lifecycleStaffHub??=[]).push({phase,role:user.role,open,pending});save();
  }
  let homeCards=null,homeCardIds=[],todaySectionIds=[],cardFailures=0;
  visitStage='home-cards';
  if(path==='/'||(path==='/me/calendar'&&['employee','manager'].includes(user.role))){
   const personal=['employee','manager'].includes(user.role),attribute=personal?'data-home-card':'data-dashboard-card';
   const cards=page.locator('main ['+attribute+']');
   await cards.first().waitFor({timeout:timeout()});
   await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:timeout()});
   const failures=await page.locator('main [role="alert"], main [data-today-unavailable], main [data-read-unavailable]').allTextContents();
   if(path==='/'){todaySectionIds=await page.locator('main [data-today-section]').evaluateAll(sections=>sections.map(section=>section.getAttribute('data-today-section')).sort());assert(todaySectionIds.length>0,'current Today sections missing');}
   cardFailures=failures.length;
   if(cardFailures)report.homeCardFailures.push({role:user.role,phase,messages:failures});
   // Keep collecting independent workflow and load evidence. A handled card error
   // still fails the run even if the other journeys meet their targets.
   homeCardIds=await cards.evaluateAll((cards,attribute)=>cards.map(card=>card.getAttribute(attribute)).sort(),attribute);
   if(path==='/'){
    const expectedCards=personal?['calendar','celebrations','notices','summary','tasks','team','timeOff','today']:
     ['attendanceOverview','companies','headcount','headcountByCompany','latestPayroll','latestPayrollRun','noticeBoard','pendingLeave','recentActivity','recentlyJoined','upcomingEvents'];
    assert.deepEqual(homeCardIds,[...expectedCards].sort(),'fictional Home must render every expected card');
    if(cardFailures===0)witness='home-card-inventory';
   }
   if(!personal){
    const rewardDraft=fixture.tenants[user.tenant].rewardDraft;
    const extraRewardEmployee=rewardDraft&&(user.role==='groupHR'||rewardDraft.companyId===user.companyId)?1:0;
    const expected=fixture.users.filter(actor=>actor.tenant===user.tenant&&(user.role==='groupHR'||actor.companyId===user.companyId)).length+extraRewardEmployee;
    assert(await page.locator('[data-dashboard-card="headcount"]').getByText(String(expected),{exact:true}).count()>0,'HR dashboard headcount must match its actual fixture scope');
   }
   homeCards=homeCardIds.length;assert(homeCards>0,'expected fictional Home cards');
   if(signIn){
    const baseline=report.browser.find(row=>row.phase==='baseline'&&row.role===user.role&&row.path==='/');
    assert.deepEqual(homeCardIds,baseline?.homeCardIds,'loaded sign-in Home card inventory changed');
    assert.deepEqual(todaySectionIds,baseline?.todaySectionIds,'loaded sign-in Today section inventory changed');
   }
  }
  visitStage='navigation-timing';
  const timing=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {ttfbMs:n.responseStart-n.requestStart,domInteractiveMs:n.domInteractive,decodedBytes:n.decodedBodySize,transferBytes:n.transferSize};});
  if(nativeRoute){
   visitStage='native-primary-rendered-evidence';
   nativeEvidenceRule='identity';
   const account=page.locator('button[data-tour="account"]'),signedInName=account.getByText(user.name,{exact:true});
   await signedInName.first().waitFor({state:'visible',timeout:timeout()});
   assert(await account.count()===1&&await account.isEnabled({timeout:timeout()})&&await signedInName.count()===1
    &&await signedInName.innerText({timeout:timeout()})===user.name,'Native rendered route account differs');
   let view=null;
   if(nativeRoute.view!==null){
    nativeEvidenceRule='view';
    const views=page.locator('main [data-ai-centre]:visible');
    await views.first().waitFor({state:'visible',timeout:timeout()});
    assert.equal(await views.count(),1,'Native Assistant selected view is ambiguous');
    view=await views.first().getAttribute('data-ai-centre',{timeout:timeout()});
   }
   nativeEvidenceRule='witness';
   if(contentWitness!==null){
    witness=await verifyNativePreflightContent(page,contentWitness,{
     actorIndex:user.index,actorName:user.name,seedToday:fixture.today,
     historicalPayrollMonth:performanceFixtureCalendar(fixture.today).historicalMonth,
     peerName:fixture.users[5]?.name,foreignName:fixture.users[254]?.name,
     companyIds:fixture.tenants[0]?.companies?.map(company=>company.companyId),
    },timeout);
   }
   nativeEvidenceRule='document';
   const observed=await nativeDom.snapshot(timeout);
   nativeEvidenceDom=observed;
   nativeEvidenceRule='witness';requireNativePreflightFixtureDay(contentWitness,fixture.today);
   nativeEvidenceRule='deadline';timeout();
   nativeEvidenceRule='route';
   assert.equal(page.url(),base+nativeRoute.final,'Native rendered route or query changed after readiness');
   const row={role:user.role,actorIndex:user.index,requested:path,final:page.url().slice(base.length),status:response.status(),redirectStatus,
    accountObserved:true,readiness:nativePreflightReadiness(witness),witness,view,elapsedMs:performance.now()-start,
    failureCount:renderedPageEvents.pageCount(page)-browserFailuresBefore+observed.busy+observed.unavailable+observed.alerts};
   nativeEvidenceRule='shape';
   assertNativeRenderedVisit(row);renderedReport.observations.push(row);
  }
  if(signIn){
   const cardsCheckedAt=performance.now();
   const result={phase,role:user.role,homeCards,homeCardIds,todaySectionIds,elapsedMs:cardsCheckedAt-start,
    startedWith,cardsCheckedWith:loadState?.(),
    passwordSubmitToCardsCheckedMs:cardsCheckedAt-signInTiming.passwordSubmittedAt,
    mfaSubmitToHomeUrlMs:signInTiming.homeUrlSettledAt-signInTiming.mfaSubmittedAt,
    mfaTransport:signInTiming.mfaTransport,
    mfaSubmitToCardsCheckedMs:cardsCheckedAt-signInTiming.mfaSubmittedAt,
    completeCardInventory:true,cardFailures};
   if(cardFailures===0){
    result.allCardsReadyWith=result.cardsCheckedWith;
    result.passwordSubmitToAllCardsMs=result.passwordSubmitToCardsCheckedMs;
    result.mfaSubmitToAllCardsMs=result.mfaSubmitToCardsCheckedMs;
   }
   const key=phase==='loaded'?'loadedBrowserSignIns':'preflightBrowserSignIns';
   (report[key]??=[]).push(result);
   if(phase==='loaded'&&user.index===employee.index)report.loadedBrowserSignIn=result;
   save();
  }
  report.browser.push({phase,role:user.role,path,heading,homeCards,homeCardIds,todaySectionIds,startedWith,elapsedMs:performance.now()-start,...timing});save();
  }catch(error){
   visitFailed=true;
   failures.notePrimary(error);
   await failures.attempt('visit-diagnostic',async()=>{
   const nativeEvidence=nativeEvidenceRule&&browserFactsBefore?{
    rule:nativeRenderedVisitFailureRule(error)??nativeEvidenceRule,
    browser:Object.fromEntries(Object.entries(renderedPageEvents.pageFacts(page)).map(([kind,count])=>[kind,count-browserFactsBefore[kind]])),
    dom:nativeEvidenceDom,
   }:null;
   const detail={phase,role:user.role,user:user.index,path,errorType:driverErrorFact(error).kind,visitStage,startedWith,...browserFailureLocation(error),elapsedMs:performance.now()-start,
    nativeEvidence,
    pdfRequests:browserPdfRequests.get(page)??[],
    frames:page.frames().map(frame=>{try{const url=new URL(frame.url());return {sameOrigin:url.origin===base,path:url.origin===base?url.pathname:'<other>'};}catch{return {path:'<unavailable>'};}}),dom:null};
   // Promise.all shutdown can make other pages fail later. Preserve the actual first visit.
   report.browserFailedNavigation??=detail;
   (report.browserVisitFailures??=[]).push({phase,role:user.role,user:user.index,path,errorType:driverErrorFact(error).kind,visitStage,...browserFailureLocation(error)});
   report.browserPendingRequests=[...(pendingBrowserRequests.get(page)?.values()??[])].map(row=>({...row,elapsedMs:performance.now()-row.startedMs}));
   detail.dom=await page.locator('body').evaluate(body=>({readyState:document.readyState,headingCount:body.querySelectorAll('h1').length,mainCount:body.querySelectorAll('main').length,
    iframeCount:body.querySelectorAll('iframe').length,busyCount:body.querySelectorAll('[aria-busy="true"]').length,alertCount:body.querySelectorAll('[role="alert"]').length}),undefined,{timeout:3000}).catch(()=>null);
   save();
   });
   throw error;
  }finally{
   const home=noteEvidence(stopHomeTracking);
   const prefetch=trackHomePrefetch?noteEvidence(()=>{
    page.off('request',observePrefetch);
    (report.homeNavigationPrefetch??=[]).push({role:user.role,rscRequests,prefetchRequests});
    save();
   }):null;
   if(!visitFailed){
    if(home.state==='failed')throw home.reason;
    if(prefetch?.state==='failed')throw prefetch.reason;
   }
  }
 }
 function claimDraftForm(page){
  // Scope interactions to the active composer, excluding retained/overlay form copies.
  // Keep strict matching: two active composers must still fail rather than choose arbitrarily.
  return page.locator('main [data-tour="claims-compose"]:visible form:visible')
   .filter({has:page.locator('button[name="intent"][value="draft"]:visible')});
 }
 async function languageJourney(page,user,path,phase,loadState){
  const catalog=locale=>JSON.parse(readFileSync(new URL('../../messages/'+locale+'.json',import.meta.url),'utf8'));
  const names={zh:'简体中文',en:'English'};
  const draft=path==='/claims'
   ?claimDraftForm(page).and(page.locator('[data-claim-form-ready="true"]')).locator('textarea[name="description"]:visible')
   :null;
  let draftReadyWaitMs;
  if(draft){
   const readyStarted=performance.now();
   await draft.waitFor({state:'visible',timeout:90000});
   draftReadyWaitMs=performance.now()-readyStarted;
   await draft.fill('PERF_UNSUBMITTED_LANGUAGE_DRAFT');
  }
  for(const locale of ['zh','en']){
   requireNativeBusiness();
   await page.getByRole('button',{name:'Change language',exact:true}).click();
   const start=performance.now(),startedWith=loadState?.();
   requireNativeBusiness();
   await page.getByRole('button',{name:names[locale],exact:true}).click();
   await page.waitForFunction(({locale,title})=>{
    const button=document.querySelector('button[aria-label="Change language"]');
    return document.documentElement.lang===locale&&button?.title===title&&!button.disabled&&button.getAttribute('aria-busy')==='false';
   },{locale,title:names[locale]},{timeout:90000});
   const messages=catalog(locale),expected=path==='/claims'?messages.claims.title:messages.people.list.adminTitle;
   await page.getByRole('heading',{level:1,name:expected,exact:true}).waitFor({timeout:90000});
   await page.locator('main tbody tr').first().waitFor({state:'visible',timeout:90000});
   if(draft)assert.equal(await draft.inputValue(),'PERF_UNSUBMITTED_LANGUAGE_DRAFT','language switch discarded an unsubmitted draft');
   (report.browserLanguageSwitches??=[]).push({role:user.role,path,phase,locale,startedWith,usableWith:loadState?.(),elapsedMs:performance.now()-start,translatedHeading:true,usable:true,draftRetained:!!draft,draftReadyWaitMs});save();
  }
 }
 if(!samplingRequired)startPreflightLockSampling(lockScope);
 // These six independent read-only contexts run concurrently, matching the loaded browser bound.
 // Route/role assertions, per-request deadlines and the overall driver deadline stay unchanged.
 await lanes.run(()=>settleDriverLanes([employee,manager,hr,group,fixture.users[254],fixture.users[251]],async user=>{
  const ctx=await context(user);
  await withContext(ctx,async()=>{const page=await ctx.newPage();
  const routes=strictRenderedPreflight&&primaryActors.includes(user)?['/']:suite==='whole-system'?routePool(user):user.role==='employee'?['/','/claims','/leave','/attendance/individual']:user.role==='manager'?['/','/approvals','/performance/home']:['/','/admin/personnel','/payroll','/lifecycle/onboarding'];
  for(const route of routes)await visit(page,user,route);
  await page.screenshot({path:join(out,'browser-'+user.index+'.png'),fullPage:false});
  });
 },failures));
 if(!samplingRequired)await finishPreflightLockSampling();
 requireCleanDriver();
 // Additional concrete pages have explicit rendered checks, separate from HTTP route counts.
 if(!strictRenderedPreflight)await lanes.run(()=>settleDriverLanes(primaryActors,async user=>{
  const ctx=await context(user);
  await withContext(ctx,async()=>{const page=await ctx.newPage();for(const path of additionalBrowserRoutes[user.role]){
   // The full workload already rendered these exact role/path pairs above. Keep each
   // required rendered check, without paying for an identical duplicate document load.
   if(!report.browser.some(row=>row.phase==='baseline'&&row.role===user.role&&row.path===path))await visit(page,user,path);
   assert(report.browser.some(row=>row.phase==='baseline'&&row.role===user.role&&row.path===path),'required rendered role/path missing');
  }});
 },failures));
 requireCleanDriver();
 async function aiCentreJourney(page,user,phase){
  await visit(page,user,'/assistant',phase);
  const askStarted=performance.now();
  try{
   // The page shell may finish before the streamed Ask composer. Require the actual enabled control.
   await page.locator('main textarea[name="question"]:enabled').waitFor({state:'visible',timeout:90000});
  }catch(error){
   noteEvidence(()=>{
    (report.browserAiAskFailures??=[]).push({role:user.role,user:user.index,phase,path:new URL(page.url()).pathname,
     elapsedMs:performance.now()-askStarted});
    save();
   });
   throw error;
  }
  const documents=[];const onRequest=request=>{if(request.resourceType()==='document')documents.push(request.url());};page.on('request',onRequest);
  let navigationFailed=false;
  try{
   // Exercise the approved navigation owner: Jobs is retired, Insights is admin-only,
   // and Operations opens Loops. Keep every available tab and return to Ask at the end.
   const tabs=centreTabsFor({isAdmin:['companyHR','groupHR'].includes(user.role)});
   const targets=[...tabs.filter(tab=>tab.key!=='ask'),...tabs.filter(tab=>tab.key==='ask')].map(tab=>[tab.key,tab.href]);
   assert.equal(await page.locator('[data-ai-centre-tabs] a[href="/assistant?view=jobs"]').count(),0,'retired Jobs tab must stay absent');
   for(const [tab,path] of targets){
    const readinessStarted=performance.now();
    const link=page.locator('[data-ai-centre-tabs] a[data-ai-centre-link-ready="true"][href="'+path+'"]');
    await link.waitFor({state:'visible',timeout:90000});
    const readinessWaitMs=performance.now()-readinessStarted,expected=new URL(path,base),start=performance.now();
    requireNativeBusiness();
    await Promise.all([page.waitForURL(url=>url.pathname===expected.pathname&&url.search===expected.search,{timeout:90000}),link.click()]);
    await page.locator('[data-ai-centre-tabs] a[aria-current="page"][href="'+path+'"]').waitFor({timeout:90000});
    await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:90000});
    assert((await page.locator('main h1').innerText()).trim().length>0,'AI Centre heading unavailable');
    assert.equal(await page.locator('main [data-read-unavailable]').count(),0,'AI Centre rendered an unavailable payroll-readiness section');
    if(tab==='ask')assert(await page.locator('main textarea:enabled').count()>0,'Ask composer unavailable after navigation');
    assert.equal(documents.length,0,'AI Centre tab unexpectedly reloaded the document');
    (report.browserAiCentreNavigation??=[]).push({phase,role:user.role,path,readinessWaitMs,elapsedMs:performance.now()-start,usable:true,documentRequests:0,promptsSubmitted:0});save();
   }
   // Tools and privacy are real links outside the tab row. Exercise both Ask footer
   // navigation and the Tools shortcut, without submitting prompts or changing privacy settings.
   for(const [view,from] of [['tools','ask-footer'],['privacy','tools-shortcut'],['ask','centre-tab'],['privacy','ask-footer'],['ask','centre-tab']]){
    const path=view==='ask'?'/assistant':'/assistant?view='+view,readinessStarted=performance.now();
    const link=view==='ask'?page.locator('[data-ai-centre-tabs] a[data-ai-centre-link-ready="true"][href="/assistant"]'):page.locator('main a[data-ai-centre-link-ready="true"][href="'+path+'"]:visible').first();
    await link.waitFor({state:'visible',timeout:90000});
    const readinessWaitMs=performance.now()-readinessStarted,expected=new URL(path,base),start=performance.now();
    requireNativeBusiness();
    await Promise.all([page.waitForURL(url=>url.pathname===expected.pathname&&url.search===expected.search,{timeout:90000}),link.click()]);
    await page.locator('main [data-ai-centre="'+view+'"]').waitFor({timeout:90000});
    await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:90000});
    assert((await page.locator('main h1').innerText()).trim().length>0,'AI Centre supplemental view heading unavailable');
    assert.equal(await page.locator('main [data-read-unavailable]').count(),0,'AI Centre supplemental view unavailable');
    if(view==='tools')await page.locator('main [data-ai-centre="tools"] #ai-ask-shortcuts:visible').waitFor({timeout:90000});
    if(view==='privacy')await page.locator('#assistant-privacy').waitFor({timeout:90000});
    if(view==='ask')assert(await page.locator('main textarea:enabled').count()>0,'Ask composer unavailable after supplemental navigation');
    assert.equal(documents.length,0,'AI Centre supplemental navigation unexpectedly reloaded the document');
    (report.browserAiCentreNavigation??=[]).push({phase,role:user.role,path,from,readinessWaitMs,elapsedMs:performance.now()-start,usable:true,documentRequests:0,promptsSubmitted:0,privacyChanges:0});save();
   }
  }catch(reason){navigationFailed=true;throw reason;}
  finally{const detached=noteEvidence(()=>page.off('request',onRequest));if(!navigationFailed&&detached.state==='failed')throw detached.reason;}
  const history=fixture.assistantHistory?.[user.index];
  if(history){
   const traffic={rscRequests:0,prefetchRequests:0};
   const observe=request=>{const url=new URL(request.url());if(url.origin!==base||url.pathname!=='/assistant')return;const headers=request.headers();if(headers.rsc==='1')traffic.rscRequests++;if(headers['next-router-prefetch']==='1'||headers.purpose==='prefetch')traffic.prefetchRequests++;};
   page.on('request',observe);
   try{requireNativeBusiness();await verifyAssistantHistoryBrowser({page,history,visitAsk:()=>visit(page,user,'/assistant',phase),timeout:90000,onMeasurement:row=>{
    const totalMs=row.navigationToUsableMs??((row.clickToUsableMs??0)+(row.readinessWaitMs??0));
    (report.browserAssistantHistory??=[]).push({...row,phase,role:user.role,totalMs,targetMs:1000,targetMet:totalMs<1000});save();
   }});}catch(reason){failures.notePrimary(reason);throw reason;}
   finally{noteEvidence(()=>{page.off('request',observe);(report.assistantHistoryTraffic??=[]).push({phase,role:user.role,...traffic});save();});}
  }
 }
 function notePreflightStageFailure(reason,stage,user=null,page=null){
  if(!fullDevelopmentRoutes)return;
  notePrimary(reason);
  if(failures.primary().reason!==reason)return;
  noteEvidence(()=>{
   let path=null;
   if(page){
    const url=new URL(page.url());
    if(url.origin===base)path=url.pathname;
   }
   report.preflightBrowserStageFailure??={stage,role:user?.role??null,path,
    errorType:driverErrorFact(reason).kind,...browserPreflightFailureLocation(reason),
    clickObstruction:browserPreflightClickObstruction(reason),
    legacyNavigation:stage==='legacy-navigation-capture'?legacyNavigationFailureFacts(reason):null,
    orgExplorerStep:stage==='org-explorer-workflow'?report.orgExplorerJourneys?.at(-1)?.failure?.stage??null:null};
  });
 }
 // Exercise real password/MFA before any capacity test; these results are never loaded proof.
 const signInPreflight=await runLanes(primaryActors,async user=>{
  const ctx=await context(user,'en',true);
  await withContext(ctx,async()=>{const page=await ctx.newPage();
   await visit(page,user,'/','sign-in-preflight',true);
   let stage='legacy-navigation-capture';
   try{
    requireNativeBusiness();
    if(baselineNavigation)await baselineNavigation.captureActor(page,user.index);
    if(strictRenderedPreflight){
     stage='hidden-shell-capture';
     requireNativeBusiness();
     const failuresBefore=fullDevelopmentRoutes?renderedPageEvents.pageCount(page):null;
     if(NATIVE_HIDDEN_SHELL_CASES.some(row=>row.actorIndex===user.index))await nativeShell.captureActor(page,user.index);
     stage='primary-route-observer';
     const nativeDom=await installNativePrimaryFailureObserver(page,user.index),paths=routePool(user);
     nativePrimaryDocuments.push({actorIndex:user.index,expected:paths.length,nativeDom,page,failuresBefore});
     stage='primary-route-navigation';
     for(const path of paths){
      const route=nativePreflightRouteFor(user.role,user.index,path);
      await visit(page,user,path,'baseline',false,undefined,route,nativeDom);
     }
     stage='primary-route-retirement';
     const retirementDeadline=Math.min(renderedDeadline,performance.now()+90000);
     await nativeDom.finish(()=>nativeRemaining(retirementDeadline));
    }
   }catch(reason){
    notePreflightStageFailure(reason,stage,user,page);
    throw reason;
   }
  });
 });
 // Finish every admitted sign-in body. On failure the terminal sweep still owns
 // every native context-close outcome.
 for(const result of signInPreflight)if(result.status==='rejected')throw result.reason;
 preflightAttributionPhase='browser-workflows';
 let baselineCapture,sealStage='pre-render-settlement';
 try{
  requireCleanDriver();
  sealStage='legacy-navigation-seal';
  baselineCapture=baselineNavigation?.finish();
  if(measureDevelopment&&baselineCapture)developmentNavigationBinding=baselineCapture;
  sealStage='rendered-union-validation';
  if(strictRenderedPreflight)renderedReport.union=requireNativeRenderedUnion(renderedReport.observations);
 }catch(reason){
  notePreflightStageFailure(reason,sealStage);
  throw reason;
 }
 report.navigationCapture={scope:'DEVELOPMENT_ONLY',releaseEligible:false,baselineScenarios:baselineCapture?.observations.length??0,loadedScenarios:0};save();
 // Handled card failures remain a failed acceptance gate. Keep collecting the
 // isolated workload evidence after every role completed a real sign-in.
 report.preflightHomeReady=['employee','manager','companyHR','groupHR'].every(role=>
  report.preflightBrowserSignIns?.some(row=>row.role===role&&row.homeCards>0&&row.todaySectionIds.length>0&&row.cardFailures===0));
 save();
 const aiBrowserActors=fixture.assistantHistory?[employee,hr,fixture.users[254],fixture.users[251]]:[employee,hr];
 const aiBaseline=await runLanes(aiBrowserActors,async user=>{
  const ctx=await context(user);
  await withContext(ctx,async()=>{const page=await ctx.newPage();await aiCentreJourney(page,user,'baseline');});
 });
 report.aiBaselineFailures=aiBaseline.flatMap((result,index)=>result.status==='rejected'
  ?[{role:aiBrowserActors[index].role,userIndex:aiBrowserActors[index].index,error:errorLabel(result.reason)}]:[]);
 save();
 requireCleanDriver();
 if(suite==='whole-system'||strictRenderedPreflight){
  const ctx=await context(group);
  await withContext(ctx,async()=>{const page=await ctx.newPage();
   let stage='org-explorer-workflow';
   try{
    requireNativeBusiness();
    await exerciseOrgExplorer({page,user:group,fixture,report,save,phase:'baseline'});
    stage='personnel-switcher-workflow';
    requireNativeBusiness();
    await exercisePersonnelSwitcher({page,user:group,fixture,report,save,phase:'baseline'});
    stage='payroll-readiness-workflow';
    requireNativeBusiness();
    await exercisePayrollBrowser({base,page,user:group,fixture,report,save,phase:'baseline'});
   }catch(reason){notePreflightStageFailure(reason,stage,group,page);throw reason;}
  });
  requireCleanDriver();
 }
 if(suite==='whole-system'||suite==='workflow-preflight'){
  const ctx=await context(group);
  await withContext(ctx,async()=>{const page=await ctx.newPage();
   requireNativeBusiness();
   await exerciseMovement({base,page,actor:group,subject:employee,fixture,db,report,save,phase:'baseline',recordEvent:suite==='workflow-preflight'});
   requireNativeBusiness();
   await exercisePayrollRegister({base,page,user:group,fixture,db,request,report,save});
   requireNativeBusiness();
   await exerciseSavedReport({page,user:group,fixture,db,base,phase:'baseline',thinkTimeMs,report,save});
  });
  requireCleanDriver();
  const foreignGroup=fixture.users.find(user=>user.role==='groupHR'&&user.tenant!==group.tenant);
  assert(foreignGroup,'Payroll register needs a foreign group HR boundary actor');
  for(const actor of [hr,foreignGroup]){
   const boundaryContext=await context(actor);
   await withContext(boundaryContext,async()=>{const boundaryPage=await boundaryContext.newPage();await verifyPayrollRegisterBoundary({base,page:boundaryPage,actor,owner:group,fixture,report,save});});
   requireCleanDriver();
  }
 }
 // Tenant-wide AI spend and provider configuration keep their group-administrator guards.
 {
  const ctx=await context(hr);
  await withContext(ctx,async()=>{const page=await ctx.newPage();for(const path of ['/control-tower/agents/spending','/control-tower/agents/provider']){
   requireNativeBusiness();
   await page.goto(base+path,{waitUntil:'networkidle',timeout:90000});
   await page.waitForURL(url=>url.pathname==='/control-tower/agents',{timeout:90000});
   report.boundaries.push({kind:'AI group-administrator-only route',role:hr.role,path,redirectDenied:true});save();
  }
  if(suite==='whole-system'||strictRenderedPreflight){
   requireNativeBusiness();
   await exercisePayrollBrowser({base,page,user:hr,fixture,report,save,phase:'baseline'});
  }
  });
  requireCleanDriver();
 }
 // Locale projection and real client navigation must work before any capacity claim.
 for(const locale of ['en','ms','zh','ta','th','vi']){
  const ctx=await context(employee,locale);
  await withContext(ctx,async()=>{const page=await ctx.newPage();await visit(page,employee,'/claims');
  const messages=JSON.parse(readFileSync(new URL('../../messages/'+locale+'.json',import.meta.url),'utf8'));
  const fallback=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
  const title=messages.claims?.title||fallback.claims.title;
  await page.getByRole('heading',{level:1,name:title,exact:true}).waitFor({state:'visible',timeout:90000});
  report.browser.at(-1).locale=locale;
  });
  requireCleanDriver();
 }
 {
  const ctx=await context(employee);
  await withContext(ctx,async()=>{const page=await ctx.newPage();await visit(page,employee,'/leave');
  const documents=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
  requireNativeBusiness();
  await Promise.all([page.waitForURL(url=>url.pathname==='/claims',{timeout:90000}),page.locator('a[href="/claims"]:visible').first().click()]);
  const catalog=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
  const heading=page.getByRole('heading',{level:1,name:catalog.claims.title,exact:true});
  const main=page.locator('main:visible').filter({has:heading});
  await heading.waitFor({state:'visible',timeout:90000});
  await claimDraftForm(page).locator('textarea[name="description"]:visible').waitFor();
  assert.equal(documents.length,0,'client link unexpectedly reloaded the document');
  assert(await main.locator('tbody tr:visible').count()>0,'client route has no visible Claims rows');
  assert((await main.innerText()).includes(catalog.claims.typeLabel),'client form lost route translations');
  report.browser.push({workflow:'client navigation',from:'/leave',to:'/claims',documentRequests:0,passed:true});
  });
  requireCleanDriver();save();
 }
 for(const [user,path]of [[employee,'/claims'],[hr,'/admin/personnel']]){
  const ctx=await context(user);
  await withContext(ctx,async()=>{const page=await ctx.newPage();await visit(page,user,path);await languageJourney(page,user,path,'baseline');});
  requireCleanDriver();
 }
 // Capture progressive-enhancement action metadata from the actual built form. No hardcoded action ID.
 async function capturedAction(response){
  const req=response.request();const raw=req.postDataBuffer();assert(raw,'missing browser action payload');
  const form=await new Request(base+'/claims',{method:'POST',headers:{'Content-Type':req.headers()['content-type']},body:raw}).formData();
  const pairs=[...form].filter(([,value])=>typeof value==='string'),fieldOrder=pairs.map(([key])=>key);
  assert.equal(new Set(fieldOrder).size,fieldOrder.length,'duplicate action fields need a richer replay contract');
  const fields=Object.fromEntries(pairs);
  const key=Object.keys(fields).find(key=>key==='claimTypeId'||key==='id'||key.endsWith('_claimTypeId')||key.endsWith('_id'));
  assert(key,'unrecognized real browser action fields');
  const suffix=key.endsWith('claimTypeId')?'claimTypeId':'id',prefix=key.slice(0,-suffix.length);
  const headers={};for(const key of ['accept','next-action','next-router-state-tree'])if(req.headers()[key])headers[key]=req.headers()[key];
  assert(headers['next-action'],'browser server action header missing');
  return {fields,fieldOrder,prefix,headers,status:response.status()};
 }
 async function ownClaimDraft(scope,user,description,work,restore){
  if(!claimCustody)return work();
  const custody=claimCustody.register(scope,{actorIndex:user.index,employmentId:user.employmentId,marker:description});
  try{return await work(custody);}
  catch(reason){
   nativeAdmission.close(reason);
   if(custody.canRestore())await failures.attempt('claim-restoration',()=>restore(custody));
   throw reason;
  }
 }
 function claimRequest(user,template,fields,custody,stage){
  const attempt=custody?{beforeDispatch:()=>custody.begin(stage,user.index)}:undefined;
  return request(user,'/claims',fields,template.status,false,template.headers,template.fieldOrder,undefined,attempt);
 }
 async function browserClaimJourney(page,user,description,phase){
  await visit(page,user,'/claims',phase);const timings=[],form=claimDraftForm(page);
  const browserAction=()=>page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/claims',{timeout:90000});
  await form.locator('[name="claimTypeId"]:visible').selectOption(user.claimTypeId);await form.locator('[name="amount"]:visible').fill('1');await form.locator('[name="incurredOn"]:visible').fill(fixture.today);
  await form.locator('textarea[name="description"]:visible').fill(description);
  let started,draft,deleteTemplate;
  const requireRestore=()=>requireNativeClaimRestoration(user,draft.id);
  async function deleteDraft(custody){
   requireRestore();
   await page.locator('main form:visible').filter({has:page.locator(`input[name="id"][value="${draft.id}"]`)}).getByRole('button').click();started=performance.now();
   requireRestore();
   custody?.begin('delete');
   if(custody)requireRestore();
   const [deleteResponse]=await Promise.all([browserAction(),page.getByRole('button',{name:'Delete draft',exact:true}).click()]);
   deleteTemplate=await capturedAction(deleteResponse);
   await page.waitForURL(url=>url.searchParams.get('toast')==='Draft deleted',{timeout:90000});timings.push({operation:'delete',visibleByMs:performance.now()-started});
   assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
   custody?.verify('delete');
  }
  return ownClaimDraft('browser',user,description,async custody=>{
   started=performance.now();
   requireNativeBusiness();
   custody?.begin('create');
   if(custody)requireNativeBusiness();
   const [createResponse]=await Promise.all([browserAction(),form.locator('button[name="intent"][value="draft"]:visible').click()]);const createTemplate=await capturedAction(createResponse);
   await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});timings.push({operation:'create',visibleByMs:performance.now()-started});
   const drafts=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft' and description=${description}`;
   [draft]=drafts;assert(draft,'browser create did not persist');
   if(custody)assert.equal(drafts.length,1,'Protected browser draft identity is ambiguous');
   custody?.verify('create',draft.id);
   if(phase==='loaded')await pause(thinkTimeMs);
   requireNativeBusiness();
   await page.goto(base+'/claims?draft='+draft.id,{waitUntil:'networkidle'});await form.locator('[name="amount"]:visible').fill('2');started=performance.now();
   requireNativeBusiness();
   custody?.begin('edit');
   if(custody)requireNativeBusiness();
   await form.locator('button[name="intent"][value="draft"]:visible').click();await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});timings.push({operation:'edit',visibleByMs:performance.now()-started});
   const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
   custody?.verify('edit');
   if(phase==='loaded')await pause(thinkTimeMs);
   custody?.reserveRestore(draft.id);
   await deleteDraft(custody);
   report.browser.push({phase,role:user.role,workflow:'claim create/edit/delete',persisted:true,timings});save();return {createTemplate,deleteTemplate};
  },async custody=>{
    custody.reserveRestore(draft.id);
    requireRestore();
    await page.goto(base+'/claims',{waitUntil:'domcontentloaded',timeout:Math.min(90000,nativeRemaining(nativeDeadline))});
    await deleteDraft(custody);
  });
 }
 {
  const ctx=await context(employee);
  await withContext(ctx,async()=>{const page=await ctx.newPage();contextTemplates=await browserClaimJourney(page,employee,'PERF_BROWSER_DRAFT','baseline');});
  requireCleanDriver();
 }
 const {createTemplate,deleteTemplate}=contextTemplates;
 async function restoreKnownClaimDraft(user,draft,custody){
  const fields={...deleteTemplate.fields,[deleteTemplate.prefix+'employmentId']:user.employmentId,[deleteTemplate.prefix+'id']:draft.id};
  custody?.reserveRestore(draft.id);
  if(!custody)await request(user,'/claims',fields,deleteTemplate.status,false,deleteTemplate.headers,deleteTemplate.fieldOrder);
  else await requests.run(()=>requestBody(user,'/claims',fields,deleteTemplate.status,false,deleteTemplate.headers,deleteTemplate.fieldOrder,undefined,
   {key:claimRestorationKey,draft:draft.id,beforeDispatch:()=>custody.begin('delete',user.index)}));
  assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
  custody?.verify('delete');
 }
 assert.equal(report.browserErrors.length,0,'baseline browser errors must be fixed before load');
 const actionProtocol=template=>({fieldNames:Object.keys(template.fields),fieldOrder:template.fieldOrder,prefix:template.prefix,status:template.status,
  arguments:Object.fromEntries(Object.entries(template.fields).filter(([key])=>/^\d+$/.test(key)).map(([key,value])=>{try{return [key,JSON.parse(value)];}catch{return [key,typeof value];}}))});
 report.actionProtocol={create:actionProtocol(createTemplate),delete:actionProtocol(deleteTemplate)};save();
 // Prove the captured browser protocol can be replayed before exercising another actor or load.
 {
  const description='PERF_HTTP_PREFLIGHT',fields={...createTemplate.fields};
  for(const [key,value]of Object.entries({employmentId:employee.employmentId,claimTypeId:employee.claimTypeId,amount:'1',incurredOn:fixture.today,description,intent:'draft'}))fields[createTemplate.prefix+key]=value;
  delete fields[createTemplate.prefix+'draftId'];
  let draft;
  await ownClaimDraft('http',employee,description,async custody=>{
   const response=await claimRequest(employee,createTemplate,fields,custody,'create');
   report.actionPreflight={status:response.status,redirect:response.headers['x-action-redirect']??response.headers.location??null,
    publicErrors:[...response.content.matchAll(/"error":"([^"\n]{1,300})"/g)].map(match=>match[1]).filter(value=>value!=='$undefined')};save();
   const drafts=await db`select id from claim_request where employment_id=${employee.employmentId}::uuid and status='draft'and description=${description}`;
   [draft]=drafts;assert(draft,'same-actor HTTP action preflight did not persist');
   if(custody)assert.equal(drafts.length,1,'Protected HTTP draft identity is ambiguous');
   custody?.verify('create',draft.id);
   await restoreKnownClaimDraft(employee,draft,custody);
   report.actionPreflight.persisted=true;save();
  },custody=>restoreKnownClaimDraft(employee,draft,custody));
 }
 // Real server actions must reject another employee's draft even for broadly visible HR actors.
 // Provision and clean up through the owner's HTTP action; the independent DB oracle only reads.
 for(const [actor,victim]of [[employee,fixture.users[5]],[hr,fixture.users[54]],[group,fixture.users[254]]]){
  const description='PERF_BOUNDARY_'+actor.index,fields={...createTemplate.fields};
  for(const [key,value]of Object.entries({employmentId:victim.employmentId,claimTypeId:victim.claimTypeId,amount:'7',incurredOn:fixture.today,description,intent:'draft'}))fields[createTemplate.prefix+key]=value;
  delete fields[createTemplate.prefix+'draftId'];
  const scope=actor.tenant!==victim.tenant?'other-tenant':actor.company!==victim.company?'other-company':'same-company';
  let protectedDraft;
  await ownClaimDraft(scope,victim,description,async custody=>{
   await claimRequest(victim,createTemplate,fields,custody,'create');
   const drafts=await db`select id from claim_request where employment_id=${victim.employmentId}::uuid and status='draft' and description=${description}`;
   [protectedDraft]=drafts;assert(protectedDraft,'boundary fixture did not persist through HTTP');
   if(custody)assert.equal(drafts.length,1,'Protected boundary draft identity is ambiguous');
   custody?.verify('create',protectedDraft.id);
   for(const selector of [actor.employmentId,victim.employmentId]){
    requireNativeBusiness();
    const stage=selector===actor.employmentId?'foreign-own':'foreign-other';
    const response=await claimRequest(actor,deleteTemplate,{...deleteTemplate.fields,[deleteTemplate.prefix+'employmentId']:selector,[deleteTemplate.prefix+'id']:protectedDraft.id},custody,stage);
    const redirect=new URL(String(response.headers['x-action-redirect']??response.headers.location).split(';')[0],base);
    assert(redirect.searchParams.get('error'),'foreign draft deletion was not explicitly refused');
    const [unchanged]=await db`select employment_id,amount,status from claim_request where id=${protectedDraft.id}::uuid`;
    assert(unchanged);assert.equal(unchanged.employment_id,victim.employmentId);assert.equal(Number(unchanged.amount),7);assert.equal(unchanged.status,'draft');
    custody?.verify(stage);
    report.boundaries.push({kind:'foreign-draft-delete',role:actor.role,scope:actor.tenant!==victim.tenant?'other-tenant':actor.company!==victim.company?'other-company':'other-person',selector:selector===actor.employmentId?'own':'foreign',passed:true});
   }
   await restoreKnownClaimDraft(victim,protectedDraft,custody);
  },custody=>restoreKnownClaimDraft(victim,protectedDraft,custody));
 }
 if(suite!=='claims-heavy'){
  requireNativeBusiness();
  mixedWorkflows=await prepareMixedWorkflows({context,withContext,closeContext,notePrimary,noteEvidence,visit,fixture,employee,hr,db,request,base,report,save,thinkTimeMs});
 }
 requireCleanDriver();
 let loadedAttendanceRejection;
 if(attendanceRejectionProbeEnabled&&suite!=='claims-heavy'){
  const baseline=await prepareAttendanceRejection({context,withContext,closeContext,notePrimary,noteEvidence,visit,fixture,db,report,save,phase:'baseline'});
  requireNativeBusiness();
  await baseline.run();
  requireCleanDriver();
  if(suite==='whole-system')loadedAttendanceRejection=await prepareAttendanceRejection({context,withContext,closeContext,notePrimary,noteEvidence,visit,fixture,db,report,save,phase:'loaded'});
 }
 if(suite!=='claims-heavy'){
  const ctx=await context(employee);
  await withContext(ctx,async()=>{
  const page=await ctx.newPage();let automaticPdfRequests=0;
  const observe=req=>{if(req.method()==='GET'&&/^\/me\/payslip\/[^/]+\/pdf$/.test(new URL(req.url()).pathname))automaticPdfRequests++;};
  page.on('request',observe);
   await visit(page,employee,'/me/payslip');assert.equal(automaticPdfRequests,0,'opening the statement requested a PDF without a download click');page.off('request',observe);
   const text=await page.locator('main').innerText(),code='PERF'+String(employee.index).padStart(4,'0');
   assert(text.includes(employee.name)&&text.includes(code),'own statement identity missing');assert(/5,000\.00/.test(text),'native fixture salary missing from statement');
   const link=page.getByRole('link',{name:'Download PDF',exact:true}),href=await link.getAttribute('href');assert(/^\/me\/payslip\/[^/]+\/pdf$/.test(href??''));
   requireNativeBusiness();
   const [download]=await Promise.all([page.waitForEvent('download',{timeout:90000}),link.click()]);
   // Chromium can hand attachment navigation to its download manager without a normal page Response.
   // Check transport headers independently with the same real browser context/cookies.
   requireNativeBusiness();
   const transport=await ctx.request.get(base+href);assert.equal(transport.status(),200);
   assert(String(transport.headers()['content-type']).includes('application/pdf'));assert(String(transport.headers()['content-disposition']).includes('attachment'));assert(String(transport.headers()['cache-control']).includes('no-store'));
   const stream=await download.createReadStream();assert(stream);const chunks=[];let bytes=0;
   for await(const chunk of stream){bytes+=chunk.length;assert(bytes<=12*1024*1024,'PDF exceeded diagnostic ceiling');chunks.push(chunk);}
   const file=Buffer.concat(chunks);assert(bytes>1000);assert.equal(file.subarray(0,5).toString(),'%PDF-');assert.equal(await download.failure(),null);assert(download.suggestedFilename().includes(code));
   const {PDFDocument}=await import('pdf-lib'),document=await PDFDocument.load(file),pages=document.getPageCount();assert(pages>0&&pages<=10);
   for(const target of [fixture.users[5],fixture.users[254]]){
    const [slip]=await db`select id from payslip where employment_id=${target.employmentId}::uuid order by created_at desc limit 1`;assert(slip);
    requireNativeBusiness();
    const denied=await ctx.request.get(base+'/me/payslip/'+slip.id+'/pdf');assert.equal(denied.status(),404,'foreign own-only PDF was accessible');report.boundaries.push({kind:'foreign-own-payslip-pdf',scope:target.tenant===employee.tenant?'same-company-other-person':'other-tenant',passed:true});
   }
   report.payslipDocument={nativeDownload:true,automaticPdfRequests,bytes,pages,ownIdentity:true,foreignBoundaries:2};save();
  });
  requireCleanDriver();
 }
 if(suite==='workflow-preflight'){
  const ctx=await context(hr);
  await withContext(ctx,async()=>{const page=await ctx.newPage();await exerciseLivePersonnelProfile({page,user:hr,fixture,db,request,report,save,phase:'baseline'});});
  requireCleanDriver();
 }
 assert.equal(report.browserErrors.length,0,'mutation/processing browser runtime errors');
 await homeHttp.read(fixture.users[5],false);await homeHttp.read(fixture.users[3],false);
 await homeHttp.boundary(employee,fixture.users[5]);await homeHttp.boundary(manager,employee);
 requireNativeBusiness();
 await databaseSnapshot('pilot');
 if(report.coverage.some(v=>v.status==='failed'))throw Error('Pilot route failures must be diagnosed before a 500-user run');
 assert(report.preflightHomeReady,'all four preflight sign-ins must load their dashboards before load');
 assert.equal(report.homeCardFailures.length,0,'Home preflight failures must be fixed before load');
 assert.equal(report.browserErrors.length,0,'browser preflight errors must be fixed before load');
 assert.equal(report.pageBusyResponses.length,0,'page Busy responses must be fixed before load');
 assert.equal(report.aiBaselineFailures.length,0,'AI Centre baseline browser journeys must pass before load');
 if(suite==='workflow-preflight'){
  assert.equal(report.aiBaselineFailures.length,0,'AI Centre baseline browser journeys failed');
  requireNativeBusiness();
  await exerciseLetterDraft({base,context,withContext,notePrimary,noteEvidence,visit,fixture,db,report,save});
  requireCleanDriver();
  const {exercisePerformanceRewardsDrafts}=await import('./performance-rewards-draft-browser.mjs');
  requireNativeBusiness();
  await exercisePerformanceRewardsDrafts({base,context,withContext,fixture,db,report,save});
  requireCleanDriver();
  await verifyAudit();save();
  const redirectContext=await context(employee);
  await withContext(redirectContext,async()=>{
   const page=await redirectContext.newPage();
   for(const [alias,target] of [['/assistant?view=jobs','/assistant'],['/assistant?view=insights','/me/payroll-readiness']]){
    await visit(page,employee,alias);
    assert.equal(new URL(page.url()).pathname,target,'AI Centre compatibility redirect changed');
    assert.equal(new URL(page.url()).search,'','AI Centre compatibility redirect kept stale view');
   }
   report.aiCompatibilityRedirectsVerified=true;save();
  });
  requireCleanDriver();
  assert(report.preflightHomeReady,'all four preflight sign-ins must load their dashboards');
  assert.equal(report.homeCardFailures.length,0,'Home rendered a handled card/summary failure');
  assert.equal(report.browserErrors.length,0,'all preflight journeys must finish without browser runtime errors');
  assert.equal(report.pageBusyResponses.length,0,'preflight page Busy responses');
  assert(baselineCapture,'Reviewed navigation baseline capture is missing');
  if(nativePreflight){
   assert(report.nativeRenderedPreflight.union,'Complete native rendered route union required');
   nativeRemaining(nativeDeadline);
  }else if(fullDevelopmentRoutes){
   assert(renderedReport.union,'Complete development rendered route union required');
   nativeRemaining(renderedDeadline);
  }
  if(measureDevelopment)developmentRenderedCapture=writeNavigationCaptureBundle(out,baselineCapture,undefined,'development-byte-binding');
  else writeNavigationCaptureBundle(out,baselineCapture);
  if(!nativePreflight)await finishPreflightLockSampling();
  preflightComplete=true;return;
 }
 const navigationPlan=suite==='whole-system'?planSteadyRouteCoverage({pools:routePools,users:fixture.users,thinkTimeMs,steadyHoldMs}):null;
 report.navigationCapacityPlan=navigationPlan; // Planning is not measured acceptance.
 requireCleanDriver();
 await finishPreflightLockSampling();
 await db`select pg_stat_statements_reset()`;
 loadedSampler=sampleDatabaseLocks(lockScope,'loaded',1000);
 const resourceCpuBefore=resourceCpu(),appCpuBefore=appCpu(),driverCpuBefore=process.cpuUsage();
 const offset=samples.length,started=performance.now(),steadyStart=started+10000,steadyUntil=steadyStart+steadyHoldMs;
 loadedWindow={startMs:steadyStart,endMs:steadyUntil};
 const navigationScheduler=navigationPlan?createSteadyRouteScheduler({pools:routePools,roleCounts,steadyStart,steadyUntil,groupReadSlots:navigationPlan.groupReadSlots}):null;
 const progress={launched:0,active:0,peakActive:0,completed:0,failed:0,iterations:0};
 let fullConcurrencyAt=null,earlyLaneExits=0;
 report.trafficSettled=false;report.functionalAccountingComplete=false;
 report.measurementWindow={startPerformanceMs:started,steadyStartPerformanceMs:steadyStart,steadyUntilPerformanceMs:steadyUntil};
 report.telemetry={querySnapshotIntervalMs:30000,resourceCounterIntervalMs:30000,holderQueries:'bounded native pid/state/query-id; up to128normalizedrootquerytexts withoutparameters',appConnections:'sampled PostgreSQL backends for ai_hr_app; excludes application-side queue length',partialSamplesAreAcceptance:false};
 sqlProgress=startDriverInterval(30000,async()=>{
  // Persist CPU counters during traffic too: a timed-out driver never reaches the final delta.
  // Keep the same bounded30s observation cadence; this does not extend the acceptance window.
  const captureStarted=performance.now();
  try{
   const counters=resourceCpu(),elapsedSeconds=(performance.now()-started)/1000;
   const delta=Object.fromEntries(Object.keys(resourceCpuBefore).map(key=>{
    const before=resourceCpuBefore[key],after=counters[key];
    return [key,before!==null&&after!==null&&after>=before?after-before:null];
   }));
   (report.resourceCpuProgress??=[]).push({kind:'INCOMPLETE_PROGRESS_SNAPSHOT',complete:false,elapsedSeconds,
    captureMs:performance.now()-captureStarted,counterDelta:delta,
    countersAvailable:Object.values(delta).every(value=>value!==null),countersOverlap:true,
    scope:'PostgreSQL cgroup includes capture helpers; host counters overlap all components. Not completed-window acceptance.'});
   noteEvidence(save);
  }catch{report.resourceCpuProgressFailures=(report.resourceCpuProgressFailures??0)+1;noteEvidence(save);}
  try{await databaseSnapshot('loaded-progress');report.sqlProgressSnapshots=(report.sqlProgressSnapshots??0)+1;}
  catch{report.sqlProgressSnapshotFailures=(report.sqlProgressSnapshotFailures??0)+1;}
 },reason=>failures.record('sql-progress-diagnostic',reason));
 progressTimer=setInterval(()=>noteEvidence(()=>{
  const loaded=samples.slice(offset);report.progress={...progress,elapsedMs:performance.now()-started};
  const currentAppCpu=appCpu(),driverCpu=process.cpuUsage(driverCpuBefore);
  report.partialTiming={kind:'INCOMPLETE_PROGRESS_SNAPSHOT',complete:false,read:summary(loaded.filter(v=>v.method==='GET').map(v=>v.durationMs)),write:summary(loaded.filter(v=>v.method==='POST').map(v=>v.durationMs)),knownRequestErrors:report.requestErrors?.length??0,transportErrorsOnly:true,httpErrorResponses:loaded.filter(v=>v.status>=400).length,
   partialCpu:{appCpuSeconds:appCpuBefore!==null&&currentAppCpu!==null?currentAppCpu-appCpuBefore:null,driverCpuSeconds:(driverCpu.user+driverCpu.system)/1e6,elapsedSeconds:(performance.now()-started)/1000,postgresCpuUnavailable:true},
   appMemory:{processes:appMemory(),peakIncludesStartupAndBaseline:true}};
  save();writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));
 }),5000);
 const loadState=()=>{
  const now=performance.now();
  return {active:progress.active,launched:progress.launched,inSteadyWindow:now>=steadyStart&&now<steadyUntil};
 };
 async function waitForSteadyUsers(){
  while(performance.now()<steadyUntil&&(performance.now()<steadyStart||progress.active<500))await pause(25);
 }
 // Representative hydrated browsers share the load interval with all 500 HTTP principals.
 const browserLoad=runLanes([employee,manager,hr,group,fixture.users[254],fixture.users[251]],async user=>{
  const signIn=[employee,manager,hr,group].some(actor=>actor.index===user.index);
  const ctx=await context(user,'en',signIn);
  await withContext(ctx,async()=>{try{
  const page=await ctx.newPage();
  const routes=user.role==='employee'?['/','/claims','/leave','/attendance/individual']
   :user.role==='manager'?['/','/approvals','/claims','/performance/home']:['/',...(suite==='whole-system'?architectureHrReadRoutes:[]),'/admin/personnel','/payroll','/claims'];
  // The two existing-session actors start on the target pages so the language proof
  // is not queued behind the sign-in and Home sequence of the four real-login actors.
  if(suite==='whole-system'&&!signIn){
   const personnel=routes.indexOf('/admin/personnel');
   routes.unshift(...routes.splice(personnel>=0?personnel:1,1));
  }
  await waitForSteadyUsers();for(const route of routes){
   await visit(page,user,route,'loaded',signIn&&route==='/',loadState);
   if((user.role==='employee'&&route==='/claims')||route==='/admin/personnel')await languageJourney(page,user,route,'loaded',loadState);
   await pause(thinkTimeMs);
  }
  if(suite==='whole-system'&&(user.index===group.index||user.index===hr.index))await visit(page,user,'/lifecycle','loaded');
  if(suite==='whole-system'&&user.index===group.index)await exerciseOrgExplorer({page,user,fixture,report,save,phase:'loaded'});
  if(fixture.assistantHistory?.[user.index]||user.index===employee.index||user.index===hr.index)await aiCentreJourney(page,user,'loaded');
  if(user.role==='employee')await browserClaimJourney(page,user,'PERF_BROWSER_LOADED_'+user.index,'loaded');
  if(suite==='whole-system'&&user.index===group.index){
   const loadState=()=>({active:progress.active,launched:progress.launched});
   await exercisePersonnelSwitcher({page,user,fixture,report,save,phase:'loaded',loadState});
  }
  if(signIn&&loadedNavigation)await loadedNavigation.captureActor(page,user.index,loadState);
  }catch(error){
   notePrimary(error);
   noteEvidence(()=>{const errorType=driverErrorFact(error).kind;(report.browserJourneyFailures??=[]).push({role:user.role,user:user.index,phase:'loaded',errorType,...browserFailureLocation(error),timeout:errorType==='TimeoutError'});save();});throw error;
  }
  });
 });
 // Independent pages let each Payroll readiness surface start at steady load.
 const payrollBrowserLoad=suite==='whole-system'?runLanes([null],async()=>{
  const ctx=await context(group);
  return withContext(ctx,async()=>{
   const pages=await Promise.all(payrollReadinessSurfaces.map(()=>ctx.newPage()));
   await waitForSteadyUsers();
   const start=loadState();
   assert(start.active===500&&start.inSteadyWindow,'Payroll browser did not reach steady 500-user load');
   return await Promise.allSettled(payrollReadinessSurfaces.map((surface,index)=>
    runLane(()=>exercisePayrollBrowser({base,page:pages[index],user:group,fixture,report,save,phase:'loaded',loadState,surface}))
   ));
  });
 }):null;
 const attendanceRejectionLoad=loadedAttendanceRejection
  ?runLanes([loadedAttendanceRejection],owner=>owner.run({loadState:()=>({active:progress.active,launched:progress.launched}),steadyUntil}))
  :null;
 const movementLoad=suite==='whole-system'?runLanes([null],async()=>{
  const ctx=await context(group);
  await withContext(ctx,async()=>{
   const page=await ctx.newPage();
   await waitForSteadyUsers();
   await exerciseMovement({base,page,actor:group,subject:employee,fixture,db,report,save,phase:'loaded',recordEvent:true,loadState});
  });
 }):null;
 const savedReportsLoad=suite==='whole-system'?runLanes([null],async()=>{
  const ctx=await context(group);
  await withContext(ctx,async()=>{
   const page=await ctx.newPage();
   await exerciseSavedReport({page,user:group,fixture,db,base,phase:'loaded',thinkTimeMs,report,save,
    loadState,waitForFirstWrite:waitForSteadyUsers});
  });
 }):null;
 const results=await runLanes(fixture.users.map((user,i)=>({user,i})),async({user,i})=>{
  await pause(i*20);progress.launched++;progress.active++;progress.peakActive=Math.max(progress.peakActive,progress.active);
  if(progress.active===500)fullConcurrencyAt??=performance.now();
  let iteration=0;
  try{do{
  const ordinal=roleOrdinals.get(user.index),slots=navigationScheduler?.slots(user.role,ordinal,iteration)??measuredRoutePools[user.role].length;
  for(let slot=0;slot<slots;slot++){
   const navigationStarted=performance.now(),lease=navigationScheduler?.reserve({role:user.role,ordinal,actors:roleCounts.get(user.role),iteration,slot,startedMs:navigationStarted});
   const route=lease?.route??measuredRoutePools[user.role][slot];let usable=false;
   try{
    await readRoute(user,route);
    if(route==='/'&&['employee','manager'].includes(user.role))await homeHttp.read(user,true);
    pageInteractions.push({role:user.role,route,startedMs:navigationStarted,durationMs:performance.now()-navigationStarted});usable=true;
   }finally{if(lease)navigationScheduler.complete(lease,usable);}
   await pause(thinkTimeMs);
  }
  if(mixedWorkflows&&await mixedWorkflows.run(user,iteration)){await pause(thinkTimeMs);iteration++;progress.iterations++;continue;}
  const description='PERF_HTTP_'+i+'_'+iteration;
  const template=contextTemplates.createTemplate,fields={...template.fields};
  for(const [key,value]of Object.entries({employmentId:user.employmentId,claimTypeId:user.claimTypeId,amount:'1',incurredOn:fixture.today,description,intent:'draft'}))fields[template.prefix+key]=value;
  delete fields[template.prefix+'draftId'];
  const created=await observedMutation(user,'create',async()=>{
   const rows=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft' and description=${description} limit 2`;return rows.length===1;
  },()=>request(user,'/claims',fields,template.status,true,template.headers,template.fieldOrder,'claimsCreate'));assert.equal(new URL(String(created.headers['x-action-redirect']??created.headers.location).split(';')[0],base).searchParams.get('toast'),'Draft saved');
  const [draft]=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft'and description=${description}`;assert(draft,'HTTP create did not persist');
  await pause(thinkTimeMs);await observedMutation(user,'edit',async()=>{
   const [row]=await db`select amount from claim_request where id=${draft.id}::uuid`;return row&&Number(row.amount)===2;
  },()=>request(user,'/claims',{...fields,[template.prefix+'draftId']:draft.id,[template.prefix+'amount']:'2'},template.status,true,template.headers,template.fieldOrder,'claimsEdit'));
  const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
  await pause(thinkTimeMs);await observedMutation(user,'delete',async()=>{
   return (await db`select id from claim_request where id=${draft.id}::uuid`).length===0;
  },()=>request(user,'/claims',{...contextTemplates.deleteTemplate.fields,[contextTemplates.deleteTemplate.prefix+'employmentId']:user.employmentId,[contextTemplates.deleteTemplate.prefix+'id']:draft.id},contextTemplates.deleteTemplate.status,true,contextTemplates.deleteTemplate.headers,contextTemplates.deleteTemplate.fieldOrder,'claimsDelete'));
  assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
  await pause(thinkTimeMs);iteration++;progress.iterations++;
  }while(performance.now()<steadyUntil);
  progress.completed++;
  }catch(error){progress.failed++;throw error;}finally{
   if(performance.now()<steadyUntil)earlyLaneExits++;
   progress.active--;
  }
 });
 const browserResults=await browserLoad;
 const payrollBrowserResults=await payrollBrowserLoad;
 if(payrollBrowserResults){
  const [result]=payrollBrowserResults;
  const rows=report.browserPayrollReadiness?.filter(row=>row.phase==='loaded')??[];
  const duringSteady500=state=>state?.active===500&&state.inSteadyWindow===true;
  report.payrollBrowserLoad={
   surfaces:payrollReadinessSurfaces,
   startedAtSteady500:rows.filter(row=>duringSteady500(row.loadAtStart)).map(row=>row.surface),
   readyAtSteady500:rows.filter(row=>row.usable&&duringSteady500(row.loadAtReady)).map(row=>row.surface),
   failures:result.status==='rejected'?[{error:errorLabel(result.reason)}]:
    result.value.flatMap((row,index)=>row.status==='rejected'?[{surface:payrollReadinessSurfaces[index],error:errorLabel(row.reason)}]:[]),
  };
 }
 const rejectionResults=await attendanceRejectionLoad;
 const movementResults=await movementLoad;
 const savedReportResults=await savedReportsLoad;
 if(movementResults){
  const [result]=movementResults;
  report.movementLoad=result.status==='fulfilled'?{status:'completed'}:{status:'failed',error:errorLabel(result.reason)};
 }

 report.trafficSettled=true;
 report.browserLoad={contexts:browserResults.length,completed:browserResults.filter(v=>v.status==='fulfilled').length,errors:browserResults.flatMap((v,index)=>v.status==='rejected'?[{index,error:errorLabel(v.reason)}]:[])};
 const loadedWindowReached=measureDevelopment&&performance.now()>=loadedWindow.endMs;
 if(suite==='whole-system')developmentLoad={holdMs:steadyHoldMs,windowElapsed:loadedWindowReached,
  firstFullConcurrencyUs:fullConcurrencyAt===null?null:Math.ceil((fullConcurrencyAt-started)*1000),
  launched:progress.launched,peakActive:progress.peakActive,completed:progress.completed,failed:progress.failed,
  activeAtSettlement:progress.active,earlyLaneExits,iterations:progress.iterations};
 const lockDrain=loadedSampler.stop(),progressDrain=sqlProgress.stop();
 clearInterval(progressTimer);progressTimer=null;report.progress={...progress,elapsedMs:performance.now()-started};
 report.functionalErrors=results.flatMap((value,index)=>value.status==='rejected'?[{user:index,error:errorLabel(value.reason)}]:[]);report.functionalAccountingComplete=true;
 const appCpuAfter=appCpu(),driverCpu=process.cpuUsage(driverCpuBefore),resourceCpuAfter=resourceCpu();
 const resourceDelta=Object.fromEntries(Object.keys(resourceCpuBefore).map(key=>{
  const before=resourceCpuBefore[key],after=resourceCpuAfter[key];
  return [key,before!==null&&after!==null&&after>=before?after-before:null];
 }));
 report.cpu={appProcesses:Number(process.env.PERF_APP_WORKERS||1),appCpuSeconds:appCpuBefore!==null&&appCpuAfter!==null?appCpuAfter-appCpuBefore:null,driverCpuSeconds:(driverCpu.user+driverCpu.system)/1000000,elapsedSeconds:(performance.now()-started)/1000,includesBrowserCpu:false,includesPostgresCpu:false};
 report.resourceCpu={...resourceDelta,complete:Object.values(resourceDelta).every(value=>value!==null),elapsedSeconds:(performance.now()-started)/1000,
  countersOverlap:true,counterScope:'PostgreSQL cgroup includes its capture helpers; proxy is the orchestrator process. Host user/system includes all hosted-runner processes (including Chromium) and overlaps every component; do not sum it with component counters. IO wait and steal are reported separately.'};
 report.appMemory={processes:appMemory(),peakIncludesStartupAndBaseline:true};
 const loaded=samples.slice(offset),reads=loaded.filter(v=>v.method==='GET'),writes=loaded.filter(v=>v.method==='POST');
 report.phases.push({name:'500-paced-HTTP-users-'+suite+'-'+thinkTimeMs+'ms-think',elapsedMs:performance.now()-started,completed:results.filter(v=>v.status==='fulfilled').length,errors:report.functionalErrors.length,
  read:summary(reads.map(v=>v.durationMs)),write:summary(writes.map(v=>v.durationMs)),ttfb:summary(loaded.map(v=>v.ttfbMs)),wireBytes:loaded.reduce((sum,v)=>sum+v.wireBytes,0),decodedBytes:loaded.reduce((sum,v)=>sum+v.decodedBytes,0)});
 report.concurrentRouteCoverage=[...new Set(Object.values(routePools).flat())].map(route=>({route,requests:loaded.filter(sample=>sample.method==='GET'&&sample.route===route).length,users:new Set(loaded.filter(sample=>sample.method==='GET'&&sample.route===route).map(sample=>sample.user)).size}));
 const steady=loaded.filter(sample=>sample.startedMs>=steadyStart&&sample.startedMs<steadyUntil);
 report.pageInteractions=pageInteractions;
 report.steady={durationMs:steadyHoldMs,concurrency:{
  reached500:fullConcurrencyAt!==null,
  rampOverrunMs:fullConcurrencyAt===null?null:Math.max(0,fullConcurrencyAt-steadyStart),
  earlyLaneExits,
 },...(developmentLoad?{load:developmentLoad}:{}),roles:Object.fromEntries(['employee','manager','companyHR','groupHR'].map(role=>[role,{
  navigation:summary(pageInteractions.filter(v=>v.role===role&&v.startedMs>=steadyStart&&v.startedMs<steadyUntil).map(v=>v.durationMs)),
  read:summary(steady.filter(v=>v.role===role&&v.method==='GET').map(v=>v.durationMs)),
  write:summary(steady.filter(v=>v.role===role&&v.method==='POST').map(v=>v.durationMs)),
 }]))};
 report.steady.navigationCoverage=navigationScheduler?.snapshot()??null;
 report.steady.routeLatency=routeLatency({samples:loaded,pageInteractions,routePools:measuredRoutePools,homeTemplates:suite==='whole-system'?report.homeApiTraffic.templates:[],steadyStart,steadyUntil});
 report.latencyTargetMet=(suite!=='whole-system'||developmentSteadyLoadPass(developmentLoad))&&(!navigationScheduler||report.steady.navigationCoverage.every(row=>row.pending.length===0&&row.inflight.length===0))&&progress.peakActive===500&&earlyLaneExits===0&&report.steady.routeLatency.targetMet&&Object.values(report.steady.roles).every(role=>role.navigation.samples>0&&role.navigation.p95Ms<1000&&role.read.samples>0&&role.write.samples>0&&role.read.p95Ms<1000&&role.write.p95Ms<500);
 await Promise.all([lockDrain,progressDrain]);
 if(measureDevelopment)loadedCadenceClosed=loadedWindowReached;
 recordLockSampling();
 writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));
 report.concurrentHomeApiCoverage=report.homeApiTraffic.templates.flatMap(({role,requests})=>requests.map(({path})=>({role,path,requests:loaded.filter(sample=>sample.role===role&&sample.method==='GET'&&sample.route===path).length})));
 await databaseSnapshot('loaded');
 if(mixedWorkflows){
  try{report.mixedWorkflows.failedAttendanceEffects={status:'checked',rows:await mixedWorkflows.verifyFailedAttendanceActions()};}
  catch(error){
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:null;
   report.mixedWorkflows.failedAttendanceEffects={status:'unavailable',code};
  }
  save();
 }
 await verifyAudit();save();
 assert(report.preflightHomeReady,'all four preflight sign-ins must load their dashboards');
 if(samplingRequired)assert(report.lockSampling.loaded.pass,'Load lock samples were incomplete or observed blocking');
 if(suite==='whole-system')assert(developmentSteadyLoadPass(developmentLoad),'Whole-system steady load did not hold 500 on-time lanes for 300 seconds');
 if(rejectionResults?.[0].status==='rejected')throw rejectionResults[0].reason;
 if(suite==='whole-system'){
  const movement=report.browserMovementJourneys?.find(row=>row.phase==='loaded');
  assert(movement?.auditVerified&&['history','newEvent','save'].every(step=>{
   const evidence=movement.steps[step];
   return evidence?.status==='passed'&&evidence.startedWith?.active===500&&evidence.startedWith.inSteadyWindow;
  }),'Movement history, New Event and audited save must start during steady 500-user load');
 }
 if(report.payrollBrowserLoad){
  const {surfaces,startedAtSteady500,readyAtSteady500,failures}=report.payrollBrowserLoad;
  assert.equal(failures.length,0,'loaded Payroll browser readiness failed');
  assert(surfaces.every(surface=>startedAtSteady500.includes(surface)&&readyAtSteady500.includes(surface)),
   'all Payroll readiness surfaces must start and finish during steady 500-user load');
 }
 if(savedReportResults?.[0].status==='rejected')throw savedReportResults[0].reason;
 if(suite==='whole-system'){
  const savedReports=report.browserSavedReportJourneys;
  assert(savedReports?.some(row=>row.phase==='baseline'&&row.status==='passed'),'baseline saved Reports browser journey did not finish');
  const loadedReport=savedReports?.find(row=>row.phase==='loaded'&&row.status==='passed');
  assert(loadedReport&&['create','edit','delete'].every(operation=>loadedReport.timings.some(step=>
   step.operation===operation&&step.startedWith?.active===500&&step.startedWith.inSteadyWindow
  )),'saved Reports create, edit and delete must start during steady 500-user load');
 }
 if(suite==='whole-system')assert(report.concurrentHomeApiCoverage.length>0&&report.concurrentHomeApiCoverage.every(row=>row.requests>0),'observed Home fetches missing from concurrent traffic');if(mixedWorkflows)assert(Object.values(report.mixedWorkflows.completed).every(count=>count>0),'a required mixed mutation/processing scenario did not complete');if(suite==='whole-system')assert(report.concurrentRouteCoverage.every(route=>route.requests>0),'wider concurrent route coverage incomplete');assert.equal(report.functionalErrors.length,0,'HTTP journey failures');assert.equal(report.homeCardFailures.length,0,'Home rendered a handled card/summary failure during baseline or load');assert(report.loadedBrowserSignIn?.homeCards>0,'real loaded browser sign-in did not finish');
 assert.equal(report.pageBusyResponses.length,0,'page Busy responses under load');
 assert.equal(report.aiBaselineFailures.length,0,'AI Centre baseline browser journeys failed');
 assert(['employee','manager','companyHR','groupHR'].every(role=>report.loadedBrowserSignIns?.some(row=>
  row.role===role&&row.homeCards>0&&row.todaySectionIds.length>0&&row.cardFailures===0
  &&row.startedWith?.active===500&&row.startedWith.inSteadyWindow
  &&row.allCardsReadyWith?.active===500&&row.allCardsReadyWith.inSteadyWindow
 )),'all four role dashboards must finish loading after real sign-in during steady 500-user load');
 if(suite==='whole-system'){
  const duringSteady500=row=>row.startedWith?.active===500&&row.startedWith.inSteadyWindow;
  for(const [name,observations] of [['Analytics',report.analyticsReadiness],['Roster',report.rosterReadiness],['Job Descriptions',report.jobDescriptionReadiness]]){
   assert(['companyHR','groupHR'].every(role=>observations?.some(row=>row.role===role&&row.phase==='loaded'&&duringSteady500(row)
    &&row.usableWith?.active===500&&row.usableWith.inSteadyWindow)),name+' must render usable content for both HR scopes during steady 500-user load');
  }
  assert(report.browser.some(row=>row.phase==='loaded'&&row.path==='/admin/personnel'&&duringSteady500(row)),
   'Personnel browser navigation did not start during steady 500-user load');
  assert(['/claims','/admin/personnel'].every(path=>['zh','en'].every(locale=>
   report.browserLanguageSwitches?.some(row=>row.phase==='loaded'&&row.path===path&&row.locale===locale&&row.usable&&duringSteady500(row))
  )),'Claims and Personnel language switches must start during steady 500-user load');
 }
 assert.equal(report.browserErrors.length,0,'browser runtime errors');assert.equal(report.browserLoad.errors.length,0,'loaded browser journeys');if(suite==='whole-system')assert(['baseline','loaded'].every(phase=>report.orgExplorerJourneys?.some(row=>row.phase===phase&&row.status==='passed')),'Org browser scope and language journeys did not finish');if(fixture.assistantHistory)assert(aiBrowserActors.every(user=>['saved-history-list','saved-history-open','saved-history-return'].every(step=>report.browserAssistantHistory?.some(row=>row.phase==='loaded'&&row.userIndex===user.index&&row.step===step&&row.targetMet))),'populated saved-history browser navigation incomplete or above1s target');assert(report.latencyTargetMet,'500-user HTTP p95 latency target was not met');
 if(suite==='whole-system'){
  assert(baselineCapture&&loadedNavigation,'Reviewed navigation producer is missing');
  const loadedCapture=loadedNavigation.finish();
  developmentRenderedCapture=writeNavigationCaptureBundle(out,baselineCapture,loadedCapture,'development-byte-binding');
  report.navigationCapture.loadedScenarios=loadedCapture.observations.length;save();
 }
}

try{
 requireNativeBusiness();
 chromiumEnv=closedChromiumEnvironment(process.env,userInfo().homedir);
 db=acquireDriverResource(acquired,'observer',()=>postgres(process.env.MIGRATION_DATABASE_URL,{max:2}));
 agent=acquireDriverResource(acquired,'agent',()=>new https.Agent({keepAlive:true,maxSockets:4000,rejectUnauthorized:nativePreflight,
  lookup:(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)}));
 await main();
 if(measureDevelopment)developmentWorkCompleted=true;
}catch(reason){
 if(reason!==lifecycleRefused){
  failures.notePrimary(reason);
  nativeAdmission?.close(reason);
 }
}

const unconfirmedClaims=claimCustody?.privateUnconfirmed();
if(claimCustody){
 const entries=claimCustody.publicFacts();
 // This is local handoff evidence. The trusted issuer independently owns
 // the whole realm stop after a kill, missing handoff or uncertain attempt.
 const sealed=noteEvidence(()=>claimCustody.seal());
 const closed=noteEvidence(()=>claimHandoff.close());
 const driverHandoffSealed=sealed.state==='settled'&&closed.state==='settled';
 const ownerStopRequired=!driverHandoffSealed||unconfirmedClaims.length>0;
 report.protectedClaimCustody={entries,driverHandoffSealed,ownerStopRequired};
 if(ownerStopRequired)failures.record('claim-custody-unconfirmed',Error('Protected Claims restitution requires owned realm stop'));
 else if(preflightComplete&&entries.filter(entry=>entry.disposition==='restored').length!==5)
  failures.record('claim-custody-census',Error('Protected Claims restoration census differs'));
 noteEvidence(save);
}
const diagnosticDrain=stopDiagnosticAdmission();
const protectedAbort=nativePreflight&&!preflightComplete?protectedSampler?.close(false):undefined;
await drainDriverLanes(lanes,requests);
const failureAtExit=failures.failed();
const shutdown=report.shutdown={acquisition:acquired,browserClosed:false,nativeAuditPoolClosed:false,driverPoolClosed:false};
const driverResources={
 async browser(){
  if(failureAtExit&&lastPage)await failures.attempt('browser-failure-capture',async()=>{
   report.browserPendingRequests??=[...(pendingBrowserRequests.get(lastPage)?.values()??[])].map(row=>({...row,elapsedMs:performance.now()-row.startedMs}));
   if(!contexts.hasPendingClose()&&!lastPage.isClosed())await lastPage.screenshot({path:join(out,'browser-failure.png'),fullPage:false});
  });
  const settled=await settleDriverBrowser(browser,ownedBrowser,contexts,failures);
  shutdown.browser={close:settled.close,unexpectedDisconnect:settled.unexpectedDisconnect};
  shutdown.browserClosed=settled.close==='settled';
  shutdown.contexts=settled.contexts;
 },
 async https(){
  await requests.drain();
  transports.seal();
  await transports.drain();
  shutdown.http=agent?await sockets.closeAgent(agent):{state:'absent'};
 },
 async database(){
  const diagnosticOutcomes=await diagnosticDrain;
  if(measureDevelopment)shutdown.diagnostics=diagnosticOutcomes.every(outcome=>outcome.status==='fulfilled')?'settled':'failed';
  if(measureDevelopment&&db)await observePostgresWaitLogging('end');
  if(failureAtExit&&db&&!nativePreflight)await failures.attempt('failure-database-snapshot',()=>databaseSnapshot('failure'));
  shutdown.database=await closePerformanceDbPools(nativeAuditClient,db,failures);
  shutdown.nativeAuditPoolClosed=shutdown.database.audit==='settled';
  shutdown.driverPoolClosed=shutdown.database.observer==='settled';
 },
};
if(nativePreflight){
 await Promise.all([failures.attempt('browser-settlement',driverResources.browser),failures.attempt('https-settlement',driverResources.https)]);
 await failures.attempt('native-lock-settlement',async()=>{
  const settled=preflightComplete&&!failures.failed()&&shutdown.browserClosed&&shutdown.http?.state==='settled';
  const lockEvidence=await (protectedAbort??protectedSampler?.close(settled));
  shutdown.protectedLockObserver=lockEvidence?.observerSettlement??'not-entered';
  recordLockSampling();noteEvidence(save);
  if(preflightComplete&&!failures.failed())assert(lockEvidence?.pass===true,'Protected preflight lock evidence incomplete or observed blocking');
 });
 await failures.attempt('database-settlement',driverResources.database);
}else await settleDriverResources(failures,driverResources);
if(developmentPageCensus)report.developmentBrowserPageEvents=developmentPageCensus.finish(shutdown,true,failures.record);
recordLockSampling();
if(nativePreflight){
 report.nativeRenderedPreflight.browserFailures=nativeBrowserFailures.facts();
 report.nativeRenderedPreflight.primaryDocumentRetirement=nativePrimaryDocuments.map(({actorIndex,expected,nativeDom})=>({actorIndex,expected,...nativeDom.facts()}));
 if(preflightComplete)await failures.attempt('native-post-settlement',()=>{
  assert.deepEqual(nativePrimaryDocuments.map(row=>row.actorIndex).sort((a,b)=>a-b),[0,1,2,4],'Native primary document owners differ');
  for(const {expected,nativeDom}of nativePrimaryDocuments)nativeDom.requireSettled(expected);
  nativeBrowserFailures.requireClean();
  assert.equal(report.browserErrors.length,0,'Native late browser runtime errors');
  nativeRemaining(nativeDeadline);
  if(!failures.failed()){
   report.nativeRenderedPreflight.nativeShellBaseline=nativeShell.finish();
   report.nativeRenderedPreflight.pendingHiddenShellCases=[];
   report.nativeRenderedPreflight.exactShellScenarioPlanComplete=true;
   report.nativeRenderedPreflight.workflowAndRenderedSlicePassed=true;
  }
 });
}
if(fullDevelopmentRoutes&&preflightComplete&&!failures.failed())await failures.attempt('development-rendered-settlement',()=>{
 assert.equal(report.developmentBrowserPageEvents.censusComplete,true,'Full development browser Page census incomplete');
 const primary=nativePrimaryDocuments.map(({actorIndex,expected,nativeDom,page,failuresBefore})=>{
  assert(page.isClosed(),'Full development primary Page did not settle');
  nativeDom.requireSettled(expected);
  const pageFailures=renderedPageEvents.pageCount(page)-failuresBefore;
  assert.equal(pageFailures,0,'Full development primary Page failures observed through settlement');
  return {actorIndex,...nativeDom.facts(),pageFailures};
 });
 const hidden=nativeShell.finish();
 nativeRemaining(renderedDeadline);
 developmentUnionFacts={primary,hidden};
});
if(measureDevelopment){
 const capture=developmentNavigationBinding;
 const identity={
  candidateSha:process.env.AIHR_CI_HEAD,controllerSha:process.env.AIHR_CI_CONTROL_HEAD,
  runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),
  harnessSha256:capture?.harnessSha256??null,scenarioSha256:capture?.scenarioSha256??null,
 };
 let measurement=buildDevelopmentMeasurement({suite,identity,workCompleted:developmentWorkCompleted,clean:!failures.failed(),
  busyResponses:report.pageBusyResponses.length,pages:report.developmentBrowserPageEvents,
  preflight:report.lockSampling.preflight.cadence,loaded:report.lockSampling.loaded.cadence,shutdown,
  renderedCapture:developmentRenderedCapture,load:developmentLoad});
 if(fullDevelopmentRoutes){
  let renderedUnion=null;
  if(measurement.complete) {
   const sealed=noteEvidence(()=>{
    assert(developmentUnionFacts,'Full development rendered route evidence missing');
    nativeRemaining(renderedDeadline);
    const binding=writeDevelopmentRenderedRouteUnion(out,capture,renderedReport.observations,developmentUnionFacts.hidden,
     developmentUnionFacts.primary,report.lifecycleStaffHub??[]);
    nativeRemaining(renderedDeadline);
    return binding;
   });
   if(sealed.state==='settled')renderedUnion=sealed.value;
  }
  measurement={...measurement,complete:measurement.complete&&renderedUnion!==null,
   renderedCapture:renderedUnion?measurement.renderedCapture:null,renderedUnion};
 }
 report.developmentMeasurement=measurement;
 if(!measurement.complete&&developmentWorkCompleted&&!failures.failed())
  failures.record('development-terminal-evidence',Error('Development measurement evidence was incomplete or observed a failure'));
 // Only the runner's direct driver child has a Node IPC channel. No path or credentials cross it.
 if(typeof process.send==='function')await failures.attempt('development-terminal-handoff',()=>
  new Promise((resolve,reject)=>process.send(measurement,error=>error?reject(error):resolve())));
}
report.driverFailures=failures.publicFailures();
if(failures.failed()){
 report.error=report.driverFailures.primary?.code??report.driverFailures.primary?.kind??'Owned driver settlement failed';
 noteEvidence(()=>writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples)));
 noteEvidence(()=>writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits)));
}
report.driverFailures=failures.publicFailures();
if(!nativePreflight&&preflightComplete&&!failures.failed())report.preflightPassed=true;
noteEvidence(save);
if(failures.failed()){
 // The outer runner publishes a bounded child log tail. Keep the actual reasons in its private directory.
 const privateFacts=failures.privateFailures();
 noteEvidence(()=>writeFileSync(join(process.env.PERF_PRIVATE_DIR,'driver-failures.log'),
  inspect(unconfirmedClaims?.length?{protectedClaims:unconfirmedClaims,...privateFacts}:privateFacts,
   {customInspect:false,getters:false,depth:4,maxArrayLength:80,maxStringLength:1200}).slice(0,32000),{mode:0o600}));
 throw Error('Owned development workload or settlement failed');
}
}
