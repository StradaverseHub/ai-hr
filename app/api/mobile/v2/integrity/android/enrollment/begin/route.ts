import {mobileRoute} from '@/lib/mobile-api/handler';
import {createAndroidEnrollmentOperations} from '@/lib/mobile-api/android-enrollment-routes';
import {readMobileEnrollmentConfiguration} from '@/packs/attendance/mobile-integrity';
import {IntegrityAndroidEnrollmentPrepared} from '@/lib/mobile-integrity-contract';
const operations=createAndroidEnrollmentOperations((ctx,id,signal)=>readMobileEnrollmentConfiguration('android',ctx,id,signal));
export const POST = mobileRoute(IntegrityAndroidEnrollmentPrepared,operations.enrollmentBegin);
