import {z} from 'zod';
/** Fixed allowlist: no reason, pay, medical field, attachment, arbitrary text or approval capability. */
export const attendanceCcMessage=z.object({reference:z.uuid(),applicant:z.string().min(1).max(500),level:z.number().int().min(1).max(10),action:z.enum(['approved','rejected','cancelled','withdrawn']),actor:z.string().min(1).max(500),occurredAt:z.iso.datetime()}).strict();
export type AttendanceCcMessage=z.infer<typeof attendanceCcMessage>;
export const attendanceCcTarget=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('employee'),userId:z.uuid(),subject:z.string().min(1).max(512),email:z.email().max(320).regex(/^[\x21-\x7e]+$/),locale:z.enum(['en','ms','zh','vi','ta','th']),message:attendanceCcMessage}).strict(),
 z.object({kind:z.literal('custom_email'),userId:z.null(),subject:z.null(),email:z.email().max(320).regex(/^[\x21-\x7e]+$/),locale:z.enum(['en','ms','zh','vi','ta','th']),message:attendanceCcMessage}).strict(),
]);
export type AttendanceCcTarget=z.infer<typeof attendanceCcTarget>;
