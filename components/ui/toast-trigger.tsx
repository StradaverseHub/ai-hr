'use client';

import { useEffect } from 'react';
import { hasPendingLegacyScheduleRedirect, legacyScheduleDestinationHash } from '@/lib/legacy-schedule-redirect';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useDatabaseErrorText } from '@/components/database-error-text';
import { CLIENT_SUCCESS_NOTICE } from '@/lib/navigation-feedback';

/**
 * Fires a toast when a server action redirects with `?toast=` (success) or `?error=`,
 * then strips the param so it doesn't re-fire. Use successNotice for feedback consumed
 * exclusively by the client, where removing it does not require rerendering the route.
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
    const showSuccess = (message: string, seal: boolean) => {
      toast.success(seal && document.documentElement.dataset.uiTheme === 'atelier'
        ? <span>{message}<span aria-hidden="true" className="atelier-approval-seal">{approved}</span></span>
        : message);
    };
    const ok = params.get('toast');
    const err = params.get('error');
    const seal = params.get('approvalSeal') === '1';
    const notice = params.get(CLIENT_SUCCESS_NOTICE);
    if (notice && !ok && !err) {
      const current = new URL(window.location.href);
      // Another mounted consumer or a newer navigation may already have replaced this URL.
      if (current.pathname !== pathname || current.searchParams.get(CLIENT_SUCCESS_NOTICE) !== notice) return;
      const showSeal = current.searchParams.get('approvalSeal') === '1';
      current.searchParams.delete(CLIENT_SUCCESS_NOTICE);
      current.searchParams.delete('approvalSeal');
      window.history.replaceState(null, '', current.pathname + current.search + current.hash);
      showSuccess(notice, showSeal);
      return;
    }
    if (!ok && !err && !seal) return;
    if (ok) showSuccess(ok, seal && !err);
    if (err) toast.error(databaseErrorText(err));
    const next = new URLSearchParams(params.toString());
    next.delete('toast');
    next.delete('error');
    next.delete('approvalSeal');
    next.delete(CLIENT_SUCCESS_NOTICE);
    const qs = next.toString();
    const hash = legacyScheduleDestinationHash(pathname, window.location.hash);
    router.replace(`${pathname}${qs ? `?${qs}` : ''}${hash}`, { scroll: false });
  }, [params, pathname, router, approved]);

  return null;
}
