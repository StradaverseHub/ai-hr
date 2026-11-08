/** Actual HTTP/UI journey on a disposable hosted-runner database, never an installation. */
import {describe,it,expect,afterAll} from 'vitest';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createWriteStream,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {totalmem,availableParallelism} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,type Browser,type Page} from 'playwright';
import {eq} from 'drizzle-orm';
import {adminCtx,migrateTestDb,resetDb,seedBase,owner,closeAll} from './harness';
import {createCompany} from '../core/admin';
import * as s from '../db/schema';
import {buildSystemLabelWorkbook,readSystemLabelWorkbook} from '../lib/system-label-workbook';
import {LOCALE_COOKIE,locales} from '../i18n/config';
import en from '../messages/en.json';
let server:ChildProcess|undefined,browser:Browser|undefined,serverLog:ReturnType<typeof createWriteStream>|undefined;
async function stop(){
 await browser?.close();browser=undefined;
 if(server?.pid&&server.exitCode===null){
  try{process.kill(-server.pid,'SIGTERM');}catch{}
  for(let n=0;n<50&&server.exitCode===null;n++)await delay(100);
  if(server.exitCode===null)try{process.kill(-server.pid,'SIGKILL');}catch{}
 }
 serverLog?.end();
 await closeAll();
}
afterAll(stop,30000);
describe('System Labels authenticated Excel browser journey',()=>{
 it('downloads, previews and imports actual authorized data, refuses restricted global imports, and renders six languages',async()=>{
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
  const port=3149,origin=`http://127.0.0.1:${port}`;
  const memory=totalmem(),heapMiB=memory>=12*1024**3?8192:4096;
  writeFileSync(join(evidence,'system-label-browser-resources.json'),JSON.stringify({memoryBytes:memory,cpus:availableParallelism(),heapMiB,runner:process.env.RUNNER_ENVIRONMENT??'local'}));
  async function navigate(target:Page,path:string){
   for(let attempt=0;;attempt++){
    if(server?.exitCode!==null)throw new Error('Owned preview process exited: '+readFileSync(log,'utf8').slice(-5000));
    try{return await target.goto(origin+path,{waitUntil:'networkidle',timeout:180000});}
    catch(error){
     // Next's development supervisor can briefly close its listener during a documented memory restart.
     // Retry only connection-level restarts of this owned process; HTTP/application failures still fail.
     if(attempt>=5||!error||!/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(String(error)))throw error;
     await delay(750);
    }
   }
  }
  // No production credentials or identity provider. This is the existing explicit developer identity route.
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(port)],{
   detached:true,cwd:process.cwd(),env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',AUTH_PROVIDER:'workos',ALLOW_DEMO_SESSION:'true',DEV_USER_ID:'',DATABASE_URL:process.env.TEST_DATABASE_URL!,MIGRATION_DATABASE_URL:process.env.TEST_MIGRATION_DATABASE_URL!,NODE_OPTIONS:`--max-old-space-size=${heapMiB}`},stdio:['ignore','pipe','pipe']});
  server.stdout?.pipe(stream,{end:false});server.stderr?.pipe(stream,{end:false});
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
   if(server.exitCode!==null)throw new Error('Owned preview server stopped: '+readFileSync(log,'utf8').slice(-5000));
   try{await fetch(origin+'/login',{signal:AbortSignal.timeout(2000)});ready=true;break;}catch{await delay(500);}
  }
  expect(ready,'Owned preview server is reachable').toBe(true);
  if(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'){
   // Ephemeral standard runner only; no larger runner or shared host configuration is touched.
   execFileSync('sudo',['apt-get','update','-qq'],{stdio:'pipe',timeout:120000});
   execFileSync('sudo',['apt-get','install','-y','--no-install-recommends','fonts-noto-core','fonts-noto-cjk'],{stdio:'pipe',timeout:120000});
  }
  browser=await chromium.launch({...(process.platform==='linux'?{channel:'chrome'}:{}),headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
  await context.addCookies([{name:'dev_user',value:b.adminUserId,url:origin},{name:LOCALE_COOKIE,value:'en',url:origin}]);
  const page=await context.newPage();page.setDefaultTimeout(90000);
  const response=await navigate(page,'/admin/settings/system-labels');
  expect(response?.status()).toBe(200);expect(page.url()).toContain('/system-labels');
  // Even a fresh personal catalogue must retain its category rail and Excel export.
  await navigate(page,'/admin/settings/system-labels/profile-options');
  await page.getByRole('button',{name:en.systemLabelExchange.export,exact:true}).waitFor();
  await page.screenshot({path:join(evidence,'system-label-profile-options-empty.png'),fullPage:true});
  await navigate(page,'/admin/settings/system-labels');
  const exports=page.getByRole('button',{name:en.systemLabelExchange.export,exact:true});await expect.poll(()=>exports.count()).toBe(1);
  const downloaded=page.waitForEvent('download');await exports.click();const download=await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const path=await download.path();expect(path).toBeTruthy();
  const exported=readSystemLabelWorkbook(readFileSync(path!));
  expect(exported.some(row=>row.sheet==='department'&&row.values.Code==='Finance')).toBe(true);
  const bytes=await buildSystemLabelWorkbook({kinds:['department','division'],includeStatus:true,references:{companies:[],grades:[],employees:[]},rows:{
   department:[{Code:'BROWSER_GLOBAL_LABEL',Label:'Fictional global label'},{Code:'BROWSER_INVALID_LABEL',Company:'Unknown company'}],
   division:[{Code:'BROWSER_COMPANY_LABEL',Label:'Fictional scoped label',Company:other.id}],
  }});
  await page.getByRole('button',{name:en.admin.systemLabels.excel.import,exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'fictional-labels.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
  await page.getByRole('button',{name:en.labelsImportWizard.check,exact:true}).click();
  await page.getByRole('button',{name:'Import 2 new codes',exact:true}).waitFor();
  expect(await page.getByRole('dialog').innerText()).toContain(en.systemLabelExchange.global);
  expect(await page.getByRole('dialog').innerText()).toContain('Fictional browser company B');
  await page.screenshot({path:join(evidence,'system-label-preview-en-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Import 2 new codes',exact:true}).click();
  await expect.poll(async()=>page.getByRole('dialog').innerText()).toContain('Failed rows: 1');
  const [global]=await owner.db.select().from(s.department).where(eq(s.department.name,'BROWSER_GLOBAL_LABEL'));
  expect(global).toMatchObject({tenantId:b.tenantId,isGlobal:true});
  const [scoped]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'BROWSER_COMPANY_LABEL'));
  expect(scoped).toMatchObject({tenantId:b.tenantId,scopeCompanyIds:[other.id]});
  expect(await owner.db.select().from(s.department).where(eq(s.department.name,'BROWSER_INVALID_LABEL'))).toHaveLength(0);
  await page.getByRole('button',{name:en.labelsImportWizard.step3,exact:true}).click();
  for(const locale of locales){
   const messages=JSON.parse(readFileSync(join(process.cwd(),'messages',locale+'.json'),'utf8'));
   await context.addCookies([{name:LOCALE_COOKIE,value:locale,url:origin}]);
   for(const [name,width,height]of [['desktop',1440,1050],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});await navigate(page,'/admin/settings/system-labels');
    await page.getByRole('button',{name:messages.systemLabelExchange.export,exact:true}).waitFor();
    expect(await page.locator('body').innerText()).not.toMatch(/MISSING_MESSAGE|INVALID_MESSAGE|Application error/);
    await page.screenshot({path:join(evidence,`system-label-exchange-${locale}-${name}.png`),fullPage:true});
   }
  }
  const restrictedContext=await browser.newContext({viewport:{width:1440,height:1050}});
  await restrictedContext.addCookies([{name:'dev_user',value:restricted.id,url:origin},{name:LOCALE_COOKIE,value:'en',url:origin}]);
  const restrictedPage=await restrictedContext.newPage();restrictedPage.setDefaultTimeout(90000);
  await navigate(restrictedPage,'/admin/settings/system-labels');
  await restrictedPage.getByRole('button',{name:en.admin.systemLabels.excel.import,exact:true}).click();
  const refused=await buildSystemLabelWorkbook({kinds:['department'],rows:{department:[{Code:'BROWSER_FORBIDDEN_GLOBAL'}]},references:{companies:[],grades:[],employees:[]}});
  await restrictedPage.locator('input[type=file]').setInputFiles({name:'forbidden-global.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:refused});
  await restrictedPage.getByRole('button',{name:en.labelsImportWizard.check,exact:true}).click();
  await restrictedPage.getByText(en.labelsImportWizard.globalAdminRequired,{exact:true}).waitFor();
  expect(await owner.db.select().from(s.department).where(eq(s.department.name,'BROWSER_FORBIDDEN_GLOBAL'))).toHaveLength(0);
  const allowedExport=await restrictedContext.request.get(origin+'/admin/settings/system-labels/current-data?kind=division&inactive=1');
  expect(allowedExport.status()).toBe(200);expect(readSystemLabelWorkbook(await allowedExport.body()).some(row=>row.values.Code==='BROWSER_COMPANY_LABEL')).toBe(false);
  await restrictedPage.screenshot({path:join(evidence,'system-label-restricted-global-refusal.png'),fullPage:true});
  writeFileSync(join(evidence,'system-label-browser-results.json'),JSON.stringify({source:process.env.AIHR_CI_HEAD,fixture:'fictional and isolated',download:true,preview:true,imported:2,refused:1,restrictedGlobalRefused:true,foreignCompanyExportHidden:true,locales:locales.length,viewports:2},null,2));
  await restrictedContext.close();await context.close();
 },600000);
});
