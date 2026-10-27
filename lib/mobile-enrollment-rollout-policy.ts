/** Deployment-owned enrollment allowlist only. No attendance or offline trust policy. */
import {z} from 'zod';
import {AppleEnrollmentSettings} from './mobile-key-enrollment';
import {AndroidEnrollmentSettings} from './mobile-android-enrollment';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const MobileEnrollmentRolloutPolicy=z.object({version:z.literal(1),entries:z.array(z.object({
 tenantId:uuid,companyId:uuid,actorIds:z.array(uuid).min(1).max(1000).refine(values=>new Set(values).size===values.length),
 settings:z.union([AppleEnrollmentSettings,AndroidEnrollmentSettings]),
}).strict()).max(100)}).strict().refine(value=>{
 const keys=value.entries.map(entry=>JSON.stringify([entry.tenantId,entry.companyId,entry.settings.target.platform]));
 return new Set(keys).size===keys.length;
});
