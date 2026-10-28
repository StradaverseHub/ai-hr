/** Closed non-own Workforce custody. The authenticated HR caller is never the target employee. */
import {z} from 'zod';
import {REVIEWED_REPORTING_LINE_ACTION as ACTION,ReviewedReportingLineHumanContent,ReviewedReportingLineReview,ReviewedReportingLineSourceReceipt} from './reviewed-reporting-line-contract';
export const OrgActionPrepare=ReviewedReportingLineHumanContent;
export const OrgActionConfirmation=z.object({action:z.literal(ACTION),contractVersion:z.literal(1),actionId:z.guid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
/** Privacy retirement needs ownership, never permission to reopen another employee's facts. */
export const OrgActionRetirement=OrgActionConfirmation.omit({reviewedDigest:true});
export const OrgActionPreparedReview=OrgActionConfirmation.extend({createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedReportingLineHumanContent,review:ReviewedReportingLineReview,consequence:z.literal('structural_reporting_change_not_delegation')}).strict();
export const OrgActionCompletedReceipt=z.object({action:z.literal(ACTION),contractVersion:z.literal(1),actionId:z.guid(),state:z.literal('completed'),receipt:ReviewedReportingLineSourceReceipt}).strict();
/** completed here means private body already retired; it is NOT a native effect receipt. */
export const OrgActionRetirementReceipt=OrgActionRetirement.extend({state:z.enum(['completed','discarded','expired','refused'])}).strict();
export const OrgActionReviewIndexResult=z.object({kind:z.literal('org_module_review_index'),reviews:z.array(z.object({action:z.literal(ACTION),actionId:z.guid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.actionId)).size===rows.length)}).strict();
