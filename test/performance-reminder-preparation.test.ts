import {describe,expect,it} from 'vitest';
import {assessmentReminderPreparationStart,assessmentReminderPreparationRoute,assessmentReminderPreparationCurrent,assessmentReminderPreparationSkip,assessmentReminderPreparationValue} from '../packs/performance/onehr/reminder-preparation';
import type {AssessmentReminderTask} from '../lib/assessment-reminder-mail';
const employmentId='5b9c9f7f-bd09-4d8d-a34d-201b1abf79e2',cycleId='8bf4da30-48a9-4a4c-bf18-37649a9863f3',tenantScope='00000000-0000-0000-0000-000000000000';
const tasks:AssessmentReminderTask[]=[{key:'team_results',count:2,closesAt:'2026-11-09T00:00:00+08:00',people:['Fictional colleague']}];
const actor={employmentIds:[employmentId],tasks},epochs=[{scopeId:tenantScope,revision:7},{scopeId:cycleId,revision:11}];
describe('canonical reminder preparation decisions',()=>{
 it('preserves refusal precedence before later delivery and epoch decisions',()=>{
  expect(assessmentReminderPreparationStart('automatic',false,employmentId,undefined)).toBe('changed');
  expect(assessmentReminderPreparationStart('manual',false,employmentId,undefined)).toBe('noPendingWork');
  expect(assessmentReminderPreparationStart('automatic',true,employmentId,{...actor,employmentIds:[]})).toBe('noPendingWork');
  expect(assessmentReminderPreparationStart('manual',false,employmentId,actor)).toBeNull();
  expect(assessmentReminderPreparationStart('automatic',true,employmentId,actor)).toBeNull();
  expect(assessmentReminderPreparationRoute(true,undefined,employmentId)).toBe('cooldown');
  expect(assessmentReminderPreparationRoute(false,'another route',employmentId)).toBe('noConsent');
  expect(assessmentReminderPreparationRoute(false,employmentId,employmentId)).toBeNull();
 });
 it('requires the complete second epoch set and a strictly future expiry',()=>{
  expect(assessmentReminderPreparationCurrent(epochs,[...epochs].reverse(),2000,1999)).toBe(true);
  expect(assessmentReminderPreparationCurrent(epochs,epochs,2000,2000)).toBe(false);
  expect(assessmentReminderPreparationCurrent(epochs,epochs.slice(0,1),2000,1999)).toBe(false);
  expect(assessmentReminderPreparationCurrent(epochs,[...epochs,{scopeId:'unexpected',revision:1}],2000,1999)).toBe(false);
  expect(assessmentReminderPreparationCurrent(epochs,[epochs[0],{...epochs[1],revision:12}],2000,1999)).toBe(false);
  expect(assessmentReminderPreparationCurrent(epochs,[epochs[0],{scopeId:'different',revision:11}],2000,1999)).toBe(false);
 });
 it.each(['changed','noPendingWork','noConsent','cooldown']as const)('clears every prepared field for %s without changing source identity',outcome=>{
  expect(assessmentReminderPreparationSkip(outcome)).toEqual({outcome,tasks:[],mailWords:null,preparedAt:null,preparedUntil:null});
 });
 it('retains exact task mail, wording, captured time and the smaller native expiry boundary',()=>{
  const now=new Date('2026-11-08T12:00:00.000Z'),expiresAt=now.getTime()+12345;
  const value=assessmentReminderPreparationValue({actor,name:'  fictional owner ',cycleName:'Fictional cycle',cycleId,tenantScope,epochs,expiresAt,now,words:{subject:'{first_name}: {count} {things}',opening:'Open {cycle}.'}});
  expect(value).toEqual({tasks,mailWords:{subject:'Fictional: 1 thing is',opening:'Open Fictional cycle.'},preparedAt:now,preparedUntil:new Date(expiresAt),tenantEpoch:7,cycleEpoch:11});
  expect(actor.tasks).toEqual(tasks);expect(epochs).toEqual([{scopeId:tenantScope,revision:7},{scopeId:cycleId,revision:11}]);
 });
 it('caps preparation at the existing sixty seconds and retains absent epoch/word defaults',()=>{
  const now=new Date('2026-11-08T12:00:00.000Z');
  expect(assessmentReminderPreparationValue({actor,name:'Fictional',cycleName:'Fictional cycle',cycleId,tenantScope,epochs:[],expiresAt:now.getTime()+120000,now,words:null})).toEqual({tasks,mailWords:null,preparedAt:now,preparedUntil:new Date(now.getTime()+60000),tenantEpoch:0,cycleEpoch:0});
 });
});
