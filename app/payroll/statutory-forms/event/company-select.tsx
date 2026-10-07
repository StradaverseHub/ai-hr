'use client';

import { MONO_UNDERLINE_FIELD as MONO_FIELD } from '@/components/monolith/classes';
import { inputCls } from '@/components/ui';

/**
 * r413 — the event-selection screen's Company box: choosing a company re-lists that company's people.
 *
 * A plain <select> in the screen's GET form; choosing an option submits it (the same pattern as
 * components/statutory-version-switch.tsx). Without script the operator presses the form's Search button,
 * which submits the same form. No string lives here.
 */
export function EventCompanySelect({
  name,
  value,
  options,
}: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      name={name}
      defaultValue={value}
      className={`${inputCls} ${MONO_FIELD}`}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
