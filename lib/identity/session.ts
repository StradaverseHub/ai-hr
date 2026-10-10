import { randomBytes, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { client } from '../../db/client';
import { AuthRequiredError } from '../auth-errors';
import { JwksUnavailableError } from '../mobile-api/jwt';
import { keycloakConfig, WEB_SESSION_COOKIE } from './config';
import { oidc, oidcClient, verifyKeycloakAccessToken } from './oidc';
import { seal, unseal } from './seal';

export const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
export type IdentitySession = {
  subject: string; issuer: string; email: string | null; emailVerified: boolean;
  accessToken: string; refreshToken: string; idToken: string; accessExpiry: number;
};
export function sessionHash(raw: string): string | null {
  return /^[A-Za-z0-9_-]{43}$/.test(raw) ? createHash('sha256').update(raw).digest('hex') : null;
}
function sessionValue(value: Record<string, unknown>): IdentitySession {
  const strings = ['subject', 'issuer', 'accessToken', 'refreshToken', 'idToken'];
  if (strings.some(k => typeof value[k] !== 'string' || !value[k]) || typeof value.accessExpiry !== 'number' ||
      !Number.isFinite(value.accessExpiry) || typeof value.emailVerified !== 'boolean' ||
      !(value.email === null || typeof value.email === 'string')) throw new AuthRequiredError('Invalid session.');
  return value as IdentitySession;
}
export async function createIdentitySession(value: IdentitySession) {
  const raw = randomBytes(32).toString('base64url');
  const hash = sessionHash(raw)!;
  const expiry = Math.floor(Date.now() / 1000) + 8 * 3600;
  await client`select app.identity_session_write(${hash},${await seal(value, `session:${hash}`, expiry)},${new Date(expiry * 1000)}::timestamptz)`;
  return raw;
}
/** The row lock serializes refresh-token rotation across requests and processes. Absolute lifetime never slides. */
export async function readIdentitySession(raw: string | undefined, refresh = true): Promise<IdentitySession | null> {
  const hash = raw && sessionHash(raw);
  if (!hash) return null;
  const result = await client.begin(async tx => {
    const [row] = await tx<{ sealed: string; expires_at: Date }[]>`select * from app.identity_session_read(${hash},true)`;
    if (!row) return null;
    let value: IdentitySession;
    try { value = sessionValue(await unseal(row.sealed, `session:${hash}`)); }
    catch { await tx`select app.identity_session_delete(${hash})`; return null; }
    if (!refresh) return value;
    if (value.accessExpiry <= Date.now() / 1000 + 60) {
      try {
        const tokens = await oidc.refreshTokenGrant(await oidcClient(), value.refreshToken);
        const verified = await verifyKeycloakAccessToken(tokens.access_token);
        if (verified.subject !== value.subject || verified.issuer !== value.issuer) throw new AuthRequiredError('Session identity changed.');
        value = { ...value, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? value.refreshToken,
          idToken: tokens.id_token ?? value.idToken, accessExpiry: verified.expiresAt };
        const expiry = Math.floor(new Date(row.expires_at).getTime() / 1000);
        await tx`select app.identity_session_write(${hash},${await seal(value, `session:${hash}`, expiry)},${row.expires_at})`;
      } catch (error) {
        if (error instanceof AuthRequiredError || (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant')) {
          await tx`select app.identity_session_delete(${hash})`; return null;
        }
        throw new JwksUnavailableError('Identity provider unavailable.');
      }
    }
    const verified = await verifyKeycloakAccessToken(value.accessToken);
    if (verified.subject !== value.subject || verified.issuer !== value.issuer) return null;
    return value;
  });
  return result as IdentitySession | null;
}
export async function currentIdentitySession() {
  return readIdentitySession((await cookies()).get(WEB_SESSION_COOKIE)?.value);
}
export async function deleteIdentitySession(raw: string | undefined) {
  const hash = raw && sessionHash(raw);
  if (hash) await client`select app.identity_session_delete(${hash})`;
}
export async function endIdentitySession(): Promise<never> {
  const store = await cookies();
  const raw = store.get(WEB_SESSION_COOKIE)?.value;
  const session = await readIdentitySession(raw, false);
  await deleteIdentitySession(raw);
  store.set(WEB_SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 });
  let destination = `${keycloakConfig().origin}/login`;
  if (session) {
    const config = keycloakConfig();
    // Local revocation is already committed. Provider downtime must not prevent local logout.
    try {
      const provider = await oidcClient();
      await oidc.tokenRevocation(provider, session.refreshToken, { token_type_hint: 'refresh_token' });
      destination = oidc.buildEndSessionUrl(provider, { id_token_hint: session.idToken,
        post_logout_redirect_uri: `${config.origin}/login`, client_id: config.webClientId }).href;
    } catch { /* Login credentials have already been removed from this browser and server. */ }
  }
  redirect(destination);
}
