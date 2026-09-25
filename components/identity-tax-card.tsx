'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { TaxCategoryField } from './tax-category-field';
import {
  ChildReliefModeField,
  ChildReliefModeHint,
  DisabledReliefField,
  DisabledReliefHints,
} from './tax-relief-fields';

// Inlined design tokens (server module) so this stays a clean client island — same pattern as bank-info-card.tsx.
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export type IdentityTaxDefaults = {
  taxNumber: string | null;
  taxCategory: number;
  taxResidency: string;
  numChildren: number;
  childReliefMode: string;
  employerBearsTax: boolean;
  /** Item d64d0df4 — registered disabled individual (OKU). Defaults to false. */
  disabledIndividual: boolean;
  /** Item d64d0df4 — the employee's SPOUSE is a registered disabled individual. Defaults to false.
   *  Only moves the tax figure for tax category 2 (married, spouse not working); the card says so. */
  disabledSpouse: boolean;
  /** Item d64d0df4 — the 'auto_table' category grid: per LHDN s.48 category, the count of children
   *  claimed at 100% and the count claimed at 50%. Null / absent keys ⇒ nothing keyed yet. */
  childReliefTable: Record<string, { full: number; half: number }> | null;
};

/**
 * 04b88724 — WHAT THE PACK PRICES, handed to this island as data.
 *
 * The card has to show the qualifying-children count LIVE, while the admin types into the grid, so the
 * count cannot be a figure the server computed once for the saved record — it would contradict the boxes
 * on screen the moment anything is keyed. What travels instead is the PRICES: per s.48 category, the
 * ringgit and the qualifying UNITS the resolved ruleset (`childByCategory` ÷ `perChild`) values it at. The
 * statutory RULE stays in the country pack, which is its only owner; this island multiplies those prices by
 * the counts the admin keyed, which is exactly what `gridHeadCount` already does for the head count.
 *
 * `null` (no pack, or a pack publishing no PCB reliefs) means the card shows the head count alone and names
 * no figure — core/dependents.ts `qualifyingChildReliefFor` reports nothing rather than inventing a rate.
 */
export type ChildReliefPricing = {
  /** The flat per-child relief in RM (RM2,000 in 2026): the divisor, and the rate the two non-table modes
   *  are priced at because the kernel's child leg is `num_children × perChild` in those modes. */
  perChild: number;
  /** Per category: the ringgit and the qualifying units the resolved ruleset prices it at. */
  categories: { key: string; amountRM: number; units: number }[];
  /** The ruleset version that priced the above, so the reader knows which schedule they are reading. */
  statutoryVersion: string | null;
  /** Live 'child' rows on the Family register. Shown when it disagrees with the stored head count — that
   *  disagreement is information, not an error, and it is exactly what the reporter wanted visible. */
  familyChildren: number;
  /** Eligible children carrying no relief category: they would contribute nothing to a category-priced
   *  figure, so a reader must know they exist before trusting one. */
  uncategorisedChildren: number;
  /** One line per ELIGIBLE child on the Family register — the working behind 'auto' mode's figure. */
  familyRows: { name: string; category: string | null; sharePercent: number }[];
};

/** A whole count reads as a whole number; a 50%-shared child priced by category produces a HALF unit, and
 *  rounding it would make the count disagree with the ringgit beside it. See core/dependents.ts. */
const fmtCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fmtRM = (n: number) =>
  new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/** The five LHDN s.48 categories, in the canonical order the grid renders them. Kept as a literal here
 *  rather than imported from the server pack so this client island pulls no server module into the
 *  bundle; the list is pinned equal to the pack's CHILD_RELIEF_CATEGORY_KEYS by a test. */
const CHILD_RELIEF_CATEGORY_KEYS = [
  'under_18',
  'study_preu',
  'study_tertiary',
  'disabled',
  'disabled_study',
] as const;

/**
 * Identification & Tax card (item 8b5334db). Dedicated, visually-separated card with its OWN save (setTaxAction,
 * a partial update of only the tax columns). IC lives on the Profile tab now; this card carries only tax-related
 * information: Tax Number, Tax Category, Income Tax Resident, Children (PCB relief) with manual/auto control, and
 * the Employer-bears-tax switch. Client island so the child-relief auto suggestion is interactive; the RSC page
 * renders it as JSX only, so the server/client boundary is respected.
 *
 * Tax Category maps the five business labels to the LHDN integers the PCB engine needs (Single→1, Married &
 * Spouse Not Working→2, Married & Spouse Working→3, Divorced/Single with Kids→3, None→1). Two labels share value
 * 3 and two share value 1; the browser highlights the first option for a given stored value on reload (we only
 * persist the integer the engine uses — the label is a data-entry convenience).
 *
 * Children auto mode SURFACES the family-derived eligible count for HR to confirm into numChildren — it never
 * silently syncs (respects the benefits-vs-tax firewall). Manual mode keeps HR's keyed figure.
 */
export function IdentityTaxCard({
  action,
  employmentId,
  personId,
  defaults,
  derivedChildCount,
  childRelief = null,
  taxNumberSharedWith = [],
  embedded = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  employmentId: string;
  personId: string;
  defaults: IdentityTaxDefaults;
  derivedChildCount: number;
  /** 04b88724 — the pack's prices for the qualifying-children figure; null when none can be resolved. */
  childRelief?: ChildReliefPricing | null;
  /**
   * 7ee14bbc — the OTHER people in this company already filed under `defaults.taxNumber`, by name.
   *
   * THE CP39 PREVIEW'S WARNING, AT THE POINT THE NUMBER IS ENTERED, which is what the approved plan
   * asks for: without it a duplicate keyed here is discovered on the statement at filing time. Names,
   * because "this number is used twice" is unactionable — the operator has to know WHO the other record
   * is to tell which of the two is wrong. Advisory: it never blocks the save, and it is empty for
   * everybody who is not a duplicate, which is almost everybody.
   */
  taxNumberSharedWith?: string[];
  /**
   * Item df09f22a — when true the island drops its own outer card chrome and renders as an "Income Tax (PCB)"
   * section nested inside the Statutory (Malaysia) card (visual merge). It keeps its OWN <form action={setTaxAction}>
   * and Save button — only the surrounding presentation changes, so the two-action design is preserved.
   */
  embedded?: boolean;
}) {
  const t = useTranslations('people.detail');
  const [mode, setMode] = useState(
    defaults.childReliefMode === 'auto' || defaults.childReliefMode === 'auto_table'
      ? defaults.childReliefMode
      : 'manual',
  );
  const [numChildren, setNumChildren] = useState<string>(String(defaults.numChildren ?? 0));
  // Item d64d0df4 — the 'auto_table' grid. Held as STRINGS so an emptied cell stays empty while the
  // admin retypes it (a number state would snap it back to 0 on every keystroke). Every category has a
  // row whether or not it was stored, so the admin sees the whole official list, not just what happens
  // to be filled in.
  const [grid, setGrid] = useState<Record<string, { full: string; half: string }>>(() =>
    Object.fromEntries(
      CHILD_RELIEF_CATEGORY_KEYS.map((k) => [
        k,
        {
          full: String(defaults.childReliefTable?.[k]?.full ?? 0),
          half: String(defaults.childReliefTable?.[k]?.half ?? 0),
        },
      ]),
    ),
  );
  const whole = (v: string) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  // In 'auto_table' the head count that Form E / CP8D / the EA statement read is the TOTAL of the grid,
  // so num_children keeps meaning exactly what it means in the other two modes and no report changes.
  const gridHeadCount = CHILD_RELIEF_CATEGORY_KEYS.reduce(
    (sum, k) => sum + whole(grid[k].full) + whole(grid[k].half),
    0,
  );

  // ── 04b88724 — TWO FIGURES, NOT ONE ─────────────────────────────────────────────────────────────────
  // PHYSICAL CHILDREN is the head count: `num_children`, which Form E, CP8D and the EA statement all read.
  // It is the value this form POSTS, unchanged, in all three modes.
  // QUALIFYING CHILDREN (PCB) is C — what the projection of P counts in. It equals the head count in
  // 'manual' and 'auto' (the kernel's child leg is `num_children × perChild` there) and DIFFERS in
  // 'auto_table', where each category carries its own unit weight: LHDN's own worked example makes two
  // children QC 9. Both are computed here from the same inputs the boxes show, so nothing on screen can
  // disagree with anything else on screen while the admin is typing.
  const priced = new Map((childRelief?.categories ?? []).map((c) => [c.key, c]));
  const gridTotals = CHILD_RELIEF_CATEGORY_KEYS.reduce(
    (acc, k) => {
      const price = priced.get(k);
      if (!price) return acc;
      const full = whole(grid[k].full);
      const half = whole(grid[k].half);
      // A 50%-shared child is worth exactly half the category — the same halving
      // `childReliefAmountFor` performs, applied to the pack's own numbers rather than re-derived from
      // a rate spelled here.
      return {
        units: acc.units + full * price.units + half * (price.units / 2),
        amountRM: acc.amountRM + full * price.amountRM + half * (price.amountRM / 2),
      };
    },
    { units: 0, amountRM: 0 },
  );
  const headCount =
    mode === 'auto' ? derivedChildCount : mode === 'auto_table' ? gridHeadCount : whole(numChildren);
  const qualifying = mode === 'auto_table' ? gridTotals.units : headCount;
  const reliefRM = mode === 'auto_table' ? gridTotals.amountRM : headCount * (childRelief?.perChild ?? 0);
  // PROVENANCE IS PART OF THE FIELD. 'manual' is a TYPED figure and is labelled as one; the two auto modes
  // are worked out and are labelled by WHAT they were worked out from. A typed number must never be dressed
  // up as a calculated one, and a calculated one must never look editable.
  const provenance =
    mode === 'manual'
      ? t('childProvenanceEntered')
      : mode === 'auto'
        ? t('childProvenanceFromFamily')
        : t('childProvenanceFromTable');
  // The working behind the qualifying count. 'manual' gets NO breakdown: there is nothing to break down,
  // and a table under a typed number would imply one.
  const breakdown: {
    key: string;
    label: string;
    category: string | null;
    sharePercent: number;
    children: number;
    units: number;
    amountRM: number;
  }[] =
    mode === 'auto_table'
      ? CHILD_RELIEF_CATEGORY_KEYS.flatMap((k) => {
          const price = priced.get(k);
          if (!price) return [];
          return ([100, 50] as const).flatMap((share) => {
            const count = whole(share === 100 ? grid[k].full : grid[k].half);
            if (count === 0) return [];
            const rate = share === 100 ? price.amountRM : price.amountRM / 2;
            const unit = share === 100 ? price.units : price.units / 2;
            return [
              {
                key: `${k}-${share}`,
                label: t(`family.childReliefCat_${k}`),
                category: k,
                sharePercent: share,
                children: count,
                units: count * unit,
                amountRM: count * rate,
              },
            ];
          });
        })
      : mode === 'auto'
        ? (childRelief?.familyRows ?? []).map((r, i) => ({
            key: `${r.name}-${i}`,
            label: r.name,
            category: r.category,
            sharePercent: r.sharePercent,
            children: 1,
            // ONE UNIT PER ELIGIBLE CHILD, because that is what 'auto' mode's kernel expression gives it:
            // `num_children × perChild`, whatever category is on file. The category column below is shown
            // as information and the note says so — printing "4 units" here would print a figure the
            // payslip contradicts (CLAUDE.md §8).
            units: 1,
            amountRM: childRelief?.perChild ?? 0,
          }))
        : [];

  const heading = embedded ? (
    <div className="px-4 py-3">
      <h3 className="text-sm font-semibold text-foreground">{t('incomeTaxPcbSection')}</h3>
    </div>
  ) : (
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-semibold text-foreground">{t('identityTaxCardTitle')}</h3>
    </div>
  );

  const wrapperCls = embedded
    ? 'border-t border-border'
    : 'rounded-xl border border-border bg-card shadow-sm';

  return (
    <div className={wrapperCls}>
      {heading}
      {/* 420ebab5 PART TWO (r255) — the card's own Save button is GONE; the Bank & Statutory tab's one
          "Save Changes" covers it. THE ORDER THIS SECTION IS WRITTEN IN IS LOAD-BEARING and is declared in
          lib/personnel-tab-sections.ts: `setTaxProfileMY` re-derives `isResident` from the `taxResidency`
          picked here, and the Statutory (Malaysia) form — which carries no residency control of its own —
          writes that same column on every save. Tax therefore runs AFTER statutory in a consolidated
          request, or the residency the admin chose would be overwritten. `action={…}` stays: it is the
          only wiring of `setTaxAction` to a card, and a `<form>` with no action would POST to the current
          URL. */}
      <form action={action} data-save-section="tax" className="flex flex-col gap-6 px-4 pb-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('taxInfoLegend')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('taxNumber')}>
              {/* Grey placeholder example; the sample seed value is no longer defaulted in (item 8b5334db). */}
              <input name="taxNumber" defaultValue={defaults.taxNumber ?? ''} placeholder="IG1234567890" className={inputCls} />
              {/* 7ee14bbc — SAME WARNING AS THE CP39 PREVIEW'S, HERE, where the number is typed. Under
                  the field rather than at the top of the card so it reads as being about this box, and
                  never disabled/blocking: the record may legitimately need to stay as keyed while the
                  employee sorts their number out with LHDN. */}
              {taxNumberSharedWith.length > 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                  {t('taxNumberSharedTitle', { count: taxNumberSharedWith.length, names: taxNumberSharedWith.join(', ') })}
                </span>
              )}
            </Field>
            {/* 35b7af0a group 6 — the SAME control the Create Employee wizard now renders. The option
                list, its order and the 5→3 value mapping moved into components/tax-category-field.tsx
                VERBATIM: this card still posts `taxCategory` with the same values it always did. */}
            <TaxCategoryField mode="form" defaultValue={defaults.taxCategory} />
            <Field label={t('incomeTaxResident')}>
              <select name="taxResidency" defaultValue={defaults.taxResidency || 'resident'} className={inputCls}>
                <option value="resident">{t('taxResidencyResident')}</option>
                <option value="non_resident">{t('taxResidencyNonResident')}</option>
                <option value="rep">{t('taxResidencyRep')}</option>
                <option value="knowledge_worker">{t('taxResidencyKnowledgeWorker')}</option>
              </select>
            </Field>
            {/* Item d64d0df4 — Disabled Individual and Disabled Spouse (OKU). Yes/No, defaulting to No,
                so nobody's monthly tax moves until an admin makes the claim. Setting either to Yes DOES
                move it: monthly tax is worked out from the year to date, so the month of the change
                absorbs the whole year-to-date correction — which is what the rules require, and what the
                hints below say out loud rather than letting it arrive as a surprise on a payslip.
                Disabled Spouse additionally only moves the deduction for tax category 2 (Married & Spouse
                Not Working); the official rules give it no effect otherwise.
                a72610af — both are now the SHARED control the Create New Employee draft renders too
                (components/tax-relief-fields.tsx). The names, the option order and the defaults are
                carried over unchanged; this card still posts the same two values. */}
            <DisabledReliefField mode="form" field="disabledIndividual" defaultValue={defaults.disabledIndividual} />
            <DisabledReliefField mode="form" field="disabledSpouse" defaultValue={defaults.disabledSpouse} />
          </div>
          <DisabledReliefHints />
        </fieldset>

        {/* Children (PCB relief) — manual or auto (derive from Family records, confirm into numChildren). */}
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('childReliefLegend')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* a72610af — the SHARED control the Create New Employee draft renders too. It is CONTROLLED
                in this mode as well, unlike every other shared group's form branch: its value decides
                whether the five-category grid below renders and whether the head count is read-only, so
                this card has always driven it from state inside the form. Item d64d0df4's third mode
                ('auto_table') keys the official five categories directly against the employee, for the
                case it exists for: their DECLARED relief differs from what the Family tab holds. */}
            <ChildReliefModeField mode="form" value={mode} onChange={setMode} />
            {/* R46 47146ea3 — in 'auto' the count is machine-maintained, so the input goes read-only and
                shows the DERIVED value rather than the stored one. readOnly (not disabled) is deliberate: a
                disabled input submits nothing, and setTaxProfileMY overwrites the whole tax column set, so
                disabling it would reset num_children to 0 on the next manual save of this card. Switching
                back to 'manual' restores the editable stored value. */}
            {/* 04b88724 — PHYSICAL CHILDREN: the head count, and the ONE field that posts `numChildren`.
                The caption changed, the contract did not — Form E, CP8D and the EA statement all read this
                column and it is not being repurposed. */}
            <Field label={t('childrenPhysical')}>
              <input
                name="numChildren"
                type="number"
                min="0"
                step="1"
                // d64d0df4 — 'auto_table' is read-only for the same reason 'auto' is: the head count is
                // machine-maintained, here as the TOTAL of the grid below. Keeping num_children equal to
                // the head count is what leaves Form E / CP8D and the EA statement untouched by this item.
                value={
                  mode === 'auto'
                    ? String(derivedChildCount)
                    : mode === 'auto_table'
                      ? String(gridHeadCount)
                      : numChildren
                }
                onChange={(e) => setNumChildren(e.target.value)}
                readOnly={mode !== 'manual'}
                aria-readonly={mode !== 'manual'}
                data-child-physical
                className={`${inputCls}${mode !== 'manual' ? ' bg-muted/50 text-muted-foreground' : ''}`}
              />
              <span className="text-xs text-muted-foreground" data-child-physical-provenance>
                {provenance}
              </span>
              {/* The Family register's own count, shown ONLY when it disagrees with the stored head count.
                  On production 71 of 75 employees are on a typed figure, so this is the line that tells an
                  administrator their tax field and their family records are saying different things. */}
              {childRelief && childRelief.familyChildren !== headCount && (
                <span className="text-xs text-amber-700 dark:text-amber-400" data-child-family-count>
                  {t('childFamilyCountHint', { count: childRelief.familyChildren })}
                </span>
              )}
            </Field>
            {/* 04b88724 — QUALIFYING CHILDREN (PCB): the figure the calculation uses. In the two derived
                modes it is READ-ONLY, because the children's records decide it. In 'manual' it stays
                EDITABLE and is labelled as entered: a manual-mode employee has nothing to derive from, so
                locking a field whose value nothing else can supply would leave it unfillable. 71 of 75
                employees on production are on manual, so that is the common case, not the edge case.
                In 'manual' the two boxes are ONE stored number (the kernel prices `num_children ×
                perChild`), and they are wired to the same state so typing in either moves both; only the
                Physical box carries the `name`, so the form still posts exactly one `numChildren`. */}
            <Field label={t('childrenQualifying')}>
              {mode === 'manual' ? (
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={numChildren}
                  onChange={(e) => setNumChildren(e.target.value)}
                  data-child-qualifying-input
                  className={inputCls}
                />
              ) : (
                <output
                  data-child-qualifying-value
                  className={`${inputCls} items-center bg-muted/50 text-muted-foreground`}
                >
                  {fmtCount(qualifying)}
                </output>
              )}
              <span className="text-xs text-muted-foreground" data-child-qualifying-provenance>
                {provenance}
              </span>
              {childRelief && (
                <span className="text-xs text-muted-foreground" data-child-relief-amount>
                  {t('childReliefAmountHint', { amount: fmtRM(reliefRM) })}
                </span>
              )}
            </Field>
          </div>
          {/* 99b2d6c0 (r336) — what the third mode IS, said before it is chosen rather than after. The
              grid below only appears once "Auto (from table)" is picked, so without this line the option
              is a word whose consequence — a tertiary-study child worth several times a child under 18,
              and an unkeyed grid worth nothing at all — is invisible at the moment of choosing. Rendered
              outside the two-column grid above so it spans the fieldset and stays out of the select's
              accessible name (see the note on ChildReliefModeHint). */}
          <ChildReliefModeHint />
          {/* Item d64d0df4 — the official five-category grid, rendered ONLY for 'auto_table'. Whole
              numbers of zero or more; the 100% and 50% columns are the LHDN claim split (100% to one
              parent, or 50% each when parents share the claim), and a 50% child is worth exactly half
              that category's relief. The hidden inputs below carry the grid on EVERY save regardless of
              mode, so switching to Manual and back does not silently discard what was keyed — the save
              action overwrites the whole tax column set. */}
          {mode === 'auto_table' ? (
            <div className="rounded-md border border-border bg-card/60 p-3">
              <p className="mb-2 text-xs text-muted-foreground">{t('childReliefTableNote')}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-1.5 pr-4 font-medium">{t('childReliefTableCategoryCol')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('childReliefTableFullCol')}</th>
                      <th className="py-1.5 font-medium">{t('childReliefTableHalfCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CHILD_RELIEF_CATEGORY_KEYS.map((key) => (
                      <tr key={key} className="border-t border-border">
                        <td className="py-1.5 pr-4 align-middle">{t(`family.childReliefCat_${key}`)}</td>
                        {(['full', 'half'] as const).map((share) => (
                          <td key={share} className="py-1.5 pr-4">
                            <input
                              name={`childRelief_${key}_${share}`}
                              type="number"
                              min="0"
                              step="1"
                              aria-label={`${t(`family.childReliefCat_${key}`)} — ${share === 'full' ? t('childReliefTableFullCol') : t('childReliefTableHalfCol')}`}
                              value={grid[key][share]}
                              onChange={(e) =>
                                setGrid((g) => ({ ...g, [key]: { ...g[key], [share]: e.target.value } }))
                              }
                              className={`${inputCls} max-w-24`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            // Not in table mode — still POST the stored grid, so a save made in Manual or Auto mode
            // cannot wipe a grid the admin keyed earlier and silently change their tax on the way back.
            CHILD_RELIEF_CATEGORY_KEYS.map((key) => (
              <span key={key} className="hidden">
                <input type="hidden" name={`childRelief_${key}_full`} value={grid[key].full} />
                <input type="hidden" name={`childRelief_${key}_half`} value={grid[key].half} />
              </span>
            ))
          )}
          {/* ── 04b88724 — HOW THE QUALIFYING COUNT WAS REACHED ──────────────────────────────────────
              The plan promises the working, not just the answer: each line, its category, whether it is
              claimed in full or shared, and the units it contributes. What a line IS differs by mode and
              must: 'auto_table' holds category COUNTS and no individual children, so its lines are
              categories — fabricating one child row per counted child would be inventing people. 'auto'
              has the actual children, so its lines are children.
              MANUAL GETS NO TABLE. There is nothing to break down, and a table under a typed number would
              imply the number was worked out. It gets a sentence saying what the figure is instead. */}
          {childRelief && mode === 'manual' && (
            <p className="text-xs text-muted-foreground" data-child-manual-note>
              {t('childQualifyingManualNote', { amount: fmtRM(childRelief.perChild) })}
            </p>
          )}
          {childRelief && mode !== 'manual' && (
            <div className="rounded-md border border-border bg-card/60 p-3" data-child-breakdown>
              <p className="mb-2 text-xs font-medium text-foreground">{t('childQualifyingBreakdown')}</p>
              {breakdown.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-child-breakdown-empty>
                  {t('childQualifyingBreakdownEmpty')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="py-1.5 pr-4 font-medium">{t('childQualifyingColItem')}</th>
                        <th className="py-1.5 pr-4 font-medium">{t('childQualifyingColCategory')}</th>
                        <th className="py-1.5 pr-4 font-medium">{t('childQualifyingColShare')}</th>
                        <th className="py-1.5 pr-4 font-medium">{t('childQualifyingColUnits')}</th>
                        <th className="py-1.5 font-medium">{t('childQualifyingColAmount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.map((row) => (
                        <tr key={row.key} className="border-t border-border" data-child-breakdown-row>
                          <td className="py-1.5 pr-4 align-middle">
                            {row.children > 1 ? `${row.label} × ${row.children}` : row.label}
                          </td>
                          <td className="py-1.5 pr-4 align-middle text-muted-foreground">
                            {row.category
                              ? t(`family.childReliefCat_${row.category}`)
                              : t('family.childReliefCategoryUnset')}
                          </td>
                          <td className="py-1.5 pr-4 align-middle text-muted-foreground">
                            {row.sharePercent === 50 ? t('family.childReliefPct_50') : t('family.childReliefPct_100')}
                          </td>
                          <td className="py-1.5 pr-4 align-middle">{fmtCount(row.units)}</td>
                          <td className="py-1.5 align-middle">{fmtRM(row.amountRM)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border font-medium">
                        <td className="py-1.5 pr-4" colSpan={3}>
                          {t('childQualifyingTotal')}
                        </td>
                        <td className="py-1.5 pr-4" data-child-breakdown-total-units>
                          {fmtCount(qualifying)}
                        </td>
                        <td className="py-1.5" data-child-breakdown-total-rm>
                          {fmtRM(reliefRM)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {/* In 'auto' the kernel counts one unit per eligible child whatever category is on file, so
                  the category column above is INFORMATION. Saying so is the difference between a screen
                  that explains a figure and one that misreports it. */}
              {mode === 'auto' && (
                <p className="mt-2 text-xs text-muted-foreground" data-child-auto-units-note>
                  {t('childQualifyingAutoUnitsNote')}
                </p>
              )}
              {childRelief.uncategorisedChildren > 0 && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-child-uncategorised>
                  {t('childQualifyingUncategorised', { count: childRelief.uncategorisedChildren })}
                </p>
              )}
              {childRelief.statutoryVersion && (
                <p className="mt-2 text-[11px] text-muted-foreground" data-child-ruleset-version>
                  {t('childQualifyingRuleset', { version: childRelief.statutoryVersion })}
                </p>
              )}
            </div>
          )}
          {mode === 'auto' && (
            // R46 47146ea3 — the "Use {count}" button and its client-side confirm step are GONE. The count is
            // now synced server-side from the Family register on every dependent add / edit / archive (see
            // syncChildReliefFromFamily in core/dependents.ts), so there is nothing left for a human to
            // confirm. What remains is an explanation of where the number comes from and that it maintains
            // itself — plus the honest warning that this is a tax figure moving without a human in the loop.
            <div className="rounded-md border border-dashed border-border bg-card/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('childReliefAutoSyncNote', { count: derivedChildCount })}
              </p>
            </div>
          )}
        </fieldset>

        {/* Employer bears tax contribution. */}
        <fieldset className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm" title={t('employerBearsTaxHint')}>
            <input
              type="checkbox"
              name="employerBearsTax"
              defaultChecked={defaults.employerBearsTax}
              className="size-4 rounded"
            />
            {t('employerBearsTax')}
          </label>
          <p className="text-xs text-muted-foreground">{t('employerBearsTaxHint')}</p>
        </fieldset>

      </form>
    </div>
  );
}
