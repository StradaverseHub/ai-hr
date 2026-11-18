import { z } from 'zod';

/** Shared with the existing Employee Master delivery contract; bytes, never a path or URL. */
export const XLSX_EMAIL_ATTACHMENT_MAX_BYTES=20_000_000;
export const XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
export const XLSX_EMAIL_ATTACHMENT_FILENAME=/^[-a-zA-Z0-9_.]{1,150}\.xlsx$/;
export const xlsxEmailAttachment=z.object({
  bytes:z.instanceof(Uint8Array).refine(bytes=>bytes.byteLength>0&&bytes.byteLength<=XLSX_EMAIL_ATTACHMENT_MAX_BYTES),
  filename:z.string().max(150).regex(XLSX_EMAIL_ATTACHMENT_FILENAME)
    .refine(value=>!value.includes('\r')&&!value.includes('\n')),
  contentType:z.literal(XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE),
}).strict();
export type XlsxEmailAttachment=z.infer<typeof xlsxEmailAttachment>;
