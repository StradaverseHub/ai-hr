import { cookies } from 'next/headers';
import { client, type Grant, type SessionContext } from '../db/client';

/**
 * DEV-ONLY session shim. Real sessions will come from WorkOS (next slice).
 *
 * Production-guarded: throws if NODE_ENV is 'production', so it can never silently become an
 * auth bypass. The active principal is selected by the `dev_user` cookie (set by the dev
 * identity switcher), defaulting to the seeded admin (DEV_USER_ID). The principal's tenant,
 * person, and roles are resolved from the DB via the SECURITY DEFINER `app.principal()` seam —
 * the SAME bootstrap WorkOS will use (keyed by workos_user_id instead of the internal id).
 *
 * When WorkOS lands, only this function changes: it verifies the session token, maps to an
 * app_user, and calls the same resolver. Every page/action keeps calling getSession() unchanged.
 */
const DEV_COOKIE = 'dev_user';

/** A row from `app.principal()` — `grants` may be null (defensively typed). */
type PrincipalRow = { tenant_id: string; person_id: string | null; grants: Grant[] | null };

/**
 * Resolve a dev principal id to a SessionContext, tolerant of stale/unknown ids. Tries the cookie
 * user first, then the configured fallback (DEV_USER_ID), and returns the FIRST that resolves — so a
 * stale `dev_user` cookie (a previous seed's id, or a since-deleted user) self-heals to the default
 * identity instead of throwing an uncaught `TypeError: ... reading 'grants'` on every request. Only
 * when no candidate id resolves at all (e.g. the DB isn't seeded) does it throw a CLEAR, typed error.
 *
 * Pure + injectable (`lookup`) so the unknown-id path is unit-testable without a request context.
 */
export async function resolveDevPrincipal(
  lookup: (id: string) => Promise<PrincipalRow[]>,
  cookieUser: string | undefined,
  fallback: string | undefined,
): Promise<SessionContext> {
  const ids = [...new Set([cookieUser, fallback].filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) {
    throw new Error('No dev principal. Run `pnpm db:seed`, then pick an identity.');
  }
  for (const id of ids) {
    const [principal] = await lookup(id);
    if (principal) {
      const grants = (principal.grants ?? []) as Grant[];
      return {
        tenantId: principal.tenant_id,
        userId: id,
        personId: principal.person_id,
        grants,
        roles: Array.from(new Set(grants.map((g) => g.role))),
      };
    }
  }
  throw new Error(
    `No valid dev principal (tried ${ids.join(', ')}) — run \`pnpm db:seed\`, then pick an identity.`,
  );
}

export async function getSession(): Promise<SessionContext> {
  // In production the dev session is an auth bypass, so it's blocked — UNLESS this is an explicitly
  // opted-in gated demo (ALLOW_DEMO_SESSION=true, behind the SHARE_PASSWORD gate; see HOSTING.md).
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SESSION !== 'true') {
    throw new Error(
      'Dev session is not allowed in production — set ALLOW_DEMO_SESSION=true for a gated demo, or wire WorkOS auth.',
    );
  }
  const cookieStore = await cookies();
  const cookieUser = cookieStore.get(DEV_COOKIE)?.value;
  const fallback = process.env.DEV_USER_ID;
  const lookup = (id: string) =>
    client<PrincipalRow[]>`
      select tenant_id, person_id, grants from app.principal(${id}::uuid)
    `;
  return resolveDevPrincipal(lookup, cookieUser, fallback);
}
