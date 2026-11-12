// Board 4452ba3c: pure assignment-group, level-number and preview-wording rules (no database).
import {describe,expect,it} from 'vitest';
import {attendanceCriteriaGroups,attendanceCriteriaFromGroups,attendanceScopesOverlap,attendanceStageLevelNumber,validateAttendanceCriteria,validateAttendanceWorkflow,ATTENDANCE_CRITERIA_GROUP_LIMIT} from '../lib/attendance-workflow';
import {attendancePreviewWarningKey,ATTENDANCE_PREVIEW_WARNING_KEYS,ATTENDANCE_SUPERIOR_PROBLEMS} from '../lib/attendance-workflow-preview';
import {nextAttendanceSuperiorDepth,type AttendanceV4Level} from '../lib/attendance-workflow-v4';
import en from '../messages/en.json';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const materials=uuid(1),group=uuid(2),design=uuid(3),finance=uuid(4);
describe('Workflow Assignment groups',()=>{
 it('reads a legacy flat assignment as exactly one group and stores one group in the legacy shape',()=>{
  expect(attendanceCriteriaGroups({departmentIds:[design]})).toEqual([{departmentIds:[design]}]);
  expect(attendanceCriteriaGroups({})).toEqual([{}]);
  expect(validateAttendanceCriteria({groups:[{departmentIds:[design,design]}]})).toEqual({departmentIds:[design]});
  expect(attendanceCriteriaFromGroups([{departmentIds:[design]},{businessUnitIds:[group]}])).toEqual({groups:[{departmentIds:[design]},{businessUnitIds:[group]}]});
 });
 it('validates every group with the per-field rules and allows one to ten groups only',()=>{
  const reporter={groups:[{businessUnitIds:[materials],departmentIds:[design]},{businessUnitIds:[group],departmentIds:[design]}]};
  expect(validateAttendanceCriteria(reporter)).toEqual(reporter);
  for(const bad of [{groups:[]},{groups:Array.from({length:ATTENDANCE_CRITERIA_GROUP_LIMIT+1},()=>({}))},{groups:[{departmentIds:['Design']}]},{groups:[{invented:[design]}]},{groups:[{}],departmentIds:[design]},{groups:'all'},{groups:[[design]]}])
   expect(()=>validateAttendanceCriteria(bad)).toThrow();
  expect(()=>validateAttendanceCriteria({groups:Array.from({length:ATTENDANCE_CRITERIA_GROUP_LIMIT},()=>({employmentTypes:['full_time']}))})).not.toThrow();
  const workflow={companyId:uuid(9),applicationType:'irregularity' as const,code:'GROUPS',name:'Groups',priority:1,active:true,criteria:reporter,stages:[{name:'Level 1',level:{kind:'direct_manager' as const,employmentId:null,alternates:[]}}]};
  expect(validateAttendanceWorkflow(workflow).criteria).toEqual(reporter);
 });
 it('treats two assignments as overlapping when any pair of groups can match the same employee',()=>{
  const reporter={groups:[{businessUnitIds:[materials],departmentIds:[design]},{businessUnitIds:[group],departmentIds:[design]}]};
  expect(attendanceScopesOverlap(reporter,{businessUnitIds:[group]})).toBe(true);
  expect(attendanceScopesOverlap(reporter,{departmentIds:[finance]})).toBe(false);
  expect(attendanceScopesOverlap(reporter,{groups:[{departmentIds:[finance]},{businessUnitIds:[materials],departmentIds:[design]}]})).toBe(true);
  expect(attendanceScopesOverlap({departmentIds:[design]},{departmentIds:[finance]})).toBe(false);
 });
});
describe('configured level numbers and default depth',()=>{
 it('keeps the configured Level N after skipped levels and falls back to the position',()=>{
  expect(attendanceStageLevelNumber({name:'Level 3'},1)).toBe(3);
  expect(attendanceStageLevelNumber({name:'Manager review'},1)).toBe(2);
  expect(attendanceStageLevelNumber(undefined,0)).toBe(1);
 });
 it('starts a new Direct Superior level one step above the deepest earlier level, capped at five',()=>{
  expect(nextAttendanceSuperiorDepth([])).toBe(1);
  const first:AttendanceV4Level={name:'Level 1',mode:'any_one',sources:[{kind:'direct_manager',depth:1}],hrAlternative:false};
  expect(nextAttendanceSuperiorDepth([first])).toBe(2);
  expect(nextAttendanceSuperiorDepth([first,{...first,sources:[{kind:'direct_manager',depth:2},{kind:'specific_employee',employmentIds:[uuid(6)]}]}])).toBe(3);
  expect(nextAttendanceSuperiorDepth([{...first,sources:[{kind:'specific_employee',employmentIds:[uuid(5)]}]}])).toBe(1);
  expect(nextAttendanceSuperiorDepth([{...first,sources:[{kind:'direct_manager',depth:5}]}])).toBe(5);
 });
});
describe('stored preview warnings use distinct wording',()=>{
 it('maps each Direct Superior diagnosis to its own message and keeps every key translated',()=>{
  const keys=ATTENDANCE_SUPERIOR_PROBLEMS.map(superiorProblem=>attendancePreviewWarningKey({superiorProblem,problem:{code:'missing_or_ambiguous_login',levelIndex:0},source:{kind:'direct_manager',depth:1},conflict:null}));
  expect(new Set(keys).size).toBe(ATTENDANCE_SUPERIOR_PROBLEMS.length);
  const messages=(en.attendanceWorkflow.previewHistory.problems as Record<string,string>);
  for(const key of ATTENDANCE_PREVIEW_WARNING_KEYS)expect(messages[key],key).toEqual(expect.any(String));
  expect(new Set(ATTENDANCE_SUPERIOR_PROBLEMS.map(key=>messages[key])).size).toBe(ATTENDANCE_SUPERIOR_PROBLEMS.length);
  // The reporter's collapsed sentence is no longer used for a Direct Superior that is merely missing a login.
  expect(messages.no_login).not.toBe(en.attendanceWorkflow.v3.identityUnavailable);
  expect(messages.superior_inactive).toMatch(/inactive/i);expect(messages.no_login).not.toMatch(/inactive/i);
  expect(attendancePreviewWarningKey({superiorProblem:null,problem:{code:'employee_unavailable',levelIndex:1,participantIndex:0},source:{kind:'specific_employee'},conflict:null})).toBe('selected_unavailable');
  expect(attendancePreviewWarningKey({superiorProblem:null,problem:null,source:null,conflict:'tie'})).toBe('tie');
  expect(attendancePreviewWarningKey({superiorProblem:null,problem:null,source:{kind:'cc'},conflict:null})).toBe('cc_unavailable');
 });
});
