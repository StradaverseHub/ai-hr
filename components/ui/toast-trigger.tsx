'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
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

  useEffect(() => {
    const ok = params.get('toast');
    const err = params.get('error');
    if (!ok && !err) return;
    if (ok) toast.success(ok);
    if (err) toast.error(databaseErrorText(err));
    const next = new URLSearchParams(params.toString());
    next.delete('toast');
    next.delete('error');
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [params, pathname, router]);

  return null;
}
