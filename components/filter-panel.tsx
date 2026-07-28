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

import { useEffect, useState, type MouseEvent } from 'react';
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
    }
  | {
      // Multi-select (feedback 0773bda9): a checkbox group posting repeated GET params
      // (?status=pending&status=approved). Still no-JS: it's plain checkboxes inside the GET form.
      kind: 'multi';
      name: string;
      label: string;
      ariaLabel: string;
      options: FilterOption[];
      removeAriaLabel: string;
    }
  | {
      // Native date input (feedback 0773bda9) — no picker dependency.
      kind: 'date';
      name: string;
      label: string;
      ariaLabel: string;
      removeAriaLabel: string;
    };

/** Normalise a value to a string[] (multi) — a single string becomes a 1-element array. */
const asArray = (v: string | string[] | undefined): string[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export type FilterPanelLabels = {
  /** Button text, also the panel's dialog aria-label. */
  filter: string;
  /** Submit button inside the panel. */
  apply: string;
  /** Clear-all link (panel footer + trailing chip). */
  clearAll: string;
  /** Resolved ICU count string, e.g. "2 filters" — screen-reader text for the badge/chip row. */
  activeCount: string;
  /**
   * Bulk tick/untick controls on every `multi` fieldset (feedback 8ec63139). OPTIONAL on purpose: a page
   * that has not adopted them keeps today's plain checkbox group rather than being forced to supply two
   * more strings. Both must be present for the pair to render — one without the other is a half control.
   */
  selectAll?: string;
  deselectAll?: string;
};

export type FilterPanelProps = {
  /** Base path for the GET form and the clear link, e.g. '/personnel'. */
  action: string;
  fields: FilterField[];
  /** Current searchParam values keyed by field name (chips + form defaults). A multi field carries a
   *  string[] (repeated GET params); every other field a single string. */
  values: Record<string, string | string[] | undefined>;
  labels: FilterPanelLabels;
  /**
   * Query params this panel does not own but must not destroy (feedback 650b6eb8). The admin /leave page
   * now carries TWO independently filtered listings, and a GET form posts only its own fields — without
   * this, filtering the employee list would silently clear the leave-request filters below it. Optional,
   * so every existing single-listing page is unaffected. Rendered as hidden inputs in the form and
   * appended to the chips' remove/clear links.
   */
  hidden?: readonly (readonly [string, string])[];
  /** Optional onboarding-tour anchor placed on the trigger button. */
  dataTour?: string;
};

// A field counts as active once when it has any value (a multi field with ≥1 selected value counts once).
const countActive = (fields: FilterField[], values: FilterPanelProps['values']) =>
  fields.filter((f) => asArray(values[f.name]).length > 0).length;

/** `action` plus the foreign params this panel must preserve — the base for its clear-all link. */
const baseHref = (action: string, hidden: FilterPanelProps['hidden']) => {
  const sp = new URLSearchParams();
  for (const [k, v] of hidden ?? []) sp.append(k, v);
  const s = sp.toString();
  return s ? `${action}?${s}` : action;
};

export function FilterPanel({ action, fields, values, labels, hidden, dataTour }: FilterPanelProps) {
  const [open, setOpen] = useState(false);
  const active = countActive(fields, values);
  const bulk = labels.selectAll && labels.deselectAll;

  // Tick/untick every box in ONE fieldset (feedback 8ec63139). Driven off the submitted event's own
  // fieldset rather than a ref map or controlled state, so the group stays uncontrolled — the plain
  // `defaultChecked` checkboxes (and therefore the no-JS GET submit) are untouched.
  const setAll = (e: MouseEvent<HTMLButtonElement>, checked: boolean) => {
    const group = e.currentTarget.closest('fieldset');
    if (!group) return;
    for (const box of group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      box.checked = checked;
    }
  };

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
            <form method="get" action={action} className="max-h-[60vh] space-y-3 overflow-y-auto">
              {(hidden ?? []).map(([k, v], i) => (
                <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
              ))}
              {fields.map((f) =>
                f.kind === 'multi' ? (
                  // Checkbox group: one repeated GET param per checked value (no-JS friendly).
                  <fieldset key={f.name} className="flex flex-col gap-1.5" aria-label={f.ariaLabel}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
                      {bulk && (
                        <span className="flex items-center gap-1.5 text-[11px]">
                          <button
                            type="button"
                            onClick={(e) => setAll(e, true)}
                            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {labels.selectAll}
                          </button>
                          <span aria-hidden className="text-muted-foreground/50">
                            ·
                          </span>
                          <button
                            type="button"
                            onClick={(e) => setAll(e, false)}
                            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {labels.deselectAll}
                          </button>
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      {f.options.map((o) => (
                        <label key={o.value} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name={f.name}
                            value={o.value}
                            defaultChecked={asArray(values[f.name]).includes(o.value)}
                            className="size-4 rounded border-border text-primary focus:ring-primary"
                          />
                          <span>{o.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : (
                  <label key={f.name} className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
                    {f.kind === 'search' ? (
                      <input
                        name={f.name}
                        defaultValue={asArray(values[f.name])[0] ?? ''}
                        placeholder={f.placeholder}
                        aria-label={f.ariaLabel}
                        className={inputCls}
                      />
                    ) : f.kind === 'date' ? (
                      <input
                        type="date"
                        name={f.name}
                        defaultValue={asArray(values[f.name])[0] ?? ''}
                        aria-label={f.ariaLabel}
                        className={inputCls}
                      />
                    ) : (
                      <select
                        name={f.name}
                        defaultValue={asArray(values[f.name])[0] ?? ''}
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
                ),
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button type="submit" size="sm">
                  {labels.apply}
                </Button>
                {active > 0 && (
                  <Link href={baseHref(action, hidden)} className="text-sm text-muted-foreground hover:text-foreground">
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
  hidden,
}: Omit<FilterPanelProps, 'dataTour'>) {
  const active = fields.filter((f) => asArray(values[f.name]).length > 0);
  if (active.length === 0) return null;

  // Rebuild the query string minus ONE param — or, for a multi field, minus a single value of it (the
  // other selected values survive via URLSearchParams.append). `page` is intentionally never carried, so
  // removing a filter returns to the first page. Foreign params (650b6eb8) ride along untouched: removing
  // one listing's chip must not clear the other listing on the same page.
  const hrefWithout = (name: string, value?: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of hidden ?? []) sp.append(k, v);
    for (const f of fields) {
      const vals = asArray(values[f.name]);
      for (const v of vals) {
        if (f.name === name && (value === undefined || v === value)) continue;
        sp.append(f.name, v);
      }
    }
    const s = sp.toString();
    return s ? `${action}?${s}` : action;
  };

  // Flatten fields → one chip per applied value (a multi field yields one chip per selected value).
  const chips = active.flatMap((f) => {
    const labelFor = (raw: string) =>
      f.kind === 'select' || f.kind === 'multi'
        ? (f.options.find((o) => o.value === raw)?.label ?? raw)
        : raw;
    return asArray(values[f.name]).map((raw) => ({
      key: `${f.name}:${raw}`,
      fieldLabel: f.label,
      display: labelFor(raw),
      href: f.kind === 'multi' ? hrefWithout(f.name, raw) : hrefWithout(f.name),
      removeAriaLabel: f.removeAriaLabel,
    }));
  });

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={labels.activeCount}>
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 py-1 pl-3 pr-1 text-xs"
        >
          <span className="shrink-0 text-muted-foreground">{c.fieldLabel}:</span>
          <span className="truncate font-medium text-foreground">{c.display}</span>
          <Link
            href={c.href}
            aria-label={c.removeAriaLabel}
            className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
          </Link>
        </span>
      ))}
      {chips.length > 1 && (
        <Link href={baseHref(action, hidden)} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {labels.clearAll}
        </Link>
      )}
    </div>
  );
}
