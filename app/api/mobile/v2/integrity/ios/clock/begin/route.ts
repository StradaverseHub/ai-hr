import {mobileRoute} from '@/lib/mobile-api/handler';
import {createDeployedSignedClockOperations} from '@/lib/mobile-api/deployed-signed-clock';
import {IntegrityClockPrepared} from '@/lib/mobile-integrity-contract';
const operations=createDeployedSignedClockOperations('ios');
export const POST = mobileRoute(IntegrityClockPrepared,async(ctx,req)=>IntegrityClockPrepared.parse(await operations.clockBegin(ctx,req)));
