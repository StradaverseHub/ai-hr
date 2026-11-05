/** Real HTTPS requests + Chromium against the isolated production server; no auth/test route bypass. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHomeHttpReplay} from './home-http.mjs';
import {browserFailureLocation} from './browser-failure.ts';
import {routeLatency} from './route-latency.mjs';
import {firstGroupNavigationRoutes,navigationRoutesForIteration} from './route-scheduling.mjs';
import {prepareMixedWorkflows} from './mixed-workflows.mjs';
import {attendanceRejectionProbeEnabled,prepareAttendanceRejection} from './attendance-rejection-browser.mjs';
import {exerciseMovement} from './movement-browser.mjs';
import {exerciseLetterDraft} from './letter-draft-browser.mjs';
import {exerciseOrgExplorer} from './org-explorer-browser.mjs';
import {exerciseSavedReport} from './reports-browser.mjs';
import {exercisePayrollBrowser} from './payroll-browser.mjs';
import {exercisePayrollRegister,verifyPayrollRegisterBoundary} from './payroll-register-browser.mjs';
import {exercisePersonnelSwitcher} from './personnel-switcher-browser.mjs';
import {exerciseLivePersonnelProfile} from './personnel-live-profile-browser.mjs';
import {verifyAssistantHistoryBrowser} from './assistant-history-browser.mjs';
import {actionFormData} from './action-form.ts';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import {createGunzip} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';
import {chromium} from 'playwright';
import postgres from 'postgres';
import {generate} from 'otplib';
import {closePerformanceDbPools,performanceNativeDbClient} from './driver-shutdown.mjs';
import {readRouteForMeasurement,routePools,wholeSystemRouteCount,additionalBrowserRoutes} from './system-route-manifest.mjs';
const base='https://localhost:3443',out=process.env.PERF_EVIDENCE_DIR;
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(new URL(process.env.DATABASE_URL).pathname,'/ai_hr_dev');
const fixture=JSON.parse(readFileSync(join(process.env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:2});
const agent=new https.Agent({keepAlive:true,maxSockets:4000,rejectUnauthorized:false,
 lookup:(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)});
const suite=process.env.PERF_HTTP_SUITE||'claims-heavy';assert(['claims-heavy','whole-system','workflow-preflight'].includes(suite));
const measuredRoutePools=suite==='whole-system'?routePools:{employee:['/me','/claims','/leave'],manager:['/approvals','/claims','/performance/home'],companyHR:['/admin/personnel','/payroll','/claims'],groupHR:['/admin/personnel','/payroll','/claims']};
const thinkTimeMs=Number(process.env.PERF_HTTP_THINK_MS||1000);assert([1000,5000].includes(thinkTimeMs));
const steadyHoldMs=Number(process.env.PERF_HTTP_HOLD_MS||30000);assert([30000,300000].includes(steadyHoldMs));
const report={suite,kind:suite==='workflow-preflight'?'HTTP_WORKFLOW_PREFLIGHT_ONLY':'HTTP_AND_CHROMIUM_DEVELOPMENT_ONLY',releaseEligible:false,users:suite==='workflow-preflight'?0:500,fixtureUsers:500,tenants:2,companies:10,startedAt:new Date().toISOString(),
 assumptions:{arrivalWindowMs:10000,thinkTimeMs,steadyHoldMs,navigation:'full-document HTTP stress, observed subject-bound Home GETs and real server actions',navigationScheduling:'disjoint role lanes; group HR prioritizes uncovered routes in cycle one and uses six read slots thereafter; other roles use three; same activity pauses',driverMaxSockets:4000,preflightHttpActorLanes:4,browserVisitReadiness:'domcontentloaded followed by unchanged heading, fixture data and complete Home card assertions',tls:'fixture-only self-signed localhost',browserContexts:6,loadedBrowserSignIns:4,preflightBrowserSignIns:4,persistenceObserverPrincipals:6,persistencePollIntervalMs:100,loginEnrollmentLoad:false,performanceFixture:'enabled dashboard; no assigned review cycle; task-gated tabs excluded'},
 workloadManifest:{readRoutes:wholeSystemRouteCount,mutations:['Claims draft create/edit/delete','Leave request create/edit/withdraw','Personnel draft create/edit/delete','Attendance correction and authorized approval'],browserMutations:suite==='claims-heavy'?[]:['Generic Reports saved-definition create/edit/delete (group HR, baseline'+(suite==='whole-system'?' and loaded':'')+')','Service Movement Secondment (group HR, '+(suite==='whole-system'?'loaded':'preflight')+')'],preflightOnly:suite==='workflow-preflight'?['Active Personnel contact edit/restore','E-Letter draft create/edit/withdraw','Concurrent Payroll close/publish','Performance review-cycle draft creation','Rewards annual unit draft creation']:[],processing:['Payroll calculation','Payroll close/employee publication preflight','scoped Payroll CSV generation','clocking-file validation/import'],notCovered:[...(suite==='workflow-preflight'?[]:['concurrent Payroll close/publish','active Personnel contact edit/restore','E-Letter draft mutations']),'Lifecycle mutations',...(suite==='workflow-preflight'?['Performance and Rewards mutations beyond draft creation']:['Performance mutations','Rewards mutations']),'large Personnel imports',...(suite==='claims-heavy'?['report-definition CRUD']:['Employee Master and Payroll Comparison definition CRUD','500-principal Reports write mix']),'long-running document jobs','external email delivery'],productionEquivalent:false},
 coverage:[],boundaries:[],browser:[],homeCardFailures:[],browserHomeRequests:[],phases:[],functionalErrors:[],browserErrors:[],persistenceObservers:[],latencyTargetMet:false};
const save=()=>writeFileSync(join(out,'http-browser.json'),JSON.stringify(report,null,2));
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
 assert.equal(execFileSync('docker',['inspect','--format','{{index .Config.Labels "aihr-owner"}}',name],{encoding:'utf8',timeout:5000}).trim(),name);
 const usage=execFileSync('docker',['exec',name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:5000});
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
const homeHttp=createHomeHttpReplay({base,request,report});
async function request(user,path,fields,expectedStatus=200,record=true,actionHeaders={},fieldOrder=[],action){
 assert(path.startsWith('/')&&!path.startsWith('//'));const started=performance.now();let body,contentType;
 if(Array.isArray(fields)){body=Buffer.from(JSON.stringify(fields));contentType='text/plain;charset=UTF-8';}
 else if(fields){const encoded=new Response(actionFormData(fields,fieldOrder));contentType=encoded.headers.get('content-type');body=Buffer.from(await encoded.arrayBuffer());}
 const response=await new Promise((resolve,reject)=>{
  const req=https.request(base+path,{agent,signal:AbortSignal.timeout(90000),method:fields?'POST':'GET',headers:{Host:'localhost:3443',Origin:base,
   Cookie:`__Host-aihr_internal=${user?.token??''}; NEXT_LOCALE=en`,'Accept-Encoding':'gzip',...actionHeaders,...(body?{'Content-Type':contentType,'Content-Length':body.length}:{})}},res=>{
   let wireBytes=0,decodedBytes=0,content='';const ttfbMs=performance.now()-started;
   res.on('data',chunk=>{wireBytes+=chunk.length;});const stream=res.headers['content-encoding']==='gzip'?res.pipe(createGunzip()):res;
   stream.on('data',chunk=>{decodedBytes+=chunk.length;if(decodedBytes>12*1024*1024){stream.destroy(new Error('Decoded response exceeded the 12MiB measurement ceiling'));return;}content+=chunk.toString();});
   stream.on('error',reject);stream.on('end',()=>resolve({status:res.statusCode,headers:res.headers,content,wireBytes,decodedBytes,ttfbMs}));
  });req.on('error',reject);req.end(body);
 }).catch(error=>{(report.requestErrors??=[]).push({user:user?.index??null,role:user?.role??'anonymous',route:readRouteForMeasurement(path),method:fields?'POST':'GET',action,startedMs:started,elapsedMs:performance.now()-started,error:String(error.message).slice(0,180)});throw error;});
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
async function databaseSnapshot(label){
 const settings=await db`select current_setting('fsync')as fsync,current_setting('synchronous_commit')as synchronous_commit,current_setting('jit')as jit,current_setting('server_version')as server_version,current_setting('shared_buffers')as shared_buffers,current_setting('work_mem')as work_mem,current_setting('max_connections')as max_connections`;
 assert.equal(settings[0].fsync,'on');assert.equal(settings[0].synchronous_commit,'on');
 const statements=await db`select queryid::text,calls,total_exec_time,total_plan_time,mean_exec_time,rows,shared_blks_hit,shared_blks_read,temp_blks_written,
 jit_generation_time,jit_inlining_time,jit_optimization_time,jit_emission_time,left(query,1800)as normalized_query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
 and query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 35`;
 const active=await db`select pid,state,wait_event_type,wait_event,extract(epoch from(clock_timestamp()-query_start))as age_seconds,left(query,4000)as query from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid()`;
 writeFileSync(join(out,'database-'+label+'.json'),JSON.stringify({settings,statements,active},null,2));
}
let nativeAuditClient;
async function verifyAudit(){
 nativeAuditClient=performanceNativeDbClient(await import('../../db/client.ts'));
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
const routePool=user=>routePools[user.role];
const roleCounts=new Map(),roleOrdinals=new Map(fixture.users.map(user=>{const ordinal=roleCounts.get(user.role)??0;roleCounts.set(user.role,ordinal+1);return [user.index,ordinal];}));
const firstGroupRoutes=suite==='whole-system'?firstGroupNavigationRoutes(routePools,roleCounts):[];
const pendingBrowserRequests=new WeakMap(),browserPdfRequests=new WeakMap();
let browser,sampling,progressTimer,sqlSnapshotTimer,browserDiagnosticTimer,contextTemplates,lastPage,runMixedWorkflow;
async function main(){
try{
 save();await db`select pg_stat_statements_reset()`;
 const anonymous=await request(null,'/claims',undefined,307,false);assert(String(anonymous.headers.location).includes('/login'));report.boundaries.push({kind:'anonymous',passed:true});
 // Bound independent preflight roles to four lanes; every role still visits its full route pool.
 const pilotResults=await Promise.allSettled([employee,manager,hr,group].map(async user=>{
  const routes=routePool(user);
  for(const route of routes){
   const diagnostic=setTimeout(()=>{databaseSnapshot('slow-pilot').catch(()=>{});},10000);
   try{const response=await request(user,route);report.coverage.push({role:user.role,route,status:'passed',durationMs:response.durationMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes});}
   catch(error){report.coverage.push({role:user.role,route,status:'failed',reason:String(error.message).slice(0,180)});save();throw error;}finally{clearTimeout(diagnostic);}
   save();
  }
 }));
 const pilotFailure=pilotResults.find(result=>result.status==='rejected');
 if(pilotFailure)throw pilotFailure.reason;
 // Direct record and search fences exercise ordinary web authorization, not a test-only endpoint.
 for(const [actor,target]of [[hr,fixture.users[50]],[group,fixture.users[250]]]){
  const response=await request(actor,'/api/personnel/search?q='+encodeURIComponent(target.name));
  assert.deepEqual(JSON.parse(response.content).rows,[]);report.boundaries.push({kind:'company-or-tenant-search',role:actor.role,passed:true});
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
 report.browserVersion=browser.version();
 browserDiagnosticTimer=setInterval(()=>{
  if(!lastPage||lastPage.isClosed())return;
  report.browserPendingSnapshot={at:new Date().toISOString(),requests:[...(pendingBrowserRequests.get(lastPage)?.values()??[])].slice(0,50).map(row=>({...row,elapsedMs:performance.now()-row.startedMs}))};save();
 },5000);
 async function context(user,locale='en',signIn=false){
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale});
  await context.addCookies([{name:'NEXT_LOCALE',value:locale,url:base}]);
  if(!signIn)await context.addCookies([{name:'__Host-aihr_internal',value:user.token,url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
  context.on('page',page=>{
   const pending=new Map(),pdfRequests=[];pendingBrowserRequests.set(page,pending);browserPdfRequests.set(page,pdfRequests);
   const pdfRequest=req=>new URL(req.url()).origin===base&&new URL(req.url()).pathname.endsWith('/pdf');
   const pdfResult=(req,outcome,extra={})=>{if(!pdfRequest(req))return;const row=pending.get(req);pdfRequests.push({path:new URL(req.url()).pathname,type:req.resourceType(),outcome,elapsedMs:row?performance.now()-row.startedMs:null,...extra});if(pdfRequests.length>40)pdfRequests.shift();};
   // Keep bounded transport facts only: no cookies, queries, file names or document bytes.
   page.on('requestfinished',req=>pdfResult(req,'finished'));
   page.on('requestfailed',req=>pdfResult(req,'failed',{error:req.failure()?.errorText}));
   page.on('response',response=>{if(pdfRequest(response.request()))pdfResult(response.request(),'response',{status:response.status(),contentType:response.headers()['content-type'],contentLength:response.headers()['content-length']});});
   page.on('request',req=>{const url=new URL(req.url());pending.set(req,{method:req.method(),path:url.origin===base?url.pathname:'<external>',sameOrigin:url.origin===base,type:req.resourceType(),startedMs:performance.now()});});
   page.on('requestfinished',req=>pending.delete(req));page.on('requestfailed',req=>pending.delete(req));
   page.on('response',response=>{const row=pending.get(response.request());if(row)row.status=response.status();});
   const started=new WeakMap();
   const homeRequest=req=>{const url=new URL(req.url());return url.origin===base&&url.pathname.startsWith('/api/home/')&&req.method()==='GET';};
   page.on('request',req=>{if(homeRequest(req))started.set(req,performance.now());});
   page.on('requestfinished',req=>{if(homeRequest(req))report.browserHomeRequests.push({role:user.role,path:new URL(req.url()).pathname,elapsedMs:performance.now()-(started.get(req)??performance.now()),outcome:'finished'});});
   page.on('requestfailed',req=>{if(homeRequest(req))report.browserHomeRequests.push({role:user.role,path:new URL(req.url()).pathname,elapsedMs:performance.now()-(started.get(req)??performance.now()),outcome:'failed',error:req.failure()?.errorText});});
   page.on('response',response=>{if(homeRequest(response.request())&&!response.ok())report.browserHomeRequests.push({role:user.role,path:new URL(response.url()).pathname,status:response.status(),outcome:'http-error'});});
   page.on('pageerror',error=>report.browserErrors.push({role:user.role,locale,error:error.name+': '+error.message.slice(0,150)}));
   page.on('console',message=>{if(message.type()==='error')report.browserErrors.push({role:user.role,locale,error:message.text().slice(0,150)});});
  });
  return context;
 }
 async function signInToHome(page,user){
  await page.goto(base+'/login?returnTo=%2F',{waitUntil:'domcontentloaded',timeout:90000});
  const username=page.locator('input[name="username"]');
  if(!await username.isVisible()){
   const workspace=page.locator('input[name="organization"]:visible');
   await workspace.fill(user.organization);
   await page.locator('form').filter({has:workspace}).locator('button[type="submit"]').click();
  }
  await username.fill(user.username);
  const password=page.locator('input[name="password"]');
  await password.fill(user.password);
  const passwordSubmittedAt=performance.now();
  await page.locator('form').filter({has:password}).locator('button[type="submit"]').click();
  const code=page.locator('input[name="code"]');
  await code.waitFor({state:'visible',timeout:90000});
  await code.fill(await generate({strategy:'totp',secret:user.secret}));
  const mfaSubmittedAt=performance.now();
  await page.locator('form').filter({has:code}).locator('button[type="submit"]').click();
  await page.waitForURL(url=>url.origin===base&&url.pathname==='/',{timeout:90000});
  const homeUrlSettledAt=performance.now();
  const session=(await page.context().cookies()).find(cookie=>cookie.name==='__Host-aihr_internal');
  assert(session&&session.value!==user.token,'browser sign-in did not establish a new session');
  return {passwordSubmittedAt,mfaSubmittedAt,homeUrlSettledAt};
 }
 async function visit(page,user,path,phase='baseline',signIn=false,loadState){
  lastPage=page;const stopHomeTracking=homeHttp.track(page,user,path);
  const start=performance.now();let response,signInTiming,visitStage=signIn?'sign-in':'navigation';
  const startedWith=loadState?.();
  try{
   if(signIn)signInTiming=await signInToHome(page,user);
   // Readiness is proved below. Network-idle adds an unrelated500ms quiet window.
   else response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:90000});
  visitStage='page-content';
  if(response)assert.equal(response.status(),200);
  assert(!new URL(page.url()).pathname.startsWith('/login'));await page.locator('main').waitFor();assert((await page.locator('body').innerText()).includes(user.name));
  visitStage='heading';
  const heading=(await page.locator('h1').first().innerText()).trim();assert(heading.length>0&&!/^404\b/.test(heading),'missing or not-found page heading');
  const skip=page.getByRole('dialog').getByRole('button',{name:'Skip',exact:true});
  if(await skip.isVisible()){await skip.click();await skip.waitFor({state:'hidden'});report.onboardingTourDismissals=(report.onboardingTourDismissals??0)+1;}
  visitStage='table-data';
  if(['/claims','/admin/personnel','/payroll'].includes(path)){
   // A streamed page can expose its heading/form before the actual table is attached.
   // Await the same required source rows; count() alone does not retry DOM readiness.
   const rows=page.locator('main tbody tr');
   if(path==='/admin/personnel'){
    const busy=page.locator('main [data-personnel-busy]');
    await rows.or(busy).first().waitFor({state:'attached',timeout:90000});
    if(await busy.count()){
     const reason=await busy.getAttribute('data-personnel-busy');
     visitStage=reason==='access-lock'?'personnel-access-lock':'personnel-statement-timeout';
     assert.fail('Personnel returned a busy screen before its rows rendered');
    }
   }else await rows.first().waitFor({state:'attached',timeout:90000});
   assert(await rows.count()>0,'expected fictional table rows');
  }
  if(path==='/me/payslip'){
   visitStage='payslip-statement';
   // The heading can stream before the actual statement. Keep the existing90s ceiling
   // and prove the real document control exists before taking identity/readiness snapshots.
   await page.getByRole('link',{name:'Download PDF',exact:true}).waitFor({state:'visible',timeout:90000});
  }
  if(suite==='whole-system'&&path==='/lifecycle'&&['companyHR','groupHR'].includes(user.role)){
   visitStage='lifecycle-staff-tiles';
   const open=user.role==='groupHR'?2:user.company<2?1:0,pending=user.role==='groupHR'||user.company===0?1:0;
   for(const [href,count] of [['/lifecycle/requisitions',open],['/lifecycle/requisitions?approval=pending',pending]]){
    await page.locator('main a[href="'+href+'"]').getByText(String(count),{exact:true}).waitFor({state:'visible',timeout:90000});
   }
   (report.lifecycleStaffHub??=[]).push({phase,role:user.role,open,pending});save();
  }
  let homeCards=null,homeCardIds=[],todaySectionIds=[];
  visitStage='home-cards';
  if(path==='/'||(path==='/me/calendar'&&['employee','manager'].includes(user.role))){
   const personal=['employee','manager'].includes(user.role),attribute=personal?'data-home-card':'data-dashboard-card';
   const cards=page.locator('main ['+attribute+']');
   await cards.first().waitFor({timeout:90000});
   await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:90000});
   const failures=await page.locator('main [role="alert"], main [data-today-unavailable], main [data-read-unavailable]').allTextContents();
   if(path==='/'){todaySectionIds=await page.locator('main [data-today-section]').evaluateAll(sections=>sections.map(section=>section.getAttribute('data-today-section')).sort());assert(todaySectionIds.length>0,'current Today sections missing');}
   if(failures.length)report.homeCardFailures.push({role:user.role,phase,messages:failures});
   // Keep collecting independent workflow and load evidence. A handled card error
   // still fails the run even if the other journeys meet their targets.
   homeCardIds=await cards.evaluateAll((cards,attribute)=>cards.map(card=>card.getAttribute(attribute)).sort(),attribute);
   if(path==='/'){
    const expectedCards=personal?['calendar','celebrations','notices','summary','tasks','team','timeOff','today']:
     ['attendanceOverview','companies','headcount','headcountByCompany','latestPayroll','latestPayrollRun','noticeBoard','pendingLeave','recentActivity','recentlyJoined','upcomingEvents'];
    assert.deepEqual(homeCardIds,[...expectedCards].sort(),'fictional Home must render every expected card');
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
  if(signIn){
   const cardsCheckedAt=performance.now();
   const result={phase,role:user.role,homeCards,homeCardIds,todaySectionIds,elapsedMs:cardsCheckedAt-start,
    startedWith,allCardsReadyWith:loadState?.(),
    passwordSubmitToAllCardsMs:cardsCheckedAt-signInTiming.passwordSubmittedAt,
    mfaSubmitToHomeUrlMs:signInTiming.homeUrlSettledAt-signInTiming.mfaSubmittedAt,
    mfaSubmitToAllCardsMs:cardsCheckedAt-signInTiming.mfaSubmittedAt,
    completeCardInventory:true,
    cardFailures:report.homeCardFailures.filter(row=>row.role===user.role&&row.phase===phase).length};
   const key=phase==='loaded'?'loadedBrowserSignIns':'preflightBrowserSignIns';
   (report[key]??=[]).push(result);
   if(phase==='loaded'&&user.index===employee.index)report.loadedBrowserSignIn=result;
   save();
  }
  report.browser.push({phase,role:user.role,path,heading,homeCards,homeCardIds,todaySectionIds,startedWith,elapsedMs:performance.now()-start,...timing});save();
  }catch(error){
   const detail={phase,role:user.role,user:user.index,path,errorType:error.name,visitStage,startedWith,...browserFailureLocation(error),elapsedMs:performance.now()-start,
    pdfRequests:browserPdfRequests.get(page)??[],
    frames:page.frames().map(frame=>{try{const url=new URL(frame.url());return {sameOrigin:url.origin===base,path:url.origin===base?url.pathname:'<other>'};}catch{return {path:'<unavailable>'};}}),dom:null};
   // Promise.all shutdown can make other pages fail later. Preserve the actual first visit.
   report.browserFailedNavigation??=detail;
   (report.browserVisitFailures??=[]).push({phase,role:user.role,user:user.index,path,errorType:error.name,visitStage,...browserFailureLocation(error)});
   report.browserPendingRequests=[...(pendingBrowserRequests.get(page)?.values()??[])].map(row=>({...row,elapsedMs:performance.now()-row.startedMs}));
   detail.dom=await page.locator('body').evaluate(body=>({readyState:document.readyState,headingCount:body.querySelectorAll('h1').length,mainCount:body.querySelectorAll('main').length,
    iframeCount:body.querySelectorAll('iframe').length,busyCount:body.querySelectorAll('[aria-busy="true"]').length,alertCount:body.querySelectorAll('[role="alert"]').length}),undefined,{timeout:3000}).catch(()=>null);
   save();throw error;
  }finally{stopHomeTracking();}
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
  const draft=path==='/claims'?claimDraftForm(page).locator('textarea[name="description"]:visible'):null;
  if(draft)await draft.fill('PERF_UNSUBMITTED_LANGUAGE_DRAFT');
  for(const locale of ['zh','en']){
   await page.getByRole('button',{name:'Change language',exact:true}).click();
   const start=performance.now(),startedWith=loadState?.();
   await page.getByRole('button',{name:names[locale],exact:true}).click();
   await page.waitForFunction(({locale,title})=>{
    const button=document.querySelector('button[aria-label="Change language"]');
    return document.documentElement.lang===locale&&button?.title===title&&!button.disabled&&button.getAttribute('aria-busy')==='false';
   },{locale,title:names[locale]},{timeout:90000});
   const messages=catalog(locale),expected=path==='/claims'?messages.claims.title:messages.people.list.adminTitle;
   await page.getByRole('heading',{level:1,name:expected,exact:true}).waitFor({timeout:90000});
   await page.locator('main tbody tr').first().waitFor({state:'visible',timeout:90000});
   if(draft)assert.equal(await draft.inputValue(),'PERF_UNSUBMITTED_LANGUAGE_DRAFT','language switch discarded an unsubmitted draft');
   (report.browserLanguageSwitches??=[]).push({role:user.role,path,phase,locale,startedWith,usableWith:loadState?.(),elapsedMs:performance.now()-start,translatedHeading:true,usable:true,draftRetained:!!draft});save();
  }
 }
 // These six independent read-only contexts run concurrently, matching the loaded browser bound.
 // Route/role assertions, per-request deadlines and the overall driver deadline stay unchanged.
 await Promise.all([employee,manager,hr,group,fixture.users[254],fixture.users[251]].map(async user=>{
  const ctx=await context(user),page=await ctx.newPage();
  try{
  for(const route of suite==='whole-system'?routePool(user):user.role==='employee'?['/','/claims','/leave','/attendance/individual']:user.role==='manager'?['/','/approvals','/performance/home']:['/','/admin/personnel','/payroll','/lifecycle/onboarding'])await visit(page,user,route);
  await page.screenshot({path:join(out,'browser-'+user.index+'.png'),fullPage:false});
  }finally{await ctx.close();}
 }));
 // Additional concrete pages have explicit rendered checks, separate from HTTP route counts.
 await Promise.all([employee,manager,hr,group].map(async user=>{
  const ctx=await context(user),page=await ctx.newPage();
  try{for(const path of additionalBrowserRoutes[user.role]){
   // The full workload already rendered these exact role/path pairs above. Keep each
   // required rendered check, without paying for an identical duplicate document load.
   if(!report.browser.some(row=>row.phase==='baseline'&&row.role===user.role&&row.path===path))await visit(page,user,path);
   assert(report.browser.some(row=>row.phase==='baseline'&&row.role===user.role&&row.path===path),'required rendered role/path missing');
  }}
  finally{await ctx.close();}
 }));
 async function aiCentreJourney(page,user,phase){
  await visit(page,user,'/assistant',phase);
  const askStarted=performance.now();
  try{
   // The page shell may finish before the streamed Ask composer. Require the actual enabled control.
   await page.locator('main textarea[name="question"]:enabled').waitFor({state:'visible',timeout:90000});
  }catch(error){
   (report.browserAiAskFailures??=[]).push({role:user.role,user:user.index,phase,path:new URL(page.url()).pathname,
    elapsedMs:performance.now()-askStarted});
   save();
   throw error;
  }
  const documents=[];const onRequest=request=>{if(request.resourceType()==='document')documents.push(request.url());};page.on('request',onRequest);
  try{
   const targets=[['jobs','/assistant?view=jobs'],['policies','/policies'],['insights','/assistant?view=insights'],['how','/assistant?view=how'],['ask','/assistant']];
   if(user.role==='companyHR')targets.splice(2,0,['operations','/control-tower'],['administration','/control-tower/agents/features']);
   for(const [tab,path] of targets){
    const readinessStarted=performance.now();
    const link=page.locator('[data-ai-centre-tabs] a[data-ai-centre-link-ready="true"][href="'+path+'"]');
    await link.waitFor({state:'visible',timeout:90000});
    const readinessWaitMs=performance.now()-readinessStarted,expected=new URL(path,base),start=performance.now();
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
  }finally{page.off('request',onRequest);}
  const history=fixture.assistantHistory?.[user.index];
  if(history){
   const traffic={rscRequests:0,prefetchRequests:0};
   const observe=request=>{const url=new URL(request.url());if(url.origin!==base||url.pathname!=='/assistant')return;const headers=request.headers();if(headers.rsc==='1')traffic.rscRequests++;if(headers['next-router-prefetch']==='1'||headers.purpose==='prefetch')traffic.prefetchRequests++;};
   page.on('request',observe);
   try{await verifyAssistantHistoryBrowser({page,history,visitAsk:()=>visit(page,user,'/assistant',phase),timeout:90000,onMeasurement:row=>{
    const totalMs=row.navigationToUsableMs??((row.clickToUsableMs??0)+(row.readinessWaitMs??0));
    (report.browserAssistantHistory??=[]).push({...row,phase,role:user.role,totalMs,targetMs:1000,targetMet:totalMs<1000});save();
   }});}finally{page.off('request',observe);(report.assistantHistoryTraffic??=[]).push({phase,role:user.role,...traffic});save();}
  }
 }
 // Exercise real password/MFA before any capacity test; these results are never loaded proof.
 await Promise.all([employee,manager,hr,group].map(async user=>{
  const ctx=await context(user,'en',true),page=await ctx.newPage();
  try{await visit(page,user,'/','sign-in-preflight',true);}finally{await ctx.close();}
 }));
 assert(['employee','manager','companyHR','groupHR'].every(role=>report.preflightBrowserSignIns?.some(row=>row.role===role&&row.homeCards>0&&row.todaySectionIds.length>0&&row.cardFailures===0)),'all four preflight sign-ins must load their dashboards');
 const aiBrowserActors=fixture.assistantHistory?[employee,hr,fixture.users[254],fixture.users[251]]:[employee,hr];
 const aiBaseline=await Promise.allSettled(aiBrowserActors.map(async user=>{
  const ctx=await context(user),page=await ctx.newPage();
  try{await aiCentreJourney(page,user,'baseline');}finally{await ctx.close();}
 }));
 report.aiBaselineFailures=aiBaseline.flatMap((result,index)=>result.status==='rejected'
  ?[{role:aiBrowserActors[index].role,userIndex:aiBrowserActors[index].index,error:String(result.reason.message).slice(0,220)}]:[]);
 save();
 if(suite==='whole-system'){
  const ctx=await context(group),page=await ctx.newPage();
  try{
   await exerciseOrgExplorer({page,user:group,fixture,report,save,phase:'baseline'});
   await exercisePersonnelSwitcher({page,user:group,fixture,report,save,phase:'baseline'});
   await exercisePayrollBrowser({base,page,user:group,fixture,report,save,phase:'baseline'});
  }finally{await ctx.close();}
 }
 if(suite==='whole-system'||suite==='workflow-preflight'){
  const ctx=await context(group),page=await ctx.newPage();
  try{
   await exerciseMovement({base,page,actor:group,subject:employee,fixture,db,report,save,phase:'baseline',recordEvent:suite==='workflow-preflight'});
   await exercisePayrollRegister({base,page,user:group,fixture,db,request,report,save});
   await exerciseSavedReport({page,user:group,fixture,db,base,phase:'baseline',thinkTimeMs,report,save});
  }finally{await ctx.close();}
  const foreignGroup=fixture.users.find(user=>user.role==='groupHR'&&user.tenant!==group.tenant);
  assert(foreignGroup,'Payroll register needs a foreign group HR boundary actor');
  for(const actor of [hr,foreignGroup]){
   const boundaryContext=await context(actor),boundaryPage=await boundaryContext.newPage();
   try{await verifyPayrollRegisterBoundary({base,page:boundaryPage,actor,owner:group,fixture,report,save});}
   finally{await boundaryContext.close();}
  }
 }
 // Tenant-wide AI spend and provider configuration keep their group-administrator guards.
 {
  const ctx=await context(hr),page=await ctx.newPage();
  try{for(const path of ['/control-tower/agents/spending','/control-tower/agents/provider']){
   await page.goto(base+path,{waitUntil:'networkidle',timeout:90000});
   await page.waitForURL(url=>url.pathname==='/control-tower/agents',{timeout:90000});
   report.boundaries.push({kind:'AI group-administrator-only route',role:hr.role,path,redirectDenied:true});save();
  }
  if(suite==='whole-system')await exercisePayrollBrowser({base,page,user:hr,fixture,report,save,phase:'baseline'});
  }finally{await ctx.close();}
 }
 // Locale projection and real client navigation must work before any capacity claim.
 for(const locale of ['en','ms','zh','ta','th','vi']){
  const ctx=await context(employee,locale),page=await ctx.newPage();await visit(page,employee,'/claims');
  const messages=JSON.parse(readFileSync(new URL('../../messages/'+locale+'.json',import.meta.url),'utf8'));
  const fallback=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
  const title=messages.claims?.title||fallback.claims.title;
  await page.getByRole('heading',{level:1,name:title,exact:true}).waitFor({state:'visible',timeout:90000});
  report.browser.at(-1).locale=locale;await ctx.close();
 }
 {
  const ctx=await context(employee),page=await ctx.newPage();await visit(page,employee,'/leave');
  const documents=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
  await Promise.all([page.waitForURL(url=>url.pathname==='/claims',{timeout:90000}),page.locator('a[href="/claims"]:visible').first().click()]);
  const catalog=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
  const heading=page.getByRole('heading',{level:1,name:catalog.claims.title,exact:true});
  const main=page.locator('main:visible').filter({has:heading});
  await heading.waitFor({state:'visible',timeout:90000});
  await claimDraftForm(page).locator('textarea[name="description"]:visible').waitFor();
  assert.equal(documents.length,0,'client link unexpectedly reloaded the document');
  assert(await main.locator('tbody tr:visible').count()>0,'client route has no visible Claims rows');
  assert((await main.innerText()).includes(catalog.claims.typeLabel),'client form lost route translations');
  report.browser.push({workflow:'client navigation',from:'/leave',to:'/claims',documentRequests:0,passed:true});await ctx.close();save();
 }
 for(const [user,path]of [[employee,'/claims'],[hr,'/admin/personnel']]){
  const ctx=await context(user),page=await ctx.newPage();
  try{await visit(page,user,path);await languageJourney(page,user,path,'baseline');}finally{await ctx.close();}
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
 async function browserClaimJourney(page,user,description,phase){
  await visit(page,user,'/claims',phase);const timings=[],form=claimDraftForm(page);
  const browserAction=()=>page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/claims',{timeout:90000});
  await form.locator('[name="claimTypeId"]:visible').selectOption(user.claimTypeId);await form.locator('[name="amount"]:visible').fill('1');await form.locator('[name="incurredOn"]:visible').fill(fixture.today);
  await form.locator('textarea[name="description"]:visible').fill(description);
  let started=performance.now();
  const [createResponse]=await Promise.all([browserAction(),form.locator('button[name="intent"][value="draft"]:visible').click()]);const createTemplate=await capturedAction(createResponse);
  await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});timings.push({operation:'create',visibleByMs:performance.now()-started});
  const [draft]=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft' and description=${description}`;assert(draft,'browser create did not persist');
  if(phase==='loaded')await pause(thinkTimeMs);
  await page.goto(base+'/claims?draft='+draft.id,{waitUntil:'networkidle'});await form.locator('[name="amount"]:visible').fill('2');started=performance.now();
  await form.locator('button[name="intent"][value="draft"]:visible').click();await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});timings.push({operation:'edit',visibleByMs:performance.now()-started});
  const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
  if(phase==='loaded')await pause(thinkTimeMs);
  await page.locator('main form:visible').filter({has:page.locator(`input[name="id"][value="${draft.id}"]`)}).getByRole('button').click();started=performance.now();
  const [deleteResponse]=await Promise.all([browserAction(),page.getByRole('button',{name:'Delete draft',exact:true}).click()]);const deleteTemplate=await capturedAction(deleteResponse);
  await page.waitForURL(url=>url.searchParams.get('toast')==='Draft deleted',{timeout:90000});timings.push({operation:'delete',visibleByMs:performance.now()-started});
  assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
  report.browser.push({phase,role:user.role,workflow:'claim create/edit/delete',persisted:true,timings});save();return {createTemplate,deleteTemplate};
 }
 {
  const ctx=await context(employee),page=await ctx.newPage();
  try{contextTemplates=await browserClaimJourney(page,employee,'PERF_BROWSER_DRAFT','baseline');}finally{await ctx.close();}
 }
 const {createTemplate,deleteTemplate}=contextTemplates;
 assert.equal(report.browserErrors.length,0,'baseline browser errors must be fixed before load');
 const actionProtocol=template=>({fieldNames:Object.keys(template.fields),fieldOrder:template.fieldOrder,prefix:template.prefix,status:template.status,
  arguments:Object.fromEntries(Object.entries(template.fields).filter(([key])=>/^\d+$/.test(key)).map(([key,value])=>{try{return [key,JSON.parse(value)];}catch{return [key,typeof value];}}))});
 report.actionProtocol={create:actionProtocol(createTemplate),delete:actionProtocol(deleteTemplate)};save();
 // Prove the captured browser protocol can be replayed before exercising another actor or load.
 {
  const description='PERF_HTTP_PREFLIGHT',fields={...createTemplate.fields};
  for(const [key,value]of Object.entries({employmentId:employee.employmentId,claimTypeId:employee.claimTypeId,amount:'1',incurredOn:fixture.today,description,intent:'draft'}))fields[createTemplate.prefix+key]=value;
  delete fields[createTemplate.prefix+'draftId'];
  const response=await request(employee,'/claims',fields,createTemplate.status,false,createTemplate.headers,createTemplate.fieldOrder);
  report.actionPreflight={status:response.status,redirect:response.headers['x-action-redirect']??response.headers.location??null,
   publicErrors:[...response.content.matchAll(/"error":"([^"\n]{1,300})"/g)].map(match=>match[1]).filter(value=>value!=='$undefined')};save();
  const [draft]=await db`select id from claim_request where employment_id=${employee.employmentId}::uuid and status='draft'and description=${description}`;
  assert(draft,'same-actor HTTP action preflight did not persist');
  await request(employee,'/claims',{...deleteTemplate.fields,[deleteTemplate.prefix+'employmentId']:employee.employmentId,[deleteTemplate.prefix+'id']:draft.id},deleteTemplate.status,false,deleteTemplate.headers,deleteTemplate.fieldOrder);
  assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
  report.actionPreflight.persisted=true;save();
 }
 // Real server actions must reject another employee's draft even for broadly visible HR actors.
 // Provision and clean up through the owner's HTTP action; the independent DB oracle only reads.
 for(const [actor,victim]of [[employee,fixture.users[5]],[hr,fixture.users[54]],[group,fixture.users[254]]]){
  const description='PERF_BOUNDARY_'+actor.index,fields={...createTemplate.fields};
  for(const [key,value]of Object.entries({employmentId:victim.employmentId,claimTypeId:victim.claimTypeId,amount:'7',incurredOn:fixture.today,description,intent:'draft'}))fields[createTemplate.prefix+key]=value;
  delete fields[createTemplate.prefix+'draftId'];
  await request(victim,'/claims',fields,createTemplate.status,false,createTemplate.headers,createTemplate.fieldOrder);
  const [protectedDraft]=await db`select id from claim_request where employment_id=${victim.employmentId}::uuid and status='draft' and description=${description}`;
  assert(protectedDraft,'boundary fixture did not persist through HTTP');
  for(const selector of [actor.employmentId,victim.employmentId]){
   const response=await request(actor,'/claims',{...deleteTemplate.fields,[deleteTemplate.prefix+'employmentId']:selector,[deleteTemplate.prefix+'id']:protectedDraft.id},deleteTemplate.status,false,deleteTemplate.headers,deleteTemplate.fieldOrder);
   const redirect=new URL(String(response.headers['x-action-redirect']??response.headers.location).split(';')[0],base);
   assert(redirect.searchParams.get('error'),'foreign draft deletion was not explicitly refused');
   const [unchanged]=await db`select employment_id,amount,status from claim_request where id=${protectedDraft.id}::uuid`;
   assert(unchanged);assert.equal(unchanged.employment_id,victim.employmentId);assert.equal(Number(unchanged.amount),7);assert.equal(unchanged.status,'draft');
   report.boundaries.push({kind:'foreign-draft-delete',role:actor.role,scope:actor.tenant!==victim.tenant?'other-tenant':actor.company!==victim.company?'other-company':'other-person',selector:selector===actor.employmentId?'own':'foreign',passed:true});
  }
  await request(victim,'/claims',{...deleteTemplate.fields,[deleteTemplate.prefix+'employmentId']:victim.employmentId,[deleteTemplate.prefix+'id']:protectedDraft.id},deleteTemplate.status,false,deleteTemplate.headers,deleteTemplate.fieldOrder);
  assert.equal((await db`select id from claim_request where id=${protectedDraft.id}::uuid`).length,0);
 }
 if(suite!=='claims-heavy')runMixedWorkflow=await prepareMixedWorkflows({context,visit,fixture,employee,hr,db,request,base,report,save,thinkTimeMs});
 let loadedAttendanceRejection;
 if(attendanceRejectionProbeEnabled&&suite!=='claims-heavy'){
  const baseline=await prepareAttendanceRejection({context,visit,fixture,db,report,save,phase:'baseline'});
  await baseline.run();
  if(suite==='whole-system')loadedAttendanceRejection=await prepareAttendanceRejection({context,visit,fixture,db,report,save,phase:'loaded'});
 }
 if(suite!=='claims-heavy'){
  const ctx=await context(employee),page=await ctx.newPage();let automaticPdfRequests=0;
  const observe=req=>{if(req.method()==='GET'&&/^\/me\/payslip\/[^/]+\/pdf$/.test(new URL(req.url()).pathname))automaticPdfRequests++;};
  page.on('request',observe);
  try{
   await visit(page,employee,'/me/payslip');assert.equal(automaticPdfRequests,0,'opening the statement requested a PDF without a download click');page.off('request',observe);
   const text=await page.locator('main').innerText(),code='PERF'+String(employee.index).padStart(4,'0');
   assert(text.includes(employee.name)&&text.includes(code),'own statement identity missing');assert(/5,000\.00/.test(text),'native fixture salary missing from statement');
   const link=page.getByRole('link',{name:'Download PDF',exact:true}),href=await link.getAttribute('href');assert(/^\/me\/payslip\/[^/]+\/pdf$/.test(href??''));
   const [download]=await Promise.all([page.waitForEvent('download',{timeout:90000}),link.click()]);
   // Chromium can hand attachment navigation to its download manager without a normal page Response.
   // Check transport headers independently with the same real browser context/cookies.
   const transport=await ctx.request.get(base+href);assert.equal(transport.status(),200);
   assert(String(transport.headers()['content-type']).includes('application/pdf'));assert(String(transport.headers()['content-disposition']).includes('attachment'));assert(String(transport.headers()['cache-control']).includes('no-store'));
   const stream=await download.createReadStream();assert(stream);const chunks=[];let bytes=0;
   for await(const chunk of stream){bytes+=chunk.length;assert(bytes<=12*1024*1024,'PDF exceeded diagnostic ceiling');chunks.push(chunk);}
   const file=Buffer.concat(chunks);assert(bytes>1000);assert.equal(file.subarray(0,5).toString(),'%PDF-');assert.equal(await download.failure(),null);assert(download.suggestedFilename().includes(code));
   const {PDFDocument}=await import('pdf-lib'),document=await PDFDocument.load(file),pages=document.getPageCount();assert(pages>0&&pages<=10);
   for(const target of [fixture.users[5],fixture.users[254]]){
    const [slip]=await db`select id from payslip where employment_id=${target.employmentId}::uuid order by created_at desc limit 1`;assert(slip);
    const denied=await ctx.request.get(base+'/me/payslip/'+slip.id+'/pdf');assert.equal(denied.status(),404,'foreign own-only PDF was accessible');report.boundaries.push({kind:'foreign-own-payslip-pdf',scope:target.tenant===employee.tenant?'same-company-other-person':'other-tenant',passed:true});
   }
   report.payslipDocument={nativeDownload:true,automaticPdfRequests,bytes,pages,ownIdentity:true,foreignBoundaries:2};save();
  }finally{await ctx.close();}
 }
 if(suite==='workflow-preflight'){
  const ctx=await context(hr),page=await ctx.newPage();
  try{await exerciseLivePersonnelProfile({page,user:hr,fixture,db,request,report,save,phase:'baseline'});}finally{await ctx.close();}
 }
 assert.equal(report.browserErrors.length,0,'mutation/processing browser runtime errors');
 await homeHttp.read(fixture.users[5],false);await homeHttp.read(fixture.users[3],false);
 await homeHttp.boundary(employee,fixture.users[5]);await homeHttp.boundary(manager,employee);
 await databaseSnapshot('pilot');
 if(report.coverage.some(v=>v.status==='failed'))throw Error('Pilot route failures must be diagnosed before a 500-user run');
 if(suite==='workflow-preflight'){
  assert.equal(report.aiBaselineFailures.length,0,'AI Centre baseline browser journeys failed');
  await exerciseLetterDraft({base,context,visit,fixture,db,report,save});
  const {exercisePerformanceRewardsDrafts}=await import('./performance-rewards-draft-browser.mjs');
  await exercisePerformanceRewardsDrafts({base,context,fixture,db,report,save});
  await verifyAudit();save();
  assert.equal(report.homeCardFailures.length,0,'Home rendered a handled card/summary failure');
  report.preflightPassed=true;save();return;
 }
 const lockKeys=[];
 for(const [index,tenant]of fixture.tenants.entries()){
  for(const [kind,key]of [['access-configuration','access-configuration:'+tenant.tenantId],['payroll-history','payroll-history:'+tenant.tenantId],['pay-component-catalog',tenant.tenantId+':pay-component-catalog']])lockKeys.push({label:kind+':fixture-tenant-'+index,key});
 }
 for(const user of fixture.users)lockKeys.push({label:'employment:fixture-user-'+user.index,key:fixture.tenants[user.tenant].tenantId+':'+user.employmentId});
 const hashedLocks=await db`select k,((hashtextextended(k,0)>>32)&4294967295)::text as classid,(hashtextextended(k,0)&4294967295)::text as objid from unnest(${lockKeys.map(row=>row.key)}::text[])k`;
 const labelsByKey=new Map(lockKeys.map(row=>[row.key,row.label])),lockLabels=new Map(hashedLocks.map(row=>[row.classid+':'+row.objid+':1',labelsByKey.get(row.k)]));
 // Audit's native key uses hashtext (int4), unlike the other bigint advisory namespaces.
 for(const [index,tenant]of fixture.tenants.entries()){
  const [row]=await db`select ((hashtext(${'audit-chain:'+tenant.tenantId})::bigint>>32)&4294967295)::text as classid,(hashtext(${'audit-chain:'+tenant.tenantId})::bigint&4294967295)::text as objid`;
  lockLabels.set(row.classid+':'+row.objid+':1','audit-chain:fixture-tenant-'+index);
 }
 await db`select pg_stat_statements_reset()`;
 const waits=[],rootStatements=new Map();let samplingBusy=false;
 sampling=setInterval(async()=>{
  if(samplingBusy)return;samplingBusy=true;
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
   const locks=await db`select a.pid,pg_blocking_pids(a.pid)as blockers,l.mode,l.classid::text,l.objid::text,l.objsubid,
     a.usename='ai_hr_app' as app_session from pg_locks l join pg_stat_activity a on a.pid=l.pid
     where a.datname=current_database()and l.database=(select oid from pg_database where datname=current_database())
       and l.locktype='advisory'and not l.granted order by a.pid limit 20`;
   appConnections.sampledAdvisoryWaiters=new Set(locks.filter(row=>row.app_session).map(row=>row.pid)).size;
   const pids=[...new Set(locks.flatMap(row=>row.blockers??[]))].filter(pid=>Number.isSafeInteger(pid)&&pid>0).slice(0,20);
   // Native holder state and normalized query IDs only; never capture statement parameters.
   const holders=pids.length?await db.unsafe('select pid,state,wait_event_type,wait_event,query_id::text,extract(epoch from(clock_timestamp()-xact_start))as transaction_age_seconds from pg_stat_activity where datname=current_database()and pid in('+pids.map((_,i)=>'$'+(i+1)).join(',')+')',pids):[];
   waits.push({at:Date.now(),rows,appConnections,blockingSessions:holders,advisoryWaiters:locks.map(row=>({pid:row.pid,blockers:row.blockers,mode:row.mode,namespace:lockLabels.get(row.classid+':'+row.objid+':'+row.objsubid)??'unclassified'}))});
   // The top-statement summary can omit rare root holders. Resolve only sampled root IDs,
   // never queued waiters or parameters; all data belongs to the fictional runner fixture.
   const queued=new Set(locks.map(row=>row.pid));
   const missing=[...new Set(holders.filter(row=>!queued.has(row.pid)&&/^-?[0-9]+$/.test(row.query_id??'')&&!rootStatements.has(row.query_id)).map(row=>row.query_id))].slice(0,128-rootStatements.size);
   if(missing.length)try{
    const statements=await db`select queryid::text,left(query,2400) as normalized_query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and queryid=ANY(${missing}::bigint[])`;
    for(const row of statements)rootStatements.set(row.queryid,{...row,firstSeenAt:Date.now()});
    writeFileSync(join(out,'blocking-statements.json'),JSON.stringify({scope:'Normalized sampled root advisory-lock-holder queries only; no parameters; correlation is not exclusive causal attribution',maxQueries:128,statements:[...rootStatements.values()]},null,2));
   }catch{report.blockingStatementCaptureUnavailable=true;}

  }catch{}finally{samplingBusy=false;}
 },1000);
 const resourceCpuBefore=resourceCpu(),appCpuBefore=appCpu(),driverCpuBefore=process.cpuUsage();
 const offset=samples.length,started=performance.now(),steadyStart=started+10000,steadyUntil=steadyStart+steadyHoldMs;
 const progress={launched:0,active:0,peakActive:0,completed:0,failed:0,iterations:0};
 report.trafficSettled=false;report.functionalAccountingComplete=false;
 report.measurementWindow={startPerformanceMs:started,steadyStartPerformanceMs:steadyStart,steadyUntilPerformanceMs:steadyUntil};
 report.telemetry={querySnapshotIntervalMs:30000,resourceCounterIntervalMs:30000,holderQueries:'bounded native pid/state/query-id; up to128normalizedrootquerytexts withoutparameters',appConnections:'sampled PostgreSQL backends for ai_hr_app; excludes application-side queue length',partialSamplesAreAcceptance:false};
 let sqlSnapshotBusy=false;
 sqlSnapshotTimer=setInterval(async()=>{
  if(sqlSnapshotBusy)return;sqlSnapshotBusy=true;
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
   save();
  }catch{report.resourceCpuProgressFailures=(report.resourceCpuProgressFailures??0)+1;save();}
  try{await databaseSnapshot('loaded-progress');report.sqlProgressSnapshots=(report.sqlProgressSnapshots??0)+1;}
  catch{report.sqlProgressSnapshotFailures=(report.sqlProgressSnapshotFailures??0)+1;}
  finally{sqlSnapshotBusy=false;}
 },30000);
 progressTimer=setInterval(()=>{
  const loaded=samples.slice(offset);report.progress={...progress,elapsedMs:performance.now()-started};
  const currentAppCpu=appCpu(),driverCpu=process.cpuUsage(driverCpuBefore);
  report.partialTiming={kind:'INCOMPLETE_PROGRESS_SNAPSHOT',complete:false,read:summary(loaded.filter(v=>v.method==='GET').map(v=>v.durationMs)),write:summary(loaded.filter(v=>v.method==='POST').map(v=>v.durationMs)),knownRequestErrors:report.requestErrors?.length??0,transportErrorsOnly:true,httpErrorResponses:loaded.filter(v=>v.status>=400).length,
   partialCpu:{appCpuSeconds:appCpuBefore!==null&&currentAppCpu!==null?currentAppCpu-appCpuBefore:null,driverCpuSeconds:(driverCpu.user+driverCpu.system)/1e6,elapsedSeconds:(performance.now()-started)/1000,postgresCpuUnavailable:true},
   appMemory:{processes:appMemory(),peakIncludesStartupAndBaseline:true}};
  save();writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));
 },5000);
 const loadState=()=>{
  const now=performance.now();
  return {active:progress.active,launched:progress.launched,inSteadyWindow:now>=steadyStart&&now<steadyUntil};
 };
 async function waitForSteadyUsers(){
  while(performance.now()<steadyUntil&&(performance.now()<steadyStart||progress.active<500))await pause(25);
 }
 // Representative hydrated browsers share the load interval with all 500 HTTP principals.
 const browserLoad=Promise.allSettled([employee,manager,hr,group,fixture.users[254],fixture.users[251]].map(async user=>{
  const signIn=[employee,manager,hr,group].some(actor=>actor.index===user.index);
  const ctx=await context(user,'en',signIn),page=await ctx.newPage();
  const routes=user.role==='employee'?['/','/claims','/leave','/attendance/individual']
   :user.role==='manager'?['/','/approvals','/claims','/performance/home']:['/','/admin/personnel','/payroll','/claims'];
  // The two existing-session actors start on the target pages so the language proof
  // is not queued behind the sign-in and Home sequence of the four real-login actors.
  if(suite==='whole-system'&&!signIn)routes.unshift(...routes.splice(1,1));
  try{await waitForSteadyUsers();for(const route of routes){
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
   await exercisePayrollBrowser({base,page,user,fixture,report,save,phase:'loaded',loadState});
  }
  }catch(error){
   (report.browserJourneyFailures??=[]).push({role:user.role,user:user.index,phase:'loaded',errorType:error.name,...browserFailureLocation(error),timeout:error.name==='TimeoutError'});save();throw error;
  }finally{await ctx.close();}
 }));
 const attendanceRejectionLoad=loadedAttendanceRejection
  ?Promise.allSettled([loadedAttendanceRejection.run({loadState:()=>({active:progress.active,launched:progress.launched}),steadyUntil})])
  :null;
 const movementLoad=suite==='whole-system'?Promise.allSettled([(async()=>{
  const ctx=await context(group);
  try{
   const page=await ctx.newPage();
   await waitForSteadyUsers();
   await exerciseMovement({base,page,actor:group,subject:employee,fixture,db,report,save,phase:'loaded',recordEvent:true,loadState});
  }finally{await ctx.close();}
 })()]):null;
 const savedReportsLoad=suite==='whole-system'?Promise.allSettled([(async()=>{
  const ctx=await context(group);
  try{
   const page=await ctx.newPage();
   await exerciseSavedReport({page,user:group,fixture,db,base,phase:'loaded',thinkTimeMs,report,save,
    loadState,waitForFirstWrite:waitForSteadyUsers});
  }finally{await ctx.close();}
 })()]):null;
 const results=await Promise.allSettled(fixture.users.map(async(user,i)=>{
  await pause(i*20);progress.launched++;progress.active++;progress.peakActive=Math.max(progress.peakActive,progress.active);
  let iteration=0;
  try{do{
  const pool=routePool(user);
  const ordinal=roleOrdinals.get(user.index);
  const routes=suite!=='whole-system'?measuredRoutePools[user.role]:
   iteration===0&&user.role==='groupHR'?firstGroupRoutes[ordinal]:
   navigationRoutesForIteration(pool,{role:user.role,ordinal,actors:roleCounts.get(user.role),iteration});
  for(const route of routes){const navigationStarted=performance.now();await request(user,route);
   if(route==='/'&&['employee','manager'].includes(user.role))await homeHttp.read(user,true);
   pageInteractions.push({role:user.role,route,startedMs:navigationStarted,durationMs:performance.now()-navigationStarted});await pause(thinkTimeMs);
  }
  if(runMixedWorkflow&&await runMixedWorkflow(user,iteration)){await pause(thinkTimeMs);iteration++;progress.iterations++;continue;}
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
  }catch(error){progress.failed++;throw error;}finally{progress.active--;}
 }));
 const browserResults=await browserLoad;
 const rejectionResults=await attendanceRejectionLoad;
 const movementResults=await movementLoad;
 const savedReportResults=await savedReportsLoad;
 if(movementResults){
  const [result]=movementResults;
  report.movementLoad=result.status==='fulfilled'?{status:'completed'}:{status:'failed',error:String(result.reason.message).slice(0,180)};
 }

 report.trafficSettled=true;
 report.browserLoad={contexts:browserResults.length,completed:browserResults.filter(v=>v.status==='fulfilled').length,errors:browserResults.flatMap((v,index)=>v.status==='rejected'?[{index,error:String(v.reason.message).slice(0,180)}]:[])};
 clearInterval(sampling);sampling=null;clearInterval(progressTimer);progressTimer=null;if(sqlSnapshotTimer)clearInterval(sqlSnapshotTimer);sqlSnapshotTimer=null;report.progress={...progress,elapsedMs:performance.now()-started};
 report.functionalErrors=results.flatMap((value,index)=>value.status==='rejected'?[{user:index,error:String(value.reason.message).slice(0,180)}]:[]);report.functionalAccountingComplete=true;
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
 report.steady={durationMs:steadyHoldMs,roles:Object.fromEntries(['employee','manager','companyHR','groupHR'].map(role=>[role,{
  navigation:summary(pageInteractions.filter(v=>v.role===role&&v.startedMs>=steadyStart&&v.startedMs<steadyUntil).map(v=>v.durationMs)),
  read:summary(steady.filter(v=>v.role===role&&v.method==='GET').map(v=>v.durationMs)),
  write:summary(steady.filter(v=>v.role===role&&v.method==='POST').map(v=>v.durationMs)),
 }]))};
 report.steady.routeLatency=routeLatency({samples:loaded,pageInteractions,routePools:measuredRoutePools,homeTemplates:suite==='whole-system'?report.homeApiTraffic.templates:[],steadyStart,steadyUntil});
 report.latencyTargetMet=progress.peakActive===500&&report.steady.routeLatency.targetMet&&Object.values(report.steady.roles).every(role=>role.navigation.samples>0&&role.navigation.p95Ms<1000&&role.read.samples>0&&role.write.samples>0&&role.read.p95Ms<1000&&role.write.p95Ms<500);
 writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));
 report.concurrentHomeApiCoverage=report.homeApiTraffic.templates.flatMap(({role,requests})=>requests.map(({path})=>({role,path,requests:loaded.filter(sample=>sample.role===role&&sample.method==='GET'&&sample.route===path).length})));
 await databaseSnapshot('loaded');await verifyAudit();save();
 if(rejectionResults?.[0].status==='rejected')throw rejectionResults[0].reason;
 if(suite==='whole-system'){
  const movement=report.browserMovementJourneys?.find(row=>row.phase==='loaded');
  assert(movement?.auditVerified&&['history','newEvent','save'].every(step=>{
   const evidence=movement.steps[step];
   return evidence?.status==='passed'&&evidence.startedWith?.active===500&&evidence.startedWith.inSteadyWindow;
  }),'Movement history, New Event and audited save must start during steady 500-user load');
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
 if(suite==='whole-system')assert(report.concurrentHomeApiCoverage.length>0&&report.concurrentHomeApiCoverage.every(row=>row.requests>0),'observed Home fetches missing from concurrent traffic');if(runMixedWorkflow)assert(Object.values(report.mixedWorkflows.completed).every(count=>count>0),'a required mixed mutation/processing scenario did not complete');if(suite==='whole-system')assert(report.concurrentRouteCoverage.every(route=>route.requests>0),'wider concurrent route coverage incomplete');assert.equal(report.functionalErrors.length,0,'HTTP journey failures');assert.equal(report.homeCardFailures.length,0,'Home rendered a handled card/summary failure during baseline or load');assert(report.loadedBrowserSignIn?.homeCards>0,'real loaded browser sign-in did not finish');
 assert.equal(report.aiBaselineFailures.length,0,'AI Centre baseline browser journeys failed');
 assert(['employee','manager','companyHR','groupHR'].every(role=>report.loadedBrowserSignIns?.some(row=>
  row.role===role&&row.homeCards>0&&row.todaySectionIds.length>0&&row.cardFailures===0
  &&row.startedWith?.active===500&&row.startedWith.inSteadyWindow
 )),'all four role dashboards must load after real sign-in started during steady 500-user load');
 if(suite==='whole-system'){
  const duringSteady500=row=>row.startedWith?.active===500&&row.startedWith.inSteadyWindow;
  assert(report.browser.some(row=>row.phase==='loaded'&&row.path==='/admin/personnel'&&duringSteady500(row)),
   'Personnel browser navigation did not start during steady 500-user load');
  assert(['/claims','/admin/personnel'].every(path=>['zh','en'].every(locale=>
   report.browserLanguageSwitches?.some(row=>row.phase==='loaded'&&row.path===path&&row.locale===locale&&row.usable&&duringSteady500(row))
  )),'Claims and Personnel language switches must start during steady 500-user load');
 }
 assert.equal(report.browserErrors.length,0,'browser runtime errors');assert.equal(report.browserLoad.errors.length,0,'loaded browser journeys');if(suite==='whole-system')assert(['baseline','loaded'].every(phase=>report.orgExplorerJourneys?.some(row=>row.phase===phase&&row.status==='passed')),'Org browser scope and language journeys did not finish');if(fixture.assistantHistory)assert(aiBrowserActors.every(user=>['saved-history-list','saved-history-open','saved-history-return'].every(step=>report.browserAssistantHistory?.some(row=>row.phase==='loaded'&&row.userIndex===user.index&&row.step===step&&row.targetMet))),'populated saved-history browser navigation incomplete or above1s target');assert(report.latencyTargetMet,'500-user HTTP p95 latency target was not met');
}catch(error){report.browserPendingRequests??=[...(pendingBrowserRequests.get(lastPage)?.values()??[])].map(row=>({...row,elapsedMs:performance.now()-row.startedMs}));if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:join(out,'browser-failure.png'),fullPage:false}).catch(()=>{});report.error=String(error.message).slice(0,350);writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));await databaseSnapshot('failure').catch(()=>{});save();throw error;}
finally{
 if(sqlSnapshotTimer)clearInterval(sqlSnapshotTimer);if(browserDiagnosticTimer)clearInterval(browserDiagnosticTimer);if(progressTimer)clearInterval(progressTimer);if(sampling)clearInterval(sampling);
 report.shutdown={browserClosed:false,nativeAuditPoolClosed:nativeAuditClient===undefined,driverPoolClosed:false};
 if(browser)await browser.close();report.shutdown.browserClosed=true;agent.destroy();save();
 // verifyTenantChain imports the canonical application pool as well as this driver's observer pool.
 // Both belong only to this isolated child. Leave no live native pool after a successful preflight.
 await closePerformanceDbPools(nativeAuditClient,db,key=>{report.shutdown[key]=true;save();});
}
}
await main();
