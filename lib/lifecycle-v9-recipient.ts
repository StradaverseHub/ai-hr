import { z } from 'zod';
const address = z.email().max(254).regex(/^[\x21-\x7e]+$/);
/** A selected business mailbox is a delivery destination, never an application principal. */
export function v9LiteralAddress(key: string): string | null {
  if (!key.startsWith('address:')) return null;
  const email = key.slice(8);
  return address.safeParse(email).success ? email : null;
}
export function v9AddressRole(email: string): `address:${string}` | null {
  const value = email.trim(), key = `address:${value}` as const;
  return v9LiteralAddress(key) ? key : null;
}
