import {mobileRoute} from '@/lib/mobile-api/handler';
import {createAndroidEnrollmentOperations} from '@/lib/mobile-api/android-enrollment-routes';
import {readMobileEnrollmentConfiguration,assertMobileEnrollmentCommit} from '@/packs/attendance/mobile-integrity';
import {IntegrityAndroidEnrollmentResult} from '@/lib/mobile-integrity-contract';
const operations=createAndroidEnrollmentOperations((ctx,id,signal)=>readMobileEnrollmentConfiguration('android',ctx,id,signal),{beforeEnrollmentCommit:assertMobileEnrollmentCommit});
export const POST = mobileRoute(IntegrityAndroidEnrollmentResult,operations.enrollmentComplete);
