import { handleAuth } from '@workos-inc/authkit-nextjs';
import { recordLoginSucceeded } from '@/core/auth';

/**
 * WorkOS OAuth callback (ADR-0072). handleAuth() exchanges the `code`, seals the session cookie, and
 * redirects into the app. onSuccess fires with the verified WorkOS user; we resolve it to our internal
 * app_user (app.principal_by_subject) and append app-user.logged-in via the SECURITY DEFINER auth-audit
 * writer (best-effort — a failed audit must never block a valid login). The subject that maps to no
 * app_user (e.g. someone who authenticated but was never invited) simply gets no login event here and,
 * on the next request, getSession() fails closed to /login (ADR-0072 step 4).
 *
 * This route is a handler (no layout), so it is not affected by the app-shell session gate.
 */
export const GET = handleAuth({
  returnPathname: '/',
  onSuccess: async ({ user }) => {
    try {
      const { client } = await import('@/db/client');
      const rows = await client<{ app_user_id: string; tenant_id: string }[]>`
        select app_user_id, tenant_id from app.principal_by_subject(${user.id})
      `;
      const resolved = rows[0];
      if (resolved) {
        await recordLoginSucceeded({ tenantId: resolved.tenant_id, userId: resolved.app_user_id });
      }
    } catch {
      // Never block a valid login on an audit-write failure.
    }
  },
});
