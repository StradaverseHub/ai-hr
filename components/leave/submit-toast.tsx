'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

/**
 * Turns the `?toast=leaveSubmitted` marker that `requestLeaveAction` redirects with into the top-right
 * toast the reporter asked for (feedback 45c781e2).
 *
 * WHY A URL MARKER AND NOT A CLIENT CALLBACK. The submit is a server action ending in `redirect()`, so the
 * page is torn down and rebuilt — anything raised in the dialog's `onSubmit` would be destroyed before it
 * rendered. Worse, `onSubmit` fires when the form is SENT, not when it succeeds, so a toast there would
 * congratulate the employee on a submission the server may be about to reject. The marker is set on the
 * line after the service call returns, so it cannot appear for a failed request; failures already redirect
 * to `?error=`, which the page renders as a banner.
 *
 * The param is STRIPPED once shown. Without that, refreshing (or using the back button) re-fires the toast
 * for a submission made minutes ago, which is exactly the kind of thing that trains people to ignore
 * confirmations. `replace` rather than `push` so the cleaned URL does not add a history entry of its own.
 *
 * `firedRef` guards React's development double-invoke of effects, which would otherwise show the toast
 * twice on every submission in dev and make it look like two requests were created.
 */
export function LeaveSubmitToast() {
  const t = useTranslations('leave');
  const router = useRouter();
  const params = useSearchParams();
  const firedRef = useRef(false);

  useEffect(() => {
    if (params.get('toast') !== 'leaveSubmitted' || firedRef.current) return;
    firedRef.current = true;
    toast.success(t('submittedToast'));

    const next = new URLSearchParams(params.toString());
    next.delete('toast');
    const qs = next.toString();
    router.replace(qs ? `/leave?${qs}` : '/leave', { scroll: false });
  }, [params, router, t]);

  return null;
}
