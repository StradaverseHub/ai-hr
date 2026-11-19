/** Repeatable direct browser entry with the existing fictional system fixture. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {request} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {nativePreflightRoutePlan} from './system-route-manifest.mjs';
import {admittedBuildNodeOptions} from '../../.github/ci/build-heap.mjs';
import {exercisePersonnelSwitcher} from './personnel-switcher-browser.mjs';
import {exercisePayrollBrowser} from './payroll-browser.mjs';
import {exerciseOrgExplorer} from './org-explorer-browser.mjs';
import {exerciseSavedReport} from './reports-browser.mjs';

const origin='https://localhost:3443';
const appPort=3174;
const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_JOB==='linux-build'&&process.platform==='linux');
assert(!Object.keys(env).some(key=>key.startsWith('WORKOS_')&&env[key]),'External auth configuration refused');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');
assert(sha===env.AIHR_CI_HEAD&&/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD??''));
assert.equal(git('status','--porcelain'),'');

const privateDir=mkdtempSync(join(env.RUNNER_TEMP,'route-baseline-private-'));
const evidencePath=join(env.RUNNER_TEMP,'browser-route-baseline.json');
const report={kind:'FICTIONAL_BROWSER_DOCUMENT_BASELINE',sourceSha:sha,controllerSha:env.AIHR_CI_CONTROL_HEAD,
 releaseEligible:false,fixture:{tenants:2,companies:10,users:500},phases:[],observations:[],journeys:[]};
const save=()=>writeFileSync(evidencePath,JSON.stringify(report,null,2),{mode:0o600});
const dbEnv={...env,NODE_ENV:'development',AUTH_PROVIDER:'internal',
 AUTH_SESSION_KEY:randomBytes(32).toString('hex'),AI_CONFIG_SECRET:randomBytes(32).toString('hex'),
 AUTH_PUBLIC_ORIGIN:origin,AUTH_DEFAULT_ORGANIZATION:'perf-a',ALLOW_DEMO_SESSION:'false',SHARE_PASSWORD:'',DEV_USER_ID:'',
 AIHR_PERFORMANCE_ROLE_FIXTURE:'true',AIHR_FOCUSED_SUITE_CAPACITY:'true',TEST_DB_NAMESPACE:'aifocus',
 AUDIT_HASH_CHAIN_ENABLED:'true',PERF_HTTP_SUITE:'workflow-preflight',PERF_ATTENDANCE_DAYS:'180',
 PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:privateDir,AIHR_FOCUSED_EVIDENCE_DIR:privateDir,
 DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',
 MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',
 TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',
 TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',NEXT_TELEMETRY_DISABLED:'1'};
const buildEnv={...dbEnv,NODE_ENV:'production',NODE_OPTIONS:admittedBuildNodeOptions(env)};
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])buildEnv[key]=env[key];
const pgEnv={...env,AIHR_CI_UNIT:'db-1'};

function start(label,command,args,childEnv) {
 const fd=openSync(join(privateDir,label+'.log'),'wx',0o600);
 try{return spawn(command,args,{env:childEnv,stdio:['ignore',fd,fd]});}
 finally{closeSync(fd);}
}
async function run(label,command,args,childEnv,limit=180000) {
 const started=performance.now(),child=start(label,command,args,childEnv);
 const timer=setTimeout(()=>child.kill('SIGKILL'),limit);
 try{
  const [code,signal]=await once(child,'close');
  report.phases.push({label,code,signal,elapsedMs:Math.round(performance.now()-started)});
  save();
  assert(code===0&&signal===null,`${label} failed`);
 }finally{clearTimeout(timer);}
}
const step=(label,script,limit)=>run(label,process.execPath,['--import','tsx',script],dbEnv,limit);

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
async function signedInContext(actor){
 assert(typeof actor?.token==='string'&&actor.token.length>0,'Expected a fictional fixture session');
 const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});
 try{
  await context.addCookies([{name:'__Host-aihr_internal',value:actor.token,url:origin,secure:true,httpOnly:true}]);
  return context;
 }catch(error){await context.close();throw error;}
}
async function visit(page,actor,route,pass) {
 const observation={role:route.role,route:route.requested,pass,status:'failed'};
 const started=performance.now(),deadline=started+15000;
 const timeout=()=>Math.max(1,Math.floor(deadline-performance.now()));
 try{
  const response=await page.goto(origin+route.requested,{waitUntil:'domcontentloaded',timeout:timeout()});
  assert(response?.status()===200&&page.url()===origin+route.final,'Unexpected rendered route');
  const main=page.locator('main:visible').first();
  await main.getByRole('heading',{level:1}).first().waitFor({state:'visible',timeout:timeout()});
  await page.locator('button[data-tour="account"]').getByText(actor.name,{exact:true}).first().waitFor({state:'visible',timeout:timeout()});
  observation.readiness='heading';
  if(route.requested===payrollHistoryPath){
   await main.locator('tbody button[data-table-disclosure]:visible').first().waitFor({state:'visible',timeout:timeout()});
   observation.readiness='usable-content';
  }else if(['/claims','/admin/personnel','/payroll'].includes(route.requested)){
   await main.locator('tbody tr:visible').first().waitFor({state:'visible',timeout:timeout()});
   observation.readiness='usable-content';
  }
  assert.equal(await main.locator('[data-personnel-busy], [data-page-busy], [data-read-unavailable]').count(),0);
  observation.status='observed';
 }catch(error){observation.failure=error?.name==='TimeoutError'?'timeout':error?.code==='ERR_ASSERTION'?'assertion':'browser';}
 finally{
  observation.elapsedMs=Math.round(performance.now()-started);
  report.observations.push(observation);save();
 }
}
async function measureRoutes(fixture){
 const plan=[...nativePreflightRoutePlan()];
 for(const [role,actorIndex] of [['companyHR',1],['groupHR',0]]){
  plan.push({role,actorIndex,requested:payrollHistoryPath,final:payrollHistoryPath});
 }
 report.plannedRoleRoutes=plan.length;
 const require=createRequire(join(process.cwd(),'package.json'));
 const {chromium}=require('playwright');
 browser=await chromium.launch();
 const lanes=await Promise.allSettled([...new Set(plan.map(route=>route.actorIndex))].map(async actorIndex=>{
  const actor=fixture.users[actorIndex],routes=plan.filter(route=>route.actorIndex===actorIndex);
  assert(actor&&routes.every(route=>route.role===actor.role),'Fixture role differs from the route inventory');
  const context=await signedInContext(actor);
  try{
   const page=await context.newPage();
   for(const pass of ['first','repeat'])for(const route of routes)await visit(page,actor,route,pass);
  }finally{await context.close();}
 }));
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
 ];
 try{
  for(const action of actions){
   const user=fixture.users[action.actorIndex],context=await signedInContext(user),result={};
   const row={journey:action.name,role:user.role,status:'incomplete',timings:[]};
   report.journeys.push(row);
   const retain=()=>{row.timings=action.timings(result)??[];save();};
   try{
    const page=await context.newPage();
    await action.run({base:origin,user,page,fixture,report:result,save:retain,phase:'baseline',db});
    if(action.name==='saved-report-draft')assert.equal(result.browserSavedReportJourneys?.[0]?.persisted,true);
    row.status='observed';
   }catch(error){row.failure=error?.name==='TimeoutError'?'timeout':error?.code==='ERR_ASSERTION'?'assertion':'browser';}
   finally{retain();await context.close();}
  }
 }finally{await db.end({timeout:5});}
}

save();
try{
 await run('production-build',process.execPath,['../automation/.github/ci/build-heap.mjs','measure',
  join(privateDir,'next-build-memory'),'--','pnpm','build'],buildEnv,900000);
 report.buildId=readFileSync('.next/BUILD_ID','utf8').trim();
 assert(report.buildId,'Missing measured application build');
 databaseStarted=true;
 await run('postgres-setup','bash',['../automation/.github/ci/postgres.sh','reset'],pgEnv);
 await run('migrate-fictional-database','pnpm',['db:migrate'],dbEnv,300000);
 await step('verify-organisation-admission','scripts/provision-organisation-admission.ts');
 await step('seed-catalogues','scripts/seed-catalogs.ts');
 await run('seed-system-fixture',process.execPath,['--conditions=react-server','--import','tsx',
  'scripts/performance/system-fixture.mjs'],dbEnv,600000);
 const fixture=JSON.parse(readFileSync(join(privateDir,'fixture.json'),'utf8'));
 assert(fixture.users.length===500&&fixture.tenants.length===2,'Fictional fixture inventory incomplete');
 app=start('application',process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1',
  '--port',String(appPort)],{...dbEnv,NODE_ENV:'production',AIHR_DB_POOL_MAX:'8'});
 await waitForApp();
 await proxy();
 await measureRoutes(fixture);
 await measureActions(fixture);
 const routesObserved=report.observations.length===2*report.plannedRoleRoutes
  &&report.observations.every(row=>row.status==='observed');
 const journeysObserved=report.journeys.length>0&&report.journeys.every(row=>row.status==='observed');
 report.complete=routesObserved&&journeysObserved;
 assert(routesObserved,'Browser baseline had missing or failed visits');
 assert(journeysObserved,'Browser baseline had missing or failed actions');
}finally{
 try{await browser?.close();}
 finally{
  try{
   if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
   await stopApp();
  }finally{
   if(databaseStarted)await run('postgres-cleanup','bash',['../automation/.github/ci/postgres.sh','stop'],pgEnv);
   save();
  }
 }
}
