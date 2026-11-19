/** Authenticated actual routes, fictional data, two viewport sizes; no installation or user records. */
import {afterAll,expect,it} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from 'playwright';
import {eq} from 'drizzle-orm';
import {adminCtx,migrateTestDb,resetDb,seedBase,owner,closeAll,setModule} from './harness';
import {hireEmployee} from '../core/org';
import {createClaimType,setClaimPolicy} from '../packs/claims/service';
import * as s from '../db/schema';
import {LOCALE_COOKIE} from '../i18n/config';
import en from '../messages/en.json';
import {OwnedVisualPreview} from './helpers/owned-visual-preview';
let preview:OwnedVisualPreview|undefined,browser:Browser|undefined;
afterAll(async()=>{
 const results=await Promise.allSettled([browser?.close(),preview?.close()]);await closeAll();
 const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
 if(failures.length)throw new AggregateError(failures,'Operational visual cleanup failed');
},30000);
it('renders affected operational routes at desktop and mobile widths without page overflow',async({signal})=>{
 const database=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost'].includes(database.hostname)).toBe(true);expect(database.pathname).toMatch(/test/);
 const evidence=resolve(process.env.AIHR_FOCUSED_EVIDENCE_DIR??'/tmp/aihr-operational-visual-evidence');
 mkdirSync(evidence,{recursive:true});mkdirSync(join(evidence,'operational-preview-heap'),{recursive:true});
 await migrateTestDb();await resetDb();const b=await seedBase();
 for(const module of ['claims','rewards','recruitment'])await setModule(b.tenantId,module,'active');
 const subject=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Visual Reviewer',primaryEmail:'visual-reviewer@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await owner.db.update(s.appUser).set({personId:subject.personId,onboardedAt:new Date()}).where(eq(s.appUser.id,b.adminUserId));
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:b.adminUserId,companyId:b.companyId,role:'employee'});
 const claimType=await createClaimType(adminCtx(b),{code:'VISUAL',name:'Fictional visual claim',defaultTaxable:false,requiresReceipt:false});
 await setClaimPolicy(adminCtx(b),{claimTypeId:claimType.id,annualBudget:100,perClaimCap:100,effectiveFrom:'2024-01-01'});
 const origin='http://127.0.0.1:3159';preview=new OwnedVisualPreview(origin,join(evidence,'operational-preview.log'),signal,evidence);
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();
 await context.addCookies([{name:'dev_user',value:b.adminUserId,url:origin},{name:LOCALE_COOKIE,value:'en',url:origin}]);
 const routes=['/admin/settings/system-labels','/roster','/rewards','/admin/personnel','/attendance/daily','/payroll','/me','/claims','/approvals','/leave','/leave/employee-balances','/leave/employee-records','/reports','/reports/employee-master/new','/recruitment','/analytics','/admin/settings/people','/'];
 const checks:unknown[]=[];
 for(let index=0;index<routes.length;index+=2){
  signal.throwIfAborted();await preview.start();
  for(const route of routes.slice(index,index+2)){
   const page=await context.newPage();page.setDefaultTimeout(60000);
   for(const [device,width,height] of [['desktop',1440,1050],['mobile',390,844]] as const){
    signal.throwIfAborted();await page.setViewportSize({width,height});
    const response=await page.goto(origin+route,{waitUntil:'domcontentloaded',timeout:120000});
    expect(response?.status()).toBe(200);expect(new URL(page.url()).pathname).toBe(route);
    await page.locator('main h1').first().waitFor();
    await page.waitForLoadState('load');
    await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
    if(route.endsWith('system-labels'))await page.locator('[data-label-import-ready="true"]').waitFor();
    expect(await page.locator('main').innerText()).not.toMatch(/MISSING_MESSAGE|INVALID_MESSAGE|Application error/);
    const metrics=await page.evaluate(()=>{const main=document.querySelector('main')!;return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,mainWidth:main.getBoundingClientRect().width,mainClientWidth:main.clientWidth,mainScrollWidth:main.scrollWidth};});
    expect(metrics.documentWidth).toBeLessThanOrEqual(width+1);expect(metrics.mainWidth).toBeGreaterThan(250);expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth+1);
    const key=route.split('/').filter(Boolean).join('-')||'today';
    await page.screenshot({path:join(evidence,`operational-${key}-${device}.png`),fullPage:true});
    if(route.endsWith('system-labels')){
     const help=page.locator('[data-label-import] details');expect(await help.getAttribute('open')).toBeNull();await help.locator('summary').click();
     await help.getByText(en.admin.systemLabels.criteriaHelp,{exact:true}).waitFor();await help.getByText(en.systemLabelExchange.scopeHelp,{exact:true}).waitFor();
     await page.screenshot({path:join(evidence,`operational-label-guidance-${device}.png`),fullPage:true});
    }
    if(route==='/roster'){
     const help=page.locator('[data-roster-guidance]');expect(await help.getAttribute('open')).toBeNull();await help.locator('summary').click();await help.getByText(en.roster.manageShiftsHint,{exact:true}).waitFor();
     expect(await help.getByRole('link',{name:en.roster.manageShiftsLink+' →'}).getAttribute('href')).toBe('/admin/attendance');
    }
    if(route==='/rewards'){
     const link=page.getByRole('link',{name:en.nav.rewardsAllReviews,exact:true}).filter({visible:true});expect(await link.count()).toBeGreaterThan(0);expect(await link.last().getAttribute('href')).toBe('/rewards/reviews');
    }
    const scrollable=await page.locator('main').evaluate(element=>element.scrollHeight>element.clientHeight+20);
    if(scrollable){await page.locator('main').evaluate(element=>{element.scrollTop=element.scrollHeight;});await page.screenshot({path:join(evidence,`operational-${key}-${device}-bottom.png`),fullPage:true});}
    checks.push({route,device,...metrics});writeFileSync(join(evidence,'operational-visual-progress.json'),JSON.stringify({source:process.env.AIHR_CI_HEAD,complete:false,checks},null,2));
   }
   await page.close();
  }
  await preview.stop();
 }
 await context.close();expect(checks).toHaveLength(routes.length*2);
 writeFileSync(join(evidence,'operational-authenticated-visual-results.json'),JSON.stringify({source:process.env.AIHR_CI_HEAD,fixture:'fictional isolated authenticated HR administrator with own employment',complete:true,checks},null,2));
 // Nine bounded pairs, measured from the 15-minute combined timeout in 44577652028; Excel/languages run separately.
},900000);
