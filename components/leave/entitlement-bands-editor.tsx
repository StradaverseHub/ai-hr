'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { btnGhost, inputCls } from '@/components/ui';
// 4a1abc4a — the shared day formatter. Only the three DAY columns use it; From/To Year(s) are years.
import { normalizeDayText } from '@/lib/day-format';

/**
 * 6e9a126e RELEASE TWO — THE ENTITLEMENT TABLE EDITOR (the reporter's Step 1, verbatim).
 *
 * The request tabulated five columns and this component is those five columns and nothing else:
 *
 *   | From Year(s) | To Year(s) | Entitled Days | Max Brought Forward | Max Entitled + Brought Forward |
 *
 * They map onto the SHARED `ServiceBand` shape — `fromYears`, `toYears`, `days`, `carryForwardDays`,
 * `maxBalanceDays` — which `scheme_leave_entitlement` and `leave_policy.accrual` already use and which
 * `bandFor` / `isWellFormedBands` already resolve. Carried forward unchanged on purpose: a new band shape
 * would fork the one piece of this area that is already right.
 *
 * ⚠️ IT IS NOT A REBUILD OF THE THREE-TIER MATRIX in components/benefit-scheme-config.tsx. That editor
 * offers exactly the bands <2y / 2-5y / 5y+ across a grade × scheme grid, which is the hardcoded shape the
 * reporter asked to be rid of ("allow HR to define their own service ranges"). This one has no fixed
 * cutoffs and no grid; the population is a separate step now.
 *
 * ⚠️ TO YEAR(S) BLANK MEANS "NO LIMIT", AND THE LAST ROW MUST BE BLANK. `isWellFormedBands` requires the
 * final band to be open-ended and the set to be contiguous from 0 — a table that fails it resolves to NO
 * BAND, i.e. the employee falls through to the scheme/policy with nothing on screen to say why. The client
 * cannot be the guard (a post can bypass it), so `validateServiceBands` refuses it server-side with a real
 * message; this only makes the shape obvious while typing.
 *
 * POSTS ONE HIDDEN `serviceBands` JSON FIELD, which is the convention the existing band editors in
 * components/benefit-scheme-config.tsx already use, so the server action's reader is the same shape.
 */
export type EditableBand = {
  fromYears: string;
  toYears: string;
  days: string;
  carryForwardDays: string;
  maxBalanceDays: string;
};

const BLANK: EditableBand = { fromYears: '', toYears: '', days: '', carryForwardDays: '', maxBalanceDays: '' };

/** A blank first table: one open-ended band from 0, which is the smallest well-formed set. */
export const DEFAULT_BANDS: EditableBand[] = [{ ...BLANK, fromYears: '0' }];

/**
 * The stored JSONB the form actually posts. Blank optional cells are OMITTED rather than sent as 0:
 * `bandCarryMax` reads a finite number >= 0 as an OVERRIDE of the policy-level cap, so a blank box
 * persisted as 0 would silently mean "carry nothing" instead of "not set on this band".
 */
export function toStoredBands(rows: EditableBand[]) {
  return rows.map((r) => {
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    const out: Record<string, number | null> = {
      fromYears: Number(r.fromYears || 0),
      toYears: num(r.toYears),
      days: Number(r.days || 0),
    };
    const carry = num(r.carryForwardDays);
    if (carry != null) out.carryForwardDays = carry;
    const maxBal = num(r.maxBalanceDays);
    if (maxBal != null) out.maxBalanceDays = maxBal;
    return out;
  });
}

export function EntitlementBandsEditor({
  initial,
  maxBands,
}: {
  initial: EditableBand[];
  /** `MAX_SERVICE_BANDS`, passed in from the server so the ceiling has ONE definition (core/leave-compute). */
  maxBands: number;
}) {
  const t = useTranslations('admin.entitlementTemplates');
  const [rows, setRows] = useState<EditableBand[]>(initial.length ? initial : DEFAULT_BANDS);

  const set = (i: number, key: keyof EditableBand, v: string) =>
    setRows((prev) => prev.map((r, ix) => (ix === i ? { ...r, [key]: v } : r)));

  /**
   * 4a1abc4a — tidy a DAY cell to 2dp when the operator clicks away, so "12.5" and the "12.50" that gets
   * saved are the same thing on screen.
   *
   * ONLY the three day columns get this. From / To Year(s) are years of service, not days, and "0.00 years"
   * would be a new and wrong claim about what that column measures.
   *
   * A BLANK CELL MUST STAY BLANK, which `normalizeDayText` guarantees and which matters more here than
   * anywhere else on the screen: `toStoredBands` OMITS a blank Max Brought Forward / Max Entitled cell, and
   * `bandCarryMax` reads that omission as "not set on this band, use the policy cap". A blur handler that
   * wrote "0.00" into an empty box would silently turn every untouched row into "carry nothing".
   */
  const tidyDays = (i: number, key: 'days' | 'carryForwardDays' | 'maxBalanceDays') => (e: { currentTarget: { value: string } }) => {
    const next = normalizeDayText(e.currentTarget.value);
    if (next !== e.currentTarget.value) set(i, key, next);
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-medium">{t('bandFrom')}</th>
              <th className="px-2 py-2 font-medium">{t('bandTo')}</th>
              <th className="px-2 py-2 font-medium">{t('bandDays')}</th>
              <th className="px-2 py-2 font-medium">{t('bandCarry')}</th>
              <th className="px-2 py-2 font-medium">{t('bandMaxBalance')}</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-2 py-1">
                  <input
                    className={inputCls}
                    type="number"
                    min={0}
                    value={r.fromYears}
                    onChange={(e) => set(i, 'fromYears', e.target.value)}
                    aria-label={t('bandFrom')}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className={inputCls}
                    type="number"
                    min={0}
                    value={r.toYears}
                    placeholder={t('bandNoLimit')}
                    onChange={(e) => set(i, 'toYears', e.target.value)}
                    aria-label={t('bandTo')}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className={inputCls}
                    type="number"
                    min={0}
                    step="0.5"
                    value={r.days}
                    onChange={(e) => set(i, 'days', e.target.value)}
                    onBlur={tidyDays(i, 'days')}
                    aria-label={t('bandDays')}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className={inputCls}
                    type="number"
                    min={0}
                    step="0.5"
                    value={r.carryForwardDays}
                    onChange={(e) => set(i, 'carryForwardDays', e.target.value)}
                    onBlur={tidyDays(i, 'carryForwardDays')}
                    aria-label={t('bandCarry')}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className={inputCls}
                    type="number"
                    min={0}
                    step="0.5"
                    value={r.maxBalanceDays}
                    onChange={(e) => set(i, 'maxBalanceDays', e.target.value)}
                    onBlur={tidyDays(i, 'maxBalanceDays')}
                    aria-label={t('bandMaxBalance')}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    className={btnGhost}
                    // The last remaining row is not removable: an empty table is not a well-formed band
                    // set, and the server would refuse the save with a message the operator would then
                    // have to decode. Refusing the removal is the same rule stated earlier.
                    disabled={rows.length <= 1}
                    onClick={() => setRows((prev) => prev.filter((_, ix) => ix !== i))}
                  >
                    {t('bandRemove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={btnGhost}
          disabled={rows.length >= maxBands}
          onClick={() =>
            setRows((prev) => [
              ...prev,
              // A new row starts where the previous one ended, which is the only contiguous choice.
              { ...BLANK, fromYears: prev[prev.length - 1]?.toYears || '' },
            ])
          }
        >
          {t('bandAdd')}
        </button>
        {/* The ceiling is quoted, not just enforced: a disabled button with no explanation reads as a bug.
            `bandCeiling` carries a {max} placeholder, so it is formatted with the value — a plain t() here
            would throw FORMATTING_ERROR at render behind a 200. */}
        <span className="text-xs text-muted-foreground">{t('bandCeiling', { max: maxBands })}</span>
      </div>
      <input type="hidden" name="serviceBands" value={JSON.stringify(toStoredBands(rows))} />
    </div>
  );
}
