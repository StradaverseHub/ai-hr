/** Baseline witness for a closed synthetic Payroll run through the authenticated application. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const copy=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8')).payroll.batch;
const budgetMs=90000;
const pageSize=25;
const registerPath=batchId=>'/payroll/'+batchId;

function registerLocators(page){
 const main=page.locator('main');
 const header=main.locator('[data-ui-section-header]').filter({hasText:/^Payslips\s*\(\d+\)$/});
 const card=header.locator('..');
 return {main,header,card,pager:card.locator('[data-ui-pager]'),rows:card.locator('tbody tr')};
}

function remainingSince(start){
 const remaining=Math.ceil(budgetMs-(performance.now()-start));
 assert(remaining>0,'Payroll register exceeded the existing per-navigation browser budget');
 return remaining;
}

export async function exercisePayrollRegister({base,page,user,fixture,db,request,report,save}){
 assert.equal(user.role,'groupHR');
 const target=fixture.tenants[user.tenant].companies[2];
 const path=registerPath(target.historicalBatchId);
 const roster=fixture.users.filter(actor=>actor.tenant===user.tenant&&actor.companyId===target.companyId)
  .sort((a,b)=>a.index-b.index);
 assert.equal(roster.length,50,'Payroll register witness needs the two-page historical roster');
 const [stored]=await db`select totals from payroll_batch where id=${target.historicalBatchId}::uuid
  and company_id=${target.companyId}::uuid and status='closed'`;
 assert(stored?.totals&&Number(stored.totals.gross)>0&&Number(stored.totals.net)>0,'missing closed-run totals oracle');
 const {main,header,pager,rows}=registerLocators(page);
 const evidence=report.browserPayrollRegister??=[];
 async function verifyPage(pageIndex,start){
  const expected=roster.slice(pageIndex*pageSize,(pageIndex+1)*pageSize);
  await header.waitFor({state:'visible',timeout:remainingSince(start)});
  await rows.first().getByRole('link',{name:expected[0].name,exact:true})
   .waitFor({state:'visible',timeout:remainingSince(start)});
  await rows.last().getByRole('link',{name:expected.at(-1).name,exact:true})
   .waitFor({state:'visible',timeout:remainingSince(start)});
  const displayed=await rows.evaluateAll(items=>items.map(row=>({
   name:row.cells[1]?.querySelector('a')?.textContent?.trim(),
   code:row.cells[0]?.querySelector('a')?.textContent?.trim(),
  })));
  assert.equal(displayed.length,pageSize,'Payroll register did not show exactly one page');
  assert(displayed.every((row,i)=>row.name===expected[i].name&&row.code==='PERF'+String(expected[i].index).padStart(4,'0')),
   'Payroll register ordering or company roster did not match the fixture');
  assert((await header.innerText()).includes('(50)'),'Payroll register lost the full row count');
  for(const [label,key]of [[copy.totalGross,'gross'],[copy.totalDeductions,'deductions'],[copy.totalNet,'net'],[copy.totalEmployerCost,'employerCost']]){
   const tile=main.getByText(label,{exact:true}).locator('..');
   const content=await tile.innerText({timeout:remainingSince(start)});
   const value=content.match(/RM ([0-9,]+\.\d{2})/)?.[1];
   assert(value&&Number(value.replaceAll(',',''))===Number(Number(stored.totals[key]).toFixed(2)),
    'Payroll register total did not match the stored closed run');
  }
  remainingSince(start);
  return {visibleRows:displayed.length,exactTotalRows:roster.length,totalsMatch:true};
 }
 const next=pager.locator('a[href*="page=1"]').first();
 const initialStart=performance.now();
 const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:remainingSince(initialStart)});
 assert(response?.status()===200&&new URL(page.url()).pathname===path,'closed Payroll register did not open');
 const initial=await verifyPage(0,initialStart);
 await next.waitFor({state:'visible',timeout:remainingSince(initialStart)});
 evidence.push({kind:'initial-browser',elapsedMs:performance.now()-initialStart,...initial});save();

 const nextHref=await next.getAttribute('href',{timeout:budgetMs});
 const targetUrl=new URL(nextHref,base);
 assert(targetUrl.origin===base&&targetUrl.pathname===path&&targetUrl.searchParams.get('page')==='1','Payroll pager has no same-run page two link');
 let documents=0;
 const countDocument=request=>{if(request.resourceType()==='document')documents++;};
 page.on('request',countDocument);
 try{
  const clickStart=performance.now();
  await next.click({timeout:remainingSince(clickStart)});
  await page.waitForURL(url=>url.pathname===path&&url.searchParams.get('page')==='1',{waitUntil:'domcontentloaded',timeout:remainingSince(clickStart)});
  const second=await verifyPage(1,clickStart);
  evidence.push({kind:'page-two-browser-click',elapsedMs:performance.now()-clickStart,documentRequests:documents,...second});save();
 }finally{page.off('request',countDocument);}

 // Full-document SSR observations are separate from browser usability, after the browser reads.
 for(const [index,href]of [path,targetUrl.pathname+targetUrl.search].entries()){
  const {status,ttfbMs,durationMs,wireBytes,decodedBytes}=await request(user,href,undefined,200,false);
  evidence.push({kind:'warm-ssr-document',page:index+1,status,ttfbMs,durationMs,wireBytes,decodedBytes});save();
 }
}

export async function verifyPayrollRegisterBoundary({base,page,actor,owner,fixture,report,save}){
 const target=fixture.tenants[owner.tenant].companies[2];
 const foreign=actor.tenant!==owner.tenant;
 assert(foreign?actor.role==='groupHR':actor.role==='companyHR'&&actor.companyId!==target.companyId,
  'Payroll register boundary needs foreign group HR or out-of-company HR');
 const path=registerPath(target.historicalBatchId),start=performance.now();
 const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:remainingSince(start)});
 assert(response&&[200,404].includes(response.status()),'unexpected response for out-of-scope Payroll register');
 await page.getByRole('heading',{name:'404',exact:true}).waitFor({state:'visible',timeout:remainingSince(start)});
 const {main,header}=registerLocators(page);
 assert.equal(await header.count(),0,'out-of-scope Payroll register rendered a payslips section');
 assert.equal(await main.getByText(copy.totalNet,{exact:true}).count(),0,'out-of-scope Payroll register rendered totals');
 (report.browserPayrollRegister??=[]).push({kind:'scope-denial',scope:foreign?'other-tenant':'other-company',status:response.status(),denied:true});
 save();
}
