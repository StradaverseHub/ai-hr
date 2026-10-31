/** WP3 / R15. Process workload prioritizes review; it never grants a capability or changes a tier. */
import { agentBacklogEntries } from './agent-capability-inventory';
import type { ProcessAssessment, ProcessId } from '../../core/process-assessment';

export const BACKLOG_RANKING_VERSION = 'backlog-v1';
type Entry = ReturnType<typeof agentBacklogEntries>[number];
/** Reviewed links to the actual ADR-0131 case owners. Configuration, payroll, performance, imports,
 * assets and new onboarding-v3 work have no matching baseline. Do not borrow a nearby module's counts.
 * Shared lifecycle/approval entry points link several processes; the strongest measured process is the
 * ranking basis, never a sum that double-counts people. These are process-level proxies, not entry usage. */
export const BACKLOG_PROCESS_LINKS: Readonly<Record<string, readonly ProcessId[]>> = {
  'app/(app)/admin/personnel/profile-changes/actions.ts#decideProfileChangeAction': ['profile_change'],
  'app/(app)/admin/personnel/profile-changes/actions.ts#rerouteProfileChangeAction': ['profile_change'],
  'app/(app)/approvals/actions.ts#approveProfileChangeAction': ['profile_change'],
  'app/(app)/approvals/actions.ts#bulkDecideAction': ['leave', 'claims', 'attendance_correction', 'profile_change'],
  'app/(app)/approvals/actions.ts#decideLeaveCancellationAction': ['leave'],
  'app/(app)/approvals/actions.ts#decideLeaveDateAction': ['leave'],
  'app/(app)/approvals/actions.ts#decideLeaveDatesAction': ['leave'],
  'app/(app)/attendance/application-history/actions.ts#attendanceHistoryAction': ['attendance_correction'],
  'app/(app)/attendance/application-history/actions.ts#attendanceHistoryBulkAction': ['attendance_correction'],
  'app/(app)/claims/actions.ts#deleteDraftAction': ['claims'],
  'app/(app)/claims/actions.ts#submitClaimAction': ['claims'],
  'app/(app)/leave/actions.ts#adminCancelLeaveAction': ['leave'],
  'app/(app)/leave/actions.ts#leaveApplySummaryAction': ['leave'],
  'app/(app)/leave/actions.ts#previewLeaveDeductionAction': ['leave'],
  'app/(app)/leave/actions.ts#requestLeaveCancellationAction': ['leave'],
  'app/(app)/me/actions.ts#myCancelAttendanceRequest': ['attendance_correction'],
  'app/(app)/me/actions.ts#myPreviewLeaveDeduction': ['leave'],
  'app/(app)/me/actions.ts#myRequestLeaveCancellation': ['leave'],
  'app/(app)/me/actions.ts#myRequestProfileChange': ['profile_change'],
  'app/(app)/me/actions.ts#myWithdrawOvertimePlan': ['attendance_correction'],
  'app/(app)/lifecycle/actions.ts#createOnboardingAction': ['onboarding'],
  'app/(app)/lifecycle/actions.ts#createOffboardingAction': ['offboarding'],
  'app/(app)/lifecycle/actions.ts#updateCaseAction': ['onboarding', 'offboarding'],
  'app/(app)/lifecycle/actions.ts#tickStepAction': ['onboarding', 'offboarding'],
  'app/(app)/lifecycle/actions.ts#undoStepAction': ['onboarding', 'offboarding'],
  'app/(app)/lifecycle/actions.ts#outcomeAction': ['onboarding', 'offboarding'],
  'app/(app)/lifecycle/actions.ts#cancelCaseAction': ['onboarding', 'offboarding'],
  'app/(app)/lifecycle/actions.ts#reopenCaseAction': ['onboarding', 'offboarding'],
  'app/(app)/lifecycle/actions.ts#commentAction': ['onboarding', 'offboarding'],
};
export type BacklogMeasurement = 'measured' | 'outside_baseline' | 'module_off' | 'unlinked';
export type RankedBacklogEntry = Entry & {
  id: string; rank: number; processes: readonly ProcessId[]; basis: ProcessId | null;
  staffActionsPer30: number | null; peopleAffected: number | null; measurement: BacklogMeasurement;
};
const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const workloadOrder = (a: {staffActionsPer30:number|null;peopleAffected:number|null}, b: {staffActionsPer30:number|null;peopleAffected:number|null}) =>
  (b.staffActionsPer30 ?? -1) - (a.staffActionsPer30 ?? -1) || (b.peopleAffected ?? -1) - (a.peopleAffected ?? -1);

/** Complete inventory coverage, including explicit null measurements. Zero recorded work is not unknown. */
export function rankAgentBacklog(processes: readonly ProcessAssessment[]): RankedBacklogEntry[] {
  const byId = new Map(processes.map(p => [p.id, p]));
  return agentBacklogEntries().map(entry => {
    const id = `${entry.source}#${entry.entry}`;
    const links = BACKLOG_PROCESS_LINKS[id] ?? [];
    const linked = links.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const measured = linked.filter(p => p.enabled && p.staffActionsPer30 !== null)
      .sort((a,b) => workloadOrder(a,b) || textOrder(a.id,b.id));
    const basis = measured[0];
    const measurement: BacklogMeasurement = basis ? 'measured' : !links.length ? 'outside_baseline'
      : linked.some(p => p.enabled) ? 'unlinked' : 'module_off';
    return { ...entry, id, rank: 0, processes: links, basis: basis?.id ?? null,
      staffActionsPer30: basis?.staffActionsPer30 ?? null, peopleAffected: basis?.peopleAffected ?? null, measurement };
  }).sort((a,b) => workloadOrder(a,b) || textOrder(a.id,b.id)).map((row,i) => ({...row, rank:i+1}));
}
