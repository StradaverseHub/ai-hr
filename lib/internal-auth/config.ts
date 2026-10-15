/** First-party authentication configuration. Never derive trust from request headers. */
type Env = Record<string, string | undefined>;
export const INTERNAL_SESSION_COOKIE = '__Host-aihr_internal';
export function internalSelected(env: Env = process.env) { return env.AUTH_PROVIDER === 'internal'; }
export function internalConfig(env: Env = process.env) {
  const origin = new URL(env.AUTH_PUBLIC_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('AUTH_PUBLIC_ORIGIN must be a canonical HTTPS origin.');
  if (!/^[a-fA-F0-9]{64}$/.test(env.AUTH_SESSION_KEY || '')) throw new Error('AUTH_SESSION_KEY must be 32 random bytes encoded as hex.');
  const organization = (env.AUTH_DEFAULT_ORGANIZATION || '').trim().toLowerCase();
  if (organization && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(organization)) throw new Error('Invalid default organization code.');
  return { origin: origin.origin, key: env.AUTH_SESSION_KEY!, organization };
}
export function internalReady(env: Env = process.env) { try { internalConfig(env); return true; } catch { return false; } }
export function internalIssuer(tenantId: string) { return `${internalConfig().origin}/auth/${tenantId}`; }
