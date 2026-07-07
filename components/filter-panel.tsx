'use client';

/**
 * Consolidated filter panel (feedback 3542ed4a): a single top-right "Filter" button that opens a
 * floating panel holding all of a listing page's filter fields, plus removable active-filter chips
 * rendered below the page header.
 *
 * Pure UI reskin — the panel wraps a plain GET <form action={action}> so the page's searchParams
 * contract (e.g. ?q=&company=&dept=&status=&type=) and the server-side query path are identical to
 * the old inline filter row. Chips are plain <Link>s that drop exactly one param, so removal works
 * without JavaScript too. All strings arrive PRE-TRANSLATED via props (no t() in this island),
 * keeping the i18n-coverage test's static-key check meaningful and the component page-agnostic.
 *
 * Popover structure (trigger button + fixed click-catcher backdrop + absolute right-aligned panel
 * with starting:* enter transition) mirrors components/company-switcher.tsx for visual consistency.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Filter, X } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';

export type FilterOption = { value: string; label: string };

export type FilterField =
  | {
      kind: 'search';
      name: string;
      label: string;
      placeholder: string;
      ariaLabel: string;
      /** Pre-resolved "Remove {label} filter" string for the chip's ✕ link. */
      removeAriaLabel: string;
    }
  | {
      kind: 'select';
      name: string;
      label: string;
      ariaLabel: string;
      allLabel: string;
      options: FilterOption[];
      removeAriaLabel: string;
    };

export type FilterPanelLabels = {
  /** Button text, also the panel's dialog aria-label. */
  filter: string;
  /** Submit button inside the panel. */
  apply: string;
  /** Clear-all link (panel footer + trailing chip). */
  clearAll: string;
  /** Resolved ICU count string, e.g. "2 filters" — screen-reader text for the badge/chip row. */
  activeCount: string;
};

export type FilterPanelProps = {
  /** Base path for the GET form and the clear link, e.g. '/personnel'. */
  action: string;
  fields: FilterField[];
  /** Current searchParam values keyed by field name (chips + form defaults). */
  values: Record<string, string | undefined>;
  labels: FilterPanelLabels;
  /** Optional onboarding-tour anchor placed on the trigger button. */
  dataTour?: string;
};

const countActive = (fields: FilterField[], values: FilterPanelProps['values']) =>
  fields.filter((f) => !!values[f.name]).length;

export function FilterPanel({ action, fields, values, labels, dataTour }: FilterPanelProps) {
  const [open, setOpen] = useState(false);
  const active = countActive(fields, values);

  // Close on Escape while open (backdrop click handles pointer dismissal).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        data-tour={dataTour}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]"
      >
        <Filter className="size-4 text-muted-foreground" aria-hidden />
        {labels.filter}
        {active > 0 && (
          <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
            <span aria-hidden>{active}</span>
            <span className="sr-only">{labels.activeCount}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label={labels.filter}
            className="absolute right-0 z-50 mt-1 w-[min(22rem,90vw)] origin-top-right scale-100 rounded-lg border border-border bg-popover p-4 text-popover-foreground opacity-100 shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0"
          >
            <form method="get" action={action} className="space-y-3">
              {fields.map((f) => (
                <label key={f.name} className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
                  {f.kind === 'search' ? (
                    <input
                      name={f.name}
                      defaultValue={values[f.name] ?? ''}
                      placeholder={f.placeholder}
                      aria-label={f.ariaLabel}
                      className={inputCls}
                    />
                  ) : (
                    <select
                      name={f.name}
                      defaultValue={values[f.name] ?? ''}
                      aria-label={f.ariaLabel}
                      className={inputCls}
                    >
                      <option value="">{f.allLabel}</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              ))}
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button type="submit" size="sm">
                  {labels.apply}
                </Button>
                {active > 0 && (
                  <Link href={action} className="text-sm text-muted-foreground hover:text-foreground">
                    {labels.clearAll}
                  </Link>
                )}
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Active-filter chips: one removable "Label: value ✕" chip per applied filter plus a trailing
 * Clear-all link. Each ✕ is a plain <Link> rebuilding the query string minus that one param
 * (page intentionally dropped — removing a filter returns to the first page).
 */
export function FilterChips({
  action,
  fields,
  values,
  labels,
}: Omit<FilterPanelProps, 'dataTour'>) {
  const active = fields.filter((f) => !!values[f.name]);
  if (active.length === 0) return null;

  const hrefWithout = (name: string) => {
    const sp = new URLSearchParams();
    for (const f of fields) {
      const v = values[f.name];
      if (v && f.name !== name) sp.set(f.name, v);
    }
    const s = sp.toString();
    return s ? `${action}?${s}` : action;
  };

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={labels.activeCount}>
      {active.map((f) => {
        const raw = values[f.name] as string;
        const display = f.kind === 'select' ? (f.options.find((o) => o.value === raw)?.label ?? raw) : raw;
        return (
          <span
            key={f.name}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 py-1 pl-3 pr-1 text-xs"
          >
            <span className="shrink-0 text-muted-foreground">{f.label}:</span>
            <span className="truncate font-medium text-foreground">{display}</span>
            <Link
              href={hrefWithout(f.name)}
              aria-label={f.removeAriaLabel}
              className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </Link>
          </span>
        );
      })}
      {active.length > 1 && (
        <Link href={action} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {labels.clearAll}
        </Link>
      )}
    </div>
  );
}
