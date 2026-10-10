/** Hosted AuthKit + PKCE. Only the public client id ships in the app (ADR-0088). */
import { clearClockDevice } from './device-registration';
import * as AuthSession from 'expo-auth-session';
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { createAuthState, type TokenPair } from './auth-state';
import { config } from './config';
import { SignInRequiredError, UnavailableError } from './errors';
import { createInstallationStore } from './installation-store';
import { providerLogoutUrl, sessionIdFromToken } from './provider-logout';

const REFRESH_KEY = 'aihr.refreshToken';
const STORE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const AUTHENTICATE_URL = 'https://api.workos.com/user_management/authenticate';
export const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://api.workos.com/user_management/authorize',
  tokenEndpoint: AUTHENTICATE_URL,
};
export function redirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: config.scheme, path: 'auth/callback' });
}

async function authenticate(body: Record<string, string>): Promise<TokenPair> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(AUTHENTICATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.workosClientId, ...body }),
      signal: controller.signal,
      redirect: 'error',
    });
    // Throttling, bad configuration and outages preserve the credentials for a retry.
    if ([400, 401, 403].includes(res.status)) throw new SignInRequiredError();
    if (!res.ok) throw new UnavailableError();
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null ||
      !('access_token' in json) || typeof json.access_token !== 'string' || !json.access_token ||
      !('refresh_token' in json) || typeof json.refresh_token !== 'string' || !json.refresh_token) {
      throw new UnavailableError('Malformed sign-in response.');
    }
    return { access_token: json.access_token, refresh_token: json.refresh_token };
  } catch (error) {
    if (error instanceof SignInRequiredError || error instanceof UnavailableError) throw error;
    throw new UnavailableError();
  } finally { clearTimeout(timeout); }
}

// iOS Keychain can outlive uninstall. This non-secret marker lives in the app sandbox.
const storage = createInstallationStore({
  markerExists: () => new File(Paths.document, 'aihr-installation-v1').exists,
  createMarker: () => new File(Paths.document, 'aihr-installation-v1').write('1'),
  logoutPending: () => {
    const marker = new File(Paths.document, 'aihr-installation-v1');
    return marker.exists && marker.textSync() === 'signed-out';
  },
  markLogoutPending: () => new File(Paths.document, 'aihr-installation-v1').write('signed-out'),
  read: () => SecureStore.getItemAsync(REFRESH_KEY, STORE),
  write: (value) => SecureStore.setItemAsync(REFRESH_KEY, value, STORE),
  remove: async () => { await Promise.all([clearClockDevice(), SecureStore.deleteItemAsync(REFRESH_KEY, STORE)]); },
});
let sessionId: string | null = null;
const state: ReturnType<typeof createAuthState> = createAuthState({
  authenticate,
  markLoggedOut: storage.markLoggedOut,
  async read() {
    const owner = state.generation();
    const value = await storage.read();
    if (!value) return null;
    try {
      const record: unknown = JSON.parse(value);
      if (typeof record === 'object' && record !== null && 'refreshToken' in record &&
        typeof record.refreshToken === 'string' && record.refreshToken) {
        if (owner === state.generation()) sessionId = 'sessionId' in record && typeof record.sessionId === 'string' ? record.sessionId : null;
        return record.refreshToken;
      }
    } catch { /* A corrupt or legacy credential is ignored, never logged. */ }
    // Reads never mutate Keychain: an asynchronous delete here could erase a concurrent new login.
    // Explicit logout deletes through the controller's serialized queue; a new login replaces it.
    return null;
  },
  async write(refreshToken, accessToken) {
    const owner = state.generation();
    const nextSessionId = sessionIdFromToken(accessToken);
    await storage.write(JSON.stringify({ refreshToken, sessionId: nextSessionId }));
    if (owner === state.generation()) {
      storage.markSignedIn();
      sessionId = nextSessionId;
    }
  },
  async remove() { sessionId = null; await storage.remove(); },
});
/** Capture before local logout; the Keychain copy allows explicit logout immediately after cold launch. */
export function workosLogoutUrl(): string | null { return providerLogoutUrl(sessionId, redirectUri()); }
export const beginSignIn = state.beginSignIn;
export const completeSignIn = state.completeSignIn;
export const hasStoredSession = state.hasStoredSession;
export const refresh = state.refresh;
export const getAccessToken = state.getAccessToken;
export const signOut = state.signOut;
export const authGeneration = state.generation;
export const assertAuthGeneration = state.assertCurrent;
