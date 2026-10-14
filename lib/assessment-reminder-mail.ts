import { z } from 'zod';

export const assessmentReminderTaskKeys=['own_results','own_checkin','own_competency','own_plan','feedback','team_setting','team_results','team_competency','team_plan','team_career','hod_performance','hod_potential','bu_performance','bu_potential','bg_talent','group_performance'] as const;
export const assessmentReminderTaskSchema=z.object({key:z.enum(assessmentReminderTaskKeys),count:z.number().int().min(1).max(1_000_000),closesAt:z.iso.datetime({offset:true}).nullable(),people:z.array(z.string().trim().min(1).max(200)).max(3).optional()}).strict();
export type AssessmentReminderTask=z.infer<typeof assessmentReminderTaskSchema>;
export const assessmentReminderWordsSchema=z.object({subject:z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),opening:z.string().trim().min(1).max(500)}).strict();
export type AssessmentReminderWords=z.infer<typeof assessmentReminderWordsSchema>;
export const assessmentPreparedWordsSchema=z.object({subject:z.string().min(1).max(20000).regex(/^[^\r\n]+$/),opening:z.string().min(1).max(30000)}).strict();
/** Source placeholders are substituted from the authorized recipient's current routing facts only. */
export function fillAssessmentReminderWords(words:AssessmentReminderWords|null,name:string,cycle:string,count:number){
 if(!words)return null;const first=(name.trim().split(/\s+/)[0]||'there').toLowerCase().replace(/\p{L}[\p{L}\p{M}]*/gu,word=>word[0].toUpperCase()+word.slice(1));
 const values={first_name:first,count:String(count),things:count===1?'thing is':'things are',cycle};
 const fill=(text:string)=>text.replace(/\{(first_name|count|things|cycle)\}/g,(_,key:keyof typeof values)=>values[key]);
 return assessmentPreparedWordsSchema.parse({subject:fill(words.subject).replace(/[\r\n]/g,' '),opening:fill(words.opening)});
}
/** Bounded task counts, deadlines and authorized team names; no raw reviews, ratings, pay or recipient-controlled HTML. */
export const assessmentReminderMailSchema=z.object({tasks:z.array(assessmentReminderTaskSchema).max(16),words:assessmentPreparedWordsSchema.nullable().optional()}).strict();
