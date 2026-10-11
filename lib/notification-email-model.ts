import { z } from 'zod';

/** Categories describe the existing event registry; they do not decide recipients. */
export const notificationEmailCategories = [
  'attendance', 'claims', 'delegation', 'leave', 'notice', 'offboarding', 'payroll',
  'performance', 'profile', 'readiness', 'review', 'rewards', 'toil',
] as const;
export type NotificationEmailCategory = typeof notificationEmailCategories[number];
export const notificationEmailCategory = z.enum(notificationEmailCategories);
export const notificationEmailLocales = ['en', 'ms', 'zh', 'vi', 'ta', 'th'] as const;
export type NotificationEmailLocale = typeof notificationEmailLocales[number];
export const notificationEmailRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }).strict(),
  // No caller-controlled address, content, SMTP configuration or origin crosses this boundary.
  z.object({ op: z.literal('send'), deliveryId: z.uuid(), leaseToken: z.uuid() }).strict(),
]);
export type NotificationEmailRequest = z.infer<typeof notificationEmailRequest>;
export type NotificationEmailStatus = { version: 1; ready: boolean };
export type NotificationEmailOutcome = 'sent' | 'retry' | 'failed' | 'skipped' | 'uncertain';
export const notificationEmailErrors = [
  'relayUnavailable', 'recipientUnavailable', 'recipientChanged', 'notEligible',
  'smtpTemporary', 'smtpRejected', 'smtpAuthentication', 'smtpTls', 'uncertain',
] as const;
export type NotificationEmailError = typeof notificationEmailErrors[number];

/** A deployment origin and a relative application path, never an event-supplied external URL. */
export function notificationEmailLink(origin: string, path: string | null): string {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('Invalid notification origin');
  if (!path || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(path) || path.length > 1500)
    throw new Error('Invalid notification path');
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('Invalid notification path');
  return url.href;
}

/** Only explicit SMTP rejection proves non-delivery after send begins. Unknown acknowledgement is held. */
export function notificationSmtpFailure(error: unknown): { outcome: NotificationEmailOutcome; error: NotificationEmailError } {
  const e = error as { code?: string; responseCode?: number } | null;
  if (e?.code === 'EAUTH') return { outcome: 'failed', error: 'smtpAuthentication' };
  if (e?.code === 'ETLS' || e?.code === 'CERT_HAS_EXPIRED' || e?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
    return { outcome: 'failed', error: 'smtpTls' };
  if (e?.responseCode && e.responseCode >= 400 && e.responseCode < 500)
    return { outcome: 'retry', error: 'smtpTemporary' };
  if (e?.responseCode && e.responseCode >= 500 && e.responseCode < 600)
    return { outcome: 'failed', error: 'smtpRejected' };
  return { outcome: 'uncertain', error: 'uncertain' };
}
