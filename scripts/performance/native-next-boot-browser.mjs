/** First actual2-worker boot/auth/Home witness only; not the500-user/full journey gate. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,lstatSync,realpathSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
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
const deadline=performance.now()+input.budgetMs,errors=[],report={version:1,kind:'ACTUAL_NEXT_TWO_WORKER_BOOT_AUTH_HOME_ONLY',
 complete:false,releaseEligible:false,fullApplicationJourneysVerified:false,fixtureUsers:8,preissuedSessions:0,
 logins:[],home:[],hydratedAccountControls:0,coldBusinessRequests:[],servedPorts:[],
 remaining:['actions-and-response-loss','freshness-and-permission-decrease','image-cache-and-PDF','uploads-and-streaming',
  'full-module-browser-preflight','500-actor-worker-load','protected-installation-and-cross-build-compatibility']};
const save=()=>writeFileSync(join(input.evidenceDirectory,'native-next-boot-browser.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
const remaining=()=>{const value=Math.floor(deadline-performance.now());assert(value>0,'Native browser budget exhausted');return Math.min(value,90000);};
const lines=createInterface({input:process.stdin,crlfDelay:Infinity}),waiting=new Map();let nextId=0;
lines.on('line',line=>{assert(Buffer.byteLength(line)<=65536);const value=JSON.parse(line),pending=waiting.get(value.id);
 assert(pending&&value.ok===true&&Object.keys(value).sort().join('|')==='id|ok|result');waiting.delete(value.id);pending(value.result);});
async function host(operation){const id=++nextId;let timer;
 try{return await Promise.race([new Promise(resolve=>{waiting.set(id,resolve);process.stdout.write(JSON.stringify({id,operation})+'\n');}),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native host operation timed out')),remaining());})]);}
 finally{clearTimeout(timer);waiting.delete(id);}
}
const worker=response=>{const value=response.headers()['x-aihr-fixture-worker'];assert(/^127\.0\.0\.1:[0-9]+$/.test(value??''));return Number(value.split(':')[1]);};
function watch(context){context.on('page',page=>{page.on('pageerror',()=>errors.push('PAGE_ERROR'));
 page.on('console',message=>{if(message.type()==='error')errors.push('CONSOLE_ERROR');});
 page.on('response',response=>{if(response.status()>=500)errors.push('HTTP_5XX');});});}
async function identity(page,actor){
 const account=page.locator('button[data-tour="account"]');await account.waitFor({state:'visible',timeout:remaining()});assert.equal(await account.count(),1);
 const name=account.getByText(actor.name,{exact:true});await name.waitFor({timeout:remaining()});assert.equal(await name.count(),1);assert.equal(await name.innerText(),actor.name);
 assert.equal(await page.locator('main [data-page-busy],main [data-personnel-busy],main [data-read-unavailable],main [data-today-unavailable]').count(),0);
 assert.equal(errors.length,0);
}
async function home(page,actor){
 const response=await page.goto(base+'/',{waitUntil:'domcontentloaded',timeout:remaining()});assert.equal(response?.status(),200);await identity(page,actor);
 const personal=actor.role==='employee',attribute=personal?'data-home-card':'data-dashboard-card';await page.locator('main ['+attribute+']').first().waitFor({timeout:remaining()});
 await page.waitForFunction(([key,count])=>document.querySelectorAll('main ['+key+']').length===count,[attribute,personal?8:11],{timeout:remaining()});
 await page.waitForFunction(()=>document.querySelectorAll('main [aria-busy="true"]').length===0,{},{timeout:remaining()});
 const cards=await page.locator('main ['+attribute+']').evaluateAll((elements,key)=>elements.map(element=>element.getAttribute(key)).sort(),attribute);
 assert.deepEqual(cards,(personal?['calendar','celebrations','notices','summary','tasks','team','timeOff','today']:
  ['attendanceOverview','companies','headcount','headcountByCompany','latestPayroll','latestPayrollRun','noticeBoard','pendingLeave','recentActivity','recentlyJoined','upcomingEvents']).sort());
 await page.locator('main [data-today-section]').first().waitFor({timeout:remaining()});assert((await page.locator('main [data-today-section]').first().innerText()).trim().length>0);assert.equal(await page.locator('main [role="alert"]').count(),0);
 if(!personal)await page.locator('[data-dashboard-card="headcount"]').getByText('4',{exact:true}).first().waitFor({timeout:remaining()});
 assert(!(await page.locator('body').innerText()).includes(foreign.name));
 const account=page.locator('button[data-tour="account"]');await account.click({timeout:remaining()});
 assert.equal(await account.getAttribute('aria-expanded'),'true');await page.getByRole('menu').waitFor({timeout:remaining()});
 await account.click({timeout:remaining()});assert.equal(await account.getAttribute('aria-expanded'),'false');report.hydratedAccountControls++;
 const port=worker(response);report.home.push({role:actor.role,cards:cards.length,port,sourceDataVerified:true});save();return port;
}
async function login(page,actor){
 await page.goto(base+'/login?returnTo=%2F',{waitUntil:'domcontentloaded',timeout:remaining()});const username=page.locator('input[name="username"]');
 if(!await username.isVisible()){const organization=page.locator('input[name="organization"]:visible');await organization.fill(actor.organization);
  await page.locator('form').filter({has:organization}).locator('button[type="submit"]').click({timeout:remaining()});}
 await username.fill(actor.username);const password=page.locator('input[name="password"]');await password.fill(actor.password);
 await page.locator('form').filter({has:password}).locator('button[type="submit"]').click({timeout:remaining()});
 const code=page.locator('input[name="code"]');await code.waitFor({state:'visible',timeout:remaining()});await code.fill(await generate({strategy:'totp',secret:actor.secret}));
 await page.locator('form').filter({has:code}).locator('button[type="submit"]').click({timeout:remaining()});await page.waitForURL(url=>url.origin===base&&url.pathname==='/',{timeout:remaining()});
 const cookie=(await page.context().cookies()).find(row=>row.name==='__Host-aihr_internal');
 assert(cookie?.value&&cookie.secure&&cookie.httpOnly&&cookie.path==='/'&&cookie.sameSite==='Lax');report.logins.push({role:actor.role,realPasswordTotp:true,newSession:true});
 return home(page,actor);
}
let browser,contexts=[],succeeded=false;
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'});contexts.push(context);watch(context);
 await context.addCookies([{name:'NEXT_LOCALE',value:'en',url:base}]);const page=await context.newPage(),first=await host('start-first');
 assert.equal(await login(page,admin),first.port);const cold=await host('start-second-cold');assert.equal(cold.admitted,false);assert.notEqual(cold.port,first.port);
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
}catch{process.stderr.write('Native Next boot browser refused\n');report.failure='BOOT_BROWSER_ASSERTION';process.exitCode=1;}
finally{
 let closed=true;for(const context of contexts)try{await context.close();}catch{closed=false;}
 try{await browser?.close();}catch{closed=false;}lines.close();
 report.complete=succeeded&&closed&&errors.length===0;report.unexpectedBrowserErrors=errors.length;
 if(!report.complete){process.exitCode=1;report.failure??='BOOT_BROWSER_CLEANUP_OR_LATE_FAILURE';}save();
}
