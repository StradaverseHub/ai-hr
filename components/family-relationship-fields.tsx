'use client';

import { useState, type ReactNode } from 'react';
import { Field, inputCls } from '@/components/ui';

/**
 * ea36b7fa — Family & Dependents consolidation: the unified Add/Edit family-member dialog asks the natural
 * first question — Relationship — and adapts the form to the answer. This island holds ONLY the selected
 * relationship value; the three field panels are SERVER-RENDERED JSX passed in as slots (the same
 * dependentFields builder as before, so field names / `__present` markers / i18n labels never fork into a
 * client bundle — and no core/ import here, since core/dependents.ts pulls the pg driver via db/client).
 *
 * Panel routing mirrors core/dependents.ts extraColumnsForAdd exactly: 'spouse' → spouse panel, 'child' →
 * child panel, EVERYTHING else (parent / sibling / other / any custom catalog type) → the standard panel,
 * because the server NULLs spouse-only and child-only columns for those relationships anyway.
 *
 * The inactive panels are wrapped in `<fieldset disabled hidden>`: `hidden` removes them visually and
 * `disabled` keeps their controls OUT of the form post (disabled controls never submit) — critical because
 * all three panels carry the same field names (fullName, dateOfBirth, …) and the server actions treat
 * "field present" as meaningful (the `__present` tri-state markers). Disabled controls also skip HTML
 * validation, so the hidden panels' `required` inputs never block a submit.
 *
 * On Add the select starts EMPTY (required + disabled placeholder), so no fields show until a relationship
 * is chosen — the flow the request asked for. On Edit it starts at the stored relationship; switching it
 * swaps panels, and the server's relationship-change gating NULLs the now-irrelevant columns on save.
 */
export function FamilyRelationshipFields({
  label,
  placeholder,
  options,
  initialValue = '',
  spousePanel,
  childPanel,
  otherPanel,
}: {
  label: string;
  placeholder: string;
  options: { value: string; label: string }[];
  initialValue?: string;
  spousePanel: ReactNode;
  childPanel: ReactNode;
  otherPanel: ReactNode;
}) {
  const [relationship, setRelationship] = useState(initialValue);
  const panel =
    relationship === '' ? null : relationship === 'spouse' ? 'spouse' : relationship === 'child' ? 'child' : 'other';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
        <Field label={label}>
          <select
            name="relationship"
            required
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              {placeholder}
            </option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset disabled={panel !== 'spouse'} hidden={panel !== 'spouse'}>
        {spousePanel}
      </fieldset>
      <fieldset disabled={panel !== 'child'} hidden={panel !== 'child'}>
        {childPanel}
      </fieldset>
      <fieldset disabled={panel !== 'other'} hidden={panel !== 'other'}>
        {otherPanel}
      </fieldset>
    </div>
  );
}
