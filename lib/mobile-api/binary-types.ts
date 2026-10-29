/**
 * The file types a mobile binary route may send, each with its signature and its file-name extensions. Shared by
 * lib/mobile-api/handler.ts (the send-time check every binary route passes) and the owners that pre-check a stored
 * file before offering it (core/mobile-approvals.ts), so the two can never disagree. Dependency-free.
 *
 * PDF is the default for every binary route (payslip, EA). JPEG and PNG exist for ONE route only — the approver's
 * view of a leave request's supporting document (GET /api/mobile/v2/tasks/leave/{id}/document) — because those
 * are the image types the leave attachment owner names (core/leave.ts DOC_MIME_LABELS: PDF, JPG, PNG). A route
 * opts in by naming them; nothing widens by default.
 */
export const MOBILE_BINARY_TYPES = ['application/pdf'] as const;
export const MOBILE_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type MobileBinaryType = (typeof MOBILE_ATTACHMENT_TYPES)[number];

const MAGIC: Record<MobileBinaryType, readonly number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};
const EXTENSIONS: Record<MobileBinaryType, readonly string[]> = {
  'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'],
};

export function isMobileBinaryType(value: string, allowed: readonly string[] = MOBILE_BINARY_TYPES): value is MobileBinaryType {
  return allowed.includes(value) && Object.hasOwn(MAGIC, value);
}
/** The bytes start with the type's signature. */
export function hasMobileBinarySignature(type: MobileBinaryType, bytes: Uint8Array): boolean {
  const magic = MAGIC[type];
  return bytes.byteLength >= magic.length && magic.every((b, i) => bytes[i] === b);
}
/** A header-safe name with the type's own extension, else `document.<ext>`. */
export function safeMobileFileName(type: MobileBinaryType, name: string): string {
  const exts = EXTENSIONS[type];
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && exts.some((e) => name.toLowerCase().endsWith(e)) ? name : `document${exts[0]}`;
}
