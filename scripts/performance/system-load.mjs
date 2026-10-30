/** Real HTTPS requests + Chromium against the isolated production server; no auth/test route bypass. */
import assert from 'node:assert/strict';
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
const agent=new https.Agent({keepAlive:true,maxSockets:600,rejectUnauthorized:false,
 lookup:(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)});
const report={kind:'HTTP_AND_CHROMIUM_DEVELOPMENT_ONLY',releaseEligible:false,users:500,tenants:2,companies:10,startedAt:new Date().toISOString(),
 assumptions:{arrivalWindowMs:10000,thinkTimeMs:1000,tls:'fixture-only self-signed localhost',browserContexts:6,loginEnrollmentLoad:false},
 coverage:[],boundaries:[],browser:[],phases:[],functionalErrors:[],browserErrors:[],latencyTargetMet:false};
const save=()=>writeFileSync(join(out,'http-browser.json'),JSON.stringify(report,null,2));
const samples=[];
async function request(user,path,fields,expectedStatus=200,record=true,actionHeaders={}){
 assert(path.startsWith('/')&&!path.startsWith('//'));const started=performance.now();let body,contentType;
 if(fields){const form=new FormData();for(const [key,value]of Object.entries(fields))form.append(key,String(value));const encoded=new Response(form);contentType=encoded.headers.get('content-type');body=Buffer.from(await encoded.arrayBuffer());}
 const response=await new Promise((resolve,reject)=>{
  const req=https.request(base+path,{agent,method:fields?'POST':'GET',headers:{Host:'localhost:3443',Origin:base,
   Cookie:`__Host-aihr_internal=${user?.token??''}; NEXT_LOCALE=en`,'Accept-Encoding':'gzip',...actionHeaders,...(body?{'Content-Type':contentType,'Content-Length':body.length}:{})}},res=>{
   let wireBytes=0,decodedBytes=0,content='';const ttfbMs=performance.now()-started;
   res.on('data',chunk=>{wireBytes+=chunk.length;});const stream=res.headers['content-encoding']==='gzip'?res.pipe(createGunzip()):res;
   stream.on('data',chunk=>{decodedBytes+=chunk.length;if(decodedBytes<=12*1024*1024)content+=chunk.toString();});
   stream.on('error',reject);stream.on('end',()=>resolve({status:res.statusCode,headers:res.headers,content,wireBytes,decodedBytes,ttfbMs}));
  });req.setTimeout(90000,()=>req.destroy(new Error('HTTP deadline')));req.on('error',reject);req.end(body);
 });
 response.durationMs=performance.now()-started;
 if(record)samples.push({role:user?.role??'anonymous',route:path.split('?')[0],method:fields?'POST':'GET',status:response.status,durationMs:response.durationMs,ttfbMs:response.ttfbMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes});
 assert.equal(response.status,expectedStatus,`Unexpected HTTP status for ${path.split('?')[0]}`);
 if(!fields&&expectedStatus===200&&!path.startsWith('/api/')){
  assert(!response.content.includes('NEXT_HTTP_ERROR_FALLBACK;500'),'server error boundary');
  assert(response.content.includes(user.name),'signed-in principal marker missing');
  assert(!response.content.includes('PERF Person '+String(user.tenant?0:250).padStart(4,'0')),'cross-tenant person leaked');
 }
 return response;
}
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1]??null,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null,p99Ms:sorted[Math.ceil(sorted.length*.99)-1]??null,maxMs:sorted.at(-1)??null};};
async function databaseSnapshot(label){
 const settings=await db`select current_setting('fsync')as fsync,current_setting('synchronous_commit')as synchronous_commit,current_setting('jit')as jit`;
 assert.equal(settings[0].fsync,'on');assert.equal(settings[0].synchronous_commit,'on');
 const statements=await db`select queryid::text,calls,total_exec_time,total_plan_time,mean_exec_time,rows,shared_blks_hit,shared_blks_read,temp_blks_written,
 left(query,1800)as normalized_query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
 and query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 35`;
 writeFileSync(join(out,'database-'+label+'.json'),JSON.stringify({settings,statements},null,2));
}
const employee=fixture.users.find(u=>u.role==='employee'),hr=fixture.users.find(u=>u.role==='companyHR'),group=fixture.users.find(u=>u.role==='groupHR'),manager=fixture.users.find(u=>u.role==='manager');
const employeeRoutes=['/','/me','/claims','/leave','/attendance/individual','/payroll/individual-payslip','/notices','/performance/my','/lifecycle/me'];
const hrRoutes=['/admin/personnel','/attendance','/payroll','/reports','/reports/employee-master','/lifecycle/onboarding','/lifecycle/offboarding','/roster','/letters/register','/performance','/rewards','/system-testing','/feedback','/knowledge-base','/control-tower','/admin/settings/movement'];
let browser,sampling,contextTemplates;
try{
 await db`select pg_stat_statements_reset()`;
 const anonymous=await request(null,'/claims',undefined,307,false);assert(String(anonymous.headers.location).includes('/login'));report.boundaries.push({kind:'anonymous',passed:true});
 for(const user of [employee,manager,hr,group]){
  const routes=user===employee?employeeRoutes:user===manager?['/approvals','/approvals/history','/performance/team']:hrRoutes;
  for(const route of routes){
   try{const response=await request(user,route);report.coverage.push({role:user.role,route,status:'passed',durationMs:response.durationMs,wireBytes:response.wireBytes,decodedBytes:response.decodedBytes});}
   catch(error){report.coverage.push({role:user.role,route,status:'failed',reason:String(error.message).slice(0,180)});}
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
 async function context(user){const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-MY'});await context.addCookies([{name:'__Host-aihr_internal',value:user.token,url:base,secure:true,httpOnly:true,sameSite:'Lax'},{name:'NEXT_LOCALE',value:'en',url:base}]);return context;}
 async function visit(page,user,path){
  const start=performance.now();const response=await page.goto(base+path,{waitUntil:'networkidle',timeout:90000});assert.equal(response.status(),200);
  assert(!new URL(page.url()).pathname.startsWith('/login'));await page.locator('main').waitFor();assert((await page.locator('body').innerText()).includes(user.name));
  const heading=(await page.locator('h1').allTextContents()).join(' ').trim();assert(heading.length>0,'missing page heading');
  const timing=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {ttfbMs:n.responseStart-n.requestStart,domInteractiveMs:n.domInteractive,decodedBytes:n.decodedBodySize,transferBytes:n.transferSize};});
  report.browser.push({role:user.role,path,heading,elapsedMs:performance.now()-start,...timing});save();
 }
 for(const user of [employee,manager,hr,group,fixture.users[254],fixture.users[251]]){
  const ctx=await context(user),page=await ctx.newPage();page.on('pageerror',error=>report.browserErrors.push({role:user.role,error:error.name+': '+error.message.slice(0,150)}));
  for(const route of user.role==='employee'?['/claims','/leave','/attendance/individual']:user.role==='manager'?['/approvals','/performance/team']:['/admin/personnel','/payroll','/lifecycle/onboarding'])await visit(page,user,route);
  await page.screenshot({path:join(out,'browser-'+user.index+'.png'),fullPage:false});await ctx.close();
 }
 // Capture progressive-enhancement action metadata from the actual built form. No hardcoded action ID.
 const ctx=await context(employee),page=await ctx.newPage();await page.goto(base+'/claims',{waitUntil:'networkidle'});
 async function capturedAction(response){
  const req=response.request();const raw=req.postDataBuffer();assert(raw,'missing browser action payload');
  const form=await new Request(base+'/claims',{method:'POST',headers:{'Content-Type':req.headers()['content-type']},body:raw}).formData();
  const fields=Object.fromEntries([...form].filter(([,value])=>typeof value==='string'));
  const key=Object.keys(fields).find(key=>key.endsWith('_claimTypeId')||key.endsWith('_id'));
  assert(key,'unrecognized real browser action fields');
  const suffix=key.endsWith('_claimTypeId')?'claimTypeId':'id',prefix=key.slice(0,-suffix.length);
  const headers={};for(const key of ['accept','next-action','next-router-state-tree'])if(req.headers()[key])headers[key]=req.headers()[key];
  assert(headers['next-action'],'browser server action header missing');
  return {fields,prefix,headers,status:response.status()};
 }
 const browserAction=()=>page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/claims');
 await page.locator('[name="claimTypeId"]').selectOption(employee.claimTypeId);await page.locator('[name="amount"]').fill('1');await page.locator('[name="incurredOn"]').fill(fixture.today);
 await page.locator('[name="description"]').fill('PERF_BROWSER_DRAFT');
 const creating=browserAction();await page.locator('button[name="intent"][value="draft"]').click();const createTemplate=await capturedAction(await creating);
 await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved',{timeout:90000});
 const [draft]=await db`select id from claim_request where employment_id=${employee.employmentId}::uuid and status='draft' and description='PERF_BROWSER_DRAFT'`;
 assert(draft,'browser create did not persist');
 await page.goto(base+'/claims?draft='+draft.id,{waitUntil:'networkidle'});await page.locator('[name="amount"]').fill('2');await page.locator('button[name="intent"][value="draft"]').click();await page.waitForURL(url=>url.searchParams.get('toast')==='Draft saved');
 const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
 const deleting=browserAction();
 await page.locator('form').filter({has:page.locator(`input[name="id"][value="${draft.id}"]`)}).first().getByRole('button').click();
 await page.getByRole('button',{name:'Delete draft',exact:true}).click();
 const deleteTemplate=await capturedAction(await deleting);await page.waitForURL(url=>url.searchParams.get('toast')==='Draft deleted');
 assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
 report.browser.push({role:'employee',workflow:'claim create/edit/delete',persisted:true});await ctx.close();
 contextTemplates={createTemplate,deleteTemplate};
 await databaseSnapshot('pilot');
 if(report.coverage.some(v=>v.status==='failed'))throw Error('Pilot route failures must be diagnosed before a 500-user run');
 await db`select pg_stat_statements_reset()`;
 const waits=[];let samplingBusy=false;sampling=setInterval(async()=>{if(samplingBusy)return;samplingBusy=true;try{const rows=await db`select coalesce(wait_event_type,'CPU-or-ready')as kind,count(*)::int as connections from pg_stat_activity where datname=current_database()and state='active'group by 1`;waits.push({at:Date.now(),rows});}catch{}finally{samplingBusy=false;}},1000);
 const offset=samples.length,started=performance.now();
 const results=await Promise.allSettled(fixture.users.map(async(user,i)=>{
  await pause(i*20);const routes=user.role==='employee'?['/me','/claims','/leave']:user.role==='manager'?['/approvals','/claims','/performance/team']:['/admin/personnel','/payroll','/claims'];
  for(const route of routes){await request(user,route);await pause(1000);}
  const description='PERF_HTTP_'+i;
  const template=contextTemplates.createTemplate,fields={...template.fields};
  for(const [key,value]of Object.entries({employmentId:user.employmentId,claimTypeId:user.claimTypeId,amount:'1',incurredOn:fixture.today,description,intent:'draft'}))fields[template.prefix+key]=value;
  delete fields[template.prefix+'draftId'];
  const created=await request(user,'/claims',fields,template.status,true,template.headers);assert.equal(new URL(String(created.headers['x-action-redirect']??created.headers.location).split(';')[0],base).searchParams.get('toast'),'Draft saved');
  const [draft]=await db`select id from claim_request where employment_id=${user.employmentId}::uuid and status='draft'and description=${description}`;assert(draft,'HTTP create did not persist');
  await pause(1000);await request(user,'/claims',{...fields,[template.prefix+'draftId']:draft.id,[template.prefix+'amount']:'2'},template.status,true,template.headers);
  const [edited]=await db`select amount from claim_request where id=${draft.id}::uuid`;assert.equal(Number(edited.amount),2);
  await pause(1000);await request(user,'/claims',{...contextTemplates.deleteTemplate.fields,[contextTemplates.deleteTemplate.prefix+'employmentId']:user.employmentId,[contextTemplates.deleteTemplate.prefix+'id']:draft.id},contextTemplates.deleteTemplate.status,true,contextTemplates.deleteTemplate.headers);
  assert.equal((await db`select id from claim_request where id=${draft.id}::uuid`).length,0);
 }));
 clearInterval(sampling);sampling=null;
 report.functionalErrors=results.flatMap((value,index)=>value.status==='rejected'?[{user:index,error:String(value.reason.message).slice(0,180)}]:[]);
 const loaded=samples.slice(offset),reads=loaded.filter(v=>v.method==='GET'),writes=loaded.filter(v=>v.method==='POST');
 report.phases.push({name:'500-paced-HTTP-users',elapsedMs:performance.now()-started,completed:results.filter(v=>v.status==='fulfilled').length,errors:report.functionalErrors.length,
  read:summary(reads.map(v=>v.durationMs)),write:summary(writes.map(v=>v.durationMs)),ttfb:summary(loaded.map(v=>v.ttfbMs)),wireBytes:loaded.reduce((sum,v)=>sum+v.wireBytes,0),decodedBytes:loaded.reduce((sum,v)=>sum+v.decodedBytes,0)});
 report.latencyTargetMet=report.phases[0].read.p95Ms<1000&&report.phases[0].write.p95Ms<500;
 writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));writeFileSync(join(out,'database-waits.json'),JSON.stringify(waits));
 await databaseSnapshot('loaded');save();assert.equal(report.functionalErrors.length,0,'HTTP journey failures');assert.equal(report.browserErrors.length,0,'browser runtime errors');
}catch(error){report.error=String(error.message).slice(0,350);writeFileSync(join(out,'http-samples.json'),JSON.stringify(samples));await databaseSnapshot('failure').catch(()=>{});save();throw error;}
finally{if(sampling)clearInterval(sampling);if(browser)await browser.close();agent.destroy();await db.end();save();}
