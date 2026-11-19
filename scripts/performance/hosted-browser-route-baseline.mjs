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
import {verifyAssistantHistoryBrowser} from './assistant-history-browser.mjs';
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
const todayContent={
 employee:[
  '[data-today-panel="today-calendar"] [data-today-month]',
  '[data-today-panel="today-requests"] [data-today-requests-all]',
  '[data-today-panel="today-notices"] a[href="/notices"]',
 ],
 manager:[
  '[data-today-panel="today-decide"] :is([data-today-empty],[data-today-decisions],[data-today-other-work])',
  '[data-today-panel="today-team-coming-up"]',
 ],
 administrator:[
  '[data-today-panel="today-needs"] :is([data-today-empty],[data-today-needs-list])',
  '[data-today-panel="today-handled"] :is([data-today-empty],[data-today-handled])',
  '[data-today-panel="today-readiness"]',
 ],
};
async function signedInContext(actor){
 assert(typeof actor?.token==='string'&&actor.token.length>0,'Expected a fictional fixture session');
 const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});
 try{
  await context.addCookies([{name:'__Host-aihr_internal',value:actor.token,url:origin,secure:true,httpOnly:true}]);
  return context;
 }catch(error){await context.close();throw error;}
}
async function readyContent(page,actor,path,timeout,onHeading=()=>{},fixture) {
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
  const audience=actor.role==='employee'||actor.role==='manager'?actor.role:'administrator';
  const today=main.locator(`[data-today="${audience}"]`);
  await today.locator('header [data-today-date]').first().waitFor({state:'visible',timeout:timeout()});
  for(const selector of todayContent[audience]){
   await today.locator(selector).first().waitFor({state:'visible',timeout:timeout()});
  }
  await today.locator('[data-today-skeleton]:visible, [data-recommendation-pending]:visible')
   .first().waitFor({state:'hidden',timeout:timeout()});
  assert.equal(await main.locator('[role="alert"],[data-today-page-unavailable],[data-today-unavailable]').count(),0);
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
 if(path==='/lifecycle/v9'){
  const table=main.getByRole('table',{name:'New joiners',exact:true});
  await table.waitFor({state:'visible',timeout:timeout()});
  const [own,other]=fixture.joiners;
  await table.getByRole('link',{name:own,exact:true}).waitFor({state:'visible',timeout:timeout()});
  const otherCompany=table.getByRole('link',{name:other,exact:true});
  if(actor.role==='groupHR')await otherCompany.waitFor({state:'visible',timeout:timeout()});
  else assert.equal(await otherCompany.count(),0,'Company HR saw a joiner outside its company');
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
 if(path==='/reports'){
  const hub=main.locator('[data-tour="intelligence-reports"]');
  await hub.locator('a[href="/reports/employee-master"]').first().waitFor({state:'visible',timeout:timeout()});
  await hub.locator('a[href="/payroll/statutory-forms"]').waitFor({state:'visible',timeout:timeout()});
  assert.equal(await hub.getByRole('heading',{level:2}).count(),6);
  return 'usable-content';
 }
 if(path==='/reports/employee-master'){
  await main.locator('form input[name="q"]').waitFor({state:'visible',timeout:timeout()});
  await main.locator('a[href="/reports/employee-master/new"]').waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/notices'){
  await main.locator('form[action="/notices"] input[type="search"]').waitFor({state:'visible',timeout:timeout()});
  await main.locator('[data-tour="notices-mine"] ul li:visible').first().waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/admin/claims'){
  const types=main.locator('[data-tour="claims-types"]');
  await types.locator('summary:visible').first().waitFor({state:'visible',timeout:timeout()});
  await types.getByText('Performance claim',{exact:true}).waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/assistant'){
  const ask=main.locator('[data-ai-centre="ask"] [data-ask-conversation]');
  await ask.locator('textarea[name="question"]:enabled').waitFor({state:'visible',timeout:timeout()});
  const history=fixture.assistantHistory?.[actor.index];
  if(history){
   const saved=main.locator('nav[data-ai-saved-chats-ready="true"]:visible');
   await saved.getByRole('link',{name:history.rootTitles[0],exact:true}).waitFor({state:'visible',timeout:timeout()});
   assert.equal(await saved.locator('a[href^="/assistant?e="]').count(),history.threads);
  }
  assert.equal(await main.locator('[role="alert"]').count(),0);
  return 'usable-content';
 }
 if(path==='/org'){
  const chart=main.locator('[data-tour="org-chart"]');
  await chart.locator('[data-org-tree] [data-org-node]').or(
   chart.getByText('No employees found for the selected filter',{exact:true})).first()
   .waitFor({state:'visible',timeout:timeout()});
  await main.locator('a[href="/org?view=explorer"]').waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/approvals/history'){
  const form=main.locator('form').filter({has:page.locator('select[name="decider"]')});
  await form.locator('select[name="module"]').waitFor({state:'visible',timeout:timeout()});
  await form.locator('input[name="from"][type="date"]').waitFor({state:'visible',timeout:timeout()});
  await main.locator('table tbody tr').or(main.getByText('No approval activity yet.',{exact:true})).first()
   .waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/admin/notice-board'){
  const board=main.locator('[data-tour="notices-administration"]');
  await board.locator('input[name="q"][type="search"]').waitFor({state:'visible',timeout:timeout()});
  await board.locator('table thead a[href*="sort=title"]').waitFor({state:'visible',timeout:timeout()});
  await main.locator('a[href="/admin/notice-board/new"]').waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/knowledge-base'){
  const library=main.locator('[data-tour="knowledge-base-library"]');
  await library.locator('form input[name="q"]').waitFor({state:'visible',timeout:timeout()});
  await library.locator('section a[href^="/knowledge-base/"]').or(
   library.getByText('No documents yet. Add the first one below.',{exact:true})).first()
   .waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/letters/register'){
  const filter=main.locator('form').filter({has:page.locator('select[name="companyId"]')});
  await filter.locator('input[name="q"]').waitFor({state:'visible',timeout:timeout()});
  await main.locator('a[href^="/letters/register/"]').or(main.getByText('No matching letters.',{exact:true}))
   .first().waitFor({state:'visible',timeout:timeout()});
  assert.equal(await main.locator('[role="alert"]').count(),0);
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
   observation.readiness=await readyContent(page,actor,route.final,timeout,()=>{
    observation.authenticatedHeadingObservedMs=Math.round(performance.now()-started);
   },fixture);
   if(route.witness){
    if(observation.readiness==='usable-content')observation.witness=route.requested==='/'?'today-panel-content':route.witness;
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
   const beforeClick={routeRequests:0,destinationRequests:0};
   const observe=request=>{
    if(request.resourceType()==='document'&&request.frame()===page.mainFrame())documentRequests++;
    if(clickStart!==undefined||request.method()!=='GET')return;
    const url=new URL(request.url());
    if(url.origin!==origin||url.pathname.startsWith('/api/')||
     !(url.searchParams.has('_rsc')||request.headers().rsc==='1'))return;
    beforeClick.routeRequests++;
    if(url.pathname===path)beforeClick.destinationRequests++;
   };
   try{
    await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:15000});
    page.on('request',observe);
    const deadline=performance.now()+30000;
    const remaining=()=>Math.max(1,Math.floor(deadline-performance.now()));
    await clickNativeShellDestination(page,path,remaining,async ()=>{
     // The flyout is visible but the user has not selected any link. Give browser
     // scheduling and intent dwell time to emit speculative route requests.
     await pause(250);
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
   finally{page.off('request',observe);row.documentRequests=documentRequests;row.beforeClick=beforeClick;save();}
  }
 }finally{await context.close();}
}
async function measureRoutes(fixture){
 const plan=[...nativePreflightRoutePlan()];
 for(const [role,actorIndex] of [['companyHR',1],['groupHR',0]]){
  for(const path of [payrollHistoryPath,'/recruitment','/lifecycle/v9','/approvals']){
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

function approvalCategoryRequest(request){
 if(request.method()!=='GET')return null;
 const url=new URL(request.url());
 const headers=request.headers();
 if(url.origin!==origin||url.pathname!=='/approvals'||!url.searchParams.has('category')
  ||!(url.searchParams.has('_rsc')||headers.rsc==='1'))return null;
 return {url,prefetch:Boolean(headers['next-router-prefetch']||headers['next-router-segment-prefetch'])};
}

async function measureApprovalCategories({page,user,report,save}){
 const passive={prefetchRequests:0,otherRequests:0};
 const observe=request=>{
  const category=approvalCategoryRequest(request);
  if(category)passive[category.prefetch?'prefetchRequests':'otherRequests']++;
 };
 const main=page.locator('main:visible').first();
 const categories=main.locator('aside nav');
 const claims=main.locator('[data-ui-section-header]').filter({hasText:/^Claims\s*\(\d+\)$/});
 const leave=main.locator('#approvals-leave');
 page.on('request',observe);
 try{
  const response=await page.goto(origin+'/approvals',{waitUntil:'domcontentloaded',timeout:15000});
  assert.equal(response?.status(),200);
  await page.locator('button[data-tour="account"]').getByText(user.name,{exact:true}).first()
   .waitFor({state:'visible',timeout:15000});
  await leave.waitFor({state:'visible',timeout:15000});
  await pause(300);
 }finally{page.off('request',observe);}
 report.approvalSteps=[{step:'initial-category-background-requests',...passive}];
 save();
 for(const [step,path,leaveState] of [['open-claims-category','/approvals?category=claim','hidden'],['return-to-all-approvals','/approvals','visible']]){
  const link=categories.locator(`a[href="${path}"]`);
  const started=performance.now(),deadline=started+15000;
  const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
  await link.click({timeout:timeout()});
  await page.waitForURL(origin+path,{timeout:timeout()});
  await link.and(categories.locator('a[aria-current="page"]')).waitFor({state:'visible',timeout:timeout()});
  await claims.waitFor({state:'visible',timeout:timeout()});
  await leave.waitFor({state:leaveState,timeout:timeout()});
  await assertContentAvailable(page);
  report.approvalSteps.push({step,elapsedMs:Math.round(performance.now()-started)});
  save();
 }
}

async function measureClaimApproval({page,user,db,report,save}){
 assert.equal(user.role,'companyHR');
 const path='/approvals?category=claim';
 const response=await page.goto(origin+path,{waitUntil:'domcontentloaded',timeout:15000});
 assert.equal(response?.status(),200);
 await page.locator('button[data-tour="account"]').getByText(user.name,{exact:true}).first()
  .waitFor({state:'visible',timeout:15000});
 const main=page.locator('main:visible').first();
 const candidates=main.locator('tr[id^="approval-row-"]').filter({
  has:page.getByRole('cell',{name:'Performance claim',exact:true}),
 }).filter({has:page.locator('button[data-action-approval]')});
 const row=candidates.first();
 await row.waitFor({state:'visible',timeout:15000});
 const rowId=await row.getAttribute('id');
 const claimId=rowId?.slice('approval-row-'.length);
 assert.match(claimId??'',/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
 const before=await db`select claim.employment_id,claim.status from claim_request claim
  join employment subject on subject.id=claim.employment_id and subject.tenant_id=claim.tenant_id
  where claim.id=${claimId}::uuid and claim.tenant_id=${user.tenantId}::uuid
   and claim.claim_type_id=${user.claimTypeId}::uuid and subject.company_id=${user.companyId}::uuid
   and subject.person_id<>${user.personId}::uuid and claim.amount=1`;
 assert.equal(before.length,1,'Expected a fictional claim in the actor’s company');
 assert.equal(before[0].status,'pending');

 const started=performance.now(),deadline=started+15000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 const approved=main.locator(`tr[id="${rowId}"]`);
 const confirmation=page.locator('[data-sonner-toast][data-type="success"]').filter({hasText:'Claim approved'});
 const cleanUrlRequests={prefetchRequests:0,otherRequests:0};
 const observe=request=>{
  const category=approvalCategoryRequest(request);
  if(!category||category.url.searchParams.get('category')!=='claim'
   ||['toast','successNotice','error','approvalSeal'].some(key=>category.url.searchParams.has(key)))return;
  cleanUrlRequests[category.prefetch?'prefetchRequests':'otherRequests']++;
 };
 page.on('request',observe);
 try{
  await Promise.all([
   confirmation.waitFor({state:'visible',timeout:timeout()}),
   approved.locator('button[data-action-approval]').click({timeout:timeout()}),
  ]);
  const confirmedMs=Math.round(performance.now()-started);
  await approved.waitFor({state:'hidden',timeout:timeout()});
  await main.locator('[data-approvals-header-actions] select').waitFor({state:'visible',timeout:timeout()});
  await page.waitForURL(origin+path,{timeout:timeout()});
  await assertContentAvailable(page);
  report.claimSteps=[{step:'approve-claim-and-refresh',elapsedMs:Math.round(performance.now()-started),
   confirmedMs,cleanUrlRequests}];
 }finally{page.off('request',observe);}
 save();

 const result=await db`select claim.status,claim.decided_at is not null as decided,
  claim.decided_by_employment_id=${user.employmentId}::uuid as expected_decider,
  (select count(*)::int from domain_event event where event.tenant_id=claim.tenant_id
   and event.aggregate_type='claim-request' and event.aggregate_id=claim.id
   and event.event_type='claim-request.approved' and event.actor_id=${user.userId}::uuid
   and event.subject_employment_id=claim.employment_id and event.payload->>'payoutMethod'='reimbursement'
   and event.chain_seq is not null and event.hash is not null) as audit_events
  from claim_request claim where claim.id=${claimId}::uuid and claim.tenant_id=${user.tenantId}::uuid`;
 assert.equal(result.length,1);
 assert.deepEqual({...result[0]},{status:'approved',decided:true,expected_decider:true,audit_events:1});
 report.claimSteps[0].auditVerified=true;
}

const noticeProbeTitles=['Fictional bell single read','Fictional bell mark all'];

async function seedNotificationReads(fixture){
 const postgres=createRequire(join(process.cwd(),'package.json'))('postgres');
 const db=postgres(dbEnv.MIGRATION_DATABASE_URL,{max:1});
 try{
  const employee=fixture.users[4],peer=fixture.users[5];
  assert(employee.role==='employee'&&peer.role==='employee'&&employee.tenantId===peer.tenantId);
  const rows=await db`insert into notification(tenant_id,recipient_employment_id,kind,title,body)
   values (${employee.tenantId}::uuid,${employee.employmentId}::uuid,'performance.bell-probe',${noticeProbeTitles[0]},'Fictional notification'),
    (${employee.tenantId}::uuid,${employee.employmentId}::uuid,'performance.bell-probe',${noticeProbeTitles[1]},'Fictional notification'),
    (${peer.tenantId}::uuid,${peer.employmentId}::uuid,'performance.bell-probe',${noticeProbeTitles[1]},'Fictional notification') returning id`;
  assert.equal(rows.length,3);
 }finally{await db.end({timeout:5});}
}

async function measureNotificationReads({page,user,fixture,db,report,save}){
 const path='/me/cases';
 const response=await page.goto(origin+path,{waitUntil:'domcontentloaded',timeout:15000});
 assert.equal(response?.status(),200);
 await readyContent(page,user,path,()=>15000);
 const bell=page.getByRole('button',{name:/^Notifications, (?:[\d,]+ waiting: )?[\d,]+ unread/});
 await bell.waitFor({state:'visible',timeout:15000});
 const unreadPattern=count=>new RegExp('^Notifications, (?:[\\d,]+ waiting: )?'+count+' unread(?:$| and )');
 const label=await bell.getAttribute('aria-label');
 const unread=Number(label?.match(/([\d,]+) unread/)?.[1].replaceAll(',',''));
 assert(Number.isSafeInteger(unread)&&unread>=2&&unread<1000);

 const rows=()=>db`select title,recipient_employment_id as recipient,read_at is not null as read
  from notification where tenant_id=${user.tenantId}::uuid and kind='performance.bell-probe'`;
 const own=notices=>notices.filter(item=>item.recipient===user.employmentId);
 const peer=fixture.users[5];
 const before=await rows();
 assert.equal(before.length,3);
 assert(before.every(item=>item.read===false));
 await bell.click({timeout:15000});
 report.notificationSteps=[];
 let current;
 const observe=request=>{
  const url=new URL(request.url());
  if(current&&url.origin===origin&&url.pathname===path&&url.searchParams.has('_rsc')&&request.method()==='GET')current.refreshRequests++;
 };
 page.on('request',observe);
 async function mark(step,button,count){
  current={step,refreshRequests:0};
  report.notificationSteps.push(current);
  const started=performance.now();
  await button.click({timeout:15000});
  await page.getByRole('button',{name:unreadPattern(count)}).waitFor({state:'visible',timeout:15000});
  current.elapsedMs=Math.round(performance.now()-started);
  await assertContentAvailable(page);
  save();
 }
 try{
  await mark('read-one-notification',page.getByRole('button',{name:/^Fictional bell single read/}),unread-1);
  const first=await rows();
  assert.equal(own(first).filter(item=>item.read).length,1);
  assert.equal(own(first).find(item=>item.title===noticeProbeTitles[0])?.read,true);
  current.persisted=true;
  await bell.click({timeout:15000});
  await mark('mark-all-notifications-read',page.getByRole('button',{name:'Mark all read',exact:true}),0);
  const last=await rows();
  assert.equal(own(last).filter(item=>item.read).length,2);
  assert.equal(last.find(item=>item.recipient===peer.employmentId)?.read,false);
  current.persisted=true;
 }finally{page.off('request',observe);}
}

async function measureApprovalSummaryReadiness({page,user,report,save}){
 const started=performance.now(),deadline=started+15000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 const response=await page.goto(origin+'/approvals',{waitUntil:'commit',timeout:timeout()});
 assert.equal(response?.status(),200);
 await page.locator('button[data-tour="account"]').getByText(user.name,{exact:true}).first()
  .waitFor({state:'visible',timeout:timeout()});
 const main=page.locator('main:visible').first();
 const sort=main.locator('[data-approvals-header-actions] select');
 await sort.waitFor({state:'visible',timeout:timeout()});
 assert(await sort.isEnabled({timeout:timeout()}));
 await main.locator('tr[id^="approval-row-"] button[data-action-approval]').first()
  .waitFor({state:'visible',timeout:timeout()});
 report.approvalReadiness=[{step:'decision-controls-visible',elapsedMs:Math.round(performance.now()-started)}];
 save();

 for(const label of ['Approved','Rejected','Cancelled']){
  const bucket=main.locator('div.uppercase').filter({hasText:new RegExp('^'+label+'$')});
  await bucket.locator('..').locator('div.tabular-nums').filter({hasText:/^(?:[0-9]+|—)$/})
   .waitFor({state:'visible',timeout:timeout()});
 }
 assert.equal(await main.locator('[data-approval-history-summary="unavailable"]').count(),0);
 await assertContentAvailable(page);
 report.approvalReadiness.push({step:'history-counts-visible',elapsedMs:Math.round(performance.now()-started)});
 await page.waitForLoadState('domcontentloaded',{timeout:timeout()});
 report.approvalReadiness.push({step:'document-content-loaded',elapsedMs:Math.round(performance.now()-started)});
}

async function measureSavedAssistantHistory({page,user,fixture,report,save}){
 const history=fixture.assistantHistory?.[user.index];
 assert(history?.rowsVerified,'The authorized actor needs their seeded Assistant history');
 report.historySteps=[];
 await verifyAssistantHistoryBrowser({page,history,timeout:15000,
  visitAsk:async()=>{
   const response=await page.goto(origin+'/assistant',{waitUntil:'commit',timeout:15000});
   assert.equal(response?.status(),200);
   await page.locator('button[data-tour="account"]').getByText(user.name,{exact:true}).first()
    .waitFor({state:'visible',timeout:15000});
  },
  onMeasurement:row=>{
   report.historySteps.push({step:row.step,elapsedMs:Math.round(row.navigationToUsableMs??row.clickToUsableMs),
    promptsSubmitted:row.promptsSubmitted});
   save();
  },
 });
}

async function measureJobDescriptionEditor({page,user,report,save}){
 const list='/admin/job-descriptions',create=list+'/new';
 const response=await page.goto(origin+list,{waitUntil:'commit',timeout:15000});
 assert.equal(response?.status(),200);
 await readyContent(page,user,list,()=>15000);
 const main=page.locator('main:visible').first();
 const picker=main.locator('form select[name="company"]');
 const started=performance.now();
 await main.locator(`a[href="${create}"]`).click({timeout:15000});
 await page.waitForURL(origin+create,{timeout:15000});
 await picker.waitFor({state:'visible',timeout:15000});
 const label=await picker.locator(`option[value="${user.companyId}"]`).textContent();
 assert(label?.trim());
 report.jobEditorSteps=[{step:'open-company-picker',elapsedMs:Math.round(performance.now()-started)}];
 save();
 await picker.selectOption(user.companyId);
 const editorStarted=performance.now();
 await main.getByRole('button',{name:'Continue',exact:true}).click({timeout:15000});
 await page.waitForURL(url=>url.pathname===create&&url.searchParams.get('company')===user.companyId,{timeout:15000});
 const company=main.getByRole('textbox',{name:'Company',exact:true});
 await company.waitFor({state:'visible',timeout:15000});
 assert.equal(await company.inputValue(),label);
 const approver=main.getByRole('combobox',{name:'Named approver',exact:true});
 await approver.waitFor({state:'visible',timeout:15000});
 assert.equal(await approver.locator(`option[value="${user.userId}"]`).textContent(),user.name);
 assert(await main.getByRole('button',{name:'Save draft',exact:true}).isEnabled());
 await assertContentAvailable(page);
 report.jobEditorSteps.push({step:'open-company-editor',elapsedMs:Math.round(performance.now()-editorStarted)});
}

async function measureActions(fixture){
 const {node,edge}=JSON.parse(readFileSync('.next/server/server-reference-manifest.json','utf8'));
 const declaredActions=new Set([...Object.keys(node??{}),...Object.keys(edge??{})]);
 assert(declaredActions.size>0,'The measured build must have registered Server Actions');
 const exercisedActions=new Set();
 report.serverActionInventory={registered:declaredActions.size,seenInPassedJourneys:0};
 const require=createRequire(join(process.cwd(),'package.json'));
 const postgres=require('postgres');
 const db=postgres(dbEnv.MIGRATION_DATABASE_URL,{max:1,connection:{default_transaction_read_only:'on'}});
 const actions=[
  ...[0,1].map(actorIndex=>({name:'job-description-editor-open',actorIndex,run:measureJobDescriptionEditor,
   timings:result=>result.jobEditorSteps})),

  ...[4,1].map(actorIndex=>({name:'assistant-saved-history',actorIndex,run:measureSavedAssistantHistory,
   timings:result=>result.historySteps})),

  ...[2,1,0].map(actorIndex=>({name:'approvals-summary-readiness',actorIndex,run:measureApprovalSummaryReadiness,
   timings:result=>result.approvalReadiness})),
  ...[2,1,0].map(actorIndex=>({name:'approvals-categories',actorIndex,run:measureApprovalCategories,
   timings:result=>result.approvalSteps})),
  {name:'claim-approval',actorIndex:1,run:measureClaimApproval,timings:result=>result.claimSteps},
  {name:'notification-read',actorIndex:4,run:measureNotificationReads,timings:result=>result.notificationSteps},
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
  {name:'new-joiners-search',actorIndex:1,run:async ({page,user,fixture,report,save})=>{
   const deadline=performance.now()+15000,timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
   const response=await page.goto(origin+'/lifecycle/v9',{waitUntil:'domcontentloaded',timeout:timeout()});
   assert.equal(response?.status(),200);
   assert.equal(page.url(),origin+'/lifecycle/v9');
   await readyContent(page,user,'/lifecycle/v9',timeout,undefined,fixture);
   const search=page.getByRole('textbox',{name:'Search by name',exact:true});
   const results=page.getByRole('table',{name:'New joiners',exact:true});
   const owned=results.getByRole('link',{name:fixture.joiners[0],exact:true});
   report.joinerSteps=[];
   for(const [step,query,state] of [['search-no-matches','Fictional unmatched joiner','hidden'],['clear-search','','visible']]){
    const started=performance.now();
    await search.fill(query,{timeout:timeout()});
    await owned.waitFor({state,timeout:timeout()});
    if(state==='hidden')await results.getByText('No new joiners match your search or filters.',{exact:true})
     .waitFor({state:'visible',timeout:timeout()});
    report.joinerSteps.push({step,elapsedMs:Math.round(performance.now()-started)});
    save();
   }
  },timings:result=>result.joinerSteps},
 ];
 try{
  for(const action of actions){
   const user=fixture.users[action.actorIndex],context=await signedInContext(user),result={};
   const row={journey:action.name,role:user.role,status:'incomplete',timings:[]};
   report.journeys.push(row);
   const retain=()=>{row.timings=action.timings(result)??[];save();};
   const matchedActions=new Set();
   const observeAction=request=>{
    if(request.method()!=='POST'||new URL(request.url()).origin!==origin)return;
    const id=request.headers()['next-action'];
    if(declaredActions.has(id))matchedActions.add(id);
   };
   try{
    const page=await context.newPage();
    page.on('request',observeAction);
    await action.run({base:origin,user,page,fixture,report:result,save:retain,phase:'baseline',db,evidenceDirectory:fixtureEvidenceDir});
    if(action.name==='saved-report-draft')assert.equal(result.browserSavedReportJourneys?.[0]?.persisted,true);
    row.status='observed';
    row.serverActionsSeen=matchedActions.size;
    for(const actionId of matchedActions)exercisedActions.add(actionId);
    report.serverActionInventory.seenInPassedJourneys=exercisedActions.size;
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
 // The task, approvals, and profile reads use the installed Resignation verifier.
 await step('provision-resignation-runtime','scripts/provision-resignation-runtime.ts');
 await step('seed-catalogues','scripts/seed-catalogs.ts');
 try{
  await run('seed-system-fixture',process.execPath,['--import','tsx',
   'scripts/performance/system-fixture.mjs'],{...dbEnv,
    NODE_OPTIONS:'--conditions=react-server',
    TEST_DATABASE_URL:dbEnv.DATABASE_URL,TEST_MIGRATION_DATABASE_URL:dbEnv.MIGRATION_DATABASE_URL},600000);
 }finally{retainSeedPhases();}
 await run('seed-visible-joiners',process.execPath,['--conditions=react-server','--import','tsx',
  '../automation/scripts/performance/joiners-browser-fixture.mjs'],dbEnv);
 const fixture=JSON.parse(readFileSync(join(privateDir,'fixture.json'),'utf8'));
 assert(Array.isArray(fixture.users)&&fixture.users.length===500&&Array.isArray(fixture.tenants)
  &&fixture.tenants.length===2,'Fictional fixture inventory incomplete');
 assert.equal(new Set(fixture.joiners).size,2,'Expected two fictional New Joiners');
 report.fixture.joinersSeeded=true;
 report.fixtureVerified=true;
 if(!fixtureOnly){
  await seedNotificationReads(fixture);
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
    const phases=new Set(['scope','focus','eligibility','labels','queues','overtime','reviews','leaveDates','decided',
     'recommendations','prepared','readReward','readProbation','readAttendanceAssignment','readResignationInbox',
     'readContracts','readLeave','readCancellation','readReplacement','readAttendance','readClaims','readResignationLegacy']);
    const approvals=[];
    for(const [,record] of log.matchAll(/^PERF_APPROVALS_PHASES (.{1,1500})$/gm)){
     let entry;
     try{entry=JSON.parse(record);}catch{continue;}
     if(!entry||!['admin','manager','assigned'].includes(entry.role)||!['inbox','category','focused'].includes(entry.view))continue;
     const measurements=Object.entries(entry.timings??{}).filter(([phase,ms])=>
      phases.has(phase)&&Number.isSafeInteger(ms)&&ms>=0&&ms<=120000);
     if(!measurements.length)continue;
     approvals.push({role:entry.role,view:entry.view,timings:Object.fromEntries(measurements)});
     if(approvals.length===64)break;
    }
    if(approvals.length)report.approvalsPreparation=approvals;
   }
  }finally{
   if(databaseStarted)await run('postgres-cleanup','bash',['../automation/.github/ci/postgres.sh','stop'],pgEnv);
   save();
  }
 }
}
