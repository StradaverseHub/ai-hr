'use client';

/**
 * A pick-list backed by a tenant-wide profile-option catalog (bc5d4891).
 *
 * LEGACY-TOLERANT, and that is the whole of it: if the stored value is not (or is no longer) in the
 * active catalog it is still rendered as a selectable option, so an edit of any OTHER field on the form
 * never silently drops it. Empty = the placeholder (clears to null on save).
 *
 * ── WHY IT IS A SHARED COMPONENT (15e5bd93 rev 2, r353) ──────────────────────────────────────────
 * It was module-private to components/company-panel.tsx while that panel was the only screen editing a
 * statutory body's State and Country. The reporter's approved rev-2 redesign gives the bodies their own
 * screen, so two components now write the SAME `company_statutory_authority.state` / `.country` columns.
 * A second copy of the legacy-tolerance rule is a second copy that can drift, and the way it would drift
 * is silent: the screen without the tolerance quietly clears a stored value that has since left the
 * catalogue, on a save of some unrelated field. One definition, both callers.
 */
import { inputCls } from './ui';

export type SelectOption = { value: string; label: string };

export function OptionSelect({
  name,
  value,
  options,
  placeholder,
}: {
  name: string;
  value: string | null;
  options: SelectOption[];
  placeholder: string;
}) {
  const known = !value || options.some((o) => o.value === value);
  return (
    <select name={name} defaultValue={value ?? ''} className={inputCls}>
      <option value="">{placeholder}</option>
      {!known && value ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
