import Link from 'next/link';
import { Bell } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

/**
 * Topbar notification bell (consultant feedback #11). A link to the Approvals inbox with a red badge
 * showing the number of pending actions awaiting the user. Rendered only for managers/admins (the
 * only roles with an approvals queue); the badge is hidden at zero.
 */
export async function NotificationBell({ count }: { count: number }) {
  const t = await getTranslations('nav');
  const label = count > 0 ? `${t('notifications')} (${count})` : t('notifications');
  return (
    <Link
      href="/approvals"
      aria-label={label}
      title={label}
      className="relative inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Bell className="size-[18px]" />
      {count > 0 && (
        <span className="absolute right-1 top-1 inline-flex min-w-[15px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-[15px] text-white">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
