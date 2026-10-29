import {mobileRoute} from '@/lib/mobile-api/handler';
import {createIntegrityOperations} from '@/lib/mobile-api/integrity-routes';
import {readMobileEnrollmentConfiguration,assertMobileEnrollmentCommit} from '@/packs/attendance/mobile-integrity';
import {IntegrityEnrollmentResult} from '@/lib/mobile-integrity-contract';
const operations=createIntegrityOperations((ctx,id,signal)=>readMobileEnrollmentConfiguration('ios',ctx,id,signal),{beforeEnrollmentCommit:assertMobileEnrollmentCommit});
export const POST = mobileRoute(IntegrityEnrollmentResult,operations.enrollmentComplete);
