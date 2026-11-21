'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function WorkerDetails({ label, initiallyOpen, children }: {
  label: string;
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    // Next links can scroll programmatically. Open the disclosure before scrolling to an existing bookmark.
    const reveal = (hash: string) => {
      const target = document.getElementById(hash.slice(1));
      if (!target || !disclosure.current?.contains(target) || disclosure.current.open) return null;
      disclosure.current.open = true;
      return target;
    };
    const showCurrentFragment = () => reveal(window.location.hash)?.scrollIntoView?.();
    const handleLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!(link instanceof HTMLAnchorElement) || !link.hash || link.origin !== window.location.origin ||
        link.pathname !== window.location.pathname) return;
      reveal(link.hash);
    };

    showCurrentFragment();
    window.addEventListener('hashchange', showCurrentFragment);
    document.addEventListener('click', handleLink, true);
    return () => {
      window.removeEventListener('hashchange', showCurrentFragment);
      document.removeEventListener('click', handleLink, true);
    };
  }, []);

  return <details ref={disclosure} data-ai-worker-details open={initiallyOpen || undefined}>
    <summary className="min-h-11 cursor-pointer rounded-md px-2 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {label}
    </summary>
    <div className="space-y-5 pt-2">{children}</div>
  </details>;
}
