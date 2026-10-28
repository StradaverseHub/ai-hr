/** Trusted deployment offline-clock rollout. Neither the clock rollout, a phone nor a company setting activates it.
 * Bounds are engineering admission limits, not HR, retention or legal policy (those are owner decisions). */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {OfflineClockContextIssuer,OFFLINE_CLOCK_MAX_WINDOW_MS} from './mobile-offline-context';
import {OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from './mobile-offline-clock';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const int=(min:number,max:number)=>z.number().int().min(min).max(max);
/** policyBytes: UTF-8 bytes of AIHR_MOBILE_OFFLINE_POLICY; signingKeyPemBytes: of AIHR_MOBILE_OFFLINE_SIGNING_KEY.
 * windowMs 1 min..72 h; permitCount 1..32; maximumIssuesPerHour 1..24; photoRetentionMs 1 h..366 d. */
export const OFFLINE_ROLLOUT_LIMITS={policyBytes:262144,signingKeyPemBytes:4096,issuers:{min:1,max:16},
 windowMs:{min:60000,max:OFFLINE_CLOCK_MAX_WINDOW_MS},permitCount:{min:1,max:OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT},
 maximumIssuesPerHour:{min:1,max:24},photoRetentionMs:{min:3600000,max:366*86400000},entries:{max:100},actorIds:{min:1,max:1000}} as const;
const L=OFFLINE_ROLLOUT_LIMITS;
export const MobileOfflineRolloutPolicy=z.object({
 version:z.literal(1),
 // drain: claim upload and context close stay available; new context issuance is refused.
 mode:z.enum(['active','drain']),
 signingKeyId:z.string().length(64).regex(/^[a-f0-9]{64}$/),
 issuers:z.array(OfflineClockContextIssuer).min(L.issuers.min).max(L.issuers.max),
 windowMs:int(L.windowMs.min,L.windowMs.max),permitCount:int(L.permitCount.min,L.permitCount.max),
 maximumIssuesPerHour:int(L.maximumIssuesPerHour.min,L.maximumIssuesPerHour.max),
 photoRetentionMs:int(L.photoRetentionMs.min,L.photoRetentionMs.max),
 entries:z.array(z.object({tenantId:uuid,companyId:uuid,
  actorIds:z.array(uuid).min(L.actorIds.min).max(L.actorIds.max).refine(values=>new Set(values).size===values.length)}).strict()).max(L.entries.max),
}).strict()
 .refine(value=>{const keys=value.entries.map(entry=>JSON.stringify([entry.tenantId,entry.companyId]));return new Set(keys).size===keys.length;})
 .refine(value=>new Set(value.issuers.map(issuer=>issuer.keyId)).size===value.issuers.length)
 // The registry key id is the SHA-256 of the raw Ed25519 public key, as verifyOfflineClockContextSignature requires.
 .refine(value=>value.issuers.every(issuer=>createHash('sha256').update(Buffer.from(issuer.publicKey,'base64url')).digest('hex')===issuer.keyId))
 .refine(value=>value.issuers.some(issuer=>issuer.keyId===value.signingKeyId));
export type MobileOfflineRolloutPolicy=z.infer<typeof MobileOfflineRolloutPolicy>;
