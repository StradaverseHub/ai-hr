/** Offline server context data (owner decision D16, 29 October 2026: keyless). The server signs no context. It is trusted
 * because the server issued and recorded it (mobile_offline_context holds this exact canonical JSON and its digest), and a
 * claim is accepted only against that record and the phone's leased hardware key. Neither parsing nor a binding check
 * authorizes a punch: the issued record, original request nonce, permits/current grants and adjudication are separate. */
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
export const OfflineClockContextTarget=z.discriminatedUnion('platform',[
 AppleEnrollmentTarget.pick({platform:true,appId:true,environment:true}).strict(),
 z.object({platform:z.literal('android'),appId:AndroidEnrollmentTarget.shape.packageName,environment:z.null()}).strict(),
]);
export const OfflineClockContextData=z.object({
 version:z.literal(1),purpose:z.literal('attendance.clock.offline.context'),
 id:uuid,requestId:uuid,requestNonce:nonce,
 scope:OfflineClockClaimData.shape.scope,
 target:OfflineClockContextTarget,
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
/** Current owner supplies these expectations independently of the submitted context. */
export const OfflineClockContextBinding=z.object({scope:OfflineClockClaimData.shape.scope,request:OfflineClockContextRequest,target:OfflineClockContextTarget}).strict()
 .refine(value=>value.request.appInstallationId===value.scope.appInstallationId&&value.request.keyId===value.scope.deviceKeyId);
export type OfflineClockContextBinding=z.infer<typeof OfflineClockContextBinding>;
/** The phone's local check of a context it received over HTTPS from its own paired server (D16). `context_valid` means
 * well-formed and naming exactly the expected scope/request/target, with its digest; it is not a server signature and
 * grants nothing. A context the server did not record, or bytes it did not hand out, is refused when a claim names it. */
export type OfflineClockContextVerificationResult={outcome:'context_valid';context:OfflineClockContextData;digest:string;authorization:'not_granted'}|
 {outcome:'invalid';reason:'malformed'|'scope_mismatch'|'request_mismatch'|'target_mismatch'};
/** Resource preflight before walking any submitted arrays. API body admission remains mandatory. */
export function parseOfflineClockContext(input:unknown):OfflineClockContextData{
 if(!input||typeof input!=='object'||!Array.isArray(Reflect.get(input,'sites'))||!Array.isArray(Reflect.get(input,'permits'))||
  Reflect.get(input,'sites').length>32||Reflect.get(input,'permits').length>OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT)throw new Error('Invalid offline context');
 return OfflineClockContextData.parse(input);
}
/** Positional digest bytes: hash their UTF-8 encoding. The claim's context.sha256 and the recorded context_digest are this. */
export function offlineClockContextClientData(input:unknown):string{
 const p=parseOfflineClockContext(input),s=p.scope,policy=p.policy,a=p.attendance;
 const sites=[...p.sites].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0);
 return JSON.stringify(['aihr.mobile.integrity',p.version,p.purpose,
  [p.id,p.requestId,p.requestNonce],
  [s.apiOrigin,s.installationId,s.tenantId,s.companyId,s.actorId,s.employmentId,s.appInstallationId,s.deviceKeyId],
  [p.target.platform,p.target.appId,p.target.environment],[p.issuedAt,p.expiresAt],
  [policy.revision,policy.offlineEnabled,policy.windowMs,policy.geofencingRequired,policy.maximumAccuracyM,policy.photoRequirement],
  sites.map(site=>[site.id,site.name,site.lat,site.lng,site.radiusM]),
  [a.baseline,a.date,a.clockedIn,a.openSince],p.permits.map(permit=>[permit.id,permit.ordinal,permit.nonce]),
 ]);
}
const utf8Bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
/** The exact JSON text the server hands out and records (D16): JSON.stringify of the strictly parsed context, in schema key
 * order. The record stores these bytes verbatim; recovery returns them unchanged. */
export function offlineClockContextJson(input:unknown):string{
 const raw=JSON.stringify(parseOfflineClockContext(input));
 if(utf8Bytes(raw)>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error('Invalid offline context');
 return raw;
}
/** Bounded strict parse of handed-out context JSON. Only the canonical text is accepted (re-serializing the parsed context
 * must reproduce it byte for byte), so a recorded copy and its digest can never disagree about what was issued. */
export function parseOfflineClockContextJson(raw:unknown):OfflineClockContextData{
 if(typeof raw!=='string'||raw.length>OFFLINE_CLOCK_CONTEXT_MAX_BYTES||utf8Bytes(raw)>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error('Invalid offline context');
 const context=parseOfflineClockContext(JSON.parse(raw));
 if(JSON.stringify(context)!==raw)throw new Error('Noncanonical offline context');
 return context;
}
export type OfflineClockContextCheck={outcome:'bound';context:OfflineClockContextData;canonical:string}|
 {outcome:'invalid';reason:'malformed'|'scope_mismatch'|'request_mismatch'|'target_mismatch'};
type Scope=OfflineClockContextData['scope'];type Target=OfflineClockContextData['target'];
const scopeFields=(s:Scope)=>JSON.stringify([s.apiOrigin,s.installationId,s.tenantId,s.companyId,s.actorId,s.employmentId,s.appInstallationId,s.deviceKeyId]);
const targetFields=(t:Target)=>JSON.stringify([t.platform,t.appId,t.environment]);
/** D16 binding check, shared by the phone. `binding` is the current connection owner's own expectation (scope including
 * apiOrigin, installation, employment, app installation and device key; request id/nonce; app target), never read from
 * the context; a malformed binding is a trusted-input fault and throws. Fields are compared positionally, so object key
 * order never matters. Expiry and window rules stay with the schema, capture-time elapsed bounds and server adjudication. */
export function bindOfflineClockContext(raw:unknown,expected:OfflineClockContextBinding):OfflineClockContextCheck{
 const binding=OfflineClockContextBinding.parse(expected);
 let context:OfflineClockContextData;
 try{context=parseOfflineClockContextJson(raw);}catch{return {outcome:'invalid',reason:'malformed'};}
 if(scopeFields(context.scope)!==scopeFields(binding.scope))return {outcome:'invalid',reason:'scope_mismatch'};
 if(context.requestId!==binding.request.requestId||context.requestNonce!==binding.request.requestNonce)return {outcome:'invalid',reason:'request_mismatch'};
 if(targetFields(context.target)!==targetFields(binding.target))return {outcome:'invalid',reason:'target_mismatch'};
 return {outcome:'bound',context,canonical:offlineClockContextClientData(context)};
}
