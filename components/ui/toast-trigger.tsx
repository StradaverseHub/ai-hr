'use client';

import { useCallback, useEffect, useRef } from 'react';
import { hasPendingLegacyScheduleRedirect, legacyScheduleDestinationHash } from '@/lib/legacy-schedule-redirect';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useDatabaseErrorText } from '@/components/database-error-text';

/**
 * Fires a toast when a server action redirects with `?toast=` (success) or `?error=`,
 * then strips the param so it doesn't re-fire. Pair with redirects in server actions.
 */
/**
 * Shows the feedback of `?toast=`, `?error=` and `?approvalSeal=1`. Returns whether there was any. Shared by
 * ToastFromQuery and <ActionNavigateForm>, which shows it before navigating so the page is not drawn twice.
 */
export function useActionFeedbackToast(): (params: URLSearchParams) => boolean {
  // Stable across renders (ToastFromQuery's effect depends on it): the latest copy is read through a ref.
  const databaseErrorText = useDatabaseErrorText();
  const approvedLabel = useTranslations('approvals')('dateStatus.approved');
  const copy = useRef({ databaseErrorText, approved: approvedLabel });
  useEffect(() => { copy.current = { databaseErrorText, approved: approvedLabel }; });
  return useCallback((params: URLSearchParams) => {
    const { databaseErrorText, approved } = copy.current;
    const ok = params.get('toast');
    const err = params.get('error');
    const seal = params.get('approvalSeal') === '1';
    if (!ok && !err && !seal) return false;
    if (ok) toast.success(seal && !err && document.documentElement.dataset.uiTheme === 'atelier'
      ? <span>{ok}<span aria-hidden="true" className="atelier-approval-seal">{approved}</span></span>
      : ok);
    if (err) toast.error(databaseErrorText(err));
    return true;
  }, []);
}

export function ToastFromQuery() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const showFeedback = useActionFeedbackToast();

  useEffect(() => {
    // The legacy destination forwards these values. Consuming them here would race that redirect
    // with a replacement of the old pathname, and could emit the same feedback twice.
    if (hasPendingLegacyScheduleRedirect(pathname, window.location.hash)) return;
    if (!showFeedback(params)) return;
    const next = new URLSearchParams(params.toString());
    next.delete('toast');
    next.delete('error');
    next.delete('approvalSeal');
    const qs = next.toString();
    const hash = legacyScheduleDestinationHash(pathname, window.location.hash);
    router.replace(`${pathname}${qs ? `?${qs}` : ''}${hash}`, { scroll: false });
  }, [params, pathname, router, showFeedback]);

  return null;
}
