import {mobileRoute} from '@/lib/mobile-api/handler';
import {createDeployedSignedClockOperations} from '@/lib/mobile-api/deployed-signed-clock';
import {IntegrityClockResult} from '@/lib/mobile-integrity-contract';
const operations=createDeployedSignedClockOperations('android');
export const POST = mobileRoute(IntegrityClockResult,operations.clockComplete);
