/**
 * M10 (D6) — where push keys come from: deployment environment variables, read on use (no cache), never EXPO_PUBLIC,
 * never logged. With a provider's variables absent or unusable that provider is simply unavailable: the sweep is a
 * logged no-op for it and the status endpoint says `unavailable`. Documented in .env.example and deploy/DEPLOY.md.
 *
 *   AIHR_PUSH_APNS_KEY_ID          the .p8 key's 10-character Key ID
 *   AIHR_PUSH_APNS_TEAM_ID         the 10-character Apple Developer Team ID
 *   AIHR_PUSH_APNS_PRIVATE_KEY     the .p8 PEM (literal \n separators are read as newlines)
 *   AIHR_PUSH_APNS_BUNDLE_ID       the iOS bundle identifier (the apns-topic), e.g. ai.stradaverse.aihr.test
 *   AIHR_PUSH_APNS_ENVIRONMENT     production (default) | development — must match the builds' aps-environment
 *   AIHR_PUSH_APNS_TOKEN_CACHE     optional private file path; lets successive sweep runs reuse the provider token
 *   AIHR_PUSH_FCM_PROJECT_ID       the Firebase project id the Android app is registered in
 *   AIHR_PUSH_FCM_SERVICE_ACCOUNT  that project's service-account JSON (one line), with the FCM send permission
 */
import { createApnsTransport, fileProviderTokenCache, validApnsConfig, type ApnsConfig, type ApnsHttp } from './mobile-push-apns';
import { createFcmTransport, validFcmConfig, type FcmConfig } from './mobile-push-fcm';
import type { PushTransports } from './mobile-push-message';

export const PUSH_ENV = {
  apnsKeyId: 'AIHR_PUSH_APNS_KEY_ID',
  apnsTeamId: 'AIHR_PUSH_APNS_TEAM_ID',
  apnsPrivateKey: 'AIHR_PUSH_APNS_PRIVATE_KEY',
  apnsBundleId: 'AIHR_PUSH_APNS_BUNDLE_ID',
  apnsEnvironment: 'AIHR_PUSH_APNS_ENVIRONMENT',
  apnsTokenCache: 'AIHR_PUSH_APNS_TOKEN_CACHE',
  fcmProjectId: 'AIHR_PUSH_FCM_PROJECT_ID',
  fcmServiceAccount: 'AIHR_PUSH_FCM_SERVICE_ACCOUNT',
} as const;
type Env = Record<string, string | undefined>;
const pem = (value: string | undefined) => (value ? value.replace(/\\n/g, '\n') : '');

export function readApnsConfig(env: Env = process.env): ApnsConfig | null {
  const keyId = env[PUSH_ENV.apnsKeyId], teamId = env[PUSH_ENV.apnsTeamId], privateKey = pem(env[PUSH_ENV.apnsPrivateKey]), bundleId = env[PUSH_ENV.apnsBundleId];
  if (!keyId || !teamId || !privateKey || !bundleId || privateKey.length > 8192) return null;
  const raw = env[PUSH_ENV.apnsEnvironment];
  const environment: ApnsConfig['environment'] | null = raw === undefined || raw === '' || raw === 'production' ? 'production' : raw === 'development' ? 'development' : null;
  if (!environment) return null;
  return { keyId, teamId, privateKey, bundleId, environment };
}

export function readFcmConfig(env: Env = process.env): FcmConfig | null {
  const projectId = env[PUSH_ENV.fcmProjectId], raw = env[PUSH_ENV.fcmServiceAccount];
  if (!projectId || !raw || Buffer.byteLength(raw, 'utf8') > 32768) return null;
  try {
    const account = JSON.parse(raw) as { type?: unknown; client_email?: unknown; private_key?: unknown };
    if (account?.type !== 'service_account' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string') return null;
    return { projectId, clientEmail: account.client_email, privateKey: account.private_key };
  } catch { return null; }
}

/** Whether each platform's provider is configured with usable keys right now. Parses keys; sends nothing. */
export function pushDeliveryAvailability(env: Env = process.env): { ios: 'available' | 'unavailable'; android: 'available' | 'unavailable' } {
  return {
    ios: validApnsConfig(readApnsConfig(env)) ? 'available' : 'unavailable',
    android: validFcmConfig(readFcmConfig(env)) ? 'available' : 'unavailable',
  };
}

/** The deployment's transports; a provider without usable keys is absent. Ports are for tests only. */
export function createConfiguredPushTransports(env: Env = process.env, ports: { apnsHttp?: ApnsHttp; fetch?: typeof fetch } = {}): PushTransports {
  const cachePath = env[PUSH_ENV.apnsTokenCache];
  const apns = createApnsTransport(readApnsConfig(env), { http: ports.apnsHttp, tokenCache: cachePath ? fileProviderTokenCache(cachePath) : undefined });
  const fcm = createFcmTransport(readFcmConfig(env), { fetch: ports.fetch });
  return { ...(apns ? { apns } : {}), ...(fcm ? { fcm } : {}) };
}
