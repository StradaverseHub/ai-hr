'use client';

import {Suspense} from 'react';
import {DegradedState} from '@/components/degraded-state';
import {CatalogClientProvider} from '@/i18n/client-provider';
import {LOCALE_COOKIE, defaultLocale} from '@/i18n/config';
import './globals.css';

function cookieLocale(): string {
  if (typeof document === 'undefined') return defaultLocale;
  return document.cookie.split('; ').find(entry => entry.startsWith(`${LOCALE_COOKIE}=`))?.split('=')[1] ?? defaultLocale;
}

/** Replaces the root layout when the shell itself cannot render, so it brings its own document and catalog. */
export default function GlobalError({error, retry}: {error: Error & {digest?: string}; retry: () => void}) {
  const locale = cookieLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="h-dvh overflow-auto font-sans">
        <Suspense>
          <CatalogClientProvider locale={locale}>
            <DegradedState error={error} retry={retry} />
          </CatalogClientProvider>
        </Suspense>
      </body>
    </html>
  );
}
