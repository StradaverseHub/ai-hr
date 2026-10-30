/** Shared raw-byte and file-count policy for planning and the private SMTP boundary. */
export const MANAGED_EMAIL_ATTACHMENT_MAX_BYTES = 20_000_000;
export const MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT = 20;

export const managedEmailSenderProfiles = ['onboarding', 'hr', 'noreply'] as const;
export type ManagedEmailSenderProfile = typeof managedEmailSenderProfiles[number];
export const managedEmailSenderNames = { onboarding: 'HR Onboarding', hr: 'Human Resource Department', noreply: 'Kingdee AI HR' } as const;
