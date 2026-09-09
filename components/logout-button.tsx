'use client';

import { useTranslations } from 'next-intl';
import { logoutAction } from '@/app/auth-actions';
import { cn } from '@/lib/utils';

/**
 * Explicit logout (ADR-0072). Server action clears/revokes the WorkOS session.
 *
 * fbf6abd0 — IT MOVED INTO THE ACCOUNT MENU and is no longer a bare control beside the theme toggle.
 * The button itself is unchanged (same form, same server action); only its dressing varies, so the one
 * place that knows how to end a session stays one place. `variant="menu"` is the full-width row the
 * dropdown renders; the default keeps the old inline topbar look for any other caller.
 */
export function LogoutButton({ variant = 'inline' }: { variant?: 'inline' | 'menu' } = {}) {
  const t = useTranslations('auth');
  const menu = variant === 'menu';
  return (
    <form action={logoutAction} className={cn(menu && 'block')}>
      <button
        type="submit"
        role={menu ? 'menuitem' : undefined}
        className={cn(
          'rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
          menu
            ? 'flex w-full items-center px-2 py-1.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground'
            : 'px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground',
        )}
      >
        {t('logout')}
      </button>
    </form>
  );
}
