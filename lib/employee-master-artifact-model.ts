/** Client-safe fingerprint contract. It never carries a file path or workbook bytes. */
import {z} from 'zod';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE,XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from './email-attachment';
export const masterArtifactFingerprint=z.object({
  sha256:z.string().regex(/^[a-f0-9]{64}$/),
  byteLength:z.number().int().min(1).max(XLSX_EMAIL_ATTACHMENT_MAX_BYTES),
  contentType:z.literal(XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE),
}).strict();
export type MasterArtifactFingerprint=z.infer<typeof masterArtifactFingerprint>;
export const masterArtifactAuthorization=z.object({
  ok:z.literal(true),accessStamp:z.string().regex(/^[a-f0-9]{64}$/),artifact:masterArtifactFingerprint,
}).strict();
export type MasterArtifactAuthorization=Omit<z.infer<typeof masterArtifactAuthorization>,'ok'>;
