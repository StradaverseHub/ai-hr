/** Trusted deployment clock rollout. Neither enrollment permission nor a phone grants activation. */
import {z} from 'zod';
import {AppleEnrollmentSettings} from './mobile-key-enrollment';
import {AndroidClockConfiguration,AndroidPlayCloudProject} from './mobile-android-clock-policy';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const AppleClockDeployment=z.object({configuration:AppleEnrollmentSettings}).strict();
export const AndroidClockDeployment=z.object({configuration:AndroidClockConfiguration,cloudProjectNumber:AndroidPlayCloudProject}).strict();
export const MobileClockDeployment=z.union([AppleClockDeployment,AndroidClockDeployment]);
export const MobileClockRolloutPolicy=z.object({version:z.literal(1),entries:z.array(z.object({
 tenantId:uuid,companyId:uuid,actorIds:z.array(uuid).min(1).max(1000).refine(values=>new Set(values).size===values.length),
 // Applies to the selected actors in this proven company, on BOTH web and old mobile self-service.
 legacySelfService:z.enum(['allow_unverified','require_signed']),
 platforms:z.object({
  ios:AppleClockDeployment.nullable(),
  android:AndroidClockDeployment.nullable(),
 }).strict().refine(value=>value.ios!==null||value.android!==null),
}).strict()).max(100)}).strict().refine(value=>{
 const keys=value.entries.map(entry=>JSON.stringify([entry.tenantId,entry.companyId]));
 return new Set(keys).size===keys.length;
});
