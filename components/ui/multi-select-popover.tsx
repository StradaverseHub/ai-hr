'use client';

/**
 * MultiSelectPopover (2449fbb7 — standardize multi-select dropdown auto-close).
 *
 * One shared searchable multi-select popover, extracted from two near-identical copies: the local
 * `MultiSelect` in components/earned-accrual-card.tsx and the inline company picker in
 * components/festive-grant-card.tsx. Both copies rendered their outside-click backdrop as a DOM
 * descendant of <Field> (a <label>): the backdrop click closed the panel, then the label's activation
 * behaviour forwarded a synthetic click to its first labelable descendant — the trigger button — whose
 * functional toggle re-opened it in the same batch. Net effect: click-outside never closed the panel,
 * and clicking an option's TEXT (non-interactive content inside the outer label) snapped it shut.
 *
 * Fixes here, by construction:
 * - No <Field>/<label> wrapper. The component owns its caption: a plain <div> + <span>, with a useId
 *   id on the span and aria-labelledby on the trigger so the accessible name survives dropping the
 *   implicit label association.
 * - No full-viewport backdrop. Outside click closes via a document `mousedown` listener on a root ref
 *   (the components/ui/combobox.tsx idiom), which also lets a click on a neighbouring trigger open
 *   that dropdown on the SAME click instead of being swallowed by a fixed inset-0 layer.
 * - `disabled` also force-closes an already-open panel (festive: ticking group-wide while open must
 *   not leave a stale interactive panel floating over a disabled trigger).
 *
 * FORM CONTRACT (mirrors components/ui/chip-multi-select.tsx): when `name` is set, the component emits
 * one hidden <input name={name} value={id}> per selected id, rendered OUTSIDE the `open` conditional,
 * so the posted ids survive the panel actually closing. The visible checkboxes are presentation only.
 * Do NOT change this without checking every server action that consumes the field
 * (festive grant → formData.getAll('companyIds') in app/admin/actions.ts).
 *
 * Presentation-only: all copy arrives already translated via props, so t() lookups stay static at the
 * call sites and the i18n coverage test keeps working. No translation hook belongs in this file.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { inputCls } from '@/components/ui';

export type MultiSelectPopoverOption = { id: string; name: string };

export function MultiSelectPopover({
  label,
  allLabel,
  options,
  selected,
  onChange,
  searchPlaceholder,
  selectAllLabel,
  clearAllLabel,
  selectedCount,
  name,
  disabled,
}: {
  /** Translated caption shown above the trigger (owned by the component — no <Field> at the call site). */
  label: string;
  /** Translated trigger text when nothing is selected (empty selection ⇒ "all" at both call sites). */
  allLabel: string;
  options: MultiSelectPopoverOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  searchPlaceholder: string;
  selectAllLabel: string;
  clearAllLabel: string;
  /** Translated "{n} selected", e.g. (n) => t('festiveSelectedCount', { count: n }). */
  selectedCount: (n: number) => string;
  /** Opt-in form contract: emit one hidden <input name={name} value={id}> per selected id. */
  name?: string;
  disabled?: boolean;
}) {
  const captionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, search]);
  const visibleIds = useMemo(() => new Set(visible.map((o) => o.id)), [visible]);

  // Close on outside click — document mousedown against the root ref (combobox.tsx idiom). No backdrop
  // element exists, so no future <label> wrapper can ever re-activate the trigger and undo the close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Disabling the control (festive: group-wide ticked while the panel is open) must also close it —
  // a plain `disabled` on the trigger alone would leave a stale open panel over a dead button.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  // Select/Clear All act on the currently VISIBLE (search-filtered) options, matching both prior copies.
  const selectAll = () => onChange(new Set([...selected, ...visibleIds]));
  const clearAll = () => onChange(new Set([...selected].filter((id) => !visibleIds.has(id))));

  const triggerLabel = selected.size === 0 ? allLabel : selectedCount(selected.size);

  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
      <span id={captionId} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {/* FORM CONTRACT — outside the `open` guard on purpose: the posted ids must survive the panel
          closing before submit. See the docblock before touching this. */}
      {name != null &&
        [...selected].map((id) => <input key={id} type="hidden" name={name} value={id} />)}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-labelledby={captionId}
          disabled={disabled}
          className={cn(
            inputCls,
            'flex w-56 items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
        {open && (
          <div className="absolute left-0 z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className={`${inputCls} mb-2`}
            />
            <div className="mb-2 flex items-center gap-3 px-1 text-xs">
              <button type="button" onClick={selectAll} className="font-medium text-primary hover:underline">
                {selectAllLabel}
              </button>
              <button type="button" onClick={clearAll} className="font-medium text-muted-foreground hover:underline">
                {clearAllLabel}
              </button>
              <span className="ml-auto text-muted-foreground">{selectedCount(selected.size)}</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {options.map((o) => (
                <label
                  key={o.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                    !visibleIds.has(o.id) && 'hidden',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.id)}
                    onChange={() => toggle(o.id)}
                    className="size-4 accent-[var(--color-primary)]"
                  />
                  <span className="truncate">{o.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
