import {describe,expect,it} from 'vitest';
import {workingShiftSchedule} from '../packs/attendance/service';
describe('canonical scheduled full/half clock and normal hours',()=>{
 it('full day is exact existing schedule including manual override',()=>{
  expect(workingShiftSchedule({start:'09:00',end:'18:00',crosses:false,breakMinutes:60},'full')).toEqual({
   scheduledMinutes:480,normalMinutes:480,shiftStart:'09:00',shiftEnd:'18:00',crosses:false,normalMinutesOverride:null});
  expect(workingShiftSchedule({start:'09:00',end:'18:00',crosses:false,breakMinutes:60,normalMinutesOverride:450},'full'))
   .toMatchObject({scheduledMinutes:480,normalMinutes:450,shiftEnd:'18:00',normalMinutesOverride:450});
 });
 it('half normal hours and effective end follow the same default-shift owner',()=>{
  expect(workingShiftSchedule({start:'09:00',end:'18:00',crosses:false,breakMinutes:60},'half')).toEqual({
   scheduledMinutes:240,normalMinutes:240,shiftStart:'09:00',shiftEnd:'13:30:00',crosses:false,normalMinutesOverride:null});
  expect(workingShiftSchedule({start:'09:00',end:'18:00',crosses:false,breakMinutes:60,normalMinutesOverride:451},'half'))
   .toMatchObject({scheduledMinutes:240,normalMinutes:225,shiftEnd:'13:30:00',normalMinutesOverride:225});
 });
 it('preserves overnight and rounding owner semantics instead of inventing another schedule',()=>{
  expect(workingShiftSchedule({start:'22:00',end:'06:00',crosses:true,breakMinutes:45,roundingMinutes:30},'full'))
   .toMatchObject({scheduledMinutes:420,normalMinutes:420,shiftEnd:'06:00',crosses:true});
  expect(workingShiftSchedule({start:'22:00',end:'06:00',crosses:true,breakMinutes:45,roundingMinutes:30},'half'))
   .toMatchObject({scheduledMinutes:210,normalMinutes:210,shiftEnd:'02:00:00',crosses:false});
 });
});
