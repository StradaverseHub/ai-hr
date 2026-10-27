import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityKeyOperations} from '@/lib/mobile-api/integrity-key-routes';
import {IntegrityRevocationResult} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityKeyOperations(1);
export const POST = mobileRoute(IntegrityRevocationResult,async(ctx,req)=>IntegrityRevocationResult.parse(await operations.revoke(ctx,req)));
