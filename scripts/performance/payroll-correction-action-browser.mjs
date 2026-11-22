import assert from 'node:assert/strict';
import {serverActionCoverage} from './system-route-manifest.mjs';

const timeout=15000;

export async function measurePayrollRemoval({db,fixture,origin,signedInContext,registrations,report,save}){
  const [actor, , , , subject]=fixture.users;
  const {tenantId,companies:[{batchId,historicalBatchId}]}=fixture.tenants[0];
  assert.equal(actor.role,'groupHR');
  assert.equal(actor.tenantId,tenantId);
  assert.equal(subject.companyId,actor.companyId);
  assert.equal(report.releaseEligible,false);
  assert.equal(report.payrollCorrectionRunPreserved,true);

  const template='/payroll/[batchId]/remove';
  const path='/payroll/'+batchId+'/remove';
  const reason='Fictional payroll correction verification';
  const readPayslips=id=>db`
    select employment_id,version,gross_pay::text,net_pay::text
    from payslip where batch_id=${id}::uuid and tenant_id=${tenantId}::uuid
    order by employment_id
  `;
  const readBatch=async()=>{
    const [row]=await db`select status from payroll_batch
      where id=${batchId}::uuid and tenant_id=${tenantId}::uuid`;
    return row?.status;
  };
  const audit=()=>db`select actor_id,payload->>'reason' as reason,
      payload->'employmentIds' as "employmentIds",payload->'payslipsRemoved' as "payslipsRemoved"
    from domain_event where tenant_id=${tenantId}::uuid and aggregate_id=${batchId}::uuid
      and aggregate_type='payroll-batch' and event_type='payroll-batch.employee-payroll-removed'
    order by sequence`;

  const row={template,role:actor.role,step:'before',outcome:'missing'};
  report.payrollRemovalAction=row;
  const exercised=new Set();
  let context;
  try{
    const [before,history,events,status]=await Promise.all([readPayslips(batchId),readPayslips(historicalBatchId),audit(),readBatch()]);
    assert.equal(status,'processed');
    assert.equal(events.length,0);
    assert(before.length>1);
    assert.equal(before.filter(slip=>slip.employment_id===subject.employmentId).length,1);
    assert(history.some(slip=>slip.employment_id===subject.employmentId));
    const remaining=before.filter(slip=>slip.employment_id!==subject.employmentId);

    row.step='open';
    context=await signedInContext(actor);
    const page=await context.newPage();
    page.setDefaultTimeout(timeout);
    assert.equal((await page.goto(origin+path,{waitUntil:'load',timeout}))?.status(),200);
    const main=page.getByRole('main');
    await main.getByRole('heading',{name:'Remove Employee Payroll',exact:true}).waitFor();
    const form=main.locator('form:has(textarea[name="reason"])');
    row.step='select';
    await form.locator('input[type="checkbox"][value="'+subject.employmentId+'"]').check();
    const selections=form.locator('input[name="employmentIds"]');
    assert.deepEqual(await selections.evaluateAll(inputs=>inputs.map(input=>input.value)),[subject.employmentId]);
    await form.locator('textarea[name="reason"]').fill(reason);
    await form.getByRole('button',{name:'Remove 1 employee payroll',exact:true}).click();
    const dialog=page.getByRole('alertdialog',{name:'Remove this payroll result?',exact:true});
    const confirm=dialog.getByRole('button',{name:'Remove payroll',exact:true});
    await confirm.click({trial:true});

    row.step='submit';
    const started=performance.now();
    const [saved]=await Promise.all([
      page.waitForResponse(candidate=>{
        const url=new URL(candidate.url());
        return url.origin===origin&&url.pathname===path&&candidate.request().method()==='POST'&&
          registrations.get(candidate.request().headers()['next-action'])?.has(template);
      },{timeout}),
      confirm.click(),
    ]);
    row.responseMs=Math.round(performance.now()-started);
    row.httpStatus=saved.status();
    assert(saved.status()>=200&&saved.status()<400);
    await page.waitForURL(url=>url.pathname===path&&url.searchParams.get('removed')==='1',{timeout});
    await main.getByText('1 employee payroll removed. '+remaining.length+' remain on this run.').waitFor({state:'visible'});
    row.usableMs=Math.round(performance.now()-started);

    row.step='read-stored-results';
    const [after,unchangedHistory,removals,currentStatus]=await Promise.all([
      readPayslips(batchId),readPayslips(historicalBatchId),audit(),readBatch(),
    ]);
    row.step='verify-run-state';
    assert.equal(currentStatus,'processed');
    row.step='verify-selected-removal';
    assert.equal(after.length,remaining.length);
    assert(!after.some(slip=>slip.employment_id===subject.employmentId));
    row.step='verify-other-payslips';
    assert.deepEqual([...after],[...remaining]);
    row.step='verify-closed-month';
    assert.deepEqual([...unchangedHistory],[...history]);
    row.step='verify-audit-count';
    assert.equal(removals.length,1);
    row.step='verify-audit-actor';
    assert.equal(removals[0].actor_id,actor.userId);
    row.step='verify-audit-payload';
    assert.deepEqual(removals[0],{actor_id:actor.userId,reason,employmentIds:[subject.employmentId],payslipsRemoved:1});
    exercised.add(saved.request().headers()['next-action']);
    row.outcome='observed';
  }catch(error){
    row.outcome=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser-failure';
  }finally{
    report.serverActionInventory=serverActionCoverage(registrations,exercised);
    if(context)await context.close();
    save();
  }
  assert.equal(row.outcome,'observed','The fictional payroll removal did not reach its visible and durable outcome');
}
