'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {useTranslations} from 'next-intl';

/** Secondary list actions stay inline on desktop and share one compact menu on phones. */
export function ResponsiveActions({children}: {children: ReactNode}) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div ref={root} className="relative min-w-0" onKeyDownCapture={event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium sm:hidden">{t('moreActions')}</button>
    <div className={`${open ? 'absolute right-0 z-40 mt-2 flex w-64 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-popover p-3 shadow-lg' : 'hidden'} gap-2 sm:static sm:mt-0 sm:flex sm:w-auto sm:max-w-none sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-3 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none`}>
      {children}
    </div>
  </div>;
}
