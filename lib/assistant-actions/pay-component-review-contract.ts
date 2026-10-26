/** Closed human catalogue CREATE custody; no employee assignment, payroll calculation or model values. */
import {z} from 'zod';
import {REVIEWED_PAY_COMPONENT_ACTION as action,ReviewedPayComponentHumanContent,ReviewedPayComponentInput,ReviewedPayComponentSourceReceipt} from './reviewed-pay-component-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)};
export const PayComponentReviewPrepare=ReviewedPayComponentHumanContent;
export const PayComponentReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const PayComponentReviewRetirement=z.object({...base,actionId:z.uuid()}).strict();
export const PayComponentPreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedPayComponentHumanContent,review:ReviewedPayComponentInput,consequence:z.literal('catalogue_created_no_employee_assignment_or_payroll_run')}).strict();
export const PayComponentCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:ReviewedPayComponentSourceReceipt}).strict();
export const PayComponentRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const PayComponentReviewIndex=z.object({kind:z.literal('pay_component_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
