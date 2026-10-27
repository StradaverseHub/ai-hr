import {mobileRoute} from '@/lib/mobile-api/handler';
import {createDeployedSignedClockOperations} from '@/lib/mobile-api/deployed-signed-clock';
import {IntegrityAndroidClockPrepared} from '@/lib/mobile-integrity-contract';
const operations=createDeployedSignedClockOperations('android');
export const POST = mobileRoute(IntegrityAndroidClockPrepared,operations.clockBegin);
