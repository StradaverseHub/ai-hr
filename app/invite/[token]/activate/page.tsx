import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { acceptInvitation } from '@/core/auth';
import { InvalidInvitationError } from '@/lib/auth-errors';
import { demoSwitcherEnabled, isDemoDeployment } from '@/lib/demo-mode';

/**
 * /invite/[token]/activate (ADR-0072) — where an invitation actually becomes a login.
 *
 * This page closes a gap: before it, /invite/[token] linked to /callback?invite=…, but the callback
 * never read that parameter and nothing in the app ever called acceptInvitation. The service, the
 * landing page and the SQL all existed; no code path connected them, so no invited user could ever be
 * bound. test/auth.test.ts called acceptInvitation directly, so the suite stayed green.
 *
 * The flow, and why the token round-trips through WorkOS this way:
 *
 *   1. No verified session yet → send the user to AuthKit with returnTo pointing BACK here. The token
 *      stays in the URL path, so it survives the round trip without a cookie or a state parameter, and
 *      without ever being sent to WorkOS as a query value.
 *   2. Returning with a verified session → we now hold BOTH the token (from the path) and a trusted
 *      subject (from WorkOS). That is exactly the pair app.consume_invitation needs, and the earliest
 *      point at which it can be called safely.
 *   3. consume_invitation is single-use and atomic, so a double-click or a refresh cannot bind twice —
 *      the second attempt matches 0 rows and surfaces as an expired/used message.
 *
 * A user who is ALREADY signed in skips step 1 entirely, which is the common case for the bootstrap
 * admin (scripts/auth/bootstrap-invite.ts) and for anyone re-invited to a second role.
 */
export default async function InviteActivatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const t = await getTranslations('auth');
  const { token } = await params;

  // Dev / gated demo: there is no WorkOS to verify against, so activation cannot be completed. Say so
  // plainly rather than throwing an opaque provider error (mirrors how /login handles the same case).
  if (demoSwitcherEnabled()) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-semibold text-foreground">{t('invite.title')}</h1>
        {/* Same split as /login: demoSwitcherEnabled() is true for BOTH local dev and the gated demo,
            and telling a prospect they are on a "development build" is wrong on the demo. */}
        <p className="text-sm text-muted-foreground">
          {isDemoDeployment() ? t('invite.demoNote') : t('invite.devNote')}
        </p>
        <a
          href="/"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('login.enterApp')}
        </a>
      </main>
    );
  }

  const { currentWorkosSession } = await import('@/lib/workos');
  const session = await currentWorkosSession();

  // Not signed in yet → authenticate first, then come straight back here with the token intact.
  if (!session) {
    const returnTo = `/invite/${encodeURIComponent(token)}/activate`;
    redirect(`/login/workos?returnTo=${encodeURIComponent(returnTo)}`);
  }

  try {
    await acceptInvitation({ token, subject: session.subject });
  } catch (e) {
    if (e instanceof InvalidInvitationError) {
      return (
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-semibold text-foreground">{t('invite.invalidTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('invite.invalidBody')}</p>
          <a
            href="/login"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('reset.backToLogin')}
          </a>
        </main>
      );
    }
    throw e; // anything else is a real fault — let the error boundary surface it
  }

  // Bound. The next request resolves a full session via app.principal_by_subject.
  redirect('/');
}
