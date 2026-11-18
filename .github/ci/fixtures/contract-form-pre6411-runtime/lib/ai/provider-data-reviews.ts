/** Disclosure review is source-owned. Pending/default records never authorize egress.
 * Technical automated testing is evidence for a human specialist, never a fabricated approval. */
import {AiPrivacyGateError} from './provider-privacy-error';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from './provider-data-source-manifest';
export type ProviderDataReviewRecord=Readonly<{contractId:string;status:'pending'|'approved';sourceDigest:string;reviewer:string;evidence:string;reviewedAt:string}>;
import {PROVIDER_DATA_REVIEW_RECORDS} from './provider-data-approvals';
export {PROVIDER_DATA_REVIEW_RECORDS} from './provider-data-approvals';
/** Record-shape validation only. This function cannot issue a capability or replace the STATIC
 * registry. Actual human approval and its immutable evidence must exist before editing it. Owner provisional approval is identified as such in the evidence; it is not specialist certification. */
export function isCompleteProviderDataReview(record:ProviderDataReviewRecord,expectedDigest:string):boolean{
 const date=Date.parse(record.reviewedAt);
 return record.status==='approved'&&/^[a-f0-9]{64}$/.test(expectedDigest)&&record.sourceDigest===expectedDigest&&
  /^human:[A-Za-z0-9][A-Za-z0-9 ._@/-]{2,119}$/.test(record.reviewer)&&!/(?:pending|unknown|placeholder|todo)/i.test(record.reviewer)&&
  /^docs\/reviews\/[a-z0-9][a-z0-9-]+\.md#[a-z0-9][a-z0-9-]{2,}$/.test(record.evidence)&&!/(?:pending|placeholder|todo)/i.test(record.evidence)&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.reviewedAt)&&Number.isFinite(date)&&date<=Date.now();
}
export function assertProviderDataContractReviewed(contractId:string,sourceDigest:string):void{
 const review=PROVIDER_DATA_REVIEW_RECORDS.find(row=>row.contractId===contractId);
 if(!review||sourceDigest!==PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST||!isCompleteProviderDataReview(review,sourceDigest))
  throw new AiPrivacyGateError('unreviewed');
}

/** Single review-state owner for local projection metadata and the runtime boundary. */
export function providerDataReviewStatus(contractId:string):'pending'|'approved'{
 const review=PROVIDER_DATA_REVIEW_RECORDS.find(row=>row.contractId===contractId);
 return review&&isCompleteProviderDataReview(review,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)?'approved':'pending';
}
