/** Dedicated same-tenant close test. Writes go through the existing browser actions. */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {performanceFixtureCalendar} from './fixture-workload.mjs';

export async function exerciseConcurrentPayrollClose({context,visit,fixture,db,request,capture,assertProcessed,report,save}){
 const tenant=fixture.tenants[0];
 const {publicationMonth,historicalMonth}=performanceFixtureCalendar(fixture.today);
 assert(publicationMonth<historicalMonth&&historicalMonth<fixture.month,'concurrent close needs a reserved past Payroll month');
 const lanes=[];
 const result={scenario:'same-tenant Payroll close in two separate companies',period:publicationMonth,closers:2,status:'preparing',results:[]};
 report.concurrentPayrollClose=result;
 save();
 try{
  for(const companyIndex of [3,4]){
   const company=tenant.companies[companyIndex];
   const batchId=company.concurrentCloseBatchId;
   assert(batchId&&![company.batchId,company.historicalBatchId,company.publicationBatchId].includes(batchId),'concurrent close must own a distinct synthetic batch');
   const admin=fixture.users.find(actor=>actor.tenant===0&&actor.company===companyIndex&&actor.role==='companyHR');
   const employee=fixture.users.find(actor=>actor.tenant===0&&actor.company===companyIndex&&actor.role==='employee');
   assert(admin&&employee&&admin.companyId===company.companyId&&employee.companyId===company.companyId,'concurrent close lacks scoped synthetic principals');
   const [batch]=await db`select tenant_id,company_id,pay_period,status,released_at from payroll_batch where id=${batchId}::uuid`;
   assert.deepEqual({...batch},{tenant_id:tenant.tenantId,company_id:company.companyId,pay_period:publicationMonth,status:'draft',released_at:null});
   const browserContext=await context(admin);
   const lane={browserContext,admin,employee,batchId,companyIndex};
   lanes.push(lane);
   const page=lane.page=await browserContext.newPage();
   await visit(page,admin,'/payroll/'+batchId);
   await page.getByRole('button',{name:'Process Payroll',exact:true}).click();
   await capture(page,()=>page.getByRole('alertdialog').getByRole('button',{name:'Process anyway',exact:true}).click(),'payrollConcurrentCloseProcess'+companyIndex);
   await assertProcessed(batchId);

   const [slip]=await db`select id from payslip where batch_id=${batchId}::uuid and employment_id=${employee.employmentId}::uuid`;
   assert(slip,'concurrent close lacks the employee payslip');
   lane.documentPath='/me/payslip/'+slip.id+'/pdf';
   await request(employee,lane.documentPath,undefined,404,false);
   await page.getByRole('button',{name:'Close batch',exact:true}).click();
   lane.confirm=page.getByRole('alertdialog').getByRole('button',{name:'Yes',exact:true});
   await lane.confirm.waitFor({state:'visible',timeout:90000});
  }

  assert.notEqual(lanes[0].batchId,lanes[1].batchId,'concurrent close fixture reused a batch');
  result.status='closing';
  save();
  const started=performance.now();
  const settled=await Promise.allSettled(lanes.map(async lane=>{
   const observeRequest=req=>{
    if(req.method()==='POST'&&req.headers()['next-action']&&new URL(req.url()).pathname==='/payroll/'+lane.batchId&&req.postData()?.includes(lane.batchId)){
     lane.closeRequest=req;
     lane.requestMs=performance.now()-started;
    }
   };
   const observeResponse=response=>{
    if(response.request()===lane.closeRequest)lane.responseMs=performance.now()-started;
   };
   lane.page.on('request',observeRequest);
   lane.page.on('response',observeResponse);
   try{
    await capture(lane.page,()=>lane.confirm.click(),'payrollConcurrentClose'+lane.companyIndex);
    const [batch]=await db`select status,released_at,employee_count from payroll_batch where id=${lane.batchId}::uuid`;
    assert.equal(batch.status,'closed');
    assert.equal(batch.employee_count,50);
    assert(batch.released_at&&new Date(batch.released_at).getTime()<=Date.now(),'close did not publish the reserved past run');
    const events=await db`select actor_id,payload from domain_event where aggregate_id=${lane.batchId}::uuid and event_type='payroll-batch.closed'`;
    assert.equal(events.length,1);
    assert.equal(events[0].actor_id,lane.admin.userId);
    assert.equal(new Date(events[0].payload.releasedAt).getTime(),new Date(batch.released_at).getTime());
    await request(lane.employee,lane.documentPath,undefined,200,false);
    const otherCompany=lanes.find(other=>other!==lane).employee;
    const otherTenant=fixture.users.find(actor=>actor.tenant!==0&&actor.role==='employee');
    assert(otherTenant);
    for(const actor of [otherCompany,otherTenant])await request(actor,lane.documentPath,undefined,404,false);
    assert(Number.isFinite(lane.requestMs)&&Number.isFinite(lane.responseMs)&&lane.responseMs>lane.requestMs,'close request/response timing missing');
    result.results.push({company:lane.companyIndex,requestMs:lane.requestMs,responseMs:lane.responseMs,employeeCount:50,closedEvents:1,published:true,scopeDenials:2});
    save();
   }finally{
    lane.page.off('request',observeRequest);
    lane.page.off('response',observeResponse);
   }
  }));
  const failures=settled.filter(outcome=>outcome.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(outcome=>outcome.reason),'Payroll close/publication lane failed');
  result.overlapMs=Math.min(...lanes.map(lane=>lane.responseMs))-Math.max(...lanes.map(lane=>lane.requestMs));
  assert(result.overlapMs>0,'Payroll close POSTs did not overlap');
  result.status='passed';
  save();
 }catch(error){
  result.status='failed';
  save();
  throw error;
 }finally{
  await Promise.allSettled(lanes.map(lane=>lane.browserContext.close()));
 }
}
