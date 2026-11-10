import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {configureNativeProfile,sqlFamily} from './profile-probe.mjs';

const root=process.cwd(),env=process.env,base='https://localhost:3443';
const expected='f9dfb7b9ea844e3938945981a4bf736c351ae980';
const appDb='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev';
const ownerDb='postgres://postgres@127.0.0.1:5433/ai_hr_dev';
const dependency=createRequire(join(root,'package.json'));
const source=(path)=>import(pathToFileURL(join(root,path)).href);
const fixture=join(env.PERF_PRIVATE_DIR,'personnel-import-rehearsal.json');
const log=(data)=>console.log(JSON.stringify(data));
const seal=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const invalid=/Personnel\s+Busy|page\s+(?:is\s+)?busy|Application error|Something went wrong|Request timed out/i;
const fileName='fictional-everything-500.csv';
const importDeadlineMs=420000, pageBudgetMs=5000, loginBudgetMs=10000, clockBudgetMs=10000;
const round=(value)=>Math.round(value);
assert(env.GITHUB_ACTIONS==='true' && env.RUNNER_ENVIRONMENT==='github-hosted' && env.AIHR_CI_HEAD===expected);
assert(env.AUTH_PROVIDER==='internal' && env.ALLOW_DEMO_SESSION==='false' && env.AUTH_PUBLIC_ORIGIN===base);
assert(env.DATABASE_URL===appDb && env.MIGRATION_DATABASE_URL===ownerDb && env.AUDIT_HASH_CHAIN_ENABLED==='true');
assert(realpathSync(env.PERF_PRIVATE_DIR)===env.PERF_PRIVATE_DIR && lstatSync(env.PERF_PRIVATE_DIR).uid===process.getuid());

function makeFile(day){
 assert(/^\d{4}-\d{2}-\d{2}$/.test(day));
 const rows=Array.from({length:500},(_,i)=>{
  const index=String(i+1).padStart(4,'0');
  return `Fictional Import ${index},rehearsal-import-${index}@example.invalid,Finance,${day},full_time,REHEARSAL-NEW-${index},2500`;
 });
 return Buffer.from('full_name,email,department,hired_on,employment_type,employee_code,basic_salary\n'+rows.join('\n')+'\n');
}
async function seed(){
 assert(env.TEST_DATABASE_URL===appDb && env.TEST_MIGRATION_DATABASE_URL===ownerDb);
 const {seedBase,entitledCtx,owner,closeAll,setModule}=await source('test/harness.ts');
 env.AUDIT_HASH_CHAIN_ENABLED='true';
 const schema=await source('db/schema.ts');
 const {hireEmployee}=await source('core/org.ts');
 const {passwordHash,digest}=await source('lib/internal-auth/crypto.ts');
 const {writeRecord}=await source('lib/internal-auth/record-store.ts');
 const {internalIssuer}=await source('lib/internal-auth/config.ts');
 const {todayInKualaLumpur}=await source('lib/hr-date.ts');
 const {generateSecret}=dependency('otplib');
 const day=todayInKualaLumpur(),password='Fictional-'+randomBytes(20).toString('hex');
 const hash=await passwordHash(password),roles=['importer','hr','employee','cold','cold-baseline','clock'];
 const actors={};
 try{
  const [fresh]=await owner.client`select count(*)::int as rows from public.employment`;
  assert.equal(fresh.rows,0);
  const tenant=await seedBase(),ctx=await entitledCtx(tenant),organization='perf-a';
  await setModule(tenant.tenantId,'attendance','active');
  const org={code:organization,tenantId:tenant.tenantId,name:'Fictional Import Rehearsal'};
  await writeRecord(owner.client,'org:'+organization,org,null);
  await writeRecord(owner.client,'tenant:'+tenant.tenantId,org,null);
  const hiredOn='2025-01-01',onboardedAt=new Date(hiredOn+'T00:00:00+08:00');
  for(let i=0;i<3000;i++){
   const index=String(i+1).padStart(4,'0');
   const name=`Fictional Baseline ${index}`,email=`rehearsal-baseline-${index}@example.invalid`;
   const hired=await hireEmployee(ctx,{person:{fullName:name,primaryEmail:email},companyId:tenant.companyId,departmentId:tenant.deptA,
    employmentType:'full_time',hiredOn,employeeCode:`REHEARSAL-BASE-${index}`});
   if(i>=roles.length)continue;
   const role=roles[i],userId=randomUUID(),subject=randomUUID(),issuer=internalIssuer(tenant.tenantId),secret=generateSecret();
   const username='rehearsal-'+role;
   await owner.db.insert(schema.appUser).values({id:userId,tenantId:tenant.tenantId,personId:hired.personId,workosUserId:'rehearsal_'+userId,onboardedAt});
   const grants=[{tenantId:tenant.tenantId,appUserId:userId,companyId:tenant.companyId,role:'employee'}];
   if(role==='importer'||role==='hr')grants.push({tenantId:tenant.tenantId,appUserId:userId,companyId:tenant.companyId,role:'hr_admin'});
   await owner.db.insert(schema.roleAssignment).values(grants);
   await owner.client`insert into app_external_identity(issuer,subject,app_user_id)values(${issuer},${subject},${userId}::uuid)`;
   await owner.client.begin(async tx=>{
    await writeRecord(tx,'credential:'+subject,{subject,version:randomUUID(),tenantId:tenant.tenantId,issuer,organization,username,email,
     emailVerified:true,enabled:true,password:hash,mustChange:false,totpSecret:secret,lastStep:-1,recoveryHashes:[]},subject);
    await writeRecord(tx,'login:'+digest(organization+'\0'+username),{subject},subject);
   });
   actors[role]={name,username,password,secret,userId,employmentId:hired.employmentId};
  }
  // One true other-tenant employment protects against an unscoped result count.
  const foreign=await seedBase(),other=await entitledCtx(foreign);
  await hireEmployee(other,{person:{fullName:'Fictional Foreign Control',primaryEmail:'rehearsal-foreign@example.invalid'},companyId:foreign.companyId,
   departmentId:foreign.deptA,employmentType:'full_time',hiredOn,employeeCode:'REHEARSAL-FOREIGN'});
  await configureNativeProfile(owner.client);
  writeFileSync(fixture,JSON.stringify({organization,tenant:tenant.tenantId,company:tenant.companyId,foreign:foreign.tenantId,actors,day}),{flag:'wx',mode:0o600});
  log({kind:'personnel-import-fixture-seeded',source:expected,fictional:true,employees:3000,foreignControls:1,realAppPrincipals:roles.length});
 }finally{await closeAll();}
}

async function measure(){
 const st=lstatSync(fixture);
 assert(st.isFile()&&st.uid===process.getuid()&&(st.mode&0o777)===0o600&&st.nlink===1&&st.size<16384);
 const f=JSON.parse(readFileSync(fixture,'utf8'));
 assert(env.PERF_APP_WORKERS==='1' && /^[1-9][0-9]*$/.test(env.PERF_APP_PIDS));
 const {chromium}=dependency('playwright'),{generate}=dependency('otplib'),pg=dependency('postgres');
 const owner=pg(ownerDb,{max:1,connect_timeout:5,connection:{default_transaction_read_only:'on',statement_timeout:'1500'}});
 const role=pg(appDb,{max:1,connect_timeout:5,connection:{default_transaction_read_only:'on',statement_timeout:'1500'}});
 const report={kind:'personnel-import-populated-profile',source:expected,controller:env.AIHR_CI_CONTROL_HEAD,run:Number(env.GITHUB_RUN_ID),fictional:true,
  qualification:'one-worker same-pool hosted diagnostic',releaseEligible:false,preview:null,commit:null,baseline:{},overlap:{},locks:null,failures:[],
  limits:{importDeadlineMs,pageBudgetMs,loginBudgetMs,clockBudgetMs}};
 const failure=(stage)=>{if(report.failures.length<128)report.failures.push(stage);};
 let browser,stop=false,sampler,preparation,pending=[],phase='fixture-binding';
 let beforePreviewSql,beforeCommitSql;
 const epoch=t=>Math.round(performance.timeOrigin+t);
 const contexts=[];
 const busy='main[data-personnel-busy],main[data-page-busy],main [data-personnel-busy],main [data-page-busy]';
 async function newPage(){
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US',permissions:['geolocation'],geolocation:{latitude:3.139,longitude:101.6869,accuracy:10}});contexts.push(context);
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort('blockedbyclient'));
  await context.addCookies([{name:'NEXT_LOCALE',value:'en',url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(10000);
  await page.addInitScript(selector=>{
   globalThis.__personnelRehearsalBusy=false;
   new MutationObserver(()=>{if(document.querySelector(selector))globalThis.__personnelRehearsalBusy=true;})
    .observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['data-personnel-busy','data-page-busy']});
  },busy);
  page.on('pageerror',()=>failure('page-error'));page.on('crash',()=>failure('page-crash'));
  page.on('response',response=>{if(new URL(response.url()).origin===base&&response.status()>=500)failure('http-5xx');});
  return page;
 }
 async function home(page){
  await page.locator('main [data-home-card],main [data-dashboard-card]').first().waitFor({state:'visible'});
  await page.locator('main [data-today-section]').first().waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0);
 }
 async function ready(page){
  assert.equal(await page.evaluate(()=>globalThis.__personnelRehearsalBusy),false);
  assert.equal(await page.locator(busy).count(),0);
  assert.equal(await page.locator('main [role="alert"],main [data-read-unavailable],main [data-today-unavailable]').count(),0);
  assert(!invalid.test(await page.locator('main').innerText()));
 }
 async function login(page,actor,onMfa){
  const t=performance.now();
  const response=await page.goto(base+'/login?returnTo=%2F',{waitUntil:'domcontentloaded',timeout:10000});
  assert.equal(response?.status(),200);
  const username=page.locator('input[name="username"]');
  if(!await username.isVisible()){
   const organization=page.locator('input[name="organization"]:visible');await organization.fill(f.organization);
   await page.locator('form').filter({has:organization}).locator('button[type="submit"]').click();
  }
  await username.fill(actor.username);
  const password=page.locator('input[name="password"]');await password.fill(actor.password);
  await page.locator('form').filter({has:password}).locator('button[type="submit"]').click();
  const code=page.locator('input[name="code"]');await code.waitFor({state:'visible'});
  await code.fill(await generate({strategy:'totp',secret:actor.secret}));
  const isMfa=request=>request.method()==='POST'&&request.url()===base+'/login/api/mfa';
  const seeMfa=request=>{if(isMfa(request))onMfa?.(performance.now());};
  page.on('request',seeMfa);
  try{
   const [mfa]=await Promise.all([page.waitForResponse(response=>isMfa(response.request()),{timeout:10000}),
    page.locator('form').filter({has:code}).locator('button[type="submit"]').click()]);
   assert(mfa.ok());
   await page.waitForURL(base+'/',{timeout:10000});
  }finally{page.off('request',seeMfa);}
  assert((await page.context().cookies()).some(cookie=>cookie.name==='__Host-aihr_internal'&&cookie.secure&&cookie.httpOnly));
  await home(page);await ready(page);
  return round(performance.now()-t);
 }
 async function visit(page,path,witness){
  const t=performance.now();
  const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:10000});
  assert(response?.status()===200&&response.request().isNavigationRequest()&&response.url()===base+path&&page.url()===base+path);
  if(witness)await (typeof witness==='function'?witness(page):page.locator(witness).first()).waitFor({state:'visible'});else await home(page);
  await ready(page);
  return round(performance.now()-t);
 }
 async function count(){
  const [r]=await owner`select
   count(*) filter(where tenant_id=${f.tenant}::uuid and company_id=${f.company}::uuid)::int as total,
   count(*) filter(where tenant_id=${f.tenant}::uuid and company_id=${f.company}::uuid and employee_code like 'REHEARSAL-BASE-%')::int as baseline,
   count(*) filter(where tenant_id=${f.tenant}::uuid and company_id=${f.company}::uuid and employee_code like 'REHEARSAL-NEW-%')::int as added,
   count(*) filter(where tenant_id=${f.foreign}::uuid and employee_code='REHEARSAL-FOREIGN')::int as "foreign",
   count(*) filter(where tenant_id<>${f.tenant}::uuid and employee_code like 'REHEARSAL-NEW-%')::int as leaked
   from public.employment`;
  return r;
 }
 async function nativeCounters(){
  const statements=await owner`select userid::text||':'||queryid::text||':'||toplevel::text as id,toplevel,calls::double precision as calls,
   total_exec_time,total_plan_time,rows::double precision as rows,shared_blks_hit::double precision as hits,shared_blks_read::double precision as reads,
   left(query,4000) as query
   from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
    and userid in (select oid from pg_roles where rolname in ('ai_hr_app','postgres','ai_hr_owner'))
    and query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 6000`;
  assert(statements.length<6000);
  const functions=await owner`select funcname,calls::double precision as calls,total_time,self_time from pg_stat_user_functions
   where schemaname='app' and funcname::text=any(array['domain_event_chain_tg','access_administrator_constraint','access_assert_administrator_for',
   'access_lock_legacy_writer','access_workforce_write_lock','access_profile_access_generation','access_profile_value_guard',
   'company_org_source_changed','company_org_assignment_guard','principal_snapshot_current','login_blocked_on'])`;
  return {statements,functions};
 }
 function summarizeSql(before,after){
  const previous=new Map(before.statements.map(row=>[row.id,row]));
  const deltas=after.statements.flatMap(row=>{
   const old=previous.get(row.id),diff=key=>row[key]-(old?.[key]??0);
   if(diff('calls')<=0)return [];
   return [{family:sqlFamily(row.query),scope:row.toplevel?'top':'nested',calls:diff('calls'),ms:round(Math.max(0,diff('total_exec_time'))),
    planMs:round(Math.max(0,diff('total_plan_time'))),rows:diff('rows'),hit:diff('hits'),read:diff('reads')}];
  });
  const oldFunctions=new Map(before.functions.map(row=>[row.funcname,row]));
  return {uniqueChangedStatements:deltas.length,top:deltas.sort((a,b)=>(b.ms+b.planMs)-(a.ms+a.planMs)).slice(0,24),
   functions:after.functions.flatMap(row=>{
    const old=oldFunctions.get(row.funcname),calls=row.calls-(old?.calls??0);
    if(calls<=0)return [];
    return [{name:row.funcname,calls,ms:round(Math.max(0,row.total_time-(old?.total_time??0))),
     selfMs:round(Math.max(0,row.self_time-(old?.self_time??0)))}];
   })};
 }
 const frames=[];
 async function sample(){
  for(let i=0;i<5600&&!stop;i++){
   const started=performance.now();
   const [r]=await owner`with keys as (
     select 'access'::text as family,hashtextextended('access-configuration:'||${f.tenant}::uuid::text,0) as id
     union all select 'leave',hashtextextended('leave-dependency-configuration:'||${f.tenant}::uuid::text,0)
     union all select 'audit',hashtext('audit-chain:'||${f.tenant}::uuid::text)::bigint),
    sessions as (select pid,xact_start,wait_event_type,query from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and backend_type='client backend'),
    owned as (select keys.family,l.pid,a.xact_start,l.granted,l.mode,a.query from pg_locks l join sessions a using(pid) cross join keys
     where l.locktype='advisory' and l.objsubid=1 and l.classid::bigint=((keys.id>>32)&4294967295) and l.objid::bigint=(keys.id&4294967295))
    select (select count(*)::int from owned where family='access' and granted and mode='ExclusiveLock') as holder,
     (select pid from owned where family='access' and granted and mode='ExclusiveLock' limit 1) as pid,
     (select (pid::text||':'||xact_start::text) from owned where family='access' and granted and mode='ExclusiveLock' limit 1) as holder_birth,
     (select query ~* '^[[:space:]]*commit' from owned where family='access' and granted and mode='ExclusiveLock' limit 1) as native_commit,
     (select count(*)::int from owned where family='access' and not granted) as queued,
     (select count(*)::int from sessions where wait_event_type='Lock') as blocked,
     coalesce((select jsonb_agg(jsonb_build_array(family,pid,granted,mode='ExclusiveLock')) from owned),'[]'::jsonb) as families`;
   assert(r.holder===0||r.holder===1);
   assert(r.families.length<=40);
   frames.push({at:performance.now(),started,...r});
   await pause(Math.max(0,100-(performance.now()-started)));
  }
 }
 try{
  const [identity]=await role`select session_user as login,current_user as role,current_database() as db,
   (select rolsuper or rolbypassrls from pg_roles where rolname=current_user) as privileged,
   current_setting('auto_explain.log_min_duration',true) as plan_threshold,current_setting('auto_explain.log_nested_statements',true) as plan_nested,
   current_setting('auto_explain.log_timing',true) as plan_timing,current_setting('track_functions') as function_tracking`;
  assert.deepEqual({...identity},{login:'ai_hr_app',role:'ai_hr_app',db:'ai_hr_dev',privileged:false,plan_threshold:'15ms',plan_nested:'on',plan_timing:'off',function_tracking:'pl'});await role.end({timeout:2});
  assert.deepEqual({...await count()},{total:3000,baseline:3000,added:0,foreign:1,leaked:0});
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,env:Object.fromEntries(['PATH','HOME','USER','LANG','LC_ALL','TZ'].filter(key=>env[key]).map(key=>[key,env[key]]))});
  browser.on('disconnected',()=>{if(!stop)failure('browser-disconnected');});
  phase='baseline-login';
  const [importer,hr,employee,cold,baselineCold,clock]=await Promise.all(Array.from({length:6},newPage));
  // Serial fixture sign-ins give a stable reference and keep the measured lock window free of warm-up writes.
  for(const [page,actor] of [[importer,f.actors.importer],[hr,f.actors.hr],[employee,f.actors.employee]])await login(page,actor);
  report.baseline.login=await login(baselineCold,f.actors['cold-baseline']);
  phase='baseline-pages';
  const clockButton=page=>page.getByRole('button',{name:'Clock in',exact:true});
  let clockReady=false;
  try{
   await login(clock,f.actors.clock);
   report.baseline.clockPage=await visit(clock,'/attendance/clock',clockButton);
   await clockButton(clock).and(clock.locator('button:enabled')).waitFor({state:'visible'});
   clockReady=true;
  }catch{failure('clock-baseline');}
  const [clockBefore]=await owner`select count(*)::int as captures from attendance_clock_capture where tenant_id=${f.tenant}::uuid and employment_id=${f.actors.clock.employmentId}::uuid`;
  if(clockBefore.captures!==0){failure('clock-baseline-not-empty');clockReady=false;}
  const lanes=[['home',employee,'/',null],['personnel',hr,'/admin/personnel','main [data-tour="people-table"] tbody tr'],
   ['profile',baselineCold,'/me',page=>page.getByRole('heading',{name:f.actors['cold-baseline'].name,exact:true})]];
  for(const [key,page,path,witness] of lanes){
   report.baseline[key]=[];
   for(let i=0;i<3;i++)report.baseline[key].push(await visit(page,path,witness));
  }
  phase='import-preview';
  await visit(importer,'/admin/personnel/import','input[type="radio"][name="import-section"][value="full"]:checked');
  beforePreviewSql=await nativeCounters();
  const file=makeFile(f.day),beforePreview=performance.now();
  await importer.locator('input[type="file"]').setInputFiles({name:fileName,mimeType:'text/csv',buffer:file});
  const confirm=importer.getByRole('button',{name:'Import 500 valid',exact:true});
  await confirm.waitFor({state:'visible',timeout:60000});assert(await confirm.isEnabled());
  report.preview={ready:500,ms:round(performance.now()-beforePreview)};
  assert.deepEqual({...await count()},{total:3000,baseline:3000,added:0,foreign:1,leaked:0});
  beforeCommitSql=await nativeCounters();
  const isUpload=request=>request.method()==='POST'&&request.url()===base+'/admin/personnel/import/employee/upload';
  let requestAt=null,responseAt=null,coldStart=null,coldMfa=null,clockPostAt=null;
  const clockRequest=request=>request.method()==='POST'&&request.url()===base+'/api/attendance/clock';
  let clockPosts=0;clock.on('request',request=>{if(clockRequest(request)){clockPosts++;clockPostAt??=performance.now();}});
  async function clockIn(){
   const start=performance.now();
   try{
    const [response]=await Promise.all([clock.waitForResponse(result=>clockRequest(result.request()),{timeout:30000}),clockButton(clock).click()]);
    const result=await response.json();
    report.overlap.clock={status:response.status(),ms:round(performance.now()-start),direction:result.receipt?.direction==='in'?'in':null};
    assert(response.ok()&&result.receipt?.direction==='in');
    await clock.getByText(/^Clocked in at /).first().waitFor({state:'visible'});
    report.overlap.clock.ms=round(performance.now()-start);
    await ready(clock);report.overlap.clock.usable=true;
   }catch{report.overlap.clock={...report.overlap.clock,ms:round(performance.now()-start),usable:false};failure('concurrent-clock-in');}
  }
  const requests=[];importer.on('request',request=>{if(isUpload(request)){requestAt??=performance.now();requests.push(request);}});
  sampler=sample().catch(()=>{failure('lock-sampler');});
  while(!frames.length&&!report.failures.includes('lock-sampler'))await pause(10);
  assert(frames.length>0);
  phase='import-submit';
  const upload=importer.waitForResponse(response=>isUpload(response.request()),{timeout:importDeadlineMs}).catch(error=>({timedOut:error.name==='TimeoutError'}));
  const clicked=confirm.click().then(()=>true,()=>false);
  preparation=(async()=>{
   // Witness the actual xact holder first. The import is never held open or retried by the harness.
   while(!stop&&responseAt===null){if(requestAt!==null&&frames.some(row=>row.holder===1&&row.started>=requestAt))break;await pause(25);}
   if(stop||responseAt!==null)return;
   coldStart=performance.now();
   pending=[login(cold,f.actors.cold,started=>{coldMfa=started;}).then(ms=>{report.overlap.login={ms,usable:true};}).catch(()=>{report.overlap.login={ms:round(performance.now()-coldStart),usable:false};failure('concurrent-login');}),clockReady?clockIn():Promise.resolve(),
    ...lanes.map(async([key,page,path,witness])=>{
     const start=performance.now();
     try{const ms=await visit(page,path,witness);report.overlap[key]={ms,usable:true};}catch{report.overlap[key]={ms:round(performance.now()-start),usable:false};failure('concurrent-'+key);}
     return {key,start,end:performance.now()};
    })];
  })();
  const response=await upload;responseAt=performance.now();
  const clickCompleted=await clicked;await preparation;
  const completedLanes=await Promise.all(pending);stop=true;await sampler;
  const importedFrames=frames.filter(row=>row.started>=requestAt&&row.at<=responseAt),holderFrames=importedFrames.filter(row=>row.holder===1);
  const firstHolder=holderFrames[0];
  if(firstHolder)writeFileSync(join(env.PERF_PRIVATE_DIR,'personnel-import-plan-pid.json'),
   JSON.stringify({pid:firstHolder.pid,startedEpochMs:epoch(requestAt),endedEpochMs:epoch(responseAt)}),{flag:'wx',mode:0o600});
  await pause(1100);
  const nativeAfter=await nativeCounters();
  report.nativeSql={scope:'Isolated database deltas; concurrent canaries may contribute, nested times overlap outer times',
   preview:summarizeSql(beforePreviewSql,beforeCommitSql),commit:summarizeSql(beforeCommitSql,nativeAfter)};
  const [clockReadback]=await owner`select count(*)::int as captures,count(*) filter(where direction='in')::int as clockIns
   from attendance_clock_capture where tenant_id=${f.tenant}::uuid and employment_id=${f.actors.clock.employmentId}::uuid`;
  report.clockNative={posts:clockPosts,captures:clockReadback.captures,clockIns:clockReadback.clockins};
  if(clockPosts!==1||clockReadback.captures!==1||clockReadback.clockins!==1)failure('clock-native-readback');
  if(!clickCompleted||requests.length!==1||!Number.isFinite(requestAt))failure('import-request-census');
  report.commit={state:'timedOut' in response?(response.timedOut?'response-timeout':'transport-failure'):'response',
   status:'timedOut' in response?null:response.status(),ms:Number.isFinite(requestAt)?round(responseAt-requestAt):null};
  if('timedOut' in response)failure(response.timedOut?'import-response-timeout':'import-transport-failure');
  else{
   const result=await response.json().catch(()=>null);
   report.commit={...report.commit,imported:result?.imported??null,skipped:result?.skipped??null,
    failed:result?.failed?.length??null,fileErrors:result?.fileErrors?.length??null,superiorFailed:result?.superiorFailed?.length??null};
   if(response.status()!==200||result?.imported!==500||result?.skipped!==0||result?.failed?.length!==0||result?.fileErrors?.length!==0||result?.superiorFailed?.length!==0)failure('import-owner-outcome');
   else {
    report.rendered={countHeading:false,matchingHistoryLink:false,ready:false};
    try{
     await importer.getByRole('heading',{level:2,name:/^Step 6\s+Imported 500 employees$/i}).waitFor({state:'visible',timeout:30000});
     report.rendered.countHeading=true;
     assert(typeof result.attemptId==='string'&&/^[a-f0-9-]{36}$/.test(result.attemptId));
     await importer.locator(`main a[href="/admin/personnel/import/history/${result.attemptId}"]`).first().waitFor({state:'visible'});
     report.rendered.matchingHistoryLink=true;
     await ready(importer);report.rendered.ready=true;
    }catch{failure('import-rendered-outcome');}
   }
  }
  phase='native-readback';
  report.native={...await count()};
  if(report.native.total!==3500||report.native.baseline!==3000||report.native.added!==500||report.native.foreign!==1||report.native.leaked!==0)failure('import-native-counts');
  const [history]=await owner`select count(distinct a.id)::int as attempts,count(distinct i.employment_id)::int as items,
   count(distinct e.id)::int as confirmed
   from import_attempt a join import_attempt_item i on i.attempt_id=a.id and i.tenant_id=a.tenant_id
   join employment h on h.id=i.employment_id and h.tenant_id=i.tenant_id and h.company_id=i.company_id
   join import_attempt_event e on e.attempt_id=a.id and e.tenant_id=a.tenant_id and e.actor_id=a.created_by
   where a.tenant_id=${f.tenant}::uuid and a.created_by=${f.actors.importer.userId}::uuid and a.kind='employee_full' and a.source_name=${fileName}
    and a.source_hash=${seal(file)} and a.company_ids=array[${f.company}::uuid] and i.status='applied'
    and h.employee_code like 'REHEARSAL-NEW-%' and e.kind='confirmed' and (e.detail->>'succeeded')::int=500`;
  report.history={...history};if(history.attempts!==1||history.items!==500||history.confirmed!==1)failure('import-native-history');
  const [effects]=await owner`select count(*)::int as employees,count(distinct p.id)::int as people,
   count(*) filter(where exists(select 1 from assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id
    where a.employment_id=h.id and a.tenant_id=h.tenant_id and a.valid_to is null and d.name='Finance'))::int as assignments,
   count(*) filter(where exists(select 1 from compensation c where c.employment_id=h.id and c.tenant_id=h.tenant_id
    and c.basic_salary=2500 and c.valid_to is null))::int as compensation,
   (select count(*)::int from domain_event e where e.tenant_id=${f.tenant}::uuid and e.aggregate_type='employee-import'
    and e.aggregate_id=${f.company}::uuid and e.event_type='employee-import.completed' and (e.payload->>'imported')::int=500) as completion_events
   from employment h join person p on p.id=h.person_id and p.tenant_id=h.tenant_id
   where h.tenant_id=${f.tenant}::uuid and h.company_id=${f.company}::uuid and h.employee_code like 'REHEARSAL-NEW-%'
    and p.primary_email='rehearsal-import-'||right(h.employee_code,4)||'@example.invalid'`;
  report.effects={...effects};
  if(effects.employees!==500||effects.people!==500||effects.assignments!==500||effects.compensation!==500||effects.completion_events!==1)failure('import-native-effects');
  phase='lock-overlap';
  const overlapping=importedFrames,holders=holderFrames;
  const maxGap=overlapping.length?Math.max(overlapping[0].at-requestAt,responseAt-overlapping.at(-1).at,
   ...overlapping.slice(1).map((row,index)=>row.at-overlapping[index].at)):Infinity;
  report.locks={samples:overlapping.length,holderSamples:holders.length,maxGapMs:Number.isFinite(maxGap)?round(maxGap):null,
   accessQueuedSamples:overlapping.filter(row=>row.queued>0).length,blockingSamples:overlapping.filter(row=>row.blocked>0).length,
   nativeCommitSamples:holders.filter(row=>row.native_commit).length,families:{}};
  for(const family of ['access','leave','audit']){
   const held=overlapping.filter(row=>row.families.some(entry=>entry[0]===family&&entry[1]===firstHolder?.pid&&entry[2]&&entry[3]));
   report.locks.families[family]={heldByImportSamples:held.length,firstAfterPostMs:held.length?round(held[0].at-requestAt):null,
    lastAfterPostMs:held.length?round(held.at(-1).at-requestAt):null,
    queuedSamples:overlapping.filter(row=>row.families.some(entry=>entry[0]===family&&!entry[2])).length};
  }
  const sampledDuring=(start,end)=>Number.isFinite(start)&&holders.some((row,index)=>row.at>=start&&row.at<=end
   ||index>0&&holders[index-1].at<=start&&row.started>=end&&row.holder_birth===holders[index-1].holder_birth);
  if(new Set(holders.map(row=>row.holder_birth)).size!==1)failure('import-holder-identity');
  if(!holders.length||maxGap>313)failure('lock-coverage');
  if(!sampledDuring(clockPostAt,responseAt))failure('clock-overlap-unproven');
  if(!sampledDuring(coldStart,responseAt)||!sampledDuring(coldMfa,responseAt))failure('login-overlap-unproven');
  for(const lane of completedLanes.filter(Boolean))if(!sampledDuring(lane.start,Math.min(lane.end,responseAt)))failure('page-overlap-unproven-'+lane.key);
  if(!['home','personnel','profile','login','clock'].every(key=>Number.isFinite(report.overlap[key]?.ms)))failure('missing-canaries');
  if(report.locks.accessQueuedSamples||report.locks.blockingSamples)failure('blocking-lock');
  // Explicit provisional bounds for this isolated rehearsal, with raw baselines retained for review.
  if(report.overlap.login?.ms>loginBudgetMs)failure('login-deadline');
  if(report.overlap.clock?.ms>clockBudgetMs)failure('clock-deadline');
  for(const key of ['home','personnel','profile'])if(report.overlap[key]?.ms>pageBudgetMs)failure('page-deadline-'+key);
 }catch{failure('incomplete-'+phase);}
 finally{
  stop=true;await Promise.allSettled([sampler,preparation,...pending]);
  const closed=await Promise.allSettled([...contexts.map(context=>context.close()),owner.end({timeout:2}),role.end({timeout:2})]);
  if(closed.some(result=>result.status==='rejected'))failure('resource-settlement');
  if(browser)try{await browser.close();}catch{failure('browser-settlement');}
  const passed=report.failures.length===0;
  log({...report,passed});
  writeFileSync(join(env.PERF_EVIDENCE_DIR,'personnel-import-rehearsal.json'),JSON.stringify({...report,passed}),{flag:'wx',mode:0o600});
  if(!passed)process.exitCode=1;
 }
}
if(process.argv[2]==='seed')await seed().catch(()=>{log({kind:'personnel-import-fixture-refused',source:expected});process.exitCode=1;});
else if(process.argv[2]==='measure')await measure();
else throw new Error('Closed rehearsal mode required');
