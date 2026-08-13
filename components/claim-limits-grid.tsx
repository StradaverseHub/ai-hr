'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button, inputCls } from './ui';
import { setGradeClaimLimitsAction } from '@/app/admin/claims/limits/actions';

/**
 * ─────────── CLAIM LIMITS, GRADE-FIRST AND EDITABLE IN PLACE (e7eb5d83 rev 5, step 3) ───────────
 *
 * WHAT THIS REPLACES AND WHY. The grade rail already shipped, so clicking GRADE 12 already showed every
 * claim type and what each was limited to. What it would not let you do is CHANGE anything there: editing
 * meant dropping to a "Set a claim limit" card at the bottom, picking one claim type, saving, and starting
 * again for the next one. Four claim types on a grade meant four trips through that form, and it could not
 * reach a sub-claim at all. The reporter's words were "click GRADE 12, type down the page, press Save
 * once". So the table IS the form now, and the old card is deleted rather than left beside it — two ways
 * to set one limit is how a screen starts disagreeing with itself.
 *
 * ⚠️ A CLIENT ISLAND THAT RECEIVES DATA, NEVER FUNCTIONS. Everything below is plain serialisable props and
 * a server action imported directly. Passing a closure from a server component to a client one 500s on
 * every request while tsc, the suite and `next build` all stay green, so the boundary is worth stating.
 *
 * ⚠️ IT POSTS NO RATE, ANYWHERE. There is no rate control in this grid and there is no rateKind in what it
 * submits, which is the plan's promise that "saving limits will never touch a rate again". That promise
 * only holds because setClaimPolicyTx INHERITS rate_config when the caller supplies none (step 1a): a Save
 * here touches every changed row of a grade, so a screen that posted a default rate would have been the
 * fastest way in the product to wipe the company's mileage rate.
 *
 * ONLY WHAT CHANGED IS WRITTEN. The payload carries the rows whose boxes differ from what they were
 * rendered with, so pressing Save after editing one cell writes one version, not nine. An admin who opens
 * a grade to look and presses Save by reflex writes nothing at all — and each write is an effective-dated
 * version in an append-only table, so "nothing" is meaningfully better than "nine identical rows".
 */

export type ClaimLimitGridValues = {
  perClaimCap: string;
  monthlyLimit: string;
  annualBudget: string;
  blockEnabled: boolean;
  blockLimit: string;
  blockLength: string;
  blockUnit: string;
  maxClaimsPerYear: string;
};

export type ClaimLimitGridRow = {
  /** `${claimTypeId}:${claimItemId ?? ''}` — stable across a re-render, and the payload's identity. */
  key: string;
  claimTypeId: string;
  /** null = the claim TYPE's own row; an id = one of its sub-claims. */
  claimItemId: string | null;
  name: string;
  code: string;
  /** 0 = claim type, 1 = sub-claim (indented under its parent). */
  depth: 0 | 1;
  /** This grade has no row of its own here and is inheriting the company-wide one. */
  inherited: boolean;
  values: ClaimLimitGridValues;
  /**
   * Rendered underneath this row, spanning the table. 'sub' explains that a sub-claim still spends its
   * parent's pot; 'mileage' replaces the sub-claim list entirely on the mileage type (step 4).
   */
  hint: { kind: 'sub'; typeName: string } | { kind: 'mileage'; bands: string } | null;
};

/**
 * ─────────── THE PER BLOCK CELL (e7eb5d83 rev 6) ───────────
 *
 * Five controls that must read as one row — tick, amount, "every", count, unit — and the reporter's
 * complaint was that they stacked. There are TWO causes, and only fixing both puts the row back.
 *
 * ⚠️ CAUSE 1, AND IT IS NOT THE ONE THE PLAN NAMED: `w-24` NEVER APPLIED. These controls were written as
 * `${inputCls} w-24`, and inputCls ALREADY CONTAINS `w-full`. Tailwind v4 emits `.w-full` AFTER `.w-24` /
 * `.w-14` / `.w-28` in the utilities layer (measured: the four rules land in scale order, statics last),
 * so with equal specificity the LAST one wins and every one of these boxes computed to `width: 100%` —
 * of the flex container. In a `flex-wrap` row a 100%-wide item cannot share a line with anything, so the
 * five controls stacked one per line AT EVERY PAGE WIDTH, on a 1920px monitor exactly as on a laptop.
 * Class order in the attribute is not cascade order; that is the whole trap.
 *
 * The fix is `basis-*` rather than `w-*`: in a row flex container the main size comes from `flex-basis`
 * when it is definite, so 6rem/3.5rem/7rem apply regardless of what `width` resolved to, and nothing has
 * to out-order a utility we do not control. `shrink-0` then holds them there instead of letting them
 * squeeze into the same illegible row by a different route. Adding `shrink-0` WITHOUT this change would
 * have been strictly worse — five un-shrinkable 100%-wide boxes on one nowrap line.
 *
 * CAUSE 2, the page width, which the plan did name: this is the sixth column of a six-column table, and
 * the page was capped at `mx-auto max-w-6xl` with a 15rem grade rail taken off the front. Even sized
 * correctly the five need ~350px (16 + 96 + label + 56 + 112 + four 6px gaps) and the column had nowhere
 * near it, so the one cell allowed to fold would have folded anyway. Hence app/admin/claims/limits/page.tsx
 * goes full width in the same change.
 *
 * Mobile-first, so read the wrap rule in that order: below `md` the row still wraps (a tablet has no room
 * for 350px in one column, and stacking is the right answer there), and at `md` and above it may not.
 * This repo uses no `max-*` variants anywhere, so "wrap only on small screens" is spelled as a base rule
 * plus a breakpoint override rather than the other way round.
 *
 * ⚠️ AT `md` AND ABOVE THE TABLE MAY BE WIDER THAN ITS FRAME, and that is the intended outcome, not a
 * regression: the grid's `overflow-x-auto` wrapper scrolls the TABLE. Removing that wrapper would make a
 * narrow window scroll the whole PAGE sideways instead.
 */
const blockCellCls = 'flex flex-wrap items-center gap-1.5 md:flex-nowrap';
/** Shared by all three sized controls in that cell. No `w-*`: see above — it would lose to inputCls. */
const blockBoxCls = 'shrink-0 disabled:opacity-50';

const sameValues = (a: ClaimLimitGridValues, b: ClaimLimitGridValues): boolean =>
  a.perClaimCap === b.perClaimCap &&
  a.monthlyLimit === b.monthlyLimit &&
  a.annualBudget === b.annualBudget &&
  a.blockEnabled === b.blockEnabled &&
  a.blockLimit === b.blockLimit &&
  a.blockLength === b.blockLength &&
  a.blockUnit === b.blockUnit &&
  a.maxClaimsPerYear === b.maxClaimsPerYear;

export function ClaimLimitsGrid({
  rows,
  gradeId,
  gradeLabel,
  today,
  mileageHref,
}: {
  rows: ClaimLimitGridRow[];
  gradeId: string | null;
  /** The grade's name, or the company-wide label — for the Save button, which names what it writes. */
  gradeLabel: string;
  today: string;
  mileageHref: string;
}) {
  const t = useTranslations('admin.claims');
  const initial = useMemo(() => Object.fromEntries(rows.map((r) => [r.key, r.values])), [rows]);
  const [values, setValues] = useState<Record<string, ClaimLimitGridValues>>(initial);
  const [effectiveFrom, setEffectiveFrom] = useState(today);

  const set = (key: string, patch: Partial<ClaimLimitGridValues>) =>
    setValues((v) => ({ ...v, [key]: { ...v[key], ...patch } }));

  // The diff, recomputed on every keystroke. Cheap (nine rows, eight scalars) and it is what makes both
  // the payload and the Save button's disabled state come from ONE source rather than two that can drift.
  const changed = rows.filter((r) => !sameValues(values[r.key], initial[r.key]));
  const payload = JSON.stringify(
    changed.map((r) => {
      const v = values[r.key];
      return {
        claimTypeId: r.claimTypeId,
        claimItemId: r.claimItemId,
        perClaimCap: v.perClaimCap,
        monthlyLimit: v.monthlyLimit,
        annualBudget: v.annualBudget,
        maxClaimsPerYear: v.maxClaimsPerYear,
        // Per block is all-four-or-none: unticked sends the whole rule as empty, which is "no per-block
        // rule" and is every row on production today. blockStartOn is deliberately never sent — the
        // service inherits the anchor already on the rule, so editing a cap cannot restart the window.
        blockEnabled: v.blockEnabled,
        blockLimit: v.blockLimit,
        blockLength: v.blockLength,
        blockUnit: v.blockUnit,
      };
    }),
  );

  const numCls = `${inputCls} w-full text-right tabular-nums`;

  return (
    <form action={setGradeClaimLimitsAction}>
      <input type="hidden" name="gradeId" value={gradeId ?? ''} />
      <input type="hidden" name="payload" value={payload} />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">{t('gridCounts', {
          types: rows.filter((r) => r.depth === 0).length,
          items: rows.filter((r) => r.depth === 1).length,
        })}</span>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('effectiveFromLabel')}
          <input
            name="effectiveFrom"
            type="date"
            required
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className={`${inputCls} w-40`}
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('gridTypeColumn')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('perClaimCapLabel')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('monthlyLimitLabel')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('annualBudgetLabel')}</th>
              <th className="px-3 py-2 font-medium">{t('blockLimitLabel')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('maxClaimsPerYearLabel')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((r) => {
              const v = values[r.key];
              const sub = r.depth === 1;
              const hintRow =
                r.hint == null ? null : (
                  <tr key={`${r.key}:hint`} className="border-t border-border/40 bg-muted/20">
                    <td colSpan={6} className="px-4 py-1.5 pl-9 text-xs text-muted-foreground">
                      {r.hint.kind === 'sub' ? (
                        t('gridSubHint', { type: r.hint.typeName })
                      ) : (
                        <span className="flex flex-wrap items-center gap-x-1.5">
                          <Link href={mileageHref} className="font-medium text-primary underline-offset-2 hover:underline">
                            {t('gridMileagePriced')}
                          </Link>
                          {r.hint.bands ? <span>· {r.hint.bands}</span> : null}
                          <span>· {t('gridMileageNoRate')}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              const main = (
                <tr key={r.key} className="border-t border-border align-top">
                  <td className={`px-4 py-2 ${sub ? 'pl-9' : ''}`}>
                    <div className={sub ? 'text-sm' : 'font-medium'}>
                      {sub ? '↳ ' : ''}
                      {r.name}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{r.code}</div>
                    {/* A grade with no row of its own INHERITS — saying so is the whole point of the
                        screen. A blank cell here is what makes an admin set the same limit twice. */}
                    {r.inherited ? (
                      <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">{t('fallbackBadge')}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min="0" step="0.01" placeholder={t('noCap')} className={numCls}
                      value={v.perClaimCap} onChange={(e) => set(r.key, { perClaimCap: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min="0" step="0.01" placeholder={t('unlimited')} className={numCls}
                      value={v.monthlyLimit} onChange={(e) => set(r.key, { monthlyLimit: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min="0" step="0.01" placeholder={t('unlimited')} className={numCls}
                      value={v.annualBudget} onChange={(e) => set(r.key, { annualBudget: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {/* ⚠️ `basis-*` NOT `w-*`, and the wrap is conditional on purpose — blockCellCls and
                        blockBoxCls above carry the reasoning, including why a `w-24` here silently did
                        nothing for as long as this cell has existed. Do not "tidy" either back. */}
                    <div className={blockCellCls}>
                      <input
                        type="checkbox" className="size-4 shrink-0" checked={v.blockEnabled}
                        aria-label={t('blockEnableLabel')}
                        onChange={(e) => set(r.key, { blockEnabled: e.target.checked })}
                      />
                      <input
                        type="number" min="0" step="0.01" placeholder={t('unlimited')}
                        disabled={!v.blockEnabled}
                        className={`${inputCls} ${blockBoxCls} basis-24 text-right tabular-nums`}
                        value={v.blockLimit} onChange={(e) => set(r.key, { blockLimit: e.target.value })}
                      />
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                        {t('blockEveryLabel').toLowerCase()}
                      </span>
                      <input
                        type="number" min="1" step="1" disabled={!v.blockEnabled}
                        className={`${inputCls} ${blockBoxCls} basis-14 text-right tabular-nums`}
                        value={v.blockLength} onChange={(e) => set(r.key, { blockLength: e.target.value })}
                      />
                      <select
                        disabled={!v.blockEnabled}
                        className={`${inputCls} ${blockBoxCls} basis-28`}
                        value={v.blockUnit} onChange={(e) => set(r.key, { blockUnit: e.target.value })}
                      >
                        <option value="month">{t('blockUnit_month')}</option>
                        <option value="year">{t('blockUnit_year')}</option>
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min="0" step="1" placeholder={t('unlimited')} className={numCls}
                      value={v.maxClaimsPerYear} onChange={(e) => set(r.key, { maxClaimsPerYear: e.target.value })}
                    />
                  </td>
                </tr>
              );
              return hintRow == null ? [main] : [main, hintRow];
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
        <Button type="submit" disabled={changed.length === 0}>
          {t('gridSaveAll', { grade: gradeLabel })}
        </Button>
        <button
          type="button"
          onClick={() => setValues(initial)}
          disabled={changed.length === 0}
          className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t('gridReset')}
        </button>
        <span className="text-xs text-muted-foreground">{t('gridChangedOnly')}</span>
      </div>
    </form>
  );
}
