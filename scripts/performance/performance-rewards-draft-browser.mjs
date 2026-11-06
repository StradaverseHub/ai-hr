/** Real browser writes against the disposable fixture. Drafts stay isolated and are never published. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const english=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
const cycleCopy=english.performance.list;
const rewardsCopy=english.rewards;
const budgetMs=90000;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function remaining(start){
 const ms=Math.ceil(budgetMs-(performance.now()-start));
 assert(ms>0,'draft browser action exceeded the existing workflow budget');
 return ms;
}
async function open(page,base,path){
 const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:budgetMs});
 assert(response?.status()===200&&new URL(page.url()).pathname===path,'draft browser lost the expected authenticated route');
}
function formWith(page,selector){
 return page.locator('main form').filter({has:page.locator(selector)});
}
async function submittedId(page,form,label,path,start){
 const button=form.getByRole('button',{name:label,exact:true});
 await button.click({timeout:remaining(start)});
 await page.waitForURL(url=>url.pathname.startsWith(path+'/')||url.pathname===path&&
  (url.searchParams.has('error')||url.searchParams.has('sharedError')),{waitUntil:'domcontentloaded',timeout:remaining(start)});
 const url=new URL(page.url()),id=url.pathname.slice(path.length+1);
 assert(uuid.test(id)&&!url.searchParams.has('error'),'draft action did not redirect to its exact new record');
 return id;
}
async function audit(db,tenantId,user,aggregateType,id,eventType){
 const rows=await db`select actor_id,actor_type,event_type,payload from domain_event
  where tenant_id=${tenantId}::uuid and aggregate_type=${aggregateType} and aggregate_id=${id}::uuid
  and event_type=${eventType}`;
 assert.equal(rows.length,1,'expected one canonical creation audit event');
 assert(rows[0].actor_type==='user'&&rows[0].actor_id===user.userId,'draft audit did not record the browser principal');
 return rows[0].payload;
}

async function createPerformance({base,page,user,target,tenantId,db,report,save}){
 const path='/performance',name='Fictional Performance draft '+randomUUID();
 const periodStart=target.year+'-01-01',periodEnd=target.year+'-12-31';
 await open(page,base,path);
 await page.locator('main summary').filter({hasText:cycleCopy.newCycle}).click({timeout:budgetMs});
 const form=formWith(page,'input[name="periodStart"]');
 await form.locator('input[name="name"]').fill(name);
 await form.locator('select[name="workflow"]').selectOption('standard');
 await form.locator('select[name="companyId"]').selectOption(target.companyId);
 await form.locator('input[name="periodStart"]').fill(periodStart);
 await form.locator('input[name="periodEnd"]').fill(periodEnd);

 const start=performance.now(),id=await submittedId(page,form,cycleCopy.createCycle,path,start);
 await page.getByRole('heading',{name,level:1,exact:true}).waitFor({state:'visible',timeout:remaining(start)});
 const visibleByMs=performance.now()-start;
 const rows=await db`select id,tenant_id,company_id,name,status,period_start::text,period_end::text,
  (select count(*)::integer from performance_review where cycle_id=review_cycle.id) as review_count
  from review_cycle where tenant_id=${tenantId}::uuid and name=${name}`;
 const [row]=rows;
 assert(rows.length===1&&row.id===id&&row.tenant_id===tenantId&&row.company_id===target.companyId&&row.name===name&&row.status==='draft'
  &&row.period_start===periodStart&&row.period_end===periodEnd&&row.review_count===0,'Performance draft state or scope mismatch');
 const payload=await audit(db,tenantId,user,'review-cycle',id,'review-cycle.created');
 assert(payload?.name===name&&payload.companyId===target.companyId&&payload.periodStart===periodStart&&payload.periodEnd===periodEnd,
  'Performance creation audit details did not match the submitted draft');
 (report.browserDraftWrites??=[]).push({module:'Performance',operation:'create company review-cycle draft',visibleByMs,scopeVerified:true,auditVerified:true,reviewCount:0});
 save();
 return {id,name};
}

async function createRewards({base,page,user,target,tenantId,db,report,save}){
 const path='/admin/rewards',name=target.planName;
 assert(target.planVersionId&&name,'missing independently approved Rewards fixture plan');
 await open(page,base,path+'/plans');
 await page.locator('main a[href="?version='+target.planVersionId+'"]').click({timeout:budgetMs});
 const form=formWith(page,'button[name="operation"][value="create"]');
 const start=performance.now();
 await form.getByRole('button',{name:english.rewardSetup.createReviews,exact:true}).click({timeout:remaining(start)});
 await page.waitForURL(url=>url.pathname===path+'/plans'&&(url.searchParams.has('saved')||url.searchParams.has('error')),{timeout:remaining(start)});
 assert.equal(new URL(page.url()).searchParams.get('error'),null,'approved Rewards plan creation was refused');
 await open(page,base,path);
 const draftRow=page.locator('main tr').filter({has:page.getByText(name,{exact:true})});
 await draftRow.locator('a[href$="?mode=view"]').click({timeout:remaining(start)});
 await page.waitForURL(url=>url.pathname.startsWith(path+'/')&&uuid.test(url.pathname.slice(path.length+1)),{timeout:remaining(start)});
 const id=new URL(page.url()).pathname.slice(path.length+1);
 await page.locator('main h1').filter({hasText:name}).waitFor({state:'visible',timeout:remaining(start)});
 const visibleByMs=performance.now()-start;
 const rows=await db`select u.id,u.tenant_id,u.company_id,u.business_unit_id,u.created_by,u.status,u.kind,
  u.snapshot_date::text,u.posted_batch_id,c.id as cycle_id,c.tenant_id as cycle_tenant_id,c.name,c.year,c.created_by as cycle_creator
  from reward_unit u join reward_cycle c on c.id=u.cycle_id where c.tenant_id=${tenantId}::uuid and c.name=${name}`;
 const [row]=rows;
 assert(rows.length===1&&row.id===id&&row.tenant_id===tenantId&&row.cycle_tenant_id===tenantId&&row.company_id===target.companyId
  &&row.business_unit_id===target.businessUnitId&&row.created_by===user.userId&&row.cycle_creator===user.userId
  &&row.status==='draft'&&row.kind==='annual'&&row.name===name&&row.year===target.year
  &&row.snapshot_date===target.snapshotDate&&row.posted_batch_id===null,'Rewards draft state or scope mismatch');
 const entries=await db`select employment_id from reward_entry where tenant_id=${tenantId}::uuid and unit_id=${id}::uuid`;
 assert.deepEqual(entries.map(row=>row.employment_id).sort(),[...target.expectedEmploymentIds].sort(),'Rewards draft snapshotted the wrong dated company roster');
 const seats=await db`select user_id,role from reward_member where tenant_id=${tenantId}::uuid and unit_id=${id}::uuid`;
 assert(seats.length===1&&seats[0].role==='gr'&&seats[0].user_id===user.userId,'Rewards draft did not assign its canonical creator seat');
 const payload=await audit(db,tenantId,user,'reward-unit',id,'reward-unit.created');
 assert(payload?.cycleId===row.cycle_id&&payload.employeeCount===entries.length,'Rewards creation audit did not match the persisted cycle and roster');
 (report.browserDraftWrites??=[]).push({module:'Rewards',operation:'create company annual unit draft',visibleByMs,scopeVerified:true,auditVerified:true,rosterCount:entries.length});
 save();
 return {id,name};
}

export async function exercisePerformanceRewardsDrafts({base,context,fixture,db,report,save}){
 assert.equal(report.suite,'workflow-preflight','draft witnesses are outside the 500-user workload');
 const user=fixture.users.find(actor=>actor.tenant===0&&actor.role==='groupHR');
 const scoped=fixture.users.find(actor=>actor.tenant===0&&actor.role==='companyHR');
 const foreign=fixture.users.find(actor=>actor.tenant===1&&actor.role==='groupHR');
 const tenant=fixture.tenants[0],target=tenant.rewardDraft;
 assert(user&&scoped&&foreign&&target&&target.companyId!==scoped.companyId,'missing isolated draft scope fixture');
 let performanceDraft,rewardsDraft;
 const actorContext=await context(user);
 try{
  const page=await actorContext.newPage();
  const tour=page.getByRole('dialog',{name:'Product tour',exact:true});
  await page.addLocatorHandler(tour,async()=>{
   await tour.getByRole('button',{name:'Skip',exact:true}).click({timeout:budgetMs});
   report.onboardingTourDismissals=(report.onboardingTourDismissals??0)+1;
  });
  performanceDraft=await createPerformance({base,page,user,target,tenantId:tenant.tenantId,db,report,save});
  rewardsDraft=await createRewards({base,page,user,target,tenantId:tenant.tenantId,db,report,save});
  // The list is the same surface used below for negative controls. Prove the positive draft is visible.
  await open(page,base,'/admin/rewards');
  await page.locator('main').getByText(rewardsDraft.name,{exact:true}).waitFor({state:'visible',timeout:budgetMs});
 }finally{await actorContext.close();}
 for(const [scope,actor]of [['other-company',scoped],['other-tenant',foreign]]){
  const boundaryContext=await context(actor);
  try{
   const page=await boundaryContext.newPage();
   const detailPath='/performance/'+performanceDraft.id;
   if(scope==='other-company'){
    // Standard cycle metadata is tenant-readable. The lifecycle action must still refuse a company outside the grant.
    await open(page,base,detailPath);
    await page.getByRole('heading',{name:performanceDraft.name,level:1,exact:true}).waitFor({state:'visible',timeout:budgetMs});
    await page.getByRole('button',{name:english.performance.cycle.openCycle,exact:true}).click({timeout:budgetMs});
    await page.waitForURL(url=>url.pathname===detailPath&&url.searchParams.has('error'),{timeout:budgetMs});
    assert.equal(new URL(page.url()).searchParams.get('error'),'Review cycle not found (or not visible)');
    const [cycle]=await db`select status,(select count(*)::integer from performance_review where cycle_id=review_cycle.id) as review_count,
     (select count(*)::integer from domain_event where tenant_id=review_cycle.tenant_id and aggregate_id=review_cycle.id
      and event_type='review-cycle.opened') as opened_events
     from review_cycle where tenant_id=${tenant.tenantId}::uuid and id=${performanceDraft.id}::uuid`;
    assert(cycle?.status==='draft'&&cycle.review_count===0&&cycle.opened_events===0,'out-of-company attempt changed the Performance draft');
   }else{
    await page.goto(base+detailPath,{waitUntil:'domcontentloaded',timeout:budgetMs});
    await page.getByRole('heading',{name:'404',exact:true}).waitFor({state:'visible',timeout:budgetMs});
    assert.equal(await page.locator('main').getByText(performanceDraft.name,{exact:true}).count(),0);
   }
   await open(page,base,'/admin/rewards');
   await page.getByRole('heading',{name:english.nav.rewardsReviewCycles,exact:true}).waitFor({state:'visible',timeout:budgetMs});
   const table=page.locator('main [data-tour="rewards-admin-units"]');
   await table.waitFor({state:'visible',timeout:budgetMs});
   assert.equal(await table.getByText(rewardsDraft.name,{exact:true}).count(),0,'out-of-scope Rewards draft is listed');
   // Setup now requires an explicit Group Rewards grant; HR alone must not expose the plan.
   await open(page,base,'/admin/rewards/plans');
   await page.getByText(english.rewardSetup.noAccess,{exact:true}).waitFor({state:'visible',timeout:budgetMs});
   assert.equal(await page.locator('main').getByText(target.planName,{exact:false}).count(),0,'out-of-scope approved Rewards plan is exposed');
   assert.equal(await page.locator('main button[name="operation"][value="create"]').count(),0,'out-of-scope plan creation is offered');
   (report.browserDraftWriteBoundaries??=[]).push({scope,performanceBoundary:scope==='other-company'?'lifecycle-write-denied':'detail-denied',rewardsListHidden:true,rewardsPlanDenied:true});
   save();
  }finally{await boundaryContext.close();}
 }
}
