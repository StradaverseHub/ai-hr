import {describe,expect,it} from 'vitest';
import {breakMinutesOf} from '../core/attendance-derive';

describe('shared attendance day break',()=>{
  it('takes scheduled net work from a normal shift span',()=>{
    expect(breakMinutesOf({shiftStart:'09:00',shiftEnd:'18:00',scheduledMinutes:480})).toBe(60);
  });
  it('keeps the scheduled break on an overnight shift',()=>{
    expect(breakMinutesOf({shiftStart:'22:00',shiftEnd:'06:00',scheduledMinutes:420})).toBe(60);
  });
  it('does not invent a break when a schedule fact is missing',()=>{
    expect(breakMinutesOf({shiftStart:null,shiftEnd:'18:00',scheduledMinutes:480})).toBeNull();
    expect(breakMinutesOf({shiftStart:'09:00',shiftEnd:null,scheduledMinutes:480})).toBeNull();
    expect(breakMinutesOf({shiftStart:'09:00',shiftEnd:'18:00',scheduledMinutes:null})).toBeNull();
  });
});
