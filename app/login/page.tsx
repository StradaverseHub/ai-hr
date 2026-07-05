import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { demoSwitcherEnabled } from '@/lib/demo-mode';

/**
 * /login (ADR-0072). In production this redirects to the WorkOS AuthKit hosted login. In dev the app
 * uses the identity switcher instead of a real login, so we show a short note + a link back to the app
 * (the dev shell resolves the seeded principal automatically). Rendered outside the app shell.
 */
export default async function LoginPage() {
  const t = await getTranslations('auth');

  // Real deployment → WorkOS hosted login. Dev + gated demo (ALLOW_DEMO_SESSION) → identity switcher.
  if (!demoSwitcherEnabled()) {
    const { signInUrl } = await import('@/lib/workos');
    redirect(await signInUrl('/'));
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold text-foreground">{t('login.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('login.devNote')}</p>
      <a
        href="/"
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t('login.enterApp')}
      </a>
    </main>
  );
}
