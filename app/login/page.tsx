import { keycloakSelected } from '@/lib/identity/config';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { demoSwitcherEnabled, isDemoDeployment } from '@/lib/demo-mode';
import { listPrincipals } from '@/lib/principals';
import { getSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { signOutUnlinkedAction } from '@/app/auth-actions';

/**
 * /login (ADR-0072). In a real deployment this redirects to the WorkOS AuthKit hosted login, so the
 * markup below is only ever seen where there is no WorkOS to redirect to: local development, and the
 * gated consultant demo. Rendered outside the app shell.
 *
 * ⚠️ ON THE DEMO THIS IS NOW THE FRONT DOOR, AND THAT IS THE POINT OF THE PAGE.
 *
 * The demo used to sign every visitor in automatically as the seeded GROUP ADMIN (lib/session.ts fell
 * back to DEV_USER_ID when no cookie was set), so this page was unreachable in normal use and a tester
 * experienced the product only as its most privileged role unless they knew to use the header switcher.
 * `lib/session.ts` now withholds that fallback on the demo, so an unauthenticated visitor lands HERE and
 * CHOOSES which access to test with — then sees exactly what that person sees.
 *
 * ⚠️ CHOOSING AN IDENTITY IS NOT AUTHENTICATION, and nothing here should imply it is. There is no
 * password: the list is the seeded staff of a demo tenant. The security boundary is still the
 * SHARE_PASSWORD gate in middleware.ts, which is why that gate stays until the demo moves to real WorkOS
 * logins. The copy says "demonstration environment" so nobody reads this as a sign-in wall.
 *
 * ⚠️ THE TWO AUDIENCES ARE SEPARATED BY `isDemoDeployment()`, NOT `demoSwitcherEnabled()`. The latter is
 * true for local dev too, where the fallback still applies and this page is a courtesy rather than a
 * gate — so local dev keeps the short note and no identity list.
 */
export default async function LoginPage({ searchParams }: { searchParams?: Promise<{ signedOut?: string }> } = {}) {
  const t = await getTranslations('auth');
  const tCommon = await getTranslations('common');

  // Real deployment → WorkOS hosted login. Dev + gated demo (ALLOW_DEMO_SESSION) → identity switcher.
  if (!demoSwitcherEnabled()) {
    // r390 — with real sign-in, middleware.ts redirects a SIGNED-OUT visitor to AuthKit before this page
    // runs (setting the SDK's PKCE cookie on that redirect; getSignInUrl() here would throw, because it sets
    // a cookie and a Server Component may not). So this branch only ever sees someone signed in at WorkOS:
    // a linked account goes home; a WorkOS login with no AI HR account is told so, and can sign out to use
    // another one. Sending that person home instead looped forever (home → AuthRequiredError → /login).
    try {
      await getSession();
    } catch (e) {
      if (!(e instanceof AuthRequiredError)) throw e;
      let email = '';
      if (keycloakSelected()) {
        const { currentIdentitySession } = await import('@/lib/identity/session');
        const identity = await currentIdentitySession();
        if (!identity) {
          if ((await searchParams)?.signedOut === '1') return (
            <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
              <h1 className="text-2xl font-semibold">{t('login.signedOutTitle')}</h1>
              <p className="text-sm text-muted-foreground">{t('login.signedOutBody')}</p>
              <a href="/login/start" className="rounded-lg bg-primary px-5 py-3 text-primary-foreground">{t('login.title')}</a>
            </main>
          );
          redirect('/login/start');
        }
        email = identity.email ?? '';
      } else {
        const { currentWorkosSession } = await import('@/lib/workos');
        email = (await currentWorkosSession())?.email ?? '';
      }
      return (
        <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-6 py-10">
          <div className="w-full max-w-md rounded-2xl border border-border bg-background p-8 shadow-sm">
            <p className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {tCommon('appName')}
            </p>
            <h1 className="mt-2 text-center text-2xl font-semibold text-foreground">{t('login.notLinkedTitle')}</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground" data-testid="login-not-linked">
              {t('login.notLinkedBody', { email })}
            </p>
            <form action={signOutUnlinkedAction} className="mt-6">
              <button
                type="submit"
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t('login.notLinkedSignOut')}
              </button>
            </form>
          </div>
        </main>
      );
    }
    redirect('/');
  }

  const demo = isDemoDeployment();
  // Only the demo needs the chooser; local dev resolves DEV_USER_ID and never arrives here in normal use.
  const principals = demo ? await listPrincipals() : [];

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-6 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border bg-background p-8 shadow-sm">
        <div className="text-center">
          {/* `common`, NOT `auth`: the brand lives at common.appName, and reading it off `t` would
              resolve auth.appName — a MISSING_MESSAGE that passes tsc, the suite and next build alike. */}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tCommon('appName')}
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-foreground">{t('login.title')}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {demo ? t('login.demoNote') : t('login.devNote')}
          </p>
        </div>

        {demo && principals.length > 0 ? (
          <div className="mt-6 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('login.chooseIdentity')}
            </p>
            {principals.map((p) => (
              // One form per row rather than a select: the ROLE each identity carries is the whole
              // reason to pick it, and a dropdown hides every option but one behind a click.
              // ⚠️ A PLAIN FORM POST TO A ROUTE HANDLER, NOT A SERVER ACTION. The server-action version
              // set the cookie correctly and then navigated without it, so every identity but one bounced
              // straight back here — see app/login/as/route.ts for the measurement. A real POST → 303 →
              // GET stores the cookie before the next request is made.
              <form key={p.userId} method="post" action="/login/as">
                <input type="hidden" name="userId" value={p.userId} />
                <button
                  type="submit"
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-primary/5"
                >
                  <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {p.roles.join(' · ') || t('login.noRole')}
                  </span>
                </button>
              </form>
            ))}
            <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
              {t('login.accessNote')}
            </p>
          </div>
        ) : (
          <a
            href="/"
            className="mt-6 inline-block w-full rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('login.enterApp')}
          </a>
        )}
      </div>
    </main>
  );
}
