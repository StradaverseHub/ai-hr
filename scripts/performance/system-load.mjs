/** Real HTTPS requests + Chromium against the isolated production server; no auth/test route bypass. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHomeHttpReplay} from './home-http.mjs';
import {prepareMixedWorkflows} from './mixed-workflows.mjs';
import {actionFormData} from './action-form.ts';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import {createGunzip} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';
import {chromium} from 'playwright';
import postgres from 'postgres';
const base='https://localhost:3443',out=process.env.PERF_EVIDENCE_DIR;
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(new URL(process.env.DATABASE_URL).pathname,'/ai_hr_system_perf');
const fixture=JSON.parse(readFileSync(join(process.env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:2});
const agent=new https.Agent({keepAlive:true,maxSockets:4000,rejectUnauthorized:false,
 lookup:(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)});
const suite=process.env.PERF_HTTP_SUITE||'claims-heavy';assert(['claims-heavy','whole-system','workflow-preflight'].includes(suite));
const thinkTimeMs=Number(process.env.PERF_HTTP_THINK_MS||1000);assert([1000,5000].includes(thinkTimeMs));
const steadyHoldMs=Number(process.env.PERF_HTTP_HOLD_MS||30000);assert([30000,300000].includes(steadyHoldMs));
const report={suite,kind:suite==='workflow-preflight'?'HTTP_WORKFLOW_PREFLIGHT_ONLY':'HTTP_AND_CHROMIUM_DEVELOPMENT_ONLY',releaseEligible:false,users:suite==='workflow-preflight'?0:500,fixtureUsers:500,tenants:2,companies:10,startedAt:new Date().toISOString(),
 assumptions:{arrivalWindowMs:10000,thinkTimeMs,steadyHoldMs,navigation:'full-document HTTP stress, observed subject-bound Home GETs and real server actions',driverMaxSockets:4000,tls:'fixture-only self-signed localhost',browserContexts:6,persistenceObserverPrincipals:6,persistencePollIntervalMs:100,loginEnrollmentLoad:false,performanceFixture:'enabled dashboard; no assigned review cycle; task-gated tabs excluded'},
 workloadManifest:{readRoutes:30,mutations:['Claims draft create/edit/delete','Leave request create/edit/withdraw','Personnel draft create/edit/delete','Attendance correction and authorized approval'],processing:['Payroll calculation','scoped Payroll CSV generation','clocking-file validation/import'],notCovered:['Payroll close/publish','Lifecycle mutations','Performance mutations','Rewards mutations','large Personnel imports','report-definition CRUD','long-running document jobs'],productionEquivalent:false},
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
const homeHttp=createHomeHttpReplay({base,fixture,request,report});
async function request(user,path,fields,expectedStatus=200,record=true,actionHeaders={},fieldOrder=[]){
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
 }).catch(error=>{(report.requestErrors??=[]).push({user:user?.index??null,role:user?.role??'anonymous',route:path.split('?')[0],method:fields?'POST':'GET',elapsedMs:performance.now()-started,error:String(error.message).slice(0,180)});throw error;});
 response.durationMs=performance.now()-started;
 if(record)samples.push({user:user?.index??null,role:user?.role??'anonymous',route:path.split('?')[0],method:fields?'POST':'GET',status:response.status,startedMs:started,durationMs:response.durationMs,ttfbMs:response.ttfbMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes});
 assert.equal(response.status,expectedStatus,`Unexpected HTTP status for ${path.split('?')[0]}`);
 if(!fields&&expectedStatus===200&&!path.startsWith('/api/')&&!String(response.headers['content-type']).includes('text/csv')){
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
async function verifyAudit(){
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
const employeeRoutes=['/','/me','/claims','/leave','/attendance/individual','/me/payslip','/notices','/performance/home','/lifecycle'];
const hrRoutes=['/admin/personnel','/attendance','/payroll','/reports','/reports/employee-master','/lifecycle/onboarding','/lifecycle/offboarding','/roster','/letters/register','/performance','/rewards','/system-testing','/feedback','/knowledge-base','/control-tower','/admin/settings/movement','/admin/security-center','/payroll/formula-builder','/payroll/formula-builder/new'];
const managerRoutes=['/','/approvals','/approvals/history','/performance/home','/claims'];
const routePool=user=>user.role==='employee'?employeeRoutes:user.role==='manager'?managerRoutes:[...hrRoutes,'/claims'];
const roleCounts=new Map(),roleOrdinals=new Map(fixture.users.map(user=>{const ordinal=roleCounts.get(user.role)??0;roleCounts.set(user.role,ordinal+1);return [user.index,ordinal];}));
let browser,sampling,progressTimer,contextTemplates,lastPage,runMixedWorkflow;
async function main(){
try{
 save();await db`select pg_stat_statements_reset()`;
 const anonymous=await request(null,'/claims',undefined,307,false);assert(String(anonymous.headers.location).includes('/login'));report.boundaries.push({kind:'anonymous',passed:true});
 for(const user of [employee,manager,hr,group]){
  const routes=user===employee?employeeRoutes:user===manager?['/approvals','/approvals/history','/performance/home']:hrRoutes;
  for(const route of routes){
   const diagnostic=setTimeout(()=>{databaseSnapshot('slow-pilot').catch(()=>{});},10000);
   try{const response=await request(user,route);report.coverage.push({role:user.role,route,status:'passed',durationMs:response.durationMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes});}
   catch(error){report.coverage.push({role:user.role,route,status:'failed',reason:String(error.message).slice(0,180)});save();throw error;}finally{clearTimeout(diagnostic);}
   save();
  }
 }
 // Direct record and search fences exercise ordinary web authorization, not a test-only endpoint.
 for(const [actor,target]of [[hr,fixture.users[50]],[group,fixture.users[250]]]){
  const response=await request(actor,'/api/personnel/search?q='+encodeURIComponent(target.name));
  assert.deepEqual(JSON.parse(response.content).rows,[]);report.boundaries.push({kind:'company-or-tenant-search',role:actor.role,passed:true});
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
 report.browserVersion=browser.version();
 async function context(user,locale='en'){
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale});
  await context.addCookies([{name:'__Host-aihr_internal',value:user.token,url:base,secure:true,httpOnly:true,sameSite:'Lax'},{name:'NEXT_LOCALE',value:locale,url:base}]);
  context.on('page',page=>{
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
 async function visit(page,user,path,phase='baseline'){
  lastPage=page;const stopHomeTracking=homeHttp.track(page,user,path);
  const start=performance.now();const response=await page.goto(base+path,{waitUntil:'networkidle',timeout:90000});assert.equal(response.status(),200);
  assert(!new URL(page.url()).pathname.startsWith('/login'));await page.locator('main').waitFor();assert((await page.locator('body').innerText()).includes(user.name));
  const heading=(await page.locator('h1').allTextContents()).join(' ').trim();assert(heading.length>0&&!/^404\b/.test(heading),'missing or not-found page heading');
  const skip=page.getByRole('dialog').getByRole('button',{name:'Skip',exact:true});
  if(await skip.isVisible()){await skip.click();await skip.waitFor({state:'hidden'});report.onboardingTourDismissals=(report.onboardingTourDismissals??0)+1;}
  if(['/claims','/admin/personnel','/payroll'].includes(path))assert(await page.locator('main tbody tr').count()>0,'expected fictional table rows');
  let homeCards=null;
  if(path==='/'&&['employee','manager'].includes(user.role)){
   await page.locator('[data-home-card]').first().waitFor({timeout:90000});
   await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:90000});
   const failures=await page.locator('main [role="alert"]').allTextContents();
   if(failures.length)report.homeCardFailures.push({role:user.role,phase,messages:failures});
   // Keep collecting independent workflow evidence, then refuse load/acceptance below.
   // A handled card error must never become a passing preflight or a capacity result.
   homeCards=await page.locator('[data-home-card]').count();assert(homeCards>0,'expected fictional Home cards');
  }
  const timing=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {ttfbMs:n.responseStart-n.requestStart,domInteractiveMs:n.domInteractive,decodedBytes:n.decodedBodySize,transferBytes:n.transferSize};});
  stopHomeTracking();
  report.browser.push({phase,role:user.role,path,heading,homeCards,elapsedMs:performance.now()-start,...timing});save();
 }
 for(const user of [employee,manager,hr,group,fixture.users[254],fixture.users[251]]){
  const ctx=await context(user),page=await ctx.newPage();
  for(const route of suite==='whole-system'?routePool(user):user.role==='employee'?['/','/claims','/leave','/attendance/individual']:user.role==='manager'?['/','/approvals','/performance/home']:['/admin/personnel','/payroll','/lifecycle/onboarding'])await visit(page,user,route);
  await page.screenshot({path:join(out,'browser-'+user.index+'.png'),fullPage:false});await ctx.close();
 }
 // Locale projection and real client navigation must work before any capacity claim.
 for(const locale of ['en','ms','zh','ta','th','vi']){
  const ctx=await context(employee,locale),page=await ctx.newPage();await visit(page,employee,'/claims');
  const messages=JSON.parse(readFileSync(new URL('../../messages/'+locale+'.json',import.meta.url),'utf8'));
  const fallback=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
  assert((await page.locator('h1').innerText()).includes(messages.claims?.title||fallback.claims.title));
  report.browser.at(-1).locale=locale;await ctx.close();
 }
 {
  const ctx=await context(employee),page=await ctx.newPage();await visit(page,employee,'/leave');
  const documents=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
  await Promise.all([page.waitForURL(url=>url.pathname==='/claims',{timeout:90000}),page.locator('a[href="/claims"]:visible').first().click()]);
  await page.locator('textarea[name="description"]').waitFor();assert.equal(documents.length,0,'client link unexpectedly reloaded the document');
  assert.equal((await page.locator('h1').innerText()).trim(),'Claims');assert(await page.locator('main tbody tr').count()>0);
  const catalog=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
  assert((await page.locator('main').innerText()).includes(catalog.claims.typeLabel),'client form lost route translations');
  report.browser.push({workflow:'client navigation',from:'/leave',to:'/claims',documentRequests:0,passed:true});await ctx.close();save();
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
  await visit(page,user,'/claims',phase);const timings=[];
  const browserAction=()=>page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/claims',{timeout:90000});
  await page.locator('[name="claimTypeId"]').selectOption(user.claimTypeId);await page.locator('[name="amount"]').fill('1');await page.locator('[name="incurredOn"]').fill(fixture.today);
  await page.locator('textarea[name="description"]').fill(description);
  let started=performance.now();
  const [createResponse]=await Promise.all([browserAction(),page.locator('button[name="intent"][value="draft"]').click()]);const createTemplate=await capturedAction(createResponse);
  await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});timings.push({operation:'create',visibleByMs:performance.now()-started});
  const [draft]=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft' and description=${description}`;assert(draft,'browser create did not persist');
  if(phase==='loaded')await pause(thinkTimeMs);
  await page.goto(base+'/claims?draft='+draft.id,{waitUntil:'networkidle'});await page.locator('[name="amount"]').fill('2');started=performance.now();
  await page.locator('button[name="intent"][value="draft"]').click();await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});timings.push({operation:'edit',visibleByMs:performance.now()-started});
  const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
  if(phase==='loaded')await pause(thinkTimeMs);
  await page.locator('form').filter({has:page.locator(`input[name="id"][value="${draft.id}"]`)}).first().getByRole('button').click();started=performance.now();
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
 await homeHttp.read(fixture.users[5],false);await homeHttp.read(fixture.users[3],false);
 await homeHttp.boundary(employee,fixture.users[5]);await homeHttp.boundary(manager,employee);
 assert.equal(report.homeCardFailures.length,0,'Home rendered a handled card/summary failure');
 await databaseSnapshot('pilot');
 if(report.coverage.some(v=>v.status==='failed'))throw Error('Pilot route failures must be diagnosed before a 500-user run');
 if(suite==='workflow-preflight'){await verifyAudit();report.preflightPassed=true;save();return;}
 await db`select pg_stat_statements_reset()`;
 const waits=[];let samplingBusy=false;sampling=setInterval(async()=>{if(samplingBusy)return;samplingBusy=true;try{const rows=await db`select coalesce(wait_event_type,'CPU-or-ready')as kind,count(*)::int as connections from pg_stat_activity where datname=current_database()and state='active'group by 1`;waits.push({at:Date.now(),rows});}catch{}finally{samplingBusy=false;}},1000);
 const resourceCpuBefore=resourceCpu(),appCpuBefore=appCpu(),driverCpuBefore=process.cpuUsage();
 const offset=samples.length,started=performance.now(),steadyStart=started+10000,steadyUntil=steadyStart+steadyHoldMs;
 const progress={launched:0,active:0,peakActive:0,completed:0,failed:0,iterations:0};
 progressTimer=setInterval(()=>{report.progress={...progress,elapsedMs:performance.now()-started};save();writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));},5000);
 // Representative hydrated browsers share the load interval with all 500 HTTP principals.
 const browserLoad=Promise.allSettled([employee,manager,hr,group,fixture.users[254],fixture.users[251]].map(async user=>{
  await pause(10000);
  const ctx=await context(user),page=await ctx.newPage();
  try{for(const route of user.role==='employee'?['/','/claims','/leave','/attendance/individual']:user.role==='manager'?['/','/approvals','/claims','/performance/home']:['/admin/personnel','/payroll','/claims']){
   await visit(page,user,route,'loaded');await pause(thinkTimeMs);
  }
  if(user.role==='employee')await browserClaimJourney(page,user,'PERF_BROWSER_LOADED_'+user.index,'loaded');
  }finally{await ctx.close();}
 }));
 const results=await Promise.allSettled(fixture.users.map(async(user,i)=>{
  await pause(i*20);progress.launched++;progress.active++;progress.peakActive=Math.max(progress.peakActive,progress.active);
  let iteration=0;
  try{do{
  const pool=routePool(user);
  const routes=suite==='whole-system'?Array.from({length:3},(_,step)=>pool[(roleOrdinals.get(user.index)+iteration*3+step)%pool.length]):user.role==='employee'?['/me','/claims','/leave']:user.role==='manager'?['/approvals','/claims','/performance/home']:['/admin/personnel','/payroll','/claims'];
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
  },()=>request(user,'/claims',fields,template.status,true,template.headers,template.fieldOrder));assert.equal(new URL(String(created.headers['x-action-redirect']??created.headers.location).split(';')[0],base).searchParams.get('toast'),'Draft saved');
  const [draft]=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft'and description=${description}`;assert(draft,'HTTP create did not persist');
  await pause(thinkTimeMs);await observedMutation(user,'edit',async()=>{
   const [row]=await db`select amount from claim_request where id=${draft.id}::uuid`;return row&&Number(row.amount)===2;
  },()=>request(user,'/claims',{...fields,[template.prefix+'draftId']:draft.id,[template.prefix+'amount']:'2'},template.status,true,template.headers,template.fieldOrder));
  const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
  await pause(thinkTimeMs);await observedMutation(user,'delete',async()=>{
   return (await db`select id from claim_request where id=${draft.id}::uuid`).length===0;
  },()=>request(user,'/claims',{...contextTemplates.deleteTemplate.fields,[contextTemplates.deleteTemplate.prefix+'employmentId']:user.employmentId,[contextTemplates.deleteTemplate.prefix+'id']:draft.id},contextTemplates.deleteTemplate.status,true,contextTemplates.deleteTemplate.headers,contextTemplates.deleteTemplate.fieldOrder));
  assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
  await pause(thinkTimeMs);iteration++;progress.iterations++;
  }while(performance.now()<steadyUntil);
  progress.completed++;
  }catch(error){progress.failed++;throw error;}finally{progress.active--;}
 }));
 const browserResults=await browserLoad;
 report.browserLoad={contexts:browserResults.length,completed:browserResults.filter(v=>v.status==='fulfilled').length,errors:browserResults.flatMap((v,index)=>v.status==='rejected'?[{index,error:String(v.reason.message).slice(0,180)}]:[])};
 clearInterval(sampling);sampling=null;clearInterval(progressTimer);progressTimer=null;report.progress={...progress,elapsedMs:performance.now()-started};
 report.functionalErrors=results.flatMap((value,index)=>value.status==='rejected'?[{user:index,error:String(value.reason.message).slice(0,180)}]:[]);
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
 report.concurrentRouteCoverage=[...new Set([...employeeRoutes,...managerRoutes,...hrRoutes])].map(route=>({route,requests:loaded.filter(sample=>sample.method==='GET'&&sample.route===route).length,users:new Set(loaded.filter(sample=>sample.method==='GET'&&sample.route===route).map(sample=>sample.user)).size}));
 const steady=loaded.filter(sample=>sample.startedMs>=steadyStart&&sample.startedMs<steadyUntil);
 report.pageInteractions=pageInteractions;
 report.steady={durationMs:steadyHoldMs,roles:Object.fromEntries(['employee','manager','companyHR','groupHR'].map(role=>[role,{
  navigation:summary(pageInteractions.filter(v=>v.role===role&&v.startedMs>=steadyStart&&v.startedMs<steadyUntil).map(v=>v.durationMs)),
  read:summary(steady.filter(v=>v.role===role&&v.method==='GET').map(v=>v.durationMs)),
  write:summary(steady.filter(v=>v.role===role&&v.method==='POST').map(v=>v.durationMs)),
 }]))};
 report.latencyTargetMet=progress.peakActive===500&&Object.values(report.steady.roles).every(role=>role.navigation.samples>0&&role.navigation.p95Ms<1000&&role.read.samples>0&&role.write.samples>0&&role.read.p95Ms<1000&&role.write.p95Ms<500);
 writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));
 report.concurrentHomeApiCoverage=report.homeApiTraffic.templates.flatMap(({role,requests})=>requests.map(({path})=>({role,path,requests:loaded.filter(sample=>sample.role===role&&sample.method==='GET'&&sample.route===path).length})));
 await databaseSnapshot('loaded');await verifyAudit();save();if(suite==='whole-system')assert(report.concurrentHomeApiCoverage.length>0&&report.concurrentHomeApiCoverage.every(row=>row.requests>0),'observed Home fetches missing from concurrent traffic');if(runMixedWorkflow)assert(Object.values(report.mixedWorkflows.completed).every(count=>count>0),'a required mixed mutation/processing scenario did not complete');if(suite==='whole-system')assert(report.concurrentRouteCoverage.every(route=>route.requests>0),'wider concurrent route coverage incomplete');assert.equal(report.functionalErrors.length,0,'HTTP journey failures');assert.equal(report.homeCardFailures.length,0,'loaded Home card/summary failures');assert.equal(report.browserErrors.length,0,'browser runtime errors');assert.equal(report.browserLoad.errors.length,0,'loaded browser journeys');assert(report.latencyTargetMet,'500-user HTTP p95 latency target was not met');
}catch(error){if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:join(out,'browser-failure.png'),fullPage:false}).catch(()=>{});report.error=String(error.message).slice(0,350);writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));await databaseSnapshot('failure').catch(()=>{});save();throw error;}
finally{if(progressTimer)clearInterval(progressTimer);if(sampling)clearInterval(sampling);if(browser)await browser.close();agent.destroy();await db.end();save();}
}
await main();
