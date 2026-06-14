'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Check, Languages } from 'lucide-react';
import { setLocale } from '@/app/i18n-actions';
import { locales, localeNames, isLocale, type Locale } from '@/i18n/config';
import { cn } from '@/lib/utils';

/** Top-bar UI-language picker. Sets the NEXT_LOCALE cookie via a server action; no URL routing. */
export function LanguageSwitcher() {
  const [open, setOpen] = useState(false);
  const active = useLocale();
  const activeLocale: Locale = isLocale(active) ? active : 'en';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Change language"
        title={localeNames[activeLocale]}
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Languages className="size-5" />
      </button>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {/* The form stays mounted and is hidden via `hidden` (not unmounted) so a locale click still
          completes its native submit — unmounting in the click handler would cancel it (React
          flushes discrete events synchronously, removing the form before the browser submits). */}
      <form
        action={setLocale}
        className={cn(
          'absolute right-0 z-50 mt-1 w-48 origin-top-right rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg',
          !open && 'hidden',
        )}
      >
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Language
        </div>
        {locales.map((loc) => (
          <button
            key={loc}
            type="submit"
            name="locale"
            value={loc}
            onClick={() => setOpen(false)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
              loc === activeLocale && 'font-medium text-foreground',
            )}
          >
            <span className="truncate">{localeNames[loc]}</span>
            {loc === activeLocale && <Check className="size-4 shrink-0 text-primary" />}
          </button>
        ))}
      </form>
    </div>
  );
}
