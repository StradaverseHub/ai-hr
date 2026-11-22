import assert from 'node:assert/strict';
import {serverActionCoverage} from './system-route-manifest.mjs';

const timeout=15000;

export async function measureAttendanceScheduleSave({db,fixture,origin,signedInContext,registrations,report,save}){
  const [actor]=fixture.users;
  assert.equal(actor.role,'groupHR');
  const {ruleId}=fixture.attendanceConfigurationRecords;
  const template='/admin/attendance/schedule/[ruleId]/edit';
  const path='/admin/attendance/schedule/'+ruleId+'/edit';
  const readRule=async()=>{
    const [row]=await db`
      select late_grace_period_minutes as minutes from attendance_rule
      where id=${ruleId}::uuid and tenant_id=${actor.tenantId}::uuid and is_default
    `;
    return row?.minutes;
  };
  const eventActors=()=>db`
    select actor_id from domain_event
    where tenant_id=${actor.tenantId}::uuid and aggregate_id=${ruleId}::uuid
      and aggregate_type='attendance-rule' and event_type='attendance-rule.updated'
    order by sequence
  `;
  const row={template,role:actor.role,step:'before',outcome:'missing'};
  report.attendanceScheduleSave=row;
  const exercised=new Set();
  let context;
  try{
    const before=await readRule();
    assert(Number.isSafeInteger(before)&&before>=0);
    const change=before===7?8:7;
    const priorEvents=await eventActors();
    row.step='open';
    context=await signedInContext(actor);
    const page=await context.newPage();
    page.setDefaultTimeout(timeout);
    const response=await page.goto(origin+path+'?section=attendance',{waitUntil:'load',timeout});
    assert.equal(response?.status(),200);
    await page.getByRole('heading',{name:'Edit Schedule Group',exact:true}).waitFor();
    const form=page.locator('form:has(input[name="attendanceFlagsEditor"][value="1"])');
    const input=form.locator('input[name="lateGracePeriodMinutes"]');
    const button=form.getByRole('button',{name:'Save Attendance settings',exact:true});
    row.step='prepare';
    assert.equal(await input.inputValue(),String(before));
    await input.fill(String(change));
    await button.click({trial:true});
    row.step='submit';
    const started=performance.now();
    const [saved]=await Promise.all([
      page.waitForResponse(candidate=>{
        const url=new URL(candidate.url());
        return url.origin===origin&&url.pathname===path&&candidate.request().method()==='POST'&&
          registrations.get(candidate.request().headers()['next-action'])?.has(template);
      },{timeout}),
      button.click(),
    ]);
    row.responseMs=Math.round(performance.now()-started);
    row.httpStatus=saved.status();
    assert(saved.status()>=200&&saved.status()<400);
    await page.waitForURL(url=>url.pathname===path&&url.searchParams.get('section')==='attendance'&&
      /^[a-f0-9]{32}$/.test(url.searchParams.get('saveAck')??''),{timeout});
    await form.and(page.locator('form[data-attendance-saved-receipt]:not([aria-busy="true"])')).waitFor({state:'visible'});
    assert.equal(await input.inputValue(),String(change));
    row.usableMs=Math.round(performance.now()-started);
    row.step='verify';
    assert.equal(await readRule(),change);
    const events=await eventActors();
    assert.deepEqual(events.slice(priorEvents.length).map(event=>event.actor_id),[actor.userId]);
    exercised.add(saved.request().headers()['next-action']);
    row.outcome='observed';
  }catch(error){
    row.outcome=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser-failure';
  }finally{
    report.serverActionInventory=serverActionCoverage(registrations,exercised);
    if(context)await context.close();
    save();
  }
  assert.equal(row.outcome,'observed','The Schedule Group save missed its visible or durable outcome');
}
