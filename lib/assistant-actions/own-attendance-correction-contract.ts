/** Human-entered correction data, not an approval or generated clock/work evidence. Canonical owner
 * retains complete validation. HR-only clockChanges/unclocked work stay explicit, never dropped. */
import {z} from 'zod';
const uuid=z.uuid().transform(value=>value.toLowerCase());
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),interval=z.object({fromEpochMillisecond:z.number().int(),toEpochMillisecond:z.number().int()}).strict();
export const OwnAttendanceCorrectionIntent=z.object({version:z.literal(1),employmentId:uuid,date:z.iso.date(),
 checkIn:time.nullable().optional(),checkOut:time.nullable().optional(),requestedOtMinutes:z.number().finite().nullable().optional(),
 plannedStartTime:time.nullable().optional(),plannedEndTime:time.nullable().optional(),
 otReasonCategory:z.enum(['project_deadline','system_maintenance','month_end_closing','client_request','other']).nullable().optional(),
 reason:z.string().max(4000),remark:z.string().max(4000).nullable().optional(),requestKind:z.enum(['self_overtime','short_hours','incomplete_entry','absent','other']).nullable().optional(),
 clockChanges:z.object({version:z.literal(1),baseline:z.string().regex(/^[a-f0-9]{64}$/),entries:z.array(z.object({id:uuid.optional(),punchAt:time,direction:z.enum(['in','out'])}).strict()).max(100)}).strict().nullable().optional(),
 unclockedWork:z.object({completeWorkedDay:z.literal(true),intervals:z.array(interval).min(1).max(16),requestedIntervals:z.array(interval).min(1).max(16).optional()}).strict().nullable().optional(),
}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=24000,'Attendance review is too large.');
export type OwnAttendanceCorrectionIntent=z.infer<typeof OwnAttendanceCorrectionIntent>;
export const OwnAttendanceCorrectionReview=z.object({version:z.literal(1),action:z.literal('attendance.correction.request'),
 request:OwnAttendanceCorrectionIntent,before:z.object({checkIn:z.string().nullable(),checkOut:z.string().nullable()}).strict(),
 meaning:z.literal('submit_for_existing_approval_not_clock_or_overtime_approval'),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OwnAttendanceCorrectionReview=z.infer<typeof OwnAttendanceCorrectionReview>;
export const OwnAttendanceCorrectionReceipt=z.object({version:z.literal(1),action:z.literal('attendance.correction.request'),proof:z.literal('recorded_submission_current_own_request'),
 correctionId:uuid,employmentId:uuid,eventId:uuid,date:z.iso.date(),status:z.enum(['pending','approved','rejected','cancelled']),cancelled:z.boolean(),
 meaning:z.literal('submitted_not_approved')}).strict();
export type OwnAttendanceCorrectionReceipt=z.infer<typeof OwnAttendanceCorrectionReceipt>;
