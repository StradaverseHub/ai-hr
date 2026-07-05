import { getTranslations } from 'next-intl/server';
import { requestPasswordResetAction } from '../auth-actions';

/**
 * /reset-password (ADR-0072). Thin over WorkOS: collect the email, trigger the WorkOS reset email.
 * We never reveal whether the email exists — after submit we always show the same "check your inbox"
 * confirmation (?sent=1). WorkOS owns the reset token + the set-new-password page. Rendered outside
 * the app shell.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const t = await getTranslations('auth');
  const { sent } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold text-foreground">{t('reset.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('reset.subtitle')}</p>
      </div>

      {sent ? (
        <p className="rounded-md border border-border bg-muted/50 px-4 py-3 text-center text-sm text-muted-foreground">
          {t('reset.sent')}
        </p>
      ) : (
        <form action={requestPasswordResetAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('reset.emailLabel')}</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            />
          </label>
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('reset.submit')}
          </button>
        </form>
      )}

      <a href="/login" className="text-center text-xs text-muted-foreground hover:text-foreground">
        {t('reset.backToLogin')}
      </a>
    </main>
  );
}
