import { attendanceStageLevelNumber, type AttendanceResolvedApprover, type AttendanceResolvedStage } from './attendance-workflow';

/** Presentation over frozen request/decision evidence. Never consults a current workflow template. */
export type AttendanceProgressWorkflow = {
  routingVersion: number; currentStage: number; stages: AttendanceResolvedStage[];
  effectiveStages?: AttendanceResolvedStage[];
  decisions: { stageIndex: number; decision: string; actualPersonId?: string | null }[];
  participantDecisions?: { stageIndex: number; participantSlot: string; decision: string; actualPersonId?: string | null }[];
};
export type AttendanceNextApprover = { name: string; employeeCode: string | null; kind: AttendanceResolvedApprover['kind']; slot?: string; eligible: boolean; actingMode?: 'assigned' | 'administrator' };
export type AttendanceProgress = { state: 'final' | 'legacy' | 'pending' | 'unresolved'; level: number | null; mode: 'any_one' | 'all_required' | 'sequential'; next: AttendanceNextApprover[] };
export function recordedAttendanceProgress(flow: AttendanceProgressWorkflow | null, status: string,
  identities: ReadonlyMap<string, { employeeCode: string | null; eligible: boolean }> = new Map()): AttendanceProgress {
  const base: AttendanceProgress = { state: 'unresolved', level: null, mode: 'any_one', next: [] };
  if (status !== 'pending') return { ...base, state: 'final' };
  if (!flow) return { ...base, state: 'legacy' };
  const stage = flow.effectiveStages?.[flow.currentStage] ?? flow.stages[flow.currentStage];
  if (!stage || flow.decisions.some(d => d.stageIndex === flow.currentStage)) return base;
  const mode = stage.mode === 'sequential' ? 'sequential' : flow.routingVersion===4&&stage.mode==='all_required'?'all_required':'any_one';
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
  // The configured level number survives levels skipped at submission.
  return { state: next.some(a => a.eligible) ? 'pending' : 'unresolved', level: attendanceStageLevelNumber(flow.stages[flow.currentStage], flow.currentStage), mode, next };
}
export function attendanceNextApproverLabel(actor: AttendanceNextApprover, labels: { hr: string; onBehalf: string }): string {
  const name = actor.kind === 'hr_admin' ? labels.hr : actor.name;
  return `${actor.actingMode === 'administrator' ? labels.onBehalf + ' · ' : ''}${name}${actor.employeeCode ? ' · ' + actor.employeeCode : ''}`;
}

/**
 * Board 237c31e6 — one status per frozen level and per participant, for the approval progress panel. Derived only
 * from the frozen request (currentStage, decisions, participantDecisions, escalations, skippedLevels); it decides
 * nothing and never consults a current workflow template. A level the request never reached reads not_required
 * once the request is final (approved, rejected, withdrawn or cancelled).
 */
export type AttendanceLevelStatus = 'pending_approval' | 'waiting_previous' | 'approved' | 'rejected' | 'escalated' | 'not_required' | 'skipped';
export type AttendanceLevelStatusWorkflow = {
  routingVersion: number; currentStage: number; stages: AttendanceResolvedStage[]; effectiveStages?: AttendanceResolvedStage[];
  decisions: { stageIndex: number; decision: string }[];
  participantDecisions?: { stageIndex: number; participantSlot: string; decision: string }[];
  escalations?: { stageIndex: number }[];
};
export type AttendanceParticipantState = { slot: string; approver: AttendanceResolvedApprover; status: AttendanceLevelStatus };
export type AttendanceLevelState = { index: number; level: number; status: AttendanceLevelStatus; participants: AttendanceParticipantState[] };

const decidedStatus = (decision: string): AttendanceLevelStatus => decision === 'rejected' ? 'rejected' : 'approved';

export function attendanceLevelStatuses(flow: AttendanceLevelStatusWorkflow, status: string): AttendanceLevelState[] {
  const pending = status === 'pending';
  return flow.stages.map((original, index) => {
    const stage = flow.effectiveStages?.[index] ?? original;
    const decision = flow.decisions.find(d => d.stageIndex === index);
    const escalated = flow.escalations?.some(e => e.stageIndex === index) ?? false;
    const levelStatus: AttendanceLevelStatus = decision ? decidedStatus(decision.decision)
      : escalated ? 'escalated'
      : pending && index === flow.currentStage ? 'pending_approval'
      : pending && index > flow.currentStage ? 'waiting_previous'
      : 'not_required';
    // Per-person lines exist only where each participant decides separately (routing versions 3 and 4).
    const participants: AttendanceParticipantState[] = [];
    if (flow.routingVersion === 3 || flow.routingVersion === 4) {
      const slots = stage.approvers.map((approver, i) => ({ slot: approver.slot ?? `${index}:${i}`, approver }));
      if (stage.hrAlternative && !stage.approvers.some(a => a.kind === 'hr_admin'))
        slots.push({ slot: `${index}:hr`, approver: { kind: 'hr_admin', employmentId: null, name: '', slot: `${index}:hr` } });
      const recorded = flow.participantDecisions?.filter(d => d.stageIndex === index) ?? [];
      let sequentialTurnTaken = false;
      for (const { slot, approver } of slots) {
        const own = recorded.find(d => d.participantSlot === slot);
        let participant: AttendanceLevelStatus;
        if (own) participant = decidedStatus(own.decision);
        else if (levelStatus === 'pending_approval') {
          if (stage.mode === 'sequential' && approver.kind !== 'hr_admin') { participant = sequentialTurnTaken ? 'waiting_previous' : 'pending_approval'; sequentialTurnTaken = true; }
          else participant = 'pending_approval';
        } else if (levelStatus === 'waiting_previous') participant = 'waiting_previous';
        else if (levelStatus === 'escalated') participant = 'escalated';
        else participant = 'not_required';
        participants.push({ slot, approver, status: participant });
      }
    }
    return { index, level: attendanceStageLevelNumber(original, index), status: levelStatus, participants };
  });
}

/** The same mapping for a route shown before Submit: the first level is pending, every later level waits. */
export function attendanceRouteLevelStatuses(stages: AttendanceResolvedStage[]): AttendanceLevelState[] {
  const participantRouting = stages.some(stage => stage.approvers.some(approver => approver.slot));
  return attendanceLevelStatuses({ routingVersion: participantRouting ? 4 : 1, currentStage: 0, stages, decisions: [] }, 'pending');
}

/**
 * The one-line headline: the level just completed and the level now waiting, or the final outcome. Level numbers are
 * the configured "Level N" (a level skipped at submission keeps its number).
 */
export type AttendanceProgressHeadline =
  | { kind: 'final'; status: string }
  | { kind: 'completed'; completed: number; waiting: number }
  | { kind: 'waiting'; waiting: number };
export function attendanceProgressMessage(flow: AttendanceLevelStatusWorkflow, status: string): AttendanceProgressHeadline | null {
  if (status !== 'pending') return { kind: 'final', status };
  const current = flow.stages[flow.currentStage];
  if (!current) return null;
  const waiting = attendanceStageLevelNumber(current, flow.currentStage);
  const previous = flow.currentStage - 1;
  const approvedBefore = previous >= 0 && flow.decisions.some(d => d.stageIndex === previous && d.decision === 'approved');
  return approvedBefore ? { kind: 'completed', completed: attendanceStageLevelNumber(flow.stages[previous], previous), waiting } : { kind: 'waiting', waiting };
}
