import { NextRequest } from 'next/server';
import { keycloakSelected } from '@/lib/identity/config';
import { completeKeycloakLogin } from '@/lib/identity/login';
import { handleAuth } from '@workos-inc/authkit-nextjs';
import { recordLoginBlocked, recordLoginSucceeded } from '@/core/auth';
import { appOrigin } from '@/lib/real-auth';
import { getTranslations } from 'next-intl/server';

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
const workosCallback = handleAuth({
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
  // r390 — a callback that cannot complete (a stale or reused link, the sign-in opened in another browser so
  // its verifier cookie is missing, a cancelled sign-in) used to end in the SDK's bare 500. Say what happened
  // and offer a fresh start. Not a redirect to /login: if the cause persists, that would loop through AuthKit.
  // The SDK has already logged the error as '[AuthKit callback error]' before calling this.
  onError: async () => {
    const t = await getTranslations('auth');
    const retry = `${appOrigin() ?? ''}/login`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(t('callbackFailedTitle'))}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5">` +
      `<h1 style="font-size:1.4rem">${escapeHtml(t('callbackFailedTitle'))}</h1><p>${escapeHtml(t('callbackFailedBody'))}</p>` +
      `<p><a href="${escapeHtml(retry)}">${escapeHtml(t('callbackRetry'))}</a></p></body></html>`;
    return new Response(html, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  },
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function GET(request: NextRequest) {
  return keycloakSelected() ? completeKeycloakLogin(request) : workosCallback(request);
}
