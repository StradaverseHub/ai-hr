import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export async function measureRecruitmentRecords({fixture,origin,compiledPages,signedInContext,report,save}){
 const data=fixture.recruitmentRecords;
 assert(data?.applicationId,'Missing fictional Recruitment record fixtures');
 const cases=[
  {surface:'requisition',root:'/recruitment/requisitions',id:data.requisitionId,name:data.reqTitle},
  {surface:'position',root:'/recruitment/positions',id:data.jobId,name:data.title},
  {surface:'application',root:'/recruitment/applications',id:data.applicationId,name:data.applicant},
 ];
 assert(cases.every(route=>compiledPages.has(route.root+'/[id]')),'Missing compiled Recruitment route');
 const sameCompany=fixture.users.find(user=>user.role==='companyHR'&&user.tenant===0&&user.companyId===data.companyId);
 const otherCompany=fixture.users.find(user=>user.role==='companyHR'&&user.tenant===0&&user.companyId!==data.companyId);
 const otherTenant=fixture.users.find(user=>user.role==='groupHR'&&user.tenant===1);
 const group=fixture.users.find(user=>user.role==='groupHR'&&user.tenant===0);
 assert(sameCompany&&otherCompany&&otherTenant&&group,'Missing native Recruitment scope witnesses');
 report.fixtureRecordVisits=[];
 for(const [access,actor] of [['group',group],['company',sameCompany],['other-company',otherCompany],['other-tenant',otherTenant]]){
  const allowed=access==='group'||access==='company';
  const context=await signedInContext(actor);
  try{
   const page=await context.newPage();
   for(const route of cases)for(const visit of allowed?['first','repeat']:['first']){
    const row={surface:route.surface,template:route.root+'/[id]',role:actor.role,access,visit,status:'failed'};
    report.fixtureRecordVisits.push(row);
    const started=performance.now();
    const remaining=()=>Math.max(1,Math.ceil(30000-(performance.now()-started)));
    try{
     const url=origin+route.root+'/'+route.id;
     const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:remaining()});
     assert.equal(page.url(),url);
     row.statusCode=response?.status()??null;
     if(allowed){
      assert.equal(row.statusCode,200);
      await page.locator('main').getByRole('heading',{name:route.name,level:1,exact:true})
       .waitFor({state:'visible',timeout:remaining()});
     }else{
      assert([200,404].includes(row.statusCode));
      await page.getByRole('heading',{name:'404',exact:true}).waitFor({state:'visible',timeout:remaining()});
      assert.equal(await page.getByText(route.name,{exact:true}).count(),0,'Restricted record name appeared');
     }
     row.readyMs=Math.round(performance.now()-started);
     row.status=allowed?'observed':'scope-denied';
    }catch(error){
     row.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
    }finally{save();}
   }
  }finally{await context.close();}
 }
 assert.equal(report.fixtureRecordVisits.filter(row=>row.status==='observed').length,12);
 assert.equal(report.fixtureRecordVisits.filter(row=>row.status==='scope-denied').length,6);
 report.complete=true;
 save();
}
