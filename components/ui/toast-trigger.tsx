'use client';

import { useEffect } from 'react';
import { hasPendingLegacyScheduleRedirect, legacyScheduleDestinationHash } from '@/lib/legacy-schedule-redirect';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useDatabaseErrorText } from '@/components/database-error-text';

/**
 * Fires a toast when a server action redirects with `?toast=` (success) or `?error=`,
 * then strips the param so it doesn't re-fire. Pair with redirects in server actions.
 */
export function ToastFromQuery() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const databaseErrorText = useDatabaseErrorText();
  const approved = useTranslations('approvals')('dateStatus.approved');

  useEffect(() => {
    // The legacy destination forwards these values. Consuming them here would race that redirect
    // with a replacement of the old pathname, and could emit the same feedback twice.
    if (hasPendingLegacyScheduleRedirect(pathname, window.location.hash)) return;
    const ok = params.get('toast');
    const err = params.get('error');
    const seal = params.get('approvalSeal') === '1';
    if (!ok && !err && !seal) return;
    if (ok) toast.success(seal && !err && document.documentElement.dataset.uiTheme === 'atelier'
      ? <span>{ok}<span aria-hidden="true" className="atelier-approval-seal">{approved}</span></span>
      : ok);
    if (err) toast.error(databaseErrorText(err));
    const next = new URLSearchParams(params.toString());
    next.delete('toast');
    next.delete('error');
    next.delete('approvalSeal');
    const qs = next.toString();
    const hash = legacyScheduleDestinationHash(pathname, window.location.hash);
    router.replace(`${pathname}${qs ? `?${qs}` : ''}${hash}`, { scroll: false });
  }, [params, pathname, router, approved]);

  return null;
}
