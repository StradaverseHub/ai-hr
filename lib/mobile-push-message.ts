/**
 * M10 (D6) — the ONLY words a push carries, and the transport port every provider implements. Dependency-free.
 *
 * A push is a doorbell, not a letter (ADR-0088 §3, Apple 4.5.4): the same generic title and body for every
 * notification, in the language the installation enrolled with, plus the notification's id. Never the stored title or
 * body, a name, an amount, a date, a leave type, a reason or a link. The app reads the real text over the authenticated
 * API after unlock. test/mobile-v2-push.test.ts pins that no stored notification text reaches a transport.
 */
export type PushLocale = 'en' | 'ms';
export const PUSH_TITLE = 'AI HR';
export const PUSH_BODY: Readonly<Record<PushLocale, string>> = {
  en: 'You have a new update. Open AI HR to see it.',
  ms: 'Anda ada kemas kini baharu. Buka AI HR untuk melihatnya.',
};
/** The Android channel a push is posted to; the app creates it with private lock-screen visibility. */
export const PUSH_ANDROID_CHANNEL = 'aihr-updates';
/** A provider deadline for a stale doorbell (seconds). The inbox keeps the notification either way. */
export const PUSH_EXPIRY_SECONDS = 3600;

export type PushMessage = { token: string; title: string; body: string; notificationId: string };
export type PushSendOutcome = {
  outcome: 'sent' | 'invalid_token' | 'failed';
  /** HTTP status from the provider, or null when no response arrived. */
  status: number | null;
  /** A provider's short code (BadDeviceToken, UNREGISTERED, transport_error), never free text. */
  reason: string | null;
};
export interface PushTransport {
  send(message: PushMessage): Promise<PushSendOutcome>;
  close(): void;
}
export type PushTransports = { apns?: PushTransport; fcm?: PushTransport };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The generic message for one notification. The id is the only per-notification value. */
export function genericPushMessage(locale: PushLocale, token: string, notificationId: string): PushMessage {
  if (!UUID.test(notificationId)) throw new Error('Invalid notification reference');
  return { token, title: PUSH_TITLE, body: PUSH_BODY[locale] ?? PUSH_BODY.en, notificationId: notificationId.toLowerCase() };
}

/** Keep a provider code storable (the delivery table's CHECK): letters and underscores, ≤ 64. */
export function safeProviderReason(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z_]{1,64}$/.test(value) ? value : null;
}
