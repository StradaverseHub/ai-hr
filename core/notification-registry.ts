/** One canonical render/recipient recipe registry. No database, app pool or service imports.
 * A reader adapter supplies only the named recipient ports. Payload-only decisions
 * and every kind/category/render value remain shared by web and maintenance callers. */
import type {NotificationSeverity} from '../db/schema';
import type {NotificationEmailCategory} from '../lib/notification-email-model';
import {READINESS_CORRECTIONS} from '../lib/readiness-correction-actions';
import {bulkJobNoticeKeys} from '../lib/bulk-job';
export type Rendered={severity:NotificationSeverity;title:string;body:string;linkPath:string};
export type EventRef={id?:string;aggregateId:string;subjectEmploymentId:string|null};
export type NotificationPayload=Record<string,unknown>|null;
export type NoticeAudienceReader=(noticeId:string)=>Promise<string[]>;
export type NotificationRecipientReader<Reader>=(reader:Reader,event:EventRef,payload:NotificationPayload,noticeReader?:NoticeAudienceReader)=>Promise<string[]>;
export const EMPLOYEE_LOOP_DIGEST_EVENT='teras-loop.employee-digest-queued';
export type NotificationPayloadGuard={field:'overtime'|'supersededByAdminCancellation'|'notify';equals:true;not?:true};
type NotificationAudience<Reader>=
 |{recipientAudience:'subject'|'none';recipientPort?:never}
 |{recipientAudience:'reader';recipientPort:keyof NotificationRecipientReaders<Reader>};
export type NotificationSpec<Reader>=NotificationAudience<Reader>&{recipientGuard?:NotificationPayloadGuard;kind:string;category:NotificationEmailCategory|null;render:(payload:NotificationPayload,event:EventRef)=>Rendered;recipients?:NotificationRecipientReader<Reader>};
export type ApprovalChaseSource='claim'|'attendance_correction'|'replacement_leave';
export type NotificationRecipientReaders<Reader>={
 probation:NotificationRecipientReader<Reader>;
 contract:NotificationRecipientReader<Reader>;
 onboardingDigest:NotificationRecipientReader<Reader>;
 assessmentReminder:NotificationRecipientReader<Reader>;
 rewardSuspension:NotificationRecipientReader<Reader>;
 rewardUploadChecker:NotificationRecipientReader<Reader>;
 rewardUploadReady:NotificationRecipientReader<Reader>;
 rewardRouted:NotificationRecipientReader<Reader>;
 rewardPreparationReleased:NotificationRecipientReader<Reader>;
 rewardPreparationChanged:NotificationRecipientReader<Reader>;
 rewardPreparationInvalidated:NotificationRecipientReader<Reader>;
 rewardPoolChanged:NotificationRecipientReader<Reader>;
 rewardApproved:NotificationRecipientReader<Reader>;
 leaveSubmitted:NotificationRecipientReader<Reader>;
 leaveCancellationSubmitted:NotificationRecipientReader<Reader>;
 overtimeSubmitted:NotificationRecipientReader<Reader>;
 readinessNudge:NotificationRecipientReader<Reader>;
 peerFeedback:NotificationRecipientReader<Reader>;
 assessmentReviewTask: (reader:Reader,event:EventRef,phase:'results'|'competencies'|'plan')=>Promise<string[]>;
 assessmentKpiApproval:NotificationRecipientReader<Reader>;
 legacyReviewStarted:NotificationRecipientReader<Reader>;
 legacyReviewEvaluated:NotificationRecipientReader<Reader>;
 legacyReviewDecidedLetter:NotificationRecipientReader<Reader>;
 legacyReviewReminder:NotificationRecipientReader<Reader>;
 delegationStarted:NotificationRecipientReader<Reader>;
 delegationEnded:NotificationRecipientReader<Reader>;
 leaveEscalation:NotificationRecipientReader<Reader>;
 attendanceEscalation:NotificationRecipientReader<Reader>;
 automaticReviewChase:NotificationRecipientReader<Reader>;
 missingClockFollowup:NotificationRecipientReader<Reader>;
 passportFollowup:NotificationRecipientReader<Reader>;
 lifecycleFollowup:NotificationRecipientReader<Reader>;
 employeeLoopDigest:NotificationRecipientReader<Reader>;
 noticePublished:NotificationRecipientReader<Reader>;
 payrollClosed:NotificationRecipientReader<Reader>;
 bulkJobInitiator:NotificationRecipientReader<Reader>;
 approvalChase:(source:ApprovalChaseSource)=>NotificationRecipientReader<Reader>;
};
/**
 * `reward-unit.routed` copy. A move back to draft from a later stage is a RETURN to the BU CEO (or the BG
 * CEO for a BG-originated off-cycle request — the recipient resolver already picks that seat), so it says
 * so. Neither branch carries an amount or the return reason: the reason is read in the app under
 * reward_decision RLS, never frozen into a stored notice or an email.
 */
export function renderRewardRouted(p: Record<string, unknown> | null, ev: EventRef): Rendered {
  const linkPath = `/rewards/${ev.aggregateId}?view=approvals`;
  if (p?.to === 'draft' && typeof p?.from === 'string' && p.from !== 'draft')
    return { severity: 'action', title: 'Rewards review returned to you', body: 'Open Reward Desk to see why it was returned and resubmit it.', linkPath };
  return { severity: 'action', title: 'Rewards review needs attention', body: 'Open Reward Desk to review the assigned request.', linkPath };
}

const overtimeOnly:NotificationPayloadGuard={field:'overtime',equals:true};
const cancellationNotSuperseded:NotificationPayloadGuard={field:'supersededByAdminCancellation',equals:true,not:true};
const noticeNotify:NotificationPayloadGuard={field:'notify',equals:true};
function payloadGuardMatches(payload:NotificationPayload,guard:NotificationPayloadGuard){
 const matches=payload?.[guard.field]===guard.equals;return guard.not?!matches:matches;
}
const noRecipients=async()=>[];
const subjectRecipient=async<Reader>(_reader:Reader,event:EventRef)=>event.subjectEmploymentId?[event.subjectEmploymentId]:[];
/** Definition validation only; this cannot issue native or application authority. */
export function assertNotificationRecipeAudience<Reader>(value:unknown,readers:NotificationRecipientReaders<Reader>){
 if(!value||typeof value!=='object'||!('recipientAudience'in value))throw Error('Explicit canonical notification audience required');
 const port='recipientPort'in value?value.recipientPort:undefined,recipient='recipients'in value?value.recipients:undefined;
 if(value.recipientAudience==='subject'){
  if(port!==undefined||recipient!==undefined&&recipient!==subjectRecipient)throw Error('Canonical subject notification resolver differs');
 }else if(value.recipientAudience==='none'){
  if(port!==undefined||recipient!==noRecipients)throw Error('Canonical no-recipient notification resolver differs');
 }else if(value.recipientAudience==='reader'){
  if(typeof port!=='string'||!Object.hasOwn(readers,port)||typeof recipient!=='function')throw Error('Canonical reader notification port required');
 }else throw Error('Unknown canonical notification audience');
}
export function createNotificationRegistry<Reader>(readers:NotificationRecipientReaders<Reader>):Record<string,NotificationSpec<Reader>|NotificationSpec<Reader>[]> {
function approvalChaseSpec(source: ApprovalChaseSource, kind: string, category: NotificationEmailCategory, title: string, what: string): NotificationSpec<Reader> {
  return {recipientAudience:'reader',
    kind,
    category,
    render: (p) => {
      const days = typeof p?.workingDaysWaiting === 'number' && Number.isSafeInteger(p.workingDaysWaiting) ? p.workingDaysWaiting : null;
      return {
        severity: 'action',
        title,
        body: days == null ? `${what} is waiting for your decision.` : `${what} has been waiting for your decision for ${days} working day(s).`,
        linkPath: '/approvals',
      };
    },
    recipientPort:'approvalChase',recipients:readers.approvalChase(source),
  };
}

const registry:Record<string,NotificationSpec<Reader>|NotificationSpec<Reader>[]>= {
  'probation.notification-due':{recipientAudience:'reader',kind:'probation.notification',category:'review',recipientPort:'probation',recipients:readers.probation,render:(payload)=>({severity:'action',title:'probation.notification.title',body:'probation.notification.body',linkPath:typeof payload?.caseId==='string'?(payload.documentKind==='letter'&&typeof payload.partId==='string'?`/lifecycle/probation/${payload.caseId}/letters/${payload.partId}`:`/lifecycle/probation/${payload.caseId}`):'/lifecycle/probation'})},
  // This explicit command atomically point-projects its in-app notification. SQL refuses a forged
  // event or a commit without that exact projection; the global cursor must not project it twice.
  'employee-home.greeting.sent': {
    kind:'employee-home.greeting',category:null,recipientAudience:'none',recipients:noRecipients,
    render:(_payload,ev)=>({severity:'info',title:'employeeHome.greetingNotification.title',
      body:'employeeHome.greetingNotification.body',linkPath:`/me/greetings/${ev.aggregateId}`}),
  },
  'contract.notification-due': {recipientAudience:'reader',
    kind:'contract.notification-due',category:'review',
    recipientPort:'contract',recipients:readers.contract,
    render:()=>({severity:'action',title:'Contract staff task',body:'Open Contract Management to review your assigned task.',linkPath:'/lifecycle/contracts'}),
  },
  'onboarding.digest': {recipientAudience:'reader',
    kind:'onboarding.digest',category:'onboarding',
    recipientPort:'onboardingDigest',recipients:readers.onboardingDigest,
    render:()=>({severity:'info',title:'Your daily onboarding digest',body:'Review your assigned onboarding work, approvals and conversations.',linkPath:'/tasks'}),
  },
  'assessment.reminder-queued': {recipientAudience:'reader',
    kind:'performance.reminder',category:'performance',
    recipientPort:'assessmentReminder',recipients:readers.assessmentReminder,
    render:()=>({severity:'action',title:'Assessment work waiting on you',body:'Open your performance workspace to complete your pending review tasks.',linkPath:'/me/performance'}),
  },
  'reward-access.suspended': {recipientAudience:'reader',
    kind:'rewards.access-suspended',category:'rewards',
    render:(_payload,event)=>({severity:'warning',title:'Rewards access suspended',body:'People records changed. Check approval-role coverage and ask a Rewards administrator to review suspended access.',linkPath:`/rewards/${event.aggregateId}?view=approvals`}),
    recipientPort:'rewardSuspension',recipients:readers.rewardSuspension,
  },
  'reward-unit.upload-replaced':{recipientAudience:'reader',kind:'rewards.upload-check',category:'rewards',recipientPort:'rewardUploadChecker',recipients:readers.rewardUploadChecker,render:(_payload,event)=>({severity:'action',title:'rewardUploaded.checkNotificationTitle',body:'rewardUploaded.checkNotificationBody',linkPath:`/rewards/${event.aggregateId}/uploaded`})},
  'reward-unit.upload-confirmed':{recipientAudience:'reader',kind:'rewards.upload-ready',category:'rewards',recipientPort:'rewardUploadReady',recipients:readers.rewardUploadReady,render:(_payload,event)=>({severity:'action',title:'rewardUploaded.readyNotificationTitle',body:'rewardUploaded.readyNotificationBody',linkPath:`/rewards/${event.aggregateId}`})},
  'reward-unit.routed': {recipientAudience:'reader',
    kind: 'rewards.review', category: 'rewards',
    render: (p, ev) => renderRewardRouted(p, ev),
    recipientPort:'rewardRouted',recipients:readers.rewardRouted,
  },
  'reward-unit.preparation-released': {recipientAudience:'reader',
    kind:'rewards.preparation-released',category:'rewards',
    recipientPort:'rewardPreparationReleased',recipients:readers.rewardPreparationReleased,
    render:(_payload,event)=>({severity:'action',title:'rewardsPreparation.releaseNotificationTitle',body:'rewardsPreparation.releaseNotificationBody',linkPath:`/rewards/${event.aggregateId}`}),
  },
  'reward-unit.preparation-changed': {recipientAudience:'reader',
    kind:'rewards.preparation-changed',category:'rewards',
    recipientPort:'rewardPreparationChanged',recipients:readers.rewardPreparationChanged,
    render:(_payload,event)=>({severity:'action',title:'rewardsPreparation.changeNotificationTitle',body:'rewardsPreparation.changeNotificationBody',linkPath:`/rewards/${event.aggregateId}`}),
  },
  'reward-unit.preparation-invalidated': {recipientAudience:'reader',
    kind:'rewards.preparation-invalidated',category:'rewards',
    recipientPort:'rewardPreparationInvalidated',recipients:readers.rewardPreparationInvalidated,
    render:(_payload,event)=>({severity:'action',title:'rewardsPreparation.changeNotificationTitle',body:'rewardsPreparation.changeNotificationBody',linkPath:`/rewards/${event.aggregateId}`}),
  },
  'reward-unit.final-pool-changed': {recipientAudience:'reader',
    kind:'rewards.final-pool-changed',category:'rewards',
    render:(_payload,event)=>({severity:'action',title:'Rewards pool updated',body:'Group Rewards changed the bonus pool or its status. Review the current pool and budget checks before approving.',linkPath:`/rewards/${event.aggregateId}#unit-governance`}),
    recipientPort:'rewardPoolChanged',recipients:readers.rewardPoolChanged,
  },
  'reward-unit.approved': {recipientAudience:'reader',
    kind: 'rewards.approved', category: 'rewards',
    render: (_p, ev) => ({ severity: 'action', title: 'Rewards ready for payroll', body: 'The review is approved and ready for the payroll handoff.', linkPath: `/rewards/${ev.aggregateId}?view=approvals` }),
    recipientPort:'rewardApproved',recipients:readers.rewardApproved,
  },
  'leave-request.approved': {recipientAudience:'subject',
    kind: 'leave.approved',
    category: 'leave',
    // Partial Leave Approval notification fix: a MIXED per-date outcome (finalizeLeaveApproval sets
    // payload.mixed === true when ≥1 date was approved AND ≥1 rejected) renders an honest "partially
    // approved" body that deep-links to /me, where the existing per-date breakdown shows which dates were
    // approved/rejected and why. Every other approval (whole-request, all-approved per-date) has no `mixed`
    // flag and keeps the flat "approved" body — byte-identical to today.
    render: (p) => {
      if (p?.mixed === true) {
        // R17 600be8ac ask #5: list the approved + rejected dates and the rejection reason so the notice is
        // self-contained. perDateOutcome is attached by finalizeLeaveApproval only for the mixed case; fall
        // back to the generic body if an older event lacks it. Cap the listing so the body stays short.
        const o = (p.perDateOutcome ?? null) as
          | { approved?: string[]; rejected?: { date: string; reason?: string | null }[] }
          | null;
        const cap = 6;
        const fmt = (arr: string[]) =>
          arr.length > cap ? `${arr.slice(0, cap).join(', ')} +${arr.length - cap} more` : arr.join(', ');
        const approved = o?.approved ?? [];
        const rejected = o?.rejected ?? [];
        const parts: string[] = [];
        if (approved.length) parts.push(`Approved: ${fmt(approved)}`);
        if (rejected.length) {
          parts.push(`Rejected: ${fmt(rejected.map((r) => r.date))}`);
          const reason = rejected.find((r) => r.reason)?.reason;
          if (reason) parts.push(`Reason: ${reason}`);
        }
        const body = parts.length
          ? `Some dates were approved and some were not. ${parts.join('. ')}.`
          : 'Some dates in your leave request were approved and some were not — tap to see the breakdown.';
        return { severity: 'info', title: 'Leave partially approved', body, linkPath: '/me' };
      }
      return { severity: 'info', title: 'Leave approved', body: 'Your leave request was approved.', linkPath: '/me' };
    },
  },
  'leave-request.rejected': {recipientAudience:'subject',
    kind: 'leave.rejected',
    category: 'leave',
    render: () => ({ severity: 'warning', title: 'Leave not approved', body: 'Your leave request was rejected.', linkPath: '/me' }),
  },
  // HR cancelled a leave on the employee's behalf (feedback 22e68ff0). Default recipient = the event's
  // subjectEmploymentId (the affected employee) — no fan-out resolver. The payload carries the display facts
  // (type + dates) the ticket wants in the notice. English-only strings, matching every other registry entry.
  'leave-request.admin-cancelled': {recipientAudience:'subject',
    kind: 'leave.admin-cancelled',
    category: 'leave',
    render: (p) => ({
      severity: 'warning',
      title: 'Leave cancelled by HR',
      body: `Your ${p?.leaveTypeName ?? 'leave'} (${p?.startDate ?? ''} → ${p?.endDate ?? ''}) has been cancelled by an HR administrator.`,
      linkPath: '/me',
    }),
  },
  // The employee withdrew their OWN pending leave (item c9a19e34, expected_function 4.v — "notify the approver
  // and HR"). Unlike the other leave notices, the SUBJECT here is the person who took the action, so a subject
  // notice would be pointless — a fan-out resolver targets the approver (the subject's current administrative
  // manager) + the company's HR admins instead, excluding the subject. English-only body (registry convention).
  'leave-request.self-cancelled': {recipientAudience:'reader',
    kind: 'leave.self-cancelled',
    category: 'leave',
    render: (p) => ({
      severity: 'info',
      title: 'Leave application withdrawn',
      body: `An employee withdrew their ${p?.leaveTypeName ?? 'leave'} application (${p?.startDate ?? ''} → ${p?.endDate ?? ''}).`,
      linkPath: '/approvals',
    }),
    recipientPort:'leaveSubmitted',recipients:readers.leaveSubmitted,
  },
  // ── r301 (board 83511d3b) — Cancel Approved Leave. The reporter's complaint was that an employee was never
  // told what became of their cancellation, so the two DECISIONS go to the employee ALWAYS (the event's
  // subject — the default recipient). The REQUEST goes to the approver and HR only when the leave type's
  // "Notify the approver and HR" box was ticked, a choice SNAPSHOTTED into the event payload at request time
  // (re-reading the leave type at dispatch would let a later untick retroactively un-notify).
  // Email uses a separate brief template; the in-app strings follow the registry convention.
  'leave-cancellation.requested': {recipientAudience:'reader',
    kind: 'leave.cancellation-requested',
    category: 'leave',
    render: (p) => {
      const what = `${p?.leaveTypeName ?? 'leave'} (${Array.isArray(p?.cancelDates) ? (p.cancelDates as string[]).join(', ') : ''})`;
      return p?.autoApproved === true
        ? {
            severity: 'info',
            title: 'Leave cancelled by an employee',
            body: `An employee cancelled ${what}. It was approved automatically by the leave type setting.`,
            linkPath: '/approvals',
          }
        : {
            severity: 'action',
            title: 'Leave cancellation awaiting approval',
            body: `An employee asked to cancel ${what}. It is waiting for approval.`,
            linkPath: '/approvals',
          };
    },
    recipientPort:'leaveCancellationSubmitted',recipients:readers.leaveCancellationSubmitted,
  },
  'leave-cancellation.approved': {recipientAudience:'subject',
    kind: 'leave.cancellation-approved',
    category: 'leave',
    render: (p) => {
      const dates = Array.isArray(p?.cancelDates) ? (p.cancelDates as string[]).join(', ') : '';
      const days = typeof p?.restoredDays === 'number' ? p.restoredDays : null;
      return {
        severity: 'info',
        title: 'Leave cancellation approved',
        body:
          `Your cancellation of ${p?.leaveTypeName ?? 'leave'}${dates ? ` on ${dates}` : ''} was approved` +
          `${p?.autoApproved === true ? ' automatically' : ''}. The leave is cancelled` +
          `${days != null ? ` and ${days} day(s) went back to your balance` : ''}.`,
        linkPath: '/leave',
      };
    },
  },
  'leave-cancellation.rejected': {recipientAudience:'subject',
    kind: 'leave.cancellation-rejected',
    category: 'leave',
    render: (p) => {
      const dates = Array.isArray(p?.cancelDates) ? (p.cancelDates as string[]).join(', ') : '';
      return {
        severity: 'warning',
        title: 'Leave cancellation not approved',
        body: `Your cancellation of ${p?.leaveTypeName ?? 'leave'}${dates ? ` on ${dates}` : ''} was not approved. The leave stays approved.`,
        linkPath: '/leave',
      };
    },
    // The subject — EXCEPT when HR cancelled the whole leave on the employee's behalf and the pending
    // give-back was closed as superseded (adminCancelLeave): the employee is already told "Leave cancelled
    // by HR", and "your cancellation was not approved… the leave stays approved" would be untrue.
    recipientGuard:cancellationNotSuperseded,recipients:subjectRecipient,
  },
  'toil.accrued': {recipientAudience:'subject',
    kind: 'toil.accrued',
    category: 'toil',
    render: (p) => ({
      severity: 'info',
      title: 'Time off in lieu banked',
      body: `${p?.daysCredited ?? ''} day(s) banked in lieu${p?.workedDate ? ` for ${p.workedDate}` : ''}.`.trim(),
      linkPath: '/me',
    }),
  },
  'toil.converted': {recipientAudience:'subject',
    kind: 'toil.converted',
    category: 'toil',
    render: (p) => ({ severity: 'info', title: 'In-lieu converted to pay', body: `Your unused time in lieu (${p?.daysCredited ?? ''} day(s)) was converted to pay.`, linkPath: '/me' }),
  },
  'toil.lapsed': {recipientAudience:'subject',
    kind: 'toil.lapsed',
    category: 'toil',
    render: (p) => ({ severity: 'warning', title: 'In-lieu expired', body: `Your unused time in lieu (${p?.daysCredited ?? ''} day(s)) has lapsed.`, linkPath: '/me' }),
  },
  // 34-2b producers — the rest of the "your request was actioned" decisions (each already carries the
  // requester as subjectEmploymentId) plus the payslip-ready fan-out.
  'resignation.accepted': {recipientAudience:'subject',
    kind: 'resignation.accepted',
    category: 'offboarding',
    render: () => ({ severity: 'info', title: 'Resignation accepted', body: 'Your resignation has been accepted by HR.', linkPath: '/me' }),
  },
  'resignation.rejected': {recipientAudience:'subject',
    kind: 'resignation.rejected',
    category: 'offboarding',
    render: () => ({ severity: 'warning', title: 'Resignation not accepted', body: 'Your resignation was not accepted — please speak with HR.', linkPath: '/me' }),
  },
  /**
   * ADR-0084 §2.7 — the input-triage question. The BODY is written by the SWEEP, not here, for the same
   * reason the nudge's is: it may be a model draft, and by the time it reaches this registry it has
   * already passed `adjudicateTriage` (or it was never emitted). Re-deciding that here would be two
   * places deciding, which is how they drift.
   *
   * ⚠️ IT GOES TO THE CLAIMANT, NOT THE APPROVER, and that is the whole design (see core/input-triage.ts).
   * `subjectEmploymentId` is the person who filed it, so the DEFAULT recipient resolver is already right
   * and no `recipients` override is needed — the absence of one here is deliberate, not an oversight.
   */
  'claim-request.triage-queried': {recipientAudience:'subject',
    kind: 'claim.triageQueried',
    // The claims category, so muting claim notifications mutes this too. It is a question about a claim.
    category: 'claims',
    render: (p) => ({
      // `info`, never `warning`. Nothing is wrong with the claim, nothing is refused, and nothing is
      // required of them — a warning colour would tell the employee they are in trouble, which is exactly
      // the accusation §2.7 forbids.
      severity: 'info',
      title: 'A question about your claim',
      body:
        typeof p?.reason === 'string' && p.reason.length > 0
          ? p.reason
          : 'There is a question about a claim you filed. Please check it before it is approved.',
      linkPath: '/me',
    }),
  },
  'claim-request.approved': {recipientAudience:'subject',
    kind: 'claim.approved',
    category: 'claims',
    render: () => ({ severity: 'info', title: 'Claim approved', body: 'Your expense claim was approved.', linkPath: '/me' }),
  },
  'claim-request.rejected': {recipientAudience:'subject',
    kind: 'claim.rejected',
    category: 'claims',
    render: () => ({ severity: 'warning', title: 'Claim not approved', body: 'Your expense claim was not approved.', linkPath: '/me' }),
  },
  // ── 1e9145d4 Plan OT — three notices, because today NOTHING is sent about an attendance or overtime
  // request at all. Overtime agreed before it is worked only works if the approver learns a plan is waiting
  // while saying no is still cheap, and if the employee learns the answer without going to look.
  //
  // SCOPED TO OVERTIME, DELIBERATELY. The same three event types are also appended by a clock-time
  // correction, which shares the record. Widening these notices to cover clock fixes would be a real
  // improvement — they are equally silent today — but it is a behaviour change on a neighbouring flow that
  // nobody asked for, so each resolver below returns NO RECIPIENTS for a non-overtime row. Widening later
  // is deleting one guard clause. The discriminator is `requestedOtMinutes` on the request event and the
  // explicit `overtime` flag on the decision events (which carry no minutes of their own).
  //
  // English-only strings, the registry convention — a notification body is rendered once and STORED, so
  // there is no per-language version of it.
  'attendance-correction.requested': {recipientAudience:'reader',
    kind: 'attendance.ot-requested',
    category: 'attendance',
    render: (p) => {
      const hours = p?.requestedOtMinutes != null ? (Number(p.requestedOtMinutes) / 60).toFixed(1) : '';
      const date = typeof p?.date === 'string' ? p.date : '';
      return {
        severity: 'action',
        title: 'Overtime plan awaiting approval',
        body: `An overtime plan for ${date} (${hours} hours) is waiting for your approval.`,
        linkPath: '/approvals',
      };
    },
    // THE APPROVER, not the subject — the event's subjectEmploymentId is the person who FILED it, so the
    // default subject notice would tell the requester what they just did. Same routing as the decide path
    // (assertCanDecide): the subject's current administrative manager, falling back to the company's HR
    // admins when they have no line — otherwise a plan filed by someone reporting to nobody is silent.
    // Both resolvers already exist and are used by the leave escalation fan-out; neither is new ground.
    recipientPort:'overtimeSubmitted',recipients:readers.overtimeSubmitted,
  },
  // The subject IS the employee whose plan was decided, so these two would take the default recipient —
  // but the resolver is spelled out anyway to carry the overtime-only scope above.
  'attendance-correction.approved': {recipientAudience:'subject',
    kind: 'attendance.ot-approved',
    category: 'attendance',
    render: (p) => ({
      severity: 'info',
      title: 'Overtime plan approved',
      // `deferred` is set by decideAttendanceCorrection when the plan was agreed AHEAD of its date, which
      // is the case worth saying out loud: approved is not the same as counted, and the hours appear on the
      // day once it is worked.
      body:
        p?.deferred === true
          ? `Your overtime plan for ${typeof p.date === 'string' ? p.date : 'the requested date'} was approved. The hours are counted once the day is worked.`
          : 'Your overtime request was approved.',
      linkPath: '/attendance/plan-ot',
    }),
    recipientGuard:overtimeOnly,recipients:subjectRecipient,
  },
  'attendance-correction.rejected': {recipientAudience:'subject',
    kind: 'attendance.ot-rejected',
    category: 'attendance',
    render: () => ({
      severity: 'warning',
      title: 'Overtime plan not approved',
      body: 'Your overtime request was not approved.',
      linkPath: '/attendance/plan-ot',
    }),
    recipientGuard:overtimeOnly,recipients:subjectRecipient,
  },
  // ADR-0084 §2.5 — the nudge agent. `body` is rendered by the SWEEP, not here, because it may be a
  // model draft that passed `nudgeIsFaithful` — and if it did not, the sweep already substituted the
  // deterministic template, so by the time it reaches this registry there is exactly one body and it is
  // trustworthy. Rendering here would have to re-decide that, and two places deciding is how they drift.
  'readiness.nudge-raised': {recipientAudience:'reader',
    kind: 'readiness.nudge',
    // Its OWN category, so the existing per-category preference is a precise opt-out: somebody can mute
    // record chasers without muting leave approvals.
    category: 'readiness',
    render: (p) => ({
      severity: 'warning',
      title: p?.audience === 'employee' ? 'Something is missing from your record' : 'An employee record needs completing',
      // The fallback is unreachable in practice (the sweep never emits without a body) and is here so a
      // hand-replayed or malformed event degrades to a true sentence rather than the string "undefined".
      body: typeof p?.body === 'string' && p.body.length > 0 ? p.body : 'A record is incomplete and is holding up payroll or a statutory filing.',
      // Deep-link to the screen the RECIPIENT can actually act on — the whole point of the routing split.
      linkPath: p?.audience === 'employee'
        ? p?.action === 'submit_correction' && typeof p?.gap === 'string' && Object.hasOwn(READINESS_CORRECTIONS, p.gap)
          ? `/me?tab=${READINESS_CORRECTIONS[p.gap as keyof typeof READINESS_CORRECTIONS].tab}#section-request-${READINESS_CORRECTIONS[p.gap as keyof typeof READINESS_CORRECTIONS].tab}`
          : '/me'
        : '/control-tower/readiness',
    }),
    recipientPort:'readinessNudge',recipients:readers.readinessNudge,
  },
  'profile-change.approved': {recipientAudience:'subject',
    kind: 'profile.approved',
    category: 'profile',
    render: () => ({ severity: 'info', title: 'Profile change approved', body: 'Your requested profile change was approved.', linkPath: '/me' }),
  },
  'profile-change.rejected': {recipientAudience:'subject',
    kind: 'profile.rejected',
    category: 'profile',
    render: () => ({ severity: 'warning', title: 'Profile change not approved', body: 'Your requested profile change was not approved.', linkPath: '/me' }),
  },
  'peer-feedback-request.created': {recipientAudience:'reader',
    kind:'performance.feedback-request',category:'performance',
    render:()=>({severity:'action',title:'Feedback requested',body:'A colleague has requested your feedback. Open your performance tasks.',linkPath:'/me/performance'}),
    recipientPort:'peerFeedback',recipients:readers.peerFeedback,
  },
  ...Object.fromEntries(['results-submitted','competencies-submitted','plan-shared'].map(event=>[`onehr.${event}`,{recipientAudience:'reader' as const,
    kind:'performance.review-task',category:'performance' as const,recipientPort:'assessmentReviewTask' as const,recipients:(reader:Reader,ev:EventRef)=>readers.assessmentReviewTask(reader,ev,event==='results-submitted'?'results':event==='competencies-submitted'?'competencies':'plan'),
    render:()=>({severity:'action' as const,title:'Performance review task',body:'An employee has submitted information for your review. Open your performance tasks.',linkPath:'/me/performance'}),
  }])),
  'onehr.kpi-approval-needed': {recipientAudience:'reader',
    kind:'performance.review-task',category:'performance',
    recipientPort:'assessmentKpiApproval',recipients:readers.assessmentKpiApproval,
    render:()=>({severity:'action',title:'Performance review task',body:'A KPI approval is awaiting your review. Open your performance tasks.',linkPath:'/me/performance'}),
  },
  // WP-E: a release is announced once per person per release action (onehr.results-to-person below), not once
  // per component; onehr.result-released stays an audit event.
  ...Object.fromEntries(['scorecard-approved','scorecard-returned','plan-reviewed','plan-closed'].map(event=>[`onehr.${event}`,{recipientAudience:'subject',
    kind:'performance.update',category:'performance' as const,
    render:()=>({severity:'info' as const,title:'Performance assessment update',body:'There is an update to your assessment or development plan. Open your performance tasks.',linkPath:'/me/performance'}),
  }])),
  // WP-E (CF-08) — release notices. The event's subject is the recipient (a leader, or the person). The release
  // service's ledger already decided who is newly told; the copy carries a count or the kinds released, never a
  // band and never another person's name. Delivery: the bell always; email under the tenant's performance
  // category policy and the recipient's own consent (E-6).
  'onehr.results-to-leader': {recipientAudience:'subject',
    kind:'performance.update',category:'performance',
    render:(p)=>{
      const count=typeof p?.count==='number'&&p.count>0?p.count:1,moved=typeof p?.moved==='number'&&p.moved>0?p.moved:0;
      const people=count===1?'1 person you lead':`${count} people you lead`;
      return {severity:'info',title:'Results released to you',
        body:`HR has released the results of ${people} to you.${p?.both===true?' They can see their own results as well.':' They cannot see their own results yet, so you can talk them through first.'}${moved?` The business group CEO moved ${moved===1?'1 of them':`${moved} of them`}.`:''} Open What you led to see them.`,
        linkPath:'/performance/led'};
    },
  },
  'onehr.results-to-person': {recipientAudience:'subject',
    kind:'performance.update',category:'performance',
    render:(p)=>{
      const words:Record<string,string>={performance:'your performance band',potential:'your potential band',talent:'your talent status',feedback:'your 360 feedback report'};
      const raw:unknown=p?.kinds,kinds=Array.isArray(raw)?raw.filter((k):k is string=>typeof k==='string'&&k in words).map(k=>words[k]):[];
      const list=kinds.length>1?`${kinds.slice(0,-1).join(', ')} and ${kinds.at(-1)}`:kinds[0]??'your results';
      return {severity:'info',title:'Your results are released',body:`HR has released ${list} to you. Open your performance record to see them.`,linkPath:'/me/performance'};
    },
  },
  // Performance closure (lifecycle G4). Release-safe: closeReview asserts the cycle is released before
  // closing, and the body says only that the review was finalized — never the score or ABC class (the
  // /me review surface gates the actual figures behind the existing release/showManager rules).
  'performance-review.closed': {recipientAudience:'subject',
    kind: 'performance.closed',
    category: 'performance',
    render: () => ({ severity: 'info', title: 'Performance review finalized', body: 'Your performance review has been finalized.', linkPath: '/me' }),
  },
  // Employment-review workflow (0110). started → fan out to the resolved direct manager (from the review
  // row) + the company's HR admins; manager-evaluated → HR admins; decided → the subject (default path).
  'employment-review.started': {recipientAudience:'reader',
    kind: 'review.started',
    category: 'review',
    render: () => ({
      severity: 'action',
      title: 'Review due',
      body: 'A probation / contract / internship review is due — confirm, extend or terminate.',
      linkPath: '/approvals',
    }),
    recipientPort:'legacyReviewStarted',recipients:readers.legacyReviewStarted,
  },
  'employment-review.manager-evaluated': {recipientAudience:'reader',
    kind: 'review.manager-evaluated',
    category: 'review',
    render: () => ({
      severity: 'action',
      title: 'Review ready for decision',
      body: 'A manager evaluation is ready — record the HR decision.',
      linkPath: '/approvals',
    }),
    recipientPort:'legacyReviewEvaluated',recipients:readers.legacyReviewEvaluated,
  },
  'employment-review.decided': [
    {recipientAudience:'subject',
      kind: 'review.decided',
      category: 'review',
      // Default subject path (no resolver) — notify the subject only. The decision itself is gated behind
      // the /me review surface; the body says only that the review is complete.
      render: () => ({ severity: 'info', title: 'Your review is complete', body: 'Your review has been finalized.', linkPath: '/me' }),
    },
    {recipientAudience:'reader',
      // 6522d26a Fn 5.2 — the follow-up "issue letter" HR task: same event, HR fan-out, deep-link to the
      // subject's profile review section where the save/upload affordances live. The notification IS the
      // task (a dedicated task table is deliberately out of scope).
      kind: 'review.issue-letter',
      category: 'review',
      render: (_p, ev) => ({
        severity: 'action',
        title: 'Issue review letter',
        body: 'A review was decided — generate the outcome letter and upload the signed copy.',
        linkPath: ev.subjectEmploymentId ? `/admin/personnel/${ev.subjectEmploymentId}` : '/approvals',
      }),
      recipientPort:'legacyReviewDecidedLetter',recipients:readers.legacyReviewDecidedLetter,
    },
  ],
  // 6522d26a Fn 2 — configurable reminder cadence: the sweep appends one reminder-due per (review,
  // offset window); recipients = assigned manager + the company's HR admins (clone of .started).
  'employment-review.reminder-due': {recipientAudience:'reader',
    kind: 'review.reminder',
    category: 'review',
    render: (p) => ({
      severity: 'action',
      title: 'Review reminder',
      body: `A ${p?.reviewType ?? ''} review is awaiting action — the period ends on ${p?.dueOn ?? ''}.`.replace('  ', ' '),
      linkPath: '/approvals',
    }),
    recipientPort:'legacyReviewReminder',recipients:readers.legacyReviewReminder,
  },
  // Global Delegation (Phase 1) — tell the STAND-IN (the delegate) when their cover starts / ends. The
  // event's subjectEmploymentId is the delegator (the person handing over), so a subject-default notice
  // would be wrong; a fan-out resolver reads the delegate off the reporting_line row (aggregateId) instead.
  // Deep-links to /delegations, where the full picture (who covers whom, windows, revoke) lives.
  'delegation.started': {recipientAudience:'reader',
    kind: 'delegation.started',
    category: 'delegation',
    render: (p) => ({
      severity: 'action',
      title: 'You are now a stand-in approver',
      body: `You have been assigned to cover approvals${p?.validFrom ? ` from ${p.validFrom}` : ''}${p?.validTo ? ` to ${p.validTo}` : ''}.`,
      linkPath: '/delegations',
    }),
    recipientPort:'delegationStarted',recipients:readers.delegationStarted,
  },
  'delegation.ended': {recipientAudience:'reader',
    kind: 'delegation.ended',
    category: 'delegation',
    render: (p) => ({
      severity: 'info',
      title: 'Your stand-in cover has ended',
      body: `Your approval cover has ended${p?.endDate ? ` (${p.endDate})` : ''}.`,
      linkPath: '/delegations',
    }),
    recipientPort:'delegationEnded',recipients:readers.delegationEnded,
  },
  // R51 722904dc/71b9143a — a leave approval step sat pending past the company's escalation threshold
  // (core/leave-escalation.ts, carried by the nightly review-sweep). WHO to chase rides in the payload
  // (targetKind, snapshotted at sweep time); WHETHER to chase is re-decided HERE, because dispatch is
  // cursor-driven and may run hours after the sweep (opportunistically on admin page render): if the step
  // — or the request — has since been decided, no notification is created. That re-check is what makes
  // "if the approver acts in time, nothing is sent" actually hold. English-only strings, the registry
  // convention (notification bodies are rendered once and STORED — there is no per-language version).
  'leave-request.escalation-due': {recipientAudience:'reader',
    kind: 'leave.escalation',
    category: 'leave',
    render: (p) => ({
      severity: 'action',
      title: 'Leave approval overdue',
      body: `A ${p?.leaveTypeName ?? 'leave'} request (${p?.startDate ?? ''} → ${p?.endDate ?? ''}) has been waiting for approval for ${p?.daysWaiting ?? ''} working day(s) and needs attention.`,
      linkPath: '/approvals',
    }),
    recipientPort:'leaveEscalation',recipients:readers.leaveEscalation,
  },
  // daa76ed4 — Attendance Escalation Approval moved a v4 request to its next level after the configured calendar
  // days with no decision. The next level's frozen participants are told, re-checked at dispatch: the request must
  // still be pending at that exact level. The subject is never a recipient.
  'attendance-workflow.stage.escalated': {recipientAudience:'reader',
    kind: 'attendance.escalated',
    category: 'attendance',
    render: (p) => ({
      severity: 'action',
      title: 'Attendance approval escalated to you',
      body: `An attendance request was not approved or rejected within ${typeof p?.escalateAfterDays === 'number' ? p.escalateAfterDays : ''} day(s) and has moved to your approval level.`,
      linkPath: '/approvals',
    }),
    recipientPort:'attendanceEscalation',recipients:readers.attendanceEscalation,
  },
  // WP13 (R18) — Automatic-tier chasers run by the tenant's agent principal (core/automatic-chasers.ts). The
  // event carries ids, stage and dates only; the copy is a fixed template (no model, no amount, no name). As for
  // the leave escalation, WHETHER to notify is re-decided here: the item must still be pending at the chased
  // stage, so an approver who acted after the sweep gets nothing. The subject is never a recipient.
  'automatic-chase.approval-raised': [
    approvalChaseSpec('claim', 'claim.approval-overdue', 'claims', 'Claim approval overdue', 'A claim'),
    approvalChaseSpec('attendance_correction', 'attendance.approval-overdue', 'attendance', 'Attendance request approval overdue', 'An attendance request'),
    approvalChaseSpec('replacement_leave', 'toil.approval-overdue', 'toil', 'Replacement leave approval overdue', 'A replacement leave request'),
  ],
  'automatic-chase.review-raised': {recipientAudience:'reader',
    kind: 'review.overdue',
    category: 'review',
    render: (p) => ({
      severity: 'action',
      title: 'Review decision overdue',
      body: `A ${typeof p?.reviewType === 'string' ? p.reviewType : ''} review passed its end date${typeof p?.waitingOn === 'string' ? ` (${p.waitingOn})` : ''} and still needs a decision.`.replace('A  review', 'A review'),
      linkPath: '/approvals',
    }),
    recipientPort:'automaticReviewChase',recipients:readers.automaticReviewChase,
  },
  'automatic-chase.followup-raised': [
    {recipientAudience:'reader',kind:'attendance.missing-clock',category:'attendance',render:p=>({severity:'action',title:'Please check your clock-in record',body:`No clock-in is recorded for ${typeof p?.waitingOn==='string'?p.waitingOn:''}. Check Attendance if a record is missing; this reminder does not establish whether you worked.`,linkPath:'/me'}),recipientPort:'missingClockFollowup',recipients:readers.missingClockFollowup},
    {recipientAudience:'reader',kind:'profile.passport-expiry',category:'profile',render:p=>({severity:'action',title:'Recorded passport expiry approaching',body:`A recorded passport expiry is ${typeof p?.waitingOn==='string'?p.waitingOn:''}. Check the Personnel record and follow your renewal process.`,linkPath:'/me'}),recipientPort:'passportFollowup',recipients:readers.passportFollowup},
    {recipientAudience:'reader',kind:'lifecycle.step-waiting',category:null,render:()=>({severity:'action',title:'Lifecycle checklist needs attention',body:'An actionable checklist step is still incomplete. Review the case; this reminder does not complete or verify any task.',linkPath:'/lifecycle'}),recipientPort:'lifecycleFollowup',recipients:readers.lifecycleFollowup},
  ],
  // 6e122302 — a Notice Board notice is A NOTIFICATION WITH A DIFFERENT PAYLOAD, which is why core/notice.ts
  // carries no delivery code of its own. Publishing appends notice.published; this entry fans it out to the
  // audience SNAPSHOT (notice_recipient) as ordinary in-app notifications, shown by the same bell as
  // everything else. Conditional email also uses this snapshot, tenant category permission and recipient
  // consent; the brief external alert carries a link instead of the notice's title/body.
  'notice.published': {recipientAudience:'reader',
    kind: 'notice.published',
    category: 'notice',
    // Delivery stays informational. Required current-version acknowledgements are live assigned work
    // from the Notice owner in the canonical inbox, so a historical notification cannot duplicate or
    // outlive the actual acknowledgement task after completion, withdrawal or a content revision.
    render: (p, ev) => ({
      severity: 'info',
      title: 'New notice',
      body: String(p?.title ?? 'A new notice has been published.'),
      linkPath: `/notices/${ev.aggregateId}`,
    }),
    recipientPort:'noticePublished',recipientGuard:noticeNotify,recipients:readers.noticePublished,
  },
  // The batch event has no single subject — fan out to every employee with a payslip in the closed batch.
  'payroll-batch.closed': {recipientAudience:'reader',
    kind: 'payslip.ready',
    category: 'payroll',
    render: () => ({ severity: 'info', title: 'Payslip ready', body: 'Your payslip is ready to view.', linkPath: '/me' }),
    recipientPort:'payrollClosed',recipients:readers.payrollClosed,
  },
  // AI v2 Phase 1 slice 3 (core/letter-requests.ts): HR declined an employee's letter request. The employee (the event's
  // subject) is told only that it was declined: no letter type, no reason, no HR name. In-app only (no email category).
  'letter-request.declined': {recipientAudience:'subject',
    kind: 'letter-request.declined',
    category: null,
    render: () => ({ severity: 'info', title: 'Letter request declined', body: 'Your letter request was declined. Open My Letters to see its status.', linkPath: '/me/letters' }),
  },
  // AI v2 Phase 2 P2-1 (core/loops/act-clock-outs.ts): the missed clock-outs loop, acting within its limits, set a missed
  // clock-out to the roster end through the attendance owner. The employee (the event's subject) is told the day, the
  // time and until when they can undo it on Today. Dates and a clock time only. In-app only (no email category).
  'teras-loop.action.applied': {recipientAudience:'subject',
    kind: 'teras-loop.clock-out-set',
    category: null,
    render: (p) => {
      const date = typeof p?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : 'a recent day';
      const time = typeof p?.checkOut === 'string' && /^\d{2}:\d{2}$/.test(p.checkOut) ? p.checkOut : 'your roster end';
      const until = typeof p?.undoUntil === 'string' && Number.isFinite(Date.parse(p.undoUntil))
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.undoUntil)) : null;
      return { severity: 'info', title: 'Missed clock-out filled in',
        body: `Your missing clock-out on ${date} was set to ${time}, the end of your roster.${until ? ` If that is wrong, undo it on Today by ${until}.` : ''}`, linkPath: '/' };
    },
  },
  // AI v2 Phase 2 P2-1 (core/loops/act-requests.ts): the missing employee data loop, acting within its limits, sent the
  // employee its request to fill in their own details. A count and their own request section only; no record changed.
  'teras-loop.request.sent': {recipientAudience:'subject',
    kind: 'teras-loop.details-requested',
    category: null,
    render: (p) => {
      const tab = p?.tab === 'bankStatutory' || p?.tab === 'payroll' ? p.tab : 'profile';
      const count = typeof p?.gaps === 'number' && Number.isInteger(p.gaps) && p.gaps > 0 ? p.gaps : null;
      return { severity: 'action', title: 'Please complete your details',
        body: count === 1 ? 'One detail is missing from your record. Fill it in on your profile; HR approves it as usual.'
          : `${count ?? 'Some'} details are missing from your record. Fill them in on your profile; HR approves them as usual.`,
        linkPath: `/me?tab=${tab}#section-request-${tab}` };
    },
  },
  'teras-loop.request.withdrawn': {recipientAudience:'subject',
    kind: 'teras-loop.details-request-withdrawn',
    category: null,
    render: () => ({ severity: 'info', title: 'Details request withdrawn', body: 'The request to complete your details was withdrawn. You can ignore it.', linkPath: '/me' }),
  },
  [EMPLOYEE_LOOP_DIGEST_EVENT]: {recipientAudience:'reader',
    kind:'teras-loop.employee-digest',category:'readiness',
    recipientPort:'employeeLoopDigest',recipients:readers.employeeLoopDigest,
    render:()=>({severity:'action',title:'Your daily action digest',
      body:'Open Today to review the items that need your attention.',linkPath:'/#today-needs-you'}),
  },
  // AI v2 Phase 2 hardening (core/loops/cut-off-reminders.ts, owner ruling 18): the Pre-salary loop's automatic cut-off
  // reminder, 5, 2 or 1 days before a payroll cut-off, to the person (the event's subject) about their OWN pending items and
  // the requests waiting on them. In-app only (no email category). Stored as message KEYS, which the bell renders in the
  // reader's own language (components/notification-center.tsx, payrollReadiness.reminder.* in all six catalogues), like the
  // greeting and letter notices: the title says how soon, the body whether items of their own, requests to decide, or
  // both wait. Never a pay figure, an amount, a count of someone else's or another person's name. It opens Today.
  'teras-loop.cut-off-reminder': {recipientAudience:'subject',
    kind: 'teras-loop.cut-off-reminder',
    category: null,
    render: (p) => {
      const lead = typeof p?.leadDays === 'number' && [5, 2, 1].includes(p.leadDays) ? `lead${p.leadDays}` : 'soon';
      const own = typeof p?.ownItems === 'number' && Number.isInteger(p.ownItems) && p.ownItems > 0;
      const approvals = typeof p?.approvals === 'number' && Number.isInteger(p.approvals) && p.approvals > 0;
      return { severity: 'action', title: `payrollReadiness.reminder.title.${lead}`,
        body: `payrollReadiness.reminder.body.${own && approvals ? 'both' : approvals ? 'approvals' : 'own'}`, linkPath: '/' };
    },
  },
  // Shared bulk-job kernel (core/bulk-job-worker.ts): the person who started a background import is told when it
  // finished, failed or was stopped. Only the job's recorded notice event, appended by its creator, resolves a recipient
  // (app.bulk_job_notice_recipients, migration 5011). In-app only (no email category). Stored as message KEYS like the
  // cut-off reminder; the bell renders them in the reader's language (bulkJobs.notification.* in all six catalogues).
  // Never a row count, file name or another person's name. It opens the kind's Import History.
  'bulk-job.finished': {recipientAudience:'reader',
    kind: 'bulk-job.finished',
    category: null,
    recipientPort:'bulkJobInitiator',recipients:readers.bulkJobInitiator,
    render: (p) => {
      const keys = bulkJobNoticeKeys(typeof p?.kind === 'string' ? p.kind : '', typeof p?.outcome === 'string' ? p.outcome : '');
      return keys ? { severity: 'info', title: keys.title, body: keys.body, linkPath: keys.linkPath }
        : { severity: 'info', title: 'Background job finished', body: 'Open the page where you started it to see the outcome.', linkPath: '/' };
    },
  },
};
 for(const entry of Object.values(registry))for(const spec of Array.isArray(entry)?entry:[entry])assertNotificationRecipeAudience(spec,readers);
 // One installed guard description powers both the pure caller and native
 // audience admission; native code interprets this closed boolean predicate.
 for(const entry of Object.values(registry))for(const spec of Array.isArray(entry)?entry:[entry])if(spec.recipientGuard){
  const guard=spec.recipientGuard,read=spec.recipients??subjectRecipient;
  spec.recipients=(reader,event,payload,noticeReader)=>payloadGuardMatches(payload,guard)?read(reader,event,payload,noticeReader):Promise.resolve([]);
 }
 return registry;
}

