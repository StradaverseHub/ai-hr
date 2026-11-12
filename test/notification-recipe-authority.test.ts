/** Canonical recipe binding models only; actual audience/RLS proof remains native. */
import {expect,it} from 'vitest';
import {createNotificationRegistry,assertNotificationRecipeAudience,type NotificationRecipientReaders,type NotificationPayload,type NotificationSpec,type EventRef} from '../core/notification-registry';
import {nativeNotificationReaderSupport,nativeNotificationRecipeImplemented,notificationWorkerProjectionContract,notificationWorkerAssessmentContract,notificationWorkerProjection,UnsupportedNotificationFacts} from '../lib/notification-worker/projection';
type Probe={calls:Array<{port:string;selector?:string}>};
const subject='00000000-0000-4000-8000-000000000001',resolved='00000000-0000-4000-8000-000000000002';
const event={id:'00000000-0000-4000-8000-000000000003',aggregateId:'00000000-0000-4000-8000-000000000004',subjectEmploymentId:subject};
const port=(name:string)=>(state:Probe)=>{state.calls.push({port:name});return Promise.resolve([resolved]);};
const readers:NotificationRecipientReaders<Probe>={
 probation:port('probation'),contract:port('contract'),onboardingDigest:port('onboardingDigest'),assessmentReminder:port('assessmentReminder'),
 rewardSuspension:port('rewardSuspension'),rewardUploadChecker:port('rewardUploadChecker'),rewardUploadReady:port('rewardUploadReady'),rewardRouted:port('rewardRouted'),rewardPreparationReleased:port('rewardPreparationReleased'),rewardPreparationChanged:port('rewardPreparationChanged'),rewardPreparationInvalidated:port('rewardPreparationInvalidated'),rewardPoolChanged:port('rewardPoolChanged'),rewardApproved:port('rewardApproved'),
 leaveSubmitted:port('leaveSubmitted'),leaveCancellationSubmitted:port('leaveCancellationSubmitted'),overtimeSubmitted:port('overtimeSubmitted'),readinessNudge:port('readinessNudge'),peerFeedback:port('peerFeedback'),
 assessmentReviewTask:(state,_event,phase)=>{state.calls.push({port:'assessmentReviewTask',selector:phase});return Promise.resolve([resolved]);},
 assessmentKpiApproval:port('assessmentKpiApproval'),legacyReviewStarted:port('legacyReviewStarted'),legacyReviewEvaluated:port('legacyReviewEvaluated'),legacyReviewDecidedLetter:port('legacyReviewDecidedLetter'),legacyReviewReminder:port('legacyReviewReminder'),
 delegationStarted:port('delegationStarted'),delegationEnded:port('delegationEnded'),leaveEscalation:port('leaveEscalation'),attendanceEscalation:port('attendanceEscalation'),automaticReviewChase:port('automaticReviewChase'),
 missingClockFollowup:port('missingClockFollowup'),passportFollowup:port('passportFollowup'),lifecycleFollowup:port('lifecycleFollowup'),employeeLoopDigest:port('employeeLoopDigest'),noticePublished:port('noticePublished'),payrollClosed:port('payrollClosed'),bulkJobInitiator:port('bulkJobInitiator'),
 approvalChase:source=>state=>{state.calls.push({port:'approvalChase',selector:source});return Promise.resolve([resolved]);},
};
const registry=createNotificationRegistry(readers),recipes=Object.entries(registry).flatMap(([eventType,value])=>(Array.isArray(value)?value:[value]).map(spec=>({eventType,spec})));
const eligible=(spec:NotificationSpec<Probe>):NotificationPayload=>spec.recipientGuard?{[spec.recipientGuard.field]:spec.recipientGuard.not?false:true}:{};
const unsupported=new Set(['attendanceEscalation','bulkJobInitiator','rewardPreparationReleased','rewardPreparationChanged','rewardPreparationInvalidated','probation','leaveSubmitted','leaveCancellationSubmitted','overtimeSubmitted','readinessNudge','peerFeedback','assessmentReviewTask','assessmentKpiApproval','legacyReviewStarted','legacyReviewEvaluated','legacyReviewDecidedLetter','legacyReviewReminder','leaveEscalation','automaticReviewChase','missingClockFollowup','passportFollowup','lifecycleFollowup','employeeLoopDigest','approvalChase']);

// Reviewed domain identities, independent of the registry's runtime count/factory expansion.
const expectedRecipeKeys=[
 'assessment.reminder-queued|performance.reminder',
 'attendance-correction.approved|attendance.ot-approved',
 'attendance-correction.rejected|attendance.ot-rejected',
 'attendance-correction.requested|attendance.ot-requested',
 'attendance-workflow.stage.escalated|attendance.escalated',
 'automatic-chase.approval-raised|attendance.approval-overdue',
 'automatic-chase.approval-raised|claim.approval-overdue',
 'automatic-chase.approval-raised|toil.approval-overdue',
 'automatic-chase.followup-raised|attendance.missing-clock',
 'automatic-chase.followup-raised|lifecycle.step-waiting',
 'automatic-chase.followup-raised|profile.passport-expiry',
 'automatic-chase.review-raised|review.overdue',
 'bulk-job.finished|bulk-job.finished',
 'claim-request.approved|claim.approved',
 'claim-request.rejected|claim.rejected',
 'claim-request.triage-queried|claim.triageQueried',
 'contract.notification-due|contract.notification-due',
 'delegation.ended|delegation.ended',
 'delegation.started|delegation.started',
 'employee-home.greeting.sent|employee-home.greeting',
 'employment-review.decided|review.decided',
 'employment-review.decided|review.issue-letter',
 'employment-review.manager-evaluated|review.manager-evaluated',
 'employment-review.reminder-due|review.reminder',
 'employment-review.started|review.started',
 'leave-cancellation.approved|leave.cancellation-approved',
 'leave-cancellation.rejected|leave.cancellation-rejected',
 'leave-cancellation.requested|leave.cancellation-requested',
 'leave-request.admin-cancelled|leave.admin-cancelled',
 'leave-request.approved|leave.approved',
 'leave-request.escalation-due|leave.escalation',
 'leave-request.rejected|leave.rejected',
 'leave-request.self-cancelled|leave.self-cancelled',
 'letter-request.declined|letter-request.declined',
 'notice.published|notice.published',
 'onboarding.digest|onboarding.digest',
 'onehr.competencies-submitted|performance.review-task',
 'onehr.kpi-approval-needed|performance.review-task',
 'onehr.plan-closed|performance.update',
 'onehr.plan-reviewed|performance.update',
 'onehr.plan-shared|performance.review-task',
 'onehr.results-submitted|performance.review-task',
 'onehr.results-to-leader|performance.update',
 'onehr.results-to-person|performance.update',
 'onehr.scorecard-approved|performance.update',
 'onehr.scorecard-returned|performance.update',
 'payroll-batch.closed|payslip.ready',
 'peer-feedback-request.created|performance.feedback-request',
 'performance-review.closed|performance.closed',
 'probation.notification-due|probation.notification',
 'profile-change.approved|profile.approved',
 'profile-change.rejected|profile.rejected',
 'readiness.nudge-raised|readiness.nudge',
 'resignation.accepted|resignation.accepted',
 'resignation.rejected|resignation.rejected',
 'reward-access.suspended|rewards.access-suspended',
 'reward-unit.approved|rewards.approved',
 'reward-unit.final-pool-changed|rewards.final-pool-changed',
 'reward-unit.preparation-released|rewards.preparation-released',
 'reward-unit.preparation-changed|rewards.preparation-changed',
 'reward-unit.preparation-invalidated|rewards.preparation-invalidated',
 'reward-unit.routed|rewards.review',
 'reward-unit.upload-confirmed|rewards.upload-ready',
 'reward-unit.upload-replaced|rewards.upload-check',
 'teras-loop.action.applied|teras-loop.clock-out-set',
 'teras-loop.cut-off-reminder|teras-loop.cut-off-reminder',
 'teras-loop.employee-digest-queued|teras-loop.employee-digest',
 'teras-loop.request.sent|teras-loop.details-requested',
 'teras-loop.request.withdrawn|teras-loop.details-request-withdrawn',
 'toil.accrued|toil.accrued',
 'toil.converted|toil.converted',
 'toil.lapsed|toil.lapsed',
];

it('executes every actual canonical recipe and independently observes its declared audience/reader binding',async()=>{
 const actualKeys=recipes.map(({eventType,spec})=>eventType+'|'+spec.kind);
 expect(actualKeys.slice().sort()).toEqual(expectedRecipeKeys.slice().sort());expect(new Set(actualKeys).size).toBe(expectedRecipeKeys.length);
 const observed=new Set<string>();
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

const preparationRecipes=[
 {eventType:'reward-unit.preparation-released',port:'rewardPreparationReleased',kind:'rewards.preparation-released',copy:'release'},
 {eventType:'reward-unit.preparation-changed',port:'rewardPreparationChanged',kind:'rewards.preparation-changed',copy:'change'},
 {eventType:'reward-unit.preparation-invalidated',port:'rewardPreparationInvalidated',kind:'rewards.preparation-invalidated',copy:'change'},
] as const;
it('keeps preparation notifications on their exact reader ports and renders no submitted private facts',async()=>{
 const privatePayload={to:'gr',salary:'PRIVATE_SALARY',budget:'PRIVATE_BUDGET',reason:'PRIVATE_REASON'};
 for(const expected of preparationRecipes){
  const calls:unknown[]=[];
  const selected=createNotificationRegistry({...readers,[expected.port]:async(state:Probe,ref:EventRef,p:NotificationPayload)=>{
   calls.push({state,ref,p});return [resolved];
  }})[expected.eventType];
  if(!selected||Array.isArray(selected))throw Error('One explicit preparation recipe required');
  const state:Probe={calls:[]};
  expect(await selected.recipients!(state,event,privatePayload)).toEqual([resolved]);
  expect(calls).toEqual([{state,ref:event,p:privatePayload}]);expect(state.calls).toEqual([]);
  expect(selected.recipientPort).toBe(expected.port);expect(selected.kind).toBe(expected.kind);expect(selected.category).toBe('rewards');
  expect(selected.render(privatePayload,event)).toEqual({severity:'action',title:`rewardsPreparation.${expected.copy}NotificationTitle`,body:`rewardsPreparation.${expected.copy}NotificationBody`,linkPath:`/rewards/${event.aggregateId}`});
  for(const value of ['PRIVATE_SALARY','PRIVATE_BUDGET','PRIVATE_REASON'])expect(JSON.stringify(selected.render(privatePayload,event))).not.toContain(value);
  for(const version of [2,3]as const)expect(nativeNotificationRecipeImplemented(selected,version)).toBe(false);
 }
});
it('does not acknowledge any preparation event when native facts are unimplemented or wrongly claim support',async()=>{
 for(const expected of preparationRecipes)for(const implemented of [false,true]){
  const statements:string[]=[],families:unknown[]=[];let rejectedTransaction=false;
  const transaction=async(strings:TemplateStringsArray,...values:unknown[])=>{
   const query=strings.join('?');statements.push(query);
   if(query.includes('notification_worker.open_batch('))return [{id:event.aggregateId}];
   if(query.includes('notification_worker.events('))return [{event_id:event.id,event_type:expected.eventType,aggregate_id:event.aggregateId,subject_employment_id:subject,payload:{to:'gr'}}];
   if(query.includes('notification_worker.facts(')){families.push(values[2]);return [{value:{known:true,implemented,obsolete:false}}];}
   throw Error('Unexpected native operation before refusal');
  };
  const connection={options:{max:1},begin:async(run:(tx:typeof transaction)=>Promise<unknown>)=>{
   try{return await run(transaction);}catch(error){rejectedTransaction=true;throw error;}
  }} as unknown as Parameters<typeof notificationWorkerProjection>[0];
  await expect(notificationWorkerProjection(connection).projectBatch(event.id,event.aggregateId)).rejects.toBeInstanceOf(UnsupportedNotificationFacts);
  expect(rejectedTransaction).toBe(true);expect(families).toEqual(['meta']);
  expect(statements.some(query=>query.includes('notification_worker.finish_event(')||query.includes('notification_worker.finish_batch(')||query.includes('notification_worker.project('))).toBe(false);
 }
});
it('retains one employee digest recipe and refuses native completion before unsupported digest facts',async()=>{
 const digest=recipes.filter(row=>row.eventType==='teras-loop.employee-digest-queued');
 expect(digest).toHaveLength(1);
 expect(digest[0].spec).toMatchObject({kind:'teras-loop.employee-digest',category:'readiness',recipientAudience:'reader',recipientPort:'employeeLoopDigest'});
 expect(digest[0].spec.render({caseIds:['private-case'],person:'private-person'},event)).toEqual({severity:'action',title:'Your daily action digest',
  body:'Open Today to review the items that need your attention.',linkPath:'/#today-needs-you'});
 for(const version of [2,3]as const)expect(nativeNotificationRecipeImplemented(digest[0].spec,version)).toBe(false);
 const statements:string[]=[];
 const transaction=async(strings:TemplateStringsArray)=>{
  const query=strings.join('?');statements.push(query);
  if(query.includes('notification_worker.open_batch('))return [{id:event.aggregateId}];
  if(query.includes('notification_worker.events('))return [{event_id:event.id,event_type:digest[0].eventType,aggregate_id:subject,subject_employment_id:subject,payload:{}}];
  throw Error('Unsupported digest must refuse before requesting or settling facts');
 };
 const begin=async(run:(tx:typeof transaction)=>Promise<unknown>)=>run(transaction);
 const connection={options:{max:1},begin} as unknown as Parameters<typeof notificationWorkerProjection>[0];
 await expect(notificationWorkerProjection(connection).projectBatch(event.id,event.aggregateId)).rejects.toBeInstanceOf(UnsupportedNotificationFacts);
 expect(statements).toHaveLength(2);
});
