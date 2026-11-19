/** Repeatable direct browser entry with the existing fictional system fixture. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {request} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {builtPageCoverage,nativePreflightRoutePlan} from './system-route-manifest.mjs';
import {performanceFixtureCalendar} from './fixture-workload.mjs';
import {requireNativePreflightFixtureDay,verifyNativePreflightContent} from './native-preflight-content.ts';
import {exercisePersonnelSwitcher} from './personnel-switcher-browser.mjs';
import {exercisePayrollBrowser} from './payroll-browser.mjs';
import {exerciseOrgExplorer} from './org-explorer-browser.mjs';
import {exerciseSavedReport} from './reports-browser.mjs';
import {exerciseMovement} from './movement-browser.mjs';
import {clickNativeShellDestination} from './navigation-shell-browser.ts';

const origin='https://localhost:3443';
const appPort=3174;
const env=process.env;
const fixtureOnly=env.AIHR_BROWSER_FIXTURE_ONLY==='true';
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests'&&process.platform==='linux');
assert(!env.AIHR_EVAL_MODEL&&!env.AIHR_EVAL_OPENROUTER_KEY,'Browser fixtures cannot run provider evaluation');
assert(!Object.keys(env).some(key=>key.startsWith('WORKOS_')&&env[key]),'External auth configuration refused');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');
assert(sha===env.AIHR_CI_HEAD&&/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD??''));
assert.equal(git('status','--porcelain'),'');

const privateDir=mkdtempSync(join(env.RUNNER_TEMP,'route-baseline-private-'));
const fixtureEvidenceDir=join(privateDir,'fixture-evidence');
mkdirSync(fixtureEvidenceDir,{mode:0o700});
const focusedEvidence=join(env.RUNNER_TEMP,'aihr-focused');
mkdirSync(focusedEvidence,{mode:0o700});
const evidencePath=join(env.RUNNER_TEMP,'browser-route-baseline.json');
const report={kind:fixtureOnly?'FICTIONAL_BROWSER_FIXTURE_CHECK':'FICTIONAL_BROWSER_DOCUMENT_BASELINE',sourceSha:sha,
 controllerSha:env.AIHR_CI_CONTROL_HEAD,releaseEligible:false,
 fixture:{tenants:2,companies:10,users:500,claimsPerEmployee:2000,rewardsDraftSeeded:false},
 phases:[],observations:[],journeys:[]};
const save=()=>writeFileSync(evidencePath,JSON.stringify(report,null,2),{mode:0o600});
const dbEnv={...env,NODE_ENV:'development',AUTH_PROVIDER:'internal',
 AUTH_SESSION_KEY:randomBytes(32).toString('hex'),AI_CONFIG_SECRET:randomBytes(32).toString('hex'),
 AUTH_PUBLIC_ORIGIN:origin,AUTH_DEFAULT_ORGANIZATION:'perf-a',ALLOW_DEMO_SESSION:'false',SHARE_PASSWORD:'',DEV_USER_ID:'',
 AIHR_PERFORMANCE_ROLE_FIXTURE:'true',AIHR_FOCUSED_SUITE_CAPACITY:'true',TEST_DB_NAMESPACE:'aifocus',
 AUDIT_HASH_CHAIN_ENABLED:'true',PERF_HTTP_SUITE:'browser-route-baseline',PERF_ATTENDANCE_DAYS:'180',
 PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:fixtureEvidenceDir,AIHR_FOCUSED_EVIDENCE_DIR:focusedEvidence,
 DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',
 MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',
 TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',
 TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test',NEXT_TELEMETRY_DISABLED:'1'};
const pgEnv={...env,AIHR_CI_UNIT:'db-1'};

function start(label,command,args,childEnv) {
 const fd=openSync(join(privateDir,label+'.log'),'wx',0o600);
 try{return spawn(command,args,{env:childEnv,stdio:['ignore',fd,fd]});}
 finally{closeSync(fd);}
}
async function run(label,command,args,childEnv,limit=180000) {
 console.info('Browser fixture phase started',label);
 const started=performance.now(),child=start(label,command,args,childEnv);
 const timer=setTimeout(()=>child.kill('SIGKILL'),limit);
 try{
  const [code,signal]=await once(child,'close');
  report.phases.push({label,code,signal,elapsedMs:Math.round(performance.now()-started)});
  console.info('Browser fixture phase finished',label,code,signal??'');
  save();
  assert(code===0&&signal===null,`${label} failed`);
 }finally{clearTimeout(timer);}
}
const step=(label,script,limit)=>run(label,process.execPath,['--import','tsx',script],dbEnv,limit);

function retainSeedPhases(){
 const file=join(fixtureEvidenceDir,'fixture-phases.json');
 if(!existsSync(file))return;
 const phases=JSON.parse(readFileSync(file,'utf8'));
 report.seedPhases=phases.filter(row=>(row.tenant===null||row.tenant===0||row.tenant===1)
  &&/^[a-z][a-z-]{0,70}$/.test(row.phase)&&['running','passed','failed'].includes(row.status)).map(row=>({
  tenant:row.tenant,phase:row.phase,status:row.status,
  elapsedMs:Number.isFinite(row.elapsedMs)?Math.round(row.elapsedMs):null,
  ...(row.failure&&{failure:{
   kind:['assertion-error','syntax-error','type-error','error','other'].includes(row.failure.kind)?row.failure.kind:'other',
   code:/^(?:ERR_[A-Z_]{1,60}|[0-9A-Z]{5})$/.test(row.failure.code)?row.failure.code:null,
  }}),
 }));
 if(report.seedPhases.some(row=>row.status==='failed')){
  const log=join(privateDir,'seed-system-fixture.log');
  const frames=readFileSync(log,'utf8').matchAll(
   /^\s+at [^\r\n]*?\/source\/((?:app|core|db|lib|packs|scripts|test)\/[A-Za-z0-9_.\/-]+:\d+:\d+)\)?$/gm);
  report.seedFailureLocations=[...new Set(Array.from(frames,frame=>frame[1]))].slice(-12);
 }
 save();
}

let server,app,browser,databaseStarted=false;
async function stopApp(){
 if(!app||app.exitCode!==null||app.signalCode!==null)return;
 const closed=once(app,'close');
 app.kill('SIGTERM');
 const hardStop=setTimeout(()=>app.kill('SIGKILL'),5000);
 try{await closed;}finally{clearTimeout(hardStop);}
}
async function proxy(){
 const key=join(privateDir,'key.pem'),cert=join(privateDir,'cert.pem');
 await run('certificate','openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
  '-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],env);
 server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(incoming,outgoing)=>{
  const upstream=request({hostname:'127.0.0.1',port:appPort,path:incoming.url,method:incoming.method,
   headers:{...incoming.headers,host:'localhost:3443','x-forwarded-proto':'https'}},response=>{
    outgoing.writeHead(response.statusCode,response.headers);
    response.pipe(outgoing);
   });
  upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
  outgoing.on('close',()=>upstream.destroy());
  incoming.pipe(upstream);
 });
 server.listen(3443,'localhost');
 await once(server,'listening');
}
async function waitForApp(){
 for(let attempt=0;attempt<120;attempt++){
  assert(app.exitCode===null&&app.signalCode===null,'Application stopped during startup');
  try{
   const response=await fetch(`http://127.0.0.1:${appPort}/login`,{redirect:'manual',signal:AbortSignal.timeout(2000)});
   await response.arrayBuffer();
   if(response.status===200)return;
  }catch{/* The started child may still be opening its socket. */}
  await pause(500);
 }
 throw Error('Application startup deadline exceeded');
}

const payrollHistoryPath='/payroll/transaction-view';
const nativeContentWitnesses=new Set([
 'own-released-payslip','own-annual-leave-controls','own-individual-attendance-picker',
 'ai-runs-group-history-controls','ai-runs-company-scope','own-profile-identity',
]);
const expectedHomeCards={
 personal:['calendar','celebrations','notices','summary','tasks','team','timeOff','today'],
 hr:['attendanceOverview','companies','headcount','headcountByCompany','latestPayroll',
  'latestPayrollRun','noticeBoard','pendingLeave','recentActivity','recentlyJoined','upcomingEvents'],
};
async function signedInContext(actor){
 assert(typeof actor?.token==='string'&&actor.token.length>0,'Expected a fictional fixture session');
 const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});
 try{
  await context.addCookies([{name:'__Host-aihr_internal',value:actor.token,url:origin,secure:true,httpOnly:true}]);
  return context;
 }catch(error){await context.close();throw error;}
}
async function readyContent(page,actor,path,timeout,onHeading=()=>{}) {
 const main=page.locator('main:visible').first();
 const heading=main.locator('h1:visible').first();
 const degraded=page.locator('[role="alert"]:visible').getByRole('heading',{
  name:/^(This page could not be displayed|This is taking longer than usual)$/,
 });
 await heading.or(degraded).first().waitFor({state:'visible',timeout:timeout()});
 assert.equal(await degraded.count(),0,'A degraded page is not usable');
 await page.locator('button[data-tour="account"]').getByText(actor.name,{exact:true}).first().waitFor({state:'visible',timeout:timeout()});
 onHeading();
 if(path==='/'){
  const personal=['employee','manager'].includes(actor.role);
  const attribute=personal?'data-home-card':'data-dashboard-card';
  const cards=main.locator(`[${attribute}]`);
  await main.locator('[data-today-section]:visible').first().waitFor({state:'visible',timeout:timeout()});
  await page.waitForFunction(()=>{
   const main=document.querySelector('main');
   return main&&!main.querySelector('[aria-busy="true"]');
  },null,{timeout:timeout()});
  const cardIds=await cards.evaluateAll((cards,attribute)=>
   cards.map(card=>card.getAttribute(attribute)).sort(),attribute);
  assert.deepEqual(cardIds,expectedHomeCards[personal?'personal':'hr']);
  assert.equal(await main.locator('[role="alert"],[data-today-unavailable]').count(),0);
  return 'usable-content';
 }
 if(path==='/admin/job-descriptions'){
  const filter=main.locator('form input[name="q"]');
  const create=main.locator('a[href="/admin/job-descriptions/new"]');
  await filter.waitFor({state:'visible',timeout:timeout()});
  await create.waitFor({state:'visible',timeout:timeout()});
  assert(await filter.isEnabled({timeout:timeout()})&&await create.isEnabled({timeout:timeout()}));
  assert(await main.locator('table thead th:visible').count()>=7);
  assert.equal(await main.locator('[role="alert"]').count(),0);
  return 'usable-content';
 }
 if(path==='/tasks'){
  const filters=main.locator('.onb-workspace nav button[aria-pressed]');
  await filters.and(main.locator('button[aria-pressed="true"]')).waitFor({state:'visible',timeout:timeout()});
  assert.equal(await filters.count(),5);
  return 'usable-content';
 }
 if(path==='/approvals'){
  const sort=main.locator('[data-approvals-header-actions] select');
  await sort.waitFor({state:'visible',timeout:timeout()});
  assert(await sort.isEnabled({timeout:timeout()}));
  assert.equal(await sort.locator('option').count(),4);
  return 'usable-content';
 }
 if(path==='/attendance/daily'){
  const form=main.locator('[data-tour="attendance-day"] form');
  await form.locator('input[name="q"]').waitFor({state:'visible',timeout:timeout()});
  await form.locator('input[name="date"]').waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path===payrollHistoryPath){
  await main.locator('tbody button[data-table-disclosure]:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(['/claims','/admin/personnel','/payroll'].includes(path)){
  await main.locator('tbody tr:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/analytics'){
  await main.locator('[data-analytics-metric] [data-analytics-value]:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/roster'){
  await main.locator('[data-roster-grid] tbody tr[data-roster-employment-id]:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/recruitment'){
  await main.locator('li a[href="/recruitment/candidates"] .tabular-nums:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/me/cases'){
  await main.locator('section[aria-labelledby="own-private-cases"]:visible').waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/leave/employee-balances'){
  await main.getByTestId('employee-balances-table').locator('tbody tr:visible').first()
   .waitFor({state:'visible',timeout:timeout()});
  await main.locator('input[type="search"]:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/leave/employee-records'){
  await main.getByRole('table').locator('thead:visible').first().waitFor({state:'visible',timeout:timeout()});
  await main.locator('input[type="search"]:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 return 'heading';
}
async function visit(page,actor,route,pass,fixture) {
 const observation={role:route.role,route:route.requested,pass,status:'failed'};
 const started=performance.now(),deadline=started+15000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 try{
  const response=await page.goto(origin+route.requested,{waitUntil:'domcontentloaded',timeout:timeout()});
  observation.httpStatus=response?.status()??null;
  observation.destination=page.url()===origin+route.final?'expected':
   new URL(page.url()).pathname==='/login'?'sign-in':'other-route';
  assert(observation.httpStatus===200&&observation.destination==='expected','Unexpected rendered route');
  if(nativeContentWitnesses.has(route.witness)){
   observation.expectedWitness=route.witness;
   await page.locator('button[data-tour="account"]').getByText(actor.name,{exact:true}).first()
    .waitFor({state:'visible',timeout:timeout()});
   requireNativePreflightFixtureDay(route.witness,fixture.today);
   observation.witness=await verifyNativePreflightContent(page,route.witness,{
    actorIndex:actor.index,actorName:actor.name,seedToday:fixture.today,
    historicalPayrollMonth:performanceFixtureCalendar(fixture.today).historicalMonth,
    peerName:fixture.users[5]?.name,foreignName:fixture.users[254]?.name,
    companyIds:fixture.tenants[0]?.companies.map(company=>company.companyId),
   },timeout);
   observation.readiness=route.witness==='ai-runs-company-scope'?'scope-denial':'usable-content';
  }else{
   observation.readiness=await readyContent(page,actor,route.requested,timeout,()=>{
    observation.authenticatedHeadingObservedMs=Math.round(performance.now()-started);
   });
   if(route.witness){
    if(observation.readiness==='usable-content')observation.witness=route.witness;
    else observation.unverifiedWitness=route.witness;
   }
  }
  await assertContentAvailable(page);
  if(performance.now()>deadline)throw Object.assign(new Error('Readiness deadline exceeded'),{name:'TimeoutError'});
  observation.status='observed';
 }catch(error){observation.failure=error?.name==='TimeoutError'?'timeout':error?.code==='ERR_ASSERTION'?'assertion':'browser';}
 finally{
  observation.elapsedMs=Math.round(performance.now()-started);
  if(observation.destination==='expected'){
   if(observation.status==='failed'){
    observation.visibleState=await page.evaluate(()=>{
     const visible=selector=>Array.from(document.querySelectorAll(selector))
      .some(node=>node.getClientRects().length>0);
     const alerts=Array.from(document.querySelectorAll('[role="alert"] h2'))
      .filter(node=>node.getClientRects().length>0);
     return {
      heading:visible('main h1'),signedInShell:visible('button[data-tour="account"]'),
      pending:visible('main [aria-busy="true"],main [data-page-busy],main [data-personnel-busy]'),
      unavailable:visible('main [data-read-unavailable]'),
      renderError:alerts.some(node=>node.textContent==='This page could not be displayed'),
      capacityError:alerts.some(node=>node.textContent==='This is taking longer than usual'),
     };
    }).catch(()=>null);
    if(observation.visibleState?.capacityError)observation.failure='capacity';
    if(observation.visibleState?.renderError)observation.failure='render-error';
   }
   observation.documentTiming=await page.evaluate(()=>{
    const [entry]=performance.getEntriesByType('navigation');
    if(!entry||entry.responseStart<=0)return null;
    return {firstByteMs:Math.round(entry.responseStart),domContentLoadedMs:Math.round(entry.domContentLoadedEventEnd),
     transferBytes:entry.transferSize};
   }).catch(()=>null);
  }
  report.observations.push(observation);save();
 }
}
async function assertContentAvailable(page){
 assert.equal(await page.locator('main [data-personnel-busy],main [data-page-busy],main [data-read-unavailable]').count(),0);
}

async function measureShellLinks(fixture){
 const actor=fixture.users[0],context=await signedInContext(actor);
 try{
  const page=await context.newPage();
  for(const path of ['/admin/personnel','/payroll','/analytics','/roster']){
   const row={journey:'shell-navigation',role:actor.role,route:path,status:'incomplete'};
   report.journeys.push(row);
   let clickStart,documentRequests=0;
   const observe=request=>{if(request.resourceType()==='document'&&request.frame()===page.mainFrame())documentRequests++;};
   try{
    await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:15000});
    page.on('request',observe);
    const deadline=performance.now()+30000;
    const remaining=()=>Math.max(1,Math.floor(deadline-performance.now()));
    await clickNativeShellDestination(page,path,remaining,()=>{
     clickStart=performance.now();
     documentRequests=0;
    });
    await page.waitForURL(origin+path,{timeout:remaining()});
    assert.equal(await readyContent(page,actor,path,remaining),'usable-content');
    await assertContentAvailable(page);
    assert.equal(documentRequests,0,'Shell link triggered a full document reload');
    assert(Number.isFinite(clickStart),'Shell click time was not observed');
    row.elapsedMs=performance.now()-clickStart;
    row.status='observed';
   }catch(error){row.failure=error?.name==='TimeoutError'?'timeout':error?.code==='ERR_ASSERTION'?'assertion':'browser';}
   finally{page.off('request',observe);row.documentRequests=documentRequests;save();}
  }
 }finally{await context.close();}
}
async function measureRoutes(fixture){
 const plan=[...nativePreflightRoutePlan()];
 for(const [role,actorIndex] of [['companyHR',1],['groupHR',0]]){
  for(const path of [payrollHistoryPath,'/recruitment']){
   plan.push({role,actorIndex,requested:path,final:path});
  }
 }
 plan.push({role:'employee',actorIndex:4,requested:'/me/cases',final:'/me/cases'});
 report.plannedRoleRoutes=plan.length;
 const appPathRoutes=JSON.parse(readFileSync('.next/app-path-routes-manifest.json','utf8'));
 report.builtPageCoverage=builtPageCoverage(appPathRoutes,plan,[]);
 save();
 const require=createRequire(join(process.cwd(),'package.json'));
 const {chromium}=require('playwright');
 browser=await chromium.launch();
 const lanes=await Promise.allSettled([...new Set(plan.map(route=>route.actorIndex))].map(async actorIndex=>{
  const actor=fixture.users[actorIndex],routes=plan.filter(route=>route.actorIndex===actorIndex);
  assert(actor&&routes.every(route=>route.role===actor.role),'Fixture role differs from the route inventory');
  const context=await signedInContext(actor);
  try{
   const page=await context.newPage();
   for(const pass of ['first','repeat'])for(const route of routes)await visit(page,actor,route,pass,fixture);
  }finally{await context.close();}
 }));
 report.builtPageCoverage=builtPageCoverage(appPathRoutes,plan,report.observations);
 save();
 assert(lanes.every(lane=>lane.status==='fulfilled'),'An owned browser lane failed');
}

async function measureActions(fixture){
 const require=createRequire(join(process.cwd(),'package.json'));
 const postgres=require('postgres');
 const db=postgres(dbEnv.MIGRATION_DATABASE_URL,{max:1,connection:{default_transaction_read_only:'on'}});
 const actions=[
  {name:'personnel-switcher',actorIndex:0,run:async options=>{
   await options.page.goto(origin+'/admin/personnel',{waitUntil:'domcontentloaded',timeout:15000});
   await exercisePersonnelSwitcher(options);
  },timings:result=>result.personnelSwitcherBrowser?.map(row=>({step:row.step,elapsedMs:row.elapsedMs,usable:row.usable}))},
  {name:'payroll-wizard',actorIndex:0,run:exercisePayrollBrowser,
   timings:result=>result.browserPayrollReadiness?.map(row=>({step:row.surface,elapsedMs:row.elapsedMs,usable:row.usable,
    ...(Number.isFinite(row.trace?.expectedEmployeeVisibleMs)&&{continueToReadyMs:row.trace.expectedEmployeeVisibleMs-row.trace.continueStartedMs})}))},
  {name:'payroll-scope-denial',actorIndex:1,run:exercisePayrollBrowser,
   timings:result=>result.browserPayrollReadiness?.map(row=>({step:row.surface,elapsedMs:row.elapsedMs,scopeDenied:row.scopeDenied}))},
  {name:'org-explorer',actorIndex:250,run:exerciseOrgExplorer,timings:result=>result.orgExplorerJourneys?.[0]?.steps
   .map(row=>({step:row.action,elapsedMs:row.elapsedMs}))},
  {name:'saved-report-draft',actorIndex:0,run:exerciseSavedReport,timings:result=>result.browserSavedReportJourneys?.[0]?.timings
   .map(row=>({step:row.operation,elapsedMs:row.visibleByMs}))},
  {name:'personnel-movement',actorIndex:0,run:async options=>{
   const subject=options.fixture.users[4];
   assert(subject.role==='employee'&&subject.tenant===options.user.tenant);
   await exerciseMovement({...options,actor:options.user,subject,recordEvent:true});
   assert.equal(options.report.browserMovementJourneys?.[0]?.auditVerified,true);
  },timings:result=>Object.entries(result.browserMovementJourneys?.[0]?.steps??{})
   .map(([step,row])=>({step,status:row.status,elapsedMs:row.elapsedMs}))},
 ];
 try{
  for(const action of actions){
   const user=fixture.users[action.actorIndex],context=await signedInContext(user),result={};
   const row={journey:action.name,role:user.role,status:'incomplete',timings:[]};
   report.journeys.push(row);
   const retain=()=>{row.timings=action.timings(result)??[];save();};
   try{
    const page=await context.newPage();
    await action.run({base:origin,user,page,fixture,report:result,save:retain,phase:'baseline',db,evidenceDirectory:fixtureEvidenceDir});
    if(action.name==='saved-report-draft')assert.equal(result.browserSavedReportJourneys?.[0]?.persisted,true);
    row.status='observed';
   }catch(error){
    row.failure=error?.name==='TimeoutError'?'timeout':error?.code==='ERR_ASSERTION'?'assertion':'browser';
    const step=result.orgExplorerJourneys?.[0]?.failure?.stage;
    if(typeof step==='string'&&/^[a-z][a-z-]{0,64}$/.test(step))row.failedStep=step;
   }
   finally{retain();await context.close();}
  }
 }finally{await db.end({timeout:5});}
}

save();
try{
 if(!fixtureOnly){
  report.buildId=readFileSync('.next/BUILD_ID','utf8').trim();
  assert(report.buildId,'Missing measured application build');
 }
 databaseStarted=true;
 await run('postgres-setup','bash',['../automation/.github/ci/postgres.sh','reset'],pgEnv);
 await run('migrate-fictional-database','pnpm',['db:migrate'],dbEnv,300000);
 await step('verify-organisation-admission','scripts/provision-organisation-admission.ts');
 await step('seed-catalogues','scripts/seed-catalogs.ts');
 try{
  await run('seed-system-fixture',process.execPath,['--import','tsx',
   'scripts/performance/system-fixture.mjs'],{...dbEnv,
    NODE_OPTIONS:'--conditions=react-server',
    TEST_DATABASE_URL:dbEnv.DATABASE_URL,TEST_MIGRATION_DATABASE_URL:dbEnv.MIGRATION_DATABASE_URL},600000);
 }finally{retainSeedPhases();}
 const fixture=JSON.parse(readFileSync(join(privateDir,'fixture.json'),'utf8'));
 assert(Array.isArray(fixture.users)&&fixture.users.length===500&&Array.isArray(fixture.tenants)
  &&fixture.tenants.length===2,'Fictional fixture inventory incomplete');
 report.fixtureVerified=true;
 if(!fixtureOnly){
  app=start('application',process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1',
   '--port',String(appPort)],{...dbEnv,NODE_ENV:'production',AIHR_DB_POOL_MAX:'8'});
  await waitForApp();
  await proxy();
  await measureRoutes(fixture);
  await measureShellLinks(fixture);
  await measureActions(fixture);
  const routesObserved=report.observations.length===2*report.plannedRoleRoutes
   &&report.observations.every(row=>row.status==='observed');
  const journeysObserved=report.journeys.length>0&&report.journeys.every(row=>row.status==='observed');
  report.contentObserved=report.observations.filter(row=>row.status==='observed'&&
   ['usable-content','scope-denial'].includes(row.readiness)).length;
  report.complete=routesObserved&&journeysObserved&&report.contentObserved===report.observations.length;
  assert(routesObserved,'Browser baseline had missing or failed visits');
  assert(journeysObserved,'Browser baseline had missing or failed actions');
 }
}finally{
 try{await browser?.close();}
 finally{
  try{
   if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
   await stopApp();
   const appLog=join(privateDir,'application.log');
   if(existsSync(appLog)){
    const log=readFileSync(appLog,'utf8');
    const counts={};
    for(const [,code] of log.matchAll(/(?:^|\n)\s*code: ['"]([0-9A-Z]{5})['"]/g)){
     counts[code]=(counts[code]??0)+1;
    }
    report.serverFailureCounts=counts;
   }
  }finally{
   if(databaseStarted)await run('postgres-cleanup','bash',['../automation/.github/ci/postgres.sh','stop'],pgEnv);
   save();
  }
 }
}
