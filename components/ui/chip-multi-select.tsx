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
  allSelectedLabel,
  countLabelFor,
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
  /** Opt-in: translated text shown (instead of chips) once every option is selected, e.g. "All selected". */
  allSelectedLabel?: string;
  /** Opt-in: translated collapsed summary when the selection count exceeds summaryThreshold, e.g. (n) => t('nSelected', { count: n }). */
  countLabelFor?: (count: number) => string;
  /** Show individual chips up to this count; above it (and below "all"), collapse to countLabelFor. */
  summaryThreshold?: number;
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    // Drop anything not in the master-data options — the control can never hold an invalid value.
    defaultSelected.filter((v) => options.some((o) => o.value === v)),
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const labelOf = new Map(options.map((o) => [o.value, o.label]));

  // Close on outside click — document mousedown against the root ref (combobox.tsx idiom). No backdrop
  // element exists, so no <label> wrapper can ever re-activate the trigger and undo the close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggleValue = (v: string) =>
    setSelected((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));

  // Collapsed summary (opt-in): "All selected" once everything is picked, else a "{n} selected" pill past
  // the chip threshold, else the removable chips. Falls back to chips whenever the labels aren't provided.
  const allSelected = options.length > 0 && selected.length === options.length;
  const showAllSummary = allSelected && allSelectedLabel != null;
  const showCountSummary = !showAllSummary && countLabelFor != null && selected.length > summaryThreshold;

  return (
    <div
      ref={rootRef}
      className="space-y-1.5"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
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
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="true"
          aria-labelledby={label != null ? captionId : undefined}
          className={cn(inputCls, 'flex items-center justify-between gap-2 text-left')}
        >
          <span className="truncate text-muted-foreground">{addPlaceholder}</span>
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
                    onClick={() => setSelected(options.map((o) => o.value))}
                    className="font-medium text-primary hover:underline"
                  >
                    {selectAllLabel}
                  </button>
                )}
                {clearAllLabel != null && (
                  <button
                    type="button"
                    onClick={() => setSelected([])}
                    className="font-medium text-muted-foreground hover:underline"
                  >
                    {clearAllLabel}
                  </button>
                )}
              </div>
            )}
            <div className="max-h-56 overflow-y-auto">
              {options.map((o) => (
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
        ) : (
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
                    onClick={() => setSelected((cur) => cur.filter((x) => x !== v))}
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
