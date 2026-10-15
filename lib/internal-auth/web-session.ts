import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { INTERNAL_SESSION_COOKIE } from './config';
import { readSession, revokeSession } from './service';
import { safeReturnTo } from '../identity/config';
export const internalCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
export async function currentInternalIdentity() {
  const value = await readSession((await cookies()).get(INTERNAL_SESSION_COOKIE)?.value);
  return value ? { subject: value.subject, issuer: value.issuer, email: value.email, emailVerified: value.emailVerified } : null;
}
export async function endInternalSession(returnTo?: string): Promise<never> {
  const store = await cookies(), raw = store.get(INTERNAL_SESSION_COOKIE)?.value;
  store.set(INTERNAL_SESSION_COOKIE, '', { ...internalCookieOptions, maxAge: 0 });
  try { await revokeSession(raw); } catch { console.error('Internal logout could not revoke server storage; browser cookie cleared.'); }
  redirect(returnTo ? safeReturnTo(returnTo) : '/login?signedOut=1');
}
