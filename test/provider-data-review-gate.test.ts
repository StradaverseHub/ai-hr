import {expect,it} from 'vitest';
import {assertProviderDataContractReviewed,PROVIDER_DATA_REVIEW_RECORDS} from '../lib/ai/provider-data-reviews';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from '../lib/ai/provider-data-source-manifest';
it('refuses every pending/unknown/stale review and never accepts a posted reviewed flag',()=>{
 expect(PROVIDER_DATA_REVIEW_RECORDS).toHaveLength(3);
 for(const record of PROVIDER_DATA_REVIEW_RECORDS){expect(record.status).toBe('pending');expect(()=>assertProviderDataContractReviewed(record.contractId,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toThrow();}
 for(const contract of ['unknown','reviewed:true','aggregate_comparison_analysis_v2'])expect(()=>assertProviderDataContractReviewed(contract,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toThrow();
 expect(()=>assertProviderDataContractReviewed('aggregate_comparison_analysis_v1','0'.repeat(64))).toThrow();
});
