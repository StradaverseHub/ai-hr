/**
 * Sign-in for the app (ADR-0088 §1): WorkOS hosted AuthKit in the system browser, authorization code +
 * PKCE, no client secret anywhere in the app.
 *
 * VERIFIED 2026-09-30, not assumed:
 *   • authorize: GET https://api.workos.com/user_management/authorize with response_type=code, client_id,
 *     redirect_uri, provider=authkit, code_challenge, code_challenge_method=S256 (WorkOS API reference).
 *   • exchange and refresh: POST https://api.workos.com/user_management/authenticate. The reference page
 *     lists client_secret as required for the refresh grant, but WorkOS's own Expo example
 *     (github.com/workos/expo-authkit-example, src/lib/auth.ts) builds `new WorkOS({ clientId })` with no key
 *     and refreshes from the device; @workos-inc/node 10.7.0 serialises `client_secret: this.workos.key`,
 *     i.e. undefined, i.e. omitted from the JSON. Working code outranks the reference page.
 *
 * STORAGE. The refresh token lives in SecureStore under WHEN_UNLOCKED_THIS_DEVICE_ONLY, so it never
 * migrates to another device through a backup. The access token lives in memory only. WorkOS may rotate
 * the refresh token on every use, so every refresh stores the replacement, and refreshes are
 * SINGLE-FLIGHT: two concurrent refreshes would spend the same token twice and the second would sign the
 * employee out.
 */
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { config } from './config';
import { SignInRequiredError, UnavailableError } from './errors';

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

let accessToken: string | null = null;
let inflight: Promise<string> | null = null;

/** Seconds-since-epoch expiry of a JWT, or 0 when it cannot be read (treated as expired). */
function expiryOf(token: string): number {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')));
    return typeof json.exp === 'number' ? json.exp : 0;
  } catch {
    return 0;
  }
}

type TokenPair = { access_token: string; refresh_token: string };

async function authenticate(body: Record<string, string>): Promise<TokenPair> {
  let res: Response;
  try {
    res = await fetch(AUTHENTICATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.workosClientId, ...body }),
    });
  } catch {
    throw new UnavailableError();
  }
  // 400/401/403: the code or refresh token is spent, expired or revoked. Anything else is an outage.
  if (res.status >= 400 && res.status < 500) throw new SignInRequiredError();
  if (!res.ok) throw new UnavailableError();
  const json = (await res.json()) as Partial<TokenPair>;
  if (!json.access_token || !json.refresh_token) throw new UnavailableError('Malformed sign-in response.');
  return { access_token: json.access_token, refresh_token: json.refresh_token };
}

async function store(pair: TokenPair): Promise<string> {
  await SecureStore.setItemAsync(REFRESH_KEY, pair.refresh_token, STORE);
  accessToken = pair.access_token;
  return pair.access_token;
}

/** Finish the browser round trip: exchange the authorization code for tokens using the PKCE verifier. */
export async function completeSignIn(code: string, codeVerifier: string): Promise<void> {
  await store(await authenticate({ grant_type: 'authorization_code', code, code_verifier: codeVerifier }));
}

export async function hasStoredSession(): Promise<boolean> {
  return (await SecureStore.getItemAsync(REFRESH_KEY, STORE)) != null;
}

/** Exchange the stored refresh token for a fresh pair. Single-flight; a credential failure clears the session. */
export function refresh(): Promise<string> {
  if (!inflight) {
    inflight = (async () => {
      const token = await SecureStore.getItemAsync(REFRESH_KEY, STORE);
      if (!token) throw new SignInRequiredError();
      try {
        return await store(await authenticate({ grant_type: 'refresh_token', refresh_token: token }));
      } catch (e) {
        if (e instanceof SignInRequiredError) await signOut();
        throw e; // UnavailableError keeps the stored token: the next attempt may succeed
      }
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** An access token good for at least another minute, refreshing if needed. */
export async function getAccessToken(): Promise<string> {
  if (accessToken && expiryOf(accessToken) - Date.now() / 1000 > 60) return accessToken;
  return refresh();
}

export async function signOut(): Promise<void> {
  accessToken = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY, STORE);
}
