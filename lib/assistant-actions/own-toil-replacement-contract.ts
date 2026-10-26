/** Human worked-date credit request, never model-created work evidence or banked balance use. */
import {z} from 'zod';
import {LEAVE_CREDIT_DAY_TYPES} from '../leave-credit-day-type';
export const OWN_TOIL_REPLACEMENT_ACTION='toil.replacement.request' as const;
const uuid=z.uuid(),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const base={action:z.literal(OWN_TOIL_REPLACEMENT_ACTION),contractVersion:z.literal(1),employmentId:uuid,leaveTypeId:uuid.nullable().optional(),firstScheduleConsent:z.boolean()};
export const OwnToilReplacementNomination=z.object({action:z.literal(OWN_TOIL_REPLACEMENT_ACTION),contractVersion:z.literal(1),employmentId:uuid}).strict();
export const OwnToilReplacementHumanContent=z.discriminatedUnion('engine',[
 z.object({...base,engine:z.literal('leave_credit_rows'),reason:z.string().trim().min(1).max(4000),rows:z.array(z.object({workedDate:date,dayType:z.enum(LEAVE_CREDIT_DAY_TYPES),claimStart:time,claimEnd:time}).strict()).min(1).max(32)}).strict(),
 z.object({...base,engine:z.literal('replacement_native'),reason:z.string().max(4000).optional(),unit:z.enum(['day','hour']),lines:z.array(z.object({workedDate:date,days:z.number().finite().positive().optional(),fromTime:time.optional(),toTime:time.optional(),sourceType:z.enum(['non_working_day','extended_hours']).optional()}).strict()).min(1).max(32)}).strict(),
]);
export type OwnToilReplacementHumanContent=z.infer<typeof OwnToilReplacementHumanContent>;
export const OwnToilReplacementConfirmation=z.object({action:z.literal(OWN_TOIL_REPLACEMENT_ACTION),contractVersion:z.literal(1),reviewedDigest:digest}).strict();
export const OwnToilReplacementReview=z.object({employmentId:uuid,leaveTypeId:uuid.nullable(),unit:z.enum(['day','hour']),totalDays:z.number().finite().positive(),totalHours:z.number().finite().nonnegative(),reason:z.string().nullable(),submittedOn:date,firstScheduleConsent:z.boolean(),lines:z.array(z.object({workedDate:date,days:z.string(),fromTime:time.nullable(),toTime:time.nullable(),hours:z.string().nullable(),sourceType:z.enum(['non_working_day','extended_hours']).nullable(),workedDayKind:z.enum(LEAVE_CREDIT_DAY_TYPES).nullable(),shiftEnd:time.nullable(),actualClockOut:time.nullable(),eligibleMinutes:z.number().int().nullable()}).strict()).min(1).max(32)}).strict();
export const OwnToilReplacementPreparedSource=z.object({kind:z.literal('prepared_source'),content:OwnToilReplacementHumanContent,review:OwnToilReplacementReview,reviewedDigest:digest,consequence:z.literal('request_only_no_credit_grant_or_cash')}).strict();
export const OwnToilReplacementSourceReceipt=z.object({kind:z.literal('requested'),requestId:uuid,submittedEventId:uuid,employmentId:uuid,currentStatus:z.enum(['pending','approved','rejected','cancelled']),totalDays:z.number().finite().positive(),totalHours:z.number().finite().nonnegative(),meaning:z.literal('request_recorded_no_assistant_credit_grant'),replayed:z.boolean()}).strict();
