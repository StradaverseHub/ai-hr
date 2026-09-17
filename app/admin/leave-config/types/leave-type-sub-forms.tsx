'use client';

import { useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
// core/leave-compute.ts is the RSC-SAFE half of the leave engine (it imports no db/postgres, see its
// header), which is why a client component may pull VALUES from it. The worked example below runs the
// real `applyRounding`: an administrator is shown what a rule produces BEFORE saving it, and a second
// implementation of the rule is a second thing that can disagree with the ledger.
import {
  applyRounding,
  checkRoundingBands,
  type LeaveRoundingMethod,
  type RoundingBand,
  type RoundingBandProblem,
} from '@/core/leave-compute';
import { ESS_VIEW_CHECKLIST_GROUPS } from '@/components/leave/entitlement-panel-config';
import { applyLeaveFormulaTemplate, type LeaveFormulaEntry } from '@/core/leave-formula';
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
import { Button, Field, inputCls } from '@/components/ui';

/**
 * a6fe37fc ROUND 2 — the stateful sub-forms of the NEW leave type screen
 * (`/admin/leave-config/types`), which is built ALONGSIDE `/admin/leave/entitlements` and replaces
 * nothing yet (docs/design/a6fe37fc-migration-order.md, Round 2).
 *
 * ⚠️ EVERY FORM HERE KEEPS ITS TRI-STATE MARKER AND ITS HIDDEN `name`, BYTE FOR BYTE.
 * `app/admin/actions.ts` decides which columns a save touches from those markers. A form that posts
 * `updateLeaveTypeAction` WITHOUT its marker does not fail — it saves, and WIPES the columns a
 * neighbouring form owns. Nothing type-checks that and no test can infer it, so the marker list of
 * IA §1.2 is walked form by form and each marker is named in a comment where it is rendered.
 * `test/leave-config-types-tabs.test.ts` pins that every one of them is still posted.
 *
 * ⚠️ NO SERVER ACTION CHANGED SIGNATURE AND NO NEW ACTION WAS WRITTEN. These forms post the EXISTING
 * `updateLeaveTypeAction` / `setLeaveTypeRulesAction`, with the existing field names.
 *
 * WHY THIS IS A COPY OF `components/leave-type-panel.tsx` RATHER THAN AN IMPORT FROM IT. That file is
 * DELETED in Round 5 (IA §2.0) together with the screen it draws; the new module cannot depend on a file
 * whose deletion is the point of the migration, and exporting its private sub-forms would have meant
 * EDITING the very file this round is forbidden to touch (five guards read it). The panel is untouched
 * and remains the working screen until Round 5 says otherwise; this is the rewrite that replaces it.
 */

/** #25 visibility: who may see + apply for this type. null = open to all. gender / maritalStatus are
 *  multi-select: a scalar (legacy single-select rows) OR an array (match ANY selected value).
 *  Declared here rather than imported from the panel for the deletion reason in the header. */
export type LeaveEligibilityRule = {
  gender?: string | string[];
  maritalStatus?: string | string[];
  minServiceMonths?: number;
  minServiceUnit?: 'months' | 'days';
  orgDivision?: string | string[];
  orgBranch?: string | string[];
  orgRegion?: string | string[];
  orgLine?: string | string[];
  orgSection?: string | string[];
  orgTeam?: string | string[];
  orgBase?: string | string[];
  employmentCategory?: string | string[];
};

/** The five consolidated settings, read from the leave TYPE (9816a5ad step 2, migration 0325 columns). */
export type LeaveTypeRules = {
  accrualMethod?: string | null;
  accrualDay?: number | null;
  /** The NOT-CONFIGURED marker, as an ISO STRING rather than the Date the column holds — a plain string
   *  is unambiguously serialisable across the server/client boundary. */
  accrualUnconfigured?: string | null;
  carryForwardEnabled?: boolean | null;
  carryForwardMax?: number | null;
  carryForwardPercent?: string | number | null;
  carryForwardExpiryMode?: 'date' | 'months' | null;
  carryForwardExpiryMonths?: number | null;
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  carryForwardIncludeEarned?: boolean | null;
  roundingMethod?: LeaveRoundingMethod | null;
  roundingThreshold?: string | number | null;
  roundingBands?: RoundingBand[] | null;
  maxBalanceDays?: number | null;
};

export type Action = (fd: FormData) => void | Promise<void>;

/** Normalize a scalar-or-array eligibility field to a list (mirrors core asList — kept local so this
 *  client component has no server import). */
export function asEligList(v: string | string[] | undefined): string[] {
  return v == null ? [] : (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

/* ── Rounding ──────────────────────────────────────────────────────────────────────────────────── */

const roundingMethodValue = (m?: LeaveRoundingMethod | null): LeaveRoundingMethod =>
  m === 'custom' ? 'custom' : 'none';

/** One month of a 14-day annual entitlement earned monthly (14 ÷ 12) — the reporter's own arithmetic. */
const ROUNDING_EXAMPLE_RAW = Math.round((14 / 12) * 100) / 100;

const bandText = (v: number) => formatDays(v);

/** The band editor holds figures as STRINGS deliberately: a controlled number input backed by a number
 *  cannot be typed into, because "0.7" passes through "0." and `Number('0.')` is 0. */
type BandRow = { to: string; result: string };

/** Row i's From is DERIVED — row 0 starts at 0.00, every later row where the row above stopped — so the
 *  table joins up by construction and an internal gap is unreachable from this screen. */
const fromText = (rows: BandRow[], i: number): string => (i === 0 ? bandText(0) : rows[i - 1].to);

const rowsFromStored = (bands: RoundingBand[] | null | undefined): BandRow[] =>
  (Array.isArray(bands) ? bands : [])
    .filter((b) => b != null && typeof b === 'object')
    .map((b) => ({ to: bandText(Number(b.to) || 0), result: bandText(Number(b.result) || 0) }));

/** A BLANK or half-typed cell becomes NaN — which `checkRoundingBands` calls a broken row — rather than
 *  `Number('')`'s silent 0, which would post a rule nobody typed. */
const bandNum = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));

const rowsToBands = (rows: BandRow[]): RoundingBand[] =>
  rows.map((r, i) => ({ from: bandNum(fromText(rows, i)), to: bandNum(r.to), result: bandNum(r.result) }));

/**
 * The Custom Rounding table. THE WARNINGS COME FROM THE SERVICE'S OWN VALIDATOR — `checkRoundingBands`
 * is the exact function `setLeaveTypeRules` calls before writing, so the administrator cannot see green
 * and get a rejection. The whole table posts through ONE hidden JSON field on the rounding form's
 * existing marker.
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

  const tidyCell =
    (i: number, field: 'to' | 'result') => (e: { currentTarget: { value: string } }) => {
      const next = normalizeDayText(e.currentTarget.value);
      if (next !== e.currentTarget.value) patch(i, field, next);
    };

  const addRow = () => setRows([...rows, { to: '', result: '' }]);

  return (
    <div className="space-y-2 rounded-lg border border-border p-2">
      {/* The ONE posted field: the whole table as JSON, on the rounding form's existing tri-state marker. */}
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
                  {/* DERIVED, not typed. `readOnly` rather than `disabled`: still reachable, still read
                      out, it simply has no answer of its own. No `name` — the table posts as JSON. */}
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

/* ── Earning method + rounding (TAB 3) ─────────────────────────────────────────────────────────── */

/** r299 (3de1453a) — `legacy` is the STORED legacy earned method (a stranded `earned_quarterly`) held as the
 *  select's own value on a type that is not Annual Leave, so it is re-posted verbatim until HR picks
 *  something else. It maps to no fixed engine value; `methodToStore` reads the stored one. */
type EarningChoice = '' | 'none' | 'monthly' | 'daily' | 'legacy';
/** A stored value outside this set (a legacy 'earned_quarterly', or anything a hand-crafted POST once
 *  put there) takes the READ-ONLY branch rather than being silently collapsed onto a choice nobody made —
 *  except, since r299, a legacy EARNED method on a type that is not Annual Leave (see `legacyReplaceable`). */
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

/**
 * r288 (686dc512) → r299 (3de1453a) — WHAT THIS FORM NEEDS TO KNOW ABOUT EARNED ACCRUAL, DECIDED ON THE SERVER.
 *
 * THE REPORTER'S RULE: "Only Annual Leave (*Annual Leave) is subject to the Earned Accrual concept. All other
 * leave types are managed based on entitlement and should not be included in the Earned Accrual process."
 *
 * r288 WARNED — and deliberately did not refuse — when an earned method sat on a code the sweep could not
 * reach ("a tenant may legitimately keep such a type for a non-accruing purpose"). The reporter's rule
 * REVERSES that: `setLeaveTypeRules` now refuses a change to an earned method on anything that is not Annual
 * Leave, and this form offers Monthly and Daily Accrual only while "This is our Annual Leave" is on. What
 * r288 got right survives: the facts are decided on the server by the engine's OWN predicate
 * (`isEarnedAccrualType`) and cross as plain data (test/server-client-boundary.test.ts), because a client
 * island may not import the engine module and a second statement of the rule here would drift from it.
 */
export type EarnedSweepFacts = {
  /** This leave type's own name, for the sentences that talk about it ("Medical Leave is entitlement-based"). */
  leaveTypeName: string;
  /**
   * Where "This is our Annual Leave" stands for THIS row, decided on the server:
   *  · `on`         — the row is recorded as Annual Leave (its role). The switch can be turned off.
   *  · `off`        — unclassified and not Annual Leave. The switch can be turned on, unless another active
   *                   type already is Annual Leave (`otherAnnualLeaveTypeNames`).
   *  · `by_code`    — unclassified but recognised as Annual Leave by its seeded code. Shown on, locked:
   *                   there is no role to clear.
   *  · `other_role` — recorded as a different kind of leave (Sick, Maternity…). Shown off, locked.
   */
  annualSwitch: 'on' | 'off' | 'by_code' | 'other_role';
  /** ⚠️ THE TENANT'S OWN NAMES for the OTHER active types that are Annual Leave, A–Z — never an English
   *  default. Non-empty ⇒ this type's switch cannot be turned on, and the sentence says which type is. */
  otherAnnualLeaveTypeNames: string[];
  /** The engine's earned-method family, verbatim. The value this form WOULD POST is tested against this
   *  list rather than against a second spelling of "earned" written in this file. */
  earnedMethods: string[];
};

/**
 * Earning Method + Rounding — IA §3.1 F9, moved to TAB 3 out of the old *General setting* step, because
 * it is the first half of "how many days" and the tables below it are the second.
 *
 * MARKERS: `earningRendered=1` (method, accrual day, rounding method, threshold AND bands are gated on
 * it inside ONE `...(earningRendered ? {} : {})` in the action) and `roundingMethodRendered=1` (the
 * inner marker that reads 'none' as an explicit CLEAR). Dropping either is a half-save.
 * r299: `annualLeaveRendered=1` + `isAnnualLeave` ('1' / '0'), posted ONLY while the Annual Leave switch is
 * editable — a locked switch posts no marker, so the role column is untouched.
 */
export function EarningMethodForm({
  t,
  rules,
  action,
  leaveTypeId,
  sweep,
}: {
  t: ReturnType<typeof useTranslations>;
  rules: LeaveTypeRules;
  action: Action;
  leaveTypeId: string;
  /** r288/r299 — see EarnedSweepFacts. Required, not optional: an editor that cannot answer "is this type
   *  Annual Leave" would offer Monthly Accrual on a type the service must refuse it for. */
  sweep: EarnedSweepFacts;
}) {
  const locale = useLocale();
  const switchLabelId = useId();
  const switchHelpId = useId();
  const storedMethod = rules.accrualMethod ?? '';
  const unknownStoredMethod = !isKnownEarningMethod(storedMethod);
  const unconfigured = rules.accrualUnconfigured != null;
  /**
   * r299 (3de1453a) — A LEGACY EARNED METHOD ON A TYPE THAT IS NOT ANNUAL LEAVE MUST BE REPLACEABLE HERE.
   *
   * The stranded note and Leave Balance Health both tell HR to change such a type's earning method to None.
   * On the read-only branch below there was nothing to change it WITH, so a type stored on `earned_quarterly`
   * (retired from the dropdown in bc36c768) could be told the fix and never apply it. On a type the SERVER
   * says is not Annual Leave (`annualSwitch` off / other_role), a stored method in the engine's earned family
   * that the dropdown cannot name renders on the select instead: held as `legacy` (re-posted verbatim, so a
   * rounding-only save rewrites nothing), with None beside it — the choice the note names. Everything else
   * about the read-only branch is unchanged, including Annual Leave on a legacy method (its method is valid
   * there and the sweep honours it) and any unknown value that is not an earned method.
   */
  const legacyReplaceable =
    unknownStoredMethod &&
    sweep.earnedMethods.includes(storedMethod) &&
    sweep.annualSwitch !== 'on' &&
    sweep.annualSwitch !== 'by_code';
  const legacyReadOnly = unknownStoredMethod && !legacyReplaceable;
  const [choice, setChoice] = useState<EarningChoice>(
    // An unconfigured type starts on the Not configured placeholder, exactly as the known branch does.
    legacyReplaceable && !unconfigured ? 'legacy' : earningChoiceOf(rules.accrualMethod ?? undefined, unconfigured),
  );
  const [accrualDay, setAccrualDay] = useState<string>(
    rules.accrualDay == null ? '' : String(rules.accrualDay),
  );
  const [rounding, setRounding] = useState<LeaveRoundingMethod>(roundingMethodValue(rules.roundingMethod));
  const [bandRows, setBandRows] = useState<BandRow[]>(() => rowsFromStored(rules.roundingBands));
  const showBands = rounding === 'custom';
  /**
   * r299 (3de1453a) — "THIS IS OUR ANNUAL LEAVE", LIVE.
   *
   * The switch and the method are ONE save (`setLeaveTypeRules` takes both and judges the method against
   * the role it writes), so turning the switch on offers Monthly and Daily Accrual immediately, before
   * anything is saved. `annualOn` starts from the server's state and is the only thing the options read.
   */
  const switchEditable =
    sweep.annualSwitch === 'on' || (sweep.annualSwitch === 'off' && sweep.otherAnnualLeaveTypeNames.length === 0);
  const [annualOn, setAnnualOn] = useState<boolean>(sweep.annualSwitch === 'on' || sweep.annualSwitch === 'by_code');
  /** The value the hidden `method` input posts on whichever branch is rendered — the literal that WOULD BE
   *  STORED, so a legacy `earned_quarterly` on the read-only branch is judged exactly like Monthly Accrual. */
  const methodToStore = legacyReadOnly || choice === 'legacy' ? storedMethod : earningMethodOf(choice);
  const methodIsEarned = sweep.earnedMethods.includes(methodToStore);
  /** Held ON exactly where the save would otherwise be refused: switching a recorded Annual Leave off while
   *  an earned method stays stored ("change its earning method first"), or switching off after choosing a
   *  NEW earned method on this form (an earned method may only be chosen on Annual Leave). A stranded
   *  method re-posted unchanged is neither, so it does not hold the switch. */
  const switchHeldByMethod =
    switchEditable && annualOn && methodIsEarned && (sweep.annualSwitch === 'on' || methodToStore !== storedMethod);
  /** A type that is not Annual Leave but still stores an earned method — only reachable from a value saved
   *  before this rule existed, because Monthly and Daily are not selectable here. It is NEVER rewritten: the
   *  hidden `method` re-posts it verbatim and the service accepts an unchanged value. */
  const stranded = !annualOn && methodIsEarned;
  const annualNames = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    sweep.otherAnnualLeaveTypeNames,
  );
  const switchHelp =
    sweep.annualSwitch === 'by_code'
      ? t('subStep.annualLeaveSwitchByCodeHelp')
      : sweep.annualSwitch === 'other_role'
        ? t('subStep.annualLeaveSwitchOtherRoleHelp')
        : annualOn
          ? t('subStep.annualLeaveSwitchOnHelp')
          : sweep.otherAnnualLeaveTypeNames.length > 0
            ? t('subStep.annualLeaveSwitchOtherHelp', { names: annualNames })
            : t('subStep.annualLeaveSwitchOffHelp');
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      {/* r299 — THE SWITCH'S OWN TRI-STATE MARKER, posted only while the switch is editable. The value rides a
          hidden input rather than a checkbox's presence: a control disabled while an earned method is chosen
          posts nothing, and "nothing" would read as OFF. */}
      {switchEditable && (
        <>
          <input type="hidden" name="annualLeaveRendered" value="1" />
          <input type="hidden" name="isAnnualLeave" value={annualOn ? '1' : '0'} />
        </>
      )}
      <div
        data-testid="annual-leave-switch"
        className={cn(
          'flex items-start gap-3 rounded-lg border p-3',
          annualOn ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/30',
        )}
      >
        <button
          type="button"
          role="switch"
          aria-checked={annualOn}
          aria-labelledby={switchLabelId}
          aria-describedby={switchHelpId}
          disabled={!switchEditable || switchHeldByMethod}
          onClick={() => setAnnualOn((on) => !on)}
          className={cn(
            'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            annualOn ? 'bg-primary' : 'bg-muted-foreground/30',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-4 rounded-full bg-background shadow transition-transform',
              annualOn ? 'translate-x-4' : 'translate-x-0.5',
            )}
          />
        </button>
        <div className="space-y-0.5">
          <span id={switchLabelId} className="text-sm font-medium text-foreground">
            {t('subStep.annualLeaveSwitchLabel')}
          </span>
          <p id={switchHelpId} className="text-xs text-muted-foreground">
            {switchHelp}
          </p>
          {switchHeldByMethod && (
            <p data-testid="annual-leave-switch-held" className="text-xs text-muted-foreground">
              {t('subStep.annualLeaveSwitchHeldHelp', {
                none: t('subStep.earningNone'),
                monthly: t('subStep.earningByMonth'),
                daily: t('subStep.earningDaily'),
              })}
            </p>
          )}
        </div>
      </div>
      {/* Tri-state marker: names the HALF of the rule row this form renders. The carry half is a separate
          form, and without this marker an earning-only save would clear its configuration. */}
      <input type="hidden" name="earningRendered" value="1" />
      {legacyReadOnly ? (
        <>
          {/* BELT AND BRACES: re-post a method this editor cannot render VERBATIM, so an unrelated save
              of the ROUNDING half is not a silent downgrade of the earning method to the lump path. */}
          <input type="hidden" name="method" value={storedMethod} />
          {/* A SPAN, not a read-only <input>: a disabled control still reads as a control, and would be
              the second element here carrying the earning-method label. */}
          <Field label={t('subStep.earningMethodLabel')}>
            <span className={cn(inputCls, 'w-72 bg-muted text-muted-foreground')}>{storedMethod}</span>
          </Field>
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.earningLegacyMethodNote')}</p>
        </>
      ) : (
        <>
          {/* the mapped engine value — the select speaks the reporter's vocabulary. r299: on a type that is
              not annual leave this re-posts a stored earned method VERBATIM until the administrator picks
              something else, which is how a stranded method is kept rather than rewritten. */}
          <input type="hidden" name="method" value={methodToStore} />
          <Field label={t('subStep.earningMethodLabel')}>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value as EarningChoice)}
              aria-label={t('subStep.earningMethodLabel')}
              className={`${inputCls} w-72`}
            >
              {/* The NOT-CONFIGURED placeholder, offered only while the type actually is. Not disabled:
                  someone who opens the dropdown and thinks better of it must be able to leave the type
                  unconfigured rather than be forced into a choice by the UI. */}
              {choice === '' && <option value="">{t('subStep.earningNotConfigured')}</option>}
              {/* r299 — the stored legacy earned method, named, on a type that is not Annual Leave. Listed so
                  the select shows what is stored; disabled like Monthly and Daily, because only Annual Leave
                  may choose an earned method — once HR moves off it, it is not offered back. */}
              {legacyReplaceable && (
                <option value="legacy" disabled={!annualOn}>
                  {storedMethod === 'earned_quarterly' ? t('earnedMethodQuarterly') : storedMethod}
                </option>
              )}
              <option value="none">{t('subStep.earningNone')}</option>
              {/* r299 — LISTED, and disabled unless the switch is on: the reporter's mockup greys them
                  rather than hiding them, so the administrator can see what the switch unlocks. */}
              <option value="monthly" disabled={!annualOn}>
                {t('subStep.earningByMonth')}
              </option>
              <option value="daily" disabled={!annualOn}>
                {t('subStep.earningDaily')}
              </option>
            </select>
          </Field>
          {choice === '' && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.earningNotConfiguredNote')}</p>
          )}
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
          {/* Daily Accrual applies rounding to the RUNNING TOTAL, so a table that rounds upward hands the
              employee a whole day from their first day. WARN rather than block — a combination that is
              wrong for most tenants is not necessarily wrong for all of them. */}
          {choice === 'daily' && rounding !== 'none' && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.dailyRoundingWarning')}</p>
          )}
        </>
      )}
      {/* r299 (3de1453a) — WHAT THE ADMINISTRATOR IS TOLD WHEN THIS IS NOT ANNUAL LEAVE. Rendered OUTSIDE the
          unknown/known branch so a legacy stored method is covered too, and LIVE on the switch.
            · stranded — an earned method is still stored on a type Earned Accrual does not cover. Nothing is
              rewritten; the note names the fix. Leave Balance Health raises the same fact as a finding.
            · otherwise — the reporter's own sentence from the mockup: this type is entitlement-based. */}
      {!annualOn &&
        (stranded ? (
          <p role="note" data-testid="earning-stranded" className="text-xs text-amber-600 dark:text-amber-400">
            {/* The option is named through its OWN label, so the note and the dropdown cannot disagree. */}
            {t('subStep.earningStrandedNote', { type: sweep.leaveTypeName, none: t('subStep.earningNone') })}
          </p>
        ) : (
          <p
            role="note"
            data-testid="earning-entitlement-based"
            className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
          >
            {t('subStep.earningEntitlementBasedNote', { type: sweep.leaveTypeName })}
          </p>
        ))}
      <p className="text-xs text-muted-foreground">{t('subStep.earningMappingHelp')}</p>
      {/* Rounding sits directly UNDER Earning Method and rides the same rule row: it tidies whatever the
          earning calculation produces, without changing the calculation. The SECOND tri-state marker. */}
      <input type="hidden" name="roundingMethodRendered" value="1" />
      <Field label={t('subStep.roundingMethodLabel')}>
        <select
          name="roundingMethod"
          value={rounding}
          onChange={(e) => setRounding(e.target.value as LeaveRoundingMethod)}
          aria-label={t('subStep.roundingMethodLabel')}
          className={cn(inputCls, 'w-72')}
        >
          <option value="none">{t('subStep.roundingNone')}</option>
          <option value="custom">{t('subStep.roundingCustom')}</option>
        </select>
      </Field>
      {showBands && <RoundingBandsEditor t={t} rows={bandRows} setRows={setBandRows} />}
      <p className="text-xs text-muted-foreground">{t('subStep.roundingHelp')}</p>
      {rounding !== 'none' && (
        <p className="text-xs text-muted-foreground">
          {t('subStep.roundingWorkedExample', {
            raw: formatDays(ROUNDING_EXAMPLE_RAW),
            rounded: formatDays(applyRounding(ROUNDING_EXAMPLE_RAW, rounding, null, rowsToBands(bandRows))),
          })}
        </p>
      )}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/* ── Carry forward (TAB 3) ─────────────────────────────────────────────────────────────────────── */

/** Leap-tolerant last-day-of-month, evaluated against a LEAP year (2024) so 29 Feb is allowed at config
 *  time (the server year-clamps it at resolve time). month is 1-based. */
const lastDayOfMonthLeapTolerant = (month: number) => new Date(Date.UTC(2024, month, 0)).getUTCDate();

/** The carry-forward expiry sub-fields — a mode toggle (concrete date vs "X months after year-end") with
 *  client-side inline validation of the month/day pair. The authoritative validation is core/admin.ts. */
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

/** The three Carry Forward shapes. 'percent' carries a share of the year-end balance; 'fixed_max' a flat
 *  number of days; 'none' forfeits everything at year end. */
type CarryMode = 'none' | 'fixed_max' | 'percent';

/**
 * Carry Forward — IA §3.1 F10, moved to TAB 3 out of *General setting* for the same reason as earning.
 * MARKER: `carryBlockRendered=1` — this form renders the CARRY half of the rule row; without it a
 * carry-only save would clear the method and the rounding.
 */
export function CarryPolicyForm({
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
  // An explicit flag wins; when it is absent a positive cap means carry is on. A stored percentage wins
  // the initial selection — a type configured as "carry 50%" must not open showing Fixed Maximum and
  // silently save that back.
  const pct = rules.carryForwardPercent ?? null;
  const initialMode: CarryMode =
    Number(pct ?? 0) > 0
      ? 'percent'
      : (rules.carryForwardEnabled ?? Number(rules.carryForwardMax ?? 0) > 0)
        ? 'fixed_max'
        : 'none';
  const [mode, setMode] = useState<CarryMode>(initialMode);
  const carryOn = mode !== 'none';
  const cap = rules.carryForwardMax ?? 0;
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      {/* Tri-state marker: the CARRY half. The earning half is a separate form. */}
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
                  defaultValue={formatDayInput(pct)}
                  onBlur={normalizeDayFieldOnBlur}
                  required
                  className={`${inputCls} w-24`}
                />
              </Field>
              {/* Percentage mode shows ONE number: the cap used to render beside it and core's Math.min
                  then silently trimmed the percentage to it. The explicit 0 is a CLEAR (the action reads
                  carryForwardMax as `num(...) ?? null`, which is not tri-state). */}
              <input type="hidden" name="carryForwardMax" value="0" />
            </>
          ) : (
            <>
              <Field label={t('carryCapLabel')}>
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
              {/* Fixed Maximum means no percentage: post an empty value so a stored one is CLEARED rather
                  than left behind to win the resolution silently. */}
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
        // The PERCENTAGE is cleared instead — carryEnabled() reads a stored percentage as "carry is on".
        <>
          <input type="hidden" name="carryForwardMax" value={cap} />
          <input type="hidden" name="carryForwardPercent" value="" />
          <input
            type="hidden"
            name="carryForwardExpiryMode"
            value={rules.carryForwardExpiryMode === 'months' ? 'months' : 'date'}
          />
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

/* ── Balance rules (TAB 3) ─────────────────────────────────────────────────────────────────────── */

/**
 * Negative balance + its floor — IA §3.1 F20, on TAB 3 because it is a BALANCE rule, not an application
 * rule. MARKER: `negativeBalance=1`. Both controls live in ONE form: the switch and the floor are one
 * decision, and splitting them would let a save of one silently clear the other.
 */
export function NegativeBalanceForm({
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
  /** Positive magnitude — 2.5 means the balance may not pass -2.5. NULL ⇒ unbounded. */
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
              // REQUIRED: "Yes with no figure" would mean "may go arbitrarily far below zero", which
              // nobody should be able to set by leaving a box empty.
              required
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
 * Balance Deduction Source — IA §3.1 F21, on TAB 3 for the same reason. MARKER: `balanceSource=1`.
 * The mode and the source live in ONE form so a "deduct from another type, but which?" half-state
 * cannot persist; the action derives the column from the pair.
 */
export function BalanceSourceForm({
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
    <div className="space-y-1.5">
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
              {/* Blank first: someone who switches to "another leave type" has not yet chosen one. */}
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

/* ── Application limits (TAB 4) ────────────────────────────────────────────────────────────────── */

/**
 * Maximum days per leave year + the period it is counted over — IA §3.1 F18, TAB 4.
 * MARKER: `applicationLimits=1`. Unlimited posts an EXPLICITLY EMPTY value, which the action reads as a
 * clear — blank-means-no-limit is invisible, so the choice is a radio pair.
 */
export function ApplicationLimitsForm({
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
  /** 'leave_year' | 'calendar_year' | 'employment'. NULL ⇒ leave year, what every type means today. */
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
              defaultValue={formatDayInput(maxDaysPerLeaveYear)}
              onBlur={normalizeDayFieldOnBlur}
              className={cn(inputCls, 'w-full')}
            />
          </Field>
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
        // Unlimited posts the field EXPLICITLY EMPTY rather than omitting it: the marker is present, so
        // an omitted field and a blank one would both have to mean something, and only one of them can.
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
 * Maximum consecutive days + its unit — IA §3.1 F19, TAB 4. A DIFFERENT rule from the year cap above,
 * with its OWN `maxConsecutive=1` marker: a shared marker would make saving one silently clear the other.
 */
export function MaxConsecutiveForm({
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
        // Unlimited posts the maximum EXPLICITLY EMPTY and forwards no unit: the action reads a blank
        // maximum as a clear of BOTH columns, which is the only state the DB's CHECK allows.
        <input type="hidden" name="maxConsecutiveDays" value="" />
      )}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/* ── Visual (TAB 1) ────────────────────────────────────────────────────────────────────────────── */

/**
 * Colour token + icon — IA §3.1 F32, TAB 1. MARKER: `visual=1`. Purely cosmetic: the picked icon and
 * colour only change how the type LOOKS on the employee Leave tab.
 */
export function LeaveVisualForm({
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

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">{t('visual.iconLabel')}</span>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('visual.searchPlaceholder')}
                aria-label={t('visual.searchPlaceholder')}
                className={`${inputCls} w-full pl-7`}
              />
            </div>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
              {PreviewIcon ? (
                <PreviewIcon className="size-4" aria-hidden />
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
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
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-foreground hover:bg-muted'
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

/* ── Employee leave view configuration + formula explanations (TAB 1) ──────────────────────────── */

/** The two inline explanation inputs for one Leave Summary item. Names follow the existing FormData
 *  contract (`formula_<key>_description|formula`) so the existing action/service path persists them. */
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

/**
 * Employee Leave View Configuration — IA §3.1 F30, TAB 1 — WITH the formula explanations (F31) that
 * share its form.
 *
 * ⚠️ TWO MARKERS, ONE SUBMIT: `essView=1` (the checklist → ess_view_config) and `formula=1` (the inline
 * wording → formula_explanations). They are ONE form because 2bc2f2a3 merged them deliberately: ticking
 * an item reveals its wording inline. IA §3.1 sends F31 to Tab 3 and F30 to Tab 1; splitting one form
 * across two tabs would mean two writers over one save, so the pair stays whole HERE and the deviation
 * is reported rather than silently taken.
 *
 * Unticking an item HIDES its editor without unmounting it (the `hidden` attribute), so the concealed
 * inputs still post and stored explanations survive an untick-then-save round trip.
 */
export function ViewConfigSection({
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
  /** The wording of the first leave type that HAS a saved configuration, resolved server-side. Used only
   *  to PRE-FILL items this type has not configured; null ⇒ the boxes start empty. */
  formulaTemplate: Record<string, LeaveFormulaEntry> | null;
  updateTypeAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const tBreakdown = useTranslations('leave.breakdown');
  // Per item: this type's own wording where it has any, the template's where it does not. Nothing is
  // written by resolving this — these become the form's defaultValues and persist only on Save.
  const defaults = applyLeaveFormulaTemplate(formulaExplanations, formulaTemplate);
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
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.labelKey ? tBreakdown(group.labelKey) : t('essView.groupOther')}
              </legend>
              {group.labelKey == null ? (
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
