/**
 * Build-time configuration. Expo inlines EXPO_PUBLIC_* variables into the bundle, so NOTHING secret may
 * live here — and nothing does: the WorkOS client id is public by design (PKCE, ADR-0088 §1), and the
 * API URL is just an address. See .env.example.
 */
export const config = {
  /** The AI HR server, e.g. https://hr.example.com. No trailing slash. */
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, ''),
  /** The WorkOS client id of the environment this build signs in against (Staging or Production). */
  workosClientId: process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? '',
  /** The custom URL scheme registered with WorkOS as `aihr://auth/callback` (placeholder until the store name is chosen). */
  scheme: 'aihr',
} as const;

/** A human-readable reason the build cannot sign anyone in, or null when it is configured. */
export function configProblem(): string | null {
  if (!config.apiUrl) return 'EXPO_PUBLIC_API_URL is not set for this build.';
  const originProblem = apiOriginProblem(config.apiUrl);
  if (originProblem) return originProblem;
  if (!config.workosClientId) return 'EXPO_PUBLIC_WORKOS_CLIENT_ID is not set for this build.';
  return null;
}

/** All builds require an HTTPS origin. Never attach bearer credentials to a cleartext URL. */
export function apiOriginProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') return 'The API URL must be an HTTPS origin without credentials, path, query or fragment.';
    return null;
  } catch { return 'The API URL must be a valid HTTPS origin.'; }
}
