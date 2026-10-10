/** Deployment-owned identity configuration. Never read issuer, endpoints or secrets from a request. */
type Env = Record<string, string | undefined>;
export const WEB_SESSION_COOKIE = '__Host-aihr_session';
export const LOGIN_COOKIE = '__Host-aihr_login';
export function keycloakSelected(env: Env = process.env): boolean { return env.AUTH_PROVIDER === 'keycloak'; }
export function keycloakConfig(env: Env = process.env) {
  const required = ['KEYCLOAK_ISSUER', 'KEYCLOAK_WEB_CLIENT_ID', 'KEYCLOAK_WEB_CLIENT_SECRET', 'KEYCLOAK_MOBILE_CLIENT_ID', 'KEYCLOAK_API_AUDIENCE', 'AUTH_PUBLIC_ORIGIN', 'AUTH_SESSION_KEY'] as const;
  for (const name of required) if (!env[name]?.trim()) throw new Error(`Missing identity setting: ${name}`);
  const issuer = new URL(env.KEYCLOAK_ISSUER!);
  const origin = new URL(env.AUTH_PUBLIC_ORIGIN!);
  for (const url of [issuer, origin]) if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Identity URLs must use HTTPS without credentials, query or fragment.');
  if (origin.pathname !== '/' || issuer.pathname.endsWith('/') || !/\/realms\/[a-zA-Z0-9_-]+$/.test(issuer.pathname)) throw new Error('Invalid identity origin or realm issuer.');
  if (!/^[a-fA-F0-9]{64}$/.test(env.AUTH_SESSION_KEY!)) throw new Error('AUTH_SESSION_KEY must contain 32 random bytes encoded as hex.');
  let backchannel: string | undefined;
  if (env.KEYCLOAK_BACKCHANNEL_ORIGIN) {
    const url = new URL(env.KEYCLOAK_BACKCHANNEL_ORIGIN);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Identity backchannel must be an explicit loopback HTTP origin.');
    backchannel = url.origin;
  }
  return { issuer: issuer.href, origin: origin.origin, webClientId: env.KEYCLOAK_WEB_CLIENT_ID!, webClientSecret: env.KEYCLOAK_WEB_CLIENT_SECRET!, mobileClientId: env.KEYCLOAK_MOBILE_CLIENT_ID!, audience: env.KEYCLOAK_API_AUDIENCE!, sessionKey: env.AUTH_SESSION_KEY!, backchannel, redirectUri: `${origin.origin}/callback` };
}
export function keycloakReady(env: Env = process.env): boolean { try { keycloakConfig(env); return true; } catch { return false; } }
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value) || value.length > 1500) return '/';
  const url = new URL(value, 'https://internal.invalid');
  return url.origin === 'https://internal.invalid' && !['/callback', '/login/start'].includes(url.pathname) ? url.pathname + url.search + url.hash : '/';
}
