'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
// core/leave-compute.ts is the RSC-SAFE half of the leave engine (it imports no db/postgres, see its
// header), which is why a client component may pull VALUES from it. Feedback 9f5164d8's worked example runs
// the real `applyRounding` rather than a lookalike: an administrator is shown what a rule produces BEFORE
// saving it, and a second implementation of the rule is a second thing that can disagree with the ledger.
import {
  applyRounding,
  checkRoundingBands,
  type LeaveRoundingMethod,
  type RoundingBand,
  type RoundingBandProblem,
} from '@/core/leave-compute';
import { ORG_ASSIGNMENT_CRITERIA, type OrgAssignmentCriterionKey } from '@/core/leave-org-criteria';
import { ESS_VIEW_CHECKLIST_GROUPS } from '@/components/leave/entitlement-panel-config';
import { applyLeaveFormulaTemplate, type LeaveFormulaEntry } from '@/core/leave-formula';
import { resolvePlacement, ESS_PLACEMENTS } from '@/lib/leave-groups';
// 464b58e6 — the statutory right to APPLY, asked once and client-safe (see the module header). The panel
// used to keep its own copy of the five seeded codes and disagreed with the service on any tenant whose
// statutory types are coded differently.
import { isStatutoryApplyLeaveType, STATUTORY_APPLY_SEEDED_CODES } from '@/lib/leave-statutory';
// 35b7af0a — the shared person master lists, in a client-safe module so this client component can use the
// real one instead of the hand-synced copy it used to carry.
import { MARITAL_STATUSES } from '@/lib/person-vocabulary';
// 4a1abc4a — ONE way to print a number of days, shared with every balance screen (see lib/day-format.ts).
// The band table used to be the module's single exception (ROUNDING_BAND_DECIMALS = 3); that constant is
// retired and every figure on this screen, bands included, is printed and tidied at the 2dp default.
import {
  formatDayInput,
  formatDays,
  normalizeDayFieldOnBlur,
  normalizeDayText,
} from '@/lib/day-format';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  LEAVE_COLORS,
  LEAVE_COLOR_TOKENS,
  LEAVE_ICONS,
  LEAVE_ICON_KEYS,
  type LeaveColorToken,
  type LeaveIconKey,
} from '@/lib/leave-visual';
import { Button, Field, inputCls } from './ui';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { ConfirmSubmit } from './ui/confirm-submit';
import { ChipMultiSelect } from './ui/chip-multi-select';
import { SubStepBar } from './leave-sub-step-bar';

/* 6e9a126e RELEASE THREE — `EntitlementPolicy` (one `leave_policy` row) and the whole per-company /
 * per-grade entitlement surface it fed are GONE from this panel, together with the benefit-scheme props
 * (`schemeEntitlements`, `benefitSchemes`, `gradeGroups`) and the two tables they drove
 * (`LeaveTypeEntitlementTable` / `ServiceEntitlementTable`, whose file went with them). Days and the
 * service-length steps that grant them are typed on Settings → Leave → Entitlements → Entitlement Tables
 * (/admin/leave/entitlements/templates), and WHO receives a table is decided by the eligibility rules on
 * that same screen — `entitlement_eligibility_rule`, not a scheme and not a policy row. The Entitlement
 * step below points there rather than offering a second, unread place to type a number.
 *
 * GRADE GROUPS ARE NOT PART OF THAT REMOVAL: they still scope approval routing, and their editor lives on
 * the Approval Workflow tab. Nothing here read them except the scheme matrix. */

export type GradeOption = { id: string; name: string };
export type CompanyOption = { id: string; name: string };

/** #25 visibility: who may see + apply for this type. null = open to all. gender / maritalStatus are
 *  multi-select (#badc5966): a scalar (legacy single-select rows) OR an array (match ANY selected value). */
export type LeaveEligibilityRule = {
  gender?: string | string[];
  maritalStatus?: string | string[];
  minServiceMonths?: number;
  // Min-service unit (#f88f0a63): the number in minServiceMonths measured in 'months' (default / absent) or
  // 'days'. Absent on legacy rows ⇒ rendered + posted as 'months'.
  minServiceUnit?: 'months' | 'days';
  // Organisation Assignment criteria (Enhance Leave Criteria Configuration): the eight catalogue-backed org
  // fields, each scalar-or-array (match-ANY) exactly like gender/maritalStatus. Keyed by the employment column
  // name (see ORG_ASSIGNMENT_CRITERIA). Absent key ⇒ no restriction. Mirrors the server LeaveEligibility.
  orgDivision?: string | string[];
  orgBranch?: string | string[];
  orgRegion?: string | string[];
  orgLine?: string | string[];
  orgSection?: string | string[];
  orgTeam?: string | string[];
  orgBase?: string | string[];
  employmentCategory?: string | string[];
};

/** The checkbox options the eligibility rule form renders. Order matches the mockup.
 *
 *  35b7af0a — the marital list is no longer a hand-synced copy. It IS the shared master list
 *  (`lib/person-vocabulary.ts` MARITAL_STATUSES, #12129e77), which moved out of `core/profile.ts` into a
 *  client-safe module precisely so client components like this one can import it instead of restating it.
 *  The old comment here said "keep the two in sync"; that obligation is gone.
 *
 *  Gender stays a SHORTER, deliberate list: 'undisclosed' is a valid PROFILE value but never a rule value
 *  (see core/admin.ts ELIGIBILITY_GENDER_OPTIONS and eligibilityUndisclosedNote), so this is a real
 *  narrowing of the master list, not a drifted copy of it. */
const ELIGIBILITY_GENDER_OPTIONS = ['male', 'female'] as const;
const ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES;
// Day Type Inclusion (feedback ef6d7146): the five day types, in the order the reporter listed them. Each
// posts `dayType_<key>` when its toggle is on; the closed set mirrors core/leave.ts DAY_TYPE_INCLUSION_KEYS.
const DAY_TYPE_INCLUSION_OPTIONS = ['offDay', 'restDay', 'publicHoliday', 'companyHoliday', 'shutdownDay'] as const;

/** Normalize a scalar-or-array eligibility field to a list (mirrors core asList — kept local so the client
 *  component has no server import). */
function asEligList(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

/** ADR-0048: the four non-full-day durations an admin can enable on a leave type. */
const DURATION_OPTIONS = ['half_day_am', 'half_day_pm', 'hourly'] as const;

/** Supporting-document config: the closed set of allowed mime types (PDF / JPG / PNG). */
const DOC_MIME_OPTIONS = [
  { mime: 'application/pdf', label: 'fileTypePdf' as const },
  { mime: 'image/jpeg', label: 'fileTypeJpg' as const },
  { mime: 'image/png', label: 'fileTypePng' as const },
] as const;

/** Step flow (c979aa8b, shortened by b8fcae73): the FOUR configuration steps, in walk order —
 *  1 General Setting, 2 Condition, 3 Entitlement, 4 Custom Settings. The Eligibility step was removed:
 *  it had held no eligibility rules since 08bc6841 relocated those to Condition · Criteria, and its
 *  remaining content (the per-company entitlement policies timeline) moved to the Entitlement step —
 *  where 6e9a126e release three then removed it outright with the `leave_policy` table. The keys are the
 *  SAME storage keys the pre-step accordion used ('ess' is Condition's historical key — kept deliberately
 *  so persisted state survives, see the leaveTypeCards migration in LeaveTypePanel).
 *
 *  1e4eb8af widened step 4 with a Leave Year Configuration block; 4b0e76ae removed it again, in full, at
 *  the reporter's request (entitlement GENERATION moved to /admin/leave/generate in the same release). The
 *  step list itself never changed either way. */
const STEP_KEYS = ['general', 'ess', 'entitlement', 'custom'] as const;
type StepKey = (typeof STEP_KEYS)[number];
/** The storage key of the step b8fcae73 retired. Kept ONLY so a persisted leaveTypeCards:<id> payload that
 *  still points at it can be remapped to the Entitlement step instead of silently snapping back to step 1.
 *  It is never a StepKey and never renders. */
const RETIRED_ELIGIBILITY_STEP = 'eligibility';
/** Step → its admin.leave title key (the same category* keys the accordion cards used, all 6 locales). */
const STEP_TITLE_KEY: Record<StepKey, string> = {
  general: 'categoryGeneral',
  entitlement: 'categoryEntitlement',
  ess: 'categoryEssPolicy',
  custom: 'categoryCustom',
};

/* 6e9a126e release three removed `isEarned` — the client mirror of core/leave.ts `isEarnedMethod`. Its
 * only caller was the entitlement timeline's earned badge, which read `leave_policy.accrual.method`; the
 * earning method is a leave-TYPE rule (9816a5ad) and EarningMethodForm reads it through `earningChoiceOf`.
 * bc36c768 removed `methodValue` before it — "normalise a stored method to a select value", dead since fa3f4ccb
 * retired the per-policy method select and referenced by nothing when this item found it. Its job is now
 * `earningChoiceOf` / `earningMethodOf`, which speak the three-choice vocabulary and, unlike this helper,
 * do NOT collapse an unrecognised value onto the lump option — that collapse is precisely the silent
 * downgrade the read-only branch of EarningMethodForm exists to prevent. */

/** Feedback b81d3c52 — normalise a stored Rounding Method to a select/hidden-input value. Nothing stored
 *  (the No-Rounding default, and every policy written before this feature) ⇒ 'none'. The action maps
 *  'none' straight back to "store nothing", so a round-trip through any form is a no-op on the JSONB.
 *  9f5164d8 added 'nearest_half' to the recognised set.
 *
 *  8fec719e — the select now offers TWO values, so anything that is not 'custom' opens as No Rounding.
 *  THAT INCLUDES A STORED 'up' / 'down' / 'nearest_half': those are values the engine still honours but
 *  nobody may choose, and 0358 clears them, so a row that somehow still carries one opens on No Rounding
 *  and saving the form makes that true. Showing a fifth option nobody asked for, to represent a value we
 *  are retiring, would keep the removed choices alive on the screen that removed them. */
const roundingMethodValue = (m?: LeaveRoundingMethod | null): LeaveRoundingMethod =>
  m === 'custom' ? 'custom' : 'none';

/** The figure the rounding worked example is computed against: one month of a 14-day annual entitlement
 *  earned monthly (14 ÷ 12 = 1.1666…), which is the reporter's own arithmetic in item 4d6eae7b and the
 *  case that made blunt whole-day rounding unsatisfactory in the first place. */
const ROUNDING_EXAMPLE_RAW = Math.round((14 / 12) * 100) / 100;

/** 4a1abc4a — band figures print at the SAME two decimals as every other day figure on this screen.
 *
 *  8fec719e wrote this table at three, because `checkRoundingBands` / `applyRoundingBands` compare and snap
 *  the fraction under test at 3dp, so a 0.125 boundary was typeable and "0.13" would have been a lie the
 *  on-blur tidier then saved. What the reporter's three tables actually contained was 0.401 and 0.701 — a
 *  notch above 0.400 and 0.700, typed only because each row had to start somewhere after the one above
 *  stopped. From is DERIVED now, so nothing needs a notch and nothing needs a third decimal. The engine is
 *  unchanged: `bandRound` widens a stored 0.40 to 0.400 and reads the same rule. */
const bandText = (v: number) => formatDays(v);

/**
 * 8fec719e — ONE EDITOR ROW. The figures are held as STRINGS, deliberately, for the reason the retired
 * threshold editor documented and this table makes worse: a controlled number input backed by a number
 * cannot be typed into, because "0.7" passes through "0." on the way and `Number('0.')` is 0, so the field
 * snaps back before the second digit lands. Keeping the raw text lets an administrator type; the warnings
 * below and the SERVER decide whether what they typed is legal.
 *
 * ⚠️ 4a1abc4a — `from` IS NOT A FIELD ANY MORE. It is DERIVED (see `fromText`): row 0 starts at 0.00 and
 * every later row starts where the row above stopped. The "light grey suggestion" this replaces was a real,
 * editable value pre-filled from the row above — and editing it is exactly what produced the reporter's
 * 0.401 / 0.701, because a row typed as 0.400→0.700 leaves the previous row's own end uncovered unless the
 * next one starts a notch later. A derived From cannot be given a notch, so the holes at exactly 0.400 and
 * 0.700 cannot exist. Two typed figures per row, and the table joins up by construction.
 */
type BandRow = { to: string; result: string };

/**
 * Row i's From. The first row starts at the bottom of the decimal range; every other starts at the row
 * above's Round To — the raw TEXT, not a re-formatted copy, so a half-typed row above shows through as
 * half-typed rather than as a confident 0.
 */
const fromText = (rows: BandRow[], i: number): string => (i === 0 ? bandText(0) : rows[i - 1].to);

const rowsFromStored = (bands: RoundingBand[] | null | undefined): BandRow[] =>
  (Array.isArray(bands) ? bands : [])
    .filter((b) => b != null && typeof b === 'object')
    // The stored `from` is DROPPED, not read: it is derived from the row above. Migration 0414 already made
    // every stored row contiguous, so there is nothing left for this to change — but a row written by hand
    // with a From that does not meet the row above would be shown, and re-saved, joined up.
    .map((b) => ({
      to: bandText(Number(b.to) || 0),
      result: bandText(Number(b.result) || 0),
    }));

/** A typed cell as the server will see it. A BLANK or half-typed cell becomes NaN — which `JSON.stringify`
 *  posts as null and `checkRoundingBands` calls a broken row — rather than `Number('')`'s silent 0, which
 *  would post a rule nobody typed. */
const bandNum = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));

/** The rows as the server will see them, WITH the derived From. The client is not trusted to have derived
 *  it — `setLeaveTypeRules` runs the same `checkRoundingBands` over whatever actually arrives. */
const rowsToBands = (rows: BandRow[]): RoundingBand[] =>
  rows.map((r, i) => ({ from: bandNum(fromText(rows, i)), to: bandNum(r.to), result: bandNum(r.result) }));

/**
 * 8fec719e — the Custom Rounding table: From, Round To, Rounded Result, an Add Row button and as many
 * rows as the reporter needs.
 *
 * IT RENDERS AS SOON AS CUSTOM ROUNDING IS CHOSEN. The "Customize Decimal Thresholds" checkbox this
 * replaces is gone: it made the common case two steps, and there is nothing behind the box to opt into —
 * choosing Custom Rounding IS choosing to write a table.
 *
 * THE WARNINGS COME FROM THE SERVICE'S OWN VALIDATOR. `checkRoundingBands` is imported from
 * core/leave-compute (the RSC-safe half of the engine, which is why a client component may) and is the
 * exact function `setLeaveTypeRules` calls before writing. A lookalike here would be a second opinion
 * about what is legal, and the two would eventually disagree — the administrator would see green and get
 * a rejection, or worse, see nothing and get a table the engine cannot evaluate.
 *
 * OVERLAPS AND DUPLICATES BLOCK THE SAVE; A GAP ONLY WARNS. That asymmetry is the service's, not a UI
 * choice — see checkRoundingBands. A gap is shown because part of the decimal range being left alone is
 * usually not what someone means, but a table has to be buildable one row at a time.
 *
 * ⚠️ 4a1abc4a — WHAT A DERIVED FROM TAKES OFF THE TABLE, and what it deliberately does not. With every row
 * starting where the row above stopped, an INTERNAL gap, an overlap and a duplicate are all unreachable
 * from this screen: they need two rows that disagree about a boundary, and there is only one boundary. What
 * remains reachable is a row whose Round To is not above where it started (an `order` problem — the fix is
 * to raise Round To, not to move From), a figure outside 0–1, a blank cell, and a TRAILING gap when the
 * last row stops below 1.00. Every branch below stays anyway: `checkRoundingBands` is the SERVICE's
 * validator and still has to answer for rows written by an older release or by hand.
 */
function RoundingBandsEditor({
  t,
  rows,
  setRows,
}: {
  t: ReturnType<typeof useTranslations>;
  rows: BandRow[];
  setRows: (next: BandRow[]) => void;
}) {
  const cell = 'px-1.5 py-1';
  const problems: RoundingBandProblem[] = rows.length === 0 ? [] : checkRoundingBands(rowsToBands(rows));
  const badRows = new Set(problems.filter((p) => p.kind !== 'gap').map((p) => (p as { index: number }).index));
  const gaps = problems.filter((p): p is Extract<RoundingBandProblem, { kind: 'gap' }> => p.kind === 'gap');
  const has = (kind: RoundingBandProblem['kind']) => problems.some((p) => p.kind === kind);

  const patch = (i: number, field: 'to' | 'result', v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [field]: v } : r)));

  // 4a1abc4a — tidy a cell to 2dp when the administrator clicks away, so what was typed and what is posted
  // look the same ("0.5" becomes "0.50", the shape every other figure on this screen is written in).
  //
  // `normalizeDayText` leaves a blank cell blank and a half-typed one alone, which keeps
  // `checkRoundingBands` calling that row broken rather than reading the empty box as a legal 0.
  const tidyCell =
    (i: number, field: 'to' | 'result') => (e: { currentTarget: { value: string } }) => {
      const next = normalizeDayText(e.currentTarget.value);
      if (next !== e.currentTarget.value) patch(i, field, next);
    };

  // A new row's From needs no suggestion any more — `fromText` derives it from the row above the moment
  // the row exists. Only the two typed cells start empty.
  const addRow = () => setRows([...rows, { to: '', result: '' }]);

  return (
    <div className="space-y-2 rounded-lg border border-border p-2">
      {/* The ONE posted field: the whole table as JSON, on the rounding form's existing tri-state marker.
          Rows are posted as typed — an unparseable figure reaches the server as null and is refused there
          with a named error, rather than being quietly dropped here. */}
      <input type="hidden" name="roundingBands" value={JSON.stringify(rowsToBands(rows))} />
      <span className="text-xs font-medium text-muted-foreground">{t('subStep.roundingBandsTitle')}</span>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className={`${cell} font-medium`}>{t('subStep.roundingBandFrom')}</th>
              <th className={`${cell} font-medium`}>{t('subStep.roundingBandTo')}</th>
              <th className={`${cell} font-medium`}>{t('subStep.roundingBandResult')}</th>
              <th className={cell} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={badRows.has(i) ? 'bg-destructive/10' : undefined}>
                <td className={cell}>
                  {/* DERIVED, not typed — 4a1abc4a. `readOnly` rather than `disabled`: the cell is still
                      reachable and still read out, it simply has no answer of its own to give. It carries no
                      `name`; the whole table posts through the hidden JSON field below. */}
                  <input
                    type="text"
                    readOnly
                    value={fromText(rows, i)}
                    aria-label={t('subStep.roundingBandFrom')}
                    className={cn(inputCls, 'w-24 bg-muted/40 text-muted-foreground')}
                  />
                </td>
                <td className={cell}>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={r.to}
                    onChange={(e) => patch(i, 'to', e.target.value)}
                    onBlur={tidyCell(i, 'to')}
                    aria-label={t('subStep.roundingBandTo')}
                    className={cn(inputCls, 'w-24')}
                  />
                </td>
                <td className={cell}>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={r.result}
                    onChange={(e) => patch(i, 'result', e.target.value)}
                    onBlur={tidyCell(i, 'result')}
                    aria-label={t('subStep.roundingBandResult')}
                    className={cn(inputCls, 'w-24')}
                  />
                </td>
                <td className={cell}>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    aria-label={t('subStep.roundingBandRemove')}
                  >
                    {t('subStep.roundingBandRemove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={addRow}>
        {t('subStep.roundingBandAddRow')}
      </Button>
      {/* Errors first, then the gap warning: an overlapping table is refused, an incomplete one is not. */}
      {(has('shape') || has('range') || has('order')) && (
        <p className="text-xs text-destructive">{t('subStep.roundingBandRowInvalid')}</p>
      )}
      {has('overlap') && <p className="text-xs text-destructive">{t('subStep.roundingBandOverlap')}</p>}
      {has('duplicate') && <p className="text-xs text-destructive">{t('subStep.roundingBandDuplicate')}</p>}
      {gaps.map((g, i) => (
        <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
          {t('subStep.roundingBandGap', { from: bandText(g.from), to: bandText(g.to) })}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">{t('subStep.roundingBandsHelp')}</p>
    </div>
  );
}

/** General step sub-flow (e1a51aea, shortened by 1e4eb8af, RESTORED to five by 4d6eae7b, back to FOUR by
 *  e4238594): the sub-steps of step 1, in the reporter's stated walk order — 1 Details, 2 Leave Year Type,
 *  3 Earning Method, 4 Carry Forward Policy. The keys are storage keys (persisted as `generalSubStep` in
 *  the leaveTypeCards:<id> localStorage shape, next to activeStep) and must never be named after the
 *  retired accordion card keys (approval/display/calculation), which must never reappear in this file (see
 *  leave-type-config-categories.test.ts).
 *
 *  WHY 'workflow' IS GONE (e4238594). The reporter's point was that the same approval configuration
 *  appeared twice. The Approval Workflow TAB is the real home — templates are built there, assigned there,
 *  and the full rule list is maintained there; this sub-step showed the same rules filtered to one type.
 *  Nothing is stranded: every rule editable here was type-scoped and non-default, and the tab renders a
 *  strict superset of them. NO LINK OR PLACEHOLDER REPLACES IT — the reporter rejected that explicitly, so
 *  the sub-step simply goes and the bar renumbers itself (leave-sub-step-bar renders `i + 1`).
 *
 *  A persisted payload still pointing at 'workflow' falls back to Details, and that is correct rather than
 *  merely tolerable: unlike the bc9be1e8 case below, the content did not move to a SIBLING sub-step that a
 *  redirect could name — it moved to a different tab entirely. There is nowhere in this panel to send them.
 *
 *  WHY 'yearType' IS BACK, HAVING BEEN REMOVED. 1e4eb8af dropped it and moved the control into Custom
 *  Settings, on the reasoning that every leave-year decision should be made in one place. Feedback
 *  4d6eae7b reverses that for the TYPE-LEVEL choice specifically, and gives the reason: "The Leave Year
 *  Type determines the leave cycle, while the Earning Method and Rounding Method determine how leave is
 *  credited within that cycle." The cycle is decided BEFORE the rules that operate inside it, so it reads
 *  in the order the decisions are actually made. This is presentation only — the same `yearCycle=1`
 *  tri-state marker, the same `updateTypeAction`, the same `year_cycle_override` column.
 *
 *  WHAT DID NOT MOVE BACK: the tenant-wide MANAGED LEAVE-YEAR RECORDS stayed in Custom Settings, because
 *  they were not a property of this leave type. 4b0e76ae has since removed them from the product entirely,
 *  so only the per-type override — this one — remains anywhere in the panel.
 *
 *  A persisted payload pointing at 'yearType' from before 1e4eb8af now resolves again rather than falling
 *  back to Details; the hydration guard restores any key present in this list. */
const GENERAL_SUB_STEP_KEYS = ['details', 'yearType', 'earning', 'carry'] as const;
type GeneralSubStepKey = (typeof GENERAL_SUB_STEP_KEYS)[number];
/** Sub-step → its admin.leave title key (all 6 locales). */
const GENERAL_SUB_STEP_TITLE_KEY: Record<GeneralSubStepKey, string> = {
  details: 'subStep.details',
  yearType: 'subStep.yearType',
  earning: 'subStep.earning',
  carry: 'subStep.carry',
};

/** Condition step sub-flow (08bc6841, shortened by c459bff9): the TWO sub-steps of step 4, in walk order
 *  — 1 Criteria (who qualifies: the eligibility rules moved from the Eligibility step), 2 Leave Application
 *  Rules (the seven existing rule groups as a card grid + the relocated company-wide Half-Day Deduction).
 *  c459bff9 removed the third sub-step (Expiry) outright — an intentional reset ahead of a new expiry
 *  framework, not a relocation: the age-from-earning expiry pair no longer exists anywhere, for ANY leave
 *  type, including the explanatory-text variants Annual and Emergency used to see here.
 *  Keys are storage keys (persisted as `essSubStep` in the leaveTypeCards:<id> localStorage shape, next to
 *  activeStep / generalSubStep — the e1a51aea shape extended backward-compatibly). Hydration validates the
 *  stored value against this list, so an older payload holding 'expiry' falls back to Criteria. The step's
 *  OWN storage key stays 'ess' (Condition's historical accordion key — see STEP_KEYS). Rendered by the SAME
 *  reusable SubStepBar the General flow introduced (components/leave-sub-step-bar.tsx — the reuse
 *  contract). */
const ESS_SUB_STEP_KEYS = ['criteria', 'rules'] as const;
type EssSubStepKey = (typeof ESS_SUB_STEP_KEYS)[number];
/** Sub-step → its admin.leave title key (all 6 locales). */
const ESS_SUB_STEP_TITLE_KEY: Record<EssSubStepKey, string> = {
  criteria: 'conditionStep.criteria',
  rules: 'conditionStep.rules',
};

/* 6e9a126e RELEASE THREE — THE ENTITLEMENT STEP NO LONGER HAS A SUB-FLOW. Its two sub-steps were Benefit
 * Schemes (the scheme workbench + the per-type scheme entitlement table) and Service Based Entitlements
 * (the scheme matrix, the per-company policy timeline and the Preview Scenario checker). Both layers are
 * removed; what is left in the step is Run Earned Accrual plus the pointer to Entitlement Tables, and a
 * SubStepBar with one entry is furniture. The three constants that walked it — ENTITLEMENT_SUB_STEP_KEYS,
 * its title map, and the two RETIRED_* storage keys that remapped a stale browser onto Service Based
 * Entitlements — go with it: there is nowhere left to remap TO. A persisted leaveTypeCards:<id> payload
 * still carrying `entitlementSubStep` is simply ignored on hydration; the step opens whole. */

type Action = (fd: FormData) => void | Promise<void>;

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  muted:
    'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

/* 6e9a126e release three removed two helpers that only served the policy surfaces:
 *   `fmt` — trim a day count to one decimal, for the header's days-per-year summary and the timeline rows.
 *   `carryRuleEnabled` — the client mirror of core's `carryEnabled`, which resolved a POLICY row's carry
 *     enable default for FrontDoorPreservedCarry. CarryPolicyForm reads the leave TYPE and applies the same
 *     back-compat rule inline against `typeRules` (see its comment), so the rule itself is not lost. */

/** R4 Build #1: leap-tolerant last-day-of-month, evaluated against a LEAP year (2024) so 29 Feb is allowed
 *  at config time (the server year-clamps it at resolve time). Mirrors core `lastRealDayOfMonth`, but kept
 *  local so this client component pulls in no server module. month is 1-based. */
const lastDayOfMonthLeapTolerant = (month: number) => new Date(Date.UTC(2024, month, 0)).getUTCDate();

/**
 * R4 Build #1: the carry-forward expiry sub-form — a mode toggle (concrete date vs "X months after
 * year-end") with the matching sub-fields, plus client-side inline validation of the month/day pair
 * (pre-submit UX; the authoritative validation is in core/admin.ts). Rendered inside both the add and the
 * edit policy forms so the two stay in sync. Both mode's inputs remain in the DOM; the server writer is
 * mode-authoritative and omits the inactive pair, so a switch clears the stale keys on save.
 */
function CarryExpiryFields({
  t,
  mode: initialMode,
  month,
  day,
  months,
}: {
  t: ReturnType<typeof useTranslations>;
  mode: 'date' | 'months' | null | undefined;
  month?: number | null;
  day?: number | null;
  months?: number | null;
}) {
  const [mode, setMode] = useState<'date' | 'months'>(initialMode === 'months' ? 'months' : 'date');
  const monthRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);

  // Cross-field validity: day must be ≤ the (leap-tolerant) last day of the chosen month. Sets a custom
  // validity message (the i18n string) on the day input so the browser blocks submit + shows it inline;
  // cleared when valid or when either field is blank.
  const revalidate = () => {
    const dEl = dayRef.current;
    if (!dEl) return;
    const m = Number(monthRef.current?.value ?? '');
    const d = Number(dEl.value ?? '');
    const bothPresent = monthRef.current?.value !== '' && dEl.value !== '';
    if (bothPresent && m >= 1 && m <= 12 && d >= 1 && d > lastDayOfMonthLeapTolerant(m)) {
      dEl.setCustomValidity(t('carryExpiryInvalidDate'));
    } else {
      dEl.setCustomValidity('');
    }
  };

  return (
    <>
      <Field label={t('carryExpiryModeLabel')}>
        <select
          name="carryForwardExpiryMode"
          value={mode}
          onChange={(e) => setMode(e.target.value === 'months' ? 'months' : 'date')}
          className={`${inputCls} w-44`}
        >
          <option value="date">{t('carryExpiryModeDate')}</option>
          <option value="months">{t('carryExpiryModeMonths')}</option>
        </select>
      </Field>
      {mode === 'date' ? (
        <Field label={t('carryExpiryLabel')}>
          <div className="flex items-center gap-1.5">
            <input
              ref={monthRef}
              name="carryForwardExpiryMonth"
              type="number"
              min="1"
              max="12"
              step="1"
              aria-label={t('carryExpiryMonthLabel')}
              placeholder={t('carryExpiryMonthLabel')}
              defaultValue={month ?? ''}
              onInput={revalidate}
              className={`${inputCls} w-16`}
            />
            <span className="text-xs text-muted-foreground">/</span>
            <input
              ref={dayRef}
              name="carryForwardExpiryDay"
              type="number"
              min="1"
              max="31"
              step="1"
              aria-label={t('carryExpiryDayLabel')}
              placeholder={t('carryExpiryDayLabel')}
              defaultValue={day ?? ''}
              onInput={revalidate}
              className={`${inputCls} w-16`}
            />
          </div>
        </Field>
      ) : (
        <Field label={t('carryExpiryMonthsLabel')}>
          <input
            name="carryForwardExpiryMonths"
            type="number"
            min="1"
            max="12"
            step="1"
            aria-label={t('carryExpiryMonthsLabel')}
            placeholder={t('carryExpiryMonthsLabel')}
            defaultValue={months ?? ''}
            className={`${inputCls} w-24`}
          />
        </Field>
      )}
    </>
  );
}

// ── The e1a51aea policy front doors are GONE (6e9a126e release three) ─────────────────────────────────
// Earning Method and Carry Forward Policy used to be front doors onto the active `leave_policy` row, and
// each carried helpers whose only job was to keep that row whole across a partial save: `activePoliciesOf`
// (which rows a front door may edit), `frontDoorScopeLabel` (company · grade · from-date, the scope picker
// when more than one was active), `FrontDoorIdentityFields` and `FrontDoorPreservedCarry` (re-post what the
// form is not editing, because updateLeavePolicyAction rebuilt the accrual JSONB wholesale). 9816a5ad had
// already moved both settings onto the leave TYPE — they post setTypeRulesAction and read `typeRules` — so
// with the policy row removed there is nothing left for any of them to preserve.

/** The reporter's earning vocabulary → the engine's per-policy method (ADR-0040). Documented mapping:
 *   - none        → grant_on_hire_prorated  (full entitlement up front — today's lump default)
 *   - by_month    → earned_monthly          (the existing monthly earning machinery)
 *   - by_year     → grant_on_hire_prorated  (an upfront ANNUAL grant *is* the lump path — "By Year"
 *                                            semantically equals the full-year grant, NOT quarterly
 *                                            earning; the helper text states this so HR isn't surprised
 *                                            that None and By Year behave identically)
 *   - by_quarter  → earned_quarterly        (not reporter vocabulary — shown only when a policy already
 *                                            stores it, so the select can round-trip faithfully)
 *   - resignation → DISABLED (engine support coming — no calculation semantics exist; follow-up item)
 *
 * bc36c768 REPLACED ALL OF THE ABOVE. The list offered four options that added up to only two behaviours:
 * None and By Year BOTH mapped to grant_on_hire_prorated (the same stored value, identical arithmetic),
 * Earn Upon Resignation was permanently disabled with no calculation behind it at all, and a fifth
 * quarterly option existed only to round-trip a stored value. The reporter asked for three choices that
 * each mean something genuinely different, and this is them:
 *
 *   - none     → grant_on_hire_prorated  (entitlement handed over up front — the lump path, unchanged)
 *   - monthly  → earned_monthly          (plus a REQUIRED day-of-month, the one new field)
 *   - daily    → earned_daily            (the annual entitlement in daily slices across the leave year)
 *
 * `''` IS A FOURTH STATE BUT NOT A FOURTH CHOICE. It is the NOT-CONFIGURED placeholder a type carries
 * after the 0376 reset, and it posts an EMPTY method, which the action maps to null — so saving the form
 * while the placeholder is still selected leaves the type unconfigured rather than quietly committing it
 * to the lump path. An accidental save must not be how a leave type gets configured.
 *
 * NOTE ON "None": it is not literally a full year for everyone, and the help text says so. An ANNUAL
 * joiner is credited only the months remaining in their hire year (core/org.ts); SICK and HOSPITALIZATION
 * are credited in full whatever month someone joins, because s.60F requires it. That joiner pro-ration is
 * NOT changed here — removing it would hand every mid-year joiner days they have not worked for, and
 * nothing in this system can take a credited day back.
 */
type EarningChoice = '' | 'none' | 'monthly' | 'daily';
/** Every method value this editor can RENDER as a choice. A stored value outside this set (a legacy
 *  'earned_quarterly', or anything a hand-crafted POST once put there) takes the READ-ONLY branch in the
 *  form below rather than being silently collapsed onto a choice nobody made — which is exactly the
 *  eee43966 silent-downgrade class, and the reason the by_quarter round-trip option existed at all. */
const KNOWN_EARNING_METHODS = ['', 'grant_on_hire_prorated', 'earned_monthly', 'earned_daily'];
const isKnownEarningMethod = (m?: string | null) => KNOWN_EARNING_METHODS.includes(m ?? '');
const earningChoiceOf = (m?: string, unconfigured?: boolean): EarningChoice =>
  unconfigured ? '' : m === 'earned_monthly' ? 'monthly' : m === 'earned_daily' ? 'daily' : 'none';
const earningMethodOf = (c: EarningChoice): string =>
  c === 'monthly'
    ? 'earned_monthly'
    : c === 'daily'
      ? 'earned_daily'
      : c === 'none'
        ? 'grant_on_hire_prorated'
        : '';

/** Earning Method sub-step (e1a51aea): a type-level front door to the active policy's `method`. */
function EarningMethodForm({
  t,
  rules,
  action,
  leaveTypeId,
}: {
  t: ReturnType<typeof useTranslations>;
  rules: LeaveTypeRules;
  action: Action;
  leaveTypeId: string;
}) {
  // bc36c768 — a stored method this editor does not render is shown READ-ONLY and RE-POSTED VERBATIM (see
  // the belt-and-braces block below). Computed once, up front, because it decides both halves of the form.
  const storedMethod = rules.accrualMethod ?? '';
  const unknownStoredMethod = !isKnownEarningMethod(storedMethod);
  const unconfigured = rules.accrualUnconfigured != null;
  const [choice, setChoice] = useState<EarningChoice>(
    earningChoiceOf(rules.accrualMethod ?? undefined, unconfigured),
  );
  // bc36c768 — the credit day, rendered only for Monthly Accrual and REQUIRED there. Held as a string so
  // the input can be genuinely empty (a numeric 0 or NaN would render as a value the administrator did not
  // type); the action reads an empty field as a CLEAR.
  const [accrualDay, setAccrualDay] = useState<string>(
    rules.accrualDay == null ? '' : String(rules.accrualDay),
  );
  // Feedback 9f5164d8 — the rounding half of this form is now three linked controls (method, a customize
  // toggle, and the threshold), so it needs local state where a single uncontrolled <select> sufficed.
  const [rounding, setRounding] = useState<LeaveRoundingMethod>(roundingMethodValue(rules.roundingMethod));
  // 8fec719e — the table is the rounding configuration now, so it is held here next to the method and
  // posted by the same form. It survives a switch back to No Rounding (the stored column is only cleared
  // when the administrator empties the table), which is the same containment the retired threshold had:
  // turning rounding off must not throw away work.
  const [bandRows, setBandRows] = useState<BandRow[]>(() => rowsFromStored(rules.roundingBands));
  const showBands = rounding === 'custom';
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      {/* Tri-state marker: names the HALF of the rule row this form renders. The carry half is a separate
          form, and without this marker an earning-only save would clear its configuration. */}
      <input type="hidden" name="earningRendered" value="1" />
      {/* bc36c768 — BELT AND BRACES FOR A METHOD THIS EDITOR CANNOT RENDER (a legacy 'earned_quarterly',
          or anything else the open value contract still permits). Two rules, and both matter:

          1. RE-POST THE STORED VALUE VERBATIM. Collapsing it onto 'none' — which is what the choice mapper
             would do — turns an unrelated save of the ROUNDING half into a silent downgrade of the earning
             method to the lump path. That is the eee43966 defect class exactly, and it is why the retired
             by_quarter option existed. Re-posting makes the method write a harmless no-op.

          2. KEEP `earningRendered` POSTED. It is rendered unconditionally above, and it must stay that
             way: app/admin/actions.ts gates accrualMethod, accrualDay, roundingMethod, roundingThreshold
             AND roundingBands inside ONE `...(earningRendered ? {...} : {})`. Dropping the marker to avoid
             writing the method would make Rounding Method unsaveable for this leave type — the exact
             half-save the markers exist to prevent. (roundingMethodRendered below is a second, inner
             marker; it does not rescue an omitted earningRendered.) */}
      {unknownStoredMethod ? (
        <>
          <input type="hidden" name="method" value={storedMethod} />
          {/* A SPAN, not a read-only <input>, and the distinction is deliberate. A disabled/read-only form
              control still reads as a control — it invites a click and it would be the second element in
              this panel carrying the earning-method label, which is exactly the "one visible method picker"
              invariant eee43966 pinned. The value is displayed; the hidden field above is what is posted. */}
          <Field label={t('subStep.earningMethodLabel')}>
            <span className={cn(inputCls, 'w-72 bg-muted text-muted-foreground')}>{storedMethod}</span>
          </Field>
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.earningLegacyMethodNote')}</p>
        </>
      ) : (
        <>
          {/* the mapped engine value — the select below speaks the reporter's vocabulary */}
          <input type="hidden" name="method" value={earningMethodOf(choice)} />
          <Field label={t('subStep.earningMethodLabel')}>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value as EarningChoice)}
              aria-label={t('subStep.earningMethodLabel')}
              className={`${inputCls} w-72`}
            >
              {/* The NOT-CONFIGURED placeholder, offered only while the type actually is. Not disabled:
                  an administrator who opens the dropdown, thinks better of it and picks this back must be
                  able to leave the type unconfigured rather than be forced into a choice by the UI. */}
              {choice === '' && <option value="">{t('subStep.earningNotConfigured')}</option>}
              <option value="none">{t('subStep.earningNone')}</option>
              <option value="monthly">{t('subStep.earningByMonth')}</option>
              <option value="daily">{t('subStep.earningDaily')}</option>
            </select>
          </Field>
          {choice === '' && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.earningNotConfiguredNote')}</p>
          )}
          {/* bc36c768 — the ONE new field, revealed only by Monthly Accrual and required there. Nothing
              appears for None or Daily Accrual: neither has a credit day to choose. */}
          {choice === 'monthly' && (
            <>
              <Field label={t('subStep.accrualDayLabel')}>
                <input
                  name="accrualDay"
                  type="number"
                  min={1}
                  max={31}
                  step={1}
                  required
                  value={accrualDay}
                  onChange={(e) => setAccrualDay(e.target.value)}
                  aria-label={t('subStep.accrualDayLabel')}
                  className={cn(inputCls, 'w-28')}
                />
              </Field>
              <p className="text-xs text-muted-foreground">{t('subStep.accrualDayHelp')}</p>
            </>
          )}
          {/* Daily Accrual applies rounding to the RUNNING TOTAL, not to each day's slice, so a table that
              rounds a decimal upward hands the employee a whole day from their very first day. The
              reporter was told we would WARN rather than block: a combination that is wrong for most
              tenants is not necessarily wrong for all of them, and blocking it would be us overruling a
              configuration decision that is theirs to make. */}
          {choice === 'daily' && rounding !== 'none' && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.dailyRoundingWarning')}</p>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">{t('subStep.earningMappingHelp')}</p>
      {/* Feedback b81d3c52 — Rounding Method sits directly UNDER Earning Method (its requested home) and
          rides the same policy row: it tidies whatever the earning calculation produces, as the final
          step, without changing the calculation itself. `roundingMethodValue` maps absent ⇒ 'none'. This
          form RENDERS the dropdown, so it posts the tri-state marker (roundingMethodRendered): the action
          then reads 'none' as an explicit CLEAR and 'up'/'down' as SET. Forms that do NOT render the
          dropdown omit the marker and the stored value is preserved — no hidden pass-through input needed. */}
      <input type="hidden" name="roundingMethodRendered" value="1" />
      <Field label={t('subStep.roundingMethodLabel')}>
        <select
          name="roundingMethod"
          value={rounding}
          onChange={(e) => setRounding(e.target.value as LeaveRoundingMethod)}
          aria-label={t('subStep.roundingMethodLabel')}
          className={cn(inputCls, 'w-72')}
        >
          {/* 8fec719e — TWO options, and only two. Nearest 0.5 Day, Round Up and Round Down are gone as
              choices: each was a fixed table this one can express, and offering four fixed shapes plus a
              tunable one was the confusion the reporter asked us to remove. */}
          <option value="none">{t('subStep.roundingNone')}</option>
          <option value="custom">{t('subStep.roundingCustom')}</option>
        </select>
      </Field>
      {/* The table appears the MOMENT Custom Rounding is chosen — no checkbox in front of it. When No
          Rounding is selected no `roundingBands` field is rendered at all, which the action reads as a
          clear: a table is part of the custom-rounding configuration, not a setting that outlives it. */}
      {showBands && <RoundingBandsEditor t={t} rows={bandRows} setRows={setBandRows} />}
      <p className="text-xs text-muted-foreground">{t('subStep.roundingHelp')}</p>
      {/* A worked example against a real figure, computed with the SAME evaluator the engines use, so what
          the administrator is shown before saving cannot disagree with what is credited afterwards. */}
      {rounding !== 'none' && (
        <p className="text-xs text-muted-foreground">
          {t('subStep.roundingWorkedExample', {
            // 4a1abc4a: the worked example is a number of DAYS, so it prints at the day precision (2dp)
            // through the shared formatter — not at the band precision of the table above it.
            raw: formatDays(ROUNDING_EXAMPLE_RAW),
            rounded: formatDays(applyRounding(ROUNDING_EXAMPLE_RAW, rounding, null, rowsToBands(bandRows))),
          })}
        </p>
      )}
      {/* bc36c768 — the unconditional amber pending-engine paragraph is GONE, along with the disabled
          Earn-Upon-Resignation option it explained. It rendered below the select on EVERY leave type,
          apologising for an option nobody could pick and no engine ever implemented; removing the option
          and leaving the apology would have been worse than either. Its i18n key is retired in all six
          locales. (Named by prose rather than by identifier on purpose: the substeps test asserts the
          retired key name appears NOWHERE in this file, and a comment quoting it would defeat that.) */}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/** Carry Forward Policy sub-step (e1a51aea): a front door to the active policy's carry fields — None
 *  (carry disabled) or Fixed Max (enable + X-days cap + the existing CarryExpiryFields days/months
 *  mode switch). The stored cap/expiry survive a "None" save (only the enable flag turns off). */
/** 7cd914b1 — the three Carry Forward Policy shapes. 'percent' carries a share of the year-end balance;
 *  'fixed_max' a flat number of days; 'none' forfeits everything at year end. */
type CarryMode = 'none' | 'fixed_max' | 'percent';

function CarryPolicyForm({
  t,
  rules,
  action,
  leaveTypeId,
}: {
  t: ReturnType<typeof useTranslations>;
  rules: LeaveTypeRules;
  action: Action;
  leaveTypeId: string;
}) {
  // Mirrors carryRuleEnabled's back-compat rule at the TYPE level: an explicit flag wins, and when it is
  // absent a positive cap means carry is on. Migration 0325 backfilled both, but a type created since then
  // has neither, and "no flag, no cap" must read as OFF rather than crashing.
  // 7cd914b1: three modes now, not two. A stored percentage wins the initial selection — a type
  // configured as "carry 50%" must not open showing Fixed Maximum and silently save that back.
  const pct = rules.carryForwardPercent ?? null;
  const initialMode: CarryMode =
    Number(pct ?? 0) > 0 ? 'percent' : (rules.carryForwardEnabled ?? Number(rules.carryForwardMax ?? 0) > 0) ? 'fixed_max' : 'none';
  const [mode, setMode] = useState<CarryMode>(initialMode);
  const carryOn = mode !== 'none';
  const cap = rules.carryForwardMax ?? 0;
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      {/* Tri-state marker: this form renders the CARRY half of the rule row. The earning half is a separate
          form; without the marker a carry-only save would clear the method and rounding. carryBlockRendered
          keeps its existing name because app/admin/actions.ts already reads it. */}
      <input type="hidden" name="carryBlockRendered" value="1" />
      {carryOn && <input type="hidden" name="carryForwardEnabled" value="on" />}
      {!!rules.carryForwardIncludeEarned && <input type="hidden" name="carryForwardIncludeEarned" value="on" />}
      <Field label={t('subStep.carryPolicyLabel')}>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as CarryMode)}
          aria-label={t('subStep.carryPolicyLabel')}
          className={`${inputCls} w-56`}
        >
          <option value="none">{t('subStep.carryNone')}</option>
          <option value="fixed_max">{t('subStep.carryFixedMax')}</option>
          <option value="percent">{t('subStep.carryPercent')}</option>
        </select>
      </Field>
      {carryOn ? (
        <div className="flex flex-wrap items-end gap-2">
          {mode === 'percent' ? (
            <>
              <Field label={t('carryPercentLabel')}>
                <input
                  name="carryForwardPercent"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  // 4a1abc4a: numeric(5,2) in the database, so it is shown and tidied at 2dp. Blank stays
                  // blank — this field is `required`, and a box pre-filled with "0.00" would let someone
                  // satisfy that requirement by pressing save without ever choosing a percentage.
                  defaultValue={formatDayInput(pct)}
                  onBlur={normalizeDayFieldOnBlur}
                  required
                  className={`${inputCls} w-24`}
                />
              </Field>
              {/* 7cd914b1 rev 2: the cap is NO LONGER offered beside the percentage. It used to render
                  here as a ceiling, and core/leave-compute.ts's Math.min then silently trimmed the
                  percentage to it — a type set to "50%" while holding an old cap of 5 carried 5 days,
                  with nothing on screen saying so. Percentage mode now shows ONE number.
                  Posting an explicit 0 rather than omitting the field: app/admin/actions.ts reads
                  carryForwardMax as `num(...) ?? null`, which is NOT tri-state, so an omitted input
                  would clear it anyway — the explicit zero makes the intent readable and matches the
                  None branch's deliberate hidden re-post below.
                  KNOWN AND INTENDED: Fixed Max -> Percent -> Fixed Max loses the stored cap. Preserving
                  it in a hidden field would reinstate the invisible ceiling this change exists to
                  remove. */}
              <input type="hidden" name="carryForwardMax" value="0" />
            </>
          ) : (
            <>
              <Field label={t('carryCapLabel')}>
                {/* 4a1abc4a: `cap` is numeric(6,2) and defaults to 0 when unset, so this box is never
                    blank — it shows "0.00" for "carry nothing", which is what a zero cap means here. */}
                <input
                  name="carryForwardMax"
                  type="number"
                  min="0"
                  step="0.5"
                  defaultValue={formatDayInput(cap)}
                  onBlur={normalizeDayFieldOnBlur}
                  className={`${inputCls} w-24`}
                />
              </Field>
              {/* Fixed Maximum means no percentage: post an empty value so a previously-stored percentage
                  is CLEARED rather than left behind to win the resolution silently. */}
              <input type="hidden" name="carryForwardPercent" value="" />
            </>
          )}
          <CarryExpiryFields
            t={t}
            mode={rules.carryForwardExpiryMode}
            month={rules.carryForwardExpiryMonth}
            day={rules.carryForwardExpiryDay}
            months={rules.carryForwardExpiryMonths}
          />
        </div>
      ) : (
        // None = disabled carry: keep the stored cap/expiry so switching back to Fixed Max restores them.
        // The PERCENTAGE is cleared instead of preserved — carryEnabled() reads a stored percentage as
        // "carry is on", so a preserved one would defeat the None the user just chose.
        <>
          <input type="hidden" name="carryForwardMax" value={cap} />
          <input type="hidden" name="carryForwardPercent" value="" />
          <input type="hidden" name="carryForwardExpiryMode" value={rules.carryForwardExpiryMode === 'months' ? 'months' : 'date'} />
          {rules.carryForwardExpiryMode === 'months' ? (
            <input type="hidden" name="carryForwardExpiryMonths" value={rules.carryForwardExpiryMonths ?? ''} />
          ) : (
            <>
              <input type="hidden" name="carryForwardExpiryMonth" value={rules.carryForwardExpiryMonth ?? ''} />
              <input type="hidden" name="carryForwardExpiryDay" value={rules.carryForwardExpiryDay ?? ''} />
            </>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">{t('subStep.carryHelp')}</p>
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/**
 * Configurable Negative Leave Balance Validation (0ef0defd), with the FLOOR added by bc512dc3.
 *
 * Extracted from the inline form it used to be because the floor is conditional: it is only meaningful
 * when the switch is Yes, and a disabled-looking input beside a No is configuration that reads as set.
 * Both controls live in ONE form under the single `negativeBalance=1` marker — the switch and the floor are
 * one decision, and splitting them would let a save of one silently clear the other.
 *
 * ⚠️ THE FLOOR BINDS AT SUBMISSION ONLY, because that is the only place the switch itself binds.
 * allow_negative_balance relaxes the submit-time gate; the approval path refuses any negative balance
 * outright without consulting it. So a balance cannot actually go negative through the ordinary
 * request-and-approve flow, and this floor caps how far a SUBMITTED application may reach. The asymmetry is
 * pre-existing and is raised separately on the board — see the maxNegativeBalance column comment in
 * db/schema.ts before deciding this control is broken.
 */
function NegativeBalanceForm({
  t,
  id,
  name,
  allowNegativeBalance,
  maxNegativeBalance,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  id: string;
  name: string;
  allowNegativeBalance: boolean;
  /** Positive magnitude — 2.5 means the balance may not pass -2.5. NULL ⇒ unbounded (today's behaviour). */
  maxNegativeBalance: number | null;
  action: Action;
}) {
  const [allowed, setAllowed] = useState<boolean>(allowNegativeBalance);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      {/* preserve the name — this form does not edit it */}
      <input type="hidden" name="name" value={name} />
      {/* marker: tells the action to touch the allow_negative_balance column (tri-state guard) */}
      <input type="hidden" name="negativeBalance" value="1" />
      <span className="text-xs font-medium text-foreground">{t('negativeBalanceLabel')}</span>
      <div className="space-y-1.5">
        {(['no', 'yes'] as const).map((opt) => (
          <label key={opt} className="flex items-start gap-2 text-xs text-foreground">
            <input
              type="radio"
              name="allowNegativeBalanceValue"
              value={opt}
              checked={allowed === (opt === 'yes')}
              onChange={() => setAllowed(opt === 'yes')}
              className="mt-0.5 size-3.5 border-border"
            />
            <span>{opt === 'yes' ? t('negativeBalanceYes') : t('negativeBalanceNo')}</span>
          </label>
        ))}
      </div>
      {allowed ? (
        <>
          <Field label={t('maxNegativeBalanceLabel')}>
            <input
              name="maxNegativeBalance"
              type="number"
              min="0.5"
              step="0.5"
              // 9861b8a4 — REQUIRED now. Yes is what unlocks the approval gate, so "Yes with no figure"
              // would mean "may go arbitrarily far below zero", which nobody should be able to set by
              // leaving a box empty. The service refuses it too; this is the fast, readable half.
              required
              // 4a1abc4a: numeric(6,2). Blank stays blank — see the `required` note above; an unset floor
              // must look unset, not like a configured zero.
              defaultValue={formatDayInput(maxNegativeBalance)}
              onBlur={normalizeDayFieldOnBlur}
              className={cn(inputCls, 'w-full')}
            />
          </Field>
          <p className="text-xs text-muted-foreground">{t('maxNegativeBalanceHelp')}</p>
        </>
      ) : (
        // Switching to No clears any floor: a floor with no permission to go negative is refused by the
        // database, and posting the field blank is what makes that unreachable from this screen.
        <input type="hidden" name="maxNegativeBalance" value="" />
      )}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/**
 * Feedback c6ffa725 — Application Limits, under Condition · Leave Application Rules.
 *
 * Unlimited / Limited as a radio pair rather than "leave the box blank", because blank-means-no-limit is
 * invisible: an administrator reading an empty field cannot tell whether the rule is off or simply not
 * filled in yet. Unlimited posts an EMPTY value, which the action reads as a clear — so the stored column
 * genuinely is NULL and every leave type keeps behaving exactly as it does today until someone picks
 * Limited and types a figure.
 *
 * The `applicationLimits=1` marker is the same tri-state discipline every other card on this grid uses: a
 * save from any neighbouring card does not carry this field and therefore cannot clear it.
 */
function ApplicationLimitsForm({
  t,
  id,
  name,
  maxDaysPerLeaveYear,
  maxDaysPeriod,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  id: string;
  name: string;
  maxDaysPerLeaveYear: number | null;
  /** ad9cb5c5 — 'leave_year' | 'calendar_year' | 'employment'. NULL ⇒ leave year, what every type means today. */
  maxDaysPeriod: string | null;
  action: Action;
}) {
  const [limited, setLimited] = useState<boolean>(maxDaysPerLeaveYear != null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      {/* preserve the name — this form does not edit it */}
      <input type="hidden" name="name" value={name} />
      {/* marker: tells the action to touch the max_days_per_leave_year column (tri-state guard) */}
      <input type="hidden" name="applicationLimits" value="1" />
      <Field label={t('conditionStep.applicationLimitYearLabel')}>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="maxDaysPerLeaveYearMode"
              value="unlimited"
              checked={!limited}
              onChange={() => setLimited(false)}
              className="h-4 w-4"
            />
            {t('conditionStep.applicationLimitUnlimited')}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="maxDaysPerLeaveYearMode"
              value="limited"
              checked={limited}
              onChange={() => setLimited(true)}
              className="h-4 w-4"
            />
            {t('conditionStep.applicationLimitLimited')}
          </label>
        </div>
      </Field>
      {limited ? (
        <>
          <Field label={t('conditionStep.applicationLimitMaxLabel')}>
            <input
              name="maxDaysPerLeaveYear"
              type="number"
              min="0.5"
              step="0.5"
              // 4a1abc4a: numeric(6,2), a number of days — 2dp like every other day figure.
              defaultValue={formatDayInput(maxDaysPerLeaveYear)}
              onBlur={normalizeDayFieldOnBlur}
              className={cn(inputCls, 'w-full')}
            />
          </Field>
          {/* ad9cb5c5 — the period the ceiling is counted over. Only offered alongside a figure: a period
              with no ceiling configures the window of a limit that does not exist, and the database
              refuses that pair. Defaults to per-leave-year, which is what every existing type means. */}
          <Field label={t('conditionStep.applicationLimitPeriodLabel')}>
            <select
              name="maxDaysPeriod"
              defaultValue={maxDaysPeriod ?? 'leave_year'}
              className={cn(inputCls, 'w-full')}
            >
              <option value="leave_year">{t('conditionStep.applicationLimitPeriodLeaveYear')}</option>
              <option value="calendar_year">{t('conditionStep.applicationLimitPeriodCalendarYear')}</option>
              <option value="employment">{t('conditionStep.applicationLimitPeriodEmployment')}</option>
            </select>
          </Field>
          <p className="text-xs text-muted-foreground">{t('conditionStep.applicationLimitPeriodHelp')}</p>
        </>
      ) : (
        // Unlimited posts the field EXPLICITLY EMPTY rather than omitting it: the marker is present, so an
        // omitted field and a blank one would both have to mean something, and only one of them can. Blank
        // is the clear. The period rides along — clearing the ceiling clears the window with it.
        <>
          <input type="hidden" name="maxDaysPerLeaveYear" value="" />
          <input type="hidden" name="maxDaysPeriod" value="" />
        </>
      )}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/**
 * Feedback c6ffa725 REVISION 2 — Maximum Consecutive Leave, under Condition · Leave Application Rules.
 *
 * THE OTHER HALF of the same request. Maximum Application Per Leave Year (above) caps "how much of this
 * type in a YEAR"; this caps "how much in ONE GO". r86a shipped the first and reported the item done, which
 * is why the reporter came back — they are different rules and neither substitutes for the other.
 *
 * ITS OWN FORM AND ITS OWN `maxConsecutive=1` MARKER, not shared with the card above even though the two sit
 * together: a shared marker would make saving one rule silently clear the other.
 *
 * Unlimited / Limited as a radio pair rather than "leave the box blank", for the same reason the year cap
 * uses one — an administrator reading an empty field cannot tell whether the rule is off or simply not
 * filled in yet. Unlimited posts an EMPTY maximum and NO unit, which the action reads as a clear of both
 * columns (the pair is all-or-nothing in the database).
 *
 * THE UNIT IS THE POINT OF THE REVISION. "Maximum 3 days" over a Friday→Monday application is 4 calendar
 * days but 2 working days, so the same number refuses or permits depending on the reading. It is stored per
 * leave type and given its meaning in exactly one function, applicationSpanDays() in core/leave.ts.
 */
function MaxConsecutiveForm({
  t,
  id,
  name,
  maxConsecutiveDays,
  maxConsecutiveUnit,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  id: string;
  name: string;
  maxConsecutiveDays: number | null;
  maxConsecutiveUnit: 'calendar_days' | 'working_days' | null;
  action: Action;
}) {
  const [limited, setLimited] = useState<boolean>(maxConsecutiveDays != null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      {/* preserve the name — this form does not edit it */}
      <input type="hidden" name="name" value={name} />
      {/* marker: tells the action to touch the max_consecutive_days / _unit pair (tri-state guard) */}
      <input type="hidden" name="maxConsecutive" value="1" />
      <Field label={t('conditionStep.maxConsecutiveLabel')}>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="maxConsecutiveMode"
              value="unlimited"
              checked={!limited}
              onChange={() => setLimited(false)}
              className="h-4 w-4"
            />
            {t('conditionStep.maxConsecutiveUnlimited')}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="maxConsecutiveMode"
              value="limited"
              checked={limited}
              onChange={() => setLimited(true)}
              className="h-4 w-4"
            />
            {t('conditionStep.maxConsecutiveLimited')}
          </label>
        </div>
      </Field>
      {limited ? (
        <>
          <Field label={t('conditionStep.maxConsecutiveMaxLabel')}>
            <input
              name="maxConsecutiveDays"
              type="number"
              min="0.5"
              step="0.5"
              // 4a1abc4a: numeric(6,2), a number of days — 2dp. Blank stays blank; the action reads a blank
              // maximum as a clear of BOTH this and the unit, so a "0.00" here would configure a real cap.
              defaultValue={formatDayInput(maxConsecutiveDays)}
              onBlur={normalizeDayFieldOnBlur}
              className={cn(inputCls, 'w-full')}
            />
          </Field>
          <Field label={t('conditionStep.maxConsecutiveUnitLabel')}>
            <select
              name="maxConsecutiveUnit"
              defaultValue={maxConsecutiveUnit ?? 'calendar_days'}
              className={cn(inputCls, 'w-full')}
            >
              <option value="calendar_days">{t('conditionStep.maxConsecutiveUnitCalendar')}</option>
              <option value="working_days">{t('conditionStep.maxConsecutiveUnitWorking')}</option>
            </select>
          </Field>
        </>
      ) : (
        // Unlimited posts the maximum EXPLICITLY EMPTY and forwards no unit. The action reads a blank
        // maximum as a clear of BOTH columns, which is the only state the DB's all-or-nothing CHECK allows
        // — a unit left behind with no figure would be inert configuration that looks set.
        <input type="hidden" name="maxConsecutiveDays" value="" />
      )}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/* 6e9a126e release three — `PolicyFrontDoor` is removed. It was the shell BOTH General sub-steps used to
 * put on before writing a policy row: pick which active row to edit, then render the form for it. 9816a5ad
 * had already re-pointed Earning Method and Carry Forward Policy at the leave TYPE, leaving this shell
 * mounted by nothing; the policy layer it picked over no longer exists either. The two sub-steps render
 * their form directly — one leave type, one set of rules, no scope to choose. */

/*
 * fa3f4ccb — ServiceBandEditor (the service-length band sub-editor, with its BandRow per-range columns)
 * has been REMOVED along with the Company Entitlements band surface it was the only mount for.
 * 6e9a126e release three: service-length steps are typed on the Entitlement Tables screen
 * (/admin/leave/entitlements/templates) as a template's bands. The benefit-scheme band matrix that
 * superseded this editor is gone with `scheme_leave_entitlement`; the template is the only band table now.
 */

/**
 * Leave Type Visual Configuration Enhancement (639fdf77): the self-contained visual sub-form — a SEARCHABLE
 * icon picker (filter the curated registry by keyword → clickable grid + live preview, posts `icon`) + a
 * 7-token colour swatch radio (posts `color`) + Save. Own tri-state marker `visual=1` so an unrelated
 * sub-form save never resets the two columns. Both init from the stored values. Purely cosmetic — the picked
 * icon + colour only change how the type LOOKS on the employee Leave tab.
 */
/**
 * Balance Deduction Source (feedback cdf9ca48) — one card of the Condition step's Leave Application Rules
 * grid. A two-option mode select ("Own Leave Balance" / "Deduct from Another Leave Type") plus, only when the
 * second is chosen, the source picker. Its own state exists purely so the picker appears and disappears with
 * the mode; the SAVED value is the source id, and the action derives it from the pair (mode 'own', or 'other'
 * with nothing picked, both clear the column) — so the panel can never persist a mode with no source.
 */
function BalanceSourceForm({
  t,
  id,
  name,
  balanceSourceTypeId,
  options,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  id: string;
  name: string;
  balanceSourceTypeId: string | null;
  options: { id: string; name: string }[];
  action: Action;
}) {
  const [mode, setMode] = useState<'own' | 'other'>(balanceSourceTypeId ? 'other' : 'own');
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">
      <span className="text-xs font-medium text-muted-foreground">{t('balanceSourceSectionTitle')}</span>
      <form action={action} className="space-y-2">
        <input type="hidden" name="id" value={id} />
        {/* preserve the name — this form does not edit it */}
        <input type="hidden" name="name" value={name} />
        {/* marker: tells the action to touch the balance_source_type_id column (tri-state guard) */}
        <input type="hidden" name="balanceSource" value="1" />
        <Field label={t('balanceSourceLabel')}>
          <select
            name="balanceSourceMode"
            value={mode}
            onChange={(e) => setMode(e.target.value === 'other' ? 'other' : 'own')}
            className={`${inputCls} w-full`}
          >
            <option value="own">{t('balanceSourceOwn')}</option>
            <option value="other">{t('balanceSourceOther')}</option>
          </select>
        </Field>
        {mode === 'other' && (
          <Field label={t('balanceSourceMapLabel')}>
            <select
              name="balanceSourceTypeId"
              defaultValue={balanceSourceTypeId ?? ''}
              className={`${inputCls} w-full`}
            >
              {/* Blank first: an administrator who switches to "another leave type" has not yet chosen one,
                  and pre-selecting whichever type happens to sort first would save a source nobody picked. */}
              <option value="">{t('balanceSourceMapPlaceholder')}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Button type="submit" size="sm">
          {t('save')}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t('balanceSourceHelp')}</p>
    </div>
  );
}

function LeaveVisualForm({
  t,
  id,
  name,
  color,
  icon,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  action: Action;
}) {
  const [selColor, setSelColor] = useState<LeaveColorToken | ''>(
    color && (LEAVE_COLOR_TOKENS as string[]).includes(color) ? (color as LeaveColorToken) : '',
  );
  const [selIcon, setSelIcon] = useState<LeaveIconKey | ''>(
    icon && (LEAVE_ICON_KEYS as string[]).includes(icon) ? (icon as LeaveIconKey) : '',
  );
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const shownIcons = LEAVE_ICON_KEYS.filter((key) => {
    if (q === '') return true;
    if (key.toLowerCase().includes(q)) return true;
    return LEAVE_ICONS[key].keywords.some((kw) => kw.includes(q));
  });
  const PreviewIcon = selIcon ? LEAVE_ICONS[selIcon].Icon : null;

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t('visual.sectionTitle')}</span>
      <form action={action} className="space-y-3 rounded-lg bg-background p-3">
        <input type="hidden" name="id" value={id} />
        {/* preserve the name — this form does not edit it */}
        <input type="hidden" name="name" value={name} />
        {/* marker: tells the action to touch the color + icon columns (tri-state guard) */}
        <input type="hidden" name="visual" value="1" />
        {/* the picked values, posted back to the action */}
        <input type="hidden" name="icon" value={selIcon} />
        <input type="hidden" name="color" value={selColor} />

        {/* Icon picker */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">{t('visual.iconLabel')}</span>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('visual.searchPlaceholder')}
                aria-label={t('visual.searchPlaceholder')}
                className={`${inputCls} w-full pl-7`}
              />
            </div>
            {/* live preview of the selected icon */}
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
              {PreviewIcon ? <PreviewIcon className="size-4" aria-hidden /> : <span className="text-xs text-muted-foreground">—</span>}
            </span>
          </div>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
            {shownIcons.map((key) => {
              const Ico = LEAVE_ICONS[key].Icon;
              const active = selIcon === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelIcon(active ? '' : key)}
                  aria-pressed={active}
                  aria-label={key}
                  title={key}
                  className={`flex aspect-square items-center justify-center rounded-md border ${
                    active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-muted'
                  }`}
                >
                  <Ico className="size-4" aria-hidden />
                </button>
              );
            })}
            {shownIcons.length === 0 && (
              <p className="col-span-full text-xs text-muted-foreground">{t('visual.noIcons')}</p>
            )}
          </div>
        </div>

        {/* Colour swatch radio */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">{t('visual.colorLabel')}</span>
          <div className="flex flex-wrap gap-1.5">
            {LEAVE_COLOR_TOKENS.map((token) => {
              const active = selColor === token;
              return (
                <button
                  key={token}
                  type="button"
                  onClick={() => setSelColor(active ? '' : token)}
                  aria-pressed={active}
                  aria-label={t(`visual.color.${token}`)}
                  title={t(`visual.color.${token}`)}
                  className={`size-7 rounded-full ${LEAVE_COLORS[token].bg} ${
                    active ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : 'ring-1 ring-border'
                  }`}
                />
              );
            })}
          </div>
        </div>

        <Button type="submit" size="sm">
          {t('save')}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t('visual.help')}</p>
    </div>
  );
}

/**
 * The five consolidated settings, read from the leave TYPE (9816a5ad step 2, migration 0325 columns).
 * They were shaped to overlap the old `EntitlementPolicy` field-for-field so the Earning Method and Carry
 * Forward forms could be re-pointed at the type without being rewritten; 6e9a126e release three deleted
 * that type, and this one is now simply what the leave type stores.
 */
export type LeaveTypeRules = {
  accrualMethod?: string | null;
  /** bc36c768 — the day of the month Monthly Accrual credits on, 1..31. null ⇒ not set (⇒ day 1). */
  accrualDay?: number | null;
  /** bc36c768 — the NOT-CONFIGURED marker, as an ISO STRING rather than the Date the column holds.
   *  Deliberate: the server page hands this to a client component, and a plain string is unambiguously
   *  serialisable across that boundary (see test/server-client-boundary.test.ts). Non-null ⇒ this type
   *  grants nothing and earns nothing until an earning method is saved. */
  accrualUnconfigured?: string | null;
  carryForwardEnabled?: boolean | null;
  carryForwardMax?: number | null;
  /** 7cd914b1 — carry as a share of the year-end balance. numeric ⇒ may arrive as a string. */
  carryForwardPercent?: string | number | null;
  carryForwardExpiryMode?: 'date' | 'months' | null;
  carryForwardExpiryMonths?: number | null;
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  carryForwardIncludeEarned?: boolean | null;
  roundingMethod?: LeaveRoundingMethod | null;
  /** Feedback 9f5164d8 — the custom decimal threshold. Postgres numeric ⇒ may arrive as a string. */
  roundingThreshold?: string | number | null;
  /** 8fec719e — the custom rounding table, as stored. A plain array of plain objects, which is what makes
   *  it legal for the server page to hand to this client component (see test/server-client-boundary). */
  roundingBands?: RoundingBand[] | null;
  maxBalanceDays?: number | null;
};

export function LeaveTypePanel({
  id,
  name,
  code,
  description,
  paid,
  archived,
  inUse,
  cascadeApprovalRules,
  cascadeBalanceSourceOf,
  isAnnual,
  eligibility,
  orgAssignmentOptions,
  durations,
  requiresDocument,
  mandatoryAfterDays,
  allowedMimeTypes,
  maxDocBytes,
  employeeRemarkRequired,
  hrRemarkRequired,
  backdatingLimitDays,
  maxDaysPerLeaveYear,
  maxDaysPeriod,
  maxConsecutiveDays,
  maxConsecutiveUnit,
  minAdvanceDays,
  minAdvanceDayType,
  customMessages,
  essViewConfig,
  formulaExplanations,
  formulaTemplate,
  dayTypeInclusion,
  color,
  icon,
  leaveUnit,
  yearCycleOverride,
  probationEligibility,
  visibleToEmployee,
  employeeCanApply,
  essPlacement,
  role,
  counting,
  perDateApproval,
  duplicateApplicationPolicy,
  overrideRules,
  allowNegativeBalance,
  maxNegativeBalance,
  balanceSourceTypeId,
  allowUnpaidLeave,
  balanceSourceOptions,
  typeRules,
  halfDaySection,
  accrualSection,
  entitlementTablesSection,
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  setTypeRulesAction,
}: {
  id: string;
  name: string;
  code: string;
  /** Leave Type master page (feedback 097de541): optional free-text description, edited in the identity
   *  sub-form. Threaded so the input round-trips. null = none. */
  description: string | null;
  /** Edit Paid/Unpaid on rename (feedback 75953777): whether leave of this type is paid (payroll-deduction
   *  source of truth). Threaded so the identity/rename sub-form's Paid checkbox round-trips its saved value.
   *  Editing it applies to FUTURE leave only — historical records/ledger are untouched. */
  paid: boolean;
  archived: boolean;
  inUse: boolean;
  /** 4fdb69b2 — what a delete would cascade, BY NAME, for the confirmation. Empty arrays render nothing. */
  cascadeApprovalRules: string[];
  /** Leave types whose balance source is THIS type; deleting clears their source (they are not deleted). */
  cascadeBalanceSourceOf: string[];
  isAnnual: boolean;
  eligibility: LeaveEligibilityRule | null;
  /** Organisation Assignment criteria (Enhance Leave Criteria Configuration): the ACTIVE picker values for each
   *  of the eight org fields, keyed by profile_option category (division / branch / … / category). Sourced from
   *  the SAME master list the profile Organisation Assignment screen uses (listAllProfileOptions active-only), so
   *  deleted/inactive values are never offered as new choices. Already-stored values (incl. now-inactive ones)
   *  are unioned in at render so a saved condition stays visible and survives a re-save. */
  orgAssignmentOptions: Record<string, { value: string; label: string }[]>;
  /** ADR-0048: enabled non-full-day durations (e.g. ['half_day_am','hourly']); null/[] = full-day-only. */
  durations: string[] | null;
  /** Supporting-document config — current values, threaded so the sub-form round-trips. */
  requiresDocument: boolean;
  mandatoryAfterDays: number | null;
  allowedMimeTypes: string[] | null;
  maxDocBytes: number;
  employeeRemarkRequired: boolean;
  hrRemarkRequired: boolean;
  /** Configurable backdated-leave restriction (0133): how many days back a leave of this type may be applied;
   *  null = no limit. Threaded so the sub-form round-trips. Field hidden for Emergency Leave (code === 'EMERGENCY'). */
  backdatingLimitDays: number | null;
  /** Application Limits (c6ffa725): max days APPLIED FOR per leave year. null = no limit. */
  maxDaysPerLeaveYear: number | null;
  /** ad9cb5c5 — the window the ceiling is counted over. NULL ⇒ leave year, what every type means today. */
  maxDaysPeriod: string | null;
  /** Maximum Consecutive Leave (c6ffa725 rev 2): the longest SINGLE application this type allows, and the
   *  unit that figure is read in. An all-or-nothing pair — both null = Unlimited, which is every leave type
   *  today. Threaded so the sub-form round-trips. */
  maxConsecutiveDays: number | null;
  maxConsecutiveUnit: 'calendar_days' | 'working_days' | null;
  /** Minimum advance-notice rule (0159): how many days before its start date a leave of this type must be
   *  submitted; null = no requirement. Threaded so the sub-form round-trips. Field hidden for Emergency Leave
   *  (code === 'EMERGENCY' — EL exists precisely for short-notice absence and is never guarded). */
  minAdvanceDays: number | null;
  /** Advance Notice — calendar days or working days (7daac043, migration 0447): the UNIT the requirement
   *  above is read in. null ⇒ Calendar Days, which is what every leave type configured before this shipped
   *  means and what the select falls back to. Threaded so the sub-form round-trips. */
  minAdvanceDayType: 'calendar_days' | 'working_days' | null;
  /** Custom validation messages (custom-messages migration): admin-authored override text keyed by rule config
   *  field (`backdatingLimitDays` | `minAdvanceDays`). Threaded so each rule's "Custom system message"
   *  textarea round-trips. null / absent key = show the built-in localized default. */
  customMessages: Record<string, string> | null;
  /** Employee Leave View Configuration (65dec703 / dup 1fedb473): per-component ESS visibility map, threaded
   *  so each checkbox round-trips its stored value. null / missing key ⇒ visible (all-visible default). */
  essViewConfig: Record<string, boolean> | null;
  /** Leave Entitlement Formula Management (79011509): stored per-item explanation map, threaded so each
   *  item's Description / Formula Explanation textareas round-trip their saved value. null / missing key ⇒
   *  no explanation (the employee-panel info icon stays hidden). */
  formulaExplanations: Record<string, LeaveFormulaEntry> | null;
  /** Smart content reuse (ed17a4f9 §4): the FIRST configured leave type's explanation map, resolved once
   *  per page. Pre-fills only the items THIS type has not configured; never overwrites and never persists
   *  on its own. null ⇒ no leave type is configured yet. */
  formulaTemplate: Record<string, LeaveFormulaEntry> | null;
  /** Day Type Inclusion (ef6d7146): stored { offDay, restDay, publicHoliday, companyHoliday, shutdownDay }
   *  map, threaded so each toggle round-trips its saved value. null / missing key ⇒ off (day type skipped,
   *  the counting-mode default). */
  dayTypeInclusion: Record<string, boolean> | null;
  /** Leave Type Visual Configuration (639fdf77): stored colour token + icon key, threaded so the swatch
   *  radio + icon picker init from what's saved. null ⇒ nothing selected (default styling). */
  color: string | null;
  icon: string | null;
  /** Leave Unit Configuration (e4980382): whether this type is managed in Days or Hours ('day' | 'hour'),
   *  threaded so the "Leave Unit" select round-trips its saved value. Coarse labelling/reporting only. */
  leaveUnit: string;
  /** Leave Year Type override (e1a51aea): the stored per-type cycle override ('a2a' | 'c2c' | null),
   *  threaded so the General step's "Leave Year Type" select round-trips its saved value. null ⇒ the type
   *  follows its company's cycle (today's behaviour). */
  yearCycleOverride: string | null;
  /** Probation eligibility (d6bdbd55): the stored probation gate ('confirmed_only' | 'probation_only' | null),
   *  threaded so the eligibility editor's Probation select round-trips its saved value. null ⇒ no restriction. */
  probationEligibility: string | null;
  /** Leave Type Employee Visibility (7b11f1c1): whether this type is shown to employees on the /me Leave tab
   *  and whether they may apply for it. Threaded so the two checkboxes round-trip their saved value. null ⇒
   *  the default (visible / can-apply). The service rejects can-apply=false on a statutory code. */
  visibleToEmployee: boolean | null;
  employeeCanApply: boolean | null;
  /** Leave grouping visibility (b653ac1b): the stored ess_placement ('primary'|'secondary'|null). Combined
   *  with visibleToEmployee (false ⇒ Hidden) and the type code, the panel resolves the current 3-way choice
   *  shown in the placement select. null ⇒ the code-keyed default. */
  essPlacement: string | null;
  /** 5ff7daff: the type's `role` marker ('replacement' | 'emergency' | …), threaded so the placement select
   *  shows the SAME default the employee's Leave tab resolves. Without it a tenant whose replacement type is
   *  coded `RL` reads "Secondary" here while the card is drawn Primary there. null ⇒ unclassified ⇒ the
   *  code-keyed default, exactly as before. Display-only: nothing on this screen writes the role. */
  role: string | null;
  /** ADR-0068 / Partial Leave Approval: the type's counting mode ('working_days' | 'calendar_days'), threaded
   *  so the per-date-approval sub-form can grey out its toggle for calendar-counted types (the feature can
   *  never fire there — see the gate in core/leave.ts perDateEligible). */
  counting: string;
  /** ADR-0068 / Partial Leave Approval: whether HR has enabled per-date (partial) approval for this type,
   *  threaded so the sub-form's checkbox round-trips its saved value. Backend at app/admin/actions.ts +
   *  core/admin.ts touchPartial persists it as a tri-state (untouched when the marker is absent). */
  perDateApproval: boolean;
  /** Duplicate Leave Application Restriction (d5e51c34): the same-date double-booking policy for this type
   *  ('allow' | 'restrict_same' | 'restrict_any'), threaded so the radio round-trips its saved value. null ⇒
   *  'allow' (today's behaviour). Enforced at requestLeave/editLeaveRequest; persisted via touchDuplicatePolicy. */
  duplicateApplicationPolicy: string | null;
  /** Override Leave Application (56910869): what HR has configured to happen when one of this type's rules
   *  is not met. null / empty ⇒ nothing configured, which is every type until HR adds a rule. Serialisable
   *  data only — this component is a client component (see the header). */
  overrideRules: { trigger: string; action: string; enabled: boolean }[] | null;
  /** Configurable Negative Leave Balance Validation (0ef0defd): whether employees may submit/edit a leave
   *  application of this type that exceeds their available balance. false ⇒ block over-application (the
   *  default). Threaded so the Yes/No sub-form round-trips its saved value; persisted via touchNegativeBalance. */
  allowNegativeBalance: boolean;
  /** bc512dc3 — positive magnitude floor; NULL ⇒ unbounded (today's behaviour). */
  maxNegativeBalance: number | null;
  /** Balance Deduction Source (cdf9ca48): the leave type this one's applications are checked against and
   *  debited from. null ⇒ its own balance (the default). Threaded so the mode radio + source select
   *  round-trip; persisted via touchBalanceSource. */
  balanceSourceTypeId: string | null;
  /** Allow Unpaid Leave (a7fab30b): whether an application of this type may exceed the available balance,
   *  with the excess treated as unpaid leave. false ⇒ today's behaviour. Threaded so the Yes/No sub-form
   *  round-trips; persisted via touchAllowUpl. */
  allowUnpaidLeave: boolean;
  /** Balance Deduction Source (cdf9ca48): the types this one may point at — the tenant's ACTIVE types minus
   *  this one, minus any that already borrow from somewhere (the service refuses chains, so offering them
   *  would only produce a rejected save). Prepared once at page level, not per panel. */
  balanceSourceOptions: { id: string; name: string }[];
  /** 9816a5ad step 2: the consolidated rules, read from and written back to the leave TYPE. */
  typeRules: LeaveTypeRules;
  /** 08bc6841: the company-wide Half-Day Deduction card — a server-composed slot (since 10e96227 ONE
   *  ChipMultiSelect over companyIds plus one Save posting setLeaveHalfDayFullDeductionCompaniesAction,
   *  embedded as one card of the Condition step's Leave Application Rules grid with an
   *  applies-company-wide badge). Slot-shaped: the rule is per-COMPANY (not per-type), so ONE node is
   *  prepared at page level and shared by every panel. */
  halfDaySection?: ReactNode;
  /** 7b945408 / 38f1fd40: the Run Accrual action (d778d2d3's EarnedAccrualDialog). It is the ONLY mount of
   *  EarnedAccrualDialog — the page header was cleared by 962077a8 and must not be used as a home again.
   *  Server-composed slot (page-level data prep, one shared node). 6e9a126e release three: it is also the
   *  only WORKING control left in the Entitlement step, which is why the step still exists. */
  accrualSection?: ReactNode;
  /** ee6b7c69: THIS TYPE'S Entitlement Tables and eligibility rules — the day figures, the service ranges
   *  and who receives them — server-composed and filtered to this panel. It replaces the release-three
   *  `entitlementTablesLink` slot, which held a caption and a link to /admin/leave/entitlements/templates;
   *  the reporter's whole point was that a step called Entitlement should contain entitlement. Unlike
   *  halfDaySection / accrualSection this is NOT one node shared by every panel — the leave-type filter is
   *  the item — but the READS behind it are still one page-level load, sliced in memory. The standalone
   *  screen still exists and is still linked from the page header for a side-by-side view of all types. */
  entitlementTablesSection?: ReactNode;
  updateTypeAction: Action;
  archiveTypeAction: Action;
  deleteTypeAction: Action;
  /** 9816a5ad step 2: writes the five consolidated settings to the leave type. */
  setTypeRulesAction: Action;
}) {
  const t = useTranslations('admin.leave');
  // Organisation Assignment criteria (Enhance Leave Criteria Configuration): the eight criterion labels REUSE
  // the existing profile_option category labels (already shipped in all six locales) — zero new keys. Scoped
  // translator so a call site reads t org-label statically (the i18n coverage test).
  const tOrg = useTranslations('admin.profileOptions.category');
  // Sync Employee Leave View Configuration (11876072): the view-config group headings reuse the employee
  // panel's OWN section titles (leave.breakdown.section.*) so the admin screen reads as a preview of the
  // panel — same words, same order. That translator now lives inside ViewConfigSection (2bc2f2a3).
  // Leave Type Employee Visibility (7b11f1c1): statutory-entitlement types can never have employee
  // applications blocked (an employee must be able to exercise a lawful entitlement — EA 1955 s.60E/s.60F/
  // s.37/s.60FA). 464b58e6 — THE QUESTION IS NOW ASKED ONCE, in lib/leave-statutory.ts, which mirrors
  // core/leave.ts's `isStatutoryApplyType` precedence exactly: ROLE FIRST, seeded codes as the fallback.
  // It used to be a local list of the five SEEDED codes, so on a tenant whose statutory types are coded
  // MTL / PTL / EL the switch looked editable here and the service refused only after Save — the reported
  // failed save. The service is still the authority; this is the screen telling the truth in advance.
  const isStatutoryApply = isStatutoryApplyLeaveType({ role, code });
  // Edit Leave Type Code (a7194511): the Code field is editable ONLY for custom (non-statutory) types. The
  // five seeded statutory codes — plus EMERGENCY — are the semantic keys the leave/payroll engine matches on
  // for EA-1955 statutory entitlement, carry-forward and encashment; renaming one would silently switch those
  // rules off, so they stay LOCKED (read-only). Mirrors the service guard (STATUTORY_APPLY_CODES +
  // EMERGENCY_LEAVE_CODE in core/leave.ts) as a local literal so this client component never imports server code.
  //
  // THIS LOCK IS STILL CODE-ONLY ON PURPOSE, and no longer rides on isStatutoryApply above (464b58e6). It
  // covers a WIDER set (Emergency too) and answers a different question, and making it role-first here would
  // newly freeze the Code field on production's classified types — a behaviour change nobody asked for in
  // this round. core/admin.ts's `isLockedType` is already role-first, so the two deliberately disagree until
  // that change is asked for; do not "tidy" them together without a plan that says so.
  const codeLocked =
    (STATUTORY_APPLY_SEEDED_CODES as readonly string[]).includes(code) || code === 'EMERGENCY';
  const [editingName, setEditingName] = useState(false);
  // Day Type Inclusion (ef6d7146): its own edit-mode toggle (a sub-form inside Eligibility Rules).
  const [editingDayTypes, setEditingDayTypes] = useState(false);
  // Feedback 9d8cf621 — custom apply-time message: the enable checkbox drives whether the textarea is shown.
  // Default from stored state (a non-empty applyNotice ⇒ enabled), so it round-trips on reload.
  const [applyNoticeEnabled, setApplyNoticeEnabled] = useState<boolean>(!!customMessages?.applyNotice);
  /* 6e9a126e release three — the "Employee Selection" scope state (pickCompanies / pickGrades /
   * entitledCount and the refreshCount + recountEditScope helpers that drove the live entitled-employee
   * figure) belonged to the add / edit policy forms and went with them. Who an entitlement covers is stated
   * as an eligibility rule on the Entitlement Tables screen, which counts its own targets through
   * countEligibilityTargetsAction — the same idea, against the layer that now decides. */

  // Step flow (c979aa8b — was the 123c1e76 five-card accordion): ONE section visible at a time, chosen by
  // the numbered horizontal step bar (1 General … 4 Custom since b8fcae73). The active step is per-type client state,
  // persisted to the SAME localStorage key the accordion used (`leaveTypeCards:<id>`) so it SURVIVES the
  // stay-on-save redirect (b9dac2d1 keystone re-mounts the panel) — the step HR was editing stays open after
  // Save. Stored shape is now { activeStep }; an old accordion payload ({ key: boolean }) migrates gracefully:
  // its first open card (in step order) becomes the active step. Default = step 1 (General Setting). Hydrate
  // from storage in an effect (client-only ⇒ no SSR hydration mismatch; a brief step-1→restored flash is
  // acceptable — the same trade-off the accordion made).
  const [activeStep, setActiveStep] = useState<StepKey>('general');
  // General sub-step (e1a51aea): the active sub-step of step 1, persisted ALONGSIDE activeStep in the SAME
  // leaveTypeCards:<id> shape — now { activeStep, generalSubStep }. Backward-compatible migration: an older
  // { activeStep }-only payload (and the pre-step accordion { key: boolean } shape) still hydrates —
  // generalSubStep simply defaults to sub-step 1 (Details) when the key is absent/unknown.
  const [generalSubStep, setGeneralSubStep] = useState<GeneralSubStepKey>('details');
  // Condition sub-step (08bc6841): the active sub-step of step 4, persisted in the SAME shape — now
  // { activeStep, generalSubStep, essSubStep }. Older payloads (activeStep-only, activeStep+generalSubStep,
  // the pre-step accordion { key: boolean }) still hydrate — essSubStep simply defaults to sub-step 1
  // (Criteria) when the key is absent/unknown.
  const [essSubStep, setEssSubStep] = useState<EssSubStepKey>('criteria');
  // 6e9a126e release three: `entitlementSubStep` is gone from this shape. The Entitlement step has no
  // sub-flow left to remember (see the ENTITLEMENT_SUB_STEP note above), so the key is neither read nor
  // written; a payload written by an older build still carries it and is simply ignored.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`leaveTypeCards:${id}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      // b8fcae73: the Eligibility step is gone, so a payload still pointing at it (either shape) no longer
      // matches STEP_KEYS and would silently fall back to step 1. Remap it to the content's new home — the
      // Entitlement step, which since release three is one undivided section.
      const wantedEligibility =
        !!parsed &&
        typeof parsed === 'object' &&
        (parsed.activeStep === RETIRED_ELIGIBILITY_STEP ||
          (typeof parsed.activeStep !== 'string' &&
            !STEP_KEYS.some((k) => parsed[k] === true) &&
            parsed[RETIRED_ELIGIBILITY_STEP] === true));
      if (wantedEligibility) {
        setActiveStep('entitlement');
      } else if (parsed && typeof parsed.activeStep === 'string' && (STEP_KEYS as readonly string[]).includes(parsed.activeStep)) {
        setActiveStep(parsed.activeStep as StepKey);
      } else if (parsed && typeof parsed === 'object') {
        // migrate the pre-step accordion shape { key: boolean } — first open card wins
        const firstOpen = STEP_KEYS.find((k) => parsed[k] === true);
        if (firstOpen) setActiveStep(firstOpen);
      }
      if (
        parsed &&
        typeof parsed.generalSubStep === 'string' &&
        (GENERAL_SUB_STEP_KEYS as readonly string[]).includes(parsed.generalSubStep)
      ) {
        setGeneralSubStep(parsed.generalSubStep as GeneralSubStepKey);
      }
      if (
        parsed &&
        typeof parsed.essSubStep === 'string' &&
        (ESS_SUB_STEP_KEYS as readonly string[]).includes(parsed.essSubStep)
      ) {
        setEssSubStep(parsed.essSubStep as EssSubStepKey);
      }
    } catch {
      /* storage unavailable / malformed ⇒ default step 1 */
    }
  }, [id]);
  const persistSteps = (step: StepKey, sub: GeneralSubStepKey, ess: EssSubStepKey) => {
    try {
      window.localStorage.setItem(
        `leaveTypeCards:${id}`,
        JSON.stringify({ activeStep: step, generalSubStep: sub, essSubStep: ess }),
      );
    } catch {
      /* storage write blocked ⇒ runtime switch still works, just not persisted */
    }
  };
  const selectStep = (key: StepKey) => {
    setActiveStep(key);
    persistSteps(key, generalSubStep, essSubStep);
  };
  const selectGeneralSubStep = (key: GeneralSubStepKey) => {
    setGeneralSubStep(key);
    persistSteps(activeStep, key, essSubStep);
  };
  const selectEssSubStep = (key: EssSubStepKey) => {
    setEssSubStep(key);
    persistSteps(activeStep, generalSubStep, key);
  };
  // Active-step indicator (27136ea6's accent treatment, carried onto the step bar): the CURRENT step's pill
  // gets the accent wash + semibold label — the same bg-accent language the sidebar's active nav item uses
  // (components/sidebar.tsx). Exactly one step is active at a time (the step-switcher invariant).
  const stepBtn = (active: boolean) =>
    cn(
      'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
      active
        ? 'border-transparent bg-accent font-semibold text-accent-foreground'
        : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
    );

  // #25 visibility: composable labels for the eligibility rule values (avoids a key-per-permutation
  // matrix across 6 locales). Shared by the edit form's pickers and the 0c15db78 criteria table.
  const genderLabel = (g: string) =>
    g === 'male' ? t('eligibilityGenderMale') : g === 'female' ? t('eligibilityGenderFemale') : null;
  const maritalLabel = (m: string) =>
    m === 'single'
      ? t('eligibilityMaritalSingle')
      : m === 'married'
        ? t('eligibilityMaritalMarried')
        : m === 'divorced'
          ? t('eligibilityMaritalDivorced')
          : m === 'widowed'
            ? t('eligibilityMaritalWidowed')
            : m === 'separated'
              ? t('eligibilityMaritalSeparated')
              : m === 'other'
                ? t('eligibilityMaritalOther')
                : null;
  // #165baee5: ChipMultiSelect DROPS any defaultSelected absent from its options, and the criteria pickers
  // are now always live (no "Edit rules" gate to opt into) — so an option list that silently omitted a stored
  // value would let a plain Save erase a rule nobody meant to touch. Union whatever is stored onto the offered
  // list; a value that no longer has a display label renders as its raw stored string.
  const withStored = (options: { value: string; label: string }[], stored: string[]) => [
    ...options,
    ...stored.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v })),
  ];
  // Organisation Assignment criteria (Enhance Leave Criteria Configuration): the picker for a field offers the
  // ACTIVE catalogue values (deleted/inactive are never NEW choices), UNIONED with whatever is ALREADY stored
  // on this type — so a saved value, even one later deactivated, stays visible and survives a re-save.
  const orgCriterionOptions = (category: string, key: OrgAssignmentCriterionKey) =>
    withStored(orgAssignmentOptions[category] ?? [], asEligList(eligibility?.[key]));

  // Day Type Inclusion (ef6d7146): a compact human summary of which day types are counted. When none are on
  // (null / all-false) we render the "working days only" default line, matching the reporter's Example 1.
  const dayTypeLabel = (k: string) => t(`dayTypeInclusion.${k}`);
  const dayTypeInclusionSummary = () => {
    const on = DAY_TYPE_INCLUSION_OPTIONS.filter((k) => dayTypeInclusion?.[k] === true);
    if (on.length === 0) return t('dayTypeInclusion.summaryNone');
    if (on.length === DAY_TYPE_INCLUSION_OPTIONS.length) return t('dayTypeInclusion.summaryAll');
    return t('dayTypeInclusion.summaryCounts', { list: on.map(dayTypeLabel).join(', ') });
  };

  /* 6e9a126e release three — THE DAYS-PER-YEAR HEADLINE IS GONE FROM THIS HEADER, together with the
   * `belowMinimumBadge` / `bandedNote` / `policyBadge` beside it and the `floor0` prop that judged them.
   * Every one of those numbers was read off the winning active `leave_policy` row; that layer no longer
   * exists, and this panel cannot see the entitlement TEMPLATES that replaced it — a template is scoped by
   * an eligibility rule, not by a leave type, so there is no single figure this screen could honestly put
   * against a type's name. Rendering "—" for every type in perpetuity would say "nothing is configured"
   * about a tenant that has configured plenty, somewhere this header cannot reach. The days, their service
   * bands and the below-statutory warning belong on the Entitlement Tables screen, which is where they are
   * typed and which the Entitlement step now links to. The header keeps what it genuinely owns: the type's
   * name, its code, and whether it is archived. */

  return (
    <div id={`type-${id}`} className={cn('space-y-3', archived && 'opacity-60')}>
      {/* Workspace header: the selected type's identity (formerly the collapsible row header — the expand
          toggle is gone; the workspace's internal left panel now does the selecting). The days-per-year
          summary that sat on the right went with the policy layer — see the note above the return. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{code}</span>
        {archived && <span className={badge.muted}>{t('archivedBadge')}</span>}
      </div>

      {/* Step bar (c979aa8b): numbered 1–5, current step highlighted; clicking a step shows that section's
          content in place — no page reload, no nested tabs. Labels reuse the category* title keys. */}
      <ol aria-label={t('workspaceStepsLabel')} className="flex flex-wrap items-center gap-1.5">
        {STEP_KEYS.map((key, i) => {
          const stepActive = activeStep === key;
          return (
            <li key={key} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="hidden h-px w-3 bg-border sm:block" />}
              <button
                type="button"
                onClick={() => selectStep(key)}
                aria-current={stepActive ? 'step' : undefined}
                aria-controls={stepActive ? `cat-${key}-${id}` : undefined}
                className={stepBtn(stepActive)}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums',
                    stepActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                {t(STEP_TITLE_KEY[key])}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="space-y-3">
          {activeStep === 'general' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryGeneral')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-general-${id}`} className="space-y-3">
          {/* General sub-flow (e1a51aea): the reusable SubStepBar (components/leave-sub-step-bar.tsx —
              the R61 step-bar mechanism generalized; later secondary flows MUST reuse it) walks the four
              sub-steps 1 Details · 2 Leave Year Type · 3 Earning Method · 4 Carry Forward Policy. One
              sub-step visible at a time; the choice persists per type alongside activeStep
              (leaveTypeCards:<id>). e4238594 removed the fifth, Approval Workflow — the bar renders
              `i + 1`, so the numbering follows the array and no step number is written down anywhere. */}
          <SubStepBar
            steps={GENERAL_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(GENERAL_SUB_STEP_TITLE_KEY[k]) }))}
            active={generalSubStep}
            onSelect={(k) => selectGeneralSubStep(k as GeneralSubStepKey)}
            ariaLabel={t('workspaceSubStepsLabel')}
          />
          {generalSubStep === 'details' && (
          <>
          {/* type-level controls */}
          {editingName ? (
            <form
              action={updateTypeAction}
              /* 6ef6e355 — responsive grid re-layout. Was a single `flex flex-wrap items-end gap-2` row where the
                 Paid checkbox sat wedged between text inputs and Description was a fixed oversized box. Now a
                 breakpoint-aware grid: 1 col (mobile) → 2 (sm) → 4 (lg). Compact fields pack the top row; Leave
                 Unit and Paid share the last cell (13ec5d3b) so Paid sits beside the unit select instead of
                 wrapping onto its own row, Description spans the full width and flows fluid, and Save/Cancel get
                 their own aligned full-width row. Cells wrap cleanly instead of compressing. Pure presentation —
                 no field, name attr, marker, server action or substrate changed. */
              className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-4"
            >
              <input type="hidden" name="id" value={id} />
              {/* Leave Type master page (feedback 097de541): marker tells the action to touch the description
                  column (tri-state guard) — this form edits Name + Description together. */}
              <input type="hidden" name="identity" value="1" />
              {/* Edit Leave Code (feedback 37a49524 → a7194511): the Leave Code is surfaced inside the edit form
                  so it can be viewed AND — for CUSTOM (non-statutory) types — renamed. Statutory codes (ANNUAL /
                  SICK / HOSPITALIZATION / MATERNITY / PATERNITY) and EMERGENCY stay LOCKED (read-only, no `name`
                  attr ⇒ nothing posted, server/substrate untouched): the code is the permanent semantic key the
                  leave/payroll engine matches on for EA-1955 rules, carry-forward and encashment; renaming one
                  would silently switch those rules off. A custom code posts `name="code"`; the server normalizes,
                  shape-validates, checks uniqueness and re-guards statutory both ways before persisting. */}
              <Field label={t('codeLabel')}>
                {codeLocked ? (
                  <input
                    value={code}
                    readOnly
                    aria-label={t('codeLabel')}
                    title={t('codeReadOnlyHint')}
                    className={`${inputCls} w-full cursor-not-allowed opacity-70`}
                  />
                ) : (
                  <input
                    name="code"
                    defaultValue={code}
                    aria-label={t('codeLabel')}
                    title={t('codeEditableHint')}
                    className={`${inputCls} w-full`}
                  />
                )}
              </Field>
              <Field label={t('nameLabel')}>
                <input name="name" defaultValue={name} aria-label={t('nameLabel')} className={`${inputCls} w-full`} />
              </Field>
              {/* 4ec5a940 — optional "why the change was made" note; recorded on the audit event. Placed ahead of
                  the Leave Unit + Paid pair so the compact fields pack the first grid row and that pair lands in
                  the last (right-most) cell (13ec5d3b). */}
              <Field label={t('reasonLabel')}>
                <input
                  name="reason"
                  type="text"
                  maxLength={500}
                  aria-label={t('reasonLabel')}
                  placeholder={t('reasonPlaceholder')}
                  className={`${inputCls} w-full`}
                />
              </Field>
              {/* Reposition Leave Unit beside Reason (bd063176 · option b — merge): the Day/Hour unit, formerly
                  its own always-on sub-form below, now rides the identity/rename form so it sits on the same grid
                  row as Reason (Reason left, Leave Unit right on lg) and saves in one action. The `leaveUnit=1`
                  marker makes updateLeaveTypeAction touch leave_unit (tri-state); the select defaults to the
                  stored value so an unchanged rename re-posts it as a no-op. Semantic shift (flagged): leave unit
                  is now editable in edit mode with Reason, not always-on. */}
              <input type="hidden" name="leaveUnit" value="1" />
              {/* 13ec5d3b: Leave Unit and Paid are co-located inside ONE grid cell (flex row) so Paid sits
                  immediately to the unit select's right instead of orphaning onto its own grid row on lg. */}
              <div className="flex items-end gap-3">
                <Field label={t('leaveUnitLabel')} className="min-w-0 flex-1">
                  <select
                    name="leaveUnitValue"
                    defaultValue={leaveUnit === 'hour' ? 'hour' : 'day'}
                    aria-label={t('leaveUnitLabel')}
                    title={t('leaveUnitHelp')}
                    className={`${inputCls} w-full`}
                  >
                    <option value="day">{t('leaveUnitDay')}</option>
                    <option value="hour">{t('leaveUnitHour')}</option>
                  </select>
                </Field>
                {/* Edit Paid/Unpaid on rename (feedback 75953777): the Paid/Unpaid flag lives on the rename form
                    so a mis-set type can be corrected without recreating it. The `identity=1` marker above means an
                    unchecked box is a real "unpaid" choice, not "untouched". Applies to future leave only.
                    13ec5d3b: shares this cell with Leave Unit (replacing 6ef6e355's justify-self-end far-right
                    cell) so the pair reads Leave Unit → Paid side by side. */}
                <Field label={t('paidLabel')}>
                  <div className="flex h-9 items-center">
                    <input
                      type="checkbox"
                      name="paid"
                      defaultChecked={paid}
                      aria-label={t('paidLabel')}
                      className="size-4 rounded"
                    />
                  </div>
                </Field>
              </div>
              <Field label={t('descriptionLabel')} className="col-span-full">
                {/* Multiline (fbcadc71): textarea so Enter inserts a newline instead of submitting the rename form;
                    h-auto/min-h/resize-y overrides inputCls's fixed h-9 so it shows ~3 lines, grows via the drag
                    handle, and scrolls on overflow. defaultValue round-trips stored newlines faithfully.
                    6ef6e355: spans the full grid row and goes fluid (w-full) so it resizes with available width
                    instead of sitting at a fixed oversized size; keeps vertical resize handle. */}
                <textarea
                  name="description"
                  defaultValue={description ?? ''}
                  aria-label={t('descriptionLabel')}
                  placeholder={t('descriptionPlaceholder')}
                  rows={3}
                  className={`${inputCls} h-auto min-h-[4.5rem] w-full resize-y`}
                />
              </Field>
              {/* Edit Leave Type Code (a7194511): Save opens a confirmation (reusing ConfirmSubmit) with
                  Save changes / Cancel; the outer button Discards the edit (exits without saving). Together
                  they give the reporter's "Save Changes / Discard Changes / Cancel" choice. On a successful
                  save the action redirects back to this panel with a success toast (stays on page). */}
              <div className="col-span-full flex items-center gap-2">
                <ConfirmSubmit
                  size="sm"
                  variant="default"
                  title={t('saveConfirmTitle')}
                  description={t('saveConfirmDescription')}
                  confirmLabel={t('saveConfirmConfirm')}
                >
                  {t('save')}
                </ConfirmSubmit>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditingName(false)}>
                  {t('discardChanges')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{t('typeLabel')}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditingName(true)}>
                {t('rename')}
              </Button>
              {archived ? (
                <form action={archiveTypeAction}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="archived" value="false" />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('unarchive')}
                  </Button>
                </form>
              ) : inUse ? (
                <form action={archiveTypeAction}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="archived" value="true" />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('archive')}
                  </Button>
                </form>
              ) : (
                <form action={deleteTypeAction}>
                  <input type="hidden" name="id" value={id} />
                  {/* 4fdb69b2 — THE CONFIRMATION IS PART OF THE FEATURE, not decoration. Deleting now
                      cascades the type's configuration, and one branch of that cascade changes a leave
                      type that is NOT being deleted: any type drawing its balance from this one has that
                      source cleared. So the dialog NAMES what goes rather than counting it, and names the
                      affected other type explicitly. The reporter asked not to clear these references by
                      hand; they did not ask to be kept in the dark about them.
                      Both lists are usually empty, in which case the wording is exactly what it was. */}
                  <ConfirmSubmit
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title={t('deleteTypeConfirmTitle')}
                    description={[
                      t('deleteTypeConfirmDescription'),
                      cascadeApprovalRules.length > 0
                        ? t('deleteTypeCascadeRules', { names: cascadeApprovalRules.join(', ') })
                        : null,
                      cascadeBalanceSourceOf.length > 0
                        ? t('deleteTypeCascadeBalanceSource', {
                            names: cascadeBalanceSourceOf.join(', '),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join('\n\n')}
                    confirmLabel={t('deleteConfirmLabel')}
                  >
                    {t('delete')}
                  </ConfirmSubmit>
                </form>
              )}
            </div>
          )}
          {/* Leave Unit Configuration (e4980382) — the Day/Hour unit moved into the identity/rename form above
              (bd063176) so it sits beside Reason and saves in one action; the standalone always-on sub-form
              that lived here was removed. */}
          {/* Partial Leave Approval (ADR-0068 · re-added ac6c2025 · moved into General Setting by 123c1e76 —
              the Approval Rules card it was the sole occupant of is gone). Its own sub-form (own tri-state)
              posts `partialApproval=1`, so a rename / eligibility / durations / document / payroll /
              backdating edit that omits the marker leaves per_date_approval untouched. This is the HR-facing
              enable switch for the per-date approval modal that is already live on the approvals inbox.
              Backend wiring (app/admin/actions.ts touchPartial + core/admin.ts) is untouched by the move.
              The feature only fires for FULL-DAY, WORKING-DAYS-counted, non-REPLACEMENT types in a company
              whose leave approval chain is single-step; when the type can never satisfy that, we still let
              the admin set the flag but show a greyed note explaining it won't apply (not a silent no-op). */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('partialApprovalSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the per_date_approval column (tri-state guard) */}
              <input type="hidden" name="partialApproval" value="1" />
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="perDateApproval"
                  defaultChecked={perDateApproval}
                  className="size-3.5 rounded border-border"
                />
                {t('perDateApprovalLabel')}
              </label>
              {/* Greyed note: the type is structurally ineligible (REPLACEMENT or calendar-counted), so the
                  flag has no effect even when set. Mirrors ADR-0068 §4C's gate rather than silently ignoring. */}
              {(code === 'REPLACEMENT' || counting !== 'working_days') && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {code === 'REPLACEMENT'
                    ? t('perDateApprovalNoteReplacement')
                    : t('perDateApprovalNoteCounting')}
                </p>
              )}
              {/* Discoverability note (item 4): the load-bearing explanation of the multi-step interaction. */}
              <p className="text-xs text-muted-foreground">{t('perDateApprovalMultiStepNote')}</p>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('perDateApprovalHelp')}</p>
          </div>
          </>
          )}
          {/* Sub-step 2 — Leave Year Type (4d6eae7b). Restored to the General walk from Custom Settings,
              where 1e4eb8af had parked it: the reporter's order puts the CYCLE before the rules that
              operate inside it, because the earning method and rounding below only mean anything relative
              to a leave year. Presentation only — the SAME form, the SAME `yearCycle=1` tri-state marker
              (so an unrelated save still cannot reset year_cycle_override) and the SAME updateTypeAction
              writing the SAME year_cycle_override column. The tenant-wide managed leave-year RECORDS stay
              in Custom Settings; they are not a property of this leave type. */}
          {generalSubStep === 'yearType' && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('subStep.yearType')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the year_cycle_override column (tri-state guard) */}
              <input type="hidden" name="yearCycle" value="1" />
              <Field label={t('subStep.yearTypeLabel')}>
                <select
                  name="yearCycleValue"
                  defaultValue={
                    yearCycleOverride === 'a2a' || yearCycleOverride === 'c2c' || yearCycleOverride === 'a2c'
                      ? yearCycleOverride
                      : ''
                  }
                  aria-label={t('subStep.yearTypeLabel')}
                  className={cn(inputCls, 'w-72')}
                >
                  {/* The blank option is kept deliberately. It is the state EVERY type that has never made
                      an explicit choice is in, and removing it would leave those types unrepresentable in
                      their own editor — the first save would then silently pick a cycle for them. */}
                  <option value="">{t('subStep.yearTypeCompanyDefault')}</option>
                  <option value="a2a">{t('subStep.yearTypeA2a')}</option>
                  <option value="a2c">{t('subStep.yearTypeA2c')}</option>
                  <option value="c2c">{t('subStep.yearTypeC2c')}</option>
                </select>
              </Field>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('subStep.yearTypeHelp')}</p>
            <p className="text-xs text-muted-foreground">{t('subStep.yearTypeStepHelp')}</p>
          </div>
          )}
          {/* Sub-step 3 — Earning Method. 9816a5ad step 2 CHANGED WHAT THIS WRITES. It used to be a "front
              door" onto the active per-company/grade policy row, posting updatePolicyAction. The engines now
              read these rules from the leave TYPE, so a policy write would save successfully and change
              nothing the calculation reads — the worst kind of control. It now posts setTypeRulesAction
              against the type, and the per-policy scope picker is gone because there is no longer a scope:
              one leave type, one set of rules, exactly the consolidation the reporter asked for. */}
          {generalSubStep === 'earning' && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('subStep.earning')}</span>
            <EarningMethodForm t={t} rules={typeRules} action={setTypeRulesAction} leaveTypeId={id} />
            <p className="text-xs text-muted-foreground">{t('subStep.earningHelp')}</p>
          </div>
          )}
          {/* Sub-step 4 — Carry Forward Policy (e1a51aea): the same front-door pattern over the active
              policy's carry fields (enable + cap + the existing CarryExpiryFields days/months switch).
              Carry-forward is an ANNUAL-engine concept (expireCarriedLeave / openLeaveYear read it for the
              ANNUAL code only), so non-annual types get an explanatory note instead of a dead form. */}
          {generalSubStep === 'carry' && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('subStep.carry')}</span>
            {/* 7cd914b1: every leave type gets the real form. It used to render an "annual only" note for
                anything else, and the engine agreed with it — openLeaveYear hardcoded ANNUAL. Both gates
                are gone; carry is OFF by default on every type, so nothing starts carrying that does not
                carry today. */}
            <CarryPolicyForm t={t} rules={typeRules} action={setTypeRulesAction} leaveTypeId={id} />
            <p className="text-xs text-muted-foreground">{t('subStep.carryStepHelp')}</p>
          </div>
          )}
          {/* e4238594 removed sub-step 5 (Approval Workflow, e1a51aea). It duplicated the Approval Workflow
              tab, which is the real home. No link or placeholder stands in its place — the reporter
              rejected that explicitly — so the walk simply ends at Carry Forward Policy. */}
            </CardContent>
          </Card>
          )}
          {activeStep === 'entitlement' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryEntitlement')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-entitlement-${id}`} className="space-y-3">
          {/* ee6b7c69 — THE ENTITLEMENT STEP CONFIGURES ENTITLEMENT AGAIN.
              6e9a126e release three emptied it: the Benefit Schemes workbench and the Service Based
              Entitlements sub-steps all wrote `benefit_scheme` / `scheme_leave_entitlement` /
              `leave_policy`, the three tables that release dropped, and what replaced them — a named day
              table plus an eligibility rule — was typed once for the whole tenant on a SEPARATE screen.
              What was left here was a caption and an "Open Entitlement tables" link. The reporter's
              complaint was precisely that, and it was right: a step called Entitlement that contains no
              entitlement setting is a signpost, not a step.
              The slot below now holds the tables THEMSELVES, filtered to this leave type and rendered from
              the SAME definition the standalone screen renders — one component, two mount points, so the
              two surfaces cannot drift. Nothing is duplicated by doing so: it is still one table per
              lineage in one place in the database, and the standalone screen (linked from the page header)
              still shows every type side by side.
              Run Earned Accrual stays below it because it PROCESSES entitlement rather than defining it,
              and this is still its only mount (962077a8 cleared the page header and
              test/entitlement-header-actions-removal.test.ts guards that it stays cleared). */}
          {/* Each server-composed slot is the SOLE child of a wrapper this component creates — the
              `halfDaySection` pattern in the Condition step, and not decoration. Two slot elements sitting
              side by side as CardContent's children put two page-created, key-less elements in one child
              array, which React's dev build reports as "Each child in a list should have a unique key"
              (seen in the dev console before this wrapper was added). */}
          <div className="mb-3">{entitlementTablesSection}</div>
          <div>{accrualSection}</div>
            </CardContent>
          </Card>
          )}
          {activeStep === 'ess' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryEssPolicy')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-ess-${id}`} className="space-y-3">
          {/* Feedback 9d8cf621: the "Payroll impact" controls moved to the Payroll Related tab (per-type list
              there). Both were self-contained sub-forms, so moving/removing them here never touches any other
              column on save. */}
          {/* Condition sub-flow (08bc6841, shortened by c459bff9): the SAME reusable SubStepBar the General
              flow introduced (components/leave-sub-step-bar.tsx — the reuse contract) walks the two
              sub-steps 1 Criteria · 2 Leave Application Rules. One sub-step visible at a time; the
              choice persists per type alongside activeStep/generalSubStep (leaveTypeCards:<id>). */}
          <SubStepBar
            steps={ESS_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(ESS_SUB_STEP_TITLE_KEY[k]) }))}
            active={essSubStep}
            onSelect={(k) => selectEssSubStep(k as EssSubStepKey)}
            ariaLabel={t('conditionStepsLabel')}
          />
          {/* Sub-step 1 — Criteria (08bc6841): the eligibility rules moved here from the main Eligibility
              step — gender, marital status, minimum service period, probation requirement. Same form, same
              fields, same eligibility=1 tri-state marker, same updateTypeAction — values untouched; only
              the location changed. */}
          {/* #165baee5: the criteria are ALWAYS editable. The read-only summary table (0c15db78) and the
              "Edit rules" toggle it fronted are both gone, so a rule is read AND changed on one screen
              instead of behind a click. Presentation only — the SAME single form, the SAME eligibility=1
              marker, the SAME updateTypeAction, so nothing about how eligibility is decided moved. Saving
              stays an explicit Save rather than auto-saving each control: a mis-click on an eligibility rule
              quietly changing who may take leave is not worth the one saved click. */}
          {essSubStep === 'criteria' && (
          <div className="space-y-1.5">
            {/* #25 visibility — eligibility rules (who can see + apply) */}
            <span className="text-xs font-medium text-muted-foreground">{t('eligibilityTitle')}</span>
            <form action={updateTypeAction} className="space-y-3 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the eligibility column (tri-state guard) */}
              <input type="hidden" name="eligibility" value="1" />
              {/* #165baee5: one labelled control per criterion on a responsive grid, in the order the
                  reporter tabulated them — marital status, gender, minimum service, probation, then the
                  Organisation Assignment fields. It replaced a flex-wrap row whose ragged wrapping left
                  stranded gaps; the columns collapse to a single stack on a phone. Each caption sits ABOVE
                  its control because ChipMultiSelect owns its caption (the b9c30be0 contract) — a label cell
                  beside the control would need a <label>, the very element that re-opens the popover on the
                  outside click meant to close it. */}
              <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {/* Multi-select (#badc5966 → 2cc30077 → 0af0729d): ChipMultiSelect pickers per field, posting
                    repeated name="gender" / name="maritalStatus" (one hidden input per value — identical
                    FormData shape to the old checkbox group, so updateLeaveTypeAction's getAll() is unchanged).
                    An employee qualifies if their attribute matches ANY selected value; select nothing ⇒ no
                    restriction on that field (open to all). 0af0729d: the picker opens a popover listing the
                    FULL option list with checkbox indicators (stored values pre-checked); the bulk Select-all /
                    Clear-all and collapsed "All selected" / "{n} selected" summary props are deliberately NOT
                    passed here — these two lists are short, so the checklist reads clean and the chips (with
                    their remove buttons) are always visible. */}
                {/* No <Field> wrapper on these two (b9c30be0): ChipMultiSelect owns its caption via the
                    label prop, so no <label> element exists to re-activate the trigger after an outside
                    click closes the popover (the 2449fbb7 label-activation bug). */}
                <ChipMultiSelect
                  name="maritalStatus"
                  label={t('eligibilityMaritalLabel')}
                  options={withStored(
                    ELIGIBILITY_MARITAL_OPTIONS.map((m) => ({ value: m, label: maritalLabel(m) ?? m })),
                    asEligList(eligibility?.maritalStatus),
                  )}
                  defaultSelected={asEligList(eligibility?.maritalStatus)}
                  addPlaceholder={t('eligibilityChipAddPlaceholder')}
                  removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                />
                <ChipMultiSelect
                  name="gender"
                  label={t('eligibilityGenderLabel')}
                  options={withStored(
                    ELIGIBILITY_GENDER_OPTIONS.map((g) => ({ value: g, label: genderLabel(g) ?? g })),
                    asEligList(eligibility?.gender),
                  )}
                  defaultSelected={asEligList(eligibility?.gender)}
                  addPlaceholder={t('eligibilityChipAddPlaceholder')}
                  removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                />
                <Field label={t('eligibilityMinServiceLabel')}>
                  {/* Min-service unit (#f88f0a63): duration input + a unit select (Months / Days) beside it,
                      mirroring the expiry {value, unit} field. Absent stored unit ⇒ 'months' default so a
                      legacy row shows exactly as before. #165baee5: the duration flexes to the cell instead
                      of a fixed w-20, and an empty value spells out "No restriction" — the same wording the
                      probation select offers, so an unset rule never reads as merely blank.

                      FEEDBACK 4dbe04c6 — WHY THESE TWO USE cn() AND NOT A TEMPLATE STRING. `inputCls` ends
                      in `w-full`. Concatenating `w-28` after it does NOT win: both are width utilities, the
                      cascade is decided by the order Tailwind emits them into the stylesheet (where w-full
                      comes last), not by the order they appear in the class attribute. So the unit select
                      resolved to width:100% of the row, and `shrink-0` then forbade the shrink that would
                      have hidden the mistake — the select overflowed the panel by ~32px and squeezed the
                      number input to 26px, which is the reported fault: the typed value was clipped and the
                      control sat outside its container. Measured live before the fix (input 26px, select
                      336px in a 336px row, scrollWidth 368).

                      `cn` is tailwind-merge, which resolves same-property conflicts by LAST WINS, so w-28
                      and flex-1 actually take effect. Anywhere `${inputCls} w-…` still appears in this file
                      it is either inside a non-flex container (where a 100% width is harmless) or has no
                      shrink-0, where the flex shrink absorbs it — this was the only pair with both. */}
                  <div className="flex items-center gap-1.5">
                    <input
                      name="minServiceMonths"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={eligibility?.minServiceMonths ?? ''}
                      placeholder={t('eligibilityProbationNone')}
                      className={cn(inputCls, 'min-w-0 flex-1')}
                    />
                    <select
                      name="minServiceUnit"
                      defaultValue={eligibility?.minServiceUnit ?? 'months'}
                      aria-label={t('eligibilityMinServiceUnitLabel')}
                      className={cn(inputCls, 'w-28 shrink-0')}
                    >
                      <option value="months">{t('expiryUnitMonths')}</option>
                      <option value="days">{t('expiryUnitDays')}</option>
                    </select>
                  </div>
                </Field>
                {/* Probation eligibility (d6bdbd55): restrict this type by the employee's probation status.
                    Rides the same eligibility=1 marker; blank ⇒ no restriction. Stored in its own column. */}
                <Field label={t('eligibilityProbationLabel')}>
                  <select
                    name="probation"
                    defaultValue={probationEligibility ?? ''}
                    aria-label={t('eligibilityProbationLabel')}
                    className={inputCls}
                  >
                    <option value="">{t('eligibilityProbationNone')}</option>
                    <option value="confirmed_only">{t('eligibilityProbationConfirmedOnly')}</option>
                    <option value="probation_only">{t('eligibilityProbationProbationOnly')}</option>
                  </select>
                </Field>
                {/* Organisation Assignment criteria (Enhance Leave Criteria Configuration): one ChipMultiSelect
                    per org field, driven by the single ORG_ASSIGNMENT_CRITERIA descriptor. Each posts one hidden
                    input per selected value under name={key} (identical FormData shape to gender/maritalStatus →
                    the action's getAll(key) reads them). Options are the ACTIVE catalogue values unioned with any
                    already-stored value, so deleted/inactive values are not offered as NEW picks yet a saved
                    condition stays visible + survives re-save. Empty selection ⇒ no restriction on that field. */}
                {ORG_ASSIGNMENT_CRITERIA.map((c) => (
                  <ChipMultiSelect
                    key={c.key}
                    name={c.key}
                    label={tOrg(c.labelKey)}
                    options={orgCriterionOptions(c.category, c.key)}
                    defaultSelected={asEligList(eligibility?.[c.key])}
                    addPlaceholder={t('eligibilityChipAddPlaceholder')}
                    removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('eligibilityMultiHint')}</p>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('eligibilityHelp')}</p>
            <p className="text-xs text-muted-foreground">{t('eligibilityUndisclosedNote')}</p>
          </div>
          )}
          {/* Sub-step 2 — Leave Application Rules (08bc6841): the seven existing rule groups, re-laid as
              a responsive card grid instead of the old vertical stack — every sub-form keeps its own edit
              marker (durations=1, document=1, negativeBalance=1, backdating=1, minAdvance=1,
              duplicatePolicy=1, dayTypeInclusion=1) so saves stay per-group, and the EMERGENCY gates on
              backdating/advance-notice are intact. Nothing about the rules themselves changed. The
              relocated company-wide Half-Day Deduction card (halfDaySection slot) completes the grid. */}
          {/* #f6d3be0b: the grid became a CSS multi-column flow. A grid row is as tall as its tallest card,
              so short cards (durations, negative balance) stranded a block of empty space under themselves
              next to a tall neighbour (supporting documents) — the whitespace the reporter saw. Columns pack
              and balance instead, and still collapse 3 → 2 → 1 by breakpoint, so the fix does not just move
              the gap to a narrower screen. Each card carries `break-inside-avoid` so a card is never split
              across a column boundary, and each is now ONE surface (border + fill + padding) rather than a
              padded box inside a padded box — that nesting is what kept the fields off the panel's width. */}
          {essSubStep === 'rules' && (
          <div className="columns-1 gap-3 md:columns-2 xl:columns-3">
          {/* ADR-0048 — allowed leave durations (full day is always available) */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('allowedDurationsLabel')}</span>
            <form action={updateTypeAction} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the durations column (tri-state guard) */}
              <input type="hidden" name="durations" value="1" />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked disabled className="size-3.5 rounded border-border" />
                {t('duration_full_day')}
              </label>
              {DURATION_OPTIONS.map((d) => (
                <label key={d} className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    name="duration"
                    value={d}
                    defaultChecked={durations?.includes(d) ?? false}
                    className="size-3.5 rounded border-border"
                  />
                  {t(`duration_${d}`)}
                </label>
              ))}
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('allowedDurationsHelp')}</p>
          </div>
          {/* Supporting-document configuration */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('documentSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the document columns (tri-state guard) */}
              <input type="hidden" name="document" value="1" />
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="requiresDocument"
                  defaultChecked={requiresDocument}
                  className="size-3.5 rounded border-border"
                />
                {t('requireAttachmentLabel')}
              </label>
              <Field label={t('mandatoryAfterDaysLabel')}>
                <input
                  name="mandatoryAfterDays"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={mandatoryAfterDays ?? ''}
                  className={`${inputCls} w-full`}
                />
              </Field>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{t('allowedFileTypesLabel')}</span>
                <div className="flex flex-wrap gap-3">
                  {DOC_MIME_OPTIONS.map((o) => (
                    <label key={o.mime} className="flex items-center gap-1.5 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name="allowedMimeType"
                        value={o.mime}
                        defaultChecked={allowedMimeTypes?.includes(o.mime) ?? false}
                        className="size-3.5 rounded border-border"
                      />
                      {t(o.label)}
                    </label>
                  ))}
                </div>
              </div>
              <Field label={t('maxFileSizeLabel')}>
                <input
                  name="maxFileSizeMb"
                  type="number"
                  min="1"
                  max="10"
                  step="1"
                  defaultValue={Math.round(maxDocBytes / (1024 * 1024))}
                  className={`${inputCls} w-full`}
                />
              </Field>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="employeeRemarkRequired"
                  defaultChecked={employeeRemarkRequired}
                  className="size-3.5 rounded border-border"
                />
                {t('employeeRemarkRequiredLabel')}
              </label>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="hrRemarkRequired"
                  defaultChecked={hrRemarkRequired}
                  className="size-3.5 rounded border-border"
                />
                {t('hrRemarkRequiredLabel')}
              </label>
              <Button type="submit" size="sm">
                {t('saveDocumentRule')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('documentSectionHelp')}</p>
          </div>
          {/* Configurable Negative Leave Balance Validation (0ef0defd). Its own self-contained <form> +
              `negativeBalance=1` tri-state marker so an unrelated save never resets it. A Yes/No radio controls
              whether an employee may submit (or edit) a leave application whose days exceed their available
              balance. Default 'No' = block over-application at submit + edit (core/leave.ts); 'Yes' permits
              going negative (the approval-time guard still applies). */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('negativeBalanceSectionTitle')}</span>
            <NegativeBalanceForm
              t={t}
              id={id}
              name={name}
              allowNegativeBalance={allowNegativeBalance}
              maxNegativeBalance={maxNegativeBalance}
              action={updateTypeAction}
            />
            <p className="text-xs text-muted-foreground">{t('negativeBalanceHelp')}</p>
          </div>
          {/* Balance Deduction Source (feedback cdf9ca48). Its own self-contained <form> + `balanceSource=1`
              tri-state marker, mirroring the negative-balance card above. Two choices: keep this type's own
              balance (the default — clears the column), or deduct from another leave type, in which case the
              select beside it names the source. The two controls live in ONE form so the mode and the choice
              save atomically — a mode without a choice would otherwise persist as a half-configured "deduct
              from another type, but which?". The service refuses self-reference and chains at save. */}
          <BalanceSourceForm
            t={t}
            id={id}
            name={name}
            balanceSourceTypeId={balanceSourceTypeId}
            options={balanceSourceOptions}
            action={updateTypeAction}
          />
          {/* Allow Unpaid Leave (UPL) (feedback a7fab30b). Its own self-contained <form> + `allowUpl=1`
              tri-state marker. 'No' (default) keeps today's behaviour — the negative-balance rule above
              decides. 'Yes' lets the application through and treats only the days the balance could not
              cover as unpaid; the employee is shown that split on the application form before submitting. */}
          <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('allowUplSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the allow_unpaid_leave column (tri-state guard) */}
              <input type="hidden" name="allowUpl" value="1" />
              <span className="text-xs font-medium text-foreground">{t('allowUplLabel')}</span>
              <div className="space-y-1.5">
                {(['no', 'yes'] as const).map((opt) => (
                  <label key={opt} className="flex items-start gap-2 text-xs text-foreground">
                    <input
                      type="radio"
                      name="allowUnpaidLeaveValue"
                      value={opt}
                      defaultChecked={opt === (allowUnpaidLeave ? 'yes' : 'no')}
                      className="mt-0.5 size-3.5 border-border"
                    />
                    <span>{opt === 'yes' ? t('allowUplYes') : t('allowUplNo')}</span>
                  </label>
                ))}
              </div>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('allowUplHelp')}</p>
          </div>
          {/* Application Limits (c6ffa725): the maximum days an employee may APPLY for of this type within
              one leave year, regardless of whether any entitlement balance exists. Its own sub-form and its
              own `applicationLimits=1` marker, exactly like every other card on this grid.

              WHY IT SITS HERE AND NOT UNDER ENTITLEMENT: it is an application rule. It does not grant,
              accrue, carry or display a single day — an Unpaid Leave type still shows 0 available in Leave
              Summary, which is the reporter's stated requirement. It is enforced at submission and again at
              approval (core/leave.ts enforceLeaveYearApplicationLimit). */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('conditionStep.applicationLimitsTitle')}</span>
            <ApplicationLimitsForm
              t={t}
              id={id}
              name={name}
              maxDaysPerLeaveYear={maxDaysPerLeaveYear}
              maxDaysPeriod={maxDaysPeriod}
              action={updateTypeAction}
            />
            <p className="text-xs text-muted-foreground">{t('conditionStep.applicationLimitHelp')}</p>
          </div>
          {/* Maximum Consecutive Leave (c6ffa725 rev 2): the longest a SINGLE application of this type may
              be, and the unit it is read in. Its own sub-form and its own `maxConsecutive=1` marker — a
              different rule from the card above, which caps the YEAR.

              WHERE IT IS ENFORCED, and why that matters here: a leave type in a Shared Leave Group can ALSO
              be capped per application by the group. The two are composed in one place
              (core/leave.ts enforceApplicationLengthLimit), the stricter binds, and the refusal names which
              limit bound — so setting this can only ever tighten, never loosen what the group promised. */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('conditionStep.maxConsecutiveTitle')}</span>
            <MaxConsecutiveForm
              t={t}
              id={id}
              name={name}
              maxConsecutiveDays={maxConsecutiveDays}
              maxConsecutiveUnit={maxConsecutiveUnit}
              action={updateTypeAction}
            />
            <p className="text-xs text-muted-foreground">{t('conditionStep.maxConsecutiveHelp')}</p>
          </div>
          {/* Configurable backdated-leave restriction (0133). Its own sub-form (own tri-state) posts
              `backdating=1`. Hidden for Emergency Leave — EL is inherently retroactive and is never guarded,
              so showing the field would let HR set a value that is silently ignored (the EL config-trap). */}
          {code !== 'EMERGENCY' && (
            <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
              <span className="text-xs font-medium text-muted-foreground">{t('backdatingSectionTitle')}</span>
              <form action={updateTypeAction} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                {/* preserve the name — this form does not edit it */}
                <input type="hidden" name="name" value={name} />
                {/* marker: tells the action to touch the backdating_limit_days column (tri-state guard) */}
                <input type="hidden" name="backdating" value="1" />
                <Field label={t('backdatingLimitDaysLabel')}>
                  <input
                    name="backdatingLimitDays"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={backdatingLimitDays ?? ''}
                    className={`${inputCls} w-full`}
                  />
                </Field>
                {/* Custom validation messages (custom-messages migration): optional HR-authored override for
                    the backdating block message. Lives in the SAME form as the limit so it saves atomically
                    with `backdating=1`. Blank = keep the built-in localized default. */}
                <Field label={t('customMessageLabel')}>
                  <textarea
                    name="customMessageBackdating"
                    maxLength={500}
                    rows={2}
                    defaultValue={customMessages?.backdatingLimitDays ?? ''}
                    placeholder={t('customMessagePlaceholder')}
                    className={inputCls}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">{t('customMessageHelp')}</p>
                <Button type="submit" size="sm">
                  {t('save')}
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">{t('backdatingSectionHelp')}</p>
            </div>
          )}
          {/* Minimum advance-notice rule (0159 / feedback 0b0fb6c3). Its own sub-form (own tri-state) posts
              `minAdvance=1`, mirroring the backdating block above. Hidden for Emergency Leave — EL exists
              precisely for short-notice absence and is never guarded (it decomposes before the gate), so
              showing the field would let HR set a value that is silently ignored (the EL config-trap). */}
          {code !== 'EMERGENCY' && (
            <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
              <span className="text-xs font-medium text-muted-foreground">{t('advanceNoticeSectionTitle')}</span>
              <form action={updateTypeAction} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                {/* preserve the name — this form does not edit it */}
                <input type="hidden" name="name" value={name} />
                {/* marker: tells the action to touch the min_advance_days column (tri-state guard) */}
                <input type="hidden" name="minAdvance" value="1" />
                <Field label={t('minAdvanceDaysLabel')}>
                  <input
                    name="minAdvanceDays"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={minAdvanceDays ?? ''}
                    className={`${inputCls} w-full`}
                  />
                </Field>
                {/* Advance Notice — calendar days or working days (7daac043). Worded and positioned to match
                    the Calendar Days / Working Days choice Maximum Consecutive Leave already offers two cards
                    down, and REUSING ITS TWO OPTION LABELS verbatim so the same choice never reads as two
                    different ones on one screen.

                    INSIDE THIS SUB-FORM ON PURPOSE. It rides the `minAdvance=1` marker above, so the unit and
                    the figure it qualifies save together and no other card's save can touch either. The
                    option VALUES are literals: this is a client component and the leave pack's vocabulary is
                    server-side (ADR-0080), so the strings cross as data, never as an import.

                    Defaults to Calendar Days when the column is null — every leave type configured before
                    this shipped — so a save that does not touch this select re-writes the reading it already
                    had. A blank Minimum advance days clears both, which is why there is no "unset" option. */}
                <Field label={t('minAdvanceDayTypeLabel')}>
                  <select
                    name="minAdvanceDayType"
                    defaultValue={minAdvanceDayType ?? 'calendar_days'}
                    className={`${inputCls} w-full`}
                  >
                    <option value="calendar_days">{t('conditionStep.maxConsecutiveUnitCalendar')}</option>
                    <option value="working_days">{t('conditionStep.maxConsecutiveUnitWorking')}</option>
                  </select>
                </Field>
                {/* Custom validation messages (0147): optional HR-authored override for the advance-notice
                    block message. Lives in the SAME form as the rule so it saves atomically with
                    `minAdvance=1`. Blank = keep the built-in localized default. */}
                <Field label={t('customMessageLabel')}>
                  <textarea
                    name="customMessageMinAdvance"
                    maxLength={500}
                    rows={2}
                    defaultValue={customMessages?.minAdvanceDays ?? ''}
                    placeholder={t('customMessagePlaceholder')}
                    className={inputCls}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">{t('advanceCustomMessageHelp')}</p>
                <Button type="submit" size="sm">
                  {t('save')}
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">{t('advanceNoticeSectionHelp')}</p>
            </div>
          )}
          {/* ── Override Leave Application (feedback 56910869) ────────────────────────────────────────
              THE ONE PLACE HR DECIDES WHAT HAPPENS WHEN A RULE ABOVE IS NOT MET. It sits directly below
              Advance Notice and above Duplicate Leave Applications, where the reporter asked for it and
              where it reads correctly: the rules that can be missed come first, then what to do about it.

              One row per TRIGGER, each choosing an ACTION and carrying its own on/off switch — so one leave
              type can BOTH convert on short notice AND split on insufficient balance. Its own
              self-contained <form> + `overrideRules=1` tri-state marker, so an unrelated save never resets
              it, and the whole set is REPLACED on save (a partial write is how a rule HR believes they
              turned off stays on).

              NOT hidden for Emergency Leave, unlike Backdating and Advance Notice above: EL can legitimately
              carry a balance rule. The `Do nothing` action is what an unconfigured trigger reads as, and the
              engine refuses to convert EL to itself in any case.

              The option values are written out literally here, as the duplicate-policy card below does with
              its three: this is a client component and the leave pack's vocabulary module is server-side
              (ADR-0080), so the strings cross as data, never as an import. */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('overrideSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the override_rules column (tri-state guard) */}
              <input type="hidden" name="overrideRules" value="1" />
              {(
                [
                  { trigger: 'advance_notice_not_met', actions: ['convert_to_emergency', 'block'] },
                  { trigger: 'insufficient_balance', actions: ['split_unpaid', 'block'] },
                ] as const
              ).map((row) => {
                const stored = (overrideRules ?? []).find((r) => r.trigger === row.trigger);
                // A stored action outside this row's set renders as "Do nothing" rather than as a phantom
                // option — the same defensive reading normalizeLeaveOverrideRules takes on the server, so
                // the screen and the engine agree about what is configured.
                const actions: readonly string[] = row.actions;
                const currentAction = actions.includes(stored?.action ?? '') ? (stored!.action as string) : '';
                return (
                  <div key={row.trigger} className="space-y-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <Field label={t(`overrideTrigger.${row.trigger}`)}>
                      <select
                        name={`override_${row.trigger}`}
                        defaultValue={currentAction}
                        aria-label={t(`overrideTrigger.${row.trigger}`)}
                        className={`${inputCls} w-full`}
                      >
                        <option value="">{t('overrideActionNone')}</option>
                        {row.actions.map((a) => (
                          <option key={a} value={a}>
                            {t(`overrideAction.${a}`)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {/* DEFAULT OFF. An unticked box does not post, and the action reads absent as
                        enabled:false — the only reading that cannot turn a rule nobody enabled into
                        behaviour. Configuring a rule and enabling it are deliberately two acts. */}
                    <label className="flex items-start gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name={`overrideOn_${row.trigger}`}
                        defaultChecked={stored?.enabled === true}
                        className="mt-0.5 size-3.5 rounded border-border"
                      />
                      <span>{t('overrideEnabledLabel')}</span>
                    </label>
                  </div>
                );
              })}
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('overrideSectionHelp')}</p>
          </div>
          {/* Duplicate Leave Application Restriction (d5e51c34). Its own self-contained <form> + `duplicatePolicy=1`
              tri-state marker so an unrelated save never resets it. A 3-option radio controls whether an employee
              may submit more than one leave application overlapping the same date. Default 'allow' = today's
              behaviour; the two restrict modes enforce at submit + edit (core/leave.ts). */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('duplicatePolicySectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the duplicate_application_policy column (tri-state guard) */}
              <input type="hidden" name="duplicatePolicy" value="1" />
              {(() => {
                const current = ['allow', 'restrict_same', 'restrict_any'].includes(duplicateApplicationPolicy ?? '')
                  ? (duplicateApplicationPolicy as string)
                  : 'allow';
                return (
                  <div className="space-y-1.5">
                    {(['allow', 'restrict_same', 'restrict_any'] as const).map((opt) => (
                      <label key={opt} className="flex items-start gap-2 text-xs text-foreground">
                        <input
                          type="radio"
                          name="duplicatePolicyValue"
                          value={opt}
                          defaultChecked={current === opt}
                          className="mt-0.5 size-3.5 border-border"
                        />
                        <span>
                          {opt === 'allow'
                            ? t('duplicatePolicyAllow')
                            : opt === 'restrict_same'
                              ? t('duplicatePolicyRestrictSame')
                              : t('duplicatePolicyRestrictAny')}
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })()}
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('duplicatePolicyHelp')}</p>
          </div>
          {/* Day Type Inclusion (feedback ef6d7146 · moved into the Condition card by 123c1e76 — the Leave
              Calculation Rules card it was the sole occupant of is gone). Five independent toggles deciding
              which day types are counted when calculating a leave's duration. Its own self-contained <form> +
              `dayTypeInclusion=1` tri-state marker so an unrelated save never resets it; the counting rules
              themselves (core/leave.ts) are untouched by the move. */}
          <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">{t('dayTypeInclusion.sectionTitle')}</span>
              {!editingDayTypes && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditingDayTypes(true)}>
                  {t('eligibilityEdit')}
                </Button>
              )}
            </div>
            {editingDayTypes ? (
              <form
                action={updateTypeAction}
                className="space-y-2"
                onSubmit={() => setEditingDayTypes(false)}
              >
                <input type="hidden" name="id" value={id} />
                {/* preserve the name — this form does not edit it */}
                <input type="hidden" name="name" value={name} />
                {/* marker: tells the action to touch the day_type_inclusion column (tri-state guard) */}
                <input type="hidden" name="dayTypeInclusion" value="1" />
                <div className="flex flex-col gap-1.5">
                  {DAY_TYPE_INCLUSION_OPTIONS.map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        name={`dayType_${k}`}
                        defaultChecked={dayTypeInclusion?.[k] === true}
                        className="size-4 accent-primary"
                      />
                      {dayTypeLabel(k)}
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditingDayTypes(false)}>
                    {t('cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="rounded-lg border border-border px-3 py-2 text-xs text-foreground">
                {dayTypeInclusionSummary()}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('dayTypeInclusion.help')}</p>
            <p className="text-xs text-muted-foreground">{t('dayTypeInclusion.statutoryNote')}</p>
          </div>
          {/* 08bc6841: the relocated company-wide Half-Day Deduction card — see the halfDaySection prop. */}
          <div className="mb-3 break-inside-avoid">{halfDaySection}</div>
          </div>
          )}
          {/* c459bff9: the third sub-step (Expiry) is GONE — for every leave type, including the
              explanatory pointer Annual saw and the no-balance note Emergency saw. The age-from-earning
              expiry pair (leave_type.expiry_value / expiry_unit) and its overnight sweep were removed
              outright as an intentional reset; a replacement expiry framework is designed separately.
              Annual's carry-forward expiry is UNAFFECTED and still lives in General → Carry Forward
              Policy — it is a different clock over a different set of days. */}
            </CardContent>
          </Card>
          )}
          {activeStep === 'custom' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryCustom')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-custom-${id}`} className="space-y-3">
          {/* 4b0e76ae — THE LEAVE YEAR CONFIGURATION SECTION IS GONE FROM HERE, AND FROM EVERY LEAVE TYPE.
              1e4eb8af had moved the tenant-wide managed leave-year RECORDS in as the server-composed
              leaveYearSection slot; the reporter asked for the whole block removed — year list, Draft /
              Open / Closed badge, Open Leave Year Date, Employee Application Start Date, Advance Rules and
              the Start / Close / Reopen / Edit / Delete / Add buttons — so the slot, both dialogs, the four
              writing actions and the records themselves went with it.

              GENERATING A YEAR'S ENTITLEMENT DID NOT GO. That was the one thing this block did that nothing
              else could, and it now has its own page at /admin/leave/generate, shipped in the SAME release.
              Do not re-add a leave-year surface here: the redesigned Leave Year module owns that ground.

              THE PER-TYPE LEAVE YEAR TYPE OVERRIDE was already not here — 4d6eae7b moved it back into the
              General walk as sub-step 2, where the cycle is chosen before the earning and rounding rules
              that operate inside it, and it is still rendered in exactly ONE place. */}
          {/* Restructure (123c1e76): the former "Leave Information Display" card's sub-forms (view
              configuration, employee visibility, ESS placement) live INSIDE the Custom Settings card. */}
          {/* Consolidated Employee Leave View Configuration (2bc2f2a3): the 65dec703 checklist and the
              79011509 formula-explanation editor are MERGED into one sub-form — tick an item and its
              Description / Formula fields appear right beside it; one Save posts both markers. The
              standalone "Leave Entitlement Formula Management" section is retired (same storage, so all
              existing content carries over). See ViewConfigSection above for the full contract. */}
          <ViewConfigSection
            id={id}
            name={name}
            essViewConfig={essViewConfig}
            formulaExplanations={formulaExplanations}
            formulaTemplate={formulaTemplate}
            updateTypeAction={updateTypeAction}
          />
          {/* Leave Type Employee Visibility (7b11f1c1, simplified by 464b58e6). Its own self-contained
              sub-form (own tri-state) posts `visibility=1` — now ONE checkbox: may an employee apply for this
              leave type? Ticked ⇒ the type is offered on the employee's Request Leave screen and can be
              applied for; unticked ⇒ it is not offered and requestLeave rejects it server-side.

              THE "VISIBLE TO EMPLOYEE" CHECKBOX THAT STOOD HERE IS GONE, and its column is NOT. Hiding a
              leave type from the employee's Leave tab is still `visible_to_employee`, and it is still fully
              available — through the Employee Tab Placement control immediately below, whose "Hidden" option
              writes that very flag (resolvePlacement reads it first). The two controls were the SAME decision
              offered twice on one screen, which is what the reporter asked us to remove; the placement select
              is the survivor and is now the ONLY writer of the flag from this panel. Nothing already hidden
              changes. Do NOT re-add a second hidden control here, and do NOT reroute hidden through
              employee_can_apply — that would recreate the overlap in a new place.

              A statutory-entitlement type (role annual / sick / hospitalization / maternity / paternity, or
              the seeded code for an unclassified row) can never have applications blocked, so the checkbox is
              shown disabled + on with the reason beside it. A DISABLED CHECKBOX POSTS NOTHING, which is why
              the hidden twin below rides with it: without it the sub-form posted no `employeeCanApply` at all
              on exactly those types, the action read that absence as FALSE, and the service's statutory guard
              refused a save in which HR had changed nothing. null/default ⇒ can-apply (backward compatible). */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('visibility.sectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch employee_can_apply (tri-state guard). It no longer carries
                  visible_to_employee — the placement sub-form below is that column's single writer. */}
              <input type="hidden" name="visibility" value="1" />
              {/* The disabled control's stand-in: a locked switch must still POST its value (see above). */}
              {isStatutoryApply ? <input type="hidden" name="employeeCanApply" value="on" /> : null}
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="employeeCanApply"
                  defaultChecked={isStatutoryApply ? true : employeeCanApply !== false}
                  disabled={isStatutoryApply}
                  className="size-3.5 rounded border-border disabled:opacity-60"
                />
                {t('visibility.employeeCanApply')}
              </label>
              {isStatutoryApply ? (
                <p className="text-xs text-amber-600 dark:text-amber-500">{t('visibility.statutoryLocked')}</p>
              ) : null}
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('visibility.help')}</p>
          </div>
          {/* Leave grouping visibility (b653ac1b). Its own self-contained sub-form (own tri-state) posts
              `placement=1` — a single Primary / Secondary / Hidden select deciding WHERE this leave type sits
              on the employee's My Profile → Leave tab: a Primary card at the top, tucked into a Secondary
              group, or Hidden entirely. HIDDEN IS THE SINGLE VISIBILITY SWITCH (7b11f1c1): choosing Hidden
              sets visible_to_employee=false — there is no second hidden control, and since 464b58e6 this
              sub-form is that column's ONLY writer on the screen (the Employee Visibility sub-form above
              stopped posting it when its duplicate checkbox went). The current selection is
              resolved from the stored value, the visibility flag, and the code-keyed default so an unconfigured
              type shows its sensible starting point. Presentation only — no balances/entitlement change. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('placement.sectionTitle')}</span>
            <form action={updateTypeAction} className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch ess_placement + the shared visibility flag (tri-state guard) */}
              <input type="hidden" name="placement" value="1" />
              <Field label={t('placement.label')}>
                <select
                  name="placementValue"
                  defaultValue={resolvePlacement(code, essPlacement, visibleToEmployee, role)}
                  className={`${inputCls} w-40`}
                >
                  {ESS_PLACEMENTS.map((pl) => (
                    <option key={pl} value={pl}>
                      {t(`placement.option.${pl}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('placement.help')}</p>
          </div>
          {/* Feedback 9d8cf621 — custom apply-time message. Own sub-form + tri-state marker `applyNotice=1`.
              An "Enable custom message" checkbox reveals the textarea; unchecked ⇒ textarea hidden and an empty
              value posts ⇒ the applyNotice key clears (message disabled). Shown to employees on the apply form. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('applyNoticeSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the applyNotice custom-message key (tri-state guard) */}
              <input type="hidden" name="applyNotice" value="1" />
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="enableApplyNotice"
                  checked={applyNoticeEnabled}
                  onChange={(e) => setApplyNoticeEnabled(e.target.checked)}
                  className="size-3.5 rounded border-border"
                />
                {t('applyNoticeEnableLabel')}
              </label>
              {applyNoticeEnabled && (
                <textarea
                  name="customMessageApplyNotice"
                  maxLength={500}
                  rows={3}
                  defaultValue={customMessages?.applyNotice ?? ''}
                  placeholder={t('applyNoticePlaceholder')}
                  className={inputCls}
                />
              )}
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('applyNoticeHelp')}</p>
          </div>
          {/* Leave Type Visual Configuration Enhancement (639fdf77). Its own self-contained sub-form (own
              tri-state) posts `visual=1` — a searchable icon picker + a 7-token colour swatch, purely
              cosmetic (icon + colour beside the leave type on the employee My Profile → Leave tab). Nothing
              existing moves; both null ⇒ default styling (backward compatible). */}
          <LeaveVisualForm t={t} id={id} name={name} color={color} icon={icon} action={updateTypeAction} />
            </CardContent>
          </Card>
          )}
      </div>
    </div>
  );
}

// ─── Employee Leave View Configuration (65dec703 · 2bc2f2a3 · ed17a4f9) ────────────────────────────────────
//
// ONE sub-form owns both concerns the Custom step used to split across two sections: WHICH Leave Summary
// items an employee sees (ess_view_config, feedback 65dec703) and HOW each item is explained
// (formula_explanations, feedback 79011509 — the standalone "Leave Entitlement Formula Management" section is
// retired). Ticking an item reveals its Description / Formula Explanation fields inline; ONE Save posts BOTH
// tri-state markers (`essView=1` + `formula=1`) so selections and explanations persist together — same two
// storage targets as before, no content migration. Unticking an item HIDES its editor without unmounting it
// (the `hidden` attribute), so the concealed inputs still post and stored explanations survive an
// untick-then-save round-trip.
//
// ed17a4f9 SYNCHRONISED the list. The checklist is derived from ENTITLEMENT_PANEL_SECTIONS
// (ESS_VIEW_CHECKLIST_GROUPS), so it now lists exactly the nine lines of the redesigned Leave Summary in the
// summary's own order and nothing else. Every checkbox key IS the employee row's field key, so its
// explanation is stored under that same key and the employee hover icon finds it. The old special cases are
// gone with the sections they served: there is no Entitlement Calculation Breakdown group revealing seven
// legacy sub-editors, and the trailing "Other" group is empty (the builder drops it) because no key gates a
// non-panel surface any more. The "Result / Date (optional)" input is removed at the reporter's request.
//
// SMART CONTENT REUSE (ed17a4f9 §4). A tenant with 30–60 leave types had HR retyping the same nine
// explanations for each one. The Description / Formula Explanation boxes of a leave type that has NO saved
// configuration are pre-filled from the first leave type that does (`applyLeaveFormulaTemplate`, resolved on
// the server in app/admin/leave/entitlements). Three properties matter and all three are the reporter's own
// words: nothing is written until Save is pressed (these are form DEFAULTS — leaving the page stores
// nothing); a leave type that already has its own wording keeps it exactly; and the fill is per ITEM, so a
// partly-configured type is completed rather than overwritten.

/** The two inline explanation inputs for one Leave Summary item. Names follow the 79011509 FormData contract
 *  (`formula_<key>_description|formula`) so the existing action/service path persists them unchanged.
 *  `isTemplate` marks values that arrived from another leave type's configuration rather than this one's —
 *  the hint tells HR the wording is a suggestion they are free to edit, and that it is not stored yet. */
function ViewConfigExplanationFields({
  fieldKey,
  entry,
  isTemplate,
  t,
}: {
  fieldKey: string;
  entry: LeaveFormulaEntry | undefined | null;
  isTemplate?: boolean;
  /** The parent's admin.leave translator (labels live under `admin.leave.formula.*`). */
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-2">
      {isTemplate && <p className="text-[11px] text-muted-foreground">{t('formula.templateHint')}</p>}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t('formula.descriptionLabel')}
        <textarea
          name={`formula_${fieldKey}_description`}
          defaultValue={entry?.description ?? ''}
          rows={2}
          className={`${inputCls} text-xs`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t('formula.formulaLabel')}
        <textarea
          name={`formula_${fieldKey}_formula`}
          defaultValue={entry?.formula ?? ''}
          rows={2}
          className={`${inputCls} text-xs`}
        />
      </label>
    </div>
  );
}

function ViewConfigSection({
  id,
  name,
  essViewConfig,
  formulaExplanations,
  formulaTemplate,
  updateTypeAction,
}: {
  id: string;
  name: string;
  essViewConfig: Record<string, boolean> | null;
  formulaExplanations: Record<string, LeaveFormulaEntry> | null;
  /** Smart content reuse (ed17a4f9 §4): the wording of the first leave type that HAS a saved configuration,
   *  resolved server-side. Used only to PRE-FILL items this type has not configured; null ⇒ no template
   *  exists yet (this is the tenant's first configuration) and the boxes start empty as before. */
  formulaTemplate: Record<string, LeaveFormulaEntry> | null;
  updateTypeAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const tBreakdown = useTranslations('leave.breakdown');
  // Per item: this type's own wording where it has any, the template's where it does not. Nothing is written
  // by resolving this — these become the form's defaultValues and persist only on Save.
  const defaults = applyLeaveFormulaTemplate(formulaExplanations, formulaTemplate);
  // Client-island reveal state: checked ⇒ the item's inline explanation editor shows. Initialised from the
  // stored config (missing ⇒ visible/ticked, the 65dec703 backward-compatible default).
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      ESS_VIEW_CHECKLIST_GROUPS.flatMap((g) => g.keys).map((key) => [key, essViewConfig?.[key] !== false]),
    ),
  );
  const toggle = (key: string) => setChecked((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t('essView.sectionTitle')}</span>
      <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
        <input type="hidden" name="id" value={id} />
        {/* preserve the name — this form does not edit it */}
        <input type="hidden" name="name" value={name} />
        {/* markers: ONE submit touches BOTH columns — the checkboxes land on ess_view_config, the inline
            explanation fields on formula_explanations (each keeps its own tri-state guard in the action). */}
        <input type="hidden" name="essView" value="1" />
        <input type="hidden" name="formula" value="1" />
        <div className="space-y-3">
          {ESS_VIEW_CHECKLIST_GROUPS.map((group) => (
            <fieldset key={group.key} className="space-y-1.5">
              {/* Heading = the panel section's own title (leave.breakdown.section.*); the orphan group
                  uses the admin-side "Other" label. */}
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.labelKey ? tBreakdown(group.labelKey) : t('essView.groupOther')}
              </legend>
              {group.labelKey == null ? (
                // "Other" group: keys gating non-panel surfaces — no explanation render site, plain checkboxes.
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {group.keys.map((key) => (
                    <label key={key} className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name={`essView_${key}`}
                        checked={checked[key] ?? true}
                        onChange={() => toggle(key)}
                        className="size-3.5 rounded border-border"
                      />
                      {t(`essView.${key}`)}
                    </label>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {group.keys.map((key) => {
                    const on = checked[key] ?? true;
                    // Template-sourced ⇒ this type has no wording of its own for this item, so what is shown
                    // came from another leave type and is a suggestion until HR saves it.
                    const fromTemplate = !formulaExplanations?.[key] && defaults[key] != null;
                    return (
                      <div key={key} className="rounded-md border border-border px-2.5 py-1.5">
                        <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                          <input
                            type="checkbox"
                            name={`essView_${key}`}
                            checked={on}
                            onChange={() => toggle(key)}
                            className="size-3.5 rounded border-border"
                          />
                          {t(`essView.${key}`)}
                        </label>
                        {/* hidden (not unmounted) when unticked: the inputs still post, so an untick+save
                            never wipes the stored explanation. */}
                        <div hidden={!on} className="mt-2 border-t border-border pt-2">
                          <ViewConfigExplanationFields
                            fieldKey={key}
                            entry={defaults[key]}
                            isTemplate={fromTemplate}
                            t={t}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </fieldset>
          ))}
        </div>
        <Button type="submit" size="sm">
          {t('save')}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t('essView.help')}</p>
    </div>
  );
}
