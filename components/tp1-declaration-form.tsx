import { getTranslations } from 'next-intl/server';
import {
  TP1_FORM_CODE,
  TP1_ITEMS,
  TP1_REBATES,
  type Tp1CatalogueItem,
  type Tp1Counted,
  type Tp1Row,
} from '@/core/tax-relief';
import { isTp1Categories2026, TP1_CATEGORY_KEYS, type Tp1ItemAmounts, type Tp1LegacyCategories } from '@/db/schema';
import { Button, Card, inputCls } from '@/components/ui';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * THE CONTAINER-QUERY MEASURES THIS FORM LAYS OUT ON (r210).
 *
 * `@xl` = 36rem, `@3xl` = 48rem, `@4xl` = 56rem, `@5xl` = 64rem — Tailwind's CONTAINER scale, resolved
 * against the nearest `@container` ancestor (the form root below), never against the window. That is
 * the whole reason these exist rather than `sm:` / `lg:`: the same class has to mean "two roomy columns"
 * on the HR month page, which fills the Payroll content area, and "two tight ones" on the employee's own
 * 42rem screen, and only the container knows which of the two it is in.
 *
 * EVERY ONE STARTS AT `grid-cols-1`, so the stacked single column is the DEFAULT and columns are only
 * ever ADDED; no count is ever fixed, and nothing here says "three columns" unconditionally.
 *
 * The thresholds are chosen so a cell stays wide enough to read — roughly 300px of content — at the
 * width that unlocks it. Two-up at 36rem clears the employee screen outright (42rem) rather than landing
 * on its exact boundary; three-up waits for 64rem, which only the HR screen reaches.
 *
 * `@max-xl` — the complement of `@xl`, so the two never overlap — is used the other way round, to UNDO
 * the wide drawing below 36rem: cell padding, cell borders and cell gaps all cost height on a phone, and
 * a phone was measured taller than before this round until they came off. It is used only for that, never
 * to add anything a narrow container did not already have.
 */
/**
 * Section C's seventeen items and Section D's rebates: one-, two-, then three-up.
 *
 * BELOW `@xl` THIS IS DELIBERATELY NOT A GRID OF CELLS. `@max-xl:gap-0` closes the gap and `itemBlock`
 * drops its box at the same breakpoint, so a narrow container gets back the stacked, rule-separated list
 * it had before r210 — the same padding, the same rules, the same height. The first cut boxed every item
 * at every width and made the PHONE 5–9% taller (measured in headless Chromium over en/ms/ta/zh at 300px
 * and 342px containers): 24px of cell padding off a 300px measure wraps captions an extra line, and
 * seventeen 12px gaps add 204px on their own. More scrolling on a phone is the opposite of what this
 * round was asked for, and the request explicitly left the narrow case alone.
 */
const reliefGridCls = 'grid grid-cols-1 items-start gap-3 @max-xl:gap-0 @xl:grid-cols-2 @5xl:grid-cols-3';
/**
 * Section D is ONE line in the 2026 catalogue (`TP1_REBATES`), and a three-column grid drawn for a single
 * cell reads as a mis-sized column with two thirds of the card blank. So the grid is used only once there
 * is more than one rebate to line up; with one, the item stays the full-width row it has always been.
 */
const rebateLayoutCls = TP1_REBATES.length > 1 ? reliefGridCls : '';
/** The legacy read-out: label/amount rows, so it columns up like the items but keeps its own tight gap. */
const legacyGridCls = 'grid grid-cols-1 gap-x-6 gap-y-1 @xl:grid-cols-2 @5xl:grid-cols-3';
/** Two whole CARDS side by side once there is room for both (A beside B, Section E beside Remarks). */
const cardPairCls = 'grid grid-cols-1 gap-4 @3xl:grid-cols-2';
/** A read-only `dl` of labelled facts inside one card. */
const factsGridCls = 'grid grid-cols-1 gap-x-6 gap-y-2 @xl:grid-cols-2';
/**
 * The "already counted" read-out's own measure. Its lines are `justify-between` — caption on the left,
 * ringgit figure on the right — and on the widened page that put the two ends ~1,100px apart with nothing
 * tying them together, which this repo's own layout guard names as the anti-pattern for a wide screen.
 * A cap, NOT `mx-auto`: the panel stays where it is, the LINE stops being a leaderless span.
 */
const countedMeasureCls = 'max-w-2xl';
/**
 * SAVE AND SUBMIT, KEPT IN REACH — the half of the request the first cut only shortened its way towards.
 * The row is the last child of the `<form>` it submits, so it sticks to the bottom of the scrollport for
 * as long as that form is on screen and un-sticks at the form's own end: Section F below it is never
 * covered at rest.
 *
 * ONLY FROM `@xl`. A permanently parked 60px band is ~9% of a phone viewport spent on two buttons that a
 * single flick reaches anyway, and on a phone it would be sitting on top of the field being keyed. Below
 * `@xl` this is exactly the plain button row it has always been.
 */
const actionRowCls = 'flex flex-wrap gap-2 @xl:sticky @xl:bottom-0 @xl:z-10 @xl:bg-canvas @xl:py-3';

type Tp1Action = (formData: FormData) => void | Promise<void>;

/** Section A — read from company_statutory_my by the page, never re-keyed on the form. */
export type Tp1Employer = { name: string; tin: string | null };
/** Section B — read from the person + employee_statutory_my by the page. */
export type Tp1Employee = { name: string; idNumber: string | null; tin: string | null };

/**
 * The LHDN TP1 (1/2026) declaration — Sections A to F (item 7ad37961, ADR-0081).
 *
 * ONE FORM, TWO SURFACES. This is the SAME component the employee's own screen (/me/tax-relief) and the
 * HR admin-on-behalf screen (/payroll/transactions/tp1/[year]/[month]) render, which is what guarantees
 * they cannot drift in layout, fields, wording or rules — a change lands once. Sections A, B, C, D and E
 * render on both. SECTION F RENDERS ONLY FOR AN ADMIN SESSION (`consent` supplied): employer consent is
 * the one thing an employee must not be able to give themselves.
 *
 * ── THE STRUCTURE IS THE PACK'S, NOT THIS FILE'S ────────────────────────────────────────────────────
 * Every item, every lettered sub-line and every ringgit limit comes from `TP1_ITEMS` / `TP1_REBATES`,
 * which the country pack supplies. This file renders `def.limit`; it never states a figure. The legacy
 * eight-key form embedded "RM 9,000" in its own help text in six message catalogues — six copies of a
 * statutory number, none of which moves when the law does. That is the mistake this replaces, and it is
 * why no `messages/*.json` string below contains a ringgit amount.
 *
 * ADR-0008: an item the agency's form prints no limit against renders "—" in the Annual Limit column and
 * is never blocked. It is still captured, still summed, still printed.
 *
 * ── EVERY ITEM CARRIES FOUR FIGURES, WHICH IS WHAT THE REPORTER ASKED FOR ───────────────────────────
 * Annual limit · Current · Accumulated · Remaining. Accumulated is what this person has ALREADY had
 * APPROVED this assessment year IN OTHER DEDUCTION MONTHS (core/tax-relief `getTp1Accumulated`, given
 * this form's own `deductionMonth`) — the same function, with the same argument, that refuses the
 * over-claim at the write and that the payroll feed sums. So the remaining figure on the screen is the
 * figure the server enforces; not two implementations that agree today.
 *
 * ── AND THE FOUR FIGURES ARE NOT THE WHOLE STORY, WHICH IS WHY THE COUNTED PANEL EXISTS (r209) ───────
 * A declaration carried forward from before this form carries MONEY but no C1–C17 attribution, so it
 * cannot appear in any item's Accumulated. It still reaches payroll. r201 shipped exactly that gap and
 * was held for it: HR read a Remaining figure that had never heard of an RM 9,000 carried-forward claim,
 * keyed against it, and the deduction came out wrong silently. `accumulated.total` /
 * `accumulated.sources` / `accumulated.unattributedTotal` are rendered below the identity sections for
 * that reason — the same numbers `prefillTp1FromSelfRelief` takes, stated on the screen that asks HR to
 * key against them.
 *
 * CURRENT IS THE INCREMENT FOR THIS MONTH, NOT THE YEAR-TO-DATE. That follows from the three figures
 * above: remaining is limit − accumulated, and the refusal names what is left to claim NOW. The year's
 * relief is the sum of its months, which is exactly what `prefillTp1FromSelfRelief` feeds. A month's own
 * record is never accumulated against itself, so correcting an approved month is measured against the
 * rest of the year rather than against the figure it replaces.
 *
 * ── RULE 17, SECTION E ──────────────────────────────────────────────────────────────────────────────
 * The declaration tick is NEVER read by presence. A hidden `declarationAccepted=no` is rendered FIRST and
 * the checkbox carries `value="yes"`; the action reads every value for the name and asks whether 'yes' is
 * among them. An unticked box therefore submits an explicit 'no' rather than nothing at all — which is
 * the only way a boolean survives a transport where a missing field and a false field look identical.
 *
 * ── LEGACY ROWS ─────────────────────────────────────────────────────────────────────────────────────
 * A declaration written before this round holds the eight-key payload. It is rendered READ-ONLY in its
 * own block, exactly as it was entered, above the current form — it still feeds payroll and it still
 * prints. It is deliberately not migrated into C1–C17: there is no honest mapping from
 * "medicalInsurance" onto C4 / C11 / C13, and inventing one would rewrite a statutory record.
 *
 * ── THE LAYOUT IS DRIVEN BY THE CONTAINER, NOT BY THE WINDOW (r210) ─────────────────────────────────
 * The two surfaces render this component at DIFFERENT widths — the HR month page fills the Payroll
 * content area (`pageWideCls`), while the employee's own screen sits in a 42rem reading column that page
 * owns and this file must not reach into. A viewport breakpoint (`sm:`, `lg:`) cannot tell those two
 * apart, because it reads the WINDOW: on one laptop `lg:grid-cols-3` means three 400px columns on the HR
 * screen and three 200px columns on the employee one, from the same class. So the root carries
 * `@container` and every grid below queries THAT — the only measure that is true on both surfaces at
 * once. The HR screen reaches three-up; the employee column reaches two-up and stops; a phone keeps the
 * single stacked column it has today, because every grid starts at `grid-cols-1` and only ADDS columns.
 * The AMOUNT boxes keep their own `max-w-*` caps regardless: a ringgit figure is four or five digits and
 * a wider container is not a reason to draw a wider box for it.
 */
export async function Tp1DeclarationForm({
  selectedYear,
  deductionMonth,
  latest,
  accumulated,
  readOnly,
  employer,
  employee,
  consent,
  saveDraftAction,
  submitAction,
  hiddenFields,
}: {
  selectedYear: number;
  /** The form's DEDUCTION MONTH (1–12), or null for the whole-year self-service view. */
  deductionMonth: number | null;
  latest: Tp1Row | null;
  accumulated: Tp1Counted;
  readOnly: boolean;
  /** Section A. Null when the employing company holds no Malaysian statutory record yet. */
  employer: Tp1Employer | null;
  /** Section B. */
  employee: Tp1Employee;
  /** Section F — ADMIN ONLY. Absent ⇒ the section renders read-only (or not at all, when undecided). */
  consent?: {
    approveAction: Tp1Action;
    rejectAction: Tp1Action;
    cancelAction: Tp1Action;
    /** Pre-resolved display name of the approver on an already-decided row. */
    approvedByName: string | null;
    hiddenFields?: Record<string, string>;
  };
  saveDraftAction: Tp1Action;
  submitAction: Tp1Action;
  /** Extra hidden inputs rendered inside the editable form (e.g. { employmentId } for the HR screen). */
  hiddenFields?: Record<string, string>;
}) {
  const t = await getTranslations('taxRelief');
  const status = latest?.status ?? null;
  const isSubmitted = status === 'submitted';
  const isDecided = status === 'approved' || status === 'rejected' || status === 'cancelled';
  const cats = latest?.categories ?? null;
  const cat2026 = isTp1Categories2026(cats) ? cats : null;
  const legacy = cats && !cat2026 ? (cats as Tp1LegacyCategories) : null;
  const extraHidden = Object.entries(hiddenFields ?? {});

  const entryOf = (code: string): Tp1ItemAmounts | undefined =>
    cat2026 ? (cat2026.items[code] ?? cat2026.rebates?.[code]) : undefined;
  const num = (v: unknown) => (v == null || v === '' ? '' : Number(v).toFixed(2));

  /**
   * The annual limit, what is already approved this year IN THE OTHER MONTHS, and what is therefore
   * left — for one item or one lettered sub-line. The CURRENT figure is the input beside it (or the
   * printed amount in read-only mode), so `remaining` here is "before this claim": limit minus
   * accumulated. That is the number the reader needs while typing, and it is literally the number the
   * server checks this claim against — same function, same month.
   */
  const strip = (limit: number | null, prior: number) => {
    const remaining = limit == null ? null : Math.max(0, Math.round((limit - prior) * 100) / 100);
    return (
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt>{t('colAnnualLimit')}</dt>
          <dd className="tabular-nums">{limit == null ? t('noLimit') : rm(limit)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('colAccumulated')}</dt>
          <dd className="tabular-nums">{rm(prior)}</dd>
        </div>
        {remaining != null && (
          <div className="flex gap-1">
            <dt>{t('colRemaining')}</dt>
            <dd className="tabular-nums font-medium text-foreground">{rm(remaining)}</dd>
          </div>
        )}
      </dl>
    );
  };

  /**
   * One numbered item — a single amount box, or one box per lettered sub-line under a shared limit.
   *
   * r210: a bordered CELL from `@xl` up, where the items are laid out two- or three-up — a `border-t`
   * divider is the right drawing for one tall column and the wrong one for a grid, since only the first
   * cell of the run would lose its top rule and the row would read as if the list started three times.
   *
   * BELOW `@xl` IT IS STILL THAT DIVIDER, to the pixel: `@max-xl:border-0` drops the box, `not-first`
   * puts the single top rule back between consecutive rows, and `@max-xl:px-0` gives the caption its full
   * measure again. That is what keeps a phone no taller than it was before this round — see
   * `reliefGridCls` for the measurements that forced it.
   */
  const itemBlock = (def: Tp1CatalogueItem, group: 'items' | 'rebates') => {
    const entry = entryOf(def.code);
    const priorItem = accumulated.items[def.code] ?? 0;
    const priorSubs = accumulated.subItems[def.code] ?? {};
    const code = def.code.toUpperCase();
    return (
      <div
        key={def.code}
        className="rounded-md border border-border p-3 @max-xl:rounded-none @max-xl:border-0 @max-xl:px-0 @max-xl:not-first:border-t"
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-semibold tabular-nums">{code}</span>
          <span className="text-sm">{t(`${group}.${def.code}.label`)}</span>
        </div>
        {def.frequency && (
          <p className="mt-0.5 text-xs italic text-muted-foreground">{t(`frequency.${def.frequency}`)}</p>
        )}

        {def.subItems.length === 0 ? (
          <>
            {strip(def.limit, priorItem)}
            {readOnly ? (
              <p className="mt-1 text-sm tabular-nums">{rm(entry?.amount ?? 0)}</p>
            ) : (
              <input
                type="number"
                name={`tp1_${group}_${def.code}_amount`}
                min="0"
                step="0.01"
                defaultValue={num(entry?.amount)}
                placeholder="0.00"
                aria-label={`${code} ${t('colCurrent')}`}
                className={`${inputCls} mt-1 max-w-[14rem]`}
              />
            )}
          </>
        ) : (
          <>
            {/* A group limit belongs to the ITEM; a `perSubLimit` item (C16) has none and each band
                carries its own — so the item-level strip is skipped there rather than printing a "—". */}
            {!def.perSubLimit && strip(def.limit, priorItem)}
            <div className="mt-1 space-y-2">
              {def.subItems.map((sub) => (
                <div key={sub.code} className="rounded-md border border-border/60 px-3 py-2">
                  <p className="text-xs">
                    <span className="font-medium">({sub.code})</span> {t(`${group}.${def.code}.sub.${sub.code}`)}
                  </p>
                  {sub.frequency && (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">{t(`frequency.${sub.frequency}`)}</p>
                  )}
                  {(sub.limit != null || def.perSubLimit) && strip(sub.limit, priorSubs[sub.code] ?? 0)}
                  {readOnly ? (
                    <p className="mt-1 text-sm tabular-nums">{rm(entry?.subItems?.[sub.code] ?? 0)}</p>
                  ) : (
                    <input
                      type="number"
                      name={`tp1_${group}_${def.code}_sub_${sub.code}`}
                      min="0"
                      step="0.01"
                      defaultValue={num(entry?.subItems?.[sub.code])}
                      placeholder="0.00"
                      aria-label={`${code}(${sub.code}) ${t('colCurrent')}`}
                      className={`${inputCls} mt-1 max-w-[14rem]`}
                    />
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  };

  // WHO THE FORM IS ABOUT, STATED FIRST AND KEPT THERE. Sections A and B are five read-only facts
  // between them, so in a wide container they sit side by side instead of taking two full-width bands
  // above the fields anybody actually keys.
  const identity = (
    <div className={cardPairCls}>
      {/* ── SECTION A: EMPLOYER INFORMATION ── read-only: nobody re-keys a tax number onto a form. */}
      <Card className="space-y-2 p-5">
        <h2 className="text-sm font-semibold">{t('sectionA')}</h2>
        <dl className={factsGridCls}>
          <Field label={`A1 ${t('employerName')}`} value={employer?.name ?? null} />
          <Field label={`A2 ${t('employerTin')}`} value={employer?.tin ?? null} />
        </dl>
      </Card>

      {/* ── SECTION B: EMPLOYEE INFORMATION ── */}
      <Card className="space-y-2 p-5">
        <h2 className="text-sm font-semibold">{t('sectionB')}</h2>
        <dl className={factsGridCls}>
          <Field label={`B1 ${t('employeeName')}`} value={employee.name} />
          <Field label={`B2 ${t('employeeIdNumber')}`} value={employee.idNumber} />
          <Field label={`B3 ${t('employeeTin')}`} value={employee.tin} />
        </dl>
      </Card>
    </div>
  );

  return (
    // `@container` — the measure every grid below is written against. See the header note: this
    // component is rendered at two very different widths and only its own container knows which.
    <div className="@container space-y-4">
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('declarationHeading', { year: String(selectedYear) })}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{TP1_FORM_CODE}</p>
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
          <Field label={t('deductionMonthLabel')} value={deductionMonth == null ? null : String(deductionMonth)} />
          <Field label={t('deductionYearLabel')} value={String(selectedYear)} />
        </dl>
      </Card>

      {identity}

      {/*
        ── WHAT HAS ALREADY BEEN COUNTED FOR THIS YEAR, AND WHERE IT CAME FROM (r209) ──────────────────
        The Accumulated/Remaining strip beside each item answers "how much of C3's limit is left". It
        CANNOT answer "what else is already going to payroll for this year", because a declaration
        carried forward from before this form has money but no C1–C17 attribution — and that is exactly
        the gap that held this build: HR keyed an increment against a Remaining figure that did not know
        about an RM 9,000 carried-forward claim, and the PCB came out wrong with nothing on the screen
        to say so.
        So the money is stated here in full, itemised or not, one line per declaration with the month it
        was claimed for, the month it starts feeding payroll, and whether it is attributed. `total` is
        the same figure `prefillTp1FromSelfRelief` takes — both come from `tp1CountForYear` — so this
        panel is the screen's copy of the payroll number rather than a second count of it.
        THE CURRENT MONTH'S OWN RECORD IS NOT HERE. `accumulated` is asked for with this form's own
        deduction month excluded, because "already counted" means the OTHER months; the figure in the
        boxes below is this month's.
      */}
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold">{t('countedHeading', { year: String(selectedYear) })}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('countedNote')}</p>
        </div>
        {accumulated.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('countedNone')}</p>
        ) : (
          <div className={`${countedMeasureCls} space-y-3`}>
            <ul className="divide-y divide-border rounded-md border border-border">
              {accumulated.sources.map((src) => (
                <li
                  key={src.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2"
                >
                  <span className="text-sm">
                    {src.deductionMonth == null
                      ? t('countedWholeYear')
                      : t('countedForMonth', { month: String(src.deductionMonth) })}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('countedEffectiveFrom', { month: String(src.effectiveFrom) })} ·{' '}
                      {t(src.attributed ? 'countedItemised' : 'countedNotItemised')}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums">{rm(src.amount)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-baseline justify-between border-t border-border pt-2">
              <span className="text-sm font-medium">{t('countedTotal')}</span>
              <span className="text-sm font-semibold tabular-nums">{rm(accumulated.total)}</span>
            </div>
            {accumulated.unattributedTotal > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('countedUnattributedNote', { amount: rm(accumulated.unattributedTotal) })}
              </p>
            )}
          </div>
        )}
      </Card>

      {/* A pre-7ad37961 declaration, shown as it was entered. It still feeds payroll and still prints. */}
      {legacy && (
        <Card className="space-y-2 p-5">
          <h2 className="text-sm font-semibold">{t('legacyHeading')}</h2>
          <p className="text-xs text-muted-foreground">{t('legacyNote')}</p>
          <div className={`${legacyGridCls} rounded-md border border-border bg-muted/40 p-3`}>
            {TP1_CATEGORY_KEYS.map((key) => (
              <div key={key} className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">{t(`categories.${key}.label`)}</span>
                <span className="tabular-nums">{rm(legacy[key] ?? 0)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {readOnly ? (
        <>
          <Card className="p-5">
            <h2 className="text-sm font-semibold">{t('sectionC')}</h2>
            <div className={`mt-2 ${reliefGridCls}`}>{TP1_ITEMS.map((def) => itemBlock(def, 'items'))}</div>
            <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
              <span className="text-sm font-medium">{t('totalLabel')}</span>
              <span className="text-lg font-semibold tabular-nums">{rm(latest?.tp1Amount ?? 0)}</span>
            </div>
          </Card>
          <Card className="p-5">
            <h2 className="text-sm font-semibold">{t('sectionD')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('rebateNote')}</p>
            <div className={`mt-2 ${rebateLayoutCls}`}>{TP1_REBATES.map((def) => itemBlock(def, 'rebates'))}</div>
          </Card>
          <Card className="space-y-2 p-5">
            <h2 className="text-sm font-semibold">{t('sectionE')}</h2>
            <p className="text-xs text-muted-foreground">{t('declarationText')}</p>
            <p className="text-sm">
              {latest?.declaredAt
                ? t('declaredOn', { at: latest.declaredAt.toISOString().slice(0, 10) })
                : t('declaredNone')}
            </p>
          </Card>
          {cats?.remarks ? (
            <p className="px-1 text-xs text-muted-foreground">
              {t('remarksLabel')}: {cats.remarks}
            </p>
          ) : null}
          <p className="px-1 text-xs text-muted-foreground">
            {latest ? t(isDecided || isSubmitted ? 'historicalSubmitted' : 'historicalDraft') : t('historicalNone')}
          </p>
        </>
      ) : (
        <>
          {/* ONE editable form, reused by Save-draft and Submit. The server always recomputes the total
              from the items — the client never sends it, at item level or at form level. */}
          <form id="tp1-form" className="space-y-4">
            <input type="hidden" name="assessmentYear" value={selectedYear} />
            <input type="hidden" name="tp1Form" value="tp1-2026" />
            {deductionMonth != null && <input type="hidden" name="deductionMonth" value={deductionMonth} />}
            {extraHidden.map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}

            <Card className="p-5">
              <h2 className="text-sm font-semibold">{t('sectionC')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('sectionCHelp')}</p>
              <div className={`mt-2 ${reliefGridCls}`}>{TP1_ITEMS.map((def) => itemBlock(def, 'items'))}</div>
            </Card>

            <Card className="p-5">
              <h2 className="text-sm font-semibold">{t('sectionD')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('rebateNote')}</p>
              <div className={`mt-2 ${rebateLayoutCls}`}>{TP1_REBATES.map((def) => itemBlock(def, 'rebates'))}</div>
            </Card>

            {/* The tick and the remarks box are the last two things before Save/Submit and neither of
                them is a wide field, so in a roomy container they share one band rather than pushing the
                buttons a screen further down. */}
            <div className={cardPairCls}>
              <Card className="space-y-3 p-5">
                <h2 className="text-sm font-semibold">{t('sectionE')}</h2>
                <p className="text-xs text-muted-foreground">{t('declarationText')}</p>
                {/* RULE 17: the 'no' is rendered FIRST and always submitted; the tick adds a 'yes'. The
                    action reads the VALUES, never whether the field arrived. */}
                <input type="hidden" name="declarationAccepted" value="no" />
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="declarationAccepted"
                    value="yes"
                    defaultChecked={latest?.declaredAt != null}
                    className="mt-0.5"
                  />
                  <span>{t('declarationTick')}</span>
                </label>
              </Card>

              <Card className="p-5">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">{t('remarksLabel')}</span>
                  <textarea
                    name="remarks"
                    rows={3}
                    defaultValue={cats?.remarks ?? ''}
                    placeholder={t('remarksPlaceholder')}
                    className={inputCls}
                  />
                </label>
                <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {t('totalNote')}
                </p>
              </Card>
            </div>

            {isSubmitted || isDecided ? (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                {t('submittedNotice')}
              </p>
            ) : null}

            {/* THE ACTION ROW IS INSIDE THE FORM ON PURPOSE — see `actionRowCls`. `position: sticky` is
                resolved against the nearest block ancestor, so being the form's last child is what gives
                it a range that ENDS with the fields it submits: Section F, which follows, is never
                covered once the page is scrolled to the bottom. The buttons still carry `form="tp1-form"`
                and their own `formAction`, so which action runs is unchanged by the move, and Save is
                still first in tree order and so still the implicit-submission default. */}
            <div className={actionRowCls}>
              <Button type="submit" variant="secondary" formAction={saveDraftAction} form="tp1-form">
                {t('saveDraft')}
              </Button>
              {/* A correction is just another submitted row for the same month; latest-submitted wins. */}
              <Button type="submit" formAction={submitAction} form="tp1-form">
                {t(isSubmitted || isDecided ? 'submitCorrection' : 'submit')}
              </Button>
            </div>
          </form>
        </>
      )}

      {/* ── SECTION F: EMPLOYER CONSENT ── ADMIN ONLY. An employee sees the OUTCOME, never the buttons. */}
      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold">{t('sectionF')}</h2>
        {isDecided ? (
          <dl className={`${factsGridCls} @4xl:grid-cols-3`}>
            <Field label={t('consentStatus')} value={t(`status.${status}`)} />
            <Field
              label={t('consentDate')}
              value={latest?.approvedAt ? latest.approvedAt.toISOString().slice(0, 10) : null}
            />
            <Field label={t('approvedMonth')} value={latest?.approvedMonth == null ? null : String(latest.approvedMonth)} />
            <Field label={t('approvedYear')} value={latest?.approvedYear == null ? null : String(latest.approvedYear)} />
            <Field label={t('approverName')} value={consent?.approvedByName ?? null} />
            <Field label={t('approverPosition')} value={latest?.approverPosition ?? null} />
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">{t('consentPending')}</p>
        )}

        {consent && isSubmitted && (
          <form id="tp1-consent" className="space-y-3 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">{t('consentIntro')}</p>
            {Object.entries(consent.hiddenFields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <div className="flex flex-wrap gap-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">{t('approvedMonth')}</span>
                <input
                  type="number"
                  name="approvedMonth"
                  min="1"
                  max="12"
                  step="1"
                  defaultValue={String(deductionMonth ?? 1)}
                  className={`${inputCls} max-w-[8rem]`}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">{t('approvedYear')}</span>
                <input
                  type="number"
                  name="approvedYear"
                  min="2000"
                  max="2100"
                  step="1"
                  defaultValue={String(selectedYear)}
                  className={`${inputCls} max-w-[8rem]`}
                />
              </label>
              {/* Capped for the same reason the month and year boxes are: "HR Manager" is a job title,
                  not a paragraph, and `flex-1` alone would draw it the width of whatever container the
                  form is in. */}
              <label className="block max-w-[24rem] flex-1 text-sm">
                <span className="mb-1 block font-medium">{t('approverPosition')}</span>
                <input type="text" name="approverPosition" maxLength={200} className={inputCls} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" formAction={consent.approveAction} form="tp1-consent">
                {t('approve')}
              </Button>
              <Button type="submit" variant="secondary" formAction={consent.rejectAction} form="tp1-consent">
                {t('reject')}
              </Button>
              <Button type="submit" variant="secondary" formAction={consent.cancelAction} form="tp1-consent">
                {t('cancelDeclaration')}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

/** A read-only labelled fact. An em dash rather than an invented value — this is a statutory form. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value && value.trim() !== '' ? value : '—'}</dd>
    </div>
  );
}
