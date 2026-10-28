/** Offline clock sync transport v1 (ADR-0088): wire shapes only, shared with the native client, so no Node API here.
 * A capability, a signed context, a closure or a receipt never authorizes attendance by itself; the issuance, claim and
 * close services and the deterministic adjudicator decide. Byte bounds are engineering admission limits, enforced on
 * the stream before parsing (lib/mobile-api/body.ts), not HR policy. Routes (all bearer-session, ?employmentId=):
 *   GET  /api/mobile/v2/integrity/{ios|android}/offline/capabilities  -> OfflineCapabilitiesResult
 *   POST /api/mobile/v2/integrity/{ios|android}/offline/context       JSON OfflineContextIssueRequest -> OfflineContextResult
 *        (re-posting the same request is the refresh: the exact original signed bytes come back)
 *   POST /api/mobile/v2/integrity/{ios|android}/offline/context/close JSON OfflineContextCloseRequest -> OfflineCloseResult
 *   POST /api/mobile/v2/integrity/{ios|android}/offline/claim         multipart `claim` (+ `photo`; Android `playIntegrityToken`,
 *        `syncBuildVersion`) -> OfflineClaimResult
 * Upload order (iPhone and Android alike): send claim N+1 only after claim N has a terminal receipt. The original App
 * Attest counter / chain digest of each claim is verified and advanced inside consumption; a later claim sent first is
 * refused (chain_conflict) with nothing consumed. No offline endpoint takes a fresh iPhone transport assertion. */
import {z} from 'zod';
import {AppleEnrollmentSettings} from './mobile-key-enrollment';
import {AndroidClockOpaqueToken} from './mobile-android-clock-policy';
import {OfflineClockContextIssuer,OfflineClockContextRequest,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,OFFLINE_CLOCK_MAX_WINDOW_MS} from './mobile-offline-context';
import {OfflineClockSignedClaim,OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from './mobile-offline-clock';
import {OfflineClockReceipt} from './mobile-offline-receipt';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const instant=z.number().int().positive().max(8640000000000000);
/** UTF-8 bytes. claimFormBytes bounds the whole multipart body (claim + photo + token + framing). */
export const OFFLINE_SYNC_LIMITS={contextBytes:1024,closeBytes:1024,claimBytes:16384,photoBytes:2097152,claimFormBytes:3145728} as const;
/** Context issue/refresh body. The employment is the ?employmentId= selector, never a body field. */
export const OfflineContextIssueRequest=OfflineClockContextRequest;
export const OfflineContextCloseRequest=z.object({contextId:uuid,closeRequestId:uuid,consumedThrough:z.number().int().min(0).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT)}).strict();
/** The `claim` multipart field. Parse with safeParse: the claim service's own parse throws. */
export const OfflineClaimUpload=OfflineClockSignedClaim;
/** Android multipart fields. The token is opaque; the version is the uploading build's Play versionCode (decimal int64). */
export const OfflineSyncPlayToken=AndroidClockOpaqueToken;
export const OfflineSyncBuildVersion=z.string().max(19).regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=BigInt('9223372036854775807'));
/** Sync-time Play outcome reasons. They describe the UPLOAD environment, never the capture-time build, device or location. */
export const OfflineSyncIntegrityRefusal=z.enum(['token_missing','invalid_input','invalid_token','request_mismatch','stale_token','app_mismatch','version_mismatch',
 'unrecognized_app','unlicensed_app','device_integrity']);
export const OfflineSyncIntegrityUnavailable=z.enum(['configuration_unavailable','provider_unavailable','not_evaluated','licensing_unavailable','unknown_vendor_verdict','time_unavailable']);
/** Stable refusal codes, one per service reason (core/mobile-offline-context.ts, core/mobile-offline-claim.ts). A refusal
 * carries no receipt and changes nothing; only `processed` receipts are terminal claim outcomes. */
export const OfflineRefused=z.object({outcome:z.literal('refused'),code:z.enum([
 'subject_unavailable','invalid_request','invalid_claim','offline_disabled','device_required','offline_pending','online_pending','key_unavailable',
 'binding_conflict','context_closed','context_unavailable','claims_pending','cursor_mismatch','scope_unavailable','chain_conflict','invalid_proof',
 'attachment_mismatch','time_unavailable','sync_integrity']),integrityReason:OfflineSyncIntegrityRefusal.optional()});
export const OfflineUnavailable=z.object({outcome:z.literal('unavailable'),code:z.enum(['not_configured','configuration_unavailable','module_unavailable','draining','proof_unavailable']),
 integrityReason:OfflineSyncIntegrityUnavailable.optional()});
const result=<S extends z.ZodType>(success:S)=>z.union([success,OfflineRefused,OfflineUnavailable]);
/** enabled: new issuance is open (deployment active). false while draining: close and claim upload stay available.
 * issuers: the deployment's trusted context-signing registry (public keys), for verifying signed contexts.
 * companyId: the selected employment's own company (the same owner the deployment lookup used), which the phone
 * binds into the context request scope; additive, a scope fact the session can already read, never an authorization. */
export const OfflineCapabilitiesResult=result(z.object({outcome:z.literal('offline'),enabled:z.boolean(),apiOrigin:AppleEnrollmentSettings.shape.apiOrigin,companyId:uuid,
 issuers:z.array(OfflineClockContextIssuer).min(1).max(16),windowMs:z.number().int().min(60000).max(OFFLINE_CLOCK_MAX_WINDOW_MS),permitCount:z.number().int().min(1).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT)}));
/** context: the exact signed envelope JSON (OfflineClockContextEnvelope); verify it against `issuers` before use. */
export const OfflineContextResult=result(z.object({outcome:z.literal('issued'),context:z.string().min(2).max(OFFLINE_CLOCK_CONTEXT_MAX_BYTES),contextId:uuid,authorization:z.literal('not_granted')}));
export const OfflineCloseResult=result(z.object({outcome:z.literal('closed'),contextId:uuid,reason:z.enum(['exhausted','retired','revoked']),closeRequestId:uuid,
 consumedThrough:z.number().int().min(0).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT),closedAt:instant}));
/** A processed receipt is terminal (accepted, needs_review or refused); an exact retry returns it without photo or token. */
export const OfflineClaimResult=result(z.object({outcome:z.literal('processed'),receipt:OfflineClockReceipt}));
