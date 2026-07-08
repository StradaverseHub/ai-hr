'use client';

/**
 * Client island for the carry-forward year picker — auto-submits its GET form on change,
 * mirroring FilterBar's one-line requestSubmit progressive enhancement.
 *
 * Extracted so app/analytics/page.tsx can stay a Server Component: an `onChange` handler
 * cannot be passed across the server→client boundary, and doing so threw
 * "Event handlers cannot be passed to Client Component props" on every render of the page
 * (the page is searchParams-dynamic, so the build never surfaced it).
 */
export function YearSelect({
  label,
  name,
  selected,
  years,
}: {
  label: string;
  name: string;
  selected: number;
  years: number[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      <select
        name={name}
        defaultValue={String(selected)}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );
}
