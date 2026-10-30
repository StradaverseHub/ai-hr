/** Human schedule/day-kind proposal only; the native Attendance owner supplies every resulting figure. */
import {z} from 'zod';
import {AttendanceDayReviewView} from '../attendance-day-review';
export const DAY_SCHEDULE_CORRECTION_ACTION='attendance.day_schedule.correct' as const;
const id=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(DAY_SCHEDULE_CORRECTION_ACTION),contractVersion:z.literal(1)},dayKind=z.enum(['workday','off_day','rest_day','holiday']);
const byteBound=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=48000;
const Human=z.object({...base,employmentId:id,subjectId:id,date:z.iso.date(),baseline:digest,shiftId:id.nullable(),dayKind:dayKind.nullable(),reason:z.string().trim().min(1).max(500),confirmPayrollRecalculation:z.boolean()}).strict().refine(v=>v.employmentId===v.subjectId);
const Subject=z.object({employmentId:id,employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000)}).strict();
const Item=Subject.extend({subjectId:id,date:z.iso.date(),before:AttendanceDayReviewView,after:AttendanceDayReviewView}).strict().refine(v=>v.subjectId===v.employmentId&&v.after.override.version===v.before.override.version+1&&v.before.payroll.map(row=>row.batchId).join(',')===v.after.payroll.map(row=>row.batchId).join(',')&&v.after.payroll.every(row=>row.recalcRequired));
const Receipt=z.object({kind:z.literal('corrected'),employmentId:id,subjectId:id,date:z.iso.date(),adjustmentId:id,eventId:id,version:z.number().int().positive(),before:AttendanceDayReviewView,after:AttendanceDayReviewView}).strict().refine(v=>v.subjectId===v.employmentId&&v.after.override.version===v.version&&byteBound(v));
const consequence='dated_schedule_corrected_with_native_day_pattern_and_payroll_effects' as const;
export const DayScheduleCorrection={action:DAY_SCHEDULE_CORRECTION_ACTION,Human,Item,Receipt,consequence,indexKind:'day_schedule_correction_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:id.optional(),date:z.iso.date().optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),day:z.object({employmentId:id,date:z.iso.date(),baseline:digest,shiftId:id.nullable(),currentShiftCode:z.string().max(4000).nullable(),dayKind:dayKind.nullable(),dayKindLocked:z.boolean(),processedPayroll:z.boolean(),shifts:z.array(z.object({id,code:z.string().max(4000),name:z.string().max(4000)}).strict()).max(200)}).strict().nullable()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:id}).strict(),
 Prepared:z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.employmentId===v.review.employmentId&&v.content.subjectId===v.review.subjectId&&v.content.date===v.review.date&&v.content.shiftId===v.review.after.override.shiftId&&v.content.dayKind===v.review.after.override.dayKind&&v.content.reason===v.review.after.override.reason&&(v.review.after.payroll.length===0||v.content.confirmPayrollRecalculation)&&byteBound(v)),
 Completed:z.object({...base,actionId:id,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('day_schedule_correction_review_index'),reviews:z.array(z.object({...base,actionId:id,date:z.iso.date(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type DayScheduleCorrectionHuman=z.infer<typeof Human>;
