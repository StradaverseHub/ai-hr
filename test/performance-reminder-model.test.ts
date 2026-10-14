import { describe,expect,it } from 'vitest';
import { assessmentReminderRulesSchema,defaultAssessmentReminderRules,assessmentReminderReasons,assessmentReminderDue,nextAssessmentReminder,assessmentReminderMailSchema } from '../packs/performance/onehr/reminder-model';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import golden from './fixtures/onehr/reminder-golden.json';
describe('all-in-one assessment reminder scheduling',()=>{
 it('matches every isolated source scheduling case, including overlapping rules and disabled modules',()=>{
  for(const c of golden.cases){const policy=defaultPolicy(framework);policy.windows=c.windows;policy.modules={...policy.modules,...c.modules};expect(assessmentReminderReasons(policy,c.cycleEnd,c.day,assessmentReminderRulesSchema.parse(c.rules)),c.name).toEqual(c.expected);}
 });
 it('starts off, preserves the original frequencies, and validates administrative settings',()=>{
  expect(defaultAssessmentReminderRules).toEqual({enabled:false,onOpen:true,daysBefore:[7,3,1],everyDays:0,sendTime:'09:00'});
  expect(assessmentReminderRulesSchema.parse({daysBefore:[1,7,1,0]}).daysBefore).toEqual([7,1,0]);
  expect(assessmentReminderRulesSchema.safeParse({everyDays:31}).success).toBe(false);expect(assessmentReminderRulesSchema.safeParse({sendTime:'24:00'}).success).toBe(false);
 });
 it('uses the Malaysia send time and calendar consistently and finds the next send-day',()=>{
  const policy=defaultPolicy(framework),rules=assessmentReminderRulesSchema.parse({enabled:true,daysBefore:[3]});
  expect(assessmentReminderDue(policy,'2026-10-17',rules,new Date('2026-10-14T00:59:00Z'))).toMatchObject({day:'2026-10-14',due:false});
  expect(assessmentReminderDue(policy,'2026-10-17',rules,new Date('2026-10-14T01:00:00Z'))).toMatchObject({day:'2026-10-14',due:true});
  expect(nextAssessmentReminder(policy,'2026-10-17',rules,new Date('2026-10-12T18:00:00Z'))).toMatchObject({day:'2026-10-14'});
  expect(nextAssessmentReminder(policy,'2026-10-17',defaultAssessmentReminderRules,new Date('2026-10-12T18:00:00Z'))).toBeNull();
 });
 it('bounds transport data to fixed task keys, counts, deadlines and at most three authorized team names',()=>{
  const mail={tasks:[{key:'team_results',count:4,closesAt:null,people:['Aina','Siti','Arun']}]};expect(assessmentReminderMailSchema.safeParse(mail).success).toBe(true);
  expect(assessmentReminderMailSchema.safeParse({...mail,html:'Arbitrary HR body'}).success).toBe(false);
  expect(assessmentReminderMailSchema.safeParse({tasks:[{key:'payroll_salary',count:4,closesAt:null}]}).success).toBe(false);
  expect(assessmentReminderMailSchema.safeParse({tasks:[{...mail.tasks[0],people:['A','B','C','D']}]}).success).toBe(false);
 });
});
