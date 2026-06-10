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

export async function getSession(): Promise<SessionContext> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Dev session is not allowed in production — wire WorkOS auth first.');
  }
  const cookieStore = await cookies();
  const cookieUser = cookieStore.get(DEV_COOKIE)?.value;
  const fallback = process.env.DEV_USER_ID;
  let userId = cookieUser || fallback;
  if (!userId) {
    throw new Error('No dev principal. Run `pnpm db:seed`, then pick an identity.');
  }
  const lookup = (id: string) =>
    client<{ tenant_id: string; person_id: string | null; grants: Grant[] }[]>`
      select tenant_id, person_id, grants from app.principal(${id}::uuid)
    `;
  let [principal] = await lookup(userId);
  if (!principal && cookieUser && fallback && cookieUser !== fallback) {
    // Stale dev cookie from a previous seed — self-heal to the default identity
    // instead of crashing every page (the switcher overwrites the cookie on next use).
    [principal] = await lookup(fallback);
    userId = fallback;
  }
  if (!principal) {
    throw new Error(`Unknown principal ${userId} — re-seed or switch identity.`);
  }
  const grants = (principal.grants ?? []) as Grant[];
  return {
    tenantId: principal.tenant_id,
    userId,
    personId: principal.person_id,
    grants,
    roles: Array.from(new Set(grants.map((g) => g.role))),
  };
}
