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
}: {
  name: string;
  value: string | null | undefined;
  options: ProfileOptionRow[];
  placeholder: string;
  legacySuffix: string;
  className?: string;
  // 3a25f5ee — optional DOM id so client islands (e.g. "Same as Permanent Address") can coordinate the
  // rendered <select> by id, matching the ic-dob-autofill pattern.
  id?: string;
}) {
  const current = value ?? '';
  const known = options.some((o) => o.value === current);
  const showLegacy = current !== '' && !known;
  return (
    <select id={id} name={name} defaultValue={current} className={className ?? inputCls}>
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
    </select>
  );
}
