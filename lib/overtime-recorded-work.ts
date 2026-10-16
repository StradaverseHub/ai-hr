import type { OvertimeFact, OvertimeProvenance, OvertimeRawSegment } from './overtime-pattern-model';

/** Recorded work evidence is an input to configured eligibility, not another schedule/OT calculator. */
export type RecordedWorkInterval = {
  id: string;
  startEpochSeconds: string;
  localDate: string;
  localStartSecond: number;
  elapsedSeconds: number;
};
export type RecordedOvertimeWork = {
  attendanceId: string;
  attendanceDate: string;
  workedMinutes: number | null;
  dayType: string | null;
  /** Only canonical recorded intervals; a current shift lookup is not historical evidence. */
  intervals: readonly RecordedWorkInterval[] | null;
};
export type RecordedWorkSegment = Omit<OvertimeRawSegment, 'approvedMinutes'>;
export type RecordedWorkResult = {
  rawMinutes: OvertimeFact<string>;
  segments: RecordedWorkSegment[];
  placement: 'recordedIntervals' | 'unavailable';
};
const unknown = <T>(reason: string): OvertimeFact<T> => ({state: 'unknown', reason});
function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function nextDate(value: string): string {
  return new Date(new Date(value + 'T00:00:00.000Z').getTime() + 86_400_000).toISOString().slice(0, 10);
}
function provenance(input: RecordedOvertimeWork, reference: string): OvertimeProvenance {
  return {owner: 'attendance', reference: input.attendanceId + ':' + reference, asOf: input.attendanceDate, basis: 'recorded'};
}
function known<T>(value: T, source: OvertimeProvenance): OvertimeFact<T> {
  return {state: 'known', value, provenance: source};
}
/**
 * An exact net count does not tell us when an unlocated break occurred. Only expose clock placement
 * when disjoint recorded interval seconds equal the canonical worked count exactly. Otherwise retain
 * the measured count with Unknown clocks, so duration formulas work and time-band formulas refuse.
 *
 * The input owner supplies explicit epoch/date/offset evidence. This helper never reads a timezone,
 * shift, current profile or holiday calendar and never allocates an aggregate approval to clocks.
 */
export function recordedOvertimeWork(input: RecordedOvertimeWork): RecordedWorkResult {
  if (!input.attendanceId || !calendarDate(input.attendanceDate)) throw new Error('Invalid recorded Attendance identity.');
  const rawMinutes = input.workedMinutes == null
    ? unknown<string>('workNotFinal')
    : Number.isSafeInteger(input.workedMinutes) && input.workedMinutes >= 0 && input.workedMinutes <= 4_320
      ? known(String(input.workedMinutes), provenance(input, 'workedMinutes'))
      : unknown<string>('invalidRecordedDuration');
  const dayType = input.dayType != null && ['workday', 'rest_day', 'holiday'].includes(input.dayType)
    ? known(input.dayType, provenance(input, 'dayType'))
    : unknown<string>('recordedDayTypeUnavailable');
  const aggregate = (reason: string): RecordedWorkResult => ({rawMinutes, placement: 'unavailable', segments: [{
    id: input.attendanceId + ':work', sessionId: input.attendanceId + ':day', dayType,
    rawMinutes, clock: unknown(reason),
  }]});
  if (rawMinutes.state === 'unknown') return aggregate(rawMinutes.reason);
  if (!input.intervals?.length) return aggregate('recordedClockPlacementUnavailable');
  if (input.intervals.length > 64) return aggregate('recordedIntervalLimit');
  const ids = new Set<string>();
  let previousEnd: bigint | null = null;
  let sumSeconds = 0;
  const intervals: {row: RecordedWorkInterval; epoch: bigint}[] = [];
  // Order is evidence supplied by the canonical owner. Do not silently sort invalid/overlapping input.
  for (const row of input.intervals) {
    if (!row.id || row.id.length > 160 || ids.has(row.id) || !/^\d{1,16}$/.test(row.startEpochSeconds)
      || !calendarDate(row.localDate) || !Number.isSafeInteger(row.localStartSecond)
      || row.localStartSecond < 0 || row.localStartSecond >= 86_400
      || !Number.isSafeInteger(row.elapsedSeconds) || row.elapsedSeconds <= 0 || row.elapsedSeconds > 259_200
      || row.elapsedSeconds % 60 !== 0 || row.localStartSecond % 60 !== 0) return aggregate('invalidRecordedIntervals');
    const epoch = BigInt(row.startEpochSeconds);
    if (previousEnd != null && epoch < previousEnd) return aggregate('overlappingOrUnorderedIntervals');
    previousEnd = epoch + BigInt(row.elapsedSeconds);
    sumSeconds += row.elapsedSeconds;
    ids.add(row.id);
    intervals.push({row, epoch});
  }
  if (sumSeconds !== Number(rawMinutes.value) * 60) return aggregate('netDurationHasNoExactClockPlacement');
  const segments: RecordedWorkSegment[] = [];
  for (const {row, epoch} of intervals) {
    let date = row.localDate, start = row.localStartSecond, remaining = row.elapsedSeconds, consumed = 0, part = 0;
    while (remaining > 0) {
      const elapsed = Math.min(remaining, 86_400 - start);
      segments.push({
        id: input.attendanceId + ':' + row.id + ':' + part,
        sessionId: row.id, dayType,
        rawMinutes: known(String(elapsed / 60), provenance(input, 'interval:' + row.id)),
        clock: known({startEpochSeconds: String(epoch + BigInt(consumed)), localDate: date, localStartSecond: start, elapsedSeconds: elapsed}, provenance(input, 'interval:' + row.id)),
      });
      if (segments.length > 256) return aggregate('recordedSegmentLimit');
      remaining -= elapsed;
      consumed += elapsed;
      start = 0;
      date = nextDate(date);
      part += 1;
    }
  }
  return {rawMinutes, segments, placement: 'recordedIntervals'};
}
