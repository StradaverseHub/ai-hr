/** HR structural relationship selection. Models nominate IDs only; neither model nor human may
 * post a delegation hand-over, Movement tag, made-up manager facts or ignored closing date. */
import {z} from 'zod';
import {isCalendarDate} from '../calendar-date';
export const REVIEWED_REPORTING_LINE_ACTION='org.reporting.change' as const;
const base={action:z.literal(REVIEWED_REPORTING_LINE_ACTION),contractVersion:z.literal(1)},uuid=z.guid(),lineType=z.enum(['administrative','functional']),date=z.string().refine(isCalendarDate),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewedReportingLineNomination=z.object({...base,subordinateEmploymentId:uuid,managerEmploymentId:uuid,lineType}).strict();
export const ReviewedReportingLineHumanContent=z.object({...base,subordinateEmploymentId:uuid,managerEmploymentId:uuid,lineType,validFrom:date,confirmReportingChange:z.literal(true)}).strict();
export type ReviewedReportingLineHumanContent=z.infer<typeof ReviewedReportingLineHumanContent>;
export const ReviewedReportingLineConfirmation=z.object({...base,reviewedDigest:digest}).strict();
export const ReviewedReportingLineReview=z.object({subordinateEmploymentId:uuid,lineType,before:z.object({reportingLineId:uuid,managerEmploymentId:uuid,validFrom:date,validTo:z.null(),willCloseAt:date}).strict().nullable(),after:z.object({managerEmploymentId:uuid,validFrom:date,validTo:z.null()}).strict()}).strict();
export const ReviewedReportingLinePreparedSource=z.object({kind:z.literal('prepared_source'),content:ReviewedReportingLineHumanContent,review:ReviewedReportingLineReview,reviewedDigest:digest,consequence:z.literal('structural_reporting_change_not_delegation')}).strict();
export type ReviewedReportingLinePreparedSource=z.infer<typeof ReviewedReportingLinePreparedSource>;
export const ReviewedReportingLineSourceReceipt=z.object({kind:z.literal('recorded'),reportingLineId:uuid,setEventId:uuid,subordinateEmploymentId:uuid,managerEmploymentId:uuid,lineType,validFrom:date,validTo:date.nullable(),superseded:z.boolean(),semantics:z.literal('recorded_reporting_line_current_record'),replayed:z.boolean()}).strict();
