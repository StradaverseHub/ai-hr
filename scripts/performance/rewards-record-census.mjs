import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

const budgetMs=20000;

export async function measureRewardsRecords({db,fixture,origin,compiledPages,signedInContext,report,save}){
 const tenant=fixture.tenants[0];
 const target=tenant.rewardDraft;
 const user=fixture.users.find(actor=>actor.tenant===0&&actor.role==='groupHR');
 assert(target?.unitId&&target.expectedEmploymentIds?.length&&user,'Missing authorized annual Rewards fixture');
 report.fixture.rewardsDraftSeeded=true;
 const draft={id:target.unitId,name:target.planName};

 const entries=await db`select id,source->>'name' as name,source->>'employeeCode' as employee_code
  from reward_entry where tenant_id=${tenant.tenantId}::uuid and unit_id=${draft.id}::uuid
  order by source->>'employeeCode',id`;
 const person=entries[0];
 assert(person?.name&&person.employee_code,'Missing persisted employee snapshot');
 const review='/rewards/'+draft.id;
 const configuration='/admin/rewards/'+draft.id;
 const setup='/admin/rewards/review-setup/'+draft.id;
 const planHeading=page=>page.locator('main h1').filter({hasText:draft.name});
 const checklist=page=>page.locator('main nav a[aria-current="step"][href^="'+setup+'?step="]');
 const backToUnit=page=>page.locator('main a[href="'+review+'"]');
 const cases=[
  {surface:'annual-configuration',template:'/admin/rewards/[unitId]',path:configuration+'?mode=view',
   witnesses:page=>[planHeading(page)]},
  {surface:'annual-review',template:'/rewards/[unitId]',path:review,
   witnesses:page=>[planHeading(page),page.locator('main #people')]},
  {surface:'review-setup',template:'/admin/rewards/review-setup/[unitId]',path:setup,
   witnesses:page=>[checklist(page),backToUnit(page)]},
  {surface:'old-setup-link',template:'/rewards/[unitId]/setup',path:review+'/setup',finalPath:setup,
   witnesses:page=>[checklist(page),backToUnit(page)]},
  {surface:'data-check',template:'/rewards/[unitId]/data-check',path:review+'/data-check',
   witnesses:page=>[backToUnit(page),page.locator('main tbody').getByText(person.employee_code+' · '+person.name,{exact:true})]},
  {surface:'reward-person',template:'/rewards/[unitId]/people/[entryId]',path:review+'/people/'+person.id,
   witnesses:page=>[page.locator('main').getByRole('heading',{name:person.name,level:1,exact:true}),backToUnit(page)]},
 ];
 assert(cases.every(route=>compiledPages.has(route.template)),'Missing compiled Rewards page');
 report.fixtureRecordVisits=[];
 for(const route of cases){
  const context=await signedInContext(user);
  try{
   const page=await context.newPage();
   for(const visit of ['first','repeat']){
    const row={surface:route.surface,template:route.template,role:'groupHR',visit,status:'failed',step:'document'};
    report.fixtureRecordVisits.push(row);
    const started=performance.now();
    const remaining=()=>Math.max(1,Math.ceil(budgetMs-(performance.now()-started)));
    try{
     const response=await page.goto(origin+route.path,{waitUntil:'domcontentloaded',timeout:remaining()});
     row.statusCode=response?.status()??null;
     assert.equal(row.statusCode,200);
     assert.equal(page.url(),origin+(route.finalPath??route.path));
     row.documentMs=Math.round(performance.now()-started);
     row.step='usable-content';
     for(const witness of route.witnesses(page)){
      await witness.first().waitFor({state:'visible',timeout:remaining()});
     }
     row.readyMs=Math.round(performance.now()-started);
     row.status='observed';
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
 assert.equal(report.fixtureRecordVisits.filter(row=>row.status==='observed').length,2*cases.length,
  'A populated Rewards visit did not reach authorized content');
 report.complete=true;
 save();
}
