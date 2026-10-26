'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readWorkplaceSetupLink, workplaceSetupLinks } from '@/lib/mobile-workplace-setup';

export function MobileSetupLink() {
  const t = useTranslations('mobileSetup');
  const processed = useRef(false);
  const [state, setState] = useState<{ href: string | null; invalid: boolean }>({ href: null, invalid: false });
  useEffect(() => {
    function review() {
      if (processed.current && !window.location.hash) return;
      processed.current = true;
      try {
        const raw = readWorkplaceSetupLink(window.location.href);
        setState({ href: workplaceSetupLinks(raw).app, invalid: false });
      } catch { setState({ href: null, invalid: true }); }
      // Setup is public routing data, but it need not stay in browser history or copied URLs.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    review();
    window.addEventListener('hashchange', review);
    return () => window.removeEventListener('hashchange', review);
  }, []);
  return <main className="flex min-h-dvh items-center justify-center px-6 py-12">
    <div className="w-full max-w-md space-y-6">
      <p className="text-sm font-semibold tracking-wide text-muted-foreground">AI HR</p>
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-base leading-relaxed text-muted-foreground">{t('help')}</p>
      {state.invalid ? <p role="alert" className="rounded-lg border border-border p-4 text-sm">{t('invalid')}</p> :
        state.href ? <a href={state.href} className="flex min-h-12 items-center justify-center rounded-lg bg-primary px-5 py-3 font-medium text-primary-foreground">{t('open')}</a> :
        <p role="status" className="text-sm text-muted-foreground">{t('checking')}</p>}
      <p className="text-sm leading-relaxed text-muted-foreground">{t('install')}</p>
      <p className="border-t border-border pt-5 text-sm leading-relaxed text-muted-foreground">{t('network')}</p>
    </div>
  </main>;
}
