/** Offline claim protocol bytes only. Parsing/hashing grants no permit, identity, time or punch.
 * Issuance, trusted context signature, key ownership, ordered consumption and adjudication remain
 * mandatory server owners; this contract does not enable an offline route or reuse online proofs. */
import {z} from 'zod';
import {OnlineClockIntegrityData} from './mobile-clock-integrity';
export const OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT=32;
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const nonce=z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const instant=z.number().int().positive().max(8640000000000000);
const duration=z.string().min(1).max(20).refine(value=>/^(0|[1-9][0-9]{0,19})$/.test(value)&&value.trim()===value&&BigInt(value)<=BigInt('18446744073709551615'));
/** Reported durations only. No raw uptime, wall/uptime pair, boot ID or runtime identifier on wire. */
export const OfflineClockElapsed=z.discriminatedUnion('status',[
 z.object({status:z.literal('elapsed'),minimumNs:duration,maximumNs:duration,continuity:z.enum(['same_process','same_boot'])}).strict()
  .refine(value=>duration.safeParse(value.minimumNs).success&&duration.safeParse(value.maximumNs).success&&BigInt(value.maximumNs)>=BigInt(value.minimumNs)),
 z.object({status:z.literal('unknown'),reason:z.enum(['invalid_snapshot','source_changed','boot_changed','continuity_unknown','counter_discontinuity'])}).strict(),
]);
export type OfflineClockElapsed=z.infer<typeof OfflineClockElapsed>;
export const OfflineClockClaimData=z.object({
 version:z.literal(1),purpose:z.literal('attendance.clock.offline.claim'),
 scope:OnlineClockIntegrityData.shape.scope.extend({companyId:uuid,appInstallationId:uuid}).strict(),
 // Digest of the canonical SERVER context data. A supplied digest alone proves no issuance.
 context:z.object({id:uuid,sha256:sha}).strict(),
 // Inventory/ordinal/nonce must match the separately verified server-issued context.
 permit:z.object({id:uuid,ordinal:z.number().int().min(1).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT),nonce}).strict(),
 chain:z.object({sequence:z.number().int().min(1).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT),previousSha256:sha.nullable()}).strict(),
 command:OnlineClockIntegrityData.shape.command,
 time:z.object({claimedAt:instant,elapsed:OfflineClockElapsed}).strict(),
 evidence:OnlineClockIntegrityData.shape.evidence,
}).strict().refine(value=>value.permit.ordinal===value.chain.sequence)
 .refine(value=>(value.chain.sequence===1)===(value.chain.previousSha256===null))
 .refine(value=>value.evidence.platform!=='ios'||value.time.elapsed.status!=='elapsed'||value.time.elapsed.continuity!=='same_boot');
export type OfflineClockClaimData=z.infer<typeof OfflineClockClaimData>;
/** Fixed positional encoding. Hash UTF-8 bytes; never a private journal or multipart digest.
 * Chain sequence is per issued context. Cross-protocol assertion order has a separate shared owner.
 * Proof verification and context/permit/current-policy checks are required before business effects. */
export function offlineClockClaimClientData(input:unknown):string{
 const p=OfflineClockClaimData.parse(input),s=p.scope,c=p.command,e=p.evidence,t=p.time.elapsed;
 return JSON.stringify(['aihr.mobile.integrity',p.version,p.purpose,
  [s.apiOrigin,s.installationId,s.tenantId,s.companyId,s.actorId,s.employmentId,s.appInstallationId,s.deviceKeyId],
  [p.context.id,p.context.sha256],[p.permit.id,p.permit.ordinal,p.permit.nonce],
  [p.chain.sequence,p.chain.previousSha256],
  [c.requestId,c.action,c.lat,c.lng,c.accuracy,c.sampledAt,c.photo?[c.photo.sha256,c.photo.byteLength,c.photo.mimeType]:null],
  [p.time.claimedAt,t.status==='elapsed'?['elapsed',t.minimumNs,t.maximumNs,t.continuity]:['unknown',t.reason]],
  [e.platform,e.appId,e.appVersion,e.buildVersion,e.provider,e.mock,e.simulated,e.accessory],
 ]);
}

/** Opaque unverified proof bytes. Crypto/key/counter/permit checks remain mandatory server owners. */
const offlineProofBytes=(maximum:number)=>z.string().min(4).max(Math.ceil(maximum/3)*4)
 .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
 .refine(value=>value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0)<=maximum);
export const OfflineClockAppleAssertion=offlineProofBytes(8192);
export const OfflineClockAndroidSignature=offlineProofBytes(72);
export const OfflineClockSignedClaim=z.object({claim:OfflineClockClaimData,proof:z.discriminatedUnion('platform',[
 z.object({platform:z.literal('ios'),assertion:OfflineClockAppleAssertion}).strict(),
 z.object({platform:z.literal('android'),signature:OfflineClockAndroidSignature}).strict(),
])}).strict().refine(value=>value.proof.platform===value.claim.evidence.platform);
export type OfflineClockSignedClaim=z.infer<typeof OfflineClockSignedClaim>;
