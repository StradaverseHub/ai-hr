/** Actual HTTP/UI journey on a disposable hosted-runner database, never an installation. */
import {describe,it,expect,afterAll,afterEach} from 'vitest';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {closeSync,createWriteStream,fstatSync,mkdirSync,openSync,readFileSync,readSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {totalmem,availableParallelism} from 'node:os';
import {performance} from 'node:perf_hooks';
import {finished} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,type Browser,type ConsoleMessage,type Page,type Request,type Response} from 'playwright';
import {eq} from 'drizzle-orm';
import {adminCtx,migrateTestDb,resetDb,seedBase,owner,closeAll} from './harness';
import {createCompany} from '../core/admin';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import * as s from '../db/schema';
import {buildSystemLabelWorkbook,readSystemLabelWorkbook} from '../lib/system-label-workbook';
import {LOCALE_COOKIE,locales} from '../i18n/config';
import en from '../messages/en.json';
let server:ChildProcess|undefined,browserLaunch:Promise<Browser>|undefined,serverLog:ReturnType<typeof createWriteStream>|undefined;
let serverClosed=false,serverSpawnFailed=false,logFailed=false;
let serverStartTicks:string|undefined;
let publishResult:(()=>void)|undefined;
function logTail(path:string,limit:number){
 const fd=openSync(path,'r');
 try{
  const size=fstatSync(fd).size,start=Math.max(0,size-limit);
  const tail=Buffer.alloc(size-start);
  return tail.subarray(0,readSync(fd,tail,0,tail.length,start)).toString('utf8');
 }finally{closeSync(fd);}
}
function remaining(deadline:number,label:string){
 const ms=Math.floor(deadline-performance.now());
 if(ms<=0)throw new Error(`System Labels ${label} deadline exceeded`);
 return ms;
}
async function within(deadline:number,label:string,work:()=>Promise<void>){
 const ms=remaining(deadline,label);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([work(),new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(new Error(`System Labels ${label} did not settle`)),ms);
  })]);
  remaining(deadline,label);
 }finally{clearTimeout(timer);}
}
function detachedLeaderStart(child:ChildProcess){
 const pid=child.pid;
 if(process.platform!=='linux'||child!==server||!pid||serverClosed||serverSpawnFailed||child.exitCode!==null||child.signalCode!==null)return;
 let stat:string;
 try{stat=readFileSync(`/proc/${pid}/stat`,'utf8');}catch{return;}
 const commandEnd=stat.lastIndexOf(') ');
 if(!stat.startsWith(`${pid} (`)||commandEnd<0)return;
 const fields=stat.slice(commandEnd+2).trim().split(/\s+/);
 const [state,parent,group,session]=fields;
 const start=fields[19];
 if(!state||!['R','S','D','T','t','I'].includes(state)||parent!==String(process.pid)
  ||group!==String(pid)||session!==String(pid)||!start||!/^[1-9]\d*$/.test(start))return;
 return start;
}
function signalGroup(pid:number,signal:0|'SIGTERM'|'SIGKILL'){
 try{process.kill(-pid,signal);return true;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
}
async function stopNext(deadline:number){
 const child=server;
 if(!child)return;
 const pid=child.pid;
 if(!pid&&!serverSpawnFailed)throw new Error('System Labels Next process identity unavailable');
 const signalOwnedLeader=(signal:'SIGTERM'|'SIGKILL')=>{
  // Recheck the original detached leader immediately before either mutating group signal.
  if(!pid||!serverStartTicks||detachedLeaderStart(child)!==serverStartTicks)return false;
  remaining(deadline,'Next cleanup');
  return signalGroup(pid,signal);
 };
 let groupPresent=pid?signalGroup(pid,0):false;
 const sentTerm=groupPresent&&signalOwnedLeader('SIGTERM');
 const termEnd=performance.now()+5000;
 let escalated=false;
 while(groupPresent||!serverClosed){
  await delay(Math.min(100,remaining(deadline,'Next cleanup')));
  remaining(deadline,'Next cleanup');
  if(groupPresent&&pid)groupPresent=signalGroup(pid,0);
  if(groupPresent&&sentTerm&&!escalated&&performance.now()>=termEnd){
   escalated=true;
   signalOwnedLeader('SIGKILL');
  }
 }
}
async function stop(){
 const begin=performance.now();
 const closeDeadline=begin+15000,deadline=begin+27000;
 const [chrome,next]=await Promise.allSettled([
  within(closeDeadline,'browser cleanup',async()=>{
   if(!browserLaunch)return;
   const browser=await browserLaunch;
   const connected=browser.isConnected();
   await browser.close();
   if(!connected)throw new Error('System Labels browser disconnected before cleanup');
   if(browser.isConnected())throw new Error('System Labels browser still connected after close');
  }),
  within(closeDeadline,'Next cleanup',()=>stopNext(closeDeadline)),
 ]);
 const rest=await Promise.allSettled([
  within(deadline,'database pool cleanup',closeAll),
  within(deadline,'server log cleanup',async()=>{
   if(!serverLog)return;
   if(server&&!serverClosed)throw new Error('System Labels server log drain unconfirmed');
   const drained=finished(serverLog,{cleanup:true});
   serverLog.end();await drained;
   if(logFailed)throw new Error('System Labels server log failed');
  }),
 ]);
 const failures=[chrome,next,...rest].flatMap(result=>result.status==='rejected'?[result.reason]:[]);
 if(failures.length)throw new AggregateError(failures,'System Labels owned cleanup incomplete');
 remaining(deadline,'cleanup');
 publishResult?.();
}
afterAll(stop,30000);
afterEach(async ({task})=>{
 if(task.result?.state!=='fail')return;
 // A failed navigation may leave the browser protocol unable to answer diagnostics.
 try{if(serverLog&&typeof serverLog.path==='string')console.error('Owned Next server failure tail:',logTail(serverLog.path,12000));}
 catch{console.error('Owned Next server failure tail unavailable');}
},30000);
describe('System Labels authenticated Excel browser journey',()=>{
 it('downloads, previews and imports actual authorized data, refuses restricted global imports, and renders six languages',async({signal,task})=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);
  expect(['127.0.0.1','localhost'].includes(url.hostname)).toBe(true);
  expect(url.pathname).toMatch(/test/);
  await migrateTestDb();await resetDb();const b=await seedBase();
  const other=await createCompany(adminCtx(b),{legalName:'Fictional browser company B'});
  await owner.db.update(s.appUser).set({onboardedAt:new Date()}).where(eq(s.appUser.id,b.adminUserId));
  const [restricted]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'fictional-label-browser-restricted',onboardedAt:new Date()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:restricted.id,role:'hr_admin',companyId:b.companyId});
  const evidence=resolve(process.env.AIHR_FOCUSED_EVIDENCE_DIR??'/tmp/aihr-label-browser-evidence');mkdirSync(evidence,{recursive:true});
  const log=join(evidence,'system-label-browser-server.log'),stream=createWriteStream(log);serverLog=stream;
  stream.once('error',()=>{logFailed=true;});
  const port=3149,origin=`http://127.0.0.1:${port}`;
  // next dev restarts itself once its used heap passes 80% of the limit, and the page request after that restart never
  // completed on the hosted runner. With the background import's job routes compiled too, an 8 GiB limit was crossed
  // during the six-language loop. The 16 GB hosted runner (15.6 GiB reported) holds a 12 GiB limit beside PostgreSQL's
  // 2 GiB cap and the unit's second worker; this is the only dev-server test, one per unit. Peaks are recorded per process.
  const memory=totalmem(),heapMiB=memory>=15*1024**3?12288:memory>=12*1024**3?8192:4096;
  const heapEvidence=join(evidence,'system-label-dev-server-heap');mkdirSync(heapEvidence,{recursive:true});
  writeFileSync(join(evidence,'system-label-browser-resources.json'),JSON.stringify({memoryBytes:memory,cpus:availableParallelism(),heapMiB,runner:process.env.RUNNER_ENVIRONMENT??'local'}));
  const labelsPath='/admin/settings/system-labels',profilePath='/admin/settings/system-labels/profile-options';
  type LabelsPath=typeof labelsPath|typeof profilePath;
  function importTrigger(target:Page,messages:typeof en){
   return target.locator('[data-label-import]').getByRole('button',{name:messages.admin.systemLabels.excel.import,exact:true})
    .and(target.locator('[data-label-import-ready="true"]'));
  }
  async function navigate(target:Page,path:LabelsPath,messages:typeof en,locale:(typeof locales)[number]='en'){
   const url=origin+path,deadline=performance.now()+180000;
   const isDocument=(response:Response)=>{
    const request=response.request();
    return response.url()===url&&request.isNavigationRequest()&&request.resourceType()==='document'&&request.frame()===target.mainFrame();
   };
   const isHtml=(response:Response)=>response.headers()['content-type']?.split(';',1)[0].trim().toLowerCase()==='text/html';
   let observedStatus:number|null=null,observedHtml:boolean|null=null,stage='document';
   const observe=(response:Response)=>{
    try{
     if(isDocument(response)){observedStatus=response.status();observedHtml=isHtml(response);}
    }catch{/* The final response check still requires the exact main frame. */}
   };
   target.on('response',observe);
   try{
    let response:Response|null;
    for(let attempt=0;;attempt++){
     signal.throwIfAborted();
     if(!server||serverSpawnFailed||server.exitCode!==null||server.signalCode!==null)throw new Error('Owned preview process exited');
     try{response=await target.goto(url,{waitUntil:'domcontentloaded',timeout:remaining(deadline,'navigation')});break;}
     catch(error){
      // Preserve only the existing connection-level restart tolerance, under one navigation clock.
      if(signal.aborted||observedStatus!==null||attempt>=5||deadline-performance.now()<=750
       ||!/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(String(error)))throw error;
      await delay(750);
     }
    }
    stage='response';
    if(!response)throw new Error('System Labels navigation returned no document response');
    expect(isDocument(response)&&response.request().redirectedFrom()===null).toBe(true);
    expect(response.status()).toBe(200);
    expect(isHtml(response)).toBe(true);
    expect(target.url()).toBe(url);
    const readyDeadline=Math.min(deadline,performance.now()+90000);
    const heading=path===labelsPath?messages.admin.systemLabels.pageTitle:messages.admin.profileOptions.title;
    stage='heading';
    await target.getByRole('heading',{name:heading,level:1,exact:true}).waitFor({state:'visible',timeout:remaining(readyDeadline,stage)});
    stage='export';
    await target.getByRole('button',{name:messages.systemLabelExchange.export,exact:true}).waitFor({state:'visible',timeout:remaining(readyDeadline,stage)});
    stage='import-hydration';
    const trigger=importTrigger(target,messages);
    await trigger.waitFor({state:'visible',timeout:remaining(readyDeadline,stage)});
    expect(await trigger.isEnabled({timeout:remaining(readyDeadline,stage)})).toBe(true);
    remaining(readyDeadline,stage);
    signal.throwIfAborted();
    return response;
   }catch(error){
    console.error('System Labels navigation diagnostics:',{path,locale,viewport:target.viewportSize(),stage,observedStatus,observedHtml});
    throw error;
   }finally{target.off('response',observe);}
  }
  async function openImport(target:Page,role:'group-admin'|'company-admin',load?:()=>Promise<void>){
   const counts={pageErrors:0,consoleErrors:0,scriptRequestFailures:0,scriptHttpErrors:0};
   const localScript=(request:Request)=>request.resourceType()==='script'&&request.url().startsWith(origin+'/_next/static/');
   const pageError=()=>{counts.pageErrors++;};
   const consoleError=(message:ConsoleMessage)=>{if(message.type()==='error')counts.consoleErrors++;};
   const requestFailed=(request:Request)=>{if(localScript(request))counts.scriptRequestFailures++;};
   const responseError=(response:Response)=>{if(response.status()>=400&&localScript(response.request()))counts.scriptHttpErrors++;};
   target.on('pageerror',pageError);target.on('console',consoleError);target.on('requestfailed',requestFailed);target.on('response',responseError);
   let stage='document';
   try{
    if(load)await load();
    const deadline=performance.now()+90000;
    const remaining=()=>{
     const ms=Math.floor(deadline-performance.now());
     if(ms<=0)throw Error('System Labels upload opening deadline exceeded');
     return ms;
    };
    stage='client-ready';
    const trigger=importTrigger(target,en);
    await trigger.waitFor({state:'visible',timeout:remaining()});
    expect(await trigger.isEnabled({timeout:remaining()})).toBe(true);
    stage='click';
    await trigger.click({timeout:remaining()});
    stage='dialog';
    const dialog=target.getByRole('dialog',{name:en.labelsImportWizard.title,exact:true});
    await dialog.waitFor({state:'visible',timeout:remaining()});
    return dialog;
   }catch(error){
    console.error('System Labels upload opening diagnostics:',{role,stage,...counts});
    throw error;
   }finally{
    target.off('pageerror',pageError);target.off('console',consoleError);target.off('requestfailed',requestFailed);target.off('response',responseError);
   }
  }
  // No production credentials or identity provider. This is the existing explicit developer identity route.
  signal.throwIfAborted();
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(port)],{
   detached:true,cwd:process.cwd(),env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',AUTH_PROVIDER:'workos',ALLOW_DEMO_SESSION:'true',DEV_USER_ID:'',DATABASE_URL:process.env.TEST_DATABASE_URL!,MIGRATION_DATABASE_URL:process.env.TEST_MIGRATION_DATABASE_URL!,NODE_OPTIONS:`--max-old-space-size=${heapMiB} --require ${resolve('test/helpers/heap-peak-preload.cjs')}`,AIHR_HEAP_PEAK_DIR:heapEvidence},stdio:['ignore','pipe','pipe']});
  const nextChild=server;
  nextChild.once('spawn',()=>{serverStartTicks=detachedLeaderStart(nextChild);});
  nextChild.once('error',()=>{serverSpawnFailed=true;});
  nextChild.once('close',()=>{serverClosed=true;});
  server.stdout?.pipe(stream,{end:false});server.stderr?.pipe(stream,{end:false});
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
   if(serverSpawnFailed||server.exitCode!==null||server.signalCode!==null)throw new Error('Owned preview server stopped: '+logTail(log,5000));
   try{await fetch(origin+'/login',{signal:AbortSignal.timeout(2000)});ready=true;break;}catch{await delay(500);}
  }
  expect(ready,'Owned preview server is reachable').toBe(true);
  if(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'){
   // Ephemeral standard runner only; no larger runner or shared host configuration is touched.
   execFileSync('sudo',['apt-get','update','-qq'],{stdio:'pipe',timeout:120000});
   execFileSync('sudo',['apt-get','install','-y','--no-install-recommends','fonts-noto-core','fonts-noto-cjk'],{stdio:'pipe',timeout:120000});
  }
  signal.throwIfAborted();
  browserLaunch=chromium.launch({...(process.platform==='linux'?{channel:'chrome'}:{}),headless:true});
  const browser=await browserLaunch;
  signal.throwIfAborted();
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
  await context.addCookies([{name:'dev_user',value:b.adminUserId,url:origin},{name:LOCALE_COOKIE,value:'en',url:origin}]);
  const page=await context.newPage();page.setDefaultTimeout(90000);
  await navigate(page,labelsPath,en);
  // Even a fresh personal catalogue must retain its category rail and Excel export.
  await navigate(page,profilePath,en);
  await page.screenshot({path:join(evidence,'system-label-profile-options-empty.png'),fullPage:true});
  await navigate(page,labelsPath,en);
  const exports=page.getByRole('button',{name:en.systemLabelExchange.export,exact:true});await expect.poll(()=>exports.count()).toBe(1);
  const downloaded=page.waitForEvent('download');await exports.click();const download=await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const path=await download.path();expect(path).toBeTruthy();
  const exported=readSystemLabelWorkbook(readFileSync(path!));
  expect(exported.some(row=>row.sheet==='department'&&row.values.Code==='Finance')).toBe(true);
  const bytes=await buildSystemLabelWorkbook({kinds:['department','division','grade_groups'],includeStatus:true,references:{companies:[],grades:[],employees:[]},rows:{
   department:[{Code:'BROWSER_GLOBAL_LABEL',Label:'Fictional global label'},{Code:'BROWSER_INVALID_LABEL',Company:'Unknown company'}],
   division:[{Code:'BROWSER_COMPANY_LABEL',Label:'Fictional scoped label',Company:other.id}],
   grade_groups:[{Code:'',Label:'',Name:'BROWSER_GROUP_LABEL'}],
  }});
  const importDialog=await openImport(page,'group-admin');
  await importDialog.getByLabel(en.labelsImportWizard.upload,{exact:true}).setInputFiles({name:'fictional-labels.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
  await page.getByRole('button',{name:en.labelsImportWizard.check,exact:true}).click();
  await page.getByRole('button',{name:'Import 3 new codes',exact:true}).waitFor();
  expect(await page.getByRole('dialog').innerText()).toContain(en.systemLabelExchange.global);
  expect(await page.getByRole('dialog').innerText()).toContain('Fictional browser company B');
  expect(await page.getByRole('dialog').innerText()).toContain('BROWSER_GROUP_LABEL');
  await page.screenshot({path:join(evidence,'system-label-preview-en-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Import 3 new codes',exact:true}).click();
  // 44810ec04 runs the confirmed import as a background job on the shared bulk-job kernel, and the wizard follows the
  // job to the summary the synchronous import showed. This disposable runner has no worker process, so the test runs
  // the worker's own tick (the call scripts/bank-import-runner.ts makes) until the wizard shows that outcome.
  await expect.poll(async()=>{
   await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});
   return page.getByRole('dialog').innerText();
  },{timeout:120000,interval:250}).toContain('Failed rows: 1');
  const [labelJob]=await owner.client<{state:string}[]>`select state from bulk_job where tenant_id=${b.tenantId}::uuid and kind='system_label_import' order by created_at desc limit 1`;
  expect(labelJob).toEqual({state:'completed'});
  const [global]=await owner.db.select().from(s.department).where(eq(s.department.name,'BROWSER_GLOBAL_LABEL'));
  expect(global).toMatchObject({tenantId:b.tenantId,isGlobal:true});
  const [scoped]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'BROWSER_COMPANY_LABEL'));
  expect(scoped).toMatchObject({tenantId:b.tenantId,scopeCompanyIds:[other.id]});
  const [group]=await owner.db.select().from(s.gradeGroup).where(eq(s.gradeGroup.name,'BROWSER_GROUP_LABEL'));expect(group).toMatchObject({tenantId:b.tenantId,scopeCompanyIds:null});
  expect(await owner.db.select().from(s.department).where(eq(s.department.name,'BROWSER_INVALID_LABEL'))).toHaveLength(0);
  await page.getByRole('button',{name:en.labelsImportWizard.step3,exact:true}).click();
  for(const locale of locales){
   const messages:typeof en=JSON.parse(readFileSync(join(process.cwd(),'messages',locale+'.json'),'utf8'));
   await context.addCookies([{name:LOCALE_COOKIE,value:locale,url:origin}]);
   for(const [name,width,height]of [['desktop',1440,1050],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});await navigate(page,labelsPath,messages,locale);
    expect(await page.locator('body').innerText()).not.toMatch(/MISSING_MESSAGE|INVALID_MESSAGE|Application error/);
    await page.screenshot({path:join(evidence,`system-label-exchange-${locale}-${name}.png`),fullPage:true});
   }
  }
  const restrictedContext=await browser.newContext({viewport:{width:1440,height:1050}});
  await restrictedContext.addCookies([{name:'dev_user',value:restricted.id,url:origin},{name:LOCALE_COOKIE,value:'en',url:origin}]);
  const restrictedPage=await restrictedContext.newPage();restrictedPage.setDefaultTimeout(90000);
  const restrictedImportDialog=await openImport(restrictedPage,'company-admin',async()=>{
   const response=await navigate(restrictedPage,labelsPath,en);
   // Inspect the actual response before any client changes, without loading another page.
   const serverTriggers=await restrictedPage.evaluate(html=>{
    const template=document.createElement('template');
    template.innerHTML=html;
    return Array.from(template.content.querySelectorAll<HTMLButtonElement>('[data-label-import] button[data-label-import-ready]'),
     button=>({disabled:button.disabled,ready:button.getAttribute('data-label-import-ready')}));
   },await response.text());
   expect(serverTriggers).toEqual([{disabled:true,ready:'false'}]);
  });
  const refused=await buildSystemLabelWorkbook({kinds:['department'],rows:{department:[{Code:'BROWSER_FORBIDDEN_GLOBAL'}]},references:{companies:[],grades:[],employees:[]}});
  await restrictedImportDialog.getByLabel(en.labelsImportWizard.upload,{exact:true}).setInputFiles({name:'forbidden-global.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:refused});
  await restrictedPage.getByRole('button',{name:en.labelsImportWizard.check,exact:true}).click();
  await restrictedPage.getByText(en.labelsImportWizard.globalAdminRequired,{exact:true}).waitFor();
  expect(await owner.db.select().from(s.department).where(eq(s.department.name,'BROWSER_FORBIDDEN_GLOBAL'))).toHaveLength(0);
  const allowedExport=await restrictedContext.request.get(origin+'/admin/settings/system-labels/current-data?kind=division&inactive=1');
  expect(allowedExport.status()).toBe(200);expect(readSystemLabelWorkbook(await allowedExport.body()).some(row=>row.values.Code==='BROWSER_COMPANY_LABEL')).toBe(false);
  await restrictedPage.screenshot({path:join(evidence,'system-label-restricted-global-refusal.png'),fullPage:true});
  await restrictedContext.close();await context.close();
  signal.throwIfAborted();
  publishResult=()=>{
   if(task.result?.state!=='pass')return;
   writeFileSync(join(evidence,'system-label-browser-results.json'),JSON.stringify({source:process.env.AIHR_CI_HEAD,fixture:'fictional and isolated',download:true,preview:true,imported:3,refused:1,restrictedGlobalRefused:true,foreignCompanyExportHidden:true,locales:locales.length,viewports:2},null,2));
  };
 },600000);
});
