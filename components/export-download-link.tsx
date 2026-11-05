'use client';

import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { exportFilename } from '@/lib/export-download';

type Props = ComponentPropsWithoutRef<'a'> & { href: string };

/** Use with same-origin report endpoints that return Content-Disposition: attachment. */
export const ExportDownloadLink = forwardRef<HTMLAnchorElement, Props>(function ExportDownloadLink(
  { children, onClick, href, ...props }, ref,
) {
  const common = useTranslations('common');
  const report = useTranslations('letters.reports');
  const errors = useTranslations('labelExcelRoundTrip');
  const [phase, setPhase] = useState<'requesting' | 'receiving' | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  return <a {...props} ref={ref} href={href} aria-busy={phase !== null} aria-disabled={phase !== null}
    data-action-pending={phase !== null || undefined} onClick={async event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        (props.target && props.target !== '_self')) return;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return;
      event.preventDefault();
      if (running.current) return;
      const controller = new AbortController();
      running.current = controller;
      setPhase('requesting');
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
        const name = exportFilename(response.headers.get('content-disposition'));
        if (!response.ok || !name) throw new Error('Export did not return an attachment');
        setPhase('receiving');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = name;
        document.body.append(link);
        try { link.click(); } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        }
        toast.success(name);
      } catch {
        if (!controller.signal.aborted) toast.error(errors('downloadFailed'));
      } finally {
        running.current = null;
        if (!controller.signal.aborted) setPhase(null);
      }
    }}>
    {children}
    <span className="sr-only" role="status">{phase === 'requesting' ? report('working') : phase === 'receiving' ? common('loading') : ''}</span>
  </a>;
});
