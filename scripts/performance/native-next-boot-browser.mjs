/** First actual2-worker boot/auth/Home witness only; not the500-user/full journey gate. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,lstatSync,realpathSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
import {chromium,errors as playwrightErrors} from 'playwright';
import {generate} from 'otplib';
assert.equal(process.platform,'linux');assert(process.getuid()>0);assert.equal(process.argv.length,3);
const file=process.argv[2],info=lstatSync(file);
assert(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o777)===0o600&&info.size>0&&info.size<=2*1024**2);
const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let input;
try{const actual=fstatSync(fd);assert.equal(actual.dev,info.dev);assert.equal(actual.ino,info.ino);assert.equal(actual.size,info.size);
 input=JSON.parse(readFileSync(fd,'utf8'));assert.equal(fstatSync(fd).mtimeMs,actual.mtimeMs);assert.equal(lstatSync(file).ino,actual.ino);
}finally{closeSync(fd);}
const base='https://localhost:3443';
assert.deepEqual(Object.keys(input).sort(),['budgetMs','evidenceDirectory','fixture','kind','version']);
assert.equal(input.version,1);assert.equal(input.kind,'PRIVATE_NATIVE_NEXT_BOOT_BROWSER_INPUT');
assert.equal(input.fixture.kind,'FICTIONAL_NATIVE_NEXT_SMOKE_ONLY');assert.equal(input.fixture.actors.length,8);
assert.equal(input.fixture.preissuedSessions,0);assert.equal(input.fixture.providersConfigured,0);
assert(Number.isSafeInteger(input.budgetMs)&&input.budgetMs>0&&input.budgetMs<=300000);
assert.equal(realpathSync(input.evidenceDirectory),input.evidenceDirectory);
const [admin,,,employee]=input.fixture.actors,foreign=input.fixture.actors[5];
assert.equal(admin.role,'groupHR');assert.equal(employee.role,'employee');assert.notEqual(admin.tenantId,foreign.tenantId);
const driverStartedAt=performance.now(),deadline=driverStartedAt+input.budgetMs,errors=[],report={version:1,kind:'ACTUAL_NEXT_TWO_WORKER_BOOT_AUTH_HOME_ONLY',
 complete:false,releaseEligible:false,fullApplicationJourneysVerified:false,fixtureUsers:8,preissuedSessions:0,
 logins:[],home:[],hydratedAccountControls:0,coldBusinessRequests:[],servedPorts:[],
 remaining:['actions-and-response-loss','freshness-and-permission-decrease','image-cache-and-PDF','uploads-and-streaming',
  'full-module-browser-preflight','500-actor-worker-load','protected-installation-and-cross-build-compatibility']};
const save=()=>writeFileSync(join(input.evidenceDirectory,'native-next-boot-browser.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
const remaining=()=>{const value=Math.floor(deadline-performance.now());assert(value>0,'Native browser budget exhausted');return Math.min(value,90000);};
const lines=createInterface({input:process.stdin,crlfDelay:Infinity}),waiting=new Map();let nextId=0;
lines.on('line',line=>{assert(Buffer.byteLength(line)<=65536);const value=JSON.parse(line),pending=waiting.get(value.id);
 assert(pending&&value.ok===true&&Object.keys(value).sort().join('|')==='id|ok|result');waiting.delete(value.id);pending(value.result);});
async function host(operation){const id=++nextId,first=id===1&&operation==='start-first',started=performance.now();let timer;
 const timing=first?(report.firstHostRequestTiming={kind:'ACTUAL_FIRST_HOST_REQUEST_TIMING_NOT_ADMISSION',timeoutMs:null,elapsedMs:null,outcome:'entered',driverFinalElapsedMs:null}):null;
 try{
  const result=await Promise.race([new Promise(resolve=>{waiting.set(id,resolve);process.stdout.write(JSON.stringify({id,operation})+'\n');}),
   new Promise((_,reject)=>{const timeoutMs=remaining();if(timing)timing.timeoutMs=timeoutMs;
    timer=setTimeout(()=>{if(timing)timing.outcome='timeout';reject(Error('Native host operation timed out'));},timeoutMs);})]);
  if(timing)timing.outcome='returned';return result;
 }catch(error){if(timing&&timing.outcome!=='timeout')timing.outcome='refused';throw error;}
 finally{clearTimeout(timer);waiting.delete(id);if(timing){timing.elapsedMs=Math.floor(performance.now()-started);save();}}
}
const worker=response=>{const value=response.headers()['x-aihr-fixture-worker'];assert(/^127\.0\.0\.1:[0-9]+$/.test(value??''));return Number(value.split(':')[1]);};
// Only the first real group HR Home attempt uses this finite trace. Persist each
// entered phase before awaiting so a parent timeout still leaves the frontier.
function makeFirstHomeProgress(emit){
 const stages=['home-navigate','account-visible','account-identity','first-card-visible','card-count','loading-settled','card-keys',
  'today-visible','today-content','headcount','tenant-scope','welcome-visible','welcome-action','welcome-hidden','account-open',
  'menu-visible','account-close','worker-match'];
 let index=-1,finished=false,statusRecorded=false;
 return {
  enter(stage){
   assert(!finished&&index+1<stages.length&&stage===stages[index+1]);
   index++;statusRecorded=false;emit({stage,state:'entered'});
  },
  status(status){
   const stage=stages[index];
   assert(!finished&&!statusRecorded&&(stage==='home-navigate'||stage==='welcome-action')&&
    (status===null||Number.isInteger(status)&&status>=100&&status<=599));
   statusRecorded=true;emit({stage,state:'http-status',status});
  },
  complete(){
   assert(!finished&&index===stages.length-1);
   finished=true;emit({stage:stages[index],state:'returned'});
  },
  fail(type){
   if(finished)return;
   assert(index>=0&&['timeout','assertion','other'].includes(type));
   finished=true;emit({stage:stages[index],state:'refused',type});
  },
 };
}
function newFirstHomeProgress(){
 const path=join(input.evidenceDirectory,'native-next-boot-first-home-progress.jsonl');
 let first=true;
 return makeFirstHomeProgress(row=>{
  writeFileSync(path,JSON.stringify(row)+'\n',{flag:first?'ax':'a',mode:0o600});
  first=false;
 });
}
const productTour=page=>page.getByRole('dialog',{name:'Product tour',exact:true});
async function skipWelcomeTour(page,progress){
 const tour=productTour(page),skip=tour.getByRole('button',{name:'Skip',exact:true});
 progress.enter('welcome-visible');
 await skip.waitFor({state:'visible',timeout:remaining()});
 progress.enter('welcome-action');
 const [finished,click]=await Promise.allSettled([
  page.waitForEvent('requestfinished',{
   predicate:request=>{
    const url=new URL(request.url());
    return url.origin===base&&url.pathname==='/'&&request.method()==='POST'&&Boolean(request.headers()['next-action']);
   },
   timeout:remaining(),
  }),
  skip.click({timeout:remaining()}),
 ]);
 // The completed request already has its response. Do not start another wait.
 const response=finished.status==='fulfilled'?finished.value.existingResponse():null;
 if(finished.status==='fulfilled')progress.status(response?.status()??null);
 if(click.status==='rejected')throw click.reason;
 if(finished.status==='rejected')throw finished.reason;
 assert.equal(response?.status(),200);
 assert(response.headers()['content-type']?.startsWith('text/x-component'));
 progress.enter('welcome-hidden');
 await tour.waitFor({state:'hidden',timeout:remaining()});
}

function watch(context){context.on('page',page=>{page.on('pageerror',()=>errors.push('PAGE_ERROR'));
 page.on('console',message=>{if(message.type()==='error')errors.push('CONSOLE_ERROR');});
 page.on('response',response=>{if(response.status()>=500)errors.push('HTTP_5XX');});});}
async function assertNoHomeFailureMarkers(page){
 const markers='[data-page-busy],[data-personnel-busy],[data-read-unavailable],[data-today-unavailable]';
 assert.equal(await page.locator(`main:is(${markers}),main :is(${markers})`).count(),0);
}
async function identity(page,actor,progress){
 progress?.enter('account-visible');
 const account=page.locator('button[data-tour="account"]');await account.waitFor({state:'visible',timeout:remaining()});assert.equal(await account.count(),1);
 progress?.enter('account-identity');
 const name=account.getByText(actor.name,{exact:true});await name.waitFor({timeout:remaining()});assert.equal(await name.count(),1);assert.equal(await name.innerText(),actor.name);
 await assertNoHomeFailureMarkers(page);
 assert.equal(errors.length,0);
}
async function home(page,actor,progress){
 progress?.enter('home-navigate');
 const response=await page.goto(base+'/',{waitUntil:'domcontentloaded',timeout:remaining()});
 progress?.status(response?.status()??null);
 assert.equal(response?.status(),200);await identity(page,actor,progress);
 progress?.enter('first-card-visible');
 const personal=actor.role==='employee',attribute=personal?'data-home-card':'data-dashboard-card';await page.locator('main ['+attribute+']').first().waitFor({timeout:remaining()});
 progress?.enter('card-count');
 await page.waitForFunction(([key,count])=>document.querySelectorAll('main ['+key+']').length===count,[attribute,personal?8:11],{timeout:remaining()});
 progress?.enter('loading-settled');
 await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:remaining()});
 progress?.enter('card-keys');
 const cards=await page.locator('main ['+attribute+']').evaluateAll((elements,key)=>elements.map(element=>element.getAttribute(key)).sort(),attribute);
 assert.deepEqual(cards,(personal?['calendar','celebrations','notices','summary','tasks','team','timeOff','today']:
  ['attendanceOverview','companies','headcount','headcountByCompany','latestPayroll','latestPayrollRun','noticeBoard','pendingLeave','recentActivity','recentlyJoined','upcomingEvents']).sort());
 progress?.enter('today-visible');
 await page.locator('main [data-today-section]').first().waitFor({timeout:remaining()});
 progress?.enter('today-content');
 assert((await page.locator('main [data-today-section]').first().innerText()).trim().length>0);assert.equal(await page.locator('main [role="alert"]').count(),0);
 progress?.enter('headcount');
 if(!personal)await page.locator('[data-dashboard-card="headcount"]').getByText('4',{exact:true}).first().waitFor({timeout:remaining()});
 progress?.enter('tenant-scope');
 assert(!(await page.locator('body').innerText()).includes(foreign.name));
 if(progress)await skipWelcomeTour(page,progress);
 progress?.enter('account-open');
 const account=page.locator('button[data-tour="account"]');await account.click({timeout:remaining()});
 assert.equal(await account.getAttribute('aria-expanded'),'true');
 progress?.enter('menu-visible');
 await page.getByRole('menu').waitFor({timeout:remaining()});
 progress?.enter('account-close');
 await account.click({timeout:remaining()});assert.equal(await account.getAttribute('aria-expanded'),'false');
 // These full navigations hydrate the normal account menu. The group HR tour
 // must stay dismissed and the personal Home never auto-opens it.
 assert.equal(await productTour(page).count(),0);
 await assertNoHomeFailureMarkers(page);assert.equal(errors.length,0);
 report.hydratedAccountControls++;
 progress?.enter('worker-match');
 const port=worker(response);report.home.push({role:actor.role,cards:cards.length,port,sourceDataVerified:true});save();return port;
}
let firstHomeProgress;
async function login(page,actor,traceFirstHome=false){
 await page.goto(base+'/login?returnTo=%2F',{waitUntil:'domcontentloaded',timeout:remaining()});const username=page.locator('input[name="username"]');
 if(!await username.isVisible()){const organization=page.locator('input[name="organization"]:visible');await organization.fill(actor.organization);
  await page.locator('form').filter({has:organization}).locator('button[type="submit"]').click({timeout:remaining()});}
 await username.fill(actor.username);const password=page.locator('input[name="password"]');await password.fill(actor.password);
 await page.locator('form').filter({has:password}).locator('button[type="submit"]').click({timeout:remaining()});
 const code=page.locator('input[name="code"]');await code.waitFor({state:'visible',timeout:remaining()});await code.fill(await generate({strategy:'totp',secret:actor.secret}));
 await page.locator('form').filter({has:code}).locator('button[type="submit"]').click({timeout:remaining()});await page.waitForURL(url=>url.origin===base&&url.pathname==='/',{timeout:remaining()});
 const cookie=(await page.context().cookies()).find(row=>row.name==='__Host-aihr_internal');
 assert(cookie?.value&&cookie.secure&&cookie.httpOnly&&cookie.path==='/'&&cookie.sameSite==='Lax');report.logins.push({role:actor.role,realPasswordTotp:true,newSession:true});
 if(traceFirstHome)firstHomeProgress=newFirstHomeProgress();
 return home(page,actor,traceFirstHome?firstHomeProgress:undefined);
}
let browser,contexts=[],succeeded=false;
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});contexts.push(context);watch(context);
 await context.addCookies([{name:'NEXT_LOCALE',value:'en',url:base}]);const page=await context.newPage(),first=await host('start-first');
 assert.equal(await login(page,admin,true),first.port);firstHomeProgress.complete();
 const cold=await host('start-second-cold');assert.equal(cold.admitted,false);assert.notEqual(cold.port,first.port);
 for(let index=0;index<3;index++){const port=await home(page,admin);assert.equal(port,first.port);report.coldBusinessRequests.push({observedPort:port,coldPort:cold.port});}
 const second=await host('admit-second'),ports=new Set();assert.equal(second.port,cold.port);
 for(let index=0;index<12&&ports.size<2;index++)ports.add(await home(page,admin));
 assert.deepEqual([...ports].sort((a,b)=>a-b),[first.port,second.port].sort((a,b)=>a-b));report.servedPorts=[...ports].sort((a,b)=>a-b);
 const own=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});contexts.push(own);watch(own);
 await own.addCookies([{name:'NEXT_LOCALE',value:'en',url:base}]);const ownPage=await own.newPage();await login(ownPage,employee);
 const response=await ownPage.goto(base+'/me/payslip',{waitUntil:'domcontentloaded',timeout:remaining()});assert.equal(response?.status(),200);await identity(ownPage,employee);
 const text=await ownPage.locator('main').innerText();assert(text.includes(employee.name)&&text.includes(employee.employeeCode)&&/5,000\.00/.test(text));
 await ownPage.getByRole('link',{name:'Download PDF',exact:true}).waitFor({timeout:remaining()});report.nonemptyOwnPayrollView=true;
 assert.equal(report.logins.length,2);assert.equal(errors.length,0);await host('browser-core-finished');succeeded=true;
}catch(error){
 process.stderr.write('Native Next boot browser refused\n');report.failure='BOOT_BROWSER_ASSERTION';process.exitCode=1;
 try{
  firstHomeProgress?.fail(error instanceof playwrightErrors.TimeoutError?'timeout':error instanceof assert.AssertionError?'assertion':'other');
 }catch{/* The existing browser refusal stays primary if the trace cannot be written. */}
}
finally{
 let closed=true;for(const context of contexts)try{await context.close();}catch{closed=false;}
 try{await browser?.close();}catch{closed=false;}lines.close();
 if(report.firstHostRequestTiming)report.firstHostRequestTiming.driverFinalElapsedMs=Math.floor(performance.now()-driverStartedAt);
 report.complete=succeeded&&closed&&errors.length===0;report.unexpectedBrowserErrors=errors.length;
 if(!report.complete){process.exitCode=1;report.failure??='BOOT_BROWSER_CLEANUP_OR_LATE_FAILURE';}save();
}
