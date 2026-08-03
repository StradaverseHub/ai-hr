'use client';

/**
 * 296fc027 · "Who may submit a replacement-leave request" — eight searchable pickers, one loop.
 *
 * WHY THIS IS A CLIENT COMPONENT AT ALL. `MultiSelectPopover` is the only house picker that carries a
 * SEARCH box, and the request asks for search, multi-select, select-all and deselect-all. But it is a
 * CONTROLLED component (`selected` / `onChange`), so somebody has to hold eight Sets of state. That is
 * this file's entire job: hold the state, render what it is given, and let each popover emit its own
 * hidden inputs so the enclosing server-action `<form>` sees `fd.getAll(key)` exactly as the leave-type
 * criteria form does. `ChipMultiSelect` would have needed no state but has no search, which is the one
 * affordance the request names explicitly.
 *
 * THE CRITERIA LIST IS A PROP, NOT AN IMPORT, and that is two decisions at once:
 *   1. Bundle. `core/replacement-eligibility.ts` pulls in drizzle-orm and db/schema for its as-of
 *      resolver. Importing it here would drag both into the CLIENT bundle for the sake of an eight-entry
 *      array. core/leave-org-criteria.ts stays deliberately DB-free for exactly this reason; this module
 *      cannot, so the dependency goes the other way instead.
 *   2. The pack ratchet (ADR-0080 D9). `core/replacement-eligibility` is a leave-pack BOUNDARY module, so
 *      a components/ file importing it directly would be drift — and the fix would be an allowlist entry,
 *      on a list documented to only ever shrink.
 * Passing the resolved, already-translated descriptor as serialisable data solves both at once.
 *
 * THE SERVER/CLIENT BOUNDARY, OBSERVED. Every prop is SERIALISABLE — arrays of {id,name}, arrays of
 * {key,label}, and plain strings. NO `t` function and no closure is received from the server page. That is
 * not stylistic: a function prop crossing this boundary throws AT RENDER, and neither tsc, nor
 * `next build`, nor the suite catches it — test/server-client-boundary.test.ts is the only thing that
 * does, and it reads these props. The one function below (`selectedCount`) is BUILT HERE from a string.
 */
import { useState } from 'react';
import { MultiSelectPopover, type MultiSelectPopoverOption } from '@/components/ui/multi-select-popover';

/** One picker: the criterion's key (= the FormData field name AND the stored JSONB key) and its caption. */
export type ReplacementEligibilityCriterionProp = { key: string; label: string };

export type ReplacementEligibilityPickerLabels = {
  all: string;
  search: string;
  selectAll: string;
  clearAll: string;
  /** "{count} selected", with the literal placeholder left in for this component to substitute. */
  selectedCountTemplate: string;
};

export function ReplacementEligibilityPicker({
  criteria,
  options,
  defaultSelected,
  labels,
  disabled,
}: {
  criteria: ReplacementEligibilityCriterionProp[];
  /** Option list per criterion key. A key with no options still renders, showing an empty picker. */
  options: Record<string, MultiSelectPopoverOption[]>;
  defaultSelected: Record<string, string[]>;
  labels: ReplacementEligibilityPickerLabels;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(criteria.map((c) => [c.key, new Set(defaultSelected[c.key] ?? [])])),
  );

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {criteria.map((c) => (
        <MultiSelectPopover
          key={c.key}
          // The FormData contract: one hidden input per selected value under the criterion's own key,
          // which is BY CONSTRUCTION the JSONB key too (see core/replacement-eligibility.ts). The action
          // reads it back with fd.getAll(key) — no JSON round-trip, no per-field wiring.
          name={c.key}
          label={c.label}
          allLabel={labels.all}
          options={options[c.key] ?? []}
          selected={selected[c.key] ?? new Set()}
          onChange={(next) => setSelected((prev) => ({ ...prev, [c.key]: next }))}
          searchPlaceholder={labels.search}
          selectAllLabel={labels.selectAll}
          clearAllLabel={labels.clearAll}
          selectedCount={(n) => labels.selectedCountTemplate.replace('{count}', String(n))}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
