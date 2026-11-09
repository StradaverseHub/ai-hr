/** Shared capture projection for live writes and the independent downstream replays. */
import type { AttendancePolicyExecutionContext } from '../../core/attendance';
import type { TraceClockPolicy } from '../../core/attendance-trace';
import {
  attendanceClockPolicyEvidence, attendancePolicyClockMillisecondEvidence,
  type PolicyClockMillisecondEvidence, type PolicyClockMillisecond,
} from '../../lib/attendance-policy-clocks';

type Context = Extract<AttendancePolicyExecutionContext,{state:'policy'}>;

export function policyClockEvidence(context:Context,clocks:readonly PolicyClockMillisecond[],periodMinutes=4320):PolicyClockMillisecondEvidence {
  return context.clockRevision
    ? attendanceClockPolicyEvidence(clocks,context.resolvedClock,periodMinutes)
    : attendancePolicyClockMillisecondEvidence(clocks,context.resolvedClock,periodMinutes);
}

export function clockPolicyTrace(context:Context,evidence:PolicyClockMillisecondEvidence):TraceClockPolicy|undefined {
  const revision=context.clockRevision;
  if(!revision || !evidence.exclusions)return undefined;
  return {...revision,requiresReview:evidence.requiresReview,exclusions:evidence.exclusions};
}
