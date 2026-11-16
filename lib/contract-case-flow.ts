/**
 * Contract's shared-automation state machine. Version 2 is explicit: legacy cases must never be silently
 * reinterpreted or execute both the automatic record effect and an approved posting. Persistence supplies
 * fresh capabilities, source facts, clock and revision. This model never writes Personnel or Payroll.
 */
import {isCalendarDate} from './calendar-date';
import {addDaysIso} from './roster-month';
import {addCalendarMonths} from './hr-date';
import {parseContractAmount, ContractManagementError} from './contract-management-model';

export const CONTRACT_CASE_PERMISSIONS = ['view', 'seePay', 'decide', 'decline', 'manual', 'workflows', 'templates', 'groups', 'access'] as const;
export type ContractCasePermission = typeof CONTRACT_CASE_PERMISSIONS[number];
export type ContractFlowStage = 'open' | 'approval' | 'workflow' | 'document' | 'posting' | 'pay' | 'renewed' | 'converted' | 'offboarding' | 'superseded';
export type ContractDecisionKind = 'renew' | 'convert' | 'end';
export type ContractFlowDecision = {
  kind: ContractDecisionKind; startOn: string | null; endOn: string | null; months: number | null;
  payChanges: boolean; salaryCents: string | null; reason: string; endReason: string | null;
  submittedBy: string; submittedAt: string; revision: number;
};
export type ContractFlowFlag = 'fallback' | 'employee_cannot_sign' | 'sent_back' | 'template_stopped' | 'posting_mismatch' | 'no_workflow' | 'pay_pending' | 'source_changed';
export type ContractFlow = {
  version: 2; revision: number; stage: ContractFlowStage;
  period: {id: string; startOn: string; endOn: string; number: string; sourceRevision: string};
  decision: ContractFlowDecision | null; decisionHistory: ContractFlowDecision[];
  flags: ContractFlowFlag[]; lastActivityAt: string;
  posting: {id: string; approvedBy: string | null; approvedAt: string | null} | null;
  payConfirmation: {by: string; at: string} | null;
  offboardingId: string | null; declined: {reason: string; notes: string; by: string; at: string} | null;
  firstReminderOn?:string|null;sourceClosure?:{reason:string;at:string};
};
export type ContractFlowActor = {userId: string; permissions: readonly ContractCasePermission[]; postingApprover: boolean; admin: boolean};
export type ContractFlowSettings = {
  fallbackGroupId: string; postingApproverGroupId: string; stallEnabled: boolean; stallDays: number;
  automaticSuperior: {enabled: boolean; permissions: ContractCasePermission[]};
};
export const DEFAULT_CONTRACT_FLOW_SETTINGS: ContractFlowSettings = {
  fallbackGroupId: 'g-peopleops', postingApproverGroupId: 'g-peopleops', stallEnabled: true, stallDays: 5,
  automaticSuperior: {enabled: true, permissions: ['view', 'decide']},
};
function refuse(message: string): never {throw new ContractManagementError('invalid', message);}
function conflict(message: string): never {throw new ContractManagementError('conflict', message);}
function actorCan(actor: ContractFlowActor, permission: ContractCasePermission) {
  if (!actor.userId || !actor.admin && !actor.permissions.includes(permission)) throw new ContractManagementError('forbidden', 'This Contract action is unavailable.');
}
function timestamp(at: string) {if (!Number.isFinite(Date.parse(at))) refuse('A verified action time is required.');}
function revision(record: ContractFlow, expected: number) {if (record.revision !== expected) conflict('This case changed. Reload before acting.');}
function touched(record: ContractFlow, at: string): ContractFlow {timestamp(at); return {...record, revision: record.revision + 1, lastActivityAt: at};}
export function validateContractFlowSettings(value: ContractFlowSettings): void {
  if (!value.fallbackGroupId.trim() || !value.postingApproverGroupId.trim()) refuse('Choose the fallback and posting approver groups.');
  if (!Number.isInteger(value.stallDays) || value.stallDays < 1 || value.stallDays > 60) refuse('Stalled-case days must be between 1 and 60.');
  if (value.automaticSuperior.permissions.some(p => !['view', 'seePay', 'decide', 'decline', 'manual'].includes(p))) refuse('Automatic team access cannot grant module administration.');
}
export function newContractFlow(period: ContractFlow['period'], at: string): ContractFlow {
  if (!period.id || !period.sourceRevision || !isCalendarDate(period.startOn) || !isCalendarDate(period.endOn) || period.endOn < period.startOn) refuse('Verify the current contract period in Personnel Management.');
  timestamp(at);
  return {version: 2, revision: 1, stage: 'open', period: {...period}, decision: null, decisionHistory: [], flags: [], lastActivityAt: at, posting: null, payConfirmation: null, offboardingId: null, declined: null};
}
export type ContractFlowDecisionDraft = {kind: ContractDecisionKind; startOn?: string; endOn?: string; months?: number; payChanges: boolean; basicSalary?: string; reason: string; endReason?: string};
/** Validation is independent of current-pay visibility: proposed salary does not require reading current salary. */
export function validateContractFlowDecision(record: ContractFlow, draft: ContractFlowDecisionDraft): Omit<ContractFlowDecision, 'submittedBy' | 'submittedAt' | 'revision'> {
  if (!['renew', 'convert', 'end'].includes(draft.kind)) refuse('Choose Renew, End or Convert to permanent.');
  if (!draft.reason.trim() && draft.kind !== 'end') refuse('Enter a reason for this decision.');
  if (draft.reason.length > 5000) refuse('Use no more than 5,000 characters for the reason.');
  if (!isCalendarDate(record.period.endOn)) refuse('A current contract end date is required.');
  if (draft.kind === 'end') {
    if (!draft.endReason?.trim()) refuse('Choose a Personnel Management reason for ending.');
    return {kind: 'end', startOn: null, endOn: null, months: null, payChanges: false, salaryCents: null, reason: draft.reason.trim(), endReason: draft.endReason!.trim()};
  }
  const startOn = draft.startOn || addDaysIso(record.period.endOn, 1);
  if (!isCalendarDate(startOn) || startOn <= record.period.endOn) refuse('New start must be after the current contract end.');
  let endOn: string | null = null, months: number | null = null;
  if (draft.kind === 'renew') {
    if (draft.months !== undefined && (!Number.isInteger(draft.months) || draft.months < 3 || draft.months > 120)) refuse('The minimum renewal term is 3 months.');
    endOn = draft.endOn || (draft.months ? addDaysIso(addCalendarMonths(startOn, draft.months), -1) : '');
    if (!isCalendarDate(endOn) || endOn <= startOn) refuse('New end must be after the new start.');
    if (endOn < addDaysIso(addCalendarMonths(startOn, 3), -1)) refuse('The minimum renewal term is 3 months.');
    // Dates are authoritative. Only retain a term when it agrees with the explicit dates.
    months = draft.months && addDaysIso(addCalendarMonths(startOn, draft.months), -1) === endOn ? draft.months : null;
  }
  const salaryCents = draft.payChanges ? parseContractAmount(draft.basicSalary ?? '') : null;
  return {kind: draft.kind, startOn, endOn, months, payChanges: draft.payChanges, salaryCents, reason: draft.reason.trim(), endReason: null};
}
export function submitContractFlowDecision(record: ContractFlow, input: {actor: ContractFlowActor; expectedRevision: number; draft: ContractFlowDecisionDraft; at: string; preflightProblems: readonly string[]}): ContractFlow {
  actorCan(input.actor, 'decide'); revision(record, input.expectedRevision);
  if (record.stage !== 'open') conflict('The submitted decision is fixed. Return the current decision before changing it.');
  if (input.preflightProblems.length) refuse(`Can’t submit. ${input.preflightProblems.join(' ')} People Ops can fix this in Assignment groups, Workflows or Templates.`);
  const decision = {...validateContractFlowDecision(record, input.draft), submittedBy: input.actor.userId, submittedAt: input.at, revision: (record.decisionHistory.at(-1)?.revision ?? 0) + 1};
  return {...touched(record, input.at), stage: 'workflow', decision, flags: record.flags.filter(f => !['no_workflow', 'posting_mismatch'].includes(f))};
}
export function rejectContractFlowDecision(record: ContractFlow, input: {expectedRevision: number; reason: string; at: string}): ContractFlow {
  revision(record, input.expectedRevision);
  if (record.stage !== 'approval' || !record.decision) conflict('This decision is not waiting for approval.');
  if (!input.reason.trim()) refuse('Enter the rejection reason.');
  return {...touched(record, input.at), stage: 'open', decisionHistory: [...record.decisionHistory, record.decision], decision: null};
}
/** Run executor uses the pinned decision; it must not read another period's terms when resumed. */
export function contractPostingKindMatches(record: ContractFlow, kind: string): boolean {
  return !!record.decision && (record.decision.kind === 'renew' && kind === 'Renewal' || record.decision.kind === 'convert' && kind === 'Conversion to permanent');
}
export function approveContractFlowPosting(record: ContractFlow, input: {actor: ContractFlowActor; expectedRevision: number; postingId: string; at: string}): ContractFlow {
  if (!input.actor.userId || !input.actor.admin && !input.actor.postingApprover) throw new ContractManagementError('forbidden', 'Only the Contract posting approver group can approve.');
  if (record.posting?.id === input.postingId && record.posting.approvedAt) return record;
  revision(record, input.expectedRevision);
  if (record.stage !== 'posting' || record.posting?.id !== input.postingId || !record.decision || record.decision.kind === 'end') conflict('This posting is not awaiting approval.');
  const pay = record.decision.payChanges;
  return {...touched(record, input.at), stage: pay ? 'pay' : record.decision.kind === 'renew' ? 'renewed' : 'converted', posting: {...record.posting, approvedBy: input.actor.userId, approvedAt: input.at}, flags: pay ? [...new Set([...record.flags, 'pay_pending' as const])] : record.flags};
}
export function confirmContractFlowPay(record: ContractFlow, input: {actor: ContractFlowActor; expectedRevision: number; confirmed: boolean; at: string}): ContractFlow {
  if (!input.actor.userId || !input.actor.admin && !input.actor.postingApprover) throw new ContractManagementError('forbidden', 'Only the Contract posting approver group can confirm pay.');
  if (record.payConfirmation) return record;
  revision(record, input.expectedRevision);
  if (!input.confirmed || record.stage !== 'pay' || !record.posting?.approvedAt || !record.decision?.payChanges || record.decision.kind === 'end') conflict('Approve the posting and confirm the separate Payroll entry first.');
  return {...touched(record, input.at), stage: record.decision.kind === 'renew' ? 'renewed' : 'converted', payConfirmation: {by: input.actor.userId, at: input.at}, flags: record.flags.filter(f => f !== 'pay_pending')};
}
export function recordContractFlowDecline(record: ContractFlow, input: {actor: ContractFlowActor; expectedRevision: number; employeeStepPending: boolean; reason: string; notes: string; at: string}): ContractFlow {
  actorCan(input.actor, 'decline'); revision(record, input.expectedRevision);
  if (record.stage !== 'document' || !input.employeeStepPending || record.decision?.kind !== 'renew') conflict('A renewal may be declined only while the employee signature is pending.');
  if (!input.reason.trim()) refuse('Choose the reason the employee declined.');
  return {...touched(record, input.at), stage: 'workflow', declined: {reason: input.reason.trim(), notes: input.notes.trim(), by: input.actor.userId, at: input.at}};
}
export function contractFlowDisplay(record: ContractFlow, input: {today: string; firstReminderOn: string | null; stallEnabled: boolean; stallDays: number}): {status: 'Upcoming' | 'Decision needed' | 'In progress' | 'Closed'; stalledDays: number | null} {
  if (!isCalendarDate(input.today)) refuse('Use the HR business date.');
  const closed = ['renewed', 'converted', 'offboarding','superseded'].includes(record.stage);
  const status = closed ? 'Closed' : record.stage !== 'open' ? 'In progress' : record.period.endOn < input.today || input.firstReminderOn && input.today >= input.firstReminderOn ? 'Decision needed' : 'Upcoming';
  const days = Math.floor((Date.parse(input.today + 'T00:00:00+08:00') - Date.parse(record.lastActivityAt)) / 86400000);
  return {status, stalledDays: !closed && record.stage !== 'open' && input.stallEnabled && days >= input.stallDays ? days : null};
}
/** Only a storage worker supplies verified native changes here. This never changes Personnel or waives a pay tick. */
export function supersedeContractFlow(record:ContractFlow,input:{reason:string;at:string}):ContractFlow{
 if(['renewed','converted','offboarding','superseded'].includes(record.stage)||record.posting?.approvedAt)return record;
 if(!input.reason.trim())refuse('Record why Personnel no longer matches this period.');
 return {...touched(record,input.at),stage:'superseded',sourceClosure:{reason:input.reason.trim(),at:input.at},flags:[...new Set([...record.flags,'source_changed' as const])]};
}
