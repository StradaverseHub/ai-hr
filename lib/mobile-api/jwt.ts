/**
 * WorkOS access-token verification for the mobile API (ADR-0088 §1).
 *
 * The web never needs this: AuthKit verifies its own cookie inside `withAuth()`. The native app instead
 * holds a WorkOS access token obtained through PKCE and sends it as `Authorization: Bearer`, so the
 * server has to verify that token itself before `principal_by_subject` may resolve its `sub`.
 *
 * WHY node:crypto AND NOT `jose`. `jose` is in the tree only as a transitive dependency of
 * @workos-inc/authkit-nextjs (not hoisted, not declared), so importing it would work by accident or not
 * at all. The verification needed here is narrow enough to state completely:
 *
 *   • ONE algorithm, RS256 — named in the token header AND, when present, on the key. `alg: none`, HS256
 *     (the classic public-key-as-HMAC-secret confusion) and every other value are refused before any key
 *     is touched.
 *   • The key is chosen by `kid` from the WorkOS JWKS for THIS deployment's client id
 *     (`https://api.workos.com/sso/jwks/<clientId>`, workos.com/docs/user-management/sessions, read
 *     2026-09-30). A token signed for another WorkOS client finds no key and is refused.
 *   • `exp` is REQUIRED and enforced; `nbf` is enforced when present; both with 30 s of skew.
 *   • `sub` is REQUIRED — it is the only claim the caller consumes.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, AND WHY. `iss` and `aud`. The WorkOS docs read for this change do
 * not state their values for AuthKit access tokens, and @workos-inc/authkit-nextjs — the verifier the WEB
 * path already trusts — checks neither (`jwtVerify(accessToken, JWKS())`, dist/esm/session.js). Guessing
 * a value would lock every user out the day the guess is wrong; the client-scoped JWKS is what binds a
 * token to this deployment. If WorkOS documents them, add them here and pin them in the test.
 *
 * Everything that fails throws `AuthRequiredError` (a 401 to the app, i.e. "sign in again"), EXCEPT a
 * JWKS fetch failure, which throws `JwksUnavailableError` so the handler can answer 503 ("try again")
 * instead of signing an employee out because WorkOS was briefly unreachable.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { AuthRequiredError } from '../auth-errors';

export type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };
export type JwksSource = (opts: { refresh: boolean }) => Promise<Jwk[]>;
export type VerifiedAccessToken = { subject: string; sessionId: string | null; expiresAt: number };

/** The JWKS could not be fetched — an availability fault, not a credential fault. */
export class JwksUnavailableError extends Error {
  constructor(cause: string) {
    super(`WorkOS signing keys are unavailable: ${cause}`);
    this.name = 'JwksUnavailableError';
  }
}

const SKEW_SECONDS = 30;

/** `Authorization: Bearer <token>` → the token, else null. The scheme is case-insensitive (RFC 7235). */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)[ ]*$/i.exec(header);
  return m ? m[1] : null;
}

function decodeSegment(seg: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    throw new AuthRequiredError('Malformed access token.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AuthRequiredError('Malformed access token.');
  }
  return parsed as Record<string, unknown>;
}

function pickKey(keys: Jwk[], kid: string): Jwk | undefined {
  return keys.find(
    (k) =>
      k.kid === kid &&
      k.kty === 'RSA' &&
      (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === 'RS256'),
  );
}

/**
 * Verify a WorkOS access token. Pure apart from `jwks`; `now` (epoch seconds) is injectable so expiry is
 * tested against a fixed clock rather than a sleep.
 */
export async function verifyAccessToken(
  token: string,
  opts: { jwks: JwksSource; now?: number },
): Promise<VerifiedAccessToken> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new AuthRequiredError('Malformed access token.');
  const [h, p, s] = parts;

  const header = decodeSegment(h);
  if (header.alg !== 'RS256') throw new AuthRequiredError('Unsupported access-token algorithm.');
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw new AuthRequiredError('Access token has no key id.');
  const kid = header.kid;

  let key = pickKey(await opts.jwks({ refresh: false }), kid);
  // Key rotation: an unknown kid gets ONE refetch (the source rate-limits it), then a refusal.
  if (!key) key = pickKey(await opts.jwks({ refresh: true }), kid);
  if (!key) throw new AuthRequiredError('Access token was not signed by a known key.');

  let ok = false;
  try {
    const publicKey = createPublicKey({ key, format: 'jwk' });
    ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthRequiredError('Access token signature is invalid.');

  const claims = decodeSegment(p);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number') throw new AuthRequiredError('Access token has no expiry.');
  if (now >= claims.exp + SKEW_SECONDS) throw new AuthRequiredError('Access token has expired.');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + SKEW_SECONDS < claims.nbf)) {
    throw new AuthRequiredError('Access token is not valid yet.');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new AuthRequiredError('Access token has no subject.');

  return {
    subject: claims.sub,
    sessionId: typeof claims.sid === 'string' ? claims.sid : null,
    expiresAt: claims.exp,
  };
}

// ── The production JWKS source ──────────────────────────────────────────────────────────────────────

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFRESH_MS = 60_000;
const JWKS_TIMEOUT_MS = 5_000;

type CacheEntry = { keys: Jwk[]; fetchedAt: number };
const jwksCache = new Map<string, CacheEntry>();

/**
 * The WorkOS JWKS for one client id, cached for 10 minutes. A forced refresh (unknown `kid`) is honoured
 * at most once a minute, so a stream of forged kids cannot turn this server into a WorkOS load generator.
 */
export function workosJwks(clientId: string, fetchImpl: typeof fetch = fetch): JwksSource {
  const url = `https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`;
  return async ({ refresh }) => {
    const cached = jwksCache.get(url);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age < JWKS_TTL_MS && (!refresh || age < JWKS_MIN_REFRESH_MS)) return cached.keys;
    let body: unknown;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      // A stale key set is still the right key set far more often than no key set: serve it through an
      // outage rather than refusing every signed-in employee.
      if (cached) return cached.keys;
      throw new JwksUnavailableError(e instanceof Error ? e.message : String(e));
    }
    const keys = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(keys)) {
      if (cached) return cached.keys;
      throw new JwksUnavailableError('response has no keys array');
    }
    const entry = { keys: keys as Jwk[], fetchedAt: Date.now() };
    jwksCache.set(url, entry);
    return entry.keys;
  };
}
