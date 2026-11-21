import { getTranslations } from 'next-intl/server';
import { attendanceStageLevelNumber, type AttendanceResolvedStage, type AttendanceSkippedLevel } from '@/lib/attendance-workflow';
import { attendanceRouteLevelStatuses } from '@/lib/attendance-progress';
import { attendanceLevelProblemMessageKey, type AttendanceLevelProblem } from '@/lib/attendance-workflow-v3';
import type { AttendanceSubmissionReason } from '@/lib/attendance-workflow-submission';
import { attendanceLevelStatusLabel } from '@/lib/attendance-progress-labels';

/** The route a submission would freeze (core/attendance-workflow.ts submissionRouteForSubjectTx), as the submit screens show it. */
export type AttendanceSubmissionRouteView =
  | { available: true; stages: AttendanceResolvedStage[]; skippedLevels?: AttendanceSkippedLevel[]; approverCodes?: Record<string, string | null> }
  | { available: false; reason: AttendanceSubmissionReason; problem?: AttendanceLevelProblem; levelCount?: number };

/**
 * Board 237c31e6 — the approval progress panel before Submit: every level of the route and its approver with their
 * Employee ID, Level 1 Pending Approval and every later level Waiting for Previous Level Approval. When the route
 * cannot be resolved the refusal is shown and, when the failing level is known, a configuration warning sits on
 * that level; Submit stays disabled as before. Pages await this once and pass the result to the form, so it holds
 * no reads of its own and renders the same in static markup.
 */
export async function AttendanceSubmissionRouteProgress({ route }: { route: AttendanceSubmissionRouteView }) {
  const t = await getTranslations('attendanceHistory'), w = await getTranslations('attendanceWorkflow'), v3 = await getTranslations('attendanceWorkflow.v3');
  if (!route.available) {
    const problem = route.reason === 'unresolved' ? route.problem : undefined;
    const count = problem && problem.levelIndex != null && route.levelCount && problem.levelIndex < route.levelCount ? route.levelCount : 0;
    return <div className="w-full space-y-2" data-approval-route="unavailable">
      <p role="status" className="text-sm">{w(`submissionRefusals.${route.reason}`)}</p>
      {count > 0 && <ol className="divide-y divide-border text-sm">{Array.from({ length: count }, (_, index) => <li key={index} className="space-y-1 py-2" data-approval-level={index + 1}>
        <p className="font-medium">{t('levelNumber', { level: index + 1 })}</p>
        {index === problem!.levelIndex && <div role="alert" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p>{t('configurationWarning')}</p>
          <p className="text-xs">{v3(attendanceLevelProblemMessageKey(problem!))}</p>
        </div>}
      </li>)}</ol>}
    </div>;
  }
  const codes = route.approverCodes ?? {};
  const person = (a: { kind: string; name: string; employmentId?: string | null }) => a.kind === 'hr_admin' ? t('hrApprover') : `${a.name}${a.employmentId && codes[a.employmentId] ? ` · ${codes[a.employmentId]}` : ''}`;
  const sourceNames = (sources: AttendanceSkippedLevel['sources']) => sources.map(source => source.kind === 'direct_manager' ? v3('depthOption', { number: source.depth }) : v3('selectedEmployees')).join(', ');
  const skipped = route.skippedLevels ?? [];
  const skippedItem = (entry: AttendanceSkippedLevel) => <li key={`skipped-${entry.configuredLevel}`} className="space-y-1 py-2" data-approval-level={entry.configuredLevel} data-approval-status="skipped">
    <p className="font-medium">{t('levelNumber', { level: entry.configuredLevel })} · {t('skippedNotRequired')}</p>
    <p className="text-xs text-muted-foreground">{t('skippedNoSuperior', { sources: sourceNames(entry.sources) })}</p>
  </li>;
  const levels = attendanceRouteLevelStatuses(route.stages);
  return <ol className="w-full divide-y divide-border text-sm" data-approval-route="available">
    {skipped.filter(entry => entry.levelSkipped && entry.configuredLevel < attendanceStageLevelNumber(route.stages[0], 0)).map(skippedItem)}
    {route.stages.map((stage, index) => {
      const state = levels[index], levelNumber = state.level;
      const nextNumber = index + 1 < route.stages.length ? attendanceStageLevelNumber(route.stages[index + 1], index + 1) : Infinity;
      const after = skipped.filter(entry => entry.levelSkipped && entry.configuredLevel > levelNumber && entry.configuredLevel < nextNumber);
      const partial = skipped.filter(entry => !entry.levelSkipped && entry.configuredLevel === levelNumber);
      const approvers = [...stage.approvers.map(person), ...(stage.hrAlternative && !stage.approvers.some(a => a.kind === 'hr_admin') ? [t('hrApprover')] : [])];
      return [<li key={index} className="space-y-1 py-2" data-approval-level={levelNumber} data-approval-status={state.status}>
        <p className="font-medium">{t('levelNumber', { level: levelNumber })} · {attendanceLevelStatusLabel(t, state.status)}</p>
        {state.participants.length > 1
          ? <ul className="space-y-0.5">{state.participants.map(p => <li key={p.slot} data-approval-participant={p.slot} data-approval-status={p.status}>{person(p.approver)} · {attendanceLevelStatusLabel(t, p.status)}</li>)}</ul>
          : <p>{approvers.join(' / ')}</p>}
        {(stage.approvers.length > 1 || stage.hrAlternative) && <p className="text-xs text-muted-foreground">{t(stage.mode === 'sequential' ? 'modeSequential' : stage.mode === 'all_required' ? 'modeAllRequired' : 'modeAnyOne')}</p>}
        {partial.map(entry => <p key={`partial-${entry.configuredLevel}`} className="text-xs text-muted-foreground">{t('skippedNoSuperior', { sources: sourceNames(entry.sources) })}</p>)}
      </li>, ...after.map(skippedItem)];
    })}
  </ol>;
}
