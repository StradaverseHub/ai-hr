/** SOURCE PROPOSAL. Fictional development smoke, never a release gate or authentication proof.
 * Import-safe pure contracts are tested separately; main alone owns disposable resources. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
export const MODULES=Object.freeze(['employees','org','leave','ess','approvals','knowledge_base','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing']);
const HUMAN_ENTRY=Object.freeze({employees:'/admin/personnel/import',org:'/assistant/org',leave:'/assistant/leave',ess:'/assistant/profile',approvals:'/assistant/approvals',knowledge_base:'/assistant/knowledge-base',payroll:'/assistant/payroll-close',attendance:'/assistant/attendance',claims:'/assistant/claims',performance:'/assistant/performance',rewards:'/assistant/rewards',lifecycle:'/assistant/lifecycle',toil:'/assistant/toil',multi_cycle_payroll:'/assistant/payroll-runs',typed_pay_components:'/assistant/pay-codes','country-my':'/assistant/statutory',notifications:'/assistant/notifications',system_testing:'/assistant/testing'});
export const REMAINING=Object.freeze(['explicit human prepare/review/confirm and exact native receipts for each action','expiry/discard/uncertain-response replay and erasure','cross-person/company/tenant denial and revocation interleavings','governed independent evaluation/promotion/rollback and actual provider capability/cost/latency','real messy employee import correction/commit and measured baseline comparison','internal HTTPS login/MFA and actual verified notification identity/consent','locale switch interaction/accessibility and full desktop/mobile action journeys','combined exact-candidate final gate and deployment arrival']);
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function unitFor(run,attempt,sha){assert(/^\d+$/.test(run)&&/^\d+$/.test(attempt)&&/^[0-9a-f]{40}$/.test(sha));return 'db-'+createHash('sha256').update([run,attempt,sha,'assistant-development-v1'].join(':')).digest('hex').slice(0,16);}
export function childEnvironment(input,add={}){
 const env={};for(const key of ['PATH','HOME','TMPDIR','LANG','RUNNER_TEMP','CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])if(input[key])env[key]=input[key];
 return {...env,TZ:'Asia/Kuala_Lumpur',NEXT_TELEMETRY_DISABLED:'1',...add};
}
export function validateFixture(f){
 assert.equal(f?.format,1);assert.equal(f.state,'native_prerequisites_prepared_not_experienced');
 const actors=[f.actors?.operator,f.actors?.self,...(f.actors?.reviewers??[]),f.actors?.peer,f.actors?.manager];assert.equal(actors.length,6);
 for(const a of actors)assert(UUID.test(a?.userId)&&UUID.test(a?.personId)&&UUID.test(a?.employmentId));assert.equal(new Set(actors.map(a=>a.userId)).size,6);
 assert.equal(f.finalNativePrerequisites?.length,3);
 assert.deepEqual(f.finalNativePrerequisites.map(x=>x.userId).sort(),[actors[0].userId,actors[2].userId,actors[3].userId].sort());
 for(const proof of f.finalNativePrerequisites){assert.deepEqual(proof.modules.map(x=>x.module).sort(),[...MODULES].sort());for(const m of proof.modules){assert.equal(m.state,'complete');assert.equal(m.nativeEvidence,'present');assert.equal(m.qualityFailures,0);assert.equal(m.securityFailures,0);assert(m.cases?.length&&m.cases.every(c=>c.passed===true));assert(m.cases.some(c=>c.id===m.module+':nonempty-business-evidence'&&c.category==='native'));}}
 assert.equal(f.expectedNative?.selfLeaveRequests,0);assert.equal(f.expectedNative?.selfProfileRequests,0);assert.equal(f.expectedNative?.closeTargetStatus,'processed');
 assert.equal(f.limits?.uiTargetEffects,'not_executed');assert.equal(f.limits?.providerCapability,'UNVERIFIED_NO_CALLS');assert.equal(f.limits?.notificationEmailConsent,'UNAVAILABLE_REQUIRES_ACTUAL_VERIFIED_PROVIDER_IDENTITY');
 assert.equal(f.limits?.releaseGate,'NOT_RUN');return f;
}
export function publicReport(sha){return {format:1,candidate:sha,kind:'assistant_development_browser_smoke',state:'incomplete',experienceComplete:false,releaseEligible:false,authentication:'gated_demo_switcher_not_production_identity',provider:'not_configured_no_calls',notificationIdentity:'excluded_requires_separate_internal_HTTPS',remaining:[...REMAINING],checks:[],errorCounts:{page:0,console:0,server:0,external:0},failure:null};}
/** Unknown/malformed snapshots cannot establish cleanup. Only the observed inspector is excluded. */
export function parseOwnedGroupSnapshot(text,inspectorPid,group){
 assert(Number.isSafeInteger(inspectorPid)&&inspectorPid>1&&Number.isSafeInteger(group)&&group>1);assert(typeof text==='string'&&text.trim());
 const result=[];for(const line of text.trim().split('\n')){const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);assert(match,'Unknown process snapshot');const [pid,pgid,sid]=match.slice(1).map(Number);assert([pid,pgid,sid].every(n=>Number.isSafeInteger(n)&&n>0));if(pgid===group&&pid!==inspectorPid){assert.equal(sid,group,'Owned group identity changed');result.push(pid);}}return result;
}
const here=dirname(fileURLToPath(import.meta.url));
async function main(){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(process.versions.node.split('.')[0],'20');
 const root=process.cwd(),sha=process.env.AIHR_CI_HEAD,control=process.env.AIHR_CI_CONTROL_HEAD;assert(/^[0-9a-f]{40}$/.test(sha??''));assert(/^[0-9a-f]{40}$/.test(control??''));
 const out=resolve(process.argv[2]??'');assert(out.startsWith(resolve(process.env.RUNNER_TEMP)+'/'));assert(!existsSync(out),'Evidence path must be new');mkdirSync(join(out,'private'),{recursive:true,mode:0o700});mkdirSync(join(out,'public'),{mode:0o700});
 const report=publicReport(sha),privateDir=join(out,'private'),children=new Set();let browser,browserServer,postgresOwned=false,failed=false;
 const unit=unitFor(process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT,sha),container=`aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${unit}`,database='aihr_assistant_browser_'+unit.slice(3),base='http://127.0.0.1:3177';
 const gate=randomBytes(32).toString('hex'),encryption=randomBytes(32).toString('hex');
 const basic=childEnvironment(process.env,{AIHR_CI_UNIT:unit,AIHR_CI_PG_MEMORY_GIB:'2'});
 const ownerUrl=`postgres://postgres@127.0.0.1:5433/${database}`,appUrl=`postgres://ai_hr_app@127.0.0.1:5433/${database}`;
 const appEnv={...basic,NODE_ENV:'production',DATABASE_URL:appUrl,AUTH_PROVIDER:'workos',NEXT_PUBLIC_APP_URL:base,PORT:'3177',ALLOW_DEMO_SESSION:'true',SHARE_PASSWORD:gate,AI_CONFIG_SECRET:encryption,TEST_DB_NAMESPACE:'assistant_browser_'+unit.slice(3)};
 const fixtureEnv={...appEnv,MIGRATION_DATABASE_URL:ownerUrl};
 const sync=(cmd,args,env=basic)=>{const r=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert(!r.error&&r.status===0,'Controller command refused');return r.stdout.trim();};
 function members(child){
  const inspection=spawnSync('ps',['-eo','pid=,pgid=,sid='],{env:basic,encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});
  assert(!inspection.error&&inspection.status===0,'Process inspection unavailable');
  return parseOwnedGroupSnapshot(inspection.stdout,inspection.pid,child.pid);
 }
 async function stop(child){
  for(const signal of ['SIGTERM','SIGKILL']){if(!members(child).length){children.delete(child);return;}process.kill(-child.pid,signal);for(let n=0;n<100;n++){await delay(100);if(!members(child).length){children.delete(child);return;}}}
  throw Error('Owned process group termination unconfirmed');
 }
 async function command(label,cmd,args,env,timeout=900000,background=false){
  const fd=openSync(join(privateDir,label+'.log'),'wx',0o600),child=spawn(cmd,args,{cwd:root,env,detached:true,stdio:['ignore',fd,fd]});closeSync(fd);children.add(child);
  const done=new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',(code,signal)=>{code===0?ok():bad(Error('Child command failed'));});});
  if(background){done.catch(()=>{});return child;}let timer;try{await Promise.race([done,new Promise((_,bad)=>{timer=setTimeout(()=>bad(Error('Child timeout')),timeout);}),new Promise((_,bad)=>{if(abort.signal.aborted)bad(Error('Interrupted'));else abort.signal.addEventListener('abort',()=>bad(Error('Interrupted')),{once:true});})]);}finally{clearTimeout(timer);if(children.has(child))await stop(child);}
 }
 const abort=new AbortController();let interrupted=false;const signal=()=>{interrupted=true;abort.abort();};const deadline=setTimeout(signal,50*60*1000);process.on('SIGTERM',signal);process.on('SIGINT',signal);
 try{
  assert.equal(sync('git',['rev-parse','HEAD']),sha);assert.equal(sync('git',['status','--porcelain','--untracked-files=all']),'');
  assert.equal(sync('git',['-C',resolve(here,'../..'),'rev-parse','HEAD']),control);
  // setup-alpha creates exactly this example copy; refuse any other private environment files.
  if(existsSync(join(root,'.env.local'))){assert.equal(readFileSync(join(root,'.env.local'),'utf8'),readFileSync(join(root,'.env.example'),'utf8'));unlinkSync(join(root,'.env.local'));}
  assert.deepEqual(readdirSync(root).filter(x=>/^\.env(?:\.|$)/.test(x)&&x!=='.env.example'),[]);
  assert(existsSync(join(root,'scripts/fixtures/ai-delivery-full-fixture.ts')),'Full native fixture owner absent; no legacy fallback');
  const inspect=spawnSync('docker',['container','inspect',container],{env:basic,encoding:'utf8'});assert.equal(inspect.status,1);assert(/No such (object|container)/i.test(inspect.stderr),'Unknown docker inspection is not absence');
  writeFileSync(join(privateDir,'owned-unit'),unit,{mode:0o600});postgresOwned=true;
  await command('postgres', 'bash',[join(here,'postgres.sh'),'reset'],basic,120000);
  sync('docker',['exec',container,'psql','-U','postgres','-p','5433','-v','ON_ERROR_STOP=1','-d','postgres','-c',`CREATE DATABASE ${database};`]);
  await command('migration','pnpm',['db:migrate'],fixtureEnv);
  const require=createRequire(join(root,'package.json')),tsx=pathToFileURL(require.resolve('tsx')).href;
  const fixturePath=join(privateDir,'fixture.json'),bootstrap=join(privateDir,'prepare.ts');
  writeFileSync(bootstrap,`import {writeFileSync} from 'node:fs';\nimport {createDb,client} from ${JSON.stringify(join(root,'db/client.ts'))};\nimport {MODULE_AGENT_ACTIONS} from ${JSON.stringify(join(root,'lib/ai/module-agent-actions.ts'))};\nimport {populateAiDeliveryFullFixture} from ${JSON.stringify(join(root,'scripts/fixtures/ai-delivery-full-fixture.ts'))};\nasync function prepare(){const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:1});try{for(const [pool,role,superuser] of [[owner.client,'postgres',true],[client,'ai_hr_app',false]] as const){const [p]=await pool.unsafe("select current_user as role,current_database() as db,inet_server_port() as port,host(inet_server_addr()) as address,rolsuper or rolbypassrls as privileged from pg_roles where rolname=current_user");if(p.role!==role||p.db!==${JSON.stringify(database)}||p.port!==5433||!['127.0.0.1','::1'].includes(p.address)||p.privileged!==superuser)throw Error('Physical fixture ownership refused');}const before=await owner.client.unsafe('select count(*)::int n from public.ai_provider_config');if(before[0].n!==0)throw Error('Provider configuration forbidden');const fixture=await populateAiDeliveryFullFixture(owner);const after=await owner.client.unsafe('select count(*)::int n from public.ai_provider_config');if(after[0].n!==0)throw Error('Provider configuration forbidden');writeFileSync(${JSON.stringify(fixturePath)},JSON.stringify({fixture,declarations:Object.values(MODULE_AGENT_ACTIONS).map(d=>({module:d.module,coverage:d.coverage,actions:d.actions.map(a=>({id:a.id,prepare:a.prepare.status,confirm:a.confirm.status}))}))}),{mode:0o600});}finally{await owner.client.end();await client.end();}}prepare().catch(()=>{process.exitCode=1;});\n`,{mode:0o600});
  await command('fixture',process.execPath,['--import',tsx,bootstrap],{...fixtureEnv,TSX_TSCONFIG_PATH:join(root,'tsconfig.json')},1200000);
  const packet=JSON.parse(readFileSync(fixturePath,'utf8')),fixture=validateFixture(packet.fixture);
  assert.deepEqual(packet.declarations.map(d=>d.module).sort(),[...MODULES].sort());
  for(const d of packet.declarations){assert(['partial_actions','read_only','orchestration_only'].includes(d.coverage),'Unknown declaration coverage');for(const a of d.actions){assert(typeof a.id==='string'&&a.id.length<100);assert(['implemented','read_context_only','human_workflow_only','pending_adapter','unavailable'].includes(a.prepare));assert(['implemented','read_context_only','human_workflow_only','pending_adapter','unavailable'].includes(a.confirm));}}
  report.declaredAvailability=packet.declarations;
  await command('production-build','pnpm',['build'],{...appEnv,DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',NODE_OPTIONS:'--max-old-space-size=6144'});
  const server=await command('production-app',process.execPath,[require.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3177'],appEnv,0,true);
  const auth='Basic '+Buffer.from('ci:'+gate).toString('base64');let ready=false;
  for(let n=0;n<120;n++){assert(!interrupted);assert(server.exitCode===null&&server.signalCode===null,'App exited');try{const r=await fetch(base+'/login',{headers:{authorization:auth},signal:AbortSignal.timeout(2000)});if(r.status===200){ready=true;break;}}catch{}await delay(1000);}assert(ready,'App unavailable');assert.equal((await fetch(base+'/',{redirect:'manual'})).status,401);
  browserServer=await require('playwright').chromium.launchServer({headless:true});children.add(browserServer.process());browser=await require('playwright').chromium.connect(browserServer.wsEndpoint());
  const roles=[['operator',fixture.actors.operator,true],['reviewer1',fixture.actors.reviewers[0],true],['reviewer2',fixture.actors.reviewers[1],true],['self',fixture.actors.self,false],['peer',fixture.actors.peer,false],['manager',fixture.actors.manager,false],['standalone_tester',fixture.platform.testing.standalone,false],['prehire',fixture.platform.prehire,false]];
  for(const [role,actor,all] of roles){
   assert(UUID.test(actor?.userId));const context=await browser.newContext({httpCredentials:{username:'ci',password:gate}});const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(20000);
   page.on('pageerror',()=>report.errorCounts.page++);page.on('console',m=>{if(m.type()==='error')report.errorCounts.console++;});page.on('response',r=>{if(r.status()>=500)report.errorCounts.server++;});
   await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===base||['data:','blob:','about:'].includes(url.protocol))return route.continue();report.errorCounts.external++;return route.abort();});
   try{
    await page.goto(base+'/login');await page.locator(`form[action="/login/as"]:has(input[name="userId"][value="${actor.userId}"]) button[type="submit"]`).click();await page.waitForURL(u=>!['/login','/login/as'].includes(u.pathname));
    for(const locale of ['en','ms','zh','ta','th','vi'])for(const viewport of [{width:1440,height:1000},{width:375,height:812}]){
     assert(!interrupted);await context.addCookies([{name:'NEXT_LOCALE',value:locale,url:base}]);await page.setViewportSize(viewport);await page.goto(base+'/assistant');assert.equal(new URL(page.url()).pathname,'/assistant');await page.locator('[data-tour="intelligence-assistant"]').waitFor();
     const available=await page.locator('a[href^="/assistant?job="]').evaluateAll(nodes=>[...new Set(nodes.map(n=>new URL(n.href).searchParams.get('job')))]);assert(available.every(m=>MODULES.includes(m)));if(all)assert.deepEqual([...available].sort(),[...MODULES].sort());
     report.checks.push({role,locale,viewport:viewport.width,workspace:'rendered',available});
     // Full20 across all current native reviewer contexts on EN desktop; locale/mobile smoke
     // repeats workspace plus own-leave entry, not an invented full translated action journey.
     if(all&&locale==='en'&&viewport.width===1440)for(const module of MODULES){await page.locator(`a[href="/assistant?job=${module}"]`).first().click();assert.equal(new URL(page.url()).searchParams.get('job'),module);await page.locator(`a[href="/assistant?job=${module}"][aria-current="page"]`).waitFor();assert(await page.locator('[data-ui-card]').count()>0);if(HUMAN_ENTRY[module])assert(await page.locator(`a[href="${HUMAN_ENTRY[module]}"]`).count()>0,'Declared human entry missing');assert(!/SQLSTATE|PostgresError|ECONNREFUSED|Unhandled Runtime Error|stack trace|AI_CONFIG_SECRET|MIGRATION_DATABASE_URL|postgres:\/\//i.test(await page.locator('body').innerText()));report.checks.push({role,locale,viewport:viewport.width,module,navigation:'rendered'});}
     if(role==='self'){await page.goto(base+'/assistant/leave');assert.equal(new URL(page.url()).pathname,'/assistant/leave');await page.locator('select[id$="-employment"]').waitFor();assert(await page.locator('select[id$="-employment"] option').count()>1);assert(await page.locator('input[type="date"]').count()===1);assert(await page.locator('textarea[id$="-reason"]').count()===1);report.checks.push({role,locale,viewport:viewport.width,ownLeaveEntry:'human_inputs_rendered_not_prepared'});}
     const body=await page.locator('body').innerText();assert(!/SQLSTATE|PostgresError|ECONNREFUSED|Unhandled Runtime Error|stack trace|AI_CONFIG_SECRET|MIGRATION_DATABASE_URL|postgres:\/\//i.test(body));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');
    }
   }finally{await context.close();}
  }
  assert(Object.values(report.errorCounts).every(n=>n===0),'Browser errors or unexpected external requests');report.state='smoke_passed_incomplete_experience';
 }catch{failed=true;report.state='failed';report.failure=interrupted?'interrupted':'bounded_controller_or_browser_failure';}
 finally{
  if(browser)try{await Promise.race([browser.close(),delay(10000).then(()=>{throw Error('Browser cleanup timeout');})]);}catch{failed=true;report.failure='browser_cleanup_failure';}
  if(browserServer)try{await Promise.race([browserServer.close(),delay(10000).then(()=>{throw Error('Browser server cleanup timeout');})]);}catch{failed=true;report.failure='browser_cleanup_failure';}
  let groupsGone=true;for(const child of [...children])try{await stop(child);}catch{groupsGone=false;failed=true;report.failure='owned_process_cleanup_unconfirmed';}
  if(groupsGone)writeFileSync(join(privateDir,'cleanup-safe'),'all owned process groups confirmed absent',{mode:0o600});
  if(postgresOwned&&groupsGone)try{await command('postgres-cleanup','bash',[join(here,'postgres.sh'),'stop'],basic,120000);}catch{failed=true;report.failure='owned_database_cleanup_unconfirmed';}
  clearTimeout(deadline);process.off('SIGTERM',signal);process.off('SIGINT',signal);if(failed)report.state='failed';writeFileSync(join(out,'public/report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 }
 if(failed)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Assistant development browser controller refused before startup.');process.exitCode=1;});
