import { getTranslations } from 'next-intl/server';

/**
 * /invite/[token] (ADR-0072). Activation landing for an emailed, single-use invitation. The invitee
 * clicks "Activate", which hands off to ./activate — that page authenticates via WorkOS if needed and
 * then binds the verified subject through app.consume_invitation (core acceptInvitation).
 *
 * This page only carries the opaque token through to the activation step — it never validates or
 * consumes the token itself (consume is single-use and must happen exactly once, server-side, with the
 * verified subject). Rendered outside the app shell.
 *
 * NOTE: this used to link to /callback?invite=… , but the callback never read that parameter, so the
 * invitation was never consumed and no invited user could be bound. The activate route now owns that
 * step; keep the link pointing there.
 */
export default async function InviteActivationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const t = await getTranslations('auth');
  const { token } = await params;
  // Keep the token in the PATH so it survives the WorkOS round trip without a cookie or state param.
  const activateHref = `/invite/${encodeURIComponent(token)}/activate`;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6 text-center">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('invite.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('invite.subtitle')}</p>
      </div>
      <a
        href={activateHref}
        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t('invite.activate')}
      </a>
      <p className="text-xs text-muted-foreground">{t('invite.expiryNote')}</p>
    </main>
  );
}
