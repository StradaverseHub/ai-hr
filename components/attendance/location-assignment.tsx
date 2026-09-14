'use client';

import { useMemo, useState } from 'react';
import { MultiSelectPopover } from '@/components/ui/multi-select-popover';

/**
 * r272 (0e8cf366) — LOCATION ASSIGNMENT: where this employee is allowed to clock in and clock out.
 *
 * WHAT THIS REPLACES. A bare `<select multiple className="h-28">` whose options read
 * `CODE · Name · within N m`. It had no search, showed neither address nor status, and the only way to
 * unassign somebody was to ctrl-click a highlighted row — which is the whole of the reporter's complaint
 * about this card. Every field in the table below was already on the row `listClockingLocations` returns;
 * nothing new is read and nothing new is stored.
 *
 * ONE SOURCE OF TRUTH FOR THE SELECTION. The table and the picker are two views of one `Set`. Remove is
 * not a separate action — it takes the id out of that set, exactly as unticking it in the picker does —
 * so the two can never disagree about what is about to be saved.
 *
 * THE FORM CONTRACT IS THE PICKER'S. `MultiSelectPopover` emits one hidden input per selected id under
 * `name`, OUTSIDE its open/closed guard, so the posted set survives the panel closing before submit. The
 * enclosing server action still reads `fd.getAll('clockingLocationIds')` and still performs a full-set
 * replace; this component changed the control, not the contract.
 *
 * ⚠️ NO PRE-TICK. The old card seeded this control from the employee's branch-derived work location when
 * nothing was assigned. It seeded the control only and never saved on its own — but it is the single
 * thing that made the reporter believe the system was choosing clocking locations from Company, State,
 * Holiday Calendar and Branch, which it has never done (`core/attendance.ts` `resolveGeofence` joins the
 * assignment table and nothing else). An empty assignment now renders empty, and says so.
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
};

export function LocationAssignment({
  name,
  locations,
  defaultSelected,
  labels,
  disabled = false,
}: {
  /** The field the enclosing form posts. One hidden input per selected id. */
  name: string;
  locations: AssignableLocation[];
  defaultSelected: string[];
  labels: {
    intro: string;
    colLocation: string;
    colAddress: string;
    colRadius: string;
    colStatus: string;
    remove: string;
    none: string;
    addLocation: string;
    all: string;
    search: string;
    selectAll: string;
    clearAll: string;
    /**
     * ⚠️ A TEMPLATE STRING, NOT A FUNCTION. This is a client component, and a function prop from the
     * server page is a hard render error — "Functions cannot be passed directly to Client Components" —
     * which tsc, eslint and every source guard pass happily. The render check is what caught it, on a
     * page that returned 500. `{count}` is substituted here. Same shape as `ReplacementEligibilityPicker`.
     */
    selectedCountTemplate: string;
    active: string;
    inactive: string;
    noRadius: string;
  };
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelected));

  // Assigned rows in the order the caller supplied, so the table reads the same way the picker does and
  // a save does not reorder anything the reader was looking at.
  const chosen = useMemo(() => locations.filter((l) => selected.has(l.id)), [locations, selected]);

  const remove = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{labels.intro}</p>

      {chosen.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {labels.none}
        </p>
      ) : (
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
                <tr key={l.id} className="align-top">
                  <td className="px-3 py-2 font-medium">
                    {l.code ? <span className="text-muted-foreground">{l.code} · </span> : null}
                    {l.name}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{l.address || '—'}</td>
                  {/* A site with no radius can never match at clock-in (core/attendance.ts reads the
                      site's own figure unless the employment overrides it), so it says so rather than
                      rendering a blank that looks like nothing is wrong. */}
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {l.radiusM == null || l.radiusText == null ? (
                      <span className="font-medium text-amber-700 dark:text-amber-500">{labels.noRadius}</span>
                    ) : (
                      l.radiusText
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {l.archived ? (
                      <span className="text-muted-foreground">{labels.inactive}</span>
                    ) : (
                      <span className="text-foreground">{labels.active}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/* type="button" is load-bearing: this sits inside the Attendance tab's form, and a
                        bare <button> there submits it. */}
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
      )}

      <MultiSelectPopover
        name={name}
        label={labels.addLocation}
        allLabel={labels.all}
        options={locations.map((l) => ({
          id: l.id,
          // The picker is one line per option, so the radius rides along — it is the figure that decides
          // whether a clock-in at that site is accepted, and picking blind is how a wrong one gets saved.
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
  );
}
