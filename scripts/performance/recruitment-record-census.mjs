import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

async function verifyFeedbackSave({db,data,interviewer,page,origin,result}){
 const path='/recruitment/interviews/'+data.interviewId+'/feedback';
 const revised='Fictional scorecard browser save';
 const timeout=15000;
 const main=page.locator('main:visible').first();
 const overview=main.locator('textarea[name="overview"]:enabled');
 const submit=main.locator('form:has(textarea[name="overview"]) button[type="submit"]:enabled');
 result.stage='edit';
 await overview.fill(revised,{timeout});
 result.stage='first-click';
 const started=performance.now();
 const posted=page.waitForResponse(response=>response.url()===origin+path
  &&response.request().method()==='POST'&&Boolean(response.request().headers()['next-action']),{timeout});
 const [response]=await Promise.all([posted,submit.click({timeout})]);
 result.responseMs=Math.round(performance.now()-started);
 result.httpStatus=response.status();
 assert([200,303].includes(response.status()),'Native feedback save must succeed');
 result.stage='redirect';
 await page.waitForURL(url=>url.pathname==='/recruitment/applications/'+data.applicationId
  &&url.searchParams.get('tab')==='interviews'&&url.searchParams.get('notice')==='saved',{timeout});
 await main.getByRole('heading',{name:data.applicant,level:1,exact:true}).waitFor({state:'visible',timeout});
 result.readyMs=Math.round(performance.now()-started);
 result.stage='persistence';
 const [stored]=await db`
  select overview,interviewer_user_id from recruitment_scorecard
  where id=${data.scorecardId}::uuid and tenant_id=${interviewer.tenantId}::uuid
 `;
 assert(stored?.overview===revised&&stored.interviewer_user_id===interviewer.userId,'Expected the exact persisted feedback edit');
 result.persisted=true;
 result.status='observed';
 result.stage='complete';
}

export async function measureRecruitmentRecords({db,fixture,origin,compiledPages,signedInContext,report,save}){
 const data=fixture.recruitmentRecords;
 assert(data?.applicationId,'Missing fictional Recruitment record fixtures');
 const cases=[
  {surface:'requisition',root:'/recruitment/requisitions',id:data.requisitionId,name:data.reqTitle},
  {surface:'position',root:'/recruitment/positions',id:data.jobId,name:data.title},
  {surface:'application',root:'/recruitment/applications',id:data.applicationId,name:data.applicant},
  {surface:'scorecard',root:'/recruitment/scorecards',id:data.scorecardId,name:'Scorecard by '+data.interviewerName,
   witness:main=>main.getByText(data.overview,{exact:true})},
  {surface:'agency-contract',root:'/recruitment/settings/agencies/contracts',id:data.contractId,name:data.contractName,
   witness:main=>main.locator('#details-title + form input[name="name"]'),value:data.contractName},
  {surface:'agency-submission',root:'/recruitment/agency-submissions',id:data.submissionId,name:data.submissionName,
   witness:main=>main.locator('#submitted-title')},
 ];
 const feedback={surface:'interview-feedback',root:'/recruitment/interviews',id:data.interviewId,suffix:'/feedback',
  name:'Feedback on '+data.applicant,witness:main=>main.locator('textarea[name="overview"]'),value:data.overview};
 const template=route=>route.root+'/[id]'+(route.suffix??'');
 assert([...cases,feedback].every(route=>route.id&&compiledPages.has(template(route))),'Missing compiled Recruitment route or fixture');
 const sameCompany=fixture.users.find(user=>user.role==='companyHR'&&user.tenant===0&&user.companyId===data.companyId);
 const otherCompany=fixture.users.find(user=>user.role==='companyHR'&&user.tenant===0&&user.companyId!==data.companyId);
 const otherTenant=fixture.users.find(user=>user.role==='groupHR'&&user.tenant===1);
 const group=fixture.users.find(user=>user.role==='groupHR'&&user.tenant===0);
 const interviewer=fixture.users.find(user=>user.index===data.interviewerIndex);
 assert(sameCompany&&otherCompany&&otherTenant&&group&&interviewer,'Missing native Recruitment scope witnesses');
 report.fixtureRecordVisits=[];
 const cohorts=[
  ['group',group,cases,true],['company',sameCompany,cases,true],
  ['other-company',otherCompany,cases,false],['other-tenant',otherTenant,cases,false],
  ['interviewer',interviewer,[feedback],true],['not-interviewer',sameCompany,[feedback],false],
 ];
 for(const [access,actor,routes,allowed] of cohorts){
  const context=await signedInContext(actor);
  try{
   const page=await context.newPage();
   for(const route of routes)for(const visit of allowed?['first','repeat']:['first']){
    const row={surface:route.surface,template:template(route),role:actor.role,access,visit,status:'failed'};
    report.fixtureRecordVisits.push(row);
    const started=performance.now();
    const remaining=()=>Math.max(1,Math.ceil(30000-(performance.now()-started)));
    try{
     const url=origin+route.root+'/'+route.id+(route.suffix??'');
     let documentReadyMs;
     const documentReady=()=>{documentReadyMs=Math.round(performance.now()-started);};
     page.once('domcontentloaded',documentReady);
     try{
      const response=await page.goto(url,{waitUntil:'commit',timeout:remaining()});
      row.responseMs=Math.round(performance.now()-started);
      assert.equal(page.url(),url);
      row.statusCode=response?.status()??null;
      if(allowed){
       assert.equal(row.statusCode,200);
       const main=page.locator('main:visible').first();
       await main.getByRole('heading',{name:route.name,level:1,exact:true})
        .waitFor({state:'visible',timeout:remaining()});
       if(route.witness){
        const witness=route.witness(main);
        await witness.waitFor({state:'visible',timeout:remaining()});
        if(route.value!==undefined)assert.equal(await witness.inputValue({timeout:remaining()}),route.value);
       }
      }else{
       assert([200,404].includes(row.statusCode));
       await page.getByRole('heading',{name:'404',exact:true}).waitFor({state:'visible',timeout:remaining()});
       assert.equal(await page.getByText(route.name,{exact:true}).count(),0,'Restricted record name appeared');
      }
      row.readyMs=Math.round(performance.now()-started);
      await page.waitForLoadState('domcontentloaded',{timeout:remaining()});
      row.documentReadyMs=documentReadyMs??Math.round(performance.now()-started);
      row.status=allowed?'observed':'scope-denied';
     }finally{page.off('domcontentloaded',documentReady);}
    }catch(error){
     row.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
    }finally{save();}
   }
   if(access==='interviewer'&&report.fixtureRecordVisits.slice(-2).every(row=>row.status==='observed')){
    const result=report.recruitmentFeedbackSave={status:'failed'};
    try{await verifyFeedbackSave({db,data,interviewer,page,origin,result});}
    catch(error){
     result.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
    }finally{save();}
   }
  }finally{await context.close();}
 }
 assert.equal(report.fixtureRecordVisits.filter(row=>row.status==='observed').length,4*cases.length+2);
 assert.equal(report.fixtureRecordVisits.filter(row=>row.status==='scope-denied').length,2*cases.length+1);
 assert.equal(report.recruitmentFeedbackSave?.status,'observed','The first feedback save must persist');
 report.complete=true;
 save();
}
