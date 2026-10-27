/** Server context signature data only. Neither parsing nor a valid signature authorizes a punch.
 * The issued-record, original request nonce, permits/current grants and adjudication are separate. */
import {z} from 'zod';
import {AppleEnrollmentTarget} from './mobile-key-enrollment';
import {AndroidEnrollmentTarget} from './mobile-android-enrollment';
import {OfflineClockClaimData,OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from './mobile-offline-clock';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const nonce=z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const instant=z.number().int().positive().max(8640000000000000);
export const OFFLINE_CLOCK_MAX_WINDOW_MS=72*60*60*1000;
export const OFFLINE_CLOCK_CONTEXT_MAX_BYTES=65536;
const site=z.object({id:uuid,name:z.string().min(1).max(200),lat:z.number().finite().min(-90).max(90),
 lng:z.number().finite().min(-180).max(180),radiusM:z.number().finite().positive()}).strict();
const permit=z.object({id:uuid,ordinal:z.number().int().min(1).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT),nonce}).strict();
export const OfflineClockContextRequest=z.object({requestId:uuid,requestNonce:nonce,appInstallationId:uuid,keyId:uuid}).strict();
const target=z.discriminatedUnion('platform',[
 AppleEnrollmentTarget.pick({platform:true,appId:true,environment:true}).strict(),
 z.object({platform:z.literal('android'),appId:AndroidEnrollmentTarget.shape.packageName,environment:z.null()}).strict(),
]);
export const OfflineClockContextData=z.object({
 version:z.literal(1),purpose:z.literal('attendance.clock.offline.context'),
 issuer:z.object({algorithm:z.literal('ed25519'),keyId:sha}).strict(),
 id:uuid,requestId:uuid,requestNonce:nonce,
 scope:OfflineClockClaimData.shape.scope,
 target,
 issuedAt:instant,expiresAt:instant,
 policy:z.object({revision:sha,offlineEnabled:z.boolean(),windowMs:z.number().int().min(1).max(OFFLINE_CLOCK_MAX_WINDOW_MS),
  geofencingRequired:z.boolean(),maximumAccuracyM:z.number().finite().positive().nullable(),
  photoRequirement:z.enum(['required','optional','not_required'])}).strict(),
 sites:z.array(site).max(32),
 attendance:z.object({baseline:sha,date:z.iso.date(),clockedIn:z.boolean(),openSince:instant.nullable()}).strict(),
 permits:z.array(permit).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT),
}).strict().refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=value.policy.windowMs)
 .refine(value=>value.attendance.clockedIn===(value.attendance.openSince!==null))
 .refine(value=>new Set(value.sites.map(s=>s.id)).size===value.sites.length)
 .refine(value=>new Set(value.permits.map(p=>p.id)).size===value.permits.length&&new Set(value.permits.map(p=>p.nonce)).size===value.permits.length)
 .refine(value=>value.permits.every((p,index)=>p.ordinal===index+1))
 .refine(value=>value.policy.offlineEnabled?value.permits.length>0&&(!value.policy.geofencingRequired||value.sites.length>0):value.permits.length===0);
export type OfflineClockContextData=z.infer<typeof OfflineClockContextData>;
export const OfflineClockContextEnvelope=z.object({context:OfflineClockContextData,
 signature:z.string().length(86).regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)}).strict();
/** Keys are supplied by an authenticated installation/deployment registry, never this envelope. */
export const OfflineClockContextIssuer=z.object({keyId:sha,publicKey:z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
 validFrom:instant,validUntil:instant,revoked:z.boolean()}).strict().refine(value=>value.validUntil>value.validFrom);
export type OfflineClockContextIssuer=z.infer<typeof OfflineClockContextIssuer>;
/** Resource preflight before walking any submitted arrays. API body admission remains mandatory. */
export function parseOfflineClockContext(input:unknown):OfflineClockContextData{
 if(!input||typeof input!=='object'||!Array.isArray(Reflect.get(input,'sites'))||!Array.isArray(Reflect.get(input,'permits'))||
  Reflect.get(input,'sites').length>32||Reflect.get(input,'permits').length>OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT)throw new Error('Invalid offline context');
 return OfflineClockContextData.parse(input);
}
export function offlineClockContextClientData(input:unknown):string{
 const p=parseOfflineClockContext(input),s=p.scope,policy=p.policy,a=p.attendance;
 const sites=[...p.sites].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0);
 return JSON.stringify(['aihr.mobile.integrity',p.version,p.purpose,
  [p.issuer.algorithm,p.issuer.keyId],[p.id,p.requestId,p.requestNonce],
  [s.apiOrigin,s.installationId,s.tenantId,s.companyId,s.actorId,s.employmentId,s.appInstallationId,s.deviceKeyId],
  [p.target.platform,p.target.appId,p.target.environment],[p.issuedAt,p.expiresAt],
  [policy.revision,policy.offlineEnabled,policy.windowMs,policy.geofencingRequired,policy.maximumAccuracyM,policy.photoRequirement],
  sites.map(site=>[site.id,site.name,site.lat,site.lng,site.radiusM]),
  [a.baseline,a.date,a.clockedIn,a.openSince],p.permits.map(permit=>[permit.id,permit.ordinal,permit.nonce]),
 ]);
}
