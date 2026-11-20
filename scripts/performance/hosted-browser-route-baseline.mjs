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
import {builtPageCoverage,nativePreflightRoutePlan,staticPageCensusPlan,STATIC_CENSUS_SHARDS,dynamicPageCensusMatcher,serverActionRegistry,serverActionCoverage,serverActionPageMatcher} from './system-route-manifest.mjs';
import {isAuthRoute} from '../../lib/auth-routes.ts';
import {performanceFixtureCalendar} from './fixture-workload.mjs';
import {requireNativePreflightFixtureDay,verifyNativePreflightContent} from './native-preflight-content.ts';
import {exercisePersonnelSwitcher} from './personnel-switcher-browser.mjs';
import {exercisePayrollBrowser} from './payroll-browser.mjs';
import {exercisePayrollRegister,verifyPayrollRegisterBoundary} from './payroll-register-browser.mjs';
import {exerciseOrgExplorer} from './org-explorer-browser.mjs';
import {exerciseSavedReport} from './reports-browser.mjs';
import {exerciseMovement} from './movement-browser.mjs';
import {verifyAssistantHistoryBrowser} from './assistant-history-browser.mjs';
import {clickNativeShellDestination} from './navigation-shell-browser.ts';
import {seedBrowserGroupShape,measureBrowserGroupScope} from './browser-group-shape.mjs';

const origin='https://localhost:3443';
const appPort=3174;
const env=process.env;
const fixtureOnly=env.AIHR_BROWSER_FIXTURE_ONLY==='true';
const groupShape=env.AIHR_BROWSER_GROUP_SHAPE==='true';
const shardInput=env.AIHR_BROWSER_STATIC_SHARD??'';
assert(!shardInput||(/^[0-7]$/.test(shardInput)&&!fixtureOnly),'Invalid static census configuration');
const staticShard=shardInput===''?null:Number(shardInput);
const payrollReadTrace=env.AIHR_BROWSER_PAYROLL_READ_TRACE==='true';
const mobileTaskTrace=env.AIHR_BROWSER_MOBILE_TASK_TRACE==='true';
const surfaceProbe=env.AIHR_BROWSER_SURFACE_PROBE??'';
assert(['','insights','recruitment','both'].includes(surfaceProbe),'Unknown browser surface');
const diagnosticCount=Number(payrollReadTrace)+Number(mobileTaskTrace)+Number(Boolean(surfaceProbe));
assert(diagnosticCount<=1&&(!diagnosticCount||(!fixtureOnly&&staticShard===null)),
 'Invalid browser read tracing configuration');
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
const report={kind:surfaceProbe?'FICTIONAL_BROWSER_SURFACE_PROBE':mobileTaskTrace?'FICTIONAL_MOBILE_TASK_OWNER_TRACE':payrollReadTrace?'FICTIONAL_PAYROLL_TRANSACTION_READ_TRACE':staticShard!==null?'FICTIONAL_STATIC_PAGE_CENSUS':fixtureOnly?'FICTIONAL_BROWSER_FIXTURE_CHECK':'FICTIONAL_BROWSER_DOCUMENT_BASELINE',sourceSha:sha,
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
 if(path==='/attendance'){
  const summary=main.locator('[data-tour="attendance-summary"]');
  await summary.getByRole('link',{name:'Previous month',exact:true}).waitFor({state:'visible',timeout:timeout()});
  await summary.getByRole('link',{name:'Next month',exact:true}).waitFor({state:'visible',timeout:timeout()});
  await summary.locator('table tbody tr:visible').first().waitFor({state:'visible',timeout:timeout()});
  assert.equal(await summary.locator('thead th').count(),9);
  return 'usable-content';
 }
 if(path==='/me/payroll-readiness'){
  const readiness=main.locator('[data-my-payroll-readiness-page] [data-payroll-readiness="ready"]');
  await readiness.locator('[data-payroll-period]').waitFor({state:'visible',timeout:timeout()});
  await readiness.locator('[data-payroll-group][data-payroll-status]').first().waitFor({state:'visible',timeout:timeout()});
  assert.equal(await readiness.locator('[data-read-unavailable]').count(),0);
  return 'usable-content';
 }
 if(path==='/me/calendar'){
  const calendar=main.locator('[data-home-card="calendar"][aria-busy="false"]');
  await calendar.getByRole('group',{name:'Calendar view',exact:true}).waitFor({state:'visible',timeout:timeout()});
  await calendar.locator('button[aria-current="date"]').waitFor({state:'visible',timeout:timeout()});
  assert((await calendar.locator('button[aria-haspopup="dialog"]').count())>=28);
  return 'usable-content';
 }
 if(path==='/leave/history'){
  const history=main.locator('[data-tour="leave-requests"]');
  await history.locator('button[aria-haspopup="dialog"][aria-expanded]').waitFor({state:'visible',timeout:timeout()});
  await history.locator('a[aria-current], table tbody tr').or(history.getByText('No requests.',{exact:true})).first()
   .waitFor({state:'visible',timeout:timeout()});
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
 if(path==='/assistant?view=insights'){
  const insights=main.locator('[data-ai-centre-insights]');
  await insights.locator('[data-capacity-ledger] [data-capacity-period] a[aria-current]').waitFor({state:'visible',timeout:timeout()});
  await insights.locator('[data-ai-quality] [data-quality-period] a[aria-current]').waitFor({state:'visible',timeout:timeout()});
  return 'usable-content';
 }
 if(path==='/control-tower/agents/build-list'){
  const window=main.locator('form[data-build-list-window]');
  const choice=window.locator('select[name="days"]:enabled');
  await choice.waitFor({state:'visible',timeout:timeout()});
  assert((await choice.locator('option').count())>1);
  const ranked=main.locator('#ranked-build-list');
  const exported=ranked.locator('a[href^="/control-tower/agents/build-list/export?days="]');
  await exported.waitFor({state:'visible',timeout:timeout()});
  assert.equal(new URL(await exported.getAttribute('href'),origin).searchParams.get('days'),await choice.inputValue());
  assert.equal(await ranked.locator('table thead th').count(),6);
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
// Collect timing before application scripts run, and retain only counts and durations.
function observeStartup(){
 const tasks={count:0,totalMs:0,longestMs:0};
 const accumulate=entries=>{
  for(const entry of entries){
   tasks.count++;
   tasks.totalMs+=entry.duration;
   tasks.longestMs=Math.max(tasks.longestMs,entry.duration);
  }
 };
 const supported=PerformanceObserver.supportedEntryTypes.includes('longtask');
 const observer=supported?new PerformanceObserver(list=>accumulate(list.getEntries())):null;
 observer?.observe({type:'longtask',buffered:true});
 let resourceBufferFull=false;
 performance.addEventListener('resourcetimingbufferfull',()=>{resourceBufferFull=true;});
 globalThis.readFixtureStartupTiming=()=>{
  if(observer)accumulate(observer.takeRecords());
  return {
   longTasks:observer?{count:tasks.count,totalMs:Math.round(tasks.totalMs),longestMs:Math.round(tasks.longestMs)}:null,
   resourceBufferFull,
  };
 };
}

async function documentTiming(page){
 return page.evaluate(()=>{
  const [entry]=performance.getEntriesByType('navigation');
  if(!entry||entry.responseStart<=0)return null;
  const round=ms=>ms>0?Math.round(ms):null;
  const firstPaint=performance.getEntriesByName('first-contentful-paint','paint')[0];
  const scripts=performance.getEntriesByType('resource').filter(resource=>{
   const url=new URL(resource.name,location.href);
   return url.origin===location.origin&&url.pathname.startsWith('/_next/static/')&&url.pathname.endsWith('.js');
  });
  return {
   firstByteMs:round(entry.responseStart),documentResponseEndMs:round(entry.responseEnd),
   firstContentfulPaintMs:firstPaint?round(firstPaint.startTime):null,
   domInteractiveMs:round(entry.domInteractive),domContentLoadedMs:round(entry.domContentLoadedEventEnd),
   transferBytes:entry.transferSize,sampledAtMs:round(performance.now()),
   appScripts:{count:scripts.length,
    completedBeforeDomContentLoaded:scripts.filter(resource=>entry.domContentLoadedEventStart>0
     &&resource.responseEnd<=entry.domContentLoadedEventStart).length,
    transferBytes:scripts.reduce((total,resource)=>total+resource.transferSize,0),
    decodedBodyBytes:scripts.reduce((total,resource)=>total+resource.decodedBodySize,0),
    lastResponseEndMs:round(scripts.reduce((latest,resource)=>Math.max(latest,resource.responseEnd),0))},
   ...globalThis.readFixtureStartupTiming?.(),
  };
 }).catch(()=>null);
}

async function visit(page,actor,route,pass,fixture) {
 const observation={role:route.role,route:route.requested,pass,status:'failed'};
 const started=performance.now(),deadline=started+15000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 try{
  const response=await page.goto(origin+route.requested,{waitUntil:'commit',timeout:timeout()});
  observation.responseCommittedMs=Math.round(performance.now()-started);
  const documentReady=page.waitForLoadState('domcontentloaded',{timeout:timeout()}).then(()=>{
   observation.documentContentLoadedMs=Math.round(performance.now()-started);
   return null;
  },error=>error);
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
  if(observation.readiness==='usable-content'||observation.readiness==='scope-denial'){
   observation.contentWitnessVisibleMs=Math.round(performance.now()-started);
  }
  // The first useful content can arrive while unrelated sections continue streaming.
  // Still evaluate the final page for errors and retain total verification time.
  const documentFailure=await documentReady;
  if(documentFailure)throw documentFailure;
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
   observation.documentTiming=await documentTiming(page);
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
   await page.addInitScript(observeStartup);
   for(const pass of ['first','repeat'])for(const route of routes)await visit(page,actor,route,pass,fixture);
  }finally{await context.close();}
 }));
 report.builtPageCoverage=builtPageCoverage(appPathRoutes,plan,report.observations);
 save();
 assert(lanes.every(lane=>lane.status==='fulfilled'),'An owned browser lane failed');
}

const focusedSurfaces={
 insights:{path:'/assistant?view=insights',witnesses:{
  heading:'[data-ai-centre-insights] h1',
  capacity:'[data-capacity-ledger] [data-capacity-period] a[aria-current]',
  quality:'[data-ai-quality] [data-quality-period] a[aria-current]',
  processEvidence:'[data-capacity-processes]:not([data-capacity-processes="unavailable"])',
 }},
 recruitment:{path:'/recruitment',witnesses:{
  heading:'main h1',
  companyTotals:'main li a[href="/recruitment/candidates"] .tabular-nums',
  taskControls:'#tasks nav[aria-label] a[aria-current="page"]',
 }},
};

async function measureSurfaceProbe(fixture,surface){
 const require=createRequire(join(process.cwd(),'package.json'));
 browser??=await require('playwright').chromium.launch();
 const {path,witnesses}=focusedSurfaces[surface];
 report.surfaceProbes??={};
 const visits=[];
 report.surfaceProbes[surface]=visits;
 for(const actorIndex of [0,1]){
  const actor=fixture.users[actorIndex],context=await signedInContext(actor);
  try{
   assert.equal(actor.role,actorIndex===0?'groupHR':'companyHR');
   const page=await context.newPage();
   for(const pass of ['first','repeat-1','repeat-2']){
    const row={role:actor.role,pass,status:'incomplete',milestones:{}};
    visits.push(row);
    const started=performance.now(),elapsed=()=>Math.round(performance.now()-started);
    try{
     const response=await page.goto(origin+path,{waitUntil:'commit',timeout:15000});
     assert.equal(response?.status(),200);
     assert.equal(page.url(),origin+path);
     row.responseMs=elapsed();
     const milestones=await Promise.allSettled(Object.entries(witnesses).map(async ([label,selector])=>{
      await page.locator(selector).first().waitFor({state:'visible',timeout:Math.max(1,15000-elapsed())});
      row.milestones[label]=elapsed();
     }));
     assert(milestones.every(result=>result.status==='fulfilled'),'A focused browser milestone did not become visible');
     await assertContentAvailable(page);
     row.status='observed';
    }finally{save();}
   }
  }finally{await context.close();}
 }
}

async function measurePayrollReadTrace(fixture){
 const require=createRequire(join(process.cwd(),'package.json'));
 browser=await require('playwright').chromium.launch();
 // Keep application traffic to one document at a time so the receipt identifies the page's own work.
 for(const actorIndex of [0,1]){
  const actor=fixture.users[actorIndex],context=await signedInContext(actor);
  try{
   assert.equal(actor.role,actorIndex===0?'groupHR':'companyHR');
   const page=await context.newPage();
   await page.addInitScript(observeStartup);
   const route={role:actor.role,requested:payrollHistoryPath,final:payrollHistoryPath};
   for(const pass of ['first','repeat-1','repeat-2']){
    await visit(page,actor,route,pass,fixture);
   }
  }finally{await context.close();}
 }
 assert.equal(report.observations.length,6);
 assert(report.observations.every(row=>row.status==='observed'&&row.readiness==='usable-content'),
  'Payroll Transaction View did not show a History row on every measured visit');
 await measureClosedPayrollPicker(fixture);
}

async function measureClosedPayrollPicker(fixture){
 const actor=fixture.users[0], subject=fixture.users[4];
 assert.equal(actor.role,'groupHR');
 assert.equal(subject.role,'employee');
 const context=await signedInContext(actor);
 const row={status:'incomplete',choiceRequestsBeforeOpen:0};
 report.payrollClosedPicker=row;
 try{
  await context.addCookies([{name:'txnview_history_panel',value:'0',url:origin,secure:true,sameSite:'Lax'}]);
  const page=await context.newPage();
  const isChoices=request=>{
   const url=new URL(request.url());
   return request.method()==='POST'&&url.origin===origin&&url.pathname==='/api/employee-choices';
  };
  const observe=request=>{if(isChoices(request))row.choiceRequestsBeforeOpen++;};
  page.on('request',observe);
  const started=performance.now();
  const response=await page.goto(origin+payrollHistoryPath,{waitUntil:'commit',timeout:15000});
  assert.equal(response?.status(),200);
  assert.equal(page.url(),origin+payrollHistoryPath);
  await readyContent(page,actor,payrollHistoryPath,()=>15000,undefined,fixture);
  row.historyContentMs=Math.round(performance.now()-started);
  const search=page.getByRole('searchbox',{name:'Search employee',exact:true});
  assert.equal(await search.count(),0,'A collapsed picker mounted the search controls');
  assert.equal(row.choiceRequestsBeforeOpen,0,'A collapsed picker started employee requests');
  page.off('request',observe);
  save();
  const toggle=page.getByRole('button',{name:'Select employee',exact:true}).and(page.locator('button:visible')).first();
  const opened=performance.now();
  const [firstPage]=await Promise.all([
   page.waitForResponse(response=>isChoices(response.request()),{timeout:15000}),
   toggle.click({timeout:15000}),
  ]);
  assert.equal(firstPage.status(),200);
  await firstPage.finished();
  await search.waitFor({state:'visible',timeout:5000});
  row.firstChoicesMs=Math.round(performance.now()-opened);
  save();
  const matching=performance.now();
  await search.fill(subject.name);
  const select=page.getByRole('button').filter({hasText:subject.name}).and(page.locator('button:visible')).first();
  await select.waitFor({state:'visible',timeout:15000});
  row.searchedChoiceMs=Math.round(performance.now()-matching);
  const selected=performance.now();
  await Promise.all([
   page.waitForURL(url=>url.pathname===payrollHistoryPath&&url.searchParams.get('employmentId')===subject.employmentId,
    {timeout:15000}),
   select.click({timeout:15000}),
  ]);
  await readyContent(page,actor,payrollHistoryPath,()=>15000,undefined,fixture);
  row.selectedHistoryMs=Math.round(performance.now()-selected);
  row.status='observed';
 }finally{save();await context.close();}
}

async function measureMobileTaskTrace(fixture){
 const require=createRequire(join(process.cwd(),'package.json'));
 browser=await require('playwright').chromium.launch();
 const actor=fixture.users[0];
 assert.equal(actor.role,'groupHR');
 const context=await signedInContext(actor);
 report.mobileTaskVisits=[];
 try{
  const page=await context.newPage();
  for(const view of ['builder','live']){
   const started=performance.now(),url=origin+'/mobile-preview'+(view==='live'?'?live=1':'');
   const elapsed=()=>Math.round(performance.now()-started);
   const row={view,status:'incomplete'};
   report.mobileTaskVisits.push(row);
   try{
    row.step='document';
    const response=await page.goto(url,{waitUntil:'commit',timeout:15000});
    assert.equal(response?.status(),200);
    assert.equal(page.url(),url);
    row.responseMs=elapsed();
    if(view==='builder'){
     row.step='editor';
     await page.locator('[data-mobile-builder]').getByRole('textbox',{name:'App brand name',exact:true})
      .waitFor({state:'visible',timeout:15000});
     row.editorMs=elapsed();
    }
    row.step='phone';
    const phone=page.locator('main [data-appearance]');
    const navigation=phone.getByRole('navigation',{name:'Mobile navigation'});
    await navigation.waitFor({state:'visible',timeout:15000});
    row.phoneMs=elapsed();
    row.step='tasks';
    const taskSection=phone.locator('[data-home-section="tasks"]');
    const pending=taskSection.getByRole('status').filter({hasText:'Refreshing data…'});
    await taskSection.waitFor({state:'visible',timeout:5000});
    row.tasksPendingWhenPhoneVisible=await pending.isVisible();
    save();
    if(view==='live'&&row.tasksPendingWhenPhoneVisible){
     row.step='personal-requests';
     await navigation.getByRole('button',{name:'Requests',exact:true}).click({timeout:10000});
     await phone.getByRole('heading',{name:'Leave Request Status',exact:true}).waitFor({state:'visible',timeout:10000});
     row.personalRequestsMs=elapsed();
     await navigation.getByRole('button',{name:'Home',exact:true}).click({timeout:10000});
     await taskSection.waitFor({state:'visible',timeout:10000});
    }
    row.step='task-content';
    await pending.waitFor({state:'hidden',timeout:45000});
    await taskSection.locator('a, p').first().waitFor({state:'visible',timeout:5000});
    assert.equal(await taskSection.getByText('Unable to load this section. Refresh to try again.',
     {exact:true}).count(),0,'Assigned-task data was unavailable');
    row.tasksMs=elapsed();
    row.status='observed';
   }finally{save();}
  }
 }finally{await context.close();}
}

const censusPanelTitles={
 '/assistant/rewards/cancel':'Cancel a Rewards review',
 '/assistant/rewards/return':'Return annual Rewards review',
};

async function measureCensusVisit(page,url,role,pass,label,compiledPaths){
 const row={path:label,pass,role,outcome:'browser-failure'};
 const path=url.pathname;
 const start=performance.now(),remaining=()=>Math.max(1,Math.floor(start+15000-performance.now()));
 const redirected=()=>{
  const finalUrl=new URL(page.url());
  if(finalUrl.origin!==origin){row.outcome='external-destination';return true;}
  if(finalUrl.pathname===path)return false;
  row.outcome='redirect';
  row.destination=compiledPaths.has(finalUrl.pathname)?finalUrl.pathname:'non-static-destination';
  return true;
 };
 try{
  const response=await page.goto(url.href,{waitUntil:'commit',timeout:remaining()});
  row.responseCommittedMs=Math.round(performance.now()-start);
  row.httpStatus=response?.status()??null;
  if(!redirected()){
   if(row.httpStatus!==200)row.outcome='http-error';
   else{
    const title=censusPanelTitles[path];
    const heading=title
     ?page.locator('main:visible').getByRole('heading',{name:title,exact:true,level:2}).first()
     :page.locator('main:visible h1:visible').first();
    const fault=page.getByRole('heading',{name:/^(This page could not be displayed|This is taking longer than usual)$/}).first();
    await heading.or(fault).first().waitFor({state:'visible',timeout:remaining()});
    if(!redirected()){
     row.headingMs=Math.round(performance.now()-start);
     row.outcome=await fault.isVisible()?'render-error':
      await page.locator('main [data-read-unavailable]:visible').count()?'read-unavailable':'heading-visible';
     if(path==='/mobile-preview'&&row.outcome==='heading-visible'){
      const builder=page.locator('[data-mobile-builder]');
      await builder.getByRole('textbox',{name:'App brand name',exact:true}).waitFor({state:'visible',timeout:remaining()});
      row.editorControlsVisibleMs=Math.round(performance.now()-start);
      await builder.locator('[data-appearance]').waitFor({state:'visible',timeout:remaining()});
      row.contentWitnessVisibleMs=Math.round(performance.now()-start);
     }
    }
   }
  }
 }catch(error){
  if(error?.name==='TimeoutError'){
   if(row.responseCommittedMs===undefined){
    row.outcome='timeout';row.timeoutStage='response';
   }else if(!redirected()){
    row.outcome='timeout';row.timeoutStage=row.headingMs===undefined?'render':'usable-content';
   }
  }else row.outcome='browser-failure';
 }
 row.elapsedMs=Math.round(performance.now()-start);
 if(row.responseCommittedMs!==undefined&&['heading-visible','timeout','render-error','read-unavailable'].includes(row.outcome)){
  row.documentTiming=await documentTiming(page);
 }
 return row;
}

const maxDynamicTemplatesPerRole=24;
const maxDynamicLinkDepth=2;
async function discoverDynamicPages(page,sourcePath,depth,matcher,discovered,parentTemplate){
 const links=await page.locator('main:visible a[href]:visible:not([download])').evaluateAll(
  anchors=>anchors.slice(0,250).map(anchor=>anchor.href));
 for(const link of links){
  const url=new URL(link);
  if(url.origin!==origin||url.username||url.password||url.href.length>1000)continue;
  const template=matcher.match(url.pathname);
  if(!template||discovered.has(template))continue;
  if(discovered.size>=maxDynamicTemplatesPerRole)return true;
  url.hash='';
  discovered.set(template,{url,sourcePath,depth,parentTemplate});
 }
 return false;
}

async function measureStaticPageCensus(fixture,shard){
 const appPathRoutes=JSON.parse(readFileSync('.next/app-path-routes-manifest.json','utf8'));
 const plan=staticPageCensusPlan(appPathRoutes,shard);
 const routesManifest=JSON.parse(readFileSync('.next/routes-manifest.json','utf8'));
 const dynamicMatcher=dynamicPageCensusMatcher(appPathRoutes,routesManifest);
 const census={shard,shards:STATIC_CENSUS_SHARDS,...plan,outcomes:[],dynamic:{
  templates:dynamicMatcher.templates,missingMatchers:dynamicMatcher.missingMatchers,
  maxTemplatesPerRole:maxDynamicTemplatesPerRole,maxLinkDepth:maxDynamicLinkDepth,
  discoveryFailures:0,limitedRoles:[],outcomes:[],
 }};
 report.staticPageCensus=census;
 save();
 const require=createRequire(join(process.cwd(),'package.json'));
 browser=await require('playwright').chromium.launch();
 const curated=nativePreflightRoutePlan();
 const lanes=new Map();
 for(const path of plan.paths){
  assert(/^\/(?:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*)?$/.test(path),'Unexpected static route shape');
  // Prefer a known authorized fixture role, then choose the closest general role.
  const owner=curated.find(route=>route.requested===path);
  const actorIndex=isAuthRoute(path)?null:owner?.actorIndex??(path==='/me'||path.startsWith('/me/')?4:0);
  if(!lanes.has(actorIndex))lanes.set(actorIndex,[]);
  lanes.get(actorIndex).push(path);
 }
 const compiledPaths=new Set(Object.values(appPathRoutes));
 const results=await Promise.allSettled(Array.from(lanes,async([actorIndex,paths])=>{
  const actor=actorIndex===null?null:fixture.users[actorIndex];
  const context=actor?await signedInContext(actor):await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});
  try{
   const page=await context.newPage();
   await page.addInitScript(observeStartup);
   const role=actor?.role??'public';
   const discovered=new Map();
   let discoveryLimited=false;
   async function discover(sourcePath,depth,parentTemplate){
    try{
     if(await discoverDynamicPages(page,sourcePath,depth,dynamicMatcher,discovered,parentTemplate))discoveryLimited=true;
    }catch{census.dynamic.discoveryFailures++;}
   }
   for(const pass of ['first','repeat'])for(const path of paths){
    const row=await measureCensusVisit(page,new URL(origin+path),role,pass,path,compiledPaths);
    if(actor&&pass==='first'&&row.outcome==='heading-visible'){
     await discover(path,1);
    }
    census.outcomes.push(row);
    save();
   }
   // First-pass detail pages can reveal further details, edits or print screens. Retain their static
   // root and depth in the receipt and keep the concrete address inside the browser fixture.
   for(const pass of ['first','repeat'])for(const [template,{url,sourcePath,depth,parentTemplate}] of discovered){
    const row=await measureCensusVisit(page,url,role,pass,template,compiledPaths);
    if(pass==='first'&&row.outcome==='heading-visible'&&depth<maxDynamicLinkDepth){
     await discover(sourcePath,depth+1,template);
    }
    census.dynamic.outcomes.push({...row,sourcePath,linkDepth:depth,parentTemplate});
    save();
   }
   if(discoveryLimited){census.dynamic.limitedRoles.push(role);save();}
  }finally{await context.close();}
 }));
 assert(results.every(result=>result.status==='fulfilled'),'A static census lane failed');
 assert.equal(census.outcomes.length,plan.paths.length*2,'Static census observations incomplete');
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
 report.actionStage='notification-page-open';
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
 const markAllButton=page.getByRole('button',{name:'Mark all read',exact:true});
 report.actionStage='notification-popover-open';
 await bell.click({timeout:15000});
 await markAllButton.waitFor({state:'visible',timeout:15000});
 report.notificationSteps=[];
 let current;
 const observe=request=>{
  const url=new URL(request.url());
  if(current&&url.origin===origin&&url.pathname===path&&url.searchParams.has('_rsc')&&request.method()==='GET')current.refreshRequests++;
 };
 const observeResponse=response=>{
  const request=response.request();
  const url=new URL(response.url());
  if(current&&request.method()==='POST'&&request.headers()['next-action']&&url.origin===origin&&url.pathname===path){
   current.actionResponseStatus=response.status();
  }
 };
 page.on('request',observe);
 page.on('response',observeResponse);
 async function mark(step,button,count){
  current={step,refreshRequests:0};
  report.notificationSteps.push(current);
  const started=performance.now();
  report.actionStage=step+'-click';
  await button.click({timeout:15000});
  report.actionStage=step+'-count';
  await page.getByRole('button',{name:unreadPattern(count)}).waitFor({state:'visible',timeout:15000});
  report.actionStage=step+'-persistence';
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
  report.actionStage='notification-popover-reopen';
  if(!await markAllButton.isVisible())await bell.click({timeout:15000});
  await markAllButton.waitFor({state:'visible',timeout:15000});
  await mark('mark-all-notifications-read',markAllButton,0);
  const last=await rows();
  assert.equal(own(last).filter(item=>item.read).length,2);
  assert.equal(last.find(item=>item.recipient===peer.employmentId)?.read,false);
  current.persisted=true;
 }catch(error){
  const afterFailure=await rows().catch(()=>null);
  if(current&&afterFailure)current.fixtureNotificationsRead=own(afterFailure).filter(item=>item.read).length;
  throw error;
 }finally{
  page.off('request',observe);
  page.off('response',observeResponse);
 }
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
 report.assistantStartup={};
 await page.addInitScript(observeStartup);
 await verifyAssistantHistoryBrowser({page,history,timeout:15000,
  visitAsk:async()=>{
   const started=performance.now();
   const response=await page.goto(origin+'/assistant',{waitUntil:'commit',timeout:15000});
   assert.equal(response?.status(),200);
   assert.equal(page.url(),origin+'/assistant');
   await Promise.all([
    page.locator('button[data-tour="account"]').getByText(user.name,{exact:true}).first()
     .waitFor({state:'visible',timeout:15000})
     .then(()=>{report.assistantStartup.authenticatedShellMs=Math.round(performance.now()-started);}),
    page.locator('main [data-ask-conversation] textarea[name="question"]:enabled')
     .waitFor({state:'visible',timeout:15000})
     .then(()=>{report.assistantStartup.composerVisibleMs=Math.round(performance.now()-started);}),
   ]);
  },
  onMeasurement:async row=>{
   report.historySteps.push({step:row.step,elapsedMs:Math.round(row.navigationToUsableMs??row.clickToUsableMs),
    promptsSubmitted:row.promptsSubmitted});
   if(row.step==='saved-history-list'){
    const timing=await documentTiming(page);
    report.assistantStartup.documentTiming=timing;
    assert(timing?.appScripts.count>0&&timing.longTasks&&timing.resourceBufferFull===false,
     'Assistant startup must have bounded script and main-thread observations');
   }
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

async function measureDailyAttendanceFilters({page,user,fixture,report,save}){
 const path='/attendance/daily';
 const company=fixture.tenants[user.tenant].companies[user.company];
 const employee=fixture.users.find(actor=>actor.tenant===user.tenant&&actor.companyId===company.companyId&&actor.role==='employee');
 assert(employee,'Daily Attendance needs a known employee in the selected company');
 const code='PERF'+String(employee.index).padStart(4,'0');
 const date=fixture.today;
 report.attendanceFilterSteps=[];
 report.attendanceStage='open-attendance';
 const initial=await page.goto(origin+path+'?date='+encodeURIComponent(date),{waitUntil:'domcontentloaded',timeout:15000});
 assert.equal(initial?.status(),200);
 const card=page.locator('main [data-tour="attendance-day"]');
 const form=card.locator('form');
 const search=form.locator('input[name="q"]');
 report.attendanceStage='select-company';
 await form.locator('select[name="company"]').selectOption(company.companyId,{timeout:15000});
 report.attendanceStage='select-department';
 await form.locator('select[name="dept"]').selectOption(company.departmentId,{timeout:15000});
 const matching=card.getByRole('row').filter({has:page.getByRole('cell',{name:code,exact:true})});
 const anyEmployee=card.locator('tbody a[href^="/attendance/individual/"]');
 const empty=card.getByText('No employees in scope.',{exact:true});
 for(const [step,query,expected] of [
  ['filter-employee',code,true],
  ['filter-no-matches','PERF-NO-FIXTURE-MATCH',false],
  ['restore-filtered-employee',code,true],
 ]){
  report.attendanceStage=step+'-input';
  await search.fill(query,{timeout:15000});
  const matchesSubmission=url=>url.origin===origin&&url.pathname===path&&url.searchParams.get('date')===date
   &&url.searchParams.get('company')===company.companyId&&url.searchParams.get('dept')===company.departmentId
   &&url.searchParams.get('q')===query;
  const started=performance.now();
  report.attendanceStage=step+'-navigation';
  await Promise.all([
   page.waitForURL(matchesSubmission,{waitUntil:'commit',timeout:15000}),
   form.getByRole('button',{name:'Apply',exact:true}).click({timeout:15000}),
  ]);
  report.attendanceStage=step+'-result';
  if(expected){
   await matching.getByText(employee.name,{exact:true}).waitFor({state:'visible',timeout:15000});
   await matching.locator('a[href="/attendance/individual/'+date+'?emp='+employee.employmentId+'"]')
    .waitFor({state:'visible',timeout:15000});
  }else{
   await empty.waitFor({state:'visible',timeout:15000});
  }
  assert.equal(await anyEmployee.count(),expected?1:0,'Daily Attendance returned unexpected employees for the selected scope');
  report.attendanceFilterSteps.push({step,elapsedMs:Math.round(performance.now()-started)});
  save();
 }
}

async function measurePayrollHistoryDisclosure({page,user,fixture,report,save}){
 report.actionStage='payroll-history-open';
 const response=await page.goto(origin+payrollHistoryPath,{waitUntil:'domcontentloaded',timeout:20000});
 assert.equal(response?.status(),200);
 assert.equal(new URL(page.url()).pathname,payrollHistoryPath);
 const table=page.locator('main tbody').filter({has:page.locator('button[data-table-disclosure]')});
 const disclosure=table.locator('button[data-table-disclosure]').first();
 await disclosure.waitFor({state:'visible',timeout:15000});
 const employeeCodes=new Set(fixture.users.filter(actor=>actor.tenant===user.tenant
  &&(user.role==='groupHR'||actor.companyId===user.companyId)).map(actor=>'PERF'+String(actor.index).padStart(4,'0')));
 const displayedCode=(await disclosure.locator('xpath=ancestor::tr[1]').innerText()).match(/\bPERF[0-9]{4}\b/)?.[0];
 assert(employeeCodes.has(displayedCode),'Payroll History needs a fixture payslip in the session scope');
 assert.equal(await disclosure.getAttribute('aria-expanded'),'false');
 const breakdown=table.locator('tr[id^="payslip-breakdown-"]');
 report.payrollDisclosureSteps=[];
 let started=performance.now();
 report.actionStage='payroll-breakdown-click';
 await disclosure.click({timeout:15000});
 report.actionStage='payroll-breakdown-expand';
 await disclosure.and(page.locator('[aria-expanded="true"]')).waitFor({state:'visible',timeout:15000});
 report.payrollDisclosureSteps.push({step:'expand-feedback',elapsedMs:Math.round(performance.now()-started)});
 save();
 report.actionStage='payroll-breakdown-details';
 await breakdown.getByRole('heading',{name:'Earnings',exact:true}).waitFor({state:'visible',timeout:15000});
 await breakdown.getByText('Net pay',{exact:true}).waitFor({state:'visible',timeout:15000});
 assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
 report.payrollDisclosureSteps.push({step:'open-breakdown',elapsedMs:Math.round(performance.now()-started)});
 save();
 started=performance.now();
 report.actionStage='payroll-breakdown-collapse';
 await disclosure.click({timeout:15000});
 await breakdown.waitFor({state:'hidden',timeout:15000});
 assert.equal(await disclosure.getAttribute('aria-expanded'),'false');
 report.payrollDisclosureSteps.push({step:'close-breakdown',elapsedMs:Math.round(performance.now()-started)});
 save();
}

async function measurePublicLogin(){
 report.publicLogin=[];
 for(const locale of ['en','ms']){
  const copy=JSON.parse(readFileSync('messages/'+locale+'.json','utf8'));
  assert(typeof copy.internalAuth?.username==='string'&&copy.internalAuth.username.length>0);
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});
  try{
   await context.addCookies([{name:'NEXT_LOCALE',value:locale,url:origin}]);
   const page=await context.newPage();
   await page.addInitScript(observeStartup);
   const errors=[];
   page.on('pageerror',()=>{errors.push(true);});
   page.on('console',message=>{
    if(message.type()==='error'&&message.text().includes('MISSING_MESSAGE'))errors.push(true);
   });
   const started=performance.now();
   const response=await page.goto(origin+'/login',{waitUntil:'commit',timeout:15000});
   assert.equal(response?.status(),200);
   assert.equal(new URL(page.url()).pathname,'/login');
   const workspace=page.locator('form.login-workspace-form');
   await workspace.locator('input[name="organization"]:enabled').waitFor({state:'visible',timeout:15000});
   assert.equal(await page.locator('html').getAttribute('lang'),locale);
   const workspaceReadyMs=Math.round(performance.now()-started);
   await workspace.locator('input[name="organization"]').fill('perf-a',{timeout:15000});
   await workspace.getByRole('button').click({timeout:15000});
   await page.getByLabel(copy.internalAuth.username,{exact:true}).waitFor({state:'visible',timeout:15000});
   await page.locator('input[name="password"]:enabled').waitFor({state:'visible',timeout:15000});
   assert.equal(errors.length,0,'Localized login produced a browser or translation error');
   report.publicLogin.push({locale,workspaceReadyMs,credentialsReadyMs:Math.round(performance.now()-started),
    documentTiming:await documentTiming(page)});
   save();
  }finally{await context.close();}
 }
}

async function measureShellPopovers({page,user,report,save}){
 report.actionStage='shell-popover-document-open';
 report.shellPopoverSteps=[];
 const response=await page.goto(origin+'/me/cases',{waitUntil:'domcontentloaded',timeout:15000});
 assert.equal(response?.status(),200);
 await readyContent(page,user,'/me/cases',()=>15000);
 const account=page.locator('button[data-tour="account"]');
 const menu=page.getByRole('menu',{name:'Account menu',exact:true});
 const bell=page.getByRole('button',{name:/^Notifications, /});

 async function open(step,trigger,panel,paths){
  report.actionStage=step;
  let speculativeRouteRequests=0;
  const observe=request=>{
   const url=new URL(request.url());
   if(request.method()!=='GET'||url.origin!==origin||!paths.some(path=>url.pathname===path))return;
   if(url.searchParams.has('_rsc')||request.headers().rsc==='1')speculativeRouteRequests++;
  };
  page.on('request',observe);
  try{
   const started=performance.now();
   await trigger.click({timeout:15000});
   await panel.waitFor({state:'visible',timeout:15000});
   const controlsVisibleMs=Math.round(performance.now()-started);
   await pause(250);
   report.shellPopoverSteps.push({step,controlsVisibleMs,speculativeRouteRequests});
   save();
   assert.equal(speculativeRouteRequests,0,'Opening the shell popover requested a linked page');
  }finally{page.off('request',observe);}
 }

 await open('shell-account-open',account,menu.getByRole('menuitem',{name:'View my profile',exact:true}),
  ['/me','/me/home','/admin/personnel','/admin/users/access']);
 await page.keyboard.press('Escape');
 await menu.waitFor({state:'hidden',timeout:15000});
 await open('shell-notifications-open',bell,page.getByRole('button',{name:'History',exact:true}),
  ['/me/notifications','/approvals','/approvals/history']);
}

async function measureWalkthrough({page,user,report,save}){
 report.walkthroughSteps=[];
 report.actionStage='welcome-profile-open';
 const response=await page.goto(origin+'/me',{waitUntil:'commit',timeout:15000});
 assert.equal(response?.status(),200);
 assert.equal(page.url(),origin+'/me');
 const account=page.locator('button[data-tour="account"]').filter({hasText:user.name});
 const dialog=page.getByRole('dialog',{name:'Product tour',exact:true});
 await account.waitFor({state:'visible',timeout:15000});
 assert.equal(await dialog.count(),0);
 const menuStarted=performance.now();
 report.actionStage='welcome-account-menu';
 await account.click({timeout:15000});
 const launcher=page.getByRole('menuitem',{name:'Take a tour',exact:true});
 await launcher.waitFor({state:'visible',timeout:15000});
 report.walkthroughSteps.push({step:'open-account-menu',elapsedMs:Math.round(performance.now()-menuStarted)});
 save();
 const started=performance.now();
 report.actionStage='welcome-launch';
 await launcher.click({timeout:15000});
 report.actionStage='welcome-dialog-ready';
 await dialog.getByRole('heading',{name:'Welcome to AIHR 👋',exact:true}).waitFor({state:'visible',timeout:15000});
 await dialog.getByRole('button',{name:'Next',exact:true}).waitFor({state:'visible',timeout:15000});
 assert.equal(await account.getAttribute('aria-expanded'),'false');
 report.walkthroughSteps.push({step:'open-welcome-tour',elapsedMs:Math.round(performance.now()-started)});
 save();
}

async function measureRosterExceptions({page,user,fixture,report,save}){
 const started=performance.now(),deadline=started+15000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 const response=await page.goto(origin+'/roster',{waitUntil:'commit',timeout:timeout()});
 assert.equal(response?.status(),200);
 assert.equal(page.url(),origin+'/roster');
 assert.equal(await readyContent(page,user,'/roster',timeout,undefined,fixture),'usable-content');
 report.rosterExceptionSteps=[{step:'schedule-visible',elapsedMs:Math.round(performance.now()-started)}];
 save();
 const link=page.locator('main a[href^="/roster/exceptions?"]');
 const count=link.locator('[data-roster-exception-count="ready"]');
 await count.waitFor({state:'visible',timeout:timeout()});
 const expected=(await count.textContent()).match(/^Exceptions \(([0-9]+)\)$/)?.[1];
 assert(expected!==undefined,'Roster exception count has no numeric label');
 report.rosterExceptionSteps.push({step:'exception-count-visible',elapsedMs:Math.round(performance.now()-started)});
 save();
 const target=new URL(await link.getAttribute('href'),origin);
 assert.equal(target.origin,origin);
 assert.equal(target.pathname,'/roster/exceptions');
 assert(target.searchParams.has('month')&&target.searchParams.has('view'));
 const clicked=performance.now();
 await link.click({timeout:15000});
 await page.waitForURL(target.href,{timeout:15000});
 const main=page.locator('main:visible');
 await main.getByRole('heading',{name:'Roster exceptions',exact:true}).waitFor({state:'visible',timeout:15000});
 const total=main.locator('[data-ui-section-count]').filter({hasText:new RegExp('^\\('+expected+'\\)$')});
 await total.waitFor({state:'visible',timeout:15000});
 await assertContentAvailable(page);
 report.rosterExceptionSteps.push({step:'open-matching-exceptions',elapsedMs:Math.round(performance.now()-clicked)});
 save();
}

async function measureCalendarMonth({page,user,fixture,report,save}){
 const path='/me/calendar';
 const response=await page.goto(origin+path,{waitUntil:'commit',timeout:15000});
 assert.equal(response?.status(),200);
 assert.equal(page.url(),origin+path);
 assert.equal(await readyContent(page,user,path,()=>15000,undefined,fixture),'usable-content');
 const calendar=page.locator('main [data-home-card="calendar"]');
 const originalMonth=fixture.today.slice(0,7);
 const previous=new Date(originalMonth+'-01T00:00:00Z');
 previous.setUTCMonth(previous.getUTCMonth()-1);
 const previousMonth=previous.toISOString().slice(0,7);
 const format=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'});
 report.calendarSteps=[];
 for(const [step,button,month] of [
  ['calendar-previous-month','Previous',previousMonth],
  ['calendar-return-to-current-month','Today',originalMonth],
 ]){
  const started=performance.now();
  const [result]=await Promise.all([
   page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.origin===origin&&url.pathname==='/api/home/calendar'&&url.searchParams.get('month')===month
     &&url.searchParams.get('employmentId')===user.employmentId;
   },{timeout:15000}),
   calendar.getByRole('button',{name:button,exact:true}).click({timeout:15000}),
  ]);
  assert.equal(result.status(),200);
  await page.waitForURL(url=>url.pathname===path&&url.searchParams.get('month')===month
   &&url.searchParams.get('employmentId')===user.employmentId,{timeout:15000});
  const heading=format.format(new Date(month+'-01T00:00:00Z'));
  await calendar.getByRole('heading',{name:heading,exact:true}).waitFor({state:'visible',timeout:15000});
  assert((await calendar.locator('button[aria-haspopup="dialog"]').count())>=28);
  report.calendarSteps.push({step,elapsedMs:Math.round(performance.now()-started)});
  save();
 }
 await calendar.locator('button[aria-current="date"]').waitFor({state:'visible',timeout:15000});
}

async function measureLifecycleMenu({page,user,fixture,report,save}){
 const path='/admin/personnel';
 const opened=performance.now(),deadline=opened+20000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 report.lifecycleMenuSteps=[];
 const measure=(step,started=opened)=>{
  report.lifecycleMenuSteps.push({step,elapsedMs:Math.round(performance.now()-started)});
  save();
 };
 const response=await page.goto(origin+path,{waitUntil:'commit',timeout:timeout()});
 assert.equal(response?.status(),200);
 assert.equal(page.url(),origin+path);
 const menu=page.getByRole('button',{name:'On/Off Boarding',exact:true});
 await Promise.all([
  readyContent(page,user,path,timeout,undefined,fixture).then(result=>{
   assert.equal(result,'usable-content');
   measure('personnel-usable');
  }),
  menu.waitFor({state:'visible',timeout:timeout()}).then(()=>measure('lifecycle-trigger-visible')),
 ]);
 const clicked=performance.now();
 await menu.click({timeout:timeout()});
 const access=page.getByRole('link',{name:'Module Access',exact:true});
 await access.waitFor({state:'visible',timeout:timeout()});
 assert.equal(await access.getAttribute('href'),'/lifecycle/v9?view=access');
 measure('authorized-lifecycle-flyout',clicked);
}

async function measureActions(fixture){
 const referenceManifest=JSON.parse(readFileSync('.next/server/server-reference-manifest.json','utf8'));
 const appPathRoutes=JSON.parse(readFileSync('.next/app-path-routes-manifest.json','utf8'));
 const registrations=serverActionRegistry(appPathRoutes,referenceManifest);
 assert(registrations.size>0,'The measured build must have registered Server Actions');
 const routesManifest=JSON.parse(readFileSync('.next/routes-manifest.json','utf8'));
 const actionPageFor=serverActionPageMatcher(appPathRoutes,routesManifest);
 const acceptedByAction=new Map();
 report.serverActionInventory=serverActionCoverage(registrations,acceptedByAction);
 const require=createRequire(join(process.cwd(),'package.json'));
 const postgres=require('postgres');
 const db=postgres(dbEnv.MIGRATION_DATABASE_URL,{max:1,connection:{default_transaction_read_only:'on'}});
 const actions=[
  ...(groupShape?[
   {name:'group-company-scope',actorIndex:0,run:measureBrowserGroupScope,timings:result=>result.groupScopeSteps},
   {name:'group-lifecycle-menu',actorIndex:0,run:measureLifecycleMenu,timings:result=>result.lifecycleMenuSteps},
  ]:[]),
  {name:'personal-calendar-month',actorIndex:4,run:measureCalendarMonth,timings:result=>result.calendarSteps},
  ...[0,1].map(actorIndex=>({name:'roster-exceptions',actorIndex,run:measureRosterExceptions,timings:result=>result.rosterExceptionSteps})),
  ...[0,4].map(actorIndex=>({name:'shell-popovers',actorIndex,run:measureShellPopovers,timings:result=>result.shellPopoverSteps})),
  {name:'welcome-tour',actorIndex:4,run:measureWalkthrough,timings:result=>result.walkthroughSteps},
  ...[0,1].map(actorIndex=>({name:'daily-attendance-filters',actorIndex,run:measureDailyAttendanceFilters,
   timings:result=>result.attendanceFilterSteps})),
  ...[0,1].map(actorIndex=>({name:'payroll-history-breakdown',actorIndex,run:measurePayrollHistoryDisclosure,
   timings:result=>result.payrollDisclosureSteps})),
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
  {name:'payroll-register-pager',actorIndex:0,run:exercisePayrollRegister,
   timings:result=>result.browserPayrollRegister?.map(({kind,elapsedMs,visibleRows,exactTotalRows,totalsMatch})=>
    ({step:kind,elapsedMs,visibleRows,exactTotalRows,totalsMatch}))},
  ...[1,250].map(actorIndex=>({name:'payroll-register-boundary',actorIndex,run:async options=>{
   await verifyPayrollRegisterBoundary({...options,actor:options.user,owner:options.fixture.users[0]});
  },timings:result=>result.browserPayrollRegister?.map(({kind,scope,status,denied})=>({step:kind,scope,status,denied}))})),
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
   const opened=performance.now(),deadline=opened+15000;
   const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
   report.joinerSteps=[];
   const measure=(step,started)=>{
    report.joinerSteps.push({step,elapsedMs:Math.round(performance.now()-started)});
    save();
   };
   report.joinerStage='document-commit';
   const response=await page.goto(origin+'/lifecycle/v9',{waitUntil:'commit',timeout:timeout()});
   assert.equal(response?.status(),200);
   assert.equal(page.url(),origin+'/lifecycle/v9');
   measure('document-commit',opened);
   report.joinerStage='register-visible';
   await readyContent(page,user,'/lifecycle/v9',timeout,undefined,fixture);
   measure('register-visible',opened);
   const search=page.getByRole('textbox',{name:'Search by name',exact:true});
   const results=page.getByRole('table',{name:'New joiners',exact:true});
   const owned=results.getByRole('link',{name:fixture.joiners[0],exact:true});
   report.joinerStage='filters-interactive';
   await search.and(page.locator('input:enabled')).waitFor({state:'visible',timeout:timeout()});
   measure('filters-interactive',opened);
   for(const [step,query,state] of [['search-no-matches','Fictional unmatched joiner','hidden'],['clear-search','','visible']]){
    report.joinerStage=step;
    const started=performance.now();
    await search.fill(query,{timeout:timeout()});
    await owned.waitFor({state,timeout:timeout()});
    if(state==='hidden')await results.getByText('No new joiners match your search or filters.',{exact:true})
     .waitFor({state:'visible',timeout:timeout()});
    measure(step,started);
   }
  },timings:result=>result.joinerSteps},
 ];
 try{
  for(const action of actions){
   const user=fixture.users[action.actorIndex],context=await signedInContext(user),result={};
   const row={journey:action.name,role:user.role,status:'incomplete',timings:[]};
   report.journeys.push(row);
   const retain=()=>{
    row.timings=action.timings(result)??[];
    if(result.assistantStartup)row.startup=result.assistantStartup;
    save();
   };
   const actionRequests=new Map();
   const observeRequest=request=>{
    if(request.method()!=='POST')return;
    const url=new URL(request.url());
    if(url.origin!==origin)return;
    const id=request.headers()['next-action'];
    if(registrations.has(id)){
     const page=actionPageFor(url.pathname);
     actionRequests.set(request,{id,page,matchedWorker:registrations.get(id).has(page),started:performance.now()});
    }
   };
   const observeResponse=response=>{
    const activity=actionRequests.get(response.request());
    if(activity){
     activity.status=response.status();
     activity.elapsedMs=Math.round(performance.now()-activity.started);
    }
   };
   try{
    const page=await context.newPage();
    page.on('request',observeRequest);
    page.on('response',observeResponse);
    await action.run({base:origin,user,page,fixture,report:result,save:retain,phase:'baseline',db,evidenceDirectory:fixtureEvidenceDir});
    if(action.name==='saved-report-draft')assert.equal(result.browserSavedReportJourneys?.[0]?.persisted,true);
    row.status='observed';
    const successful=new Set();
    for(const {id,page,status} of actionRequests.values()){
     if(!(status>=200&&status<400))continue;
     successful.add(id);
     const destinations=acceptedByAction.get(id)??new Set();
     destinations.add(page);
     acceptedByAction.set(id,destinations);
    }
    row.serverActionsAccepted=successful.size;
   }catch(error){
    row.failure=error?.name==='TimeoutError'?'timeout':error?.code==='ERR_ASSERTION'?'assertion':'browser';
    const step=result.actionStage??result.groupScopeStage??result.joinerStage??result.attendanceStage??result.orgExplorerJourneys?.[0]?.failure?.stage;
    if(typeof step==='string'&&/^[a-z][a-z-]{0,64}$/.test(step))row.failedStep=step;
   }
   finally{
    row.serverActionResponses=[...actionRequests.values()].map(({page,matchedWorker,status,elapsedMs})=>
     ({page,matchedWorker,status:status??null,elapsedMs:elapsedMs??null}));
    report.serverActionInventory=serverActionCoverage(registrations,acceptedByAction);
    retain();
    await context.close();
   }
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
 if(groupShape){
  const postgres=createRequire(join(process.cwd(),'package.json'))('postgres');
  const owner=postgres(dbEnv.MIGRATION_DATABASE_URL,{max:1});
  try{
   const {counts,company}=await seedBrowserGroupShape(owner,fixture);
   fixture.scaleCompany=company;
   report.fixture.groupShape=counts;
   save();
  }finally{await owner.end({timeout:5});}
 }
 assert(Array.isArray(fixture.users)&&fixture.users.length===500&&Array.isArray(fixture.tenants)
  &&fixture.tenants.length===2,'Fictional fixture inventory incomplete');
 assert.equal(new Set(fixture.joiners).size,2,'Expected two fictional New Joiners');
 report.fixture.joinersSeeded=true;
 report.fixtureVerified=true;
 if(!fixtureOnly){
  if(staticShard===null&&!diagnosticCount)await seedNotificationReads(fixture);
  app=start('application',process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1',
   '--port',String(appPort)],{...dbEnv,NODE_ENV:'production',AIHR_DB_POOL_MAX:'8',AIHR_ASSISTANT_OPEN_PROFILE:'true',AIHR_SHELL_OPEN_PROFILE:'true',AIHR_MOBILE_PREVIEW_READ_TRACE:'true',
    AIHR_PAYROLL_TRANSACTION_READ_TRACE:String(payrollReadTrace)});
  await waitForApp();
  await proxy();
  if(surfaceProbe){
   const requested=surfaceProbe==='both'?Object.keys(focusedSurfaces):[surfaceProbe];
   for(const surface of requested)await measureSurfaceProbe(fixture,surface);
  }
  else if(mobileTaskTrace)await measureMobileTaskTrace(fixture);
  else if(payrollReadTrace)await measurePayrollReadTrace(fixture);
  else if(staticShard!==null)await measureStaticPageCensus(fixture,staticShard);
  else{
   await measureRoutes(fixture);
   await measureShellLinks(fixture);
   await measureActions(fixture);
   await measurePublicLogin();
   const routesObserved=report.observations.length===2*report.plannedRoleRoutes
    &&report.observations.every(row=>row.status==='observed');
   const journeysObserved=report.journeys.length>0&&report.journeys.every(row=>row.status==='observed');
   report.contentObserved=report.observations.filter(row=>row.status==='observed'&&
    ['usable-content','scope-denial'].includes(row.readiness)).length;
   report.complete=routesObserved&&journeysObserved&&report.contentObserved===report.observations.length;
   assert(routesObserved,'Browser baseline had missing or failed visits');
   assert(journeysObserved,'Browser baseline had missing or failed actions');
  }
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
    if(payrollReadTrace){
     const phases=new Set(['scope','employee-options','employee-selection','company-options','catalogue','cycle-options',
      'default-period','history-page','statutory-settings','reprocess-outcomes','recorded-sources','render-ready']);
     const transactions=[];
     for(const [,line] of log.matchAll(/^PERF_PAYROLL_TRANSACTION_READ (.{1,200})$/gm)){
      let row;
      try{row=JSON.parse(line);}catch{continue;}
      if(!row||!Number.isSafeInteger(row.trace)||row.trace<1||!phases.has(row.phase)||
       ![row.startedMs,row.elapsedMs].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=120000))continue;
      transactions.push({trace:row.trace,phase:row.phase,startedMs:row.startedMs,elapsedMs:row.elapsedMs});
      if(transactions.length===160)break;
     }
     report.payrollReadPhases=transactions;
     save();
     const traces=new Set(transactions.filter(row=>row.phase==='render-ready').map(row=>row.trace));
     if(report.observations.length===6&&report.observations.every(row=>row.status==='observed')){
      assert(traces.size>=6,'Expected anonymous Payroll phases for each document render');
     }
    }
    const mobilePhases=new Set(['preview','own-employment','own-person-name','clock','leave','requests',
     'claims','team','tasks','inbox','payslips','tasks-leave','tasks-leave-cancellation','tasks-resignation',
     'tasks-manager-review','tasks-hr-review','tasks-replacement','tasks-attendance','tasks-profile','tasks-claims']);
    const mobile=[];
    for(const [,line] of log.matchAll(/^PERF_MOBILE_PREVIEW_READ (.{1,220})$/gm)){
     let row;
     try{row=JSON.parse(line);}catch{continue;}
     if(!row||!Number.isSafeInteger(row.trace)||row.trace<1||!mobilePhases.has(row.phase)||
      !['started','settled'].includes(row.state)||!Number.isSafeInteger(row.elapsedMs)||row.elapsedMs<0)continue;
     mobile.push({trace:row.trace,phase:row.phase,state:row.state,elapsedMs:row.elapsedMs});
     if(mobile.length>=120)break;
    }
    report.mobilePreviewReadPhases=mobile;

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
    const assistantPhases=new Set(['session','translations','access','scope','retention','importAvailability',
     'legacyList','legacySelected','storedList','storedSelected','title']);
    const assistantOpens=[];
    for(const [,record] of log.matchAll(/^PERF_ASSISTANT_OPEN (.{1,1500})$/gm)){
     let entry;
     try{entry=JSON.parse(record);}catch{continue;}
     if(!entry||!['group-admin','company-admin','employee'].includes(entry.role)
       ||!['new','legacy','stored'].includes(entry.view)
       ||!Number.isSafeInteger(entry.elapsedMs)||entry.elapsedMs<0||entry.elapsedMs>120000)continue;
     const timings=Object.entries(entry.timings??{}).filter(([phase,interval])=>assistantPhases.has(phase)
      &&Array.isArray(interval)&&interval.length===2&&interval.every(Number.isSafeInteger)
      &&0<=interval[0]&&interval[0]<=interval[1]&&interval[1]<=entry.elapsedMs);
     assistantOpens.push({role:entry.role,view:entry.view,elapsedMs:entry.elapsedMs,timings:Object.fromEntries(timings)});
     if(assistantOpens.length===128)break;
    }
    if(assistantOpens.length)report.assistantOpens=assistantOpens;
    const shellRoutes=new Set(['/','/assistant','/admin/personnel','/approvals','/payroll',
     '/payroll/transaction-view','/roster','/attendance','/recruitment']);
    const shellPhases=new Set(['requestPreferences','session','entryAndIdlePolicy','initialNavigation','letters',
     'rewards','lifecycle','moduleNavigation','identityEmailAndPerformance','renderPreparation']);
    const lifecycleOwnerPhases=new Set(['onboardingNavigation','scopedLifecycleNavigation','offboardingPostingAccess']);
    const shellOpens=[];
    for(const [,record] of log.matchAll(/^PERF_SHELL_OPEN (.{1,1000})$/gm)){
     let entry;
     try{entry=JSON.parse(record);}catch{continue;}
     if(!entry||!shellRoutes.has(entry.route)||!['group-admin','company-admin','manager','employee'].includes(entry.role)
       ||!Number.isSafeInteger(entry.elapsedMs)||entry.elapsedMs<0||entry.elapsedMs>120000)continue;
     const timings=Object.entries(entry.timings??{}).filter(([phase,ms])=>
      (shellPhases.has(phase)||lifecycleOwnerPhases.has(phase))
      &&Number.isSafeInteger(ms)&&ms>=0&&ms<=entry.elapsedMs);
     if(timings.filter(([phase])=>shellPhases.has(phase)).length!==shellPhases.size)continue;
     shellOpens.push({route:entry.route,role:entry.role,elapsedMs:entry.elapsedMs,timings:Object.fromEntries(timings)});
     if(shellOpens.length===128)break;
    }
    if(shellOpens.length)report.shellOpens=shellOpens;
    const notificationPhases=new Set(['onboardingNotices','projection','bellRead','lifecycle']);
    const notificationShell=[];
    for(const [,record] of log.matchAll(/^PERF_NOTIFICATION_SHELL (.{1,500})$/gm)){
     let entry;
     try{entry=JSON.parse(record);}catch{continue;}
     if(!entry||typeof entry.catchUp!=='boolean'||!Number.isSafeInteger(entry.elapsedMs)
       ||entry.elapsedMs<0||entry.elapsedMs>120000)continue;
     const timings=Object.entries(entry.timings??{}).filter(([phase,ms])=>notificationPhases.has(phase)
      &&Number.isSafeInteger(ms)&&ms>=0&&ms<=entry.elapsedMs);
     if(timings.length!==(entry.catchUp?4:3))continue;
     notificationShell.push({catchUp:entry.catchUp,elapsedMs:entry.elapsedMs,timings:Object.fromEntries(timings)});
     if(notificationShell.length===256)break;
    }
    if(notificationShell.length)report.notificationShell=notificationShell;
   }
  }finally{
   if(databaseStarted)await run('postgres-cleanup','bash',['../automation/.github/ci/postgres.sh','stop'],pgEnv);
   save();
  }
 }
}
