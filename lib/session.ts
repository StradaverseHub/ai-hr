import type { SessionContext } from '../db/client';

/**
 * DEV-ONLY session shim. Real sessions will come from WorkOS (next slice).
 *
 * This is production-guarded: it throws if NODE_ENV is 'production', so it can never
 * silently become an auth bypass. It returns a seeded admin session — run `pnpm db:seed`,
 * which sets DEV_TENANT_ID / DEV_USER_ID in .env.local.
 *
 * When WorkOS lands, this is the single seam that changes: getSession() reads the verified
 * session instead of env, and every server action/page keeps calling it unchanged.
 */
export async function getSession(): Promise<SessionContext> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Dev session is not allowed in production — wire WorkOS auth first.');
  }
  const tenantId = process.env.DEV_TENANT_ID;
  const userId = process.env.DEV_USER_ID;
  if (!tenantId || !userId) {
    throw new Error('DEV_TENANT_ID / DEV_USER_ID are not set. Run `pnpm db:seed`.');
  }
  return { tenantId, userId, roles: ['hr_admin'] };
}
