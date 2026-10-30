/** Source-reviewed disclosure registry. An approved record is a technical source review, never legal
 * adequacy, installed acceptance, or human employment decision authority. Pending records refuse.
 * Review digest covers exact transform sources/dependencies, not a caller-supplied schema hash. */
import {AiGatewayError} from './types';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from './provider-data-source-manifest';
export type ProviderDataReviewRecord=Readonly<{contractId:string;status:'pending'|'approved';sourceDigest:string;reviewer:string;evidence:string}>;
export const PROVIDER_DATA_REVIEW_RECORDS:readonly ProviderDataReviewRecord[]=Object.freeze([
 {contractId:'structured_canonical_records_v1',status:'pending',sourceDigest:'',reviewer:'pending',evidence:'pending'},
 {contractId:'attendance_trend_analysis_v1',status:'pending',sourceDigest:'',reviewer:'pending',evidence:'pending'},
 {contractId:'aggregate_comparison_analysis_v1',status:'pending',sourceDigest:'',reviewer:'pending',evidence:'pending'},
].map(row=>Object.freeze(row as ProviderDataReviewRecord)));
export function assertProviderDataContractReviewed(contractId:string,sourceDigest:string):void{
 const review=PROVIDER_DATA_REVIEW_RECORDS.find(row=>row.contractId===contractId);
 // A source edit invalidates approval even if the closed schema shape remains identical.
 if(!review||review.status!=='approved'||!review.evidence||!review.reviewer||review.sourceDigest!==sourceDigest||sourceDigest!==PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)
  throw new AiGatewayError('The AI data-protection review is pending or no longer matches this request.');
}
