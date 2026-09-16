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
 *
 * ── r287 (ff1c935f) — TWO OPT-IN PROPS, BOTH DEFAULTED, NO CALL SITE CHANGES ──────────────────────────
 * `matchOption` and `emptyLabelFor` were added for the Generate Entitlement employee picker. Omit either
 * and this component behaves EXACTLY as it did for all five pre-existing call sites.
 *
 * · `emptyLabelFor` is not polish. The reported defect on that screen was a control that searched, found
 *   nothing, and said nothing — so the operator sat on "Working it out…" with no idea why. Filtering to
 *   zero rows here previously rendered an EMPTY BOX, which asserts nothing. The terminal state must name
 *   what was searched, or it is the same silence in a different font.
 *
 * · `matchOption` exists because the default filter is a plain substring over `name`, and this repo
 *   already owns the "find an employee by partial ID or partial name" rule in `lib/employee-search.ts`
 *   (folding, so "emp0008" finds "EMP-0008"). A picker that shows an Employee ID on screen and then fails
 *   to find it when typed is the same broken promise one layer down. Callers with a domain search rule
 *   pass it in; everyone else keeps the substring default.
 *
 * Both are FUNCTIONS, matching the `selectedCount` prop this component has always required — so they add
 * no constraint that was not already there: every call site is a client component. A SERVER page cannot
 * mount this control at all (see components/attendance/location-assignment.tsx, which crosses the
 * boundary with plain strings and builds the functions on the client side of it).
 *
 * ── r293 — A THIRD OPT-IN PROP, SAME CONTRACT: `optionNote` ───────────────────────────────────────────
 * Omit it and this component behaves EXACTLY as it did for every earlier call site. Run Earned Accrual
 * offers every ACTIVE leave type, but `accrueEarnedLeave` filters `code IN STANDING_LEAVE_CODES` before
 * it reads a single employment — so the list has always contained rows that can never produce a day, and
 * the only signal was an empty preview AFTER the operator picked one and pressed Preview. The note marks
 * them where the choice is made. It is a MARKER, not a filter: the option stays selectable, because the
 * engine's typed empty reason is still the authority on why a run came back with nothing, and hiding the
 * row would replace one silence with another.
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
  matchOption,
  emptyLabelFor,
  optionNote,
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
  /** Translated "{n} selected", e.g. (n) => t('multiSelectSelectedCount', { count: n }). */
  selectedCount: (n: number) => string;
  /** Opt-in form contract: emit one hidden <input name={name} value={id}> per selected id. */
  name?: string;
  disabled?: boolean;
  /**
   * Opt-in: the caller's own search rule, e.g. `(o, q) => matchesEmployeeSearch(rowFor(o.id), q)`.
   * Omitted ⇒ a case-insensitive substring over `name`, which is what every earlier call site had.
   */
  matchOption?: (option: MultiSelectPopoverOption, query: string) => boolean;
  /**
   * Opt-in: translated "nothing matched {query}" line, rendered INSTEAD of the (empty) row list when a
   * non-blank search matches no option. Omitted ⇒ an empty panel, the pre-r287 behaviour.
   */
  emptyLabelFor?: (query: string) => string;
  /**
   * r293 — opt-in: a short translated marker rendered beside an option's name. Return `null`/`undefined`
   * for the options that carry no marker; omit the prop entirely and no option carries one, which is what
   * every pre-r293 call site has. Presentation only — a marked option is still selectable and still posts
   * exactly as it did (this component owns no filter on it).
   */
  optionNote?: (option: MultiSelectPopoverOption) => string | null | undefined;
}) {
  const captionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const q = search.trim();
    if (!q) return options;
    if (matchOption) return options.filter((o) => matchOption(o, q));
    const lower = q.toLowerCase();
    return options.filter((o) => o.name.toLowerCase().includes(lower));
  }, [options, search, matchOption]);
  const visibleIds = useMemo(() => new Set(visible.map((o) => o.id)), [visible]);
  // r287 — THE TERMINAL EMPTY STATE. `search.trim()` rather than `search`, so a box holding only spaces
  // (which filters nothing and shows everything) never claims a failed search.
  const noMatches = search.trim() !== '' && visible.length === 0;

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
            {/* r287 — said out loud, naming what was typed. An empty box asserts nothing (CLAUDE.md §8);
                this is the difference between "no such employee" and "the screen is still thinking". */}
            {noMatches && emptyLabelFor != null && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyLabelFor(search.trim())}</p>
            )}
            <div className="max-h-56 overflow-y-auto">
              {options.map((o) => {
                // r293 — computed per row and rendered ONLY when the caller returns one: a marker on every
                // row is furniture, and furniture stops being read. It sits INSIDE the <label>, so it is
                // part of the option's accessible name too — a screen reader hears "…, not covered".
                const note = optionNote?.(o);
                return (
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
                    {note ? (
                      <span
                        data-testid="multi-select-option-note"
                        className="ml-auto shrink-0 text-[11px] text-amber-600 dark:text-amber-400"
                      >
                        {note}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
