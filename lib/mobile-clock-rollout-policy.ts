/** Trusted deployment clock rollout. Neither enrollment permission nor a phone grants activation. */
import {z} from 'zod';
import {AppleEnrollmentSettings} from './mobile-key-enrollment';
import {AndroidClockConfiguration} from './mobile-android-clock-policy';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const project=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>value.trim()===value&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=BigInt('9223372036854775807'));
export const MobileClockRolloutPolicy=z.object({version:z.literal(1),entries:z.array(z.object({
 tenantId:uuid,companyId:uuid,actorIds:z.array(uuid).min(1).max(1000).refine(values=>new Set(values).size===values.length),
 // Applies to the selected actors in this proven company, on BOTH web and old mobile self-service.
 legacySelfService:z.enum(['allow_unverified','require_signed']),
 platforms:z.object({
  ios:z.object({configuration:AppleEnrollmentSettings}).strict().nullable(),
  android:z.object({configuration:AndroidClockConfiguration,cloudProjectNumber:project}).strict().nullable(),
 }).strict().refine(value=>value.ios!==null||value.android!==null),
}).strict()).max(100)}).strict().refine(value=>{
 const keys=value.entries.map(entry=>JSON.stringify([entry.tenantId,entry.companyId]));
 return new Set(keys).size===keys.length;
});
