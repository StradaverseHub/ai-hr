import { NextRequest, NextResponse } from 'next/server';
import { toDataURL } from 'qrcode';
import { internalSelected, internalReady, internalConfig, INTERNAL_SESSION_COOKIE } from '@/lib/internal-auth/config';
import { AuthBusyError } from '@/lib/internal-auth/crypto';
import { InternalAuthError, startLogin, changeInitialPassword, verifyMfa, rotateRefresh, revokeSession, type AuthReply } from '@/lib/internal-auth/service';
import { requestRecovery, completeRecovery } from '@/lib/internal-auth/recovery';
import { startInvitation, acceptInternalInvitation } from '@/lib/internal-auth/invitations';
const responseHeaders = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new InternalAuthError('invalidChallenge');
  const reader = request.body?.getReader();
  if (!reader) throw new InternalAuthError('invalidChallenge');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength; if (size > 8192) { await reader.cancel(); throw new InternalAuthError('invalidChallenge'); }
    chunks.push(next.value);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InternalAuthError('invalidChallenge'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InternalAuthError('invalidChallenge');
  return value as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string, max = 256) {
  const value = body[key] ?? '';
  if (typeof value !== 'string' || value.length > max) throw new InternalAuthError('invalidChallenge');
  return value;
}
export async function POST(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  if (!internalSelected()) return NextResponse.json({ error: 'unavailable' }, { status: 404, headers: responseHeaders });
  if (!internalReady()) return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: responseHeaders });
  const { operation } = await context.params;
  const native = request.headers.get('x-aihr-client') === 'native';
  const origin = request.headers.get('origin');
  // Browser mutations require exact Origin. Native JSON requests never read or set browser cookies.
  if ((origin && origin !== internalConfig().origin) || (!native && origin !== internalConfig().origin))
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
  let result: AuthReply | { step: string };
  try {
    const body = await readBody(request);
    if (operation === 'login') result = await startLogin({ organization: text(body, 'organization', 64), username: text(body, 'username', 64), password: text(body, 'password', 128), native });
    else if (operation === 'password') result = await changeInitialPassword(text(body, 'challenge', 43), text(body, 'password', 128), native);
    else if (operation === 'mfa') result = await verifyMfa(text(body, 'challenge', 43), text(body, 'code', 64), native);
    else if (operation === 'refresh' && native) result = await rotateRefresh(text(body, 'refresh_token', 80));
    else if (operation === 'invite') result = await startInvitation(text(body, 'token', 43), text(body, 'username', 64), text(body, 'password', 128), native);
    else if (operation === 'accept-invite' && !native) {
      const identity = await (await import('@/lib/internal-auth/web-session')).currentInternalIdentity();
      if (!identity?.emailVerified) throw new InternalAuthError('invalidLogin');
      await acceptInternalInvitation(text(body, 'token', 43), identity);
      result = { step: 'complete' };
    } else if (operation === 'recovery') {
      await requestRecovery(text(body, 'organization', 64), text(body, 'username', 64));
      result = { step: 'sent' };
    } else if (operation === 'reset') {
      await completeRecovery(text(body, 'token', 43), text(body, 'password', 128), text(body, 'code', 64)); result = { step: 'resetDone' };
    } else if (operation === 'logout') {
      const bearer = /^Bearer (aihr_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') || '')?.[1];
      await revokeSession(native ? bearer : request.cookies.get(INTERNAL_SESSION_COOKIE)?.value, native, native ? text(body, 'refresh_token', 80) : undefined);
      result = { step: 'signedOut' };
    } else return NextResponse.json({ error: 'unavailable' }, { status: 404, headers: responseHeaders });
    const reply: Record<string, unknown> = { ...result };
    if (result.step === 'enroll' && 'secret' in result && result.secret) {
      const uri = `otpauth://totp/${encodeURIComponent(`AI HR:${result.account || ''}`)}?${new URLSearchParams({ secret: result.secret, issuer: 'AI HR', algorithm: 'SHA1', digits: '6', period: '30' })}`;
      reply.qr = await toDataURL(uri, { width: 224, margin: 2, errorCorrectionLevel: 'M' });
    }
    let browserToken: string | undefined;
    if (result.step === 'complete' && 'access_token' in result && !native) {
      browserToken = result.access_token;
      delete reply.access_token; delete reply.refresh_token; delete reply.expires_in;
    }
    const response = NextResponse.json(reply, { headers: responseHeaders });
    if (browserToken) response.cookies.set(INTERNAL_SESSION_COOKIE, browserToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 8 * 3600 });
    if (operation === 'logout' && !native) response.cookies.set(INTERNAL_SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  } catch (error) {
    const code = error instanceof InternalAuthError ? error.code : error instanceof AuthBusyError ? 'unavailable' : 'unavailable';
    if (!(error instanceof InternalAuthError) && !(error instanceof AuthBusyError)) console.error('Internal authentication operation unavailable.');
    const response = NextResponse.json({ error: code }, { status: code === 'rateLimited' ? 429 : code === 'unavailable' ? 503 : code === 'invalidLogin' ? 401 : 400,
      headers: { ...responseHeaders, ...(code === 'rateLimited' ? { 'retry-after': '900' } : {}) } });
    if (operation === 'logout' && !native) response.cookies.set(INTERNAL_SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  }
}
