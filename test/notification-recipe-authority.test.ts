/** Canonical recipe binding models only; actual audience/RLS proof remains native. */
import {expect,it} from 'vitest';
import {createNotificationRegistry,assertNotificationRecipeAudience,type NotificationRecipientReaders,type NotificationPayload,type NotificationSpec} from '../core/notification-registry';
import {nativeNotificationReaderSupport,nativeNotificationRecipeImplemented,notificationWorkerProjectionContract,notificationWorkerAssessmentContract} from '../lib/notification-worker/projection';
type Probe={calls:Array<{port:string;selector?:string}>};
const subject='00000000-0000-4000-8000-000000000001',resolved='00000000-0000-4000-8000-000000000002';
const event={id:'00000000-0000-4000-8000-000000000003',aggregateId:'00000000-0000-4000-8000-000000000004',subjectEmploymentId:subject};
const port=(name:string)=>(state:Probe)=>{state.calls.push({port:name});return Promise.resolve([resolved]);};
const readers:NotificationRecipientReaders<Probe>={
 probation:port('probation'),contract:port('contract'),onboardingDigest:port('onboardingDigest'),assessmentReminder:port('assessmentReminder'),
 rewardSuspension:port('rewardSuspension'),rewardUploadChecker:port('rewardUploadChecker'),rewardUploadReady:port('rewardUploadReady'),rewardRouted:port('rewardRouted'),rewardPoolChanged:port('rewardPoolChanged'),rewardApproved:port('rewardApproved'),
 leaveSubmitted:port('leaveSubmitted'),leaveCancellationSubmitted:port('leaveCancellationSubmitted'),overtimeSubmitted:port('overtimeSubmitted'),readinessNudge:port('readinessNudge'),peerFeedback:port('peerFeedback'),
 assessmentReviewTask:(state,_event,phase)=>{state.calls.push({port:'assessmentReviewTask',selector:phase});return Promise.resolve([resolved]);},
 assessmentKpiApproval:port('assessmentKpiApproval'),legacyReviewStarted:port('legacyReviewStarted'),legacyReviewEvaluated:port('legacyReviewEvaluated'),legacyReviewDecidedLetter:port('legacyReviewDecidedLetter'),legacyReviewReminder:port('legacyReviewReminder'),
 delegationStarted:port('delegationStarted'),delegationEnded:port('delegationEnded'),leaveEscalation:port('leaveEscalation'),automaticReviewChase:port('automaticReviewChase'),
 missingClockFollowup:port('missingClockFollowup'),passportFollowup:port('passportFollowup'),lifecycleFollowup:port('lifecycleFollowup'),noticePublished:port('noticePublished'),payrollClosed:port('payrollClosed'),
 approvalChase:source=>state=>{state.calls.push({port:'approvalChase',selector:source});return Promise.resolve([resolved]);},
};
const registry=createNotificationRegistry(readers),recipes=Object.entries(registry).flatMap(([eventType,value])=>(Array.isArray(value)?value:[value]).map(spec=>({eventType,spec})));
const eligible=(spec:NotificationSpec<Probe>):NotificationPayload=>spec.recipientGuard?{[spec.recipientGuard.field]:spec.recipientGuard.not?false:true}:{};
const unsupported=new Set(['probation','leaveSubmitted','leaveCancellationSubmitted','overtimeSubmitted','readinessNudge','peerFeedback','assessmentReviewTask','assessmentKpiApproval','legacyReviewStarted','legacyReviewEvaluated','legacyReviewDecidedLetter','legacyReviewReminder','leaveEscalation','automaticReviewChase','missingClockFollowup','passportFollowup','lifecycleFollowup','approvalChase']);

it('executes every actual canonical recipe and independently observes its declared audience/reader binding',async()=>{
 expect(recipes).toHaveLength(63);const observed=new Set<string>();
 for(const {eventType,spec}of recipes){
  const state:Probe={calls:[]},value=spec.recipients?await spec.recipients(state,event,eligible(spec)):[subject];
  if(spec.recipientAudience==='reader'){
   expect(value,eventType+':'+spec.kind).toEqual([resolved]);expect(state.calls.map(call=>call.port)).toEqual([spec.recipientPort]);observed.add(spec.recipientPort);
   if(spec.recipientPort==='assessmentReviewTask')expect(state.calls[0].selector).toBe(eventType==='onehr.results-submitted'?'results':eventType==='onehr.competencies-submitted'?'competencies':'plan');
   if(spec.recipientPort==='approvalChase')expect(state.calls[0].selector).toBe(spec.kind==='claim.approval-overdue'?'claim':spec.kind==='attendance.approval-overdue'?'attendance_correction':'replacement_leave');
  }else{expect(state.calls).toEqual([]);expect(value).toEqual(spec.recipientAudience==='none'?[]:[subject]);}
  if(spec.recipientGuard){const denied:Probe={calls:[]};expect(await spec.recipients!(denied,event,{[spec.recipientGuard.field]:spec.recipientGuard.not?true:false})).toEqual([]);expect(denied.calls).toEqual([]);}
 }
 expect([...observed].sort()).toEqual(Object.keys(readers).sort());
});
it('retains exact shared native contract metadata while refusing every unsupported reader in both versions',()=>{
 for(const [version,contract]of [[2,notificationWorkerProjectionContract],[3,notificationWorkerAssessmentContract]]as const){
  expect(contract).toHaveLength(recipes.length);expect(new Set(contract.map(row=>row.eventType+'\0'+row.kind)).size).toBe(recipes.length);
  for(const {eventType,spec}of recipes){
   const expected=spec.recipientAudience!=='reader'||!unsupported.has(spec.recipientPort)&&!(spec.recipientPort==='assessmentReminder'&&version===2);
   expect(contract.find(row=>row.eventType===eventType&&row.kind===spec.kind)).toEqual({eventType,kind:spec.kind,category:spec.category,recipientPort:spec.recipientPort??null,audience:spec.recipientAudience,guard:spec.recipientGuard??null,implemented:expected});
   expect(nativeNotificationRecipeImplemented(spec,version)).toBe(expected);
  }
 }
 expect(Object.keys(nativeNotificationReaderSupport).sort()).toEqual(Object.keys(readers).sort());
 for(const [name,enabled]of Object.entries(nativeNotificationReaderSupport))expect(enabled).toBe(!unsupported.has(name));
});
it('makes all3 follow-ups explicit unsupported readers and preserves command-owned greeting none behavior',async()=>{
 const followups=recipes.filter(row=>row.eventType==='automatic-chase.followup-raised');expect(followups.map(row=>row.spec.kind)).toEqual(['attendance.missing-clock','profile.passport-expiry','lifecycle.step-waiting']);
 for(const {spec}of followups){expect(spec.recipientAudience).toBe('reader');expect(nativeNotificationRecipeImplemented(spec,3)).toBe(false);}
 const greeting=recipes.filter(row=>row.eventType==='employee-home.greeting.sent');expect(greeting).toHaveLength(1);expect(greeting[0].spec.recipientAudience).toBe('none');const state:Probe={calls:[]};expect(await greeting[0].spec.recipients!(state,event,{})).toEqual([]);expect(state.calls).toEqual([]);
});
it('refuses missing/unknown/inconsistent metadata rather than guessing subject or accepting a forged none resolver',()=>{
 for(const value of [{},null,[],{recipientAudience:'other'},{recipientAudience:'reader'},{recipientAudience:'reader',recipientPort:'caller',recipients:port('caller')},{recipientAudience:'reader',recipientPort:'probation'},
  {recipientAudience:'subject',recipientPort:'probation'},{recipientAudience:'subject',recipients:port('caller')},{recipientAudience:'none',recipients:async()=>[]}])expect(()=>assertNotificationRecipeAudience(value,readers)).toThrow();
 expect(()=>assertNotificationRecipeAudience({recipientAudience:'subject'},readers)).not.toThrow();
});
