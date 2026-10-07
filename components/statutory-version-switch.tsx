'use client';

import { MONO_FIELD } from '@/components/ui/input';
import { inputCls } from '@/components/ui';

/**
 * r402 (item f3cf2444) — the Version choice in the viewer's header: switch the form's language without
 * starting again.
 *
 * A plain GET form back to the SAME viewer with the same parameters and the other version, so the result
 * is a normal, refreshable URL and the framed document is re-requested through its own gate. Choosing an
 * option submits; the visually hidden button is there for keyboard and no-script users, who choose and
 * then press it.
 *
 * Generic: `name` is the destination's own parameter (`lang` for the EA and PCB 2(II)), `options` are the
 * catalog entry's declared versions, already labelled. Every string is the caller's.
 */
export function StatutoryVersionSwitch({
  action,
  name,
  value,
  options,
  hidden,
  label,
  submitLabel,
}: {
  action: string;
  name: string;
  value: string;
  options: { value: string; label: string }[];
  /** Every other parameter of the current view, carried unchanged (company, year, the ticked ids…). */
  hidden: { name: string; value: string }[];
  label: string;
  submitLabel: string;
}) {
  return (
    <form method="get" action={action} className="flex items-end gap-2">
      {hidden.map((h, i) => (
        <input key={`${h.name}-${i}`} type="hidden" name={h.name} value={h.value} />
      ))}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid">
          {label}
        </span>
        <select
          name={name}
          defaultValue={value}
          className={`${inputCls} min-w-44 ${MONO_FIELD}`}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="sr-only focus:not-sr-only">
        {submitLabel}
      </button>
    </form>
  );
}
