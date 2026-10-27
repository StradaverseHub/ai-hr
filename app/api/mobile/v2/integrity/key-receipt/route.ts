import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityKeyOperations} from '@/lib/mobile-api/integrity-key-routes';
import {IntegrityKeyLookupResultV2} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityKeyOperations(2);
export const POST = mobileRoute(IntegrityKeyLookupResultV2,async(ctx,req)=>IntegrityKeyLookupResultV2.parse(await operations.keyReceipt(ctx,req)));
