/** Checks the diagnostic cases against the actual canonical parser, with bounded fixed labels. */
import {expect,it} from 'vitest';
import {assessmentReminderTaskSchema,assessmentPreparedWordsSchema} from '../lib/assessment-reminder-mail';
import {acceptedAssessmentPeopleEdges,rejectedAssessmentTaskChanges,rejectedAssessmentWords} from './fixtures/notification-worker/assessment-task-shape-cases';
import {assertAssessmentParserContract} from './fixtures/notification-worker/assessment-parser-contract';
it('identifies every claimed malformed task that the canonical parser actually accepts',()=>{
 const base={key:'own_competency',count:1,closesAt:null};
 const unexpected=rejectedAssessmentTaskChanges.flatMap((change,index)=>assessmentReminderTaskSchema.safeParse({...base,...change}).success?[{index,change}]:[]);
 expect(unexpected).toEqual([]);
});
it('pins the real parser and accepts exact Unicode code-point boundaries',()=>{
 assertAssessmentParserContract();
 for(const people of acceptedAssessmentPeopleEdges){
  const parsed=assessmentReminderTaskSchema.parse({key:'own_competency',count:1,closesAt:null,people});
  expect(parsed.people).toEqual(people.map(name=>name.trim()));
 }
 expect(assessmentPreparedWordsSchema.parse({subject:'😀'.repeat(20000),opening:'😀'.repeat(30000)})).toEqual({subject:'😀'.repeat(20000),opening:'😀'.repeat(30000)});
 expect(assessmentPreparedWordsSchema.parse({subject:'\u0001'.repeat(20000),opening:'\u0002'.repeat(30000)})).toEqual({subject:'\u0001'.repeat(20000),opening:'\u0002'.repeat(30000)});
 for(const words of rejectedAssessmentWords)expect(assessmentPreparedWordsSchema.safeParse(words).success).toBe(false);
});
