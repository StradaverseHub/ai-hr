import { z } from 'zod';
/** Private delivery receives validated bytes. It never accepts a filesystem path or remote URL. */
export const MANAGED_EMAIL_ATTACHMENT_MAX_BYTES = 20_000_000;
export const MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT = 20;
export const managedEmailAttachment = z.object({
  bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= MANAGED_EMAIL_ATTACHMENT_MAX_BYTES),
  filename: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f/\\:]+$/u),
  contentType: z.enum(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv']),
}).strict();
export type ManagedEmailAttachment = z.infer<typeof managedEmailAttachment>;
export const managedEmailSenderProfiles = ['onboarding', 'hr', 'noreply'] as const;
export const managedEmailSenderNames = { onboarding: 'HR Onboarding', hr: 'Human Resource Department', noreply: 'Kingdee AI HR' } as const;
