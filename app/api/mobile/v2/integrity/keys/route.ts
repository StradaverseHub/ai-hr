import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityKeyOperations} from '@/lib/mobile-api/integrity-key-routes';
import {IntegrityKeysResultV2} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityKeyOperations(2);
export const GET = mobileRoute(IntegrityKeysResultV2,async(ctx,req)=>IntegrityKeysResultV2.parse(await operations.keys(ctx,req)));
