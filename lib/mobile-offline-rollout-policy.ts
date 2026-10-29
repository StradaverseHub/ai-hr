/** Trusted deployment offline-clock rollout. Neither the clock rollout, a phone nor a company setting activates it.
 * Bounds are engineering admission limits, not HR, retention or legal policy (those are owner decisions).
 * Keyless (owner decision D16, 29 October 2026): no issuer registry, signing key id or rotation facts. A policy that
 * still carries `issuers` or `signingKeyId` fails the strict schema (configuration_unavailable) until they are removed. */
import {z} from 'zod';
import {OFFLINE_CLOCK_MAX_WINDOW_MS} from './mobile-offline-context';
import {OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from './mobile-offline-clock';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const int=(min:number,max:number)=>z.number().int().min(min).max(max);
/** policyBytes: UTF-8 bytes of AIHR_MOBILE_OFFLINE_POLICY.
 * windowMs 1 min..72 h; permitCount 1..32; maximumIssuesPerHour 1..24; photoRetentionMs 1 h..366 d. */
export const OFFLINE_ROLLOUT_LIMITS={policyBytes:262144,
 windowMs:{min:60000,max:OFFLINE_CLOCK_MAX_WINDOW_MS},permitCount:{min:1,max:OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT},
 maximumIssuesPerHour:{min:1,max:24},photoRetentionMs:{min:3600000,max:366*86400000},entries:{max:100},actorIds:{min:1,max:1000}} as const;
const L=OFFLINE_ROLLOUT_LIMITS;
export const MobileOfflineRolloutPolicy=z.object({
 version:z.literal(1),
 // drain: claim upload and context close stay available; new context issuance is refused.
 mode:z.enum(['active','drain']),
 windowMs:int(L.windowMs.min,L.windowMs.max),permitCount:int(L.permitCount.min,L.permitCount.max),
 maximumIssuesPerHour:int(L.maximumIssuesPerHour.min,L.maximumIssuesPerHour.max),
 photoRetentionMs:int(L.photoRetentionMs.min,L.photoRetentionMs.max),
 entries:z.array(z.object({tenantId:uuid,companyId:uuid,
  actorIds:z.array(uuid).min(L.actorIds.min).max(L.actorIds.max).refine(values=>new Set(values).size===values.length)}).strict()).max(L.entries.max),
}).strict()
 .refine(value=>{const keys=value.entries.map(entry=>JSON.stringify([entry.tenantId,entry.companyId]));return new Set(keys).size===keys.length;});
export type MobileOfflineRolloutPolicy=z.infer<typeof MobileOfflineRolloutPolicy>;
