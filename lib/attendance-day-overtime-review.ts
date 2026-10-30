/** Native overtime review projection and witness; no Assistant registry, authority or calculations. */
import {z} from 'zod';
import {AttendanceDayReviewLegacyRow,AttendanceDayReviewSummary,AttendanceDayReviewView,AttendanceDayReviewRow} from './attendance-day-review';
const minute=z.number().int().min(0).max(1440);
const byteLength=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const AttendanceDayOvertimeChanges=z.array(z.object({key:z.string().min(1).max(500),minutes:minute.nullable()}).strict()).min(1).max(100)
 .refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length)
 .refine(rows=>JSON.stringify(rows).length<=20000&&byteLength(rows)<=20000);
export const AttendanceDayOvertimeReviewRow=AttendanceDayReviewLegacyRow.extend({manualMinutes:minute.nullable(),manualCalculatedMinutes:z.number().int().nullable(),autoEffectiveMinutes:z.number().int()}).strict()
 .refine(v=>(v.manualMinutes===null)===(v.manualCalculatedMinutes===null));
const extra={complete:z.boolean(),approvedOtMinutes:z.number().int().nullable(),legacyRows:z.array(AttendanceDayOvertimeReviewRow).max(100)};
export const AttendanceDayOvertimeReviewSummary=AttendanceDayReviewSummary.omit({legacyRows:true}).extend(extra).strict();
export const AttendanceDayOvertimeReviewView=AttendanceDayReviewView.omit({legacyRows:true}).extend(extra).strict()
 .refine(v=>new Set(v.legacyRows.map(row=>row.key)).size===v.legacyRows.length&&new Set(v.payroll.map(row=>row.batchId)).size===v.payroll.length);
export const AttendanceDayOvertimeReviewWitness=z.object({version:z.literal(1),date:z.iso.date(),selectedRows:AttendanceDayOvertimeChanges,payrollBatchIds:z.array(z.guid()).max(25),
 before:z.object({summary:AttendanceDayOvertimeReviewSummary,rows:z.array(AttendanceDayReviewRow).max(256)}).strict(),
 after:z.object({summary:AttendanceDayOvertimeReviewSummary,rows:z.array(AttendanceDayReviewRow).max(256)}).strict(),relatedEventIds:z.array(z.guid()).max(100)}).strict().refine(v=>byteLength(v)<=120000);
export type AttendanceDayOvertimeReviewSummaryData=z.infer<typeof AttendanceDayOvertimeReviewSummary>;
export type AttendanceDayOvertimeReviewViewData=z.infer<typeof AttendanceDayOvertimeReviewView>;
