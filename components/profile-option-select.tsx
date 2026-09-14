import { inputCls } from '@/components/ui';

/**
 * The narrow shape either rendering needs: a value, its label, and a stable React key.
 * `core/profile-options.ts`'s `ProfileOptionRow` satisfies it, and so does the trimmed `{ id, value, label }` the Create New Employee wizard receives —
 * that screen is a client component, and shipping a catalog row's sort order and active flag across the
 * boundary would put columns in the browser bundle that nothing on the page reads.
 */
export type ProfileOptionChoice = { id?: string; value: string; label: string };

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
  // Widened to the narrow shape (a72610af) so the SAME props satisfy both renderings; every existing
  // caller still passes full `ProfileOptionRow`s, which are assignable to it.
  options: ProfileOptionChoice[];
  placeholder: string;
  legacySuffix: string;
  className?: string;
  // 3a25f5ee — optional DOM id so client islands (e.g. "Same as Permanent Address") can coordinate the
  // rendered <select> by id, matching the ic-dob-autofill pattern.
  id?: string;
}) {
  const current = value ?? '';
  return (
    <select id={id} name={name} defaultValue={current} className={className ?? inputCls}>
      {profileOptionChoices(current, options, placeholder, legacySuffix)}
    </select>
  );
}

/**
 * THE CATALOG'S OPTION LIST, INCLUDING THE LEGACY-TOLERANCE EXTRA — one definition, two renderings.
 *
 * Item a72610af needed the SAME dropdown on the Create New Employee wizard, where the value is held in
 * the draft's React state rather than read out of FormData at submit. The legacy rule is the part that
 * must not be copied: an off-catalog stored value is rendered as a pre-selected extra so a save never
 * blanks it, and a second copy of that is a second place for it to rot. Both components below build
 * their options here.
 */
function profileOptionChoices(
  current: string,
  options: ProfileOptionChoice[],
  placeholder: string,
  legacySuffix: string,
) {
  const known = options.some((o) => o.value === current);
  const showLegacy = current !== '' && !known;
  return (
    <>
      <option value="">{placeholder}</option>
      {showLegacy && (
        <option value={current}>
          {current} {legacySuffix}
        </option>
      )}
      {options.map((o) => (
        <option key={o.id ?? o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </>
  );
}

/**
 * The CONTROLLED twin of `ProfileOptionSelect` (item a72610af) — the same catalog, the same legacy
 * tolerance, the same placeholder, driven by `value` + `onChange` and carrying NO `name` at all.
 *
 * NO `name` IS DELIBERATE and is the r159 lesson: the Create New Employee wizard submits its draft as
 * JSON, not as FormData, so a guard grepping for `name="religion"` must never be able to conclude that
 * this copy posts anything.
 */
export function ProfileOptionSelectControlled({
  value,
  options,
  placeholder,
  legacySuffix,
  className,
  onChange,
}: {
  value: string | null | undefined;
  options: ProfileOptionChoice[];
  placeholder: string;
  legacySuffix: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  const current = value ?? '';
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? inputCls}
    >
      {profileOptionChoices(current, options, placeholder, legacySuffix)}
    </select>
  );
}
