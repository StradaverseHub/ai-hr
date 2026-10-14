import { z } from 'zod';

export const assessmentReminderTaskKeys=['own_results','own_checkin','own_competency','own_plan','feedback','team_setting','team_results','team_competency','team_plan','team_career','hod_performance','hod_potential','bu_performance','bu_potential','bg_talent','group_performance'] as const;
export const assessmentReminderTaskSchema=z.object({key:z.enum(assessmentReminderTaskKeys),count:z.number().int().min(1).max(1_000_000),closesAt:z.iso.datetime({offset:true}).nullable(),people:z.array(z.string().trim().min(1).max(200)).max(3).optional()}).strict();
export type AssessmentReminderTask=z.infer<typeof assessmentReminderTaskSchema>;
/** Bounded task counts, deadlines and authorized team names; no raw reviews, ratings, pay or recipient-controlled HTML. */
export const assessmentReminderMailSchema=z.object({tasks:z.array(assessmentReminderTaskSchema).max(16)}).strict();
