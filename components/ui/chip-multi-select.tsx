'use client';

/**
 * Chip-style multi-select for plain form posts (1a6ed9e6 contest resolution: eligibility pickers).
 *
 * Selected values render as removable chips; new values are added from a dropdown that only lists the
 * not-yet-selected options, so only valid master-data values can ever be chosen. Picking exactly one
 * value is single-select; picking several is multi-select — one control covers both.
 *
 * Form contract: emits one hidden <input name={name} value={v}> per selected value, so it posts the
 * exact FormData shape of the native <select multiple> it replaces — server actions reading
 * formData.getAll(name) keep working unchanged. Do NOT change this without checking every action
 * that consumes the field.
 *
 * Presentation-only: all copy arrives translated via props (addPlaceholder, removeLabelFor) so t()
 * lookups stay static at the call site for the i18n coverage test.
 *
 * DOM order note: the add-<select> is rendered BEFORE the chips on purpose. Call sites wrap this in
 * <Field>, which is a <label> — the label activates its first labelable descendant, and the chips'
 * remove <button>s are labelable. Select-first keeps a click on the field label focusing the dropdown
 * instead of pressing (and firing) the first chip's remove button.
 *
 * Bulk controls & collapsed summary (feedback 2cc30077, opt-in): when selectAllLabel/clearAllLabel are
 * passed, small "Select all" / "Clear all" buttons render beside the add dropdown. When allSelectedLabel
 * and/or countLabelFor are passed, the chip strip collapses to a compact summary ("All selected" once
 * every option is picked, "{n} selected" past summaryThreshold). All are additive — omit them and the
 * control behaves exactly as before (the /performance eligibility pickers stay unchanged).
 */
import { useState } from 'react';
import { inputCls } from '@/components/ui';

export function ChipMultiSelect({
  name,
  options,
  addPlaceholder,
  removeLabelFor,
  defaultSelected = [],
  selectAllLabel,
  clearAllLabel,
  allSelectedLabel,
  countLabelFor,
  summaryThreshold = 4,
}: {
  name: string;
  options: { value: string; label: string }[];
  /** Translated placeholder shown on the add dropdown, e.g. t('chipAddPlaceholder'). */
  addPlaceholder: string;
  /** Translated aria-label for a chip's remove button, e.g. (label) => t('chipRemoveLabel', { value: label }). */
  removeLabelFor: (label: string) => string;
  defaultSelected?: string[];
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
  const labelOf = new Map(options.map((o) => [o.value, o.label]));
  const remaining = options.filter((o) => !selected.includes(o.value));

  // Collapsed summary (opt-in): "All selected" once everything is picked, else a "{n} selected" pill past
  // the chip threshold, else the removable chips. Falls back to chips whenever the labels aren't provided.
  const allSelected = options.length > 0 && selected.length === options.length;
  const showAllSummary = allSelected && allSelectedLabel != null;
  const showCountSummary = !showAllSummary && countLabelFor != null && selected.length > summaryThreshold;

  return (
    <div className="space-y-1.5">
      {selected.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={inputCls}
          value=""
          disabled={remaining.length === 0}
          onChange={(e) => {
            const v = e.target.value;
            if (v) setSelected((cur) => (cur.includes(v) ? cur : [...cur, v]));
          }}
        >
          <option value="">{addPlaceholder}</option>
          {remaining.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {selectAllLabel != null && (
          <button
            type="button"
            onClick={() => setSelected(options.map((o) => o.value))}
            disabled={allSelected}
            className="rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          >
            {selectAllLabel}
          </button>
        )}
        {clearAllLabel != null && (
          <button
            type="button"
            onClick={() => setSelected([])}
            disabled={selected.length === 0}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            {clearAllLabel}
          </button>
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
              const label = labelOf.get(v) ?? v;
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
                >
                  {label}
                  <button
                    type="button"
                    aria-label={removeLabelFor(label)}
                    title={removeLabelFor(label)}
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
