/** Opt-in fictional Attendance action. It never contributes samples to the 500 HTTP action mix. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';
import {performanceFixtureCalendar} from './fixture-workload.mjs';

const timeout=90000;
export const attendanceRejectionProbeEnabled=process.env.PERF_ATTENDANCE_REJECTION_BROWSER==='1'||
 process.env.PERF_HTTP_SUITE==='workflow-preflight';

export function attendanceRejectionSubjects(users){
 const subjects=users.filter(user=>user.tenant===0&&user.company===0&&user.role==='employee'&&user.index%2===0&&user.index>=6)
  .sort((a,b)=>a.index-b.index).slice(0,2);
 assert.equal(subjects.length,2,'Attendance rejection probe requires two distinct reserved fixture employees');
 return subjects;
}

export function attendanceCorrectionForm(page){
 return page.locator('main form').filter({
  has:page.getByRole('button',{name:'Submit correction',exact:true}),
 }).filter({visible:true});
}

export async function prepareAttendanceRejection({context,visit,fixture,db,report,save,phase}){
 const {attendanceHistory,components}=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
 const subject=attendanceRejectionSubjects(fixture.users)[phase==='loaded'?1:0];
 const approver=fixture.users.find(user=>user.tenant===subject.tenant&&user.company===subject.company&&['companyHR','groupHR'].includes(user.role));
 assert(approver,'Missing fictional Attendance participant');
 const tenantId=fixture.tenants[subject.tenant].tenantId;
 // The original correction workload writes today. Original import work reserves offsets 2–90.
 const date=performanceFixtureCalendar(fixture.today).importDate(1);
 const marker='PERF_ATTENDANCE_REJECTION_'+phase.toUpperCase();
 const reason='Fictional correction rejected in '+phase+' performance probe';

 // The tour can mount after visit returns on a fresh browser. Dismiss it through
 // the real UI before actionability checks proceed.
 async function handleWelcomeTour(page){
  const tour=page.getByRole('dialog',{name:'Product tour',exact:true});
  await page.addLocatorHandler(tour,async()=>{
   await tour.getByRole('button',{name:'Skip',exact:true}).click({timeout});
   report.onboardingTourDismissals=(report.onboardingTourDismissals??0)+1;
  });
 }
 const evidence={phase,status:'preparing',syntheticSubjectIndex:subject.index};
 (report.attendanceRejectionBrowser??=[]).push(evidence);
 save();

 async function snapshot(){
  const [day]=await db`select id,to_jsonb(a) as row from attendance a where tenant_id=${tenantId}::uuid
    and employment_id=${subject.employmentId}::uuid and attendance_date=${date}::date`;
  assert(day,'Reserved Attendance day missing');
  const punches=await db`select to_jsonb(p) as row from attendance_punch p where attendance_id=${day.id}::uuid order by id`;
  return {day:day.row,punches:punches.map(row=>row.row)};
 }

 const before=await snapshot();
 assert.equal(before.punches.length,2,'Nonempty two-punch fixture required');
 assert.deepEqual(before.punches.map(punch=>punch.direction).sort(),['in','out']);
 assert(before.punches.every(punch=>punch.voided_at===null));
 const employeeContext=await context(subject);
 try{
  const page=await employeeContext.newPage(),path='/attendance/my-records/'+date;
  await visit(page,subject,path,'attendance-rejection-setup');
  await handleWelcomeTour(page);
  const form=attendanceCorrectionForm(page);
  await form.locator('input[type="time"][name="checkIn"]').fill('09:15',{timeout});
  await form.locator('input[type="time"][name="checkOut"]').fill('17:15',{timeout});
  await form.locator('[name="reason"]').fill(marker,{timeout});
  // The tour dismissal also posts to the current route. Match this form's
  // fictional marker so its earlier response cannot satisfy the correction wait.
  const [response]=await Promise.all([
   page.waitForResponse(result=>{
    const request=result.request();
    return request.method()==='POST'&&new URL(request.url()).pathname===path&&
     request.postDataBuffer()?.includes(Buffer.from(marker));
   },{timeout}),
   form.locator('button[type="submit"]').click({timeout}),
  ]);
  const redirect=response.headers()['x-action-redirect']??response.headers().location;
  if(redirect){
   const outcome=new URL(redirect.split(';',1)[0],page.url()).searchParams;
   evidence.creationOutcome={
    corrected:outcome.get('corrected')==='1',
    correctionError:outcome.get('correctionError'),
    workflowProblem:outcome.has('workflowProblem'),
   };
  }
  evidence.creationStatus=response.status();
  save();
  assert([200,303].includes(response.status()),'Native Attendance creation response failed');
  if(evidence.creationOutcome)assert(evidence.creationOutcome.corrected,
   'Native Attendance creation did not report success: '+JSON.stringify(evidence.creationOutcome));
 }finally{await employeeContext.close();}
 const rows=await db`select c.id,c.request_kind,c.requested_ot_minutes,c.status,w.id as workflow_id,w.routing_version,w.current_stage
   from attendance_correction c left join attendance_workflow_request w on w.correction_id=c.id and w.tenant_id=c.tenant_id
   where c.tenant_id=${tenantId}::uuid and c.employment_id=${subject.employmentId}::uuid
     and c.attendance_date=${date}::date and c.reason=${marker}`;
 assert.equal(rows.length,1,'Expected one persisted Attendance correction for the submitted marker');
 const correction=rows[0];
 assert(correction.workflow_id,'Persisted Attendance correction has no workflow snapshot');
 assert.deepEqual([correction.request_kind,correction.requested_ot_minutes,correction.status,correction.routing_version,correction.current_stage],
  ['other',null,'pending',4,0]);
 const reviewerContext=await context(approver);
 try{
  const page=await reviewerContext.newPage(),path='/attendance/application-history/'+correction.id;
  await visit(page,approver,path,'attendance-rejection-setup');
  await handleWelcomeTour(page);
  const main=page.locator('main');
  const form=main.locator('form').filter({has:page.locator('input[name="action"][value="rejected"]')}).filter({visible:true});
  assert.equal(await form.locator('input[name="workflowParticipant"]').inputValue(),'0:0');
  await form.getByRole('button',{name:attendanceHistory.reject,exact:true}).click({timeout});
  const dialog=page.getByRole('alertdialog');
  await dialog.getByRole('textbox',{name:attendanceHistory.rejectionReason,exact:true}).fill(reason,{timeout});
  const confirm=dialog.getByRole('button',{name:components.confirmSubmit.confirm,exact:true});
  evidence.status='ready';
  save();

  return {
   async run({loadState=()=>({active:0,launched:0}),steadyUntil}={}){
    try{
     if(phase==='loaded'){
      assert(Number.isFinite(steadyUntil));
      while(performance.now()<steadyUntil){
       const {active,launched}=loadState();
       if(active===500&&launched===500)break;
       await pause(25);
      }
     }
     const started=performance.now(),start=loadState();
     evidence.startedWith=start;
     if(phase==='loaded')assert(start.active===500&&start.launched===500&&started<steadyUntil,
      'A full 500 active principals were not observed within the existing steady window');
     evidence.status='submitting';
     save();
     const sameAction=request=>request.method()==='POST'&&new URL(request.url()).pathname===path;
     const captureRequest=page.waitForRequest(sameAction,{timeout}).then(()=>{
      const requestAt=performance.now();
      evidence.postDispatchedWith=loadState();
      evidence.clickToPostMs=requestAt-started;
      evidence.postWithinSteadyWindow=phase==='loaded'?requestAt<steadyUntil:null;
      save();
     });
     const [response]=await Promise.all([
      page.waitForResponse(result=>sameAction(result.request()),{timeout}),
      captureRequest,
      confirm.click({timeout}),
     ]);
     evidence.responseMs=performance.now()-started;
     evidence.httpStatus=response.status();
     assert([200,303].includes(response.status()),'Native Attendance rejection response failed');
     await main.getByText(reason,{exact:true}).first().waitFor({state:'visible',timeout});
     await main.getByText(attendanceHistory.statuses.rejected,{exact:true}).first().waitFor({state:'visible',timeout});
     await form.waitFor({state:'hidden',timeout});
     assert.equal(new URL(page.url()).searchParams.has('error'),false);
     evidence.usableMs=performance.now()-started;
     evidence.usableWith=loadState();
     evidence.usableWithinSteadyWindow=phase==='loaded'?performance.now()<steadyUntil:null;
     save();
     const [saved]=await db`select status,reject_reason,decided_at from attendance_correction where id=${correction.id}::uuid`;
     assert.equal(saved?.status,'rejected');
     assert.equal(saved.reject_reason,reason);
     assert(saved.decided_at);
     const [decision]=await db`select decision,actual_user_id,participant_slot from attendance_workflow_participant_decision
       where request_id=${correction.workflow_id}::uuid`;
     assert.deepEqual({...decision},{decision:'rejected',actual_user_id:approver.userId,participant_slot:'0:0'});
     const events=await db`select event_type,actor_id,subject_employment_id,chain_seq::text,hash,prev_hash,payload
       from domain_event where tenant_id=${tenantId}::uuid and aggregate_id=${correction.id}::uuid
         and event_type in ('attendance-workflow.stage.decided','attendance-correction.rejected') order by chain_seq`;
     assert.deepEqual(events.map(event=>event.event_type),['attendance-workflow.stage.decided','attendance-correction.rejected']);
     assert(events.every(event=>event.actor_id===approver.userId&&event.subject_employment_id===subject.employmentId&&/^[a-f0-9]{64}$/.test(event.hash)));
     assert.equal(events[1].prev_hash,events[0].hash);
     assert.equal(BigInt(events[1].chain_seq),BigInt(events[0].chain_seq)+1n);
     assert.equal(events[1].payload.rejectReason,reason);
     assert.deepEqual(await snapshot(),before);
     if(phase==='loaded')assert(evidence.postDispatchedWith.active===500&&evidence.postWithinSteadyWindow,
      'The actual browser POST was dispatched outside the 500-active steady interval');
     Object.assign(evidence,{status:'passed',persisted:true,workflowDecisionVerified:true,linkedAuditEvents:2,unchangedPunches:2,unchangedAttendanceDay:true});
     save();
    }catch(error){
     evidence.status='failed';evidence.failure=error.name;save();throw error;
    }finally{await reviewerContext.close();}
   },
  };
 }catch(error){await reviewerContext.close();throw error;}
}
