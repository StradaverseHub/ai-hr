import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {assertProviderDataContractReviewed,PROVIDER_DATA_REVIEW_RECORDS,isCompleteProviderDataReview} from '../lib/ai/provider-data-reviews';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from '../lib/ai/provider-data-source-manifest';
it('refuses every pending/unknown/stale review and never accepts a posted reviewed flag',()=>{
 expect(PROVIDER_DATA_REVIEW_RECORDS).toHaveLength(3);
 for(const record of PROVIDER_DATA_REVIEW_RECORDS){expect(record.status).toBe('pending');expect(()=>assertProviderDataContractReviewed(record.contractId,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toThrow();}
 for(const contract of ['unknown','reviewed:true','aggregate_comparison_analysis_v2'])expect(()=>assertProviderDataContractReviewed(contract,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toThrow();
 expect(()=>assertProviderDataContractReviewed('aggregate_comparison_analysis_v1','0'.repeat(64))).toThrow();
});

it('rejects incomplete or placeholder approval metadata even after status/digest are changed',()=>{
 const complete={contractId:'aggregate_comparison_analysis_v1',status:'approved' as const,sourceDigest:PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST,reviewer:'human:Fixture Reviewer',evidence:'docs/reviews/fixture-specialist-approval.md#aggregate-analysis',reviewedAt:'2026-10-29T00:00:00Z'};
 expect(isCompleteProviderDataReview(complete,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toBe(true);
 for(const change of [{reviewer:'pending'},{reviewer:'human:pending'},{reviewer:' '},{reviewer:'automated:agent'},{evidence:'pending'},{evidence:' '},{evidence:'docs/reviews/pending.md#review'},{reviewedAt:'pending'},{reviewedAt:'2999-01-01T00:00:00Z'},{sourceDigest:'0'.repeat(64)}])
  expect(isCompleteProviderDataReview({...complete,...change},PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toBe(false);
 // A complete synthetic record does not replace the real pending registry.
 expect(()=>assertProviderDataContractReviewed(complete.contractId,complete.sourceDigest)).toThrow();
});

it('binds the exact reviewed transform dependency sources through the generated manifest',()=>{
 const result=JSON.parse(execFileSync(process.execPath,['scripts/ai-provider-data-source-manifest.mjs','--check'],{encoding:'utf8'}));
 expect(result.files).toBeGreaterThanOrEqual(13);expect(result.digest).toBe(PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST);
});
