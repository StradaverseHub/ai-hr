/**
 * M10 (D6) — direct APNs and FCM transports and their configuration, with FAKE wires: no test contacts Apple or Google.
 *
 * Pinned: the APNs ES256 provider token verifies against the key's public half and carries only kid/iss/iat; the exact
 * APNs request (origin per environment, /3/device/{token}, topic, push type, priority, expiry) and its generic body
 * with the id under `body` (where expo-notifications reads remote data); provider-token reuse within 50 minutes, across
 * runs through the file cache, and a fresh token after an Expired/InvalidProviderToken answer; which APNs answers
 * revoke (410, BadDeviceToken) and which do not (DeviceTokenNotForTopic, 5xx, transport errors). The FCM jwt-bearer
 * assertion verifies against the service account's public key; the access token is reused; the exact data-only v1
 * message; UNREGISTERED and INVALID_ARGUMENT-on-the-token revoke, SENDER_ID_MISMATCH and other answers do not. Absent or
 * unusable keys give no transport (push off), never a throw.
 */
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  APNS_ORIGIN, APNS_TOKEN_REUSE_SECONDS, apnsOutcome, apnsProviderToken, apnsRequest, createApnsTransport, fileProviderTokenCache, validApnsConfig,
  type ApnsHttp, type ApnsRequest, type ApnsResponse, type CachedProviderToken, type ProviderTokenCache,
} from '../lib/mobile-push-apns';
import { FCM_SCOPE, FCM_TOKEN_URL, createFcmTransport, fcmAssertion, fcmMessage, fcmOutcome, validFcmConfig } from '../lib/mobile-push-fcm';
import { PUSH_ENV, createConfiguredPushTransports, pushDeliveryAvailability, readApnsConfig, readFcmConfig } from '../lib/mobile-push-config';
import { PUSH_BODY, PUSH_TITLE, genericPushMessage, safeProviderReason } from '../lib/mobile-push-message';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS_CONFIG = { keyId: 'ABC123DEFG', teamId: 'TEAM123456', privateKey: pem(ec.privateKey), bundleId: 'ai.stradaverse.aihr.test', environment: 'production' as const };
const FCM_CONFIG = { projectId: 'aihr-test-project', clientEmail: 'push-sender@aihr-test-project.iam.gserviceaccount.com', privateKey: pem(rsa.privateKey) };
const NOTIFICATION = '3f2c1d0e-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
const TOKEN = 'AB'.repeat(32);
const message = (token = TOKEN) => genericPushMessage('en', token, NOTIFICATION);
const json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const verifies = (jwt: string, key: KeyObject, ecdsa: boolean) => {
  const [h, c, s] = jwt.split('.');
  return verify('sha256', Buffer.from(`${h}.${c}`), ecdsa ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function wire(answers: (ApnsResponse | Error)[] = []) {
  const requests: ApnsRequest[] = [];
  const http: ApnsHttp = {
    request: vi.fn(async (r: ApnsRequest) => { requests.push(r); const next = answers.shift() ?? { status: 200, body: '' }; if (next instanceof Error) throw next; return next; }),
    close: vi.fn(),
  };
  return { http, requests };
}

describe('the generic message', () => {
  it('is the same fixed words for every notification, in the enrolled language, plus the id', () => {
    expect(genericPushMessage('ms', 'tok', NOTIFICATION.toUpperCase())).toEqual({ token: 'tok', title: PUSH_TITLE, body: PUSH_BODY.ms, notificationId: NOTIFICATION });
    expect(() => genericPushMessage('en', 'tok', 'not-an-id')).toThrow();
    expect(safeProviderReason('BadDeviceToken')).toBe('BadDeviceToken');
    for (const bad of ['Bad Device', 'x'.repeat(65), 42, null, "'; drop"]) expect(safeProviderReason(bad)).toBeNull();
  });
});

describe('APNs', () => {
  it('signs an ES256 provider token that verifies against the .p8 key and names only kid, iss and iat', () => {
    const jwt = apnsProviderToken(APNS_CONFIG, validApnsConfig(APNS_CONFIG)!.key, 1_800_000_000);
    const [h, c] = jwt.split('.');
    expect(json(h)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(json(c)).toEqual({ iss: 'TEAM123456', iat: 1_800_000_000 });
    expect(verifies(jwt, ec.publicKey, true)).toBe(true);
    expect(verifies(jwt, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey, true)).toBe(false);
  });

  it('shapes the exact request: host per environment, device path, topic, alert type, and a generic body', () => {
    const r = apnsRequest(APNS_CONFIG, 'jwt.value.here', message(), 1_800_000_000);
    expect(r.origin).toBe('https://api.push.apple.com');
    expect(r.path).toBe(`/3/device/${TOKEN.toLowerCase()}`);
    expect(r.headers).toEqual({
      authorization: 'bearer jwt.value.here', 'apns-topic': 'ai.stradaverse.aihr.test', 'apns-push-type': 'alert',
      'apns-priority': '10', 'apns-expiration': String(1_800_000_000 + 3600), 'content-type': 'application/json',
    });
    expect(JSON.parse(r.body)).toEqual({ aps: { alert: { title: PUSH_TITLE, body: PUSH_BODY.en }, sound: 'default' }, body: { notificationId: NOTIFICATION } });
    expect(apnsRequest({ ...APNS_CONFIG, environment: 'development' }, 'j', message(), 0).origin).toBe(APNS_ORIGIN.development);
  });

  it('maps answers: only 410 and BadDeviceToken revoke', () => {
    expect(apnsOutcome({ status: 200, body: '' })).toEqual({ outcome: 'sent', status: 200, reason: null });
    expect(apnsOutcome({ status: 410, body: '{"reason":"Unregistered","timestamp":1}' })).toEqual({ outcome: 'invalid_token', status: 410, reason: 'Unregistered' });
    expect(apnsOutcome({ status: 410, body: '' })).toEqual({ outcome: 'invalid_token', status: 410, reason: 'Unregistered' });
    expect(apnsOutcome({ status: 400, body: '{"reason":"BadDeviceToken"}' })).toEqual({ outcome: 'invalid_token', status: 400, reason: 'BadDeviceToken' });
    expect(apnsOutcome({ status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' }).outcome).toBe('failed');
    expect(apnsOutcome({ status: 500, body: 'oops' })).toEqual({ outcome: 'failed', status: 500, reason: null });
    expect(apnsOutcome({ status: 429, body: '{"reason":"TooManyProviderTokenUpdates"}' })).toEqual({ outcome: 'failed', status: 429, reason: 'TooManyProviderTokenUpdates' });
  });

  it('reuses one provider token for 50 minutes, renews after, and after an expired-token answer', async () => {
    let now = 1_800_000_000_000;
    const w = wire([{ status: 200, body: '' }, { status: 200, body: '' }, { status: 200, body: '' }, { status: 403, body: '{"reason":"ExpiredProviderToken"}' }, { status: 200, body: '' }]);
    const t = createApnsTransport(APNS_CONFIG, { http: w.http, now: () => now })!;
    expect(await t.send(message())).toMatchObject({ outcome: 'sent' });
    now += (APNS_TOKEN_REUSE_SECONDS - 60) * 1000;
    await t.send(message());
    now += 120 * 1000;
    await t.send(message());
    const auth = w.requests.map((r) => r.headers.authorization);
    expect(auth[1]).toBe(auth[0]);
    expect(auth[2]).not.toBe(auth[0]);
    expect((await t.send(message())).outcome).toBe('failed');
    await t.send(message());
    expect(w.requests[4].headers.authorization).not.toBe(w.requests[3].headers.authorization);
    for (const r of w.requests) expect(verifies(r.headers.authorization.slice(7), ec.publicKey, true)).toBe(true);
    t.close();
    expect(w.http.close).toHaveBeenCalled();
  });

  it('shares the provider token between runs through the private file cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aihr-apns-')); dirs.push(dir);
    const path = join(dir, 'token.json');
    const now = () => 1_800_000_000_000;
    const first = wire(), second = wire();
    await createApnsTransport(APNS_CONFIG, { http: first.http, now, tokenCache: fileProviderTokenCache(path) })!.send(message());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE KEY');
    await createApnsTransport(APNS_CONFIG, { http: second.http, now, tokenCache: fileProviderTokenCache(path) })!.send(message());
    expect(second.requests[0].headers.authorization).toBe(first.requests[0].headers.authorization);
    // Another key's cached token is never used; a corrupt file is a miss.
    const other = wire();
    await createApnsTransport({ ...APNS_CONFIG, keyId: 'ZZZ999YYYX' }, { http: other.http, now, tokenCache: fileProviderTokenCache(path) })!.send(message());
    expect(other.requests[0].headers.authorization).not.toBe(first.requests[0].headers.authorization);
    writeFileSync(path, '{not json');
    expect(fileProviderTokenCache(path).read()).toBeNull();
  });

  it('a wire error is a failure that revokes nothing; a malformed token never reaches the path', async () => {
    const w = wire([new Error('socket hang up')]);
    const t = createApnsTransport(APNS_CONFIG, { http: w.http })!;
    expect(await t.send(message())).toEqual({ outcome: 'failed', status: null, reason: 'transport_error' });
    expect(await t.send(message('not/hex/../token'))).toMatchObject({ outcome: 'invalid_token' });
    expect(w.requests).toHaveLength(1);
  });

  it('an unusable configuration is no transport (push off), never a throw', () => {
    const cache: ProviderTokenCache = { read: () => null, write: (_v: CachedProviderToken) => {} };
    expect(createApnsTransport(null)).toBeNull();
    expect(createApnsTransport({ ...APNS_CONFIG, keyId: 'short' }, { tokenCache: cache })).toBeNull();
    expect(createApnsTransport({ ...APNS_CONFIG, privateKey: pem(rsa.privateKey) })).toBeNull();
    expect(createApnsTransport({ ...APNS_CONFIG, privateKey: 'garbage' })).toBeNull();
    expect(createApnsTransport({ ...APNS_CONFIG, bundleId: 'no-dots' })).toBeNull();
  });
});

type Call = { url: string; init: RequestInit };
function fcmWire(answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const tokenAnswer = () => Response.json({ access_token: 'ya29.test-access-token', expires_in: 3600, token_type: 'Bearer' });
const fcmError = (status: number, errorCode: string, field?: string) => Response.json({ error: { code: status, status: errorCode === 'UNREGISTERED' ? 'NOT_FOUND' : errorCode, message: 'private provider text',
  details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }, ...(field ? [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field, description: 'x' }] }] : [])] } }, { status });

describe('FCM', () => {
  it('exchanges an RS256 jwt-bearer assertion, then sends the exact data-only message with the access token', async () => {
    const w = fcmWire([tokenAnswer(), Response.json({ name: 'projects/aihr-test-project/messages/1' }), Response.json({ name: 'm/2' })]);
    const t = createFcmTransport(FCM_CONFIG, { fetch: w.fetch, now: () => 1_800_000_000_000 })!;
    expect(await t.send(message('fcm-token:abc_DEF-123'))).toEqual({ outcome: 'sent', status: 200, reason: null });
    const [exchange, send] = w.calls;
    expect(exchange.url).toBe(FCM_TOKEN_URL);
    expect(exchange.init).toMatchObject({ method: 'POST', redirect: 'error' });
    const form = new URLSearchParams(String(exchange.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    expect(verifies(assertion, rsa.publicKey, false)).toBe(true);
    expect(json(assertion.split('.')[1])).toEqual({ iss: FCM_CONFIG.clientEmail, scope: FCM_SCOPE, aud: FCM_TOKEN_URL, iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/aihr-test-project/messages:send');
    expect(send.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ya29.test-access-token', 'content-type': 'application/json' } });
    const body = JSON.parse(String(send.init.body));
    expect(body).toEqual({ message: {
      token: 'fcm-token:abc_DEF-123',
      data: { title: PUSH_TITLE, message: PUSH_BODY.en, body: JSON.stringify({ notificationId: NOTIFICATION }), channelId: 'aihr-updates' },
      android: { priority: 'HIGH', ttl: '3600s' },
    } });
    expect(body).toEqual(fcmMessage(message('fcm-token:abc_DEF-123')));
    // The access token is reused: the second send makes no second exchange.
    await t.send(message('fcm-token:abc_DEF-123'));
    expect(w.calls.map((c) => c.url)).toEqual([FCM_TOKEN_URL, send.url, send.url]);
  });

  it('maps answers: UNREGISTERED and INVALID_ARGUMENT on the token revoke; a project mismatch does not', () => {
    expect(fcmOutcome(404, JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }))).toEqual({ outcome: 'invalid_token', status: 404, reason: 'UNREGISTERED' });
    expect(fcmOutcome(400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }, { fieldViolations: [{ field: 'message.token' }] }] } })).outcome).toBe('invalid_token');
    expect(fcmOutcome(400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }, { fieldViolations: [{ field: 'message.data' }] }] } })).outcome).toBe('failed');
    expect(fcmOutcome(403, JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } }))).toEqual({ outcome: 'failed', status: 403, reason: 'SENDER_ID_MISMATCH' });
    expect(fcmOutcome(503, 'Service Unavailable')).toEqual({ outcome: 'failed', status: 503, reason: null });
  });

  it('a revoking answer from the wire, a 401 that drops the access token, and failures that send nothing', async () => {
    const w = fcmWire([tokenAnswer(), fcmError(404, 'UNREGISTERED'), fcmError(400, 'INVALID_ARGUMENT', 'message.token'), new Response('{}', { status: 401 }), tokenAnswer(), Response.json({ name: 'm' })]);
    const t = createFcmTransport(FCM_CONFIG, { fetch: w.fetch })!;
    expect(await t.send(message('tok-a'))).toMatchObject({ outcome: 'invalid_token', reason: 'UNREGISTERED' });
    expect(await t.send(message('tok-b'))).toMatchObject({ outcome: 'invalid_token', reason: 'INVALID_ARGUMENT' });
    expect(await t.send(message('tok-c'))).toMatchObject({ outcome: 'failed', status: 401 });
    expect(await t.send(message('tok-c'))).toMatchObject({ outcome: 'sent' });
    expect(w.calls.filter((c) => c.url === FCM_TOKEN_URL)).toHaveLength(2);
    const refused = fcmWire([new Response('{"error":"invalid_grant"}', { status: 400 })]);
    expect(await createFcmTransport(FCM_CONFIG, { fetch: refused.fetch })!.send(message('t'))).toEqual({ outcome: 'failed', status: null, reason: 'oauth_unavailable' });
    const down = fcmWire([new Error('ECONNRESET')]);
    expect(await createFcmTransport(FCM_CONFIG, { fetch: down.fetch })!.send(message('t'))).toEqual({ outcome: 'failed', status: null, reason: 'transport_error' });
  });

  it('an unusable configuration is no transport', () => {
    expect(createFcmTransport(null)).toBeNull();
    expect(validFcmConfig({ ...FCM_CONFIG, clientEmail: 'someone@example.com' })).toBeNull();
    expect(validFcmConfig({ ...FCM_CONFIG, projectId: 'X' })).toBeNull();
    expect(validFcmConfig({ ...FCM_CONFIG, privateKey: pem(ec.privateKey) })).toBeNull();
    expect(fcmAssertion(FCM_CONFIG.clientEmail, validFcmConfig(FCM_CONFIG)!.key, 1).split('.')).toHaveLength(3);
  });
});

describe('configuration from the environment', () => {
  const env = {
    [PUSH_ENV.apnsKeyId]: APNS_CONFIG.keyId, [PUSH_ENV.apnsTeamId]: APNS_CONFIG.teamId, [PUSH_ENV.apnsBundleId]: APNS_CONFIG.bundleId,
    [PUSH_ENV.apnsPrivateKey]: APNS_CONFIG.privateKey.replace(/\n/g, '\\n'),
    [PUSH_ENV.fcmProjectId]: FCM_CONFIG.projectId,
    [PUSH_ENV.fcmServiceAccount]: JSON.stringify({ type: 'service_account', project_id: 'aihr-test-project', client_email: FCM_CONFIG.clientEmail, private_key: FCM_CONFIG.privateKey }),
  };
  it('reads both providers, the .p8 with literal \\n separators, production by default', () => {
    expect(readApnsConfig(env)).toEqual({ ...APNS_CONFIG, environment: 'production' });
    expect(readApnsConfig({ ...env, [PUSH_ENV.apnsEnvironment]: 'development' })?.environment).toBe('development');
    expect(readApnsConfig({ ...env, [PUSH_ENV.apnsEnvironment]: 'staging' })).toBeNull();
    expect(readFcmConfig(env)).toEqual(FCM_CONFIG);
    expect(readFcmConfig({ ...env, [PUSH_ENV.fcmServiceAccount]: '{broken' })).toBeNull();
    expect(pushDeliveryAvailability(env)).toEqual({ ios: 'available', android: 'available' });
    const transports = createConfiguredPushTransports(env, { apnsHttp: wire().http, fetch: fcmWire([]).fetch });
    expect(Object.keys(transports).sort()).toEqual(['apns', 'fcm']);
  });
  it('nothing configured ⇒ both unavailable and no transport at all (the sweep is a no-op)', () => {
    expect(pushDeliveryAvailability({})).toEqual({ ios: 'unavailable', android: 'unavailable' });
    expect(createConfiguredPushTransports({})).toEqual({});
    const { [PUSH_ENV.apnsPrivateKey]: _key, ...withoutKey } = env;
    expect(pushDeliveryAvailability(withoutKey)).toEqual({ ios: 'unavailable', android: 'available' });
  });
});
