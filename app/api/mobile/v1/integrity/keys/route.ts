import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityKeyOperations} from '@/lib/mobile-api/integrity-key-routes';
import {IntegrityKeysResult} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityKeyOperations(1);
export const GET = mobileRoute(IntegrityKeysResult,async(ctx,req)=>IntegrityKeysResult.parse(await operations.keys(ctx,req)));
