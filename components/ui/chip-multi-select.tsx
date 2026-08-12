'use client';

/**
 * Checkbox-popover multi-select for plain form posts (1a6ed9e6 contest resolution: eligibility pickers;
 * 0af0729d: popover checkbox list; b9c30be0: standardized auto-close + component-owned caption).
 *
 * The trigger button opens a popover listing EVERY option with a checkbox indicator — options already in the
 * selection appear pre-checked; clicking a row toggles that one value. (This replaced the 2cc30077 → d6bdbd55
 * native add-<select>, which listed only the not-yet-selected options plus "Select all" / "Clear all" sentinel
 * entries and collapsed to an "All selected" summary — the arrangement feedback 0af0729d reported as hard to
 * read.) Picking exactly one value is single-select; picking several is multi-select — one control covers both.
 *
 * Form contract (UNCHANGED): emits one hidden <input name={name} value={v}> per selected value, rendered
 * OUTSIDE the `open` conditional so the posted values survive the panel closing before submit — it posts
 * the exact FormData shape of the native <select multiple> it replaced, and server actions reading
 * formData.getAll(name) keep working unchanged. Do NOT change this without checking every action that
 * consumes the field. Nothing inside the popover may carry a `name` attribute: the rows are <button
 * type="button" role="checkbox">s (NOT real checkbox inputs, which would pollute getAll(); and NOT <label>
 * rows, which would nest invalid <label>-in-<label> markup at call sites that wrap this control in <Field>,
 * itself a label — see the labeling modes below). Every button is type="button" — the pickers sit inside
 * live <form>s, and a default-type button would submit the form the moment the popover is opened.
 *
 * Labeling — two modes (b9c30be0, mirroring components/ui/multi-select-popover.tsx):
 * - `label` prop (the leave eligibility pickers): the component owns its caption — a plain <span> with a
 *   useId id, referenced by aria-labelledby on the trigger. No <label> element exists, so an outside click
 *   that lands on the caption can never re-activate the trigger and undo the close. The aria-labelledby is
 *   deliberately CONDITIONAL on the prop: an unconditional reference to a nonexistent id would compute an
 *   empty accessible name and override the implicit <Field> label in the other mode.
 * - <Field> wrapper, no `label` prop (the /performance new-cycle pickers): the control keeps its implicit
 *   label association. The no-label-rows rule and the trigger-first DOM-order rationale exist for this mode.
 *
 * Presentation-only: all copy arrives translated via props (label, addPlaceholder, removeLabelFor) so t()
 * lookups stay static at the call site for the i18n coverage test.
 *
 * DOM order note: caption (when `label` is passed), hidden inputs, then the trigger, then the chips — on
 * purpose. Call sites in <Field> mode wrap this in a <label>, which activates its first labelable
 * descendant, and the chips' remove <button>s are labelable. Trigger-first keeps a click on the field label
 * opening the popover instead of pressing (and firing) the first chip's remove button.
 *
 * Bulk controls & collapsed summary (feedback 2cc30077, opt-in): when selectAllLabel / clearAllLabel are
 * passed, "Select all" / "Clear all" render as two small buttons pinned at the top of the popover (0af0729d
 * relocated them out of the old dropdown's sentinel entries). When allSelectedLabel and/or countLabelFor are
 * passed, the chip strip collapses to a compact summary ("All selected" once every option is picked,
 * "{n} selected" past summaryThreshold). All are additive — omit them (as the leave eligibility pickers now
 * do) and the popover shows a plain checklist while the chips always render with their remove buttons.
 *
 * Summary ON THE TRIGGER (74d00fd2, opt-in — `triggerSummaryFor`): the collapsed control otherwise reads
 * "Add…" however many values are picked, so a field holding three values looks identical to an empty one
 * until you open it. Passing `triggerSummaryFor` moves the summary onto the trigger itself, at ANY count
 * (that "at any count" is the point — the below-control count only ever appeared past summaryThreshold,
 * which is precisely the range the reporter could already see the chips for). An EMPTY selection still
 * reads addPlaceholder, so "filled" and "untouched" stay distinguishable at a glance. While it is supplied
 * the below-control summary lines are suppressed ENTIRELY — the same sentence is never printed twice — and
 * the strip below becomes chips-or-nothing: up to summaryThreshold the removable chips render exactly as
 * they always did (including for a SHORT field that happens to be fully picked, which would otherwise
 * collapse to "All selected" and lose its per-value remove buttons); past it, nothing, because the count
 * is already on the control and 197 chips help nobody. It is opt-in for the usual reason — six-plus call
 * sites, none of whose triggers may change.
 *
 * Search (18103ba4, opt-in): passing `searchPlaceholder` puts a filter box at the top of the popover. The
 * Leave Adjustments criteria builder offers ~20 pickers, several of them over catalogues with dozens of
 * values, and the reporter asked for search on every one of them. State is popover-local and resets on
 * close, so it can never affect what the form posts.
 *
 * ⚠️ WITH A FILTER ACTIVE, BOTH BULK BUTTONS ACT ON THE VISIBLE ROWS ONLY. "Select all" means "select
 * everything I can currently see", ADDED to what is already picked — not "replace my selection with the
 * whole catalogue". Anything else makes the pair (search, select all) actively dangerous: filter to
 * "Finance", press Select all, and silently select all two hundred departments. "Clear all" is the mirror
 * image and was the missing half (74d00fd2): it used to `apply([])` regardless of the filter, so typing
 * "ind" and pressing it dropped the six picks the filter was HIDING along with the one on screen — the
 * destructive direction of exactly the bug the Select-all rule above exists to prevent. When no filter is
 * typed the visible set IS every option, so both buttons behave exactly as they always did for every
 * pre-existing caller; only the filtered case changes, and only for callers that pass BOTH searchPlaceholder
 * and clearAllLabel (components/leave/adjustment-form.tsx and components/leave/generate-form.tsx).
 *
 * Dismissal & keyboard (b9c30be0 — the 2449fbb7 standardize-dropdown idiom, same as combobox.tsx and
 * multi-select-popover.tsx): while open, a document `mousedown` listener closes the popover when the event
 * target is outside the root ref. There is no full-viewport backdrop, so a click on any other control acts
 * immediately (Save closes-and-submits in one click; a neighbouring picker's trigger opens on the same
 * click). Rows are buttons, so Tab/Enter/Space work natively; Escape is handled on the ROOT div — key
 * events bubble from both the trigger and the panel rows, so it closes the popover the moment it is open
 * (even with focus still on the trigger, the normal state right after opening by mouse) and returns focus
 * to the trigger.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';

export function ChipMultiSelect({
  name,
  options,
  addPlaceholder,
  removeLabelFor,
  defaultSelected = [],
  label,
  selectAllLabel,
  clearAllLabel,
  searchPlaceholder,
  allSelectedLabel,
  countLabelFor,
  triggerSummaryFor,
  onSelectionChange,
  summaryThreshold = 4,
}: {
  name: string;
  options: { value: string; label: string }[];
  /** Translated placeholder shown on the popover trigger, e.g. t('chipAddPlaceholder'). */
  addPlaceholder: string;
  /** Translated aria-label for a chip's remove button, e.g. (label) => t('chipRemoveLabel', { value: label }). */
  removeLabelFor: (label: string) => string;
  defaultSelected?: string[];
  /** Opt-in: translated caption rendered above the trigger (component-owned — do NOT also wrap in <Field>). */
  label?: string;
  /** Opt-in: translated label for the "select every option" button. Omit to hide it. */
  selectAllLabel?: string;
  /** Opt-in: translated label for the "clear all" button. Omit to hide it. */
  clearAllLabel?: string;
  /** Opt-in: translated placeholder for a filter box at the top of the popover. Omit to hide it. */
  searchPlaceholder?: string;
  /** Opt-in: translated text shown (instead of chips) once every option is selected, e.g. "All selected". */
  allSelectedLabel?: string;
  /** Opt-in: translated collapsed summary when the selection count exceeds summaryThreshold, e.g. (n) => t('nSelected', { count: n }). */
  countLabelFor?: (count: number) => string;
  /**
   * Opt-in: translated summary for the TRIGGER itself, called only when something is selected — an empty
   * selection always reads addPlaceholder. `allSelected` is true once every option is picked, so one
   * function covers both sentences the below-control strip used to own:
   *   (n, all) => (all ? t('allSelected') : t('nSelected', { count: n }))
   *
   * Supplying it suppresses the below-control summary lines entirely; see the header for why the chips
   * below then run to summaryThreshold and stop.
   */
  triggerSummaryFor?: (count: number, allSelected: boolean) => string;
  /**
   * Opt-in: called with the NEW selection whenever it changes, by any route (a row, Select all, Clear all,
   * a chip's ×).
   *
   * ⚠️ WHY THIS EXISTS, found by rendering the page rather than by reading it. The rows are
   * `<button type="button">`s, so toggling one fires NO `change` event — the hidden inputs are simply
   * re-rendered. A parent that watches its `<form onChange>` therefore never hears about a chip selection
   * at all: on the Leave Adjustments criteria builder the live matched count sat unchanged at "everyone"
   * while the operator picked criteria, and only moved when they happened to touch a text or date field.
   * A count that silently describes a different set from the one on screen is worse than no count.
   *
   * Only client parents may pass this (it is a function prop); a server component must not.
   */
  onSelectionChange?: (values: string[]) => void;
  /** Show individual chips up to this count; above it (and below "all"), collapse to countLabelFor. */
  summaryThreshold?: number;
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    // Drop anything not in the master-data options — the control can never hold an invalid value.
    defaultSelected.filter((v) => options.some((o) => o.value === v)),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const labelOf = new Map(options.map((o) => [o.value, o.label]));
  // The rows the popover currently shows. No search box ⇒ every option, so nothing about the unfiltered
  // behaviour (including what "Select all" selects) changes for any pre-existing caller.
  const visible =
    searchPlaceholder == null || query.trim() === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));

  // Close on outside click — document mousedown against the root ref (combobox.tsx idiom). No backdrop
  // element exists, so no <label> wrapper can ever re-activate the trigger and undo the close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        // A filter is a way of LOOKING at the list, not part of the selection. Dropping it on close keeps
        // the next open honest: the popover always reopens showing everything.
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  /**
   * THE ONE WRITER. Every route that changes the selection goes through here so `onSelectionChange` can
   * never be forgotten by one of them — the four call sites below used to be four separate `setSelected`
   * calls, and a notification added to three of them is a bug that only shows up on the fourth.
   *
   * `next` is computed from the CURRENT `selected` at the call site rather than inside a state updater:
   * calling a listener from inside an updater is a side effect React is free to run twice.
   */
  const apply = (next: string[]) => {
    setSelected(next);
    onSelectionChange?.(next);
  };

  const toggleValue = (v: string) =>
    apply(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  // Collapsed summary (opt-in): "All selected" once everything is picked, else a "{n} selected" pill past
  // the chip threshold, else the removable chips. Falls back to chips whenever the labels aren't provided.
  const allSelected = options.length > 0 && selected.length === options.length;
  // 74d00fd2: with the summary on the trigger, the lines below it are OFF — printing the same sentence
  // twice, once above the chips and once on the control, is not a summary, it is noise.
  const summaryOnTrigger = triggerSummaryFor != null;
  const triggerSummary =
    summaryOnTrigger && selected.length > 0 ? triggerSummaryFor(selected.length, allSelected) : null;
  const showAllSummary = !summaryOnTrigger && allSelected && allSelectedLabel != null;
  const showCountSummary =
    !summaryOnTrigger && !showAllSummary && countLabelFor != null && selected.length > summaryThreshold;
  // Chips-or-nothing once the summary moved onto the trigger: up to the threshold they are unchanged (a
  // short, fully-picked field keeps its per-value remove buttons); past it the count is already on the
  // control, and a 197-chip strip is not the thing to print underneath it.
  const showChips = !summaryOnTrigger || selected.length <= summaryThreshold;

  return (
    <div
      ref={rootRef}
      className="space-y-1.5"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          setQuery('');
          triggerRef.current?.focus();
        }
      }}
    >
      {label != null && (
        <span id={captionId} className="block text-xs font-medium text-muted-foreground">
          {label}
        </span>
      )}
      {selected.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (open) setQuery('');
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          aria-haspopup="true"
          aria-labelledby={label != null ? captionId : undefined}
          className={cn(inputCls, 'flex items-center justify-between gap-2 text-left')}
        >
          <span className={cn('truncate', triggerSummary == null ? 'text-muted-foreground' : 'font-medium text-foreground')}>
            {triggerSummary ?? addPlaceholder}
          </span>
          <ChevronDown
            aria-hidden
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
        {open && (
          <div className="absolute left-0 z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
            {(selectAllLabel != null || clearAllLabel != null) && (
              <div className="mb-1 flex items-center gap-3 border-b border-border px-1.5 pb-1.5 pt-0.5 text-xs">
                {selectAllLabel != null && (
                  <button
                    type="button"
                    onClick={() =>
                      // UNION with what is already picked — see the header. Unfiltered this is exactly the
                      // old "every option"; filtered it is "everything I can see", which is the only
                      // reading that does not silently select the rest of the catalogue.
                      apply([...selected, ...visible.map((o) => o.value).filter((v) => !selected.includes(v))])
                    }
                    className="font-medium text-primary hover:underline"
                  >
                    {selectAllLabel}
                  </button>
                )}
                {clearAllLabel != null && (
                  <button
                    type="button"
                    onClick={() =>
                      // The MIRROR of Select all — see the header. Removes only what is currently
                      // VISIBLE, so a filtered clear can never drop the picks the filter is hiding.
                      // Unfiltered, `visible` IS every option, so this is exactly the old apply([]).
                      apply(selected.filter((v) => !visible.some((o) => o.value === v)))
                    }
                    className="font-medium text-muted-foreground hover:underline"
                  >
                    {clearAllLabel}
                  </button>
                )}
              </div>
            )}
            {searchPlaceholder != null && (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                // NO `name` — nothing inside the popover may post (see the form contract above); a named
                // search box would land in getAll() and become a phantom criteria value.
                className="mb-1 w-full rounded-md border border-input bg-card px-2 py-1 text-xs outline-none focus:border-primary"
              />
            )}
            <div className="max-h-56 overflow-y-auto">
              {visible.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="checkbox"
                  aria-checked={selected.includes(o.value)}
                  onClick={() => toggleValue(o.value)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded border transition-colors',
                      selected.includes(o.value)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-card',
                    )}
                  >
                    {selected.includes(o.value) && (
                      <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M2.5 6.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="truncate">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {selected.length > 0 &&
        (showAllSummary ? (
          <div className="text-xs font-medium text-primary">{allSelectedLabel}</div>
        ) : showCountSummary ? (
          <div className="text-xs font-medium text-primary">{countLabelFor!(selected.length)}</div>
        ) : !showChips ? null : (
          <div className="flex flex-wrap gap-1.5">
            {selected.map((v) => {
              const chipLabel = labelOf.get(v) ?? v;
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
                >
                  {chipLabel}
                  <button
                    type="button"
                    aria-label={removeLabelFor(chipLabel)}
                    title={removeLabelFor(chipLabel)}
                    onClick={() => apply(selected.filter((x) => x !== v))}
                    className="grid size-4 shrink-0 place-items-center rounded-full text-primary/70 transition-colors hover:bg-primary/20 hover:text-primary"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ))}
    </div>
  );
}
