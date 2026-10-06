'use client';

import { formatQualifyingChildCount } from '@/localization/child-qualification';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
// 04b88724 (r340 fix pass) — the CLIENT-SAFE country-pack seam (ADR-0080 rung 5b, D4). This island prices
// the child-relief grid the admin is typing into, and it now does so by calling the PACK's own
// `childReliefFor` — the very function `pack.payroll.childReliefAmountFor` is built on — instead of
// multiplying the prices itself. The previous build's copy of that arithmetic is what made this card print a
// child-relief figure in ringgit that the payroll kernel contradicted. `registry.client.ts` is the one
// client-side place allowed to name packs (test/country-pack-drift.test.ts ALWAYS_ALLOWED); it serves only
// the db-free `CountryPackClient` slice, so nothing server-only reaches the bundle through it.
import { clientPackFor } from '@/localization/registry.client';
import type { ChildReliefPrice } from '@/localization/country-pack';
import { TaxCategoryField } from './tax-category-field';
import { TaxResidencySelect } from './tax-residency-field';
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
  taxCircumstance?:string|null;
  taxApplicabilityEpoch?:number;
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
  /** The flat per-child relief in RM (RM2,000 in 2026): the rate the two non-table modes are priced at,
   *  because the kernel's child leg is `num_children × perChild` in those modes. */
  perChild: number;
  /** Per category: the ringgit and the qualifying units the resolved ruleset prices it at, straight from
   *  `pack.payroll.childReliefPrices`. Handed BACK to the pack with the counts on screen — this island
   *  never works a price out and never divides one by a rate. */
  categories: ChildReliefPrice[];
  /** The ruleset version that priced the above, so the reader knows which schedule they are reading. */
  statutoryVersion: string | null;
  /** Live 'child' rows on the Family register. Shown when it disagrees with the stored head count — that
   *  disagreement is information, not an error, and it is exactly what the reporter wanted visible. */
  familyChildren: number;
  /** Eligible children carrying no relief category: they would contribute nothing to a category-priced
   *  figure, so a reader must know they exist before trusting one. */
  uncategorisedChildren: number;
  /** r347 — true when the figure was priced from the s.48 grid, false when it is the plain head count.
   *  The notes under the table branch on THIS, not on `mode`: since r344 an 'auto' employee's relief
   *  depends on whether the grid is derived as well as on the mode, and a note keyed on mode alone told
   *  half of them the opposite of what their own payslip does. */
  pricedFromGrid: boolean;
  /** r343 04b88724 — the s.48 WEIGHTED qualifying-children count the categories on file come to (1 / 4 / 8,
   *  half for a 50%-shared child), from `core/dependents.ts eligibleChildReliefUnits`. */
  ruleUnits: number;
  /** r343 04b88724 — the ringgit `ruleUnits` prices at, from the same one pack call. */
  ruleReliefRM: number;

  // ── WHAT THE STORED RECORD ACTUALLY DEDUCTS (r340 fix pass) ───────────────────────────────────────
  // The six fields below are `qualifyingChildReliefFor`'s own answer for the SAVED employee. The first
  // build of this item computed them on every render and threw them away, leaving the card to re-derive
  // the figure from a count taken at a different instant — which under-stated the relief on screen for an
  // 'auto'-mode employee whose child had aged past 18. The card reads THESE now.
  /** `employee_statutory_my.child_relief_mode` AS STORED — not the mode showing in the select, which the
   *  admin may have changed and not saved. What is on file is the only thing that can be stale. */
  mode: 'manual' | 'auto' | 'auto_table';
  /** true for the two auto modes: the stored figure was WORKED OUT, not typed. */
  derived: boolean;
  /** `num_children` as stored — the head count Form E / CP8D / the EA statement read, AND the count the
   *  kernel's child leg multiplies in 'manual' mode and in 'auto' mode when no grid is stored. */
  physicalChildren: number;
  /** Eligible children on the Family register as of the page's own KL "today". In 'auto' mode this is what
   *  the next save writes into `num_children`, and since r351 it is also what the figure below is priced
   *  from — the register, not the column an unrelated edit last wrote. */
  eligibleChildren: number;
  /** QC as the FAMILY REGISTER supports it in the auto modes (r351), as stored/typed in 'manual'. */
  qualifyingChildren: number;
  /** The child deduction in ringgit for `qualifyingChildren`, from the pack's own call. */
  reliefRM: number;
  /** r351 — QC and the ringgit the STORED columns come to, in the kernel's own expression: what payroll
   *  deducts for this employee right now. It equals the two fields above whenever the record is in step and
   *  differs the moment time has passed without a save, because nothing re-derives `num_children` or
   *  `child_relief_table` on the passage of time. The card prints the register figure and names THIS in
   *  amber when they differ — never one without the other (CLAUDE.md §8). */
  storedQualifyingChildren: number;
  storedReliefRM: number;
  /** r351 — the s.48 grid the Family register supports as of `asOf`, or null when it cannot be priced by
   *  category. POSTED BACK by the hidden inputs in 'auto' mode, so saving the card genuinely brings the
   *  stored record into step instead of re-posting the stale grid it was rendered with. */
  derivedGrid: Record<string, { full: number; half: number }> | null;
  /** r351 — child records with no usable date of birth, BY NAME. They cannot be counted (the age the rule
   *  turns on cannot be confirmed) and until now nothing on any screen said which ones they were. */
  undatedChildren: string[];
  /** r351 — the Kuala Lumpur calendar day every figure above was taken at, so the card can SAY which date
   *  it is describing instead of implying "now". */
  asOf: string;
  /** The working behind the stored figure: one line per eligible child in 'auto', one per priced grid cell
   *  in 'auto_table', empty in 'manual'. */
  breakdown: {
    kind: 'child' | 'category';
    name: string | null;
    category: string | null;
    sharePercent: number;
    children: number;
    units: number;
    amountRM: number;
    /** 77e882f5 — which limb of the eligibility rule counted this child ('explicit' = somebody ticked
     *  "Claim tax relief" on the record, which wins over the age test). Absent on a grid cell. */
    why?: 'category' | 'student' | 'under_18' | null;
    /** 77e882f5 — the child's recorded category is disproved by their own date of birth. */
    categoryContradictsDob?: boolean;
  }[];
};

/** A whole count reads as a whole number; a 50%-shared child priced by category produces a HALF unit, and
 *  rounding it would make the count disagree with the ringgit beside it. See core/dependents.ts. */
const fmtCount = formatQualifyingChildCount;
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
 * Tax choices now preserve their own circumstance token beside the existing mathematical integer.
 * None is explicit person non-applicability; saved employer scheme history remains separate.
 *
 * Children auto mode SURFACES the family-derived eligible count for HR to confirm into numChildren — it never
 * silently syncs (respects the benefits-vs-tax firewall). Manual mode keeps HR's keyed figure.
 */
export function IdentityTaxCard({
  action,
  employmentId,
  personId,
  defaults,
  taxSelection,
  childRelief = null,
  taxNumberSharedWith = [],
  country = 'MY',
  embedded = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  employmentId: string;
  personId: string;
  defaults: IdentityTaxDefaults;
  taxSelection?:{companyId:string;companyName:string;version:number;confirmationRequired:boolean};
  /**
   * 04b88724 — the pack's prices AND the pack's figure for the saved record; null when no pack / no PCB
   * reliefs can be resolved, and the card then names no relief figure rather than inventing a rate.
   *
   * THE `derivedChildCount` PROP IS GONE ON PURPOSE (r340 fix pass). It was a SECOND count of the same
   * eligible children, taken by a second call to `eligibleChildReliefCount` at real UTC now while this
   * figure was computed at Kuala Lumpur "today". Between 16:00Z and midnight those are different calendar
   * days, so a child whose 18th birthday is KL-today was eligible for one and not the other, and the card's
   * total could disagree with its own breakdown rows by a line. There is now one count, taken once, at one
   * instant: `childRelief.eligibleChildren`.
   */
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
   * 04b88724 — which country pack prices the child relief, matching the `packFor('MY')` the Personnel
   * detail page already resolves server-side for the same employee. A prop rather than a literal in the
   * body so the day a second pack lands, the screen and the server resolve the same one.
   */
  country?: string;
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
  const [taxCategory, setTaxCategory] = useState(String(defaults.taxCategory ?? 1));
  const [taxCircumstance,setTaxCircumstance]=useState(defaults.taxCircumstance??String(defaults.taxCategory??1));
  const residencyDefault=taxSelection?.confirmationRequired||!clientPackFor('MY')?.payroll.taxSelectionSchemes?.includes(defaults.taxResidency)?'':defaults.taxResidency;
  const taxContextKey=JSON.stringify([employmentId,personId,taxSelection?.companyId,taxSelection?.version,taxSelection?.confirmationRequired,defaults.taxApplicabilityEpoch??0]);
  const [taxDraftContext,setTaxDraftContext]=useState(taxContextKey);
  const [taxResidency,setTaxResidency]=useState(residencyDefault);
  // Reset this controlled draft before rendering a changed owner/revision. Same-owner refreshes
  // retain unsaved edits, while a returned old context cannot resurrect an earlier incentive draft.
  if(taxDraftContext!==taxContextKey){
    setTaxDraftContext(taxContextKey);setTaxResidency(residencyDefault);
    setTaxCircumstance(defaults.taxCircumstance??String(defaults.taxCategory??1));
    setTaxCategory(String(defaults.taxCategory??1));
  }
  const none=taxCircumstance==='none';
  const onTaxCircumstance=(value:string)=>{
    if((taxCircumstance==='none')!==(value==='none'))setTaxResidency('');
    setTaxCircumstance(value);
    const mapped=clientPackFor('MY')?.payroll.taxCircumstanceOptions?.find(x=>x.value===value)?.category;
    setTaxCategory(String(mapped??defaults.taxCategory??1));
  };
  const categoryChanged = taxCategory !== String(defaults.taxCategory ?? 1);
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

  // ── 04b88724 — TWO FIGURES, NOT ONE, AND ONE DERIVATION FOR BOTH ────────────────────────────────────
  // PHYSICAL CHILDREN is the head count: `num_children`, which Form E, CP8D and the EA statement all read.
  // It is the value this form POSTS, unchanged, in all three modes.
  // QUALIFYING CHILDREN (PCB) is C — what the projection of P counts in. It equals the head count in
  // 'manual' and 'auto' (the kernel's child leg is `num_children × perChild` there) and DIFFERS in
  // 'auto_table', where each category carries its own unit weight: LHDN's own worked example makes two
  // children QC 9.
  //
  // WHERE THE ARITHMETIC LIVES, AND WHY IT IS NOT HERE ANY MORE. It is the PACK's — `childReliefFor`, the
  // same function `pack.payroll.childReliefAmountFor` returns one field of, reached through the client seam.
  // This card used to walk the grid itself and multiply the prices, and that copy is precisely what went
  // wrong: in 'auto' mode it worked the figure out from its own eligible-child count instead of the head
  // count the kernel multiplies, and printed a relief in ringgit that the payslip contradicted. A screen
  // whose whole purpose is to stop two child numbers being confused must not invent a third.
  const packChildReliefFor = clientPackFor(country)?.payroll?.childReliefFor ?? null;
  const prices: readonly ChildReliefPrice[] = childRelief?.categories ?? [];
  // The grid AS TYPED, in the shape the pack prices: whole counts, not the strings the inputs hold.
  const typedGrid = Object.fromEntries(
    CHILD_RELIEF_CATEGORY_KEYS.map((k) => [k, { full: whole(grid[k].full), half: whole(grid[k].half) }]),
  );
  // WHICH FIGURE THE SCREEN SHOWS, mode by mode:
  //   auto_table — the grid ON SCREEN, priced live. The admin is typing into it, so a figure the server
  //                computed for the saved record would contradict the boxes the moment anything is keyed.
  //   manual     — the head count ON SCREEN, priced live, for the same reason: it is an editable box.
  //   auto       — the server's figure for the SAVED record. Nothing on this screen changes it; the
  //                children's records do.
  //                ⚠️ r351 — WHAT THAT FIGURE IS MADE OF CHANGED, AND THIS COMMENT USED TO NAME THE OLD
  //                ONE ("`num_children` is what the payslip multiplies until the next save. Showing
  //                anything else here is the r340 blocking defect"). The server now prices 'auto' from the
  //                Family register as of its own KL date, because a figure captioned as describing that
  //                register cannot be read out of a column that only an unrelated family edit ever moves.
  //                The r340 rule it was protecting is KEPT, and kept where it belongs: the card must never
  //                print a figure without naming what the payslip actually deducts, so the server also
  //                returns `storedReliefRM` and the amber line below states it whenever the two differ.
  const figure =
    mode === 'auto_table'
      ? (packChildReliefFor?.({ from: 'table', taxCategory: Number(taxCategory), table: typedGrid, prices }) ?? null)
      : mode === 'manual'
        ? (packChildReliefFor?.({
            from: 'headCount',
            taxCategory: Number(taxCategory),
            children: whole(numChildren),
            perChild: childRelief?.perChild ?? 0,
          }) ?? null)
        : childRelief
          ? (categoryChanged
              ? (packChildReliefFor?.(childRelief.pricedFromGrid
                  ? { from: 'table', taxCategory: Number(taxCategory), table: childRelief.derivedGrid, prices }
                  : { from: 'headCount', taxCategory: Number(taxCategory), children: childRelief.eligibleChildren, perChild: childRelief.perChild }) ?? null)
              : { units: childRelief.qualifyingChildren, amountRM: childRelief.reliefRM, rows: [] })
          : null;
  const childPricingAvailable = !packChildReliefFor || childRelief != null && (mode !== 'auto_table' || prices.length > 0);
  const manualClaimAllowed = childPricingAvailable && (!packChildReliefFor || packChildReliefFor({
    from: 'headCount', taxCategory: Number(taxCategory), children: 1, perChild: childRelief?.perChild ?? 0,
  }).units > 0);
  const headCount =
    mode === 'auto'
      ? (childRelief?.eligibleChildren ?? 0)
      : mode === 'auto_table'
        ? gridHeadCount
        : whole(numChildren);
  const qualifying = figure?.units ?? headCount;
  const reliefRM = figure?.amountRM ?? 0;
  // r351 — IS ANY CHILD RELIEF BEING CLAIMED AT ALL, by either figure? `reliefRM` is what the record as it
  // stands supports; `storedReliefRM` is what payroll is deducting until somebody saves. A sentence that
  // denies the relief has to be false of BOTH before it may be printed, because a reader cannot be told
  // "nothing is claimed" while either number is spending money. The two differ only on an 'auto' record the
  // register has moved under, and the amber line says which is which.
  const claimedRM = Math.max(reliefRM, childRelief?.storedReliefRM ?? 0);
  // ── r343 FIX PASS — THE WEIGHTING GAP, SIGNED, BECAUSE IT HAS TWO DIRECTIONS ──────────────────────
  // `ruleUnits` is what the s.48 categories on file come to (1 / 4 / 8, HALVED for a 50% claim share);
  // `qualifying` is what the calculation actually gives, which in 'auto' is one unit per eligible child.
  //   positive ⇒ the rules call for MORE than the payslip gives  ⇒ PCB OVER-deducted (the reported case:
  //              a disabled child in higher education is relieved as one child instead of eight);
  //   negative ⇒ the rules call for LESS                          ⇒ PCB UNDER-deducted. Reachable and, until
  //              this pass, SILENT: a child recorded at a 50% claim share is half a unit to the rules and a
  //              whole child to the head count, so an 'auto' employee with one 50%-shared child is relieved
  //              RM2,000 where the categories support RM1,000.
  // A TOLERANCE RATHER THAN `!==`: a half share makes both sides fractional, and float equality on a
  // derived figure would put an amber warning on a difference of 1e-15.
  const ruleUnitsGap = categoryChanged ? 0 : (childRelief?.ruleUnits ?? qualifying) - qualifying;
  const weightingGap: 'under' | 'over' | null =
    Math.abs(ruleUnitsGap) < 0.0005 ? null : ruleUnitsGap > 0 ? 'under' : 'over';
  // IS PAYROLL BEHIND THE FAMILY RECORDS? Only a record STORED as 'auto' can be: the server-side sync fires
  // on a dependent add / edit / archive, so a child simply ageing past 18 moves the register and leaves the
  // stored columns — which are what the payslip reads — where they were. `childRelief.mode` and `.derived`
  // are the STORED provenance, deliberately not the select's current value: a mode the admin has just picked
  // and not saved describes nothing on file and cannot be stale.
  //
  // ⚠️ r351 — THE TEST IS THE MONEY, NOT THE HEAD COUNTS, AND THE OLD TEST MISSED HALF THE CASES. It read
  // `physicalChildren !== eligibleChildren`, which cannot see a stale GRID: changing a child from `under_18`
  // to `disabled_study` moves the relief from RM2,000 to RM16,000 with the head count unmoved, and since
  // r344 the payslip prices that grid. Comparing the two ringgit figures catches both directions of both
  // branches, and it is the difference that actually lands on a payslip.
  // A TOLERANCE, not `!==`: a 50%-shared child priced by category makes both sides fractional, and float
  // equality on a derived figure would put an amber warning on a difference of 1e-15.
  const storedAutoStale =
    childRelief != null &&
    childRelief.derived &&
    childRelief.mode === 'auto' &&
    mode === 'auto' &&
    Math.abs(childRelief.storedReliefRM - childRelief.reliefRM) >= 0.005;
  // PROVENANCE IS PART OF THE FIELD. 'manual' is a TYPED figure and is labelled as one; the two auto modes
  // are worked out and are labelled by WHAT they were worked out from. A typed number must never be dressed
  // up as a calculated one, and a calculated one must never look editable.
  const provenance =
    mode === 'manual'
      ? t('childProvenanceEntered')
      : mode === 'auto'
        ? t('childProvenanceFromFamily')
        : t('childProvenanceFromTable');
  // The working behind the qualifying count, as LINES A SCREEN CAN PRINT. The numbers are the pack's (for
  // the live grid) or the server's (for a saved 'auto' record) — this only labels them.
  // 'manual' gets NO breakdown: there is nothing to break down, and a table under a typed number would
  // imply one.
  // Preserve the saved declaration while pricing an unsaved category change through the pack.
  const familyBreakdown = (childRelief?.breakdown ?? []).map(row => {
    if (!categoryChanged || !packChildReliefFor || !childRelief) return row;
    const priced = packChildReliefFor(childRelief.pricedFromGrid && row.category
      ? { from: 'table', taxCategory: Number(taxCategory), prices, table: {
          [row.category]: { full: row.sharePercent === 100 ? row.children : 0, half: row.sharePercent === 50 ? row.children : 0 },
        } }
      : { from: 'headCount', taxCategory: Number(taxCategory), children: row.children, perChild: childRelief.perChild });
    return { ...row, units: priced.units, amountRM: priced.amountRM };
  });

  const breakdown: {
    key: string;
    label: string;
    category: string | null;
    sharePercent: number;
    children: number;
    units: number;
    amountRM: number;
    why: 'category' | 'student' | 'under_18' | null;
    categoryContradictsDob: boolean;
  }[] =
    mode === 'auto_table'
      ? (figure?.rows ?? []).map((r) => ({
          key: `${r.category}-${r.sharePercent}`,
          // THE ITEM COLUMN SAYS WHAT THE LINE STANDS FOR, and for a grid cell that is a NUMBER OF
          // CHILDREN, not the category again — the category has its own column and printing it twice per
          // row was noise the reporter would have had to read past.
          label: t('childQualifyingItemChildren', { count: r.children }),
          category: r.category,
          sharePercent: r.sharePercent,
          children: r.children,
          units: r.units,
          amountRM: r.amountRM,
          // A grid cell stands for a COUNT, not a person, so there is no child whose record could carry
          // a reason or contradict itself. Null rather than absent, so the row shape is uniform.
          why: null,
          categoryContradictsDob: false,
        }))
      : mode === 'auto'
        ? familyBreakdown.map((r, i) => ({
            key: `${r.name ?? r.category ?? 'row'}-${i}`,
            // ONE UNIT PER ELIGIBLE CHILD, because that is what 'auto' mode's kernel expression gives it:
            // `num_children × perChild`, whatever category is on file. The category column below is shown
            // as information and the note says so — printing "4 units" here would print a figure the
            // payslip contradicts (CLAUDE.md §8).
            label: r.name ?? t('childQualifyingItemChildren', { count: r.children }),
            category: r.category,
            sharePercent: r.sharePercent,
            children: r.children,
            units: r.units,
            amountRM: r.amountRM,
            // 77e882f5 — WHY this child counts, and whether their own record disproves their category.
            // Carried per row and rendered under the name: the reporter read a count of 1 against a child
            // called "More than 18Y" twice and both times concluded the age check was broken, when what
            // had actually happened is that somebody ticked "Claim tax relief" on that child.
            why: r.why ?? null,
            categoryContradictsDob: r.categoryContradictsDob === true,
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
      {/* The tab's Save Changes submits this tax section. The employer-scoped selection is saved
          atomically with the other tax fields; person-only statutory updates cannot change it.
          The form action also supports this card outside a consolidated tab. */}
      <form action={action} data-save-section="tax" className="flex flex-col gap-6 px-4 pb-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />
        {taxSelection && <><input type="hidden" name="expectedTaxCompanyId" value={taxSelection.companyId}/><input type="hidden" name="expectedTaxSelectionVersion" value={taxSelection.version}/></>}

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
                list and mapping are country-owned; the integer and detailed circumstance post separately. */}
            <input type="hidden" name="expectedTaxApplicabilityEpoch" value={defaults.taxApplicabilityEpoch??0}/><TaxCategoryField key={taxContextKey} mode="form" defaultValue={defaults.taxCategory} circumstance={defaults.taxCircumstance} onChange={onTaxCircumstance} />
            <Field label={t('incomeTaxResident')}>
              {/* Reset only this draft when its employer owner/revision/confirmation changes. */}
              {none&&<input type="hidden" name="taxResidency" value="none"/>}
              {/* r393 (685d2380 step 3b) — the SAME select the Create New Employee draft renders, in its
                  form branch (components/tax-residency-field.tsx); markup unchanged. */}
              <TaxResidencySelect key={taxContextKey} mode="form" none={none} value={taxResidency} onChange={setTaxResidency} />
              {taxSelection && <><span className="text-xs text-muted-foreground">{t('taxSelectionEmployer',{employer:taxSelection.companyName})}</span><span className="text-xs text-muted-foreground">{t('taxSelectionEligibilityHint')}</span>{taxSelection.confirmationRequired&&<span className="text-xs text-amber-700">{t('taxSelectionConfirmationRequired')}</span>}</>}
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
                column and it is not being repurposed. (r364 — still true, and true again: r359 moved EA
                item 8 off this column for a day. On 'auto_table' the EA reads the keyed grid's head count
                instead, which is the same number this read-only box displays.) */}
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
                    ? String(childRelief?.eligibleChildren ?? 0)
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
              {/* r359 fda53352 — WHICH DOCUMENT PRINTS THIS ONE. The reporter read the EA's item 8 off
                  this box for two rounds, because nothing on the screen said which figure each form
                  takes and the caption said "Physical children" over a number that is not the physical
                  count in either automatic mode.
                  ⚠️ r364 fda53352 rev 8 — r359's LAST SENTENCE SAID "EA item 8 takes the WEIGHTED figure
                  below", AND IT WAS WRONG. EA item 8 takes THIS figure: it asks for the "Number of
                  children qualified for tax relief", a count. The caption is now
                  "Children qualifying for tax relief" rather than "Children on record", because in both
                  automatic modes this box already holds the QUALIFYING count (the eligibility ladder in
                  lib/dependent-vocabulary.ts on 'auto', the keyed grid's head count on 'auto_table'), and
                  "on record" invited the same confusion from the other side. The weighted figure beside it
                  is a price, and the box that prints it is Form EA Section D item 6. */}
              <span className="text-xs text-muted-foreground" data-child-physical-doc>
                {t('childrenPhysicalDoc')}
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
              {mode === 'manual' && manualClaimAllowed ? (
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
                  {childPricingAvailable ? fmtCount(qualifying) : t('childQualificationUnavailable')}
                </output>
              )}
              <span className="text-xs text-muted-foreground" data-child-qualifying-provenance>
                {provenance}
              </span>
              {/* …and this is C, in LHDN's own sense: a WEIGHTING, not a number of people. r364 — the
                  caption no longer calls it a number of children ("Qualifying children (C)" became
                  "Counted as, for monthly tax (C)"), and its hint no longer claims Form EA item 8 reads
                  it, because item 8 reads the box on the left. Nothing on the EA prints C; the relief it
                  produces is what Form EA Section D item 6 prints. */}
              <span className="text-xs text-muted-foreground" data-child-qualifying-doc>
                {childPricingAvailable ? t('childrenQualifyingDoc', { perChild: childRelief?.perChild ?? 0 }) : t('childQualificationReviewSettings')}
              </span>
              {childRelief && (
                <span className="text-xs text-muted-foreground" data-child-relief-amount>
                  {t('childReliefAmountHint', { amount: fmtRM(reliefRM) })}
                </span>
              )}
              {/* ── PAYROLL IS BEHIND THE FAMILY RECORDS ──────────────────────────────────────────────
                  'auto' mode's sync fires on a dependent add / edit / archive and on nothing else, so a child
                  ageing past 18 — or a category corrected on the Family tab while this record sat untouched —
                  leaves the STORED columns holding a relief the register no longer supports, and it is the
                  stored columns the payslip reads.
                  ⚠️ r351 — THE FIGURE ABOVE IS NOW THE REGISTER'S, so this line carries the other half: what
                  payroll will actually deduct until the record is saved, in ringgit, beside what the records
                  support. Both numbers, always, in one sentence — a screen that shows one and hides the other
                  is the r340 defect whichever of the two it picks. Amber, never blocking: HR decides when a
                  tax figure moves, and Save is the button that moves it. */}
              {storedAutoStale && childRelief && (
                <span className="text-xs text-amber-700 dark:text-amber-400" data-child-stale-figure>
                  {t('childQualifyingPayrollBehind', {
                    storedCount: fmtCount(childRelief.storedQualifyingChildren),
                    storedAmount: fmtRM(childRelief.storedReliefRM),
                    count: fmtCount(qualifying),
                    amount: fmtRM(reliefRM),
                    date: childRelief.asOf,
                  })}
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
            // Not in table mode — the grid is still POSTED, because `setTaxProfileMY` overwrites the whole
            // tax column set and an omitted grid would be a silent tax change. WHICH grid depends on the
            // mode, and that distinction is r351's:
            //
            //   manual     — the STORED grid, verbatim, exactly as before. 'manual' short-circuits the sync
            //                (NO_SYNC('manual_mode')), so nothing here is machine-maintained and a save must
            //                not wipe a grid the admin keyed earlier under 'auto (from table)'.
            //   auto       — the DERIVED grid: what the Family register supports as of the server's own KL
            //                date, or all zeros when it cannot be priced by category (setTaxProfileMY turns
            //                all-zero into NULL, which is exactly what the sync stores in that case).
            //                ⚠️ THE OLD BEHAVIOUR MADE THE AMBER LINE ABOVE A FALSE PROMISE. It re-posted
            //                the stored grid out of these hidden inputs, so "Saving this card brings the tax
            //                figure back in step" was true for the head count — the box above posts the
            //                derived eligible count — and FALSE for an employee priced from a stored grid:
            //                the save wrote the stale grid straight back and the payslip did not move. In
            //                'auto' the grid IS machine-maintained (syncChildReliefFromFamily overwrites the
            //                same column on every family edit), so posting the derivation is the one answer
            //                consistent with its only other writer.
            CHILD_RELIEF_CATEGORY_KEYS.map((key) => {
              const cell =
                mode === 'auto' && childRelief
                  ? (childRelief.derivedGrid?.[key] ?? { full: 0, half: 0 })
                  : grid[key];
              return (
                <span key={key} className="hidden">
                  <input type="hidden" name={`childRelief_${key}_full`} value={String(cell.full)} />
                  <input type="hidden" name={`childRelief_${key}_half`} value={String(cell.half)} />
                </span>
              );
            })
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
                /* ── THE EMPTY BOX MUST NOT CONTRADICT THE FIGURE ABOVE IT ──────────────────────────
                   An empty breakdown has TWO causes and they say opposite things about the money.
                   'auto_table' with no grid keyed ⇒ nothing is claimed, and the original sentence is
                   true. But a record stored 'auto' whose Family register is empty still has a
                   `num_children` head count, and THAT is what the payslip multiplies — so relief IS
                   claimed and there is simply nothing here to itemise it with. Printing "no child
                   relief is claimed" under a stated "Child relief: RM 10,000.00" made one fieldset
                   assert both, which is the defect this item exists to stop. Production has three
                   employees stored 'auto', so the state is reachable. Choose on the MONEY, not on the
                   row count; the amber line above already names the stored and eligible counts.
                   ⚠️ r351 — AND THE SENTENCE IT CHOSE WAS ITSELF FALSE. `childQualifyingBreakdownUnsupported`
                   opened "No children are recorded in the Family register", but it renders on the row COUNT,
                   so it also fired when children ARE recorded and none of them qualifies — the reporter's own
                   case, told that their family records were empty. It is retired. Its replacement says only
                   what is true of every case that reaches it: there is no per-child working behind this
                   figure, and money is still claimed. WHY none qualifies is a separate sentence below, which
                   can state the reason because it is rendered only when the facts are known.
                   ⚠️ AND THE TEST IS `claimedRM`, THE LARGER OF THE TWO FIGURES, NOT `reliefRM`. Since r351
                   the figure above is the register's, so the r340 contradiction can now arrive from the
                   OTHER side: an 'auto' record with an empty register supports RM0 while its stored head
                   count still has payroll deducting RM10,000, and "no child relief is claimed" under that is
                   the same false sentence read from the opposite end. Whichever of the two is claiming
                   money, this box must not deny it; the amber line above names both and which is which. */
                <p className="text-xs text-muted-foreground" data-child-breakdown-empty>
                  {claimedRM > 0
                    ? t('childQualifyingBreakdownUnitemised', { amount: fmtRM(claimedRM) })
                    : t('childQualifyingBreakdownEmpty')}
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
                          {/* The line's own identity: the child's NAME for a Family-register line, the
                              NUMBER OF CHILDREN for a grid cell. It is deliberately not the category name
                              again — that is the next column, and a row that printed it twice made the
                              reader check whether the two were saying different things. */}
                          <td className="py-1.5 pr-4 align-middle">
                            {row.label}
                            {/* 77e882f5 — the disclosure. Only an EXPLICIT tick is worth a line: a child
                                counted because they are under 18, or because they are a full-time
                                student, is counted for the reason the caption already implies, and
                                annotating every row would bury the one that matters. */}
                            {row.why === 'category' ? (
                              <span className="block text-[11px] text-muted-foreground" data-child-why-category>
                                {t('childQualifyingWhyCategory')}
                              </span>
                            ) : null}
                            {row.categoryContradictsDob ? (
                              <span className="block text-[11px] font-medium text-amber-700" data-child-category-contradicts>
                                {t('childQualifyingCategoryContradictsDob')}
                              </span>
                            ) : null}
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
              {/* ⚠️ THIS NOTE USED TO SAY THE WRONG THING UNCONDITIONALLY (r347, item 04b88724).
                  It read "In Auto (from Family records) every eligible child counts as one qualifying
                  child… the relief category shown is for information only", and it rendered for EVERY
                  'auto' employee. That was true until r344 taught the payslip to price the derived grid
                  on 'auto' — after which an employee WITH a grid was relieved at the s.48 weight while
                  this sentence told the reader the opposite. The reporter found it on a named employee.
                  It now renders only when the figure really IS the head count, and says WHY. */}
              {mode === 'auto' && !childRelief.pricedFromGrid && (
                <p className="mt-2 text-xs text-muted-foreground" data-child-auto-units-note>
                  {t('childQualifyingAutoUnitsNote')}
                </p>
              )}
              {mode === 'auto' && childRelief.pricedFromGrid && (
                <p className="mt-2 text-xs text-muted-foreground" data-child-auto-weighted-note>
                  {t('childQualifyingAutoWeightedNote')}
                </p>
              )}
              {/* ── r343 04b88724 — THE GAP, NAMED, IN THE MODE WHERE IT COSTS MONEY ────────────────────
                  The reporter is right about the rule: s.48 counts a child 18+ in diploma-or-above study,
                  and a disabled child, as FOUR children, and a disabled child in that study as EIGHT. In
                  'auto' mode the kernel's child leg is `num_children × perChild`, so those children are
                  relieved as ONE each and the employee's monthly PCB is OVER-deducted.
                  WHY THIS IS A SENTENCE AND NOT A DIFFERENT NUMBER IN THE TOTAL: the total above is what the
                  payslip deducts, and replacing it with the weighted figure would print an amount this
                  repo's own kernel contradicts (CLAUDE.md §8, and the r340 defect this card was rebuilt to
                  stop). So both are shown, each labelled with what it is.
                  ⚠️ BOTH DIRECTIONS, AND A DIFFERENT SENTENCE FOR EACH (r343 fix pass). The first version of
                  this note fired only on `ruleUnits > qualifying` while its comment claimed it fired
                  "whenever the two differ" — and the OTHER direction is real: a child recorded at a 50%
                  claim share is half a unit to the rules and a whole child to the head count, so that
                  employee is OVER-relieved and their PCB UNDER-deducted, with the card saying nothing. The
                  two directions do not share a sentence, because "your tax is over-deducted" printed on an
                  under-deduction is worse than silence. See `weightingGap` above for the arithmetic.
                  Absent when the two agree — on a register of whole-claim under-18 children they do, and an
                  amber warning on a correct figure teaches the reader to ignore the one that matters. */}
              {mode === 'auto' && childRelief.mode === 'auto' && weightingGap != null && (
                <p
                  className="mt-2 text-xs text-amber-700 dark:text-amber-400"
                  data-child-auto-weighting-gap
                  data-child-auto-weighting-gap-direction={weightingGap}
                >
                  {t(
                    weightingGap === 'under' ? 'childQualifyingWeightingGap' : 'childQualifyingWeightingGapOver',
                    {
                      ruleUnits: fmtCount(childRelief.ruleUnits),
                      ruleAmount: fmtRM(childRelief.ruleReliefRM),
                      amount: fmtRM(reliefRM),
                    },
                  )}
                </p>
              )}
              {/* ── r351 — THE CHILDREN ARE THERE AND NONE OF THEM QUALIFIES, SAID IN THOSE WORDS ───────
                  The reporter's exact scenario: a child turned 18 and is not in further education, so the
                  Family tab says "No" in its relief column and the figure here is nothing. What the card
                  used to offer was the retired sentence claiming the register was EMPTY — the one fact the
                  reporter could see with their own eyes to be wrong.
                  Gated on the STORED mode being 'auto' as well as the select: it is only in that mode that
                  the Family register decides the figure at all. In 'auto (from table)' the keyed grid does,
                  and telling an administrator there that their children do not qualify would be the next
                  false sentence. It names the rule too, because "none qualifies" without the rule leaves the
                  reader to guess whether it is the age, the studies or the record. */}
              {mode === 'auto' &&
                childRelief.mode === 'auto' &&
                childRelief.familyChildren > 0 &&
                childRelief.eligibleChildren === 0 && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-child-none-eligible>
                    {t('childQualifyingNoneEligible', {
                      count: childRelief.familyChildren,
                      date: childRelief.asOf,
                    })}
                  </p>
                )}
              {/* ── r351 — A CHILD WITH NO DATE OF BIRTH IS NAMED, NOT SILENTLY COUNTED ZERO ─────────────
                  `isChildReliefEligible` cannot confirm the age the rule turns on without a date of birth,
                  so it does not count the child — the right answer, and one the register gave no sign of.
                  BY NAME: a count would send an administrator through the whole Family tab to find which
                  record is incomplete, and the fix is one field on one child. */}
              {childRelief.undatedChildren.length > 0 && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-child-no-dob>
                  {t('childQualifyingNoDob', {
                    count: childRelief.undatedChildren.length,
                    names: childRelief.undatedChildren.join(', '),
                  })}
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
            // ⚠️ r351 — THE SENTENCE WAS OVERSTATED IN BOTH HALVES AND IS REWRITTEN IN ALL SIX LOCALES. It
            // called `{count}` "the figure that feeds PCB": the figure that feeds PCB is `num_children` (and,
            // since r344, `child_relief_table`), and this count is what the next write puts there. And
            // "updates on its own" was true only of a family add / edit / archive — the sync fires on nothing
            // else, so a birthday moves the register and leaves the tax record untouched. The new text names
            // the trigger it really has, and the amber line above is what reports the gap when one opens.
            <div className="rounded-md border border-dashed border-border bg-card/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('childReliefAutoSyncNote', { count: childRelief?.eligibleChildren ?? 0 })}
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
