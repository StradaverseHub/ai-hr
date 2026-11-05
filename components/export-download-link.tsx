'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { useExportDownload } from './use-export-download';

type Props = ComponentPropsWithoutRef<'a'> & { href: string };

/** Use with same-origin report endpoints that return Content-Disposition: attachment. */
export const ExportDownloadLink = forwardRef<HTMLAnchorElement, Props>(function ExportDownloadLink(
  { children, onClick, href, ...props }, ref,
) {
  const { download, pending, status } = useExportDownload();

  return <a {...props} ref={ref} href={href} aria-busy={pending} aria-disabled={pending}
    data-action-pending={pending || undefined} onClick={async event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        (props.target && props.target !== '_self')) return;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return;
      event.preventDefault();
      await download(url);
    }}>
    {children}
    <span className="sr-only" role="status">{status}</span>
  </a>;
});
