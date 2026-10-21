import { isAttendanceTrace } from '../core/attendance-trace';

/** A whitelist of recorded attendance facts; neither unknowns nor an absent row become zero. */
export function attendanceReviewEvidence(raw: unknown) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' ? v : null;
  const minutes = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const trace = isAttendanceTrace(value.calcTrace) ? value.calcTrace : null;
  return { checkIn: text(value.checkInAt), checkOut: text(value.checkOutAt), status: text(value.status),
    worked: minutes(value.workedMinutes), shortfall: minutes(value.underMinutes),
    required: trace?.schedule.dayType === 'workday' ? minutes(trace.schedule.normalMinutesOverride ?? trace.schedule.scheduledMinutes) : null,
    start: minutes(trace?.schedule.startAbs), end: minutes(trace?.schedule.endAbs) };
}
export function originalAttendanceReview(events: readonly { eventType: string; payload: unknown }[], snapshot?: {
  attendanceId: string | null; originalCheckIn: string | null; originalCheckOut: string | null;
} | null) {
  const recorded = events.find(event => ['attendance-correction.effect.recorded', 'attendance.amended'].includes(event.eventType)
    && event.payload !== null && typeof event.payload === 'object' && Object.hasOwn(event.payload, 'before'));
  if (recorded) return attendanceReviewEvidence((recorded.payload as { before: unknown }).before);
  if (!snapshot) return undefined;
  return snapshot.attendanceId === null ? null : attendanceReviewEvidence({ checkInAt: snapshot.originalCheckIn, checkOutAt: snapshot.originalCheckOut });
}
