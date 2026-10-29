import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityOperations} from '@/lib/mobile-api/integrity-routes';
import {readMobileEnrollmentConfiguration} from '@/packs/attendance/mobile-integrity';
import {IntegrityEnrollmentPrepared} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityOperations((ctx,id,signal)=>readMobileEnrollmentConfiguration('ios',ctx,id,signal));
export const POST = mobileRoute(IntegrityEnrollmentPrepared,operations.enrollmentBegin);
