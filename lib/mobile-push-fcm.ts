/**
 * M10 (D6) — direct FCM delivery through the HTTP v1 API with a service-account OAuth token. Node built-ins only
 * (node:crypto and fetch); no Google SDK. No 'server-only': the cron script imports this.
 *
 *   OAuth      RS256 JWT {iss: client_email, scope: firebase.messaging, aud: token URL, iat, exp: iat+3600} exchanged
 *              at https://oauth2.googleapis.com/token (jwt-bearer grant); the access token is reused until 60 s before
 *              it expires, within this process only.
 *   send       POST https://fcm.googleapis.com/v1/projects/{project}/messages:send
 *              {message:{token, notification:{title, body}, data:{notificationId},
 *                        android:{priority:'HIGH', ttl:'3600s', notification:{channel_id, visibility:'PRIVATE'}}}}
 *
 * Outcomes. 200 sent. errorCode UNREGISTERED (404), and INVALID_ARGUMENT whose field violation names `message.token`,
 * are `invalid_token`: the sweep revokes the binding. SENDER_ID_MISMATCH is `failed` — it means the token belongs to
 * another Firebase project, i.e. OUR configuration, and revoking on it would empty every registration after one wrong
 * project id. A 401 drops the cached access token.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readBoundedBody } from './bounded-body';
import { PUSH_ANDROID_CHANNEL, PUSH_EXPIRY_SECONDS, safeProviderReason, type PushMessage, type PushSendOutcome, type PushTransport } from './mobile-push-message';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export type FcmConfig = { projectId: string; clientEmail: string; privateKey: string };
const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const EMAIL = /^[^\s@]{1,200}@[A-Za-z0-9.-]{1,120}\.gserviceaccount\.com$/;
const ACCESS = /^[A-Za-z0-9._~+/-]+=*$/;

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** A configuration this module can use (RSA ≥ 2048 key, a service-account email, a project id), or null. */
export function validFcmConfig(config: FcmConfig | null | undefined): (FcmConfig & { key: KeyObject }) | null {
  if (!config || !PROJECT_ID.test(config.projectId) || !EMAIL.test(config.clientEmail)) return null;
  try {
    const key = createPrivateKey(config.privateKey), bits = key.asymmetricKeyDetails?.modulusLength;
    return key.asymmetricKeyType === 'rsa' && bits && bits >= 2048 && bits <= 8192 ? { ...config, key } : null;
  } catch { return null; }
}

/** The jwt-bearer assertion. `iat` in whole seconds. */
export function fcmAssertion(clientEmail: string, key: KeyObject, iat: number): string {
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: clientEmail, scope: FCM_SCOPE, aud: FCM_TOKEN_URL, iat, exp: iat + 3600 }))}`;
  return `${input}.${sign('sha256', Buffer.from(input, 'utf8'), key).toString('base64url')}`;
}

/** The exact v1 message for one generic push. Exported for request-shaping tests. */
export function fcmMessage(message: PushMessage) {
  return {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: { notificationId: message.notificationId },
      android: { priority: 'HIGH', ttl: `${PUSH_EXPIRY_SECONDS}s`, notification: { channel_id: PUSH_ANDROID_CHANNEL, visibility: 'PRIVATE' } },
    },
  };
}

type FcmError = { error?: { code?: unknown; status?: unknown; details?: { '@type'?: unknown; errorCode?: unknown; fieldViolations?: { field?: unknown }[] }[] } };
/** Map an FCM answer to an outcome. Only the device's own fault revokes. */
export function fcmOutcome(status: number, text: string): PushSendOutcome {
  if (status === 200) return { outcome: 'sent', status, reason: null };
  let body: FcmError = {};
  try { body = JSON.parse(text) as FcmError; } catch { /* no code */ }
  const details = Array.isArray(body.error?.details) ? body.error!.details! : [];
  const errorCode = safeProviderReason(details.find((d) => typeof d?.errorCode === 'string')?.errorCode) ?? safeProviderReason(body.error?.status);
  const tokenField = details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field === 'message.token'));
  if (errorCode === 'UNREGISTERED') return { outcome: 'invalid_token', status, reason: 'UNREGISTERED' };
  if (errorCode === 'INVALID_ARGUMENT' && tokenField) return { outcome: 'invalid_token', status, reason: 'INVALID_ARGUMENT' };
  return { outcome: 'failed', status, reason: errorCode };
}

const textOf = async (response: Response) => new TextDecoder('utf-8', { fatal: false }).decode(await readBoundedBody(response, 16384, 10_000));

/** The FCM transport, or null when the configuration is unusable (push stays off for Android; never a crash). */
export function createFcmTransport(config: FcmConfig | null | undefined, ports: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): PushTransport | null {
  const valid = validFcmConfig(config);
  if (!valid) return null;
  const transport = ports.fetch ?? fetch, now = ports.now ?? Date.now, timeoutMs = ports.timeoutMs ?? 10_000;
  let access: { token: string; expiresAt: number } | null = null;
  const call = (url: string, init: RequestInit) => transport(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  async function accessToken(): Promise<string | null> {
    if (access && access.expiresAt - 60_000 > now()) return access.token;
    const iat = Math.floor(now() / 1000);
    const response = await call(FCM_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: fcmAssertion(valid!.clientEmail, valid!.key, iat) }).toString(),
    });
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return null; }
    const value = JSON.parse(await textOf(response)) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    if (typeof value.access_token !== 'string' || !ACCESS.test(value.access_token) || value.access_token.length > 4096) return null;
    const life = typeof value.expires_in === 'number' && value.expires_in > 0 && value.expires_in <= 3600 ? value.expires_in : 300;
    access = { token: value.access_token, expiresAt: now() + life * 1000 };
    return access.token;
  }
  return {
    async send(message) {
      try {
        const token = await accessToken();
        if (!token) return { outcome: 'failed', status: null, reason: 'oauth_unavailable' };
        const response = await call(`https://fcm.googleapis.com/v1/projects/${valid!.projectId}/messages:send`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(fcmMessage(message)),
        });
        let text = '';
        if (response.status === 200) void response.body?.cancel().catch(() => {});
        else text = await textOf(response).catch(() => '');
        if (response.status === 401) access = null;
        return fcmOutcome(response.status, text);
      } catch { return { outcome: 'failed', status: null, reason: 'transport_error' }; }
    },
    close() { access = null; },
  };
}
