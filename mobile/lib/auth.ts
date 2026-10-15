/** Hosted AuthKit + PKCE. Only the public client id ships in the app (ADR-0088). */
import { clearClockDevice } from './device-registration';
import * as AuthSession from 'expo-auth-session';
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { createAuthState, type TokenPair } from './auth-state';
import { config, configProblem, identityClientId, identityNamespace } from './config';
import { SignInRequiredError, UnavailableError } from './errors';
import { createInstallationStore } from './installation-store';
import { providerLogoutUrl, sessionIdFromToken } from './provider-logout';

const REFRESH_KEY = 'aihr.refreshToken';
const STORE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const discovery: AuthSession.DiscoveryDocument = {
  get authorizationEndpoint() { return config.authProvider === 'keycloak' ? `${config.issuer}/protocol/openid-connect/auth` : 'https://api.workos.com/user_management/authorize'; },
  get tokenEndpoint() { return config.authProvider === 'keycloak' ? `${config.issuer}/protocol/openid-connect/token` : 'https://api.workos.com/user_management/authenticate'; },
};
export function redirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: config.scheme, path: 'auth/callback' });
}

async function authenticate(body: Record<string, string>): Promise<TokenPair> {
  if (configProblem()) throw new UnavailableError('Sign-in is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    if (config.authProvider === 'internal' && body.grant_type !== 'refresh_token') throw new SignInRequiredError();
    const embedded = config.authProvider === 'internal';
    const endpoint = embedded ? config.apiUrl + '/login/api/refresh' : discovery.tokenEndpoint!;
    const params = { client_id: identityClientId(), ...body, ...(config.authProvider === 'keycloak' && body.grant_type === 'authorization_code' ? { redirect_uri: redirectUri() } : {}) };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...(embedded ? { 'x-aihr-client': 'native' } : {}), 'content-type': config.authProvider === 'keycloak' ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: config.authProvider === 'keycloak' ? new URLSearchParams(params).toString() : JSON.stringify(params),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
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
    if (embedded && (!/^aihr_[A-Za-z0-9_-]{43}$/.test(json.access_token) ||
      !/^aihr_refresh_[A-Za-z0-9_-]{43}$/.test(json.refresh_token) || !('expires_in' in json) ||
      typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in) || json.expires_in <= 0 || json.expires_in > 3600)) {
      throw new UnavailableError('Malformed sign-in response.');
    }
    return { access_token: json.access_token, refresh_token: json.refresh_token, ...('expires_in' in json && typeof json.expires_in === 'number' ? { expires_in: json.expires_in } : {}), ...('id_token' in json && typeof json.id_token === 'string' ? { id_token: json.id_token } : {}) };
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
let idToken: string | null = null;
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
        typeof record.refreshToken === 'string' && record.refreshToken &&
        'namespace' in record && record.namespace === identityNamespace()) {
        if (owner === state.generation()) idToken = 'idToken' in record && typeof record.idToken === 'string' ? record.idToken : null;
        if (owner === state.generation()) sessionId = 'sessionId' in record && typeof record.sessionId === 'string' ? record.sessionId : null;
        return record.refreshToken;
      }
    } catch { /* A corrupt or legacy credential is ignored, never logged. */ }
    // Reads never mutate Keychain: an asynchronous delete here could erase a concurrent new login.
    // Explicit logout deletes through the controller's serialized queue; a new login replaces it.
    return null;
  },
  async write(refreshToken, accessToken, nextIdToken) {
    const owner = state.generation();
    const nextSessionId = sessionIdFromToken(accessToken);
    await storage.write(JSON.stringify({ refreshToken, sessionId: nextSessionId, namespace: identityNamespace(), idToken: nextIdToken ?? idToken }));
    if (owner === state.generation()) {
      storage.markSignedIn();
      sessionId = nextSessionId;
      idToken = nextIdToken ?? idToken;
    }
  },
  async remove() {
    const endpoint = config.authProvider === 'internal' ? config.apiUrl + '/login/api/logout' : null;
    const namespace = identityNamespace();
    // Read only for remote revocation: the synchronous logout tombstone intentionally blocks
    // storage.read(), which may also erase the surviving handle during cold-start initialization.
    const stored = endpoint ? await SecureStore.getItemAsync(REFRESH_KEY, STORE).catch(() => null) : null;
    sessionId = null; idToken = null; await storage.remove();
    // createAuthState invalidates synchronously before entering this serialized cleanup.
    if (!endpoint || !stored) return;
    try {
      const record = JSON.parse(stored);
      if (record.namespace !== namespace || typeof record.refreshToken !== 'string') return;
      await fetch(endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-aihr-client': 'native' }, body: JSON.stringify({ refresh_token: record.refreshToken }) });
    } catch { /* Local credentials are gone even when remote revocation is unavailable. */ }
  },
});
/** Capture before local logout; the Keychain copy allows explicit logout immediately after cold launch. */
export function workosLogoutUrl(): string | null {
  if (config.authProvider === 'internal') return null;
  if (config.authProvider !== 'keycloak') return providerLogoutUrl(sessionId, redirectUri());
  if (!idToken || configProblem()) return null;
  return `${config.issuer}/protocol/openid-connect/logout?${new URLSearchParams({ id_token_hint: idToken, client_id: identityClientId(), post_logout_redirect_uri: redirectUri() })}`;
}
export const beginSignIn = state.beginSignIn;
export const completeSignIn = state.completeSignIn;
export const hasStoredSession = state.hasStoredSession;
export const refresh = state.refresh;
export const getAccessToken = state.getAccessToken;
export const signOut = state.signOut;
export const completeInternalSignIn = state.completeTokens;
export const authGeneration = state.generation;
export const assertAuthGeneration = state.assertCurrent;
