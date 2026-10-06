import { handleAuth } from '@workos-inc/authkit-nextjs';
import { recordLoginBlocked, recordLoginSucceeded } from '@/core/auth';
import { appOrigin } from '@/lib/real-auth';

/**
 * WorkOS OAuth callback (ADR-0072). handleAuth() exchanges the `code`, seals the session cookie, and
 * redirects into the app. onSuccess fires with the verified WorkOS user; we resolve it to our internal
 * app_user (app.principal_by_subject) and append app-user.logged-in via the SECURITY DEFINER auth-audit
 * writer (best-effort — a failed audit must never block a valid login).
 *
 * A subject that maps to NO app_user — never invited, archived, or a leaver whose employments have all
 * ended (0279) — appends app-user.login-blocked instead, so a rejection with otherwise-valid credentials
 * leaves an auditable trace rather than vanishing into the catch below. Either way, on the next request
 * getSession() fails closed to /login (ADR-0072 step 4).
 *
 * This route is a handler (no layout), so it is not affected by the app-shell session gate.
 */
export const GET = handleAuth({
  returnPathname: '/',
  // r390 — behind the Cloudflare tunnel this route sees http://127.0.0.1:3000, so the post-sign-in redirect
  // must be built on the PUBLIC origin (from NEXT_PUBLIC_WORKOS_REDIRECT_URI), or the browser is sent to a
  // localhost address it cannot reach.
  baseURL: appOrigin(),
  onSuccess: async ({ user }) => {
    try {
      const { client } = await import('@/db/client');
      const rows = await client<{ app_user_id: string; tenant_id: string }[]>`
        select app_user_id, tenant_id from app.principal_by_subject(${user.id})
      `;
      const resolved = rows[0];
      if (resolved) {
        await recordLoginSucceeded({ tenantId: resolved.tenant_id, userId: resolved.app_user_id });
      } else {
        await recordLoginBlocked({ subject: user.id });
      }
    } catch {
      // Never block a valid login on an audit-write failure.
    }
  },
});
