/**
 * M10 (D6) — native push enrollment for THIS installation of the app. v2 only. Imported by route handlers AND by the
 * Expo app, so this file stays dependency-free (zod and common.ts only, no server module, no 'server-only').
 *
 *   POST /api/mobile/v2/push/enrollment?employmentId {requestId, installationId, platform, token, permission, locale,
 *                                                     appVersion?, appBuild?}                       → PushEnrollmentResult
 *   POST /api/mobile/v2/push/revoke?employmentId     {requestId, installationId, reason}          → PushRevokeResult
 *   GET  /api/mobile/v2/push/status?installationId                                                → PushStatusV2
 *
 * THE BINDING IS (tenant, user, installation) — amending ADR-0088 §3. Tenant and user come from the bearer session,
 * never from the body; `installationId` is the app installation id the integrity enrollment already uses
 * (mobile/lib/submission-native.ts nativeIntegrityInstallationId). `employmentId` only selects the caller's own
 * employment as the command receipt's subject (core/mobile-command-receipt.ts); the binding does not depend on it.
 *
 * NOTHING PRIVATE TRAVELS IN A PUSH. A push carries a generic title and body and `{notificationId}`; the app resolves
 * that id through POST /api/mobile/v2/notifications/read and the server's destination allowlist after unlock.
 * The token is accepted here and never answered back: no response (and so no replayed command receipt) carries it.
 */
import { z } from 'zod';
import { commandOf, refusalOf } from './common';

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const PushPlatform = z.enum(PUSH_PLATFORMS);
export type PushPlatform = z.infer<typeof PushPlatform>;
export const PushProvider = z.enum(['apns', 'fcm']);
export type PushProvider = z.infer<typeof PushProvider>;
/** The provider a platform uses. Fixed: iOS is APNs and Android is FCM, both direct (D6). */
export const PROVIDER_OF: Readonly<Record<PushPlatform, PushProvider>> = { ios: 'apns', android: 'fcm' };

/** An APNs device token is hex; an FCM registration token is URL-safe text. Both bounded (the table CHECK agrees). */
export const PUSH_TOKEN_MAX = 1024;
export const PushToken = z.string().min(16).max(PUSH_TOKEN_MAX).regex(/^[A-Za-z0-9_:.-]+$/);
const APNS_TOKEN = /^[0-9a-fA-F]{32,200}$/;
/** The OS notification permission as the app read it just before enrolling. Only granted/provisional enroll. */
export const PushPermission = z.enum(['granted', 'provisional', 'denied', 'undetermined']);
export type PushPermission = z.infer<typeof PushPermission>;
/** The language a generic push is written in (the app's own two catalogues). */
export const PushLocale = z.enum(['en', 'ms']);
export type PushLocale = z.infer<typeof PushLocale>;
const appVersion = z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/);

export const PushEnrollmentCommand = commandOf({
  installationId: z.string().uuid(),
  platform: PushPlatform,
  token: PushToken,
  permission: PushPermission,
  locale: PushLocale,
  appVersion: appVersion.nullable().optional(),
  appBuild: appVersion.nullable().optional(),
}).refine((c) => c.platform !== 'ios' || APNS_TOKEN.test(c.token), { message: 'Invalid APNs token', path: ['token'] });
export type PushEnrollmentCommand = z.infer<typeof PushEnrollmentCommand>;

/** Whether this server can deliver to the caller's provider now (keys configured). Never says which key or why. */
export const PushDelivery = z.enum(['available', 'unavailable']);
export type PushDelivery = z.infer<typeof PushDelivery>;

/**
 * Refusals:
 *   notifications_off       the Notifications module is off for the tenant: nothing is enrolled;
 *   permission_not_granted  the app reported the OS permission as denied or undetermined: nothing is enrolled
 *                           (the app revokes instead, with reason `permission_denied`);
 *   request_conflict        the requestId already recorded a different command.
 */
export const PUSH_COMMAND_REFUSALS = ['notifications_off', 'permission_not_granted', 'request_conflict'] as const;
export const PushCommandRefusal = refusalOf(PUSH_COMMAND_REFUSALS);
export type PushCommandRefusal = z.infer<typeof PushCommandRefusal>;

export const PushEnrollmentResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('registered'),
    platform: PushPlatform,
    provider: PushProvider,
    /** `rotated`: this installation's previous token was replaced; `unchanged`: the same token was already bound. */
    change: z.enum(['created', 'rotated', 'unchanged']),
    delivery: PushDelivery,
  }),
  PushCommandRefusal,
]);
export type PushEnrollmentResult = z.infer<typeof PushEnrollmentResult>;

/** Why the app stops push on this installation. Recorded as the registration's revoke reason. */
export const PUSH_REVOKE_REASONS = ['logout', 'turned_off', 'company_switch', 'permission_denied'] as const;
export const PushRevokeReason = z.enum(PUSH_REVOKE_REASONS);
export type PushRevokeReason = z.infer<typeof PushRevokeReason>;
export const PushRevokeCommand = commandOf({ installationId: z.string().uuid(), reason: PushRevokeReason });
export type PushRevokeCommand = z.infer<typeof PushRevokeCommand>;
/** `revoked: false` — this installation had no active binding for the caller (idempotent; not a refusal). */
export const PushRevokeResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('revoked'), revoked: z.boolean() }),
  PushCommandRefusal,
]);
export type PushRevokeResult = z.infer<typeof PushRevokeResult>;

/** The caller's own binding for one installation. `registered: false` covers "never", "revoked" and "someone else's". */
export const PushStatusV2 = z.object({
  enabled: z.boolean(),
  registered: z.boolean(),
  platform: PushPlatform.nullable(),
  updatedAt: z.string().max(40).nullable(),
  /** Per platform, so the app can say honestly that this server does not send pushes yet. */
  delivery: z.object({ ios: PushDelivery, android: PushDelivery }),
});
export type PushStatusV2 = z.infer<typeof PushStatusV2>;
