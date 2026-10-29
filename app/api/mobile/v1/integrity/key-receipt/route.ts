import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityKeyOperations} from '@/lib/mobile-api/integrity-key-routes';
import {IntegrityKeyLookupResult} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityKeyOperations(1);
export const POST = mobileRoute(IntegrityKeyLookupResult,async(ctx,req)=>IntegrityKeyLookupResult.parse(await operations.keyReceipt(ctx,req)));
