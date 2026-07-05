import { getTranslations } from 'next-intl/server';

/**
 * /invite/[token] (ADR-0072). Activation landing for an emailed, single-use invitation. The invitee
 * clicks "Activate", which sends them into WorkOS to set their password; on return, the callback binds
 * the verified WorkOS subject to the invitation via app.consume_invitation (core acceptInvitation).
 *
 * This page only carries the opaque token through to the activation step — it never validates or
 * consumes the token itself (consume is single-use and must happen exactly once, server-side, with the
 * verified subject). Rendered outside the app shell.
 */
export default async function InviteActivationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const t = await getTranslations('auth');
  const { token } = await params;
  // Carry the token to the callback so the post-WorkOS step can bind subject → invitation.
  const activateHref = `/callback?invite=${encodeURIComponent(token)}`;

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
