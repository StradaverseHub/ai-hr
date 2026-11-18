'use client';

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

/** Search navigates once per explicit request and never submits the financial form. */
export function PayrollSelectionSearch({ query, placeholder }: { query: string; placeholder: string }) {
  const [value, setValue] = useState(query);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useTranslations('common');

  useEffect(() => setValue(query), [query]);

  function search() {
    const next = new URLSearchParams(params.toString());
    if (value.trim()) next.set('q', value.trim());
    else next.delete('q');
    next.delete('page');
    next.delete('newPage');
    startTransition(() => router.replace(pathname + (next.size ? '?' + next.toString() : ''), { scroll: false }));
  }

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={placeholder}
        placeholder={placeholder}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            search();
          }
        }}
        className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
      />
      <button type="button" onClick={search} disabled={pending}
        className="rounded-lg border border-border px-3 py-1.5 text-sm">
        {pending ? t('loading') : t('search')}
      </button>
    </div>
  );
}
