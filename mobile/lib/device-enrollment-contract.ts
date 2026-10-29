import type {ClockSigningKey} from './clock-signing-key';
import type {EnrollmentStatus} from './enrollment-journal';
import type {AndroidEnrollmentStatus} from './android-enrollment-journal';
export type DeviceEnrollmentStatus=EnrollmentStatus|AndroidEnrollmentStatus;
/** Local bridge support and saved status are not server authorization or verified attendance. */
export type DeviceEnrollmentController={platform:'ios'|'android';supported:boolean;
 signingKey?:()=>Promise<ClockSigningKey>;
 /** iPhone only: the App Attest environment of the stored key receipt (offline context target). */
 signingEnvironment?:()=>Promise<'production'|'development'>;
 status():Promise<DeviceEnrollmentStatus>;begin():Promise<DeviceEnrollmentStatus>;
 advance():Promise<DeviceEnrollmentStatus>;reconcile():Promise<DeviceEnrollmentStatus>;
 revoke():Promise<DeviceEnrollmentStatus>;replace?:()=>Promise<DeviceEnrollmentStatus>;
};
