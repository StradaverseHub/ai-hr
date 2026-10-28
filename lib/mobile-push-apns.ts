/**
 * M10 (D6) — direct APNs delivery: HTTP/2 with token-based (.p8) provider authentication. Node built-ins only
 * (node:http2, node:crypto, node:fs). No 'server-only': the cron script imports this.
 *
 *   provider token  ES256 JWT {alg:'ES256', kid:<key id>} . {iss:<team id>, iat:<seconds>}, signature as raw r||s
 *   request         POST {origin}/3/device/{token}; apns-topic = the app's bundle id; apns-push-type alert
 *   payload         {aps:{alert:{title, body}, sound:'default'}, body:{notificationId}} — generic only (mobile-push-message.ts);
 *                   expo-notifications reads a remote notification's data from the `body` key (its NotificationRecords)
 *
 * Outcomes. 200 sent. 410 Unregistered, and 400 BadDeviceToken, are `invalid_token`: the sweep revokes the binding.
 * BadDeviceToken is also what APNs answers when a sandbox token meets the production host (or the reverse), so
 * AIHR_PUSH_APNS_ENVIRONMENT must match the builds in use (deploy/DEPLOY.md). DeviceTokenNotForTopic and every other
 * answer are `failed` and revoke nothing: they describe our configuration, not the device. A 403 Expired/Invalid
 * provider token drops the cached JWT so the next send signs a fresh one.
 *
 * Apple asks that a provider token be refreshed no more than once every 20 minutes and no less than once an hour. A
 * cron sweep is a new process every run, so the token may be persisted between runs through `tokenCache`
 * (fileProviderTokenCache, AIHR_PUSH_APNS_TOKEN_CACHE); without it each run signs its own token.
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { PUSH_EXPIRY_SECONDS, safeProviderReason, type PushMessage, type PushSendOutcome, type PushTransport } from './mobile-push-message';

export type ApnsEnvironment = 'production' | 'development';
export type ApnsConfig = { keyId: string; teamId: string; privateKey: string; bundleId: string; environment: ApnsEnvironment };
export const APNS_ORIGIN: Readonly<Record<ApnsEnvironment, string>> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};
/** Reuse a signed provider token for 50 minutes (Apple: refresh between 20 and 60 minutes). */
export const APNS_TOKEN_REUSE_SECONDS = 50 * 60;
const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const DEVICE_TOKEN = /^[0-9a-fA-F]{32,200}$/;

export type ApnsRequest = { origin: string; path: string; headers: Record<string, string>; body: string };
export type ApnsResponse = { status: number; body: string };
/** The wire, injectable so no test contacts Apple. */
export type ApnsHttp = { request(request: ApnsRequest): Promise<ApnsResponse>; close(): void };
export type CachedProviderToken = { keyId: string; teamId: string; issuedAt: number; token: string };
export type ProviderTokenCache = { read(): CachedProviderToken | null; write(value: CachedProviderToken): void };

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** Parse and check the .p8 key: an EC P-256 private key, or null. */
export function apnsSigningKey(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch { return null; }
}

/** A configuration this module can use, or null (push off for iOS). Never throws, never logs the key. */
export function validApnsConfig(config: ApnsConfig | null | undefined): (ApnsConfig & { key: KeyObject }) | null {
  if (!config) return null;
  if (!APPLE_ID.test(config.keyId) || !APPLE_ID.test(config.teamId) || !BUNDLE_ID.test(config.bundleId) || config.bundleId.length > 155) return null;
  if (config.environment !== 'production' && config.environment !== 'development') return null;
  const key = apnsSigningKey(config.privateKey);
  return key ? { ...config, key } : null;
}

/** The ES256 provider token. `iat` in whole seconds. */
export function apnsProviderToken(config: Pick<ApnsConfig, 'keyId' | 'teamId'>, key: KeyObject, iat: number): string {
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))}.${b64url(JSON.stringify({ iss: config.teamId, iat }))}`;
  const signature = sign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/** The exact request for one generic message. Exported for request-shaping tests. */
export function apnsRequest(config: Pick<ApnsConfig, 'bundleId' | 'environment'>, providerToken: string, message: PushMessage, nowSeconds: number): ApnsRequest {
  return {
    origin: APNS_ORIGIN[config.environment],
    path: `/3/device/${message.token.toLowerCase()}`,
    headers: {
      authorization: `bearer ${providerToken}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(nowSeconds + PUSH_EXPIRY_SECONDS),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, body: { notificationId: message.notificationId } }),
  };
}

/** Map an APNs answer to an outcome. Only the device's own fault revokes. */
export function apnsOutcome(response: ApnsResponse): PushSendOutcome {
  if (response.status === 200) return { outcome: 'sent', status: 200, reason: null };
  let reason: string | null = null;
  try { reason = safeProviderReason((JSON.parse(response.body) as { reason?: unknown })?.reason); } catch { /* an empty or non-JSON body has no code */ }
  if (response.status === 410) return { outcome: 'invalid_token', status: 410, reason: reason ?? 'Unregistered' };
  if (response.status === 400 && reason === 'BadDeviceToken') return { outcome: 'invalid_token', status: 400, reason };
  return { outcome: 'failed', status: response.status, reason };
}

/** One HTTP/2 session per origin, reused for the sweep run; closed by the transport's close(). */
export function http2ApnsClient(timeoutMs = 10_000): ApnsHttp {
  let session: ClientHttp2Session | null = null, sessionOrigin = '';
  const open = (origin: string) => {
    if (!session || session.closed || session.destroyed || sessionOrigin !== origin) {
      session?.close();
      const next = connect(origin);
      // An unhandled session error would end the process; a broken session is simply replaced on the next send.
      next.on('error', () => { if (session === next) session = null; });
      session = next; sessionOrigin = origin;
    }
    return session;
  };
  return {
    request({ origin, path, headers, body }) {
      return new Promise<ApnsResponse>((resolve, reject) => {
        let stream: ReturnType<ClientHttp2Session['request']>;
        try { stream = open(origin).request({ ':method': 'POST', ':path': path, ...headers }); } catch (error) { reject(error); return; }
        let status = 0, size = 0;
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => { stream.close(constants.NGHTTP2_CANCEL); reject(new Error('APNs request timed out')); }, timeoutMs);
        stream.on('response', (h) => { status = Number(h[':status']); });
        stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 4096) chunks.push(chunk); });
        stream.on('end', () => { clearTimeout(timer); resolve({ status, body: Buffer.concat(chunks).toString('utf8') }); });
        stream.on('error', (error) => { clearTimeout(timer); reject(error); });
        stream.end(body);
      });
    },
    close() { session?.close(); session = null; },
  };
}

/**
 * A provider-token cache in one private file (0600, replaced atomically), so successive cron runs reuse a token for up
 * to 50 minutes. A missing, unreadable or foreign file is simply a miss. Holds the short-lived JWT only, never the key.
 */
export function fileProviderTokenCache(path: string): ProviderTokenCache {
  return {
    read() {
      try {
        const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<CachedProviderToken>;
        return typeof v.keyId === 'string' && typeof v.teamId === 'string' && Number.isInteger(v.issuedAt) && typeof v.token === 'string' && v.token.length < 2048
          ? { keyId: v.keyId, teamId: v.teamId, issuedAt: v.issuedAt!, token: v.token } : null;
      } catch { return null; }
    },
    write(value) {
      try { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, path); }
      catch { /* an unwritable cache only costs a fresh token next run */ }
    },
  };
}

/** The APNs transport, or null when the configuration is unusable (push stays off for iOS; never a crash). */
export function createApnsTransport(config: ApnsConfig | null | undefined, ports: { http?: ApnsHttp; now?: () => number; tokenCache?: ProviderTokenCache } = {}): PushTransport | null {
  const valid = validApnsConfig(config);
  if (!valid) return null;
  const now = ports.now ?? Date.now;
  const http = ports.http ?? http2ApnsClient();
  const fresh = (c: CachedProviderToken | null, seconds: number) =>
    c && c.keyId === valid.keyId && c.teamId === valid.teamId && c.issuedAt <= seconds && seconds - c.issuedAt < APNS_TOKEN_REUSE_SECONDS ? c : null;
  let cached: CachedProviderToken | null = null;
  const providerToken = (seconds: number) => {
    cached = fresh(cached, seconds) ?? fresh(ports.tokenCache?.read() ?? null, seconds);
    if (!cached) {
      cached = { keyId: valid.keyId, teamId: valid.teamId, issuedAt: seconds, token: apnsProviderToken(valid, valid.key, seconds) };
      ports.tokenCache?.write(cached);
    }
    return cached.token;
  };
  return {
    async send(message) {
      // Registration already refused anything else; a malformed token never reaches the path.
      if (!DEVICE_TOKEN.test(message.token)) return { outcome: 'invalid_token', status: null, reason: 'BadDeviceToken' };
      const seconds = Math.floor(now() / 1000);
      let response: ApnsResponse;
      try { response = await http.request(apnsRequest(valid, providerToken(seconds), message, seconds)); }
      catch { return { outcome: 'failed', status: null, reason: 'transport_error' }; }
      const out = apnsOutcome(response);
      if (response.status === 403 && (out.reason === 'ExpiredProviderToken' || out.reason === 'InvalidProviderToken')) {
        cached = null;
        // Overwrite the shared cache too, so the next run does not reuse the rejected token.
        ports.tokenCache?.write({ keyId: valid.keyId, teamId: valid.teamId, issuedAt: 0, token: '' });
      }
      return out;
    },
    close() { http.close(); },
  };
}
