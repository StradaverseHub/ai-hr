import type { AttendanceResolvedApprover, AttendanceResolvedStage } from './attendance-workflow';

/** Presentation over frozen request/decision evidence. Never consults a current workflow template. */
export type AttendanceProgressWorkflow = {
  routingVersion: number; currentStage: number; stages: AttendanceResolvedStage[];
  effectiveStages?: AttendanceResolvedStage[];
  decisions: { stageIndex: number; decision: string; actualPersonId?: string | null }[];
  participantDecisions?: { stageIndex: number; participantSlot: string; decision: string; actualPersonId?: string | null }[];
};
export type AttendanceNextApprover = { name: string; employeeCode: string | null; kind: AttendanceResolvedApprover['kind']; slot?: string; eligible: boolean; actingMode?: 'assigned' | 'administrator' };
export type AttendanceProgress = { state: 'final' | 'legacy' | 'pending' | 'unresolved'; level: number | null; mode: 'any_one' | 'sequential'; next: AttendanceNextApprover[] };
export function recordedAttendanceProgress(flow: AttendanceProgressWorkflow | null, status: string,
  identities: ReadonlyMap<string, { employeeCode: string | null; eligible: boolean }> = new Map()): AttendanceProgress {
  const base: AttendanceProgress = { state: 'unresolved', level: null, mode: 'any_one', next: [] };
  if (status !== 'pending') return { ...base, state: 'final' };
  if (!flow) return { ...base, state: 'legacy' };
  const stage = flow.effectiveStages?.[flow.currentStage] ?? flow.stages[flow.currentStage];
  if (!stage || flow.decisions.some(d => d.stageIndex === flow.currentStage)) return base;
  const mode = stage.mode === 'sequential' ? 'sequential' : 'any_one';
  const completed = flow.participantDecisions?.filter(d => d.stageIndex === flow.currentStage) ?? [];
  if (completed.some(d => d.decision === 'rejected' || d.participantSlot === `${flow.currentStage}:hr`) || mode === 'any_one' && completed.length) return base;
  let remaining = stage.approvers.filter(a => !completed.some(d => d.participantSlot === a.slot));
  if (mode === 'sequential') remaining = remaining.slice(0, 1);
  if (stage.hrAlternative && !remaining.some(a => a.kind === 'hr_admin')) remaining = [...remaining, { kind: 'hr_admin', employmentId: null, name: '', slot: `${flow.currentStage}:hr` }];
  const usedPeople = new Set(flow.routingVersion === 1 ? [] : [...(flow.participantDecisions ?? []), ...flow.decisions].map(d => d.actualPersonId).filter(Boolean));
  const next = remaining.map(a => {
    const identity = a.employmentId ? identities.get(a.employmentId) : identities.get('hr_admin');
    return { name: a.name, kind: a.kind, slot: a.slot, employeeCode: identity?.employeeCode ?? null,
      eligible: identity?.eligible === true && (!a.personId || !usedPeople.has(a.personId)) };
  });
  return { state: next.some(a => a.eligible) ? 'pending' : 'unresolved', level: flow.currentStage + 1, mode, next };
}
export function attendanceNextApproverLabel(actor: AttendanceNextApprover, labels: { hr: string; onBehalf: string }): string {
  const name = actor.kind === 'hr_admin' ? labels.hr : actor.name;
  return `${actor.actingMode === 'administrator' ? labels.onBehalf + ' · ' : ''}${name}${actor.employeeCode ? ' · ' + actor.employeeCode : ''}`;
}
