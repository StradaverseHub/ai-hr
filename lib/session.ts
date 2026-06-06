import { cookies } from 'next/headers';
import { client, type SessionContext } from '../db/client';

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
  const userId = cookieStore.get(DEV_COOKIE)?.value || process.env.DEV_USER_ID;
  if (!userId) {
    throw new Error('No dev principal. Run `pnpm db:seed`, then pick an identity.');
  }
  const rows = await client<{ tenant_id: string; person_id: string | null; roles: string[] }[]>`
    select tenant_id, person_id, roles from app.principal(${userId}::uuid)
  `;
  const principal = rows[0];
  if (!principal) {
    throw new Error(`Unknown principal ${userId} — re-seed or switch identity.`);
  }
  return {
    tenantId: principal.tenant_id,
    userId,
    personId: principal.person_id,
    roles: principal.roles,
  };
}
