/** Checks the diagnostic cases against the actual canonical parser, with bounded fixed labels. */
import {expect,it} from 'vitest';
import {assessmentReminderTaskSchema} from '../lib/assessment-reminder-mail';
import {rejectedAssessmentTaskChanges} from './fixtures/notification-worker/assessment-task-shape-cases';
it('identifies every claimed malformed task that the canonical parser actually accepts',()=>{
 const base={key:'own_competency',count:1,closesAt:null};
 const unexpected=rejectedAssessmentTaskChanges.flatMap((change,index)=>assessmentReminderTaskSchema.safeParse({...base,...change}).success?[{index,change}]:[]);
 expect(unexpected).toEqual([]);
});
