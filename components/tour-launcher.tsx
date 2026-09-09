'use client';

import { useTranslations } from 'next-intl';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { START_TOUR_EVENT } from '@/lib/onboarding-tour';

/**
 * Help control: (re)starts the onboarding tour from anywhere.
 *
 * r256 — IT MOVED INTO THE ACCOUNT MENU and is no longer a bare icon beside the theme toggle. The
 * topbar's right cluster is a fixed budget (see app/layout.tsx): at a 1280px viewport its track is
 * 308px, and with this button still in it the signed-in person's name and Employee ID measured ZERO
 * pixels wide. This was also the control the cluster was already squeezing — it rendered 20px wide
 * instead of 36 at 1280 and 1440, its icon clipped — so it was both the cheapest thing to move and
 * the thing least well served by staying.
 *
 * Same button, same event, only its dressing varies (the precedent is LogoutButton's `menu` variant,
 * which moved for the same reason): `variant="menu"` is the full-width dropdown row, the default keeps
 * the icon for any other caller. `onSelect` lets the menu close itself BEFORE the tour starts, so the
 * tour's first spotlight is not sitting under an open popover.
 */
export function TourLauncher({
  variant = 'icon',
  onSelect,
}: { variant?: 'icon' | 'menu'; onSelect?: () => void } = {}) {
  const t = useTranslations('onboarding');
  const menu = variant === 'menu';
  return (
    <button
      type="button"
      role={menu ? 'menuitem' : undefined}
      aria-label={menu ? undefined : t('launch')}
      title={menu ? undefined : t('launch')}
      onClick={() => {
        onSelect?.();
        window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
      }}
      className={cn(
        'transition-colors',
        menu
          ? 'flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground hover:bg-muted'
          : 'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {menu ? t('launch') : <HelpCircle className="size-5" />}
    </button>
  );
}
