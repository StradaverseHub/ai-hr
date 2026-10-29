import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityKeyOperations} from '@/lib/mobile-api/integrity-key-routes';
import {IntegrityRevocationResultV2} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityKeyOperations(2);
export const POST = mobileRoute(IntegrityRevocationResultV2,async(ctx,req)=>IntegrityRevocationResultV2.parse(await operations.revoke(ctx,req)));
