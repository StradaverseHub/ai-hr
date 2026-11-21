import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

export async function measureLeaveBalanceReadiness({fixture,origin,compiledPages,signedInContext,report,save}){
 const path='/leave/employee-balances';
 assert(compiledPages.has(path),'The Leave Balances page is absent from the measured build');
 const cases=[
  {role:'groupHR',size:25},{role:'groupHR',size:50},{role:'groupHR',size:100},{role:'groupHR',size:50,mode:'selected'},
  {role:'companyHR',size:25},{role:'companyHR',size:50},{role:'companyHR',size:50,mode:'selected'},
  {role:'companyHR',size:50,mode:'other-company'},
 ];
 report.leaveBalanceVisits=[];
 for(const {role,size,mode='all'} of cases){
  const actor=fixture.users.find(candidate=>candidate.tenant===0&&candidate.role===role);
  assert(actor,'Missing authorized Leave Balances actor');
  const anotherCompany=mode==='other-company';
  const target=fixture.users.find(user=>user.tenant===0&&user.role==='employee'
   &&(anotherCompany?user.companyId!==actor.companyId:user.companyId===actor.companyId));
  assert(target?.employmentId&&target.name,'The Leave Balances fixture is incomplete');
  const query=new URLSearchParams({size:String(size),asOf:fixture.today});
  if(mode!=='all')query.set('emp',target.employmentId);
  const expected=origin+path+'?'+query;
  const context=await signedInContext(actor);
  try{
   const page=await context.newPage();
   const tour=page.getByRole('dialog',{name:'Product tour',exact:true});
   await page.addLocatorHandler(tour,()=>tour.getByRole('button',{name:'Skip',exact:true}).click());
   for(const visit of ['first','repeat']){
    const row={role,size,mode,visit,status:'failed',step:'document'};
    report.leaveBalanceVisits.push(row);
    const started=performance.now();
    const remaining=()=>Math.max(1,Math.ceil(45000-(performance.now()-started)));
    try{
     const response=await page.goto(expected,{waitUntil:'domcontentloaded',timeout:remaining()});
     row.documentMs=Math.round(performance.now()-started);
     assert.equal(response?.status(),200);
     assert.equal(page.url(),expected);
     row.step='usable-content';
     const table=page.getByTestId('employee-balances-table');
     if(anotherCompany){
      await page.locator('main').getByRole('alert').waitFor({state:'visible',timeout:remaining()});
      assert.equal(await table.count(),0,'An out-of-company balance table was rendered');
     }else{
      const rows=table.locator('tbody tr:has(> td:nth-child(2))');
      await rows.first().waitFor({state:'visible',timeout:remaining()});
      const names=await rows.locator('td:nth-child(2)').allTextContents();
      assert(names.length>0&&names.length<=size);
      if(mode==='selected')assert(names.every(name=>name===target.name),'Selected balances contain a different employee');
      else assert(names.length===size&&new Set(names).size>1,'The page did not render the requested populated balance window');
      row.rows=names.length;
      row.distinctEmployees=new Set(names).size;
     }
     row.readyMs=Math.round(performance.now()-started);
     row.status=anotherCompany?'scope-denied':'observed';
     delete row.step;
    }catch(error){
     row.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
    }finally{
     save();
    }
   }
  }finally{
   await context.close();
  }
 }
 assert.equal(report.leaveBalanceVisits.filter(row=>row.status!=='failed').length,2*cases.length,
  'A Leave Balance visit did not reach its expected scoped result');
 report.complete=true;
 save();
}
