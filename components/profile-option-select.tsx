import { inputCls } from '@/components/ui';
import type { ProfileOptionRow } from '@/core/profile-options';

/**
 * A dropdown for a configurable profile field (religion / race / nationality / state / country /
 * relationship), fed by the tenant's profile_option catalog (7d309da7). Server-rendered inside the
 * Profile-tab forms.
 *
 * LEGACY-VALUE TOLERANCE: if the currently-stored `value` is not among the active catalog options (an
 * option that was renamed, deactivated, deleted, or imported as free text before this feature existed), it
 * is rendered as an extra, PRE-SELECTED option so the form's defaultValue matches and a Save does NOT blank
 * it. The extra option is labelled with `legacySuffix` so HR sees it is off-catalog.
 */
export function ProfileOptionSelect({
  name,
  value,
  options,
  placeholder,
  legacySuffix,
  className,
  id,
  onChange,
}: {
  /** Form mode only: the field name the surrounding server-action <form> posts under. */
  name?: string;
  value: string | null | undefined;
  options: ProfileOptionRow[];
  placeholder: string;
  legacySuffix: string;
  className?: string;
  // 3a25f5ee — optional DOM id so client islands (e.g. "Same as Permanent Address") can coordinate the
  // rendered <select> by id, matching the ic-dob-autofill pattern.
  id?: string;
  /**
   * THE SECOND BINDING (item 759dfc7d stage 2). Supply it and the select becomes CONTROLLED — `value`
   * plus `onChange`, and NO `name`, so nothing is posted. That is what the Create New Employee tabs need:
   * a draft is one jsonb row held in client state and saved whole, not a form per field.
   *
   * This is the plan's Route A in one prop: the same dropdown, the same catalog, the same legacy-value
   * tolerance, reading and writing the draft blob instead of a person row. A private copy on the draft
   * screen would have been the third place this tolerance rule is written, and the first one to fall
   * behind — the r159 lesson, and the reason 35b7af0a gave the other field groups their `mode` prop.
   *
   * A SERVER component must never pass it (a function prop across the RSC boundary is the r123 fault);
   * both callers today are client components.
   */
  onChange?: (value: string) => void;
}) {
  const current = value ?? '';
  const known = options.some((o) => o.value === current);
  const showLegacy = current !== '' && !known;
  const optionNodes = (
    <>
      <option value="">{placeholder}</option>
      {showLegacy && (
        <option value={current}>
          {current} {legacySuffix}
        </option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.value}>
          {o.label}
        </option>
      ))}
    </>
  );
  if (onChange) {
    return (
      <select id={id} value={current} onChange={(e) => onChange(e.target.value)} className={className ?? inputCls}>
        {optionNodes}
      </select>
    );
  }
  return (
    <select id={id} name={name} defaultValue={current} className={className ?? inputCls}>
      {optionNodes}
    </select>
  );
}
