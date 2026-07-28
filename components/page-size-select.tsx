'use client';

import { useRouter } from 'next/navigation';

/**
 * The rows-per-page control inside the shared <Pager> (feedback fc776376).
 *
 * The only client-side piece of pagination: the hrefs are all built on the server (so the choice rides in
 * the address and a copied link opens on the same view), and this island exists purely because a <select>
 * cannot navigate without JavaScript. Labels arrive pre-translated so the island carries no t() keys.
 */
export function PageSizeSelect({
  label,
  value,
  options,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; href: string }[];
}) {
  const router = useRouter();
  const id = `page-size-${value}`;

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) router.push(next.href, { scroll: false });
        }}
        className="h-7 rounded-md border border-border bg-card px-1.5 text-xs tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
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
