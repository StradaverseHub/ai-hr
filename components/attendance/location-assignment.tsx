'use client';

import { useMemo, useState } from 'react';
import { MultiSelectPopover } from '@/components/ui/multi-select-popover';

/**
 * r272 (0e8cf366) — LOCATION ASSIGNMENT: where this employee is allowed to clock in and clock out.
 *
 * ONE SOURCE OF TRUTH FOR THE SELECTION. The table and the picker are two views of one `Set`. Remove is
 * not a separate action — it takes the id out of that set, exactly as unticking it in the picker does —
 * so the two can never disagree about what is about to be saved.
 *
 * THE FORM CONTRACT IS THE PICKER'S. `MultiSelectPopover` emits one hidden input per selected id under
 * `name`, OUTSIDE its open/closed guard, so the posted set survives the panel closing before submit.
 *
 * ⚠️ NO PRE-TICK. An empty assignment renders empty, and says so (r272).
 *
 * r423 (83c0d3c8) — ONE SWITCH DECIDES. "Use Geofencing for Clocking" (posted as `switchName`, a checkbox:
 * off posts nothing) replaced the separate "Enforce geofencing" tick box and the "Radius override" box.
 *   • OFF — the location field is hidden and nothing needs choosing. The picker is UNMOUNTED, so no ids
 *     are posted; the server clears the assignments on save (the change history keeps the old list). The
 *     selection is held here, so turning the switch back on before saving shows it again.
 *   • ON — the Clocking Location field appears. The picker offers ONLY the active locations open to the
 *     employee's company (the server page filters; the server action refuses anything else). A location
 *     assigned earlier that is no longer usable (inactive, or not open to the employee's company — e.g.
 *     after a transfer) stays in the table, FLAGGED with why, and does not count towards the one required.
 *     With no usable location chosen the card says the employee cannot clock in until one is assigned;
 *     Save is refused by the server in the plan's words.
 */

export type AssignableLocation = {
  id: string;
  name: string;
  /** The `location` master's code, where this site is linked to one. Blank is normal and common. */
  code: string | null;
  address: string | null;
  radiusM: number | null;
  /** "within 100 m", already formatted by the server page. Null where the site has no radius. */
  radiusText: string | null;
  archived: boolean;
  /**
   * r423 — null when the location can be clocked at by this employee. Otherwise the reason it cannot,
   * already translated ("Inactive — does not accept clocking" / "Not open to … — does not accept
   * clocking"). An unusable location is never OFFERED; it only appears when it is already assigned.
   */
  unusableReason: string | null;
};

export function LocationAssignment({
  name,
  switchName,
  defaultEnabled,
  locations,
  defaultSelected,
  labels,
  disabled = false,
}: {
  /** The field the enclosing form posts. One hidden input per selected id. */
  name: string;
  /** r423 — the switch's field name. Checked posts `on`; off posts nothing. */
  switchName: string;
  defaultEnabled: boolean;
  /** Every location the table may show: the offered (usable) ones plus any assigned unusable one. */
  locations: AssignableLocation[];
  defaultSelected: string[];
  labels: {
    switchTitle: string;
    switchDescription: string;
    switchOn: string;
    switchOff: string;
    offNote: string;
    fieldLabel: string;
    requiredMark: string;
    pickerHint: string;
    requiredNote: string;
    cannotClockWarning: string;
    colLocation: string;
    colAddress: string;
    colRadius: string;
    colStatus: string;
    remove: string;
    addLocation: string;
    all: string;
    search: string;
    selectAll: string;
    clearAll: string;
    /**
     * ⚠️ A TEMPLATE STRING, NOT A FUNCTION. This is a client component, and a function prop from the
     * server page is a hard render error — "Functions cannot be passed directly to Client Components".
     * `{count}` is substituted here.
     */
    selectedCountTemplate: string;
    active: string;
    noRadius: string;
    noneOffered: string;
  };
  disabled?: boolean;
}) {
  const [enabled, setEnabled] = useState(defaultEnabled);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelected));

  const offered = useMemo(() => locations.filter((l) => l.unusableReason == null), [locations]);
  // Assigned rows in the order the caller supplied, so the table reads the same way the picker does.
  const chosen = useMemo(() => locations.filter((l) => selected.has(l.id)), [locations, selected]);
  const usableChosen = chosen.filter((l) => l.unusableReason == null).length;

  // The picker OFFERS only the usable locations but is handed the WHOLE selection: an assigned-but-unusable
  // id is not an option, so it cannot be ticked or unticked there, yet MultiSelectPopover still emits its
  // hidden input (it posts every selected id) and its select-all / clear-all keep ids that are not options.
  // So a Save that did not touch a flagged row does not silently drop it; Remove in the table does.

  const remove = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-sm font-medium text-foreground">{labels.switchTitle}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{labels.switchDescription}</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground" aria-hidden>
            {enabled ? labels.switchOn : labels.switchOff}
          </span>
          <input
            type="checkbox"
            role="switch"
            name={switchName}
            checked={enabled}
            aria-checked={enabled}
            aria-label={labels.switchTitle}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={disabled}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative inline-flex h-6 w-11 items-center rounded-full border border-border bg-muted transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50"
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </span>
        </label>
      </div>

      {!enabled ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          {labels.offNote}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">
            {labels.fieldLabel}
            <span className="ml-0.5 text-destructive" aria-label={labels.requiredMark}>
              *
            </span>
          </p>

          {usableChosen === 0 ? (
            <p
              role="status"
              className="rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-400"
            >
              {labels.cannotClockWarning}
            </p>
          ) : null}

          {chosen.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{labels.colLocation}</th>
                    <th className="px-3 py-2 font-medium">{labels.colAddress}</th>
                    <th className="px-3 py-2 font-medium">{labels.colRadius}</th>
                    <th className="px-3 py-2 font-medium">{labels.colStatus}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {chosen.map((l) => (
                    <tr key={l.id} className={`align-top ${l.unusableReason ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''}`}>
                      <td className="px-3 py-2 font-medium">
                        {l.code ? <span className="text-muted-foreground">{l.code} · </span> : null}
                        {l.name}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.address || '—'}</td>
                      <td className="px-3 py-2 text-xs tabular-nums">
                        {l.radiusM == null || l.radiusText == null ? (
                          <span className="font-medium text-amber-700 dark:text-amber-500">{labels.noRadius}</span>
                        ) : (
                          l.radiusText
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {l.unusableReason ? (
                          <span className="font-medium text-amber-700 dark:text-amber-500">{l.unusableReason}</span>
                        ) : (
                          <span className="text-foreground">{labels.active}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* type="button" is load-bearing: this sits inside the Attendance tab's form. */}
                        <button
                          type="button"
                          onClick={() => remove(l.id)}
                          disabled={disabled}
                          className="text-xs text-destructive underline underline-offset-2 disabled:opacity-50"
                        >
                          {labels.remove}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="max-w-md">
            <MultiSelectPopover
              name={name}
              label={labels.addLocation}
              allLabel={labels.all}
              options={offered.map((l) => ({
                id: l.id,
                // One line per option, so the radius rides along — it decides whether a clock-in is accepted.
                name: `${l.code ? `${l.code} · ` : ''}${l.name}${l.radiusText ? ` · ${l.radiusText}` : ''}`,
              }))}
              selected={selected}
              onChange={setSelected}
              searchPlaceholder={labels.search}
              selectAllLabel={labels.selectAll}
              clearAllLabel={labels.clearAll}
              selectedCount={(n) => labels.selectedCountTemplate.replace('{count}', String(n))}
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{offered.length === 0 ? labels.noneOffered : labels.pickerHint}</p>
          <p className="text-xs text-muted-foreground">{labels.requiredNote}</p>
        </div>
      )}
    </div>
  );
}
