import {mobileRoute} from '@/lib/mobile-api/handler';
import {createDeployedClockCapabilitiesOperation} from '@/lib/mobile-api/deployed-signed-clock';
import {IntegrityClockCapabilities} from '@/lib/mobile-integrity-contract';
const operation=createDeployedClockCapabilitiesOperation('android');
export const GET = mobileRoute(IntegrityClockCapabilities,operation);
