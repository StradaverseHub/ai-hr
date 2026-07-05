'use client';

import { useTranslations } from 'next-intl';
import { logoutAction } from '@/app/auth-actions';

/** Explicit logout in the topbar (ADR-0072). Server action clears/revokes the WorkOS session. */
export function LogoutButton() {
  const t = useTranslations('auth');
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {t('logout')}
      </button>
    </form>
  );
}
