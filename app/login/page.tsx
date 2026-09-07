import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { demoSwitcherEnabled, isDemoDeployment } from '@/lib/demo-mode';

/**
 * /login (ADR-0072). In a real deployment this redirects to the WorkOS AuthKit hosted login, so the
 * markup below is only ever seen where there is no WorkOS to redirect to: local development, and the
 * gated consultant demo. Rendered outside the app shell.
 *
 * ⚠️ THOSE TWO CASES ARE NOT THE SAME AUDIENCE, AND SAYING SO IS THE POINT OF THIS FILE'S FIX.
 * `demoSwitcherEnabled()` is true for BOTH, and this page used it to print one sentence:
 * "This is a development build — the identity switcher is used instead of a real login." On the gated
 * demo that sentence was served to prospects, and it is wrong twice over — the demo is a production
 * build, and "development build" is the last thing someone evaluating the product should read on the
 * page they land on. Measured on production 2026-09-07: that is exactly what /login returned.
 *
 * `lib/demo-mode.ts` already carries the predicate that separates them and its header says the
 * difference "is the entire point of having a second predicate". So: `isDemoDeployment()` picks the
 * demo wording, and a developer running `pnpm dev` still gets the developer wording.
 */
export default async function LoginPage() {
  const t = await getTranslations('auth');
  const tCommon = await getTranslations('common');

  // Real deployment → WorkOS hosted login. Dev + gated demo (ALLOW_DEMO_SESSION) → identity switcher.
  if (!demoSwitcherEnabled()) {
    const { signInUrl } = await import('@/lib/workos');
    redirect(await signInUrl('/'));
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-6 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border bg-background p-8 text-center shadow-sm">
        {/* The product's own name, so the front door does not read as an untitled page. `common`, NOT
            `auth`: the brand lives at common.appName, and reading it off `t` would resolve auth.appName
            — a MISSING_MESSAGE that passes tsc, the suite and next build alike. */}
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {tCommon('appName')}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">{t('login.title')}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {isDemoDeployment() ? t('login.demoNote') : t('login.devNote')}
        </p>
        <a
          href="/"
          className="mt-6 inline-block w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('login.enterApp')}
        </a>
      </div>
    </main>
  );
}
