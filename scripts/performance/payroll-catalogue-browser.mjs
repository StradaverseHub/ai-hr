import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const timeout=30000;
const messages=locale=>JSON.parse(readFileSync(join(process.cwd(),'messages',locale+'.json'),'utf8'));

export async function measurePayrollCatalogue({origin,fixture,signedInContext,observeStartup,documentTiming,readyContent,report,save}){
  const [group,company]=fixture.users;
  assert.equal(group.role,'groupHR');
  assert.equal(company.role,'companyHR');
  const [year,month]=fixture.month.split('-').map(Number);
  assert(year>1900&&month>=1&&month<=12);
  const path='/payroll?year='+year+'&m='+month+'&status=draft';
  const english=messages('en');
  const cases=['en','ms','zh','ta','th','vi'].map(locale=>({locale,actor:group}));
  cases.push({locale:'en',actor:company});
  const results=report.payrollCatalogue=[];
  for(const {locale,actor} of cases){
    const row={locale,role:actor.role,step:'document',outcome:'missing',translationErrors:0,pageErrors:0,visits:[]};
    results.push(row);
    const translation=messages(locale);
    const label=key=>translation.payroll?.list?.[key]||english.payroll.list[key];
    const cancel=translation.components?.confirmSubmit?.cancel||english.components.confirmSubmit.cancel;
    const context=await signedInContext(actor);
    try{
      await context.addCookies([{name:'NEXT_LOCALE',value:locale,url:origin}]);
      const page=await context.newPage();
      page.setDefaultTimeout(timeout);
      await page.addInitScript(observeStartup);
      page.on('pageerror',()=>row.pageErrors++);
      page.on('console',message=>{
        if(/MISSING_MESSAGE|IntlError/.test(message.text()))row.translationErrors++;
      });
      const main=page.locator('main');
      const title=main.getByRole('heading',{name:label('title'),level:1,exact:true});
      const draft=main.locator(`form:has(input[name="batchId"][value="${actor.batchId}"])`);
      const trigger=draft.getByRole('button',{name:label('deleteDraft'),exact:true});
      const dialog=page.getByRole('alertdialog',{name:label('deleteDraftTitle'),exact:true});
      for(const visit of ['first','repeat']){
        row.step='document';
        const started=performance.now();
        const response=await page.goto(origin+path,{waitUntil:'domcontentloaded',timeout});
        assert.equal(response?.status(),200);
        assert.equal(await page.locator('html').getAttribute('lang'),locale);
        const document={visit,documentReadyMs:Math.round(performance.now()-started)};
        row.visits.push(document);
        row.step='dashboard';
        await title.waitFor({state:'visible'});
        await trigger.waitFor({state:'visible'});
        document.readyMs=Math.round(performance.now()-started);
        row.step='confirmation';
        await page.locator('button[data-tour="account"]:enabled').waitFor({state:'visible'});
        const clicked=performance.now();
        await trigger.click();
        await dialog.getByText(label('deleteDraftBody'),{exact:true}).waitFor({state:'visible'});
        const dismiss=dialog.getByRole('button',{name:cancel,exact:true});
        await dismiss.waitFor({state:'visible'});
        document.firstClickMs=Math.round(performance.now()-clicked);
        document.appScripts=(await documentTiming(page))?.appScripts;
        assert(document.appScripts?.decodedBodyBytes>0);
        await dismiss.click();
        await dialog.waitFor({state:'hidden'});
      }
      if(actor===group&&locale==='en'){
        row.step='client-navigation';
        await page.evaluate(()=>{window.__aihrPayrollCatalogueDocument=true;});
        const beforeHome=(await documentTiming(page)).appScripts;
        const openedHome=performance.now();
        await page.locator('[data-app-sidebar] a[href="/"]:visible').first().click();
        await page.waitForURL(url=>url.pathname==='/');
        assert.equal(await readyContent(page,actor,'/',()=>timeout,undefined,fixture),'usable-content');
        assert.equal(await page.evaluate(()=>window.__aihrPayrollCatalogueDocument),true);
        const homeMs=Math.round(performance.now()-openedHome);
        const afterHome=(await documentTiming(page)).appScripts;
        row.scopedNavigation={
          homeMs,
          scriptTransferBytes:afterHome.transferBytes-beforeHome.transferBytes,
          scriptDecodedBytes:afterHome.decodedBodyBytes-beforeHome.decodedBodyBytes,
        };
        await page.goBack({waitUntil:'commit',timeout});
        await page.waitForURL(url=>url.pathname==='/payroll');
        await trigger.waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>window.__aihrPayrollCatalogueDocument),true);
        const next=main.getByRole('link',{name:label('newRun'),exact:true});
        const selected=performance.now();
        await next.click();
        await page.waitForURL(url=>url.pathname==='/payroll/process');
        await main.getByRole('heading',{name:english.payroll.process.title,level:1,exact:true}).waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>window.__aihrPayrollCatalogueDocument),true);
        const processMs=Math.round(performance.now()-selected);
        const returning=performance.now();
        await page.goBack({waitUntil:'commit',timeout});
        await page.waitForURL(url=>url.pathname==='/payroll');
        await trigger.waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>window.__aihrPayrollCatalogueDocument),true);
        row.clientNavigation={processMs,returnMs:Math.round(performance.now()-returning)};
      }
      row.step='translation';
      assert.equal(row.translationErrors,0);
      assert.equal(row.pageErrors,0);
      row.outcome='observed';
    }catch(error){
      row.outcome=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser-failure';
    }finally{
      await context.close();
      save();
    }
  }
  assert(results.every(row=>row.outcome==='observed'),'The Payroll dashboard locale or first-click witness failed');
}
