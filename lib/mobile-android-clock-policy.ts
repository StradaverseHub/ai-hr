/** Deployment-owned requirements for current Android evidence. No defaults or attendance authority. */
import {z} from 'zod';
import {AndroidEnrollmentSettings} from './mobile-android-enrollment';

const signal=z.enum(['deny_reported','require_report']);
export const AndroidClockIntegrityPolicy=z.object({
 version:z.literal(1),minimumDeviceIntegrity:z.enum(['device','strong']),
 licensing:z.enum(['licensed','any_evaluated']),
 maxTokenAgeMs:z.number().int().min(1).max(120000),
 allowedFutureSkewMs:z.number().int().min(0).max(30000),
 locationSignals:z.object({mock:signal,simulated:signal,
  accessory:z.enum(['allow','deny_reported','require_report']),
 }).strict(),
}).strict();
export type AndroidClockIntegrityPolicy=z.infer<typeof AndroidClockIntegrityPolicy>;

/** Shared opaque-token boundary for HTTP and direct service callers. */
export const AndroidClockOpaqueToken=z.string().min(1).max(32768).regex(/^[\x21-\x7e]+$/);
/** Clock configuration is distinct from enrollment permission and binds both settings and policy. */
export const AndroidClockConfiguration=z.object({settings:AndroidEnrollmentSettings,policy:AndroidClockIntegrityPolicy}).strict();
export const AndroidClockRefusalReason=z.enum(['invalid_proof','challenge_unavailable','stale_token','unrecognized_app','unlicensed_app',
 'device_integrity','reported_mock','reported_simulation','reported_accessory']);
export const AndroidClockUnavailableReason=z.enum(['configuration_unavailable','provider_unavailable','licensing_unavailable',
 'location_signal_unavailable','unknown_vendor_verdict','time_unavailable']);
