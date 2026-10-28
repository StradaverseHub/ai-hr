/** Existing Personnel EPF/SOCSO section only; no posted country or protected pass-through fields. */
import {z} from 'zod';
import {REVIEWED_COUNTRY_STATUTORY_ACTION as action,ReviewedCountryStatutoryHumanContent,ReviewedCountryStatutoryReview,ReviewedCountryStatutorySourceReceipt} from './reviewed-country-statutory-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const CountryStatutoryReviewPrepare=ReviewedCountryStatutoryHumanContent;
export const CountryStatutoryReviewConfirmation=z.object({...base,actionId:z.guid(),reviewedDigest:digest}).strict();
export const CountryStatutoryReviewRetirement=z.object({...base,actionId:z.guid()}).strict();
export const CountryStatutoryPreparedReview=z.object({...base,actionId:z.guid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedCountryStatutoryHumanContent,review:ReviewedCountryStatutoryReview}).strict();
export const CountryStatutoryCompletedReview=z.object({...base,actionId:z.guid(),state:z.literal('completed'),receipt:ReviewedCountryStatutorySourceReceipt}).strict();
export const CountryStatutoryRetiredReview=z.object({...base,actionId:z.guid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const CountryStatutoryReviewIndex=z.object({kind:z.literal('country_statutory_review_index'),reviews:z.array(z.object({...base,actionId:z.guid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
