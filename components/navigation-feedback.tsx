'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NAVIGATION_START, navigationKind } from '@/lib/navigation-feedback';

export function NavigationFeedback() {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const t = useTranslations('common');
  const [pending, setPending] = useState<ReturnType<typeof navigationKind>>(null);
  const clear = useRef<() => void>(() => {});
  const committed = useRef('');

  useEffect(() => {
    committed.current = pathname + (query ? '?' + query : '');
    clear.current();
  }, [pathname, query]);

  useEffect(() => {
    let delay: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    function reset() {
      clearTimeout(delay);
      clearTimeout(deadline);
      setPending(null);
    }
    clear.current = reset;
    function start(event: Event) {
      const url = (event as CustomEvent<string>).detail;
      if (typeof url !== 'string') return;
      const kind = navigationKind(new URL(committed.current || location.href, location.origin), new URL(url, location.href));
      reset();
      if (!kind) return;
      delay = setTimeout(() => setPending(kind), 120);
      // App Router exposes a start hook but no cancellation event for an abandoned transition.
      deadline = setTimeout(reset, 20_000);
    }
    window.addEventListener(NAVIGATION_START, start);
    window.addEventListener('pageshow', reset);
    return () => {
      clear.current = () => {};
      clearTimeout(delay);
      clearTimeout(deadline);
      window.removeEventListener(NAVIGATION_START, start);
      window.removeEventListener('pageshow', reset);
    };
  }, []);

  return <div className="atelier-navigation-feedback" data-pending={pending ?? undefined} role="status">
    <span className="sr-only">{pending ? t('loading') : ''}</span>
  </div>;
}
