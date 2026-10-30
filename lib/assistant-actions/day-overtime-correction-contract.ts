/** Unmounted proposal. Native Attendance owns every resulting figure and business refusal. */
import {z} from 'zod';
import {AttendanceDayOvertimeChanges as Changes,AttendanceDayOvertimeReviewRow as Row,AttendanceDayOvertimeReviewView as View} from '../attendance-day-overtime-review';

export const DAY_OVERTIME_CORRECTION_ACTION='attendance.day_overtime.correct' as const;
const id=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const base={action:z.literal(DAY_OVERTIME_CORRECTION_ACTION),contractVersion:z.literal(1)};
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const bounded=(value:unknown)=>bytes(value)<=48000;
const Human=z.object({...base,employmentId:id,subjectId:id,date:z.iso.date(),baseline:digest,rows:Changes,
 reason:z.string().trim().min(1).max(500),confirmPayrollRecalculation:z.boolean()}).strict().refine(v=>v.employmentId===v.subjectId);

type ViewData=z.infer<typeof View>;
type ChangesData=z.infer<typeof Changes>;
function effectsMatch(before:ViewData,after:ViewData){
 return after.override.version===before.override.version+1&&after.override.shiftId===before.override.shiftId&&after.override.dayKind===before.override.dayKind
  &&before.payroll.map(row=>row.batchId).join(',')===after.payroll.map(row=>row.batchId).join(',')&&after.payroll.every(row=>row.recalcRequired);
}
/** Bind displayed selected/unselected manual values. Native services still prove map provenance,
 * eligibility, approved Auto semantics, calculations and actual stored effects in the transaction. */
function selectionMatches(rows:ChangesData,before:ViewData,after:ViewData){
 const picked=new Map(rows.map(row=>[row.key,row.minutes]));
 if(after.legacyRows.some(row=>!before.legacyRows.some(original=>original.key===row.key)))return false;
 for(const input of rows){
  const original=before.legacyRows.find(row=>row.key===input.key),result=after.legacyRows.find(row=>row.key===input.key);
  if(!original)return false;
  if(input.minutes===null){if(original.orphan){if(result)return false;}else if(!result||result.manualMinutes!==null||result.effectiveMinutes!==result.autoEffectiveMinutes)return false;}
  else if(!result||result.manualMinutes!==input.minutes||result.effectiveMinutes!==input.minutes||result.manualCalculatedMinutes!==original.calculatedMinutes)return false;
 }
 for(const row of before.legacyRows)if(!picked.has(row.key)){
  const result=after.legacyRows.find(value=>value.key===row.key);
  if(!result||result.manualMinutes!==row.manualMinutes||result.manualCalculatedMinutes!==row.manualCalculatedMinutes)return false;
 }
 return true;
}
const Subject=z.object({employmentId:id,employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000)}).strict();
const Item=Subject.extend({subjectId:id,date:z.iso.date(),before:View,after:View}).strict().refine(v=>v.subjectId===v.employmentId&&effectsMatch(v.before,v.after));
const Receipt=z.object({kind:z.literal('corrected'),employmentId:id,subjectId:id,date:z.iso.date(),adjustmentId:id,eventId:id,version:z.number().int().positive(),rows:Changes,before:View,after:View}).strict()
 .refine(v=>v.subjectId===v.employmentId&&v.after.override.version===v.version&&effectsMatch(v.before,v.after)&&selectionMatches(v.rows,v.before,v.after)&&bounded(v));
const consequence='dated_overtime_rows_corrected_with_native_day_pattern_and_payroll_effects' as const;
const Prepared=z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict()
 .refine(v=>v.content.employmentId===v.review.employmentId&&v.content.subjectId===v.review.subjectId&&v.content.date===v.review.date&&v.content.reason===v.review.after.override.reason
  &&selectionMatches(v.content.rows,v.review.before,v.review.after)&&(v.review.after.payroll.length===0||v.content.confirmPayrollRecalculation)
  &&Date.parse(v.expiresAt)>Date.parse(v.createdAt)&&bounded(v));
export const DayOvertimeCorrection={action:DAY_OVERTIME_CORRECTION_ACTION,Human,Changes,Row,View,Item,Receipt,Prepared,consequence,indexKind:'day_overtime_correction_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:id.optional(),date:z.iso.date().optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),day:z.object({employmentId:id,date:z.iso.date(),baseline:digest,complete:z.boolean(),processedPayroll:z.boolean(),approvedOtMinutes:z.number().int().nullable(),rows:z.array(Row).max(100)}).strict().nullable()}).strict(),
  z.object({kind:z.literal('unavailable')}).strict(),
 ]).refine(bounded),
 Confirmation:z.object({...base,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:id}).strict(),
 Completed:z.object({...base,actionId:id,state:z.literal('completed'),receipt:Receipt}).strict().refine(bounded),
 Retired:z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('day_overtime_correction_review_index'),reviews:z.array(z.object({...base,actionId:id,date:z.iso.date(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type DayOvertimeCorrectionHuman=z.infer<typeof Human>;
export type DayOvertimeCorrectionView=ViewData;
