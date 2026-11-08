import {describe,it,expect} from 'vitest';
import {attendanceFormulaOvertimeMeasurements as measure} from '../lib/attendance-formula-overtime';
describe('answered before/after overtime distinctions',()=>{
 it('keeps approved, cross-day approved and unapproved coverage distinct, using exact intersection',()=>{
  const p={net:[{from:420,to:1080}],eligible:[{from:420,to:1080}],approved:[{from:450,to:510},{from:1035,to:1065}],start:540,end:1020,crossesMidnight:false};
  expect(measure(p)).toMatchObject({ZoneAWorkingMins:120,ZoneBWorkingMins:60,ApproveZoneAOT:60,ApproveZoneAPreOT:0,ApproveZoneBOT:30,ApproveZoneBPreOT:0,ZoneAPreOT:60,ZoneAPostOT:30,ZoneBPostOT:30,ZoneBPreOT:0});
 });
 it('exposes cross-day subsets only for an explicitly cross-day shift',()=>{
  expect(measure({net:[{from:1200,to:1920}],eligible:[{from:1200,to:1920}],approved:[{from:1200,to:1260},{from:1830,to:1890}],start:1320,end:1800,crossesMidnight:true})).toMatchObject({ApproveZoneAOT:60,ApproveZoneAPreOT:60,ApproveZoneBOT:60,ApproveZoneBPreOT:60,ZoneAPreOT:60,ZoneAPostOT:60,ZoneBPreOT:60});
 });
 it('leaves approval-dependent variables absent when approval placement is unknown',()=>{
  const result=measure({net:[{from:480,to:1080}],eligible:null,approved:null,start:540,end:1020,crossesMidnight:false});expect(result).toEqual({ZoneAWorkingMins:60,ZoneBWorkingMins:60});expect(result).not.toHaveProperty('ApproveZoneAOT');
 });
 it('never sums duplicate approved windows twice or invents a disjoint approval overlap',()=>{
  expect(measure({net:[{from:480,to:540}],eligible:[{from:480,to:540}],approved:[{from:480,to:510},{from:480,to:510},{from:600,to:660}],start:540,end:1020,crossesMidnight:false})).toMatchObject({ApproveZoneAOT:30,ZoneAPreOT:30});
 });
});

it('does not turn early clocked work into eligible overtime when the native policy enables only after-shift OT',()=>{expect(measure({net:[{from:420,to:1080}],approved:[{from:420,to:1080}],eligible:[{from:1020,to:1080}],start:540,end:1020,crossesMidnight:false})).toMatchObject({ZoneAWorkingMins:120,ApproveZoneAOT:0,ZoneAPreOT:0,ApproveZoneBOT:60,OTAssignmentInShift:0});});
