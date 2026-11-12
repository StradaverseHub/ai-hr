import assert from 'node:assert/strict';
import {test} from 'node:test';
import {attendanceCorrectionOutcome,readAttendanceCorrectionForm} from './mixed-workflows.mjs';

const actionId='a'.repeat(42),fingerprint='b'.repeat(64),date='2026-11-10';
const employmentId='afc2ab62-b20c-4ebb-867d-c4269da2bb21';
const scope={actionId,date,employmentId};
const url=new URL('/attendance/my-records/'+date+'?employmentId='+employmentId,'https://localhost:3443');
const action='<input type="hidden" name="$ACTION_ID_'+actionId+'">';
const ownerForm=`<form action="" encType="multipart/form-data" method="POST">
 ${action}<input type="hidden" name="date" value="${date}">
 <input type="hidden" name="employmentId" value="${employmentId}">
 <input type="hidden" name="workflowFingerprint" value="${fingerprint}">
 <fieldset><input type="time" name="checkIn"><input type="time" name="checkOut">
 <input name="reason" required><button type="submit">Submit correction</button></fieldset>
</form>`;

test('takes the fresh fingerprint only from the exact native scoped action form',()=>{
 const html=`<main><form><input name="workflowFingerprint" value="${'c'.repeat(64)}"></form></main>
  <script>self.__next_f.push(${JSON.stringify(ownerForm)})</script>
  <div hidden id="S:0">${ownerForm}</div>`;
 assert.equal(readAttendanceCorrectionForm(html,scope),fingerprint);
 assert.throws(()=>readAttendanceCorrectionForm(`<script>${JSON.stringify(ownerForm)}</script>`,scope),/Expected one captured action/);
});

test('refuses mismatched, duplicate, missing or disabled owner form controls',()=>{
 for(const html of [
  ownerForm.replace(actionId,'c'.repeat(42)),
  ownerForm.replace(date,'2026-11-09'),
  ownerForm.replace(employmentId,'c2ff73cf-2af4-4b51-a6ad-7cf7a37c5e1e'),
  ownerForm.replace(fingerprint,'unavailable'),
  ownerForm.replace('name="workflowFingerprint"','name="unrelated"'),
  ownerForm.replace('<fieldset>','<fieldset disabled>'),
  ownerForm.replace('action=""','action="/attendance/requests"'),
  ownerForm.replace(action,action+'<input type="hidden" name="$ACTION_REF_alternate">'),
  ownerForm.replace(action,action+'<input type="hidden" name="employmentId" value="'+employmentId+'">'),
  ownerForm+ownerForm,
 ])assert.throws(()=>readAttendanceCorrectionForm(html,scope));
});

test('reports only the closed correction outcome on the exact own-day redirect',()=>{
 const outcome=target=>attendanceCorrectionOutcome({headers:{'x-action-redirect':target}},url);
 const own=url.pathname+url.search;
 assert.equal(outcome(own+'&workflowRefusal=routeChanged;push'),'routeChanged');
 assert.equal(outcome(own+'&corrected=1;push'),'corrected');
 for(const query of ['workflowRefusal=arbitrary','correctionError=correctionRejected',
  'workflowRefusal=routeChanged&corrected=1','workflowRefusal=routeChanged&workflowRefusal=routeChanged',
  'corrected=1&corrected=1','corrected=1&workflowProblem=unresolved'])assert.equal(outcome(own+'&'+query),'refused');
 for(const target of [url.pathname+'?corrected=1',own+'&employmentId='+employmentId,
  'https://example.invalid'+own,own.replace(date,'2026-11-09')])assert.throws(()=>outcome(target),/redirect scope differs/);
});
