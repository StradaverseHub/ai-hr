/** The one canonical e-mail address rule the SMTP boundary enforces for managed delivery (lib/internal-auth/smtp.ts): a plain address,
 * at most 320 printable ASCII characters, no display name. Callers that freeze an address for later delivery validate with the same
 * schema, so nothing they accept is refused by the transport. Client-safe (zod only). */
import { z } from 'zod';

export const canonicalEmailAddress = z.email().max(320).regex(/^[\x21-\x7e]+$/);
export function isCanonicalEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && canonicalEmailAddress.safeParse(value).success;
}
