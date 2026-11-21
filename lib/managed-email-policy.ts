/** Shared raw-byte and file-count policy for planning and the private SMTP boundary. */
export const MANAGED_EMAIL_ATTACHMENT_MAX_BYTES = 20_000_000;
export const MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT = 20;

/** On/Off Boarding mail has one sender. The internal key stays 'noreply' because queued payloads,
 * the capture trigger and receipts already accept it; no product display name is hard-coded here.
 * The display name is the tenant's own setting, owned by the installation email operator. */
export const managedEmailSenderProfiles = ['noreply'] as const;
export type ManagedEmailSenderProfile = typeof managedEmailSenderProfiles[number];
/** Read-only: earlier payloads and bindings may still carry these keys. They are normalised, never offered. */
export const legacyManagedEmailSenderProfiles = ['onboarding', 'hr'] as const;
export type LegacyManagedEmailSenderProfile = typeof legacyManagedEmailSenderProfiles[number];
export function normaliseManagedEmailSender(value: unknown): ManagedEmailSenderProfile | null {
  return value === 'noreply' || (legacyManagedEmailSenderProfiles as readonly unknown[]).includes(value) ? 'noreply' : null;
}
/** A display name only: no address syntax, so a name can never look like another mailbox. */
export function validManagedEmailSenderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 160 && !/[\x00-\x1f\x7f@<>"]/.test(name) ? name : null;
}
