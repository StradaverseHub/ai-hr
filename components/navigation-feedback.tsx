'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NAVIGATION_START, navigationKind } from '@/lib/navigation-feedback';

export function NavigationFeedback() {
  const pathname = usePathname();
  const query = useSearchParams()?.toString() ?? '';
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
    function show(kind: ReturnType<typeof navigationKind>) {
      reset();
      if (!kind) return;
      delay = setTimeout(() => setPending(kind), 120);
      // App Router exposes a start hook but no cancellation event for an abandoned transition.
      deadline = setTimeout(reset, 20_000);
    }
    function start(event: Event) {
      const url = (event as CustomEvent<string>).detail;
      if (typeof url !== 'string') return;
      show(navigationKind(new URL(committed.current || location.href, location.origin), new URL(url, location.href)));
    }
    function nativeFilter(event: SubmitEvent) {
      if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      const submitter = event.submitter;
      const method = submitter?.getAttribute('formmethod') ?? form.method;
      const target = submitter?.getAttribute('formtarget') ?? form.target;
      if (method.toLowerCase() !== 'get' || (target && target !== '_self')) return;
      const destination = new URL(submitter?.getAttribute('formaction') ?? form.action, location.href);
      if (destination.origin !== location.origin) return;
      show(destination.pathname === location.pathname ? 'filter' : 'navigate');
    }
    window.addEventListener(NAVIGATION_START, start);
    window.addEventListener('pageshow', reset);
    document.addEventListener('submit', nativeFilter);
    return () => {
      clear.current = () => {};
      clearTimeout(delay);
      clearTimeout(deadline);
      window.removeEventListener(NAVIGATION_START, start);
      window.removeEventListener('pageshow', reset);
      document.removeEventListener('submit', nativeFilter);
    };
  }, []);

  return <div className="atelier-navigation-feedback" data-pending={pending ?? undefined} role="status">
    <span className="sr-only">{pending ? t('loading') : ''}</span>
  </div>;
}
