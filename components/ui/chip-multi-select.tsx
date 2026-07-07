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
 */
import { useState } from 'react';
import { inputCls } from '@/components/ui';

export function ChipMultiSelect({
  name,
  options,
  addPlaceholder,
  removeLabelFor,
  defaultSelected = [],
}: {
  name: string;
  options: { value: string; label: string }[];
  /** Translated placeholder shown on the add dropdown, e.g. t('chipAddPlaceholder'). */
  addPlaceholder: string;
  /** Translated aria-label for a chip's remove button, e.g. (label) => t('chipRemoveLabel', { value: label }). */
  removeLabelFor: (label: string) => string;
  defaultSelected?: string[];
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    // Drop anything not in the master-data options — the control can never hold an invalid value.
    defaultSelected.filter((v) => options.some((o) => o.value === v)),
  );
  const labelOf = new Map(options.map((o) => [o.value, o.label]));
  const remaining = options.filter((o) => !selected.includes(o.value));

  return (
    <div className="space-y-1.5">
      {selected.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
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
      {selected.length > 0 && (
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
      )}
    </div>
  );
}
