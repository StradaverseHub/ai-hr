import {overtimeInteger,overtimeKeys,overtimeObject} from './overtime-pattern-schema';

export const ATTENDANCE_CLOCK_DAY_TYPES = ['normal','rest','off','publicHoliday'] as const;
export type AttendanceClockDayType = typeof ATTENDANCE_CLOCK_DAY_TYPES[number];
export type AttendanceClockPairing = 'auto'|'firstInLastOut';
export type AttendanceClockPolicy = {
  pairing:Record<AttendanceClockDayType,AttendanceClockPairing>;
  minimumIntervalMinutes:number;
};

export const MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES = 4320;

export function validateAttendanceClockPolicy(input:unknown):AttendanceClockPolicy {
  const value=overtimeObject(input,'clockPolicy');
  overtimeKeys(value,['pairing','minimumIntervalMinutes'],'clockPolicy');
  const pairing=overtimeObject(value.pairing,'clockPolicy.pairing');
  overtimeKeys(pairing,[...ATTENDANCE_CLOCK_DAY_TYPES],'clockPolicy.pairing');
  const method=(day:AttendanceClockDayType):AttendanceClockPairing=>{
    const selected=pairing[day];
    if(selected!=='auto'&&selected!=='firstInLastOut')throw new Error('Choose a pairing method for each day type.');
    return selected;
  };
  return {
    pairing:{normal:method('normal'),rest:method('rest'),off:method('off'),publicHoliday:method('publicHoliday')},
    minimumIntervalMinutes:overtimeInteger(value.minimumIntervalMinutes,0,MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES,'clockPolicy.minimumIntervalMinutes'),
  };
}
