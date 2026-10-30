import { z } from 'zod';
/** Private delivery receives validated bytes. It never accepts a filesystem path or remote URL. */
import { MANAGED_EMAIL_ATTACHMENT_MAX_BYTES } from './managed-email-policy';
export { MANAGED_EMAIL_ATTACHMENT_MAX_BYTES, MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT } from './managed-email-policy';
export const managedEmailAttachment = z.object({
  bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= MANAGED_EMAIL_ATTACHMENT_MAX_BYTES),
  filename: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f/\\:]+$/u),
  cid: z.string().regex(/^v9-image\.[0-9a-f-]{36}@aihr$/).optional(),
  contentType: z.enum(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv']),
}).strict().superRefine((file, context) => { if (file.cid && !file.contentType.startsWith('image/')) context.addIssue({ code: 'custom', message: 'Only an image can be embedded inline.' }); });
export type ManagedEmailAttachment = z.infer<typeof managedEmailAttachment>;
export { managedEmailSenderProfiles, managedEmailSenderNames } from './managed-email-policy';
