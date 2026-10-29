import {mobileRoute} from '@/lib/mobile-api/handler';
import {createEnrollmentCapabilitiesOperation} from '@/lib/mobile-api/enrollment-capabilities';
import {readMobileEnrollmentConfiguration} from '@/packs/attendance/mobile-integrity';
import {IntegrityEnrollmentCapabilitiesV2} from '@/lib/mobile-integrity-contract';
const operation=createEnrollmentCapabilitiesOperation('ios',(ctx,id,signal)=>readMobileEnrollmentConfiguration('ios',ctx,id,signal));
export const GET = mobileRoute(IntegrityEnrollmentCapabilitiesV2,operation);
