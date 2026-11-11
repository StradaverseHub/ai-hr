/** Load-only control course (release versus main). The same fictional fixture, HTTP pilot, paced steady reads
 * and clock writes, and a few real browser sign-ins, on whichever product tree runs it. It asserts no
 * release-only behaviour: every outcome is recorded and nothing here is a release gate. Only route labels,
 * roles, counts and timings are written; no people, tokens, payloads or SQL parameters. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import postgres from 'postgres';
import {generate} from 'otplib';
import {routePools} from './system-route-manifest.mjs';

const base='https://localhost:3443';
const out=process.env.PERF_EVIDENCE_DIR,privateDir=process.env.PERF_PRIVATE_DIR;
const fixture=JSON.parse(readFileSync(join(privateDir,'fixture.json'),'utf8'));
const users=fixture.users;
const holdMs=Number(process.env.PERF_HTTP_HOLD_MS||300000),thinkMs=Number(process.env.PERF_HTTP_THINK_MS||1000),rampMs=10000;
const workers=Number(process.env.PERF_APP_WORKERS||0);
const requestDeadlineMs=90000,browserStepMs=30000,pilotBudgetMs=240000,baselineBudgetMs=150000,stuckMs=30000,writeEvery=8;
// The runner kills the driver at 870 s; save what was measured before that, whatever is still running.
const driverDeadlineMs=Number(process.env.PERF_HTTP_HOLD_MS||300000)+480000;
const agent=new https.Agent({keepAlive:true,maxSockets:4000,rejectUnauthorized:false});
const started=performance.now();
const now=()=>performance.now();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=value=>Number.isFinite(value)?Math.round(value*10)/10:null;
const label=path=>{const route=path.split('?')[0];return Object.values(routePools).flat().includes(path)?path:route;};

// Product topology, stated from the tree itself: the release admits a fixed fleet budget, main has none.
const admission=existsSync('db/admission.ts');
const topology={workers,admissionLayer:admission,
 effectiveConnections:admission?Number(process.env.PERF_APP_POOL_CONNECTIONS||16):workers*10,
 basis:admission?'db/capacity.ts fleet budget: AIHR_DB_TOTAL_CONNECTIONS across the web workers'
  :'db/client.ts fixed postgres.js pool of 10 per web worker; no admission layer'};

// ---- HTTP with in-flight tracking ------------------------------------------------------------------------
const inflight=new Map();let sequence=0;
const busyMarker=/<[a-z][^<>]*\sdata-(?:personnel|page)-busy(?:\s|=|>)/i;
const errorMarker=/NEXT_HTTP_ERROR_FALLBACK;(?:404|500)|<h1[^>]*>\s*(?:404|500)(?:\s|<)/;
function send(user,path,{method='GET',body,contentType}={}){
 return new Promise(resolve=>{
  const id=++sequence,startedMs=now(),row={id,method,route:label(path),role:user?.role??'anonymous',startedMs};
  inflight.set(id,row);
  let settled=false,ttfbMs=null;
  const finish=fields=>{if(settled)return;settled=true;clearTimeout(deadline);inflight.delete(id);
   resolve({...row,ttfbMs,durationMs:now()-startedMs,...fields});};
  const request=https.request(base+path,{agent,method,headers:{Host:'localhost:3443',Origin:base,'Sec-Fetch-Site':'same-origin',
   Cookie:`__Host-aihr_internal=${user?.token??''}; NEXT_LOCALE=en`,'Accept-Encoding':'identity',
   ...(body?{'Content-Type':contentType,'Content-Length':body.length}:{})}},response=>{
   ttfbMs=now()-startedMs;const chunks=[];let bytes=0;
   response.on('data',chunk=>{bytes+=chunk.length;if(bytes<=1024*1024)chunks.push(chunk);});
   response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');
    finish({status:response.statusCode,bytes,busy:busyMarker.test(text),errorPage:errorMarker.test(text)});});
   response.on('error',error=>finish({status:null,error:error.code??error.name}));
  });
  const deadline=setTimeout(()=>{request.destroy(Object.assign(Error('deadline'),{code:'ABORT_DEADLINE'}));},requestDeadlineMs);
  request.on('error',error=>finish({status:null,error:error.code??error.name}));
  if(body)request.write(body);
  request.end();
 });
}
function clockBody(action){
 const boundary='----aihrcontrol'+randomUUID().replace(/-/g,'');
 const field=(name,value)=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
 return {contentType:'multipart/form-data; boundary='+boundary,
  body:Buffer.from(field('action',action)+field('requestId',randomUUID())+field('locationStatus','unavailable')+`--${boundary}--\r\n`)};
}

// ---- Database observers: record-only lock sampler and long-pending activity sampler ---------------------
const observer=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,onnotice:()=>{},connection:{application_name:'aihr-control-observer'}});
const probeDb=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,onnotice:()=>{},connection:{application_name:'aihr-control-lock-sampler'}});
const lock={samples:0,skippedTicks:0,blockingSamples:0,maxGapMs:0,steady:{samples:0,skippedTicks:0,blockingSamples:0,maxGapMs:0},failures:0};
let probeRunning=false,lastProbeStart=null,steadyStart=null,steadyEnd=null;
const inSteady=at=>steadyStart!==null&&at>=steadyStart&&at<steadyEnd;
const lockTimer=setInterval(()=>{
 const at=now();
 if(probeRunning){lock.skippedTicks++;if(inSteady(at))lock.steady.skippedTicks++;return;}
 probeRunning=true;const previous=lastProbeStart;lastProbeStart=at;
 probeDb`select (select count(*) from pg_locks where not granted)::int as waiting,
  (select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock')::int as lock_waiters`
  .then(([row])=>{
   const completed=now(),gap=previous===null?0:completed-previous;
   lock.samples++;lock.maxGapMs=Math.max(lock.maxGapMs,gap);if(row.lock_waiters>0)lock.blockingSamples++;
   if(inSteady(at)){lock.steady.samples++;lock.steady.maxGapMs=Math.max(lock.steady.maxGapMs,gap);if(row.lock_waiters>0)lock.steady.blockingSamples++;}
  }).catch(()=>{lock.failures++;}).finally(()=>{probeRunning=false;});
},250);
const browserInflight=new Map();
const stuck={http:new Set(),browser:new Set(),diagnostics:[]};let activityProbe=null;
const stuckTimer=setInterval(()=>{
 const at=now(),rows=[];
 for(const row of inflight.values())if(at-row.startedMs>stuckMs){stuck.http.add(row.id);rows.push({source:'http',method:row.method,route:row.route,role:row.role,elapsedMs:round(at-row.startedMs)});}
 for(const [key,row] of browserInflight)if(at-row.startedMs>stuckMs){stuck.browser.add(key);rows.push({source:'browser',method:row.method,route:row.route,role:row.role,elapsedMs:round(at-row.startedMs)});}
 if(!rows.length||activityProbe||stuck.diagnostics.length>=24)return;
 activityProbe=(async()=>{
  const activity=await observer`select coalesce(state,'') as state,coalesce(wait_event_type,'') as wait_type,coalesce(wait_event,'') as wait_event,
   count(*)::int as n,coalesce(max(extract(epoch from clock_timestamp()-query_start)),0)::float8 as max_age_s from pg_stat_activity
   where datname=current_database() and pid<>pg_backend_pid() group by 1,2,3 order by 4 desc limit 12`;
  const [oldest]=await observer`select round(extract(epoch from clock_timestamp()-query_start)*1000)::int as age_ms,coalesce(wait_event_type,'') as wait_type,
   coalesce(wait_event,'') as wait_event,left(regexp_replace(query,'\\s+',' ','g'),240) as query from pg_stat_activity
   where datname=current_database() and pid<>pg_backend_pid() and state='active' order by query_start limit 1`;
  const [ungranted]=await observer`select count(*)::int as n from pg_locks where not granted`;
  stuck.diagnostics.push({atMs:round(at-started),pending:rows.slice(0,8),ungrantedLocks:ungranted?.n??null,
   activity:activity.map(row=>({state:row.state,waitType:row.wait_type,waitEvent:row.wait_event,n:row.n,maxAgeS:round(row.max_age_s)})),
   oldestActive:oldest?{ageMs:oldest.age_ms,waitType:oldest.wait_type,waitEvent:oldest.wait_event,query:oldest.query}:null});
 })().catch(()=>{}).finally(()=>{activityProbe=null;});
},5000);

// ---- Measurements -----------------------------------------------------------------------------------------
const primary={employee:users[4],manager:users[2],companyHR:users[1],groupHR:users[0]};
const keyPages={employee:['/','/me'],manager:['/','/approvals'],companyHR:['/','/admin/personnel'],groupHR:['/','/admin/personnel']};
const result={kind:'CONTROL_LOAD_RESULT_V1',version:1,scope:'Load-only control; recorded, not a release gate',topology,
 holdMs,thinkMs,actors:users.length,pilot:{rows:[],skipped:0},browser:{baseline:[],loaded:[]},steady:null,lockSampler:lock,
 pendingOver30s:null,phases:{},failures:[]};
function save(){
 try{writeFileSync(join(out,'control-load.json'),JSON.stringify({...result,partial:true,elapsedMs:round(now()-started),
  pendingOver30s:{httpRequests:stuck.http.size,browserRequests:stuck.browser.size,diagnostics:stuck.diagnostics}}));}
 catch(error){console.error('[control-load] partial save failed: '+(error?.code??error?.message));}
}
const saveTimer=setInterval(save,30000);saveTimer.unref();
const watchdog=setTimeout(async()=>{note('driver',{code:'driver-deadline'});save();console.error('[control-load] driver deadline: partial result saved');
 await Promise.race([browser?.close().catch(()=>{}),pause(5000)]);process.exit(0);},driverDeadlineMs);watchdog.unref();
const note=(stage,error)=>{if(result.failures.length<40)result.failures.push({stage,error:String(error?.code??error?.name??'error').slice(0,40)});};

async function pilot(){
 const deadline=now()+pilotBudgetMs;
 await Promise.all(Object.entries(primary).map(async([role,user])=>{
  for(const route of routePools[role]){
   if(now()>deadline){result.pilot.skipped++;continue;}
   const row=await send(user,route);
   result.pilot.rows.push([role,row.route,row.status,round(row.durationMs),row.busy?1:0,row.errorPage?1:0,row.error??null]);
  }
 }));
}

let browser;const lastSignIn=new Map();
async function signedInVisit(role,user,phase){
 const wait=(lastSignIn.get(user.index)??-Infinity)+31000-now();if(wait>0)await pause(wait);
 lastSignIn.set(user.index,now());
 const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en'});
 const row={phase,role,login:null,pages:[]};
 try{
  const page=await context.newPage();
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===base)browserInflight.set(request,{method:request.method(),route:label(url.pathname+url.search),role,startedMs:now()});});
  for(const event of ['requestfinished','requestfailed'])page.on(event,request=>browserInflight.delete(request));
  await page.goto(base+'/login?returnTo=%2F',{waitUntil:'domcontentloaded',timeout:browserStepMs});
  const username=page.locator('input[name="username"]');
  if(!await username.isVisible()){
   const workspace=page.locator('input[name="organization"]:visible');
   await workspace.fill(user.organization);
   await page.locator('form').filter({has:workspace}).locator('button[type="submit"]').click();
  }
  await username.fill(user.username);
  const password=page.locator('input[name="password"]');await password.fill(user.password);
  const submitted=now();
  await page.locator('form').filter({has:password}).locator('button[type="submit"]').click();
  const code=page.locator('input[name="code"]');await code.waitFor({state:'visible',timeout:browserStepMs});
  await code.fill(await generate({strategy:'totp',secret:user.secret}));
  await page.locator('form').filter({has:code}).locator('button[type="submit"]').click();
  await page.waitForURL(url=>url.origin===base&&url.pathname==='/',{timeout:requestDeadlineMs});
  await page.waitForLoadState('load',{timeout:browserStepMs});
  row.login=round(now()-submitted);
  for(const path of keyPages[role]){
   const at=now();
   const response=await page.goto(base+path,{waitUntil:'load',timeout:requestDeadlineMs}).catch(error=>{note(phase+':'+path,error);return null;});
   save();
   row.pages.push([path,response?round(now()-at):null,response?.status()??null]);
  }
 }catch(error){note(phase+':sign-in:'+role,error);}
 finally{await context.close().catch(()=>{});for(const key of [...browserInflight.keys()])if(browserInflight.get(key).role===role)browserInflight.delete(key);}
 return row;
}

async function steady(){
 const samples=new Map(),statusCounts={},writes={attempted:0,status:{}};
 const totals={requests:0,errors5xx:0,transport:0,aborted:0,busy:0,refusals:0,errorPages:0};
 let launched=0,iterations=0;
 const record=(kind,row)=>{
  if(!inSteady(row.startedMs))return;
  totals.requests++;
  const key=kind+'\t'+row.role+'\t'+row.route;
  if(!samples.has(key))samples.set(key,{values:[],errors:0});
  const bucket=samples.get(key);bucket.values.push(row.durationMs);
  statusCounts[row.status??row.error??'none']=(statusCounts[row.status??row.error??'none']??0)+1;
  if(row.status===null){if(row.error==='ABORT_DEADLINE')totals.aborted++;else totals.transport++;bucket.errors++;}
  else if(row.status>=500&&row.status!==503){totals.errors5xx++;bucket.errors++;}
  if(row.status===503||row.status===429)totals.refusals++;
  if(row.busy)totals.busy++;
  if(row.errorPage)totals.errorPages++;
 };
 steadyStart=now()+rampMs;steadyEnd=steadyStart+holdMs;
 await Promise.all(users.map(async(user,index)=>{
  await pause(Math.floor(index*rampMs/users.length));launched++;
  const pool=routePools[user.role],writer=['employee','manager'].includes(user.role);
  let step=index,action='in';
  while(now()<steadyEnd){
   iterations++;
   if(writer&&step%writeEvery===0){
    const {body,contentType}=clockBody(action);action=action==='in'?'out':'in';
    const row=await send(user,'/api/attendance/clock',{method:'POST',body,contentType});
    if(inSteady(row.startedMs)){writes.attempted++;writes.status[row.status??row.error]=(writes.status[row.status??row.error]??0)+1;}
    record('write',{...row,route:'/api/attendance/clock (clock in/out)'});
   }else record('read',await send(user,pool[step%pool.length]));
   step++;
   await pause(thinkMs);
  }
 }));
 const rows=[...samples].map(([key,{values,errors}])=>{
  const [kind,role,route]=key.split('\t');values.sort((a,b)=>a-b);
  const pct=f=>round(values[Math.max(0,Math.ceil(values.length*f)-1)]);
  return [kind,role,route,values.length,pct(.5),pct(.95),pct(.99),round(values.at(-1)),errors];
 }).sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1])||a[2].localeCompare(b[2]));
 return {columns:['kind','role','route','n','p50Ms','p95Ms','p99Ms','maxMs','errors'],holdMs,launched,iterations,
  throughputRps:round(totals.requests/(holdMs/1000)),totals,statusCounts,writes,rows};
}

async function loadedBrowser(){
 const order=['employee','manager','companyHR','groupHR'],pointers={};
 const byRole=Object.fromEntries(order.map(role=>[role,users.filter(user=>user.role===role)]));
 let turn=0;
 while(now()<steadyEnd-20000){
  const role=order[turn++%order.length],list=byRole[role];
  pointers[role]=((pointers[role]??0)+1)%list.length;
  result.browser.loaded.push(await signedInVisit(role,list[pointers[role]],'loaded'));
  await pause(2000);
 }
}

async function main(){
 const phase=async(name,work)=>{const at=now();console.error('[control-load] phase '+name+' started');try{await work();}catch(error){note(name,error);console.error('[control-load] phase '+name+' failed: '+(error?.message??error));}
  result.phases[name]=round(now()-at);console.error('[control-load] phase '+name+' finished ms='+result.phases[name]);};
 await phase('pilot-http',pilot);save();
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,
  args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
 await phase('browser-baseline',async()=>{const deadline=now()+baselineBudgetMs;for(const [role,user] of Object.entries(primary)){if(now()>deadline){note('browser-baseline:'+role,{code:'budget'});continue;}result.browser.baseline.push(await signedInVisit(role,user,'baseline'));}});
 await phase('steady',async()=>{
  const [load]=await Promise.all([steady(),loadedBrowser().catch(error=>note('loaded-browser',error))]);
  result.steady=load;
 });
 result.pendingOver30s={httpRequests:stuck.http.size,browserRequests:stuck.browser.size,diagnostics:stuck.diagnostics};
}

try{await main();}
catch(error){note('driver',error);}
finally{
 clearInterval(lockTimer);clearInterval(stuckTimer);clearInterval(saveTimer);clearTimeout(watchdog);
 await activityProbe?.catch(()=>{});
 result.elapsedMs=round(now()-started);
 let serialized;
 try{serialized=JSON.stringify(result);}
 catch(error){console.error('[control-load] result serialization failed: '+(error?.message??error));
  serialized=JSON.stringify({kind:'CONTROL_LOAD_RESULT_V1',unavailable:'serialization',failures:result.failures});}
 try{writeFileSync(join(out,'control-load.json'),serialized);console.error('[control-load] result written, bytes='+serialized.length);}
 catch(error){console.error('[control-load] result write failed: '+(error?.code??error?.message));}
 await browser?.close().catch(()=>{});
 await Promise.allSettled([observer.end({timeout:2}),probeDb.end({timeout:2})]);
 agent.destroy();
 if(process.connected)process.disconnect();
}
