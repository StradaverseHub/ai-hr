'use client';

import { useRouter } from 'next/navigation';

/**
 * The page-level company picker (20e759a0) — one company at a time on a per-company configuration
 * screen, without touching the GLOBAL company-scope cookie in the top bar.
 *
 * Modelled on components/page-size-select.tsx and on the settings filters in components/settings-list.tsx:
 * every href is built on the SERVER, so the choice rides in the address bar and the page stays a server
 * render. This island exists only because a <select> cannot navigate without JavaScript.
 *
 * SERIALISABLE PROPS ONLY — label, value and a plain array of {value,label,href}. No `t`, no callback,
 * no closure over the server translator; labels arrive already translated so this file opens no i18n
 * namespace of its own (test/server-client-boundary.test.ts and test/i18n-coverage.test.ts Check C).
 */
export function CompanyFilterSelect({
  id,
  label,
  value,
  options,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string; href: string }[];
}) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) router.push(next.href, { scroll: false });
        }}
        className="h-8 max-w-[16rem] rounded-lg border border-border bg-card px-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
