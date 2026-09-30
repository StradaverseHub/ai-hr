// Security (assessment 2026-09, finding H3). Stored attachments (leave/feedback/performance/
// resignation/attendance/KB/review) carry the uploader's CLIENT-declared MIME type and untrusted bytes.
// Serving them `Content-Disposition: inline` with that MIME lets an uploaded text/html or SVG file
// execute script in the app origin under the viewer's session (stored XSS). This module centralises the
// one safe rule so every serve route agrees:
//   - only a small image/PDF allowlist may render inline; everything else is forced to download;
//   - always send X-Content-Type-Options: nosniff so the browser cannot re-sniff a spoofed type.
// The upload side should additionally verify magic bytes (see the personnel-document / claims routes).
export const INLINE_SAFE = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** inline only for the allowlisted, non-scriptable types AND only when the caller asked (?inline=1). */
export function inlineDisposition(req: Request, mimeType: string | null | undefined): 'inline' | 'attachment' {
  const wantsInline = new URL(req.url).searchParams.get('inline') === '1';
  return wantsInline && INLINE_SAFE.has(mimeType ?? '') ? 'inline' : 'attachment';
}
