/**
 * Probation Confirmation's catalogue for the shared builders (handoff A1; prototype "Probation Confirmation" trigger
 * category). Labels follow the prototype. Ids are stable storage keys.
 *
 * `legacyEvents` maps each event of the notify-only Probation engine (`lib/probation-workflow.ts`) onto this
 * catalogue, so existing definitions can be moved without losing a capability (the automation floor). Mappings marked
 * `exact: false` are proposals: build step 4 must prove them against the sweep's issue rules (migration 0949,
 * app.probation_* notification functions) before any stored definition is converted. Events with no equivalent in the
 * prototype stay as triggers of their own.
 */
import type {AutomationModuleCatalogue} from '../catalogue';

const PARTS = ['Part 1 · Week 1 Success Plan', 'Part 2 · Mid-Probation Review', 'Part 3 · Final Confirmation Review'] as const;
const PART_TRIGGERS = ['dueAfterStart', 'formIssued', 'dueBeforeReview', 'lmSubmitted', 'acknowledged', 'approvalsComplete', 'returned', 'lowResult', 'outcomeOverridden', 'declinedToSign', 'outcomeDecided', 'approvalPending', 'kpiOverdue'] as const;
const OUTCOME_TRIGGERS = ['outcomeDecided', 'letterActionNeeded', 'letterSentBack', 'letterReleased', 'letterReleasePending'] as const;
const SCORE_TRIGGERS = ['lmSubmitted', 'lowResult', 'outcomeOverridden'] as const;
const LETTER_TRIGGERS = ['letterActionNeeded', 'letterSentBack', 'letterReleased', 'letterReleasePending'] as const;
const PENDING_TRIGGERS = ['dueAfterStart', 'dueBeforeReview', 'kpiOverdue'] as const;

export const PROBATION_AUTOMATION_CATALOGUE: AutomationModuleCatalogue = {
  module: 'probation', label: 'Probation',
  triggers: [
    { id: 'caseOpened', label: 'A probation case opens' },
    { id: 'dueAfterStart', label: 'Days after the start date', dated: { anchor: 'startDate', direction: 'after' } },
    { id: 'formIssued', label: 'A review form opens' },
    { id: 'dueBeforeReview', label: 'Days before a review due date', dated: { anchor: 'reviewDueDate', direction: 'before' } },
    { id: 'lmSubmitted', label: 'The Line Manager submits an assessment' },
    { id: 'lowResult', label: 'A low result is recorded (Band 1–2)' },
    { id: 'outcomeOverridden', label: 'The suggested outcome is overridden' },
    { id: 'acknowledged', label: 'The employee acknowledges a part' },
    { id: 'declinedToSign', label: 'The employee declines to sign' },
    { id: 'approvalsComplete', label: 'All approvals for a part are completed' },
    { id: 'returned', label: 'An approval is returned with comments' },
    { id: 'outcomeDecided', label: 'The probation outcome is decided' },
    { id: 'letterActionNeeded', label: 'A letter needs a review, approval or signature' },
    { id: 'letterSentBack', label: 'A letter is sent back for changes' },
    { id: 'letterReleased', label: 'A letter is signed and released' },
    // Kept from the notify-only engine: no prototype equivalent.
    { id: 'approvalPending', label: 'A part is waiting for approval' },
    { id: 'kpiOverdue', label: 'Week 1 KPIs are overdue', dated: { anchor: 'kpiOverdueDate', direction: 'after' } },
    { id: 'letterReleasePending', label: 'A signed letter is waiting to be released' },
    { id: 'overdueSummary', label: 'Overdue summary (daily)' },
  ],
  skipWhen: [
    { id: 'never', label: 'Never skip' },
    { id: 'caseClosed', label: 'The case is already closed' },
    { id: 'noPbp', label: 'No People Business Partner is found for the case' },
  ],
  conditionFields: [
    { id: 'part', label: 'Part', ops: ['is', 'isNot'], values: PARTS, triggers: PART_TRIGGERS },
    { id: 'outcome', label: 'Outcome', ops: ['is', 'isNot'], values: ['Confirm', 'Extend', 'Non-confirmation', 'Other'], triggers: OUTCOME_TRIGGERS },
    { id: 'reviewPlan', label: 'Review plan', ops: ['is', 'isNot'], values: ['3 months', '6 months'] },
    { id: 'businessGroup', label: 'Business group', ops: ['is', 'isNot'] },
    { id: 'company', label: 'Company', ops: ['is', 'isNot'] },
    { id: 'department', label: 'Department', ops: ['is', 'isNot'] },
    { id: 'jobGrade', label: 'Job grade', ops: ['is', 'isNot'] },
    { id: 'extensionsUsed', label: 'Extensions used', ops: ['is', 'isNot', 'lt', 'lte', 'gte'] },
    { id: 'resultBand', label: 'Result band', ops: ['is', 'isNot', 'lte', 'gte'], values: ['1', '2', '3', '4', '5'], triggers: SCORE_TRIGGERS },
    { id: 'suggestionOverridden', label: 'Suggestion overridden', ops: ['is'], values: ['Yes', 'No'], triggers: SCORE_TRIGGERS },
    { id: 'pendingStep', label: 'Pending step', ops: ['is', 'isNot'], values: ['Line Manager', 'Employee', 'HOD', 'PBP', 'Nobody (all steps done)'], triggers: PENDING_TRIGGERS },
  ],
  stepTypes: [
    { id: 'generateDocument', label: 'Generate a document' },
    { id: 'sendEmail', label: 'Send an email' },
    { id: 'notify', label: 'Notify someone' },
    { id: 'createPosting', label: 'Create Personnel Management posting' },
    { id: 'startOffboarding', label: 'Start offboarding case' },
    // "Request approval" is deliberately absent: Probation letters use the document's own signing routing (handoff B4).
  ],
  recipients: [
    { id: 'employee', label: 'The employee', kind: 'role' },
    { id: 'directSuperior', label: 'Their Direct Superior', kind: 'role' },
    { id: 'routing', label: 'A routing', kind: 'routing' },
    { id: 'group', label: 'An assignment group', kind: 'group' },
    { id: 'person', label: 'Named people', kind: 'person' },
    { id: 'pendingStep', label: 'Whoever’s step is pending', kind: 'pending' },
  ],
  mergeFields: [
    { key: 'employee.name', label: 'Full name', group: 'Employee' },
    { key: 'employee.id', label: 'Employee ID', group: 'Employee' },
    { key: 'employee.firstName', label: 'First name', group: 'Employee' },
    { key: 'employee.jobTitle', label: 'Job title', group: 'Employee' },
    { key: 'employee.grade', label: 'Job grade', group: 'Employee' },
    { key: 'org.businessGroup', label: 'Business group', group: 'Organisation' },
    { key: 'org.company', label: 'Company', group: 'Organisation' },
    { key: 'org.department', label: 'Department', group: 'Organisation' },
    { key: 'people.lineManager', label: 'Line Manager', group: 'People' },
    { key: 'people.hod', label: 'Head of Department', group: 'People' },
    { key: 'people.pbp', label: 'People Business Partner', group: 'People' },
    { key: 'probation.startDate', label: 'Start date', group: 'Probation' },
    { key: 'probation.originalEndDate', label: 'Original end date', group: 'Probation' },
    { key: 'probation.endDate', label: 'Current probation end date', group: 'Probation' },
    { key: 'probation.reviewPlan', label: 'Review plan', group: 'Probation' },
    { key: 'probation.part', label: 'Part', group: 'Probation', triggers: PART_TRIGGERS },
    { key: 'probation.dueDate', label: 'Review due date', group: 'Probation', triggers: ['formIssued', 'dueBeforeReview', 'dueAfterStart', 'kpiOverdue', 'approvalPending'] },
    { key: 'probation.outcome', label: 'Outcome', group: 'Probation', triggers: OUTCOME_TRIGGERS },
    { key: 'probation.confirmationDate', label: 'Confirmation effective date', group: 'Probation', triggers: OUTCOME_TRIGGERS },
    { key: 'probation.extensionLength', label: 'Extension length', group: 'Probation', triggers: OUTCOME_TRIGGERS },
    { key: 'probation.newEndDate', label: 'New end date', group: 'Probation', triggers: OUTCOME_TRIGGERS },
    { key: 'probation.extensionNumber', label: 'Extension number', group: 'Probation', triggers: OUTCOME_TRIGGERS },
    { key: 'probation.resultBand', label: 'Result band', group: 'Probation', triggers: SCORE_TRIGGERS },
    { key: 'letter.documentName', label: 'Letter name', group: 'Letter', triggers: LETTER_TRIGGERS },
    { key: 'letter.signingStep', label: 'Signing step waiting', group: 'Letter', triggers: ['letterActionNeeded'] },
    { key: 'letter.sentBackBy', label: 'Sent back by', group: 'Letter', triggers: ['letterSentBack'] },
    { key: 'letter.sentBackReason', label: 'Reason it was sent back', group: 'Letter', triggers: ['letterSentBack'] },
    { key: 'case.link', label: 'Link to the case', group: 'General' },
    { key: 'today', label: 'Today', group: 'General' },
  ],
  legacyEvents: [
    { event: 'kpi_assigned', trigger: 'formIssued', preset: [{ field: 'part', op: 'is', values: [PARTS[0]] }], exact: false, note: 'Issued on the Part 1 issue date.' },
    { event: 'kpi_reminder', trigger: 'dueAfterStart', preset: [{ field: 'part', op: 'is', values: [PARTS[0]] }], exact: false, note: 'Days come from the settings KPI reminder milestone.' },
    { event: 'kpi_overdue', trigger: 'kpiOverdue', exact: true },
    { event: 'review_issued', trigger: 'formIssued', preset: [{ field: 'part', op: 'isNot', values: [PARTS[0]] }], exact: false },
    { event: 'review_reminder', trigger: 'dueBeforeReview', exact: false, note: 'Old engine suppresses it per role once that role has submitted.' },
    { event: 'review_due', trigger: 'dueBeforeReview', exact: false, note: 'Zero days before the due date.' },
    { event: 'approval_pending', trigger: 'approvalPending', exact: true },
    { event: 'letter_released', trigger: 'letterReleased', exact: true },
    { event: 'letter_signing_pending', trigger: 'letterActionNeeded', exact: false, note: 'New trigger also covers Review and Approve steps.' },
    { event: 'letter_release_pending', trigger: 'letterReleasePending', exact: true },
    { event: 'letter_returned', trigger: 'letterSentBack', exact: true },
    { event: 'overdue_summary', trigger: 'overdueSummary', exact: true },
  ],
};

/** Recipients of the notify-only engine and how they are named in the shared builder. `hod` and `pbp` resolve
 * through the routings "HOD by business group and department" and "BP by business group"; `gbs` through the
 * GBS People Ops assignment group (handoff B5). */
export const PROBATION_LEGACY_RECIPIENTS = { employee: 'employee', lm: 'directSuperior', hod: 'routing', pbp: 'routing', gbs: 'group' } as const;
/** Merge tokens of the notify-only engine (`{{token}}`) and their shared merge field. */
export const PROBATION_LEGACY_MERGE_FIELDS = { employeeName: 'employee.name', employeeCode: 'employee.id', part: 'probation.part', dueOn: 'probation.dueDate', endOn: 'probation.endDate', companyName: 'org.company' } as const;
