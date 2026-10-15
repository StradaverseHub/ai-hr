import {describe, expect, it} from 'vitest';
import {recordedOvertimeWork, type RecordedOvertimeWork} from '../lib/overtime-recorded-work';

const day: RecordedOvertimeWork = {
  attendanceId: 'attendance-proof', attendanceDate: '2026-01-30', workedMinutes: 120, dayType: 'workday',
  intervals: [{id: 'recorded-session', startEpochSeconds: '1769785200', localDate: '2026-01-30', localStartSecond: 23 * 3600, elapsedSeconds: 7200}],
};
describe('recorded work inputs preserve the boundary between quantity and clock evidence', () => {
  it('partitions a proven overnight interval without changing source/session or guessing a new day type', () => {
    const result = recordedOvertimeWork(day);
    expect(result.placement).toBe('recordedIntervals');
    expect(result.segments).toHaveLength(2);
    const [before, after] = result.segments;
    expect(before.rawMinutes).toMatchObject({state: 'known', value: '60'});
    expect(after.rawMinutes).toMatchObject({state: 'known', value: '60'});
    expect(before.clock).toMatchObject({state: 'known', value: {localDate: '2026-01-30', localStartSecond: 82800, elapsedSeconds: 3600}});
    expect(after.clock).toMatchObject({state: 'known', value: {startEpochSeconds: String(BigInt(day.intervals![0].startEpochSeconds) + 3600n), localDate: '2026-01-31', localStartSecond: 0, elapsedSeconds: 3600}});
    expect(before.sessionId).toBe(after.sessionId);
    expect(before.id).not.toBe(after.id);
    for (const segment of result.segments) expect(segment.dayType).toMatchObject({state: 'known', value: 'workday', provenance: {owner: 'attendance', asOf: day.attendanceDate, basis: 'recorded'}});
  });
  it('does not locate a flexible/scalar break by trimming the start or end of a span', () => {
    const result = recordedOvertimeWork({...day, workedMinutes: 90});
    expect(result.rawMinutes).toMatchObject({state: 'known', value: '90'});
    expect(result.placement).toBe('unavailable');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].clock).toEqual({state: 'unknown', reason: 'netDurationHasNoExactClockPlacement'});
  });
  it('retains known zero separately from an open/missing or invalid duration', () => {
    expect(recordedOvertimeWork({...day, workedMinutes: 0, intervals: null}).rawMinutes).toMatchObject({state: 'known', value: '0'});
    expect(recordedOvertimeWork({...day, workedMinutes: null}).rawMinutes).toEqual({state: 'unknown', reason: 'workNotFinal'});
    for (const workedMinutes of [-1, NaN, Infinity, 0.5, 4321]) expect(recordedOvertimeWork({...day, workedMinutes}).rawMinutes.state).toBe('unknown');
  });
  it('refuses clock certainty for duplicate, overlapping, reordered or malformed evidence', () => {
    const first = {...day.intervals![0], elapsedSeconds: 3600};
    const second = {...first, id: 'second'};
    const later = {...second, startEpochSeconds: String(BigInt(first.startEpochSeconds) + 3600n)};
    for (const intervals of [[first, second], [later, first], [first, {...later, id: first.id}], [{...first, localDate: '2026-02-30'}], [{...first, startEpochSeconds: 'bad'}], [{...first, elapsedSeconds: 3601}]]) {
      const result = recordedOvertimeWork({...day, intervals});
      expect(result.placement).toBe('unavailable');
      expect(result.segments[0].clock.state).toBe('unknown');
    }
  });
  it('preserves distinct disjoint sessions instead of charging an absent gap as work', () => {
    const first = {...day.intervals![0], localStartSecond: 36000, elapsedSeconds: 3600};
    const second = {...first, id: 'second', startEpochSeconds: String(BigInt(first.startEpochSeconds) + 7200n), localStartSecond: 43200};
    const result = recordedOvertimeWork({...day, intervals: [first, second]});
    expect(result.placement).toBe('recordedIntervals');
    expect(result.segments.map(segment => segment.sessionId)).toEqual(['recorded-session', 'second']);
    expect(result.segments.map(segment => segment.rawMinutes.state === 'known' ? segment.rawMinutes.value : null)).toEqual(['60', '60']);
  });
  it('does not turn an unavailable recorded classification into workday', () => {
    for (const dayType of [null, 'unsupported']) expect(recordedOvertimeWork({...day, dayType}).segments[0].dayType.state).toBe('unknown');
  });
  it('bounds evidence and rejects invalid attendance identities', () => {
    expect(() => recordedOvertimeWork({...day, attendanceDate: '2026-02-30'})).toThrow();
    expect(() => recordedOvertimeWork({...day, attendanceId: ''})).toThrow();
    expect(recordedOvertimeWork({...day, intervals: Array.from({length: 65}, (_, i) => ({...day.intervals![0], id: 's' + i}))}).placement).toBe('unavailable');
  });
});
