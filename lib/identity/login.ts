import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { client } from '../../db/client';
import { recordLoginBlocked, recordLoginSucceeded } from '../../core/auth';
import { keycloakConfig, LOGIN_COOKIE, safeReturnTo, WEB_SESSION_COOKIE } from './config';
import { oidc, oidcClient, verifyKeycloakAccessToken } from './oidc';
import { seal, unseal } from './seal';
import { cookieOptions, createIdentitySession, deleteIdentitySession } from './session';

export async function startKeycloakLogin(request: NextRequest) {
  const config = keycloakConfig();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const destination = oidc.buildAuthorizationUrl(await oidcClient(), {
    redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
  });
  const response = NextResponse.redirect(destination);
  response.cookies.set(LOGIN_COOKIE, await seal({ verifier, state, nonce, returnTo }, 'login', Math.floor(Date.now() / 1000) + 600), { ...cookieOptions, maxAge: 600 });
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}
export async function completeKeycloakLogin(request: NextRequest) {
  let response: NextResponse;
  try {
    const config = keycloakConfig();
    const transaction = await unseal(request.cookies.get(LOGIN_COOKIE)?.value ?? '', 'login');
    for (const key of ['state', 'nonce', 'verifier', 'returnTo']) if (typeof transaction[key] !== 'string') throw new Error('Invalid login transaction.');
    // Never use an untrusted Host / forwarded origin to construct the OAuth callback.
    const currentUrl = new URL(request.nextUrl.search, config.redirectUri);
    const tokens = await oidc.authorizationCodeGrant(await oidcClient(), currentUrl, {
      pkceCodeVerifier: transaction.verifier as string, expectedState: transaction.state as string,
      expectedNonce: transaction.nonce as string, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || !tokens.refresh_token || !tokens.id_token) throw new Error('Incomplete identity response.');
    const verified = await verifyKeycloakAccessToken(tokens.access_token);
    if (verified.subject !== claims.sub) throw new Error('Identity response mismatch.');
    const raw = await createIdentitySession({ ...verified, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      idToken: tokens.id_token, accessExpiry: verified.expiresAt,
      email: typeof claims.email === 'string' ? claims.email : null, emailVerified: claims.email_verified === true });
    await deleteIdentitySession(request.cookies.get(WEB_SESSION_COOKIE)?.value);
    const [principal] = await client<{ app_user_id: string; tenant_id: string }[]>`select * from app.principal_by_identity(${verified.issuer},${verified.subject})`;
    try {
      if (principal) await recordLoginSucceeded({ userId: principal.app_user_id, tenantId: principal.tenant_id });
      else await recordLoginBlocked({ subject: `${verified.issuer}#${verified.subject}` });
    } catch { /* Audit transport failure does not change the identity authorization result. */ }
    response = NextResponse.redirect(new URL(safeReturnTo(transaction.returnTo as string), config.origin));
    response.cookies.set(WEB_SESSION_COOKIE, raw, { ...cookieOptions, maxAge: 8 * 3600 });
  } catch {
    const t = await getTranslations('auth');
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    response = new NextResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(t('callbackFailedTitle'))}</title></head><body><h1>${escape(t('callbackFailedTitle'))}</h1><p>${escape(t('callbackFailedBody'))}</p><a href="/login">${escape(t('callbackRetry'))}</a></body></html>`, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  response.cookies.set(LOGIN_COOKIE, '', { ...cookieOptions, maxAge: 0 });
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}
