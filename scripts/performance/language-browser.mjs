/** Real isolated production-renderer language changes; no HR write, auth bypass or500-user claim. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
assert.equal(process.env.GITHUB_ACTIONS,'true');
const fixture=JSON.parse(readFileSync(join(process.env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const base='https://localhost:3443',samples=[],errors=[],actions=[];
const names={en:'English',zh:'简体中文',ms:'Bahasa Melayu',ta:'தமிழ்',th:'ไทย',vi:'Tiếng Việt'};
const locales=['zh','ms','ta','th','vi','en'];
const english=JSON.parse(readFileSync('messages/en.json','utf8'));
const expected=Object.fromEntries(Object.keys(names).map(locale=>{const messages=JSON.parse(readFileSync('messages/'+locale+'.json','utf8'));return [locale,messages.people?.list?.adminTitle||english.people.list.adminTitle];}));
for(const [locale,heading] of Object.entries(expected))assert(typeof heading==='string'&&heading.trim().length>0,'missing independent Personnel heading for '+locale);
const report={kind:'LANGUAGE_SWITCH_HTTP_BROWSER_NOT_500_ACCEPTANCE',releaseEligible:false,sha:process.env.AIHR_CI_HEAD,resources:'one appworker, applicationpool10, heap4GiB, standard runner, original PostgreSQLprofile2',fixture:'500 fictional accounts,100kClaims,90kAttendance; single active browser; native sessions',navigationTargetMs:1000,samples,errors,actions,complete:false};
const save=()=>writeFileSync(join(process.env.PERF_EVIDENCE_DIR,'language-switch.json'),JSON.stringify(report,null,2));save();
let lastPage;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 const actor=fixture.users.find(user=>user.role==='groupHR');assert(actor,'real fictional HR actor missing');
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 await context.addCookies([{name:'__Host-aihr_internal',value:actor.token,url:base,secure:true,httpOnly:true,sameSite:'Lax'},{name:'NEXT_LOCALE',value:'en',url:base,secure:true,sameSite:'Lax'}]);
 const page=await context.newPage();lastPage=page;page.setDefaultTimeout(90000);
 page.on('pageerror',error=>{errors.push(String(error.message).slice(0,250));save();});
 page.on('response',response=>{const request=response.request();if(request.method()!=='POST')return;const timing=request.timing();actions.push({path:new URL(response.url()).pathname,status:response.status(),ttfbMs:timing.responseStart>=0?timing.responseStart-timing.requestStart:null});save();});
 const navigationStart=performance.now();
 report.personnel={status:'loading'};save();
 const response=await page.goto(base+'/admin/personnel',{waitUntil:'commit',timeout:90000});
 assert.equal(response.status(),200);assert(!page.url().includes('/login'));
 report.personnel.responseMs=performance.now()-navigationStart;save();
 await page.getByRole('heading',{level:1,name:expected.en,exact:true}).waitFor();
 const skip=page.getByRole('dialog').getByRole('button',{name:'Skip',exact:true});
 if(await skip.isVisible()){await skip.click();await skip.waitFor({state:'hidden'});report.welcomeTourDismissed=true;}
 assert((await page.locator('body').innerText()).includes(actor.name),'fixture actor identity is missing');
 await page.locator('main tbody tr').first().waitFor({state:'visible'});
 await page.getByRole('button',{name:'Change language',exact:true}).click({trial:true});
 report.personnel={...report.personnel,status:'usable',usableMs:performance.now()-navigationStart};
 save();
 await page.screenshot({path:join(process.env.PERF_EVIDENCE_DIR,'language-initial-en.png')});
 const originalPath=new URL(page.url()).pathname;
 for(let round=0;round<2;round++){
  const order=round===0?locales:['vi','th','ta','ms','zh','en'];
  for(const locale of order){
   const switcher=page.getByRole('button',{name:'Change language',exact:true});
   await switcher.click();
   const choice=page.getByRole('button',{name:names[locale],exact:true});
   await choice.click({trial:true});
   const before=actions.length,start=performance.now();
   await choice.click();
   await page.waitForFunction(locale=>document.documentElement.lang===locale,locale,{timeout:90000});
   await page.getByRole('heading',{level:1,name:expected[locale],exact:true}).waitFor();
   await page.waitForFunction(name=>document.querySelector('button[aria-label="Change language"]')?.getAttribute('title')===name,names[locale]);
   const translatedMs=performance.now()-start;
   await page.locator('main tbody tr').first().waitFor({state:'visible'});
   await switcher.click({trial:true});
   await page.evaluate(()=>document.fonts.ready.then(()=>true));
   const usableMs=performance.now()-start;
   assert.equal(new URL(page.url()).pathname,originalPath,'changing language navigated away');
   const cookie=(await context.cookies()).find(cookie=>cookie.name==='NEXT_LOCALE');assert.equal(cookie?.value,locale);
   samples.push({round,locale,translatedMs,usableMs,serverActions:actions.length-before,correctServerHeading:true,cookieCorrect:true,pathPreserved:true});save();
   await page.screenshot({path:join(process.env.PERF_EVIDENCE_DIR,'language-'+round+'-'+locale+'.png')});
  }
 }
 await page.getByRole('button',{name:'Change language',exact:true}).click();const active=page.getByRole('button',{name:'English',exact:true});
 report.activeLocaleDisabled=await active.isDisabled();
 if(!report.activeLocaleDisabled){const before=actions.length;await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'),active.click()]);report.unnecessaryActiveChoicePosts=actions.length-before;}else report.unnecessaryActiveChoicePosts=0;
 report.complete=true;const times=samples.map(row=>row.usableMs).sort((a,b)=>a-b);report.p50Ms=times[Math.ceil(times.length*.5)-1];report.p95Ms=times[Math.ceil(times.length*.95)-1];report.withinNavigationTarget=report.p95Ms<1000;save();
 assert.equal(errors.length,0);assert(samples.every(row=>row.serverActions===1),'a locale change must use exactly one action');assert.equal(report.activeLocaleDisabled,true,'current-language choice must not submit another full refresh');
 // A page-speed miss stays visible; this isolated single-reader test is never500-user acceptance.
 assert(report.withinNavigationTarget,'language change exceeds the unchanged1s navigation goal');
 await context.close();
}catch(error){report.error=String(error.message).slice(0,350);if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:join(process.env.PERF_EVIDENCE_DIR,'language-failure.png')}).catch(()=>{});throw error;}finally{save();await browser.close();}
