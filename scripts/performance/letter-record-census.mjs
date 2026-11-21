import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { exerciseLetterDraft } from './letter-draft-browser.mjs';

export async function measureLetterRecords({db,fixture,origin,compiledPages,signedInContext,report,save}){
 const tenant=fixture.tenants[0],seed=tenant.letterDraft;
 const author=fixture.users.find(actor=>actor.index===seed?.authorIndex);
 assert(seed&&author?.role==='companyHR'&&author.companyId===seed.companyId,'Missing authorized Letters fixture');
 const budgetMs=30000;
 await exerciseLetterDraft({
  base:origin,context:signedInContext,fixture,db,report,save,
  withContext:async (context,work)=>{try{await work();}finally{await context.close();}},
  notePrimary:error=>{report.letterDraftFailure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';},
  noteEvidence:retain=>retain(),
  notePreflightStageFailure:(_error,stage)=>{report.letterDraftStage=stage;},
  visit:async(page,_actor,path)=>{
   const response=await page.goto(origin+path,{waitUntil:'domcontentloaded',timeout:budgetMs});
   assert.equal(response?.status(),200);
   assert.equal(page.url(),origin+path);
  },
 });
 assert.equal(report.letterDraftBrowser.status,'passed');
 const rows=await db`select b.id,l.reference from letter_generation_batch b
  join letter_record l on l.batch_id=b.id and l.tenant_id=b.tenant_id
  where b.tenant_id=${tenant.tenantId}::uuid and b.created_by=${author.userId}::uuid
   and b.template_version_id=${seed.versionId}::uuid and l.state='withdrawn'`;
 assert.equal(rows.length,1,'The observed withdrawal needs one persisted base record');
 const [record]=rows;
 const cases=[
  {surface:'letter-withdrawn-draft',template:'/letters/generate/[batchId]',path:'/letters/generate/'+record.id,
   witness:page=>page.locator('main').getByRole('heading',{name:record.reference,exact:true})},
  {surface:'letter-approved-template',template:'/letters/templates/[versionId]',path:'/letters/templates/'+seed.versionId,
   witness:page=>page.locator('main').getByRole('heading',{name:seed.name,level:1,exact:true})},
 ];
 assert(cases.every(route=>compiledPages.has(route.template)),'Missing compiled Letters page');
 report.fixtureRecordVisits=[];
 for(const route of cases){
  const context=await signedInContext(author);
  try{
   const page=await context.newPage();
   for(const visit of ['first','repeat']){
    const row={surface:route.surface,template:route.template,visit,role:'companyHR',status:'failed'};
    const started=performance.now();
    const remaining=()=>Math.max(1,Math.ceil(budgetMs-(performance.now()-started)));
    report.fixtureRecordVisits.push(row);
    try{
     const response=await page.goto(origin+route.path,{waitUntil:'domcontentloaded',timeout:remaining()});
     assert.equal(response?.status(),200);
     assert.equal(page.url(),origin+route.path);
     await route.witness(page).waitFor({state:'visible',timeout:remaining()});
     row.readyMs=Math.round(performance.now()-started);
     row.status='observed';
    }catch(error){
     row.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
    }finally{save();}
   }
  }finally{await context.close();}
 }
 assert(report.fixtureRecordVisits.every(row=>row.status==='observed'),'A populated Letters visit missed its exact readiness witness');
 report.complete=true;
 save();
}
