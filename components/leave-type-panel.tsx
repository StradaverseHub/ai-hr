'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
// core/leave-compute.ts is the RSC-SAFE half of the leave engine (it imports no db/postgres, see its
// header), which is why a client component may pull VALUES from it. Feedback 9f5164d8's worked example runs
// the real `applyRounding` rather than a lookalike: an administrator is shown what a rule produces BEFORE
// saving it, and a second implementation of the rule is a second thing that can disagree with the ledger.
import {
  applyRounding,
  DEFAULT_ROUNDING_THRESHOLD,
  type LeaveRoundingMethod,
  type ServiceBand,
} from '@/core/leave-compute';
import { ORG_ASSIGNMENT_CRITERIA, type OrgAssignmentCriterionKey } from '@/core/leave-org-criteria';
import { ESS_VIEW_CHECKLIST_GROUPS } from '@/components/leave/entitlement-panel-config';
import { applyLeaveFormulaTemplate, type LeaveFormulaEntry } from '@/core/leave-formula';
import { resolvePlacement, ESS_PLACEMENTS } from '@/lib/leave-groups';
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
import {
  LeaveTypeEntitlementTable,
  ServiceEntitlementTable,
  type LeaveTypeSchemeEntitlement,
  type ServicePolicyRow,
  type ServiceSchemeRow,
} from './benefit-scheme-config';
import { SubStepBar } from './leave-sub-step-bar';

export type EntitlementPolicy = {
  id: string;
  annualDays: number;
  /** Leave Entitlement Rules Engine: optional service-length bands above annualDays. null/undefined = none
   *  (flat annualDays only). */
  serviceBands?: ServiceBand[] | null;
  carryForwardMax: number;
  /** ADR-0038 carry-forward expiry: month/day the carried-forward portion auto-forfeits; null = never. */
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  /** R4 Build #1: carry-expiry mode. 'date' (or null) = month/day; 'months' = "X months after year-end". */
  carryForwardExpiryMode?: 'date' | 'months' | null;
  /** R4 Build #1: X ∈ 1..12 for 'months' mode. null = unset. */
  carryForwardExpiryMonths?: number | null;
  /** Carry-forward enhancement: explicit on/off switch. null = unset ⇒ back-compat default (cap > 0). */
  carryForwardEnabled?: boolean | null;
  /** Carry-forward enhancement (config-only): include monthly-earned balance — persisted, engine deferred. */
  carryForwardIncludeEarned?: boolean | null;
  /** Accrual cadence (ADR-0040): 'earned_monthly' | 'earned_quarterly' earn through the year; anything
   *  else is a lump grant at hire / year-open. */
  method?: string;
  /** Feedback b81d3c52 — Rounding Method applied to the CALCULATED entitlement before it is credited.
   *  null/undefined = No Rounding (nothing is stored for a No-Rounding policy). */
  roundingMethod?: LeaveRoundingMethod | null;
  /** Grade this policy applies to (ADR-0041 2E); null = all grades (company default). */
  gradeId?: string | null;
  gradeName?: string | null;
  /** Company this policy applies to (ADR-0066); null = group default (all companies). */
  companyId?: string | null;
  companyName?: string | null;
  validFrom: string;
  validTo: string | null;
};

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

/** The checkbox options the eligibility rule form renders. Order matches the mockup. The marital list mirrors
 *  the shared master enum (core/profile.ts MARITAL_STATUSES, #12129e77) — client components can't import the
 *  server module, so it's duplicated here in the same order; keep the two in sync. */
const ELIGIBILITY_GENDER_OPTIONS = ['male', 'female'] as const;
const ELIGIBILITY_MARITAL_OPTIONS = ['single', 'married', 'divorced', 'widowed', 'separated', 'other'] as const;
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
 *  remaining content (the per-company entitlement policies timeline) moved to the Entitlement step's
 *  Service Based Entitlements sub-step. The keys are the SAME storage keys the pre-step accordion used ('ess' is
 *  Condition's historical key — kept deliberately so persisted state survives, see the leaveTypeCards
 *  migration in LeaveTypePanel).
 *
 *  1e4eb8af widened step 4: Custom Settings now opens with Leave Year Configuration — this type's Leave
 *  Year Type override (moved out of the General walk) plus the managed leave-year records (moved off the
 *  retired Application Rules tab, as the leaveYearSection slot). The step list itself is unchanged. */
const STEP_KEYS = ['general', 'ess', 'entitlement', 'custom'] as const;
type StepKey = (typeof STEP_KEYS)[number];
/** The storage key of the step b8fcae73 retired. Kept ONLY so a persisted leaveTypeCards:<id> payload that
 *  still points at it can be remapped to where its content went (Entitlement · Service Based Entitlements)
 *  instead of silently snapping back to step 1. It is never a StepKey and never renders. */
const RETIRED_ELIGIBILITY_STEP = 'eligibility';
/** Step → its admin.leave title key (the same category* keys the accordion cards used, all 6 locales). */
const STEP_TITLE_KEY: Record<StepKey, string> = {
  general: 'categoryGeneral',
  entitlement: 'categoryEntitlement',
  ess: 'categoryEssPolicy',
  custom: 'categoryCustom',
};

const isEarned = (m?: string) => m === 'earned_monthly' || m === 'earned_quarterly';
/** Normalise to a select value: earned methods pass through, everything else is the lump option. */
const methodValue = (m?: string) => (isEarned(m) ? m! : 'grant_on_hire_prorated');

/** Feedback b81d3c52 — normalise a stored Rounding Method to a select/hidden-input value. Nothing stored
 *  (the No-Rounding default, and every policy written before this feature) ⇒ 'none'. The action maps
 *  'none' straight back to "store nothing", so a round-trip through any form is a no-op on the JSONB.
 *  9f5164d8 added 'nearest_half' to the recognised set. */
const roundingMethodValue = (m?: LeaveRoundingMethod | null): LeaveRoundingMethod =>
  m === 'up' || m === 'down' || m === 'nearest_half' ? m : 'none';

/** Feedback 9f5164d8 — format a threshold for the editor's number inputs at the three decimal places the
 *  reporter's own table uses. Mirrors DEFAULT_ROUNDING_THRESHOLD when nothing is stored. */
const thresholdText = (v: number) => v.toFixed(3);

/** A finite number or null — postgres numerics reach the client as strings. */
const numOrNullFinite = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The figure the rounding worked example is computed against: one month of a 14-day annual entitlement
 *  earned monthly (14 ÷ 12 = 1.1666…), which is the reporter's own arithmetic in item 4d6eae7b and the
 *  case that made blunt whole-day rounding unsatisfactory in the first place. */
const ROUNDING_EXAMPLE_RAW = Math.round((14 / 12) * 100) / 100;

/**
 * Feedback 9f5164d8 — the "Custom decimal thresholds" editor, exactly the two-row table the reporter drew,
 * driven by ONE stored number.
 *
 * WHY ONE NUMBER AND NOT FOUR. The request lists four validation rules — values within 0.000–1.000, ranges
 * covering the whole interval, no overlap, no gaps — and every one of them is a statement that the two
 * ranges meet at a single point and stop at the two fixed ends. Storing four independent figures would make
 * all four rules violable and then need all four checks; storing the BOUNDARY makes them true by
 * construction. So the table renders four cells, of which the two ends are fixed (0.000 and 1.000) and the
 * two middle ones are the same value: typing in either moves the boundary and the other follows
 * immediately, which is also the clearest way to show that they are one decision.
 *
 * The single editable value is posted as `roundingThreshold`; the fixed ends are never posted at all.
 *
 * THE VALUE IS HELD AS A STRING, deliberately. A controlled number input backed by a number cannot be
 * typed into: "0.7" passes through "0." on the way, `Number('0.')` is 0, and the field snaps back to
 * "0.000" before the second digit arrives. Keeping the raw text lets an administrator type; the SERVER
 * decides whether what they typed is legal, with a named error, which is where that decision belongs.
 */
function RoundingThresholdEditor({
  t,
  value,
  onChange,
}: {
  t: ReturnType<typeof useTranslations>;
  value: string;
  onChange: (v: string) => void;
}) {
  const cell = 'px-1.5 py-1';
  const readOnlyCls = 'w-24 cursor-not-allowed opacity-70';
  const boundary = (
    <input
      type="number"
      min="0.001"
      max="1"
      step="0.001"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(inputCls, 'w-24')}
      aria-label={t('subStep.roundingThresholdsTitle')}
    />
  );
  return (
    <div className="space-y-2 rounded-lg border border-border p-2">
      {/* The ONE posted field. Rendered once, outside both rows, so there is no doubt which cell is stored. */}
      <input type="hidden" name="roundingThreshold" value={value} />
      <span className="text-xs font-medium text-muted-foreground">{t('subStep.roundingThresholdsTitle')}</span>
      {/* Two tables, each with its own header, because the request's two ranges close differently: the
          round-DOWN range is exclusive at its top, the round-UP range is inclusive at its top. Collapsing
          them into one table would have to pick one heading and misstate the other. */}
      <div className="space-y-2 overflow-x-auto">
        <div>
          <span className="text-xs text-muted-foreground">{t('subStep.roundingDownRangeLabel')}</span>
          <table className="w-full min-w-[20rem] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className={`${cell} font-medium`}>{t('subStep.roundingFromInclusive')}</th>
                <th className={`${cell} font-medium`}>{t('subStep.roundingToExclusive')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={cell}>
                  <input type="text" readOnly value={thresholdText(0)} className={cn(inputCls, readOnlyCls)} tabIndex={-1} />
                </td>
                <td className={cell}>{boundary}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">{t('subStep.roundingUpRangeLabel')}</span>
          <table className="w-full min-w-[20rem] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className={`${cell} font-medium`}>{t('subStep.roundingFromInclusive')}</th>
                <th className={`${cell} font-medium`}>{t('subStep.roundingToInclusive')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={cell}>{boundary}</td>
                <td className={cell}>
                  <input type="text" readOnly value={thresholdText(1)} className={cn(inputCls, readOnlyCls)} tabIndex={-1} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('subStep.roundingThresholdHelp')}</p>
    </div>
  );
}

/** General step sub-flow (e1a51aea, shortened by 1e4eb8af, RESTORED to five by 4d6eae7b): the five
 *  sub-steps of step 1, in the reporter's stated walk order — 1 Details, 2 Leave Year Type, 3 Earning
 *  Method, 4 Carry Forward Policy, 5 Approval Workflow. The keys are storage keys (persisted as
 *  `generalSubStep` in the leaveTypeCards:<id> localStorage shape, next to activeStep) — 'workflow' is
 *  deliberately NOT named after the retired accordion card keys (approval/display/calculation), which must
 *  never reappear in this file (see leave-type-config-categories.test.ts).
 *
 *  WHY 'yearType' IS BACK, HAVING BEEN REMOVED. 1e4eb8af dropped it and moved the control into Custom
 *  Settings, on the reasoning that every leave-year decision should be made in one place. Feedback
 *  4d6eae7b reverses that for the TYPE-LEVEL choice specifically, and gives the reason: "The Leave Year
 *  Type determines the leave cycle, while the Earning Method and Rounding Method determine how leave is
 *  credited within that cycle." The cycle is decided BEFORE the rules that operate inside it, so it reads
 *  in the order the decisions are actually made. This is presentation only — the same `yearCycle=1`
 *  tri-state marker, the same `updateTypeAction`, the same `year_cycle_override` column.
 *
 *  WHAT DID NOT MOVE BACK: the tenant-wide MANAGED LEAVE-YEAR RECORDS (the `leaveYearSection` slot) stay
 *  in Custom Settings. They are not a property of this leave type — they are tenant-wide rows carrying an
 *  "applies company-wide" badge — so putting them inside a per-type walk would say something untrue about
 *  their scope. Only the per-type override moved.
 *
 *  A persisted payload pointing at 'yearType' from before 1e4eb8af now resolves again rather than falling
 *  back to Details; the hydration guard restores any key present in this list. */
const GENERAL_SUB_STEP_KEYS = ['details', 'yearType', 'earning', 'carry', 'workflow'] as const;
type GeneralSubStepKey = (typeof GENERAL_SUB_STEP_KEYS)[number];
/** Sub-step → its admin.leave title key (all 6 locales). */
const GENERAL_SUB_STEP_TITLE_KEY: Record<GeneralSubStepKey, string> = {
  details: 'subStep.details',
  yearType: 'subStep.yearType',
  earning: 'subStep.earning',
  carry: 'subStep.carry',
  workflow: 'subStep.workflow',
};

/** Condition step sub-flow (08bc6841): the three sub-steps of step 4, in walk order — 1 Criteria (who
 *  qualifies: the eligibility rules moved from the Eligibility step), 2 Leave Application Rules (the seven
 *  existing rule groups as a card grid + the relocated company-wide Half-Day Deduction), 3 Expiry (the
 *  age-from-earning expiry moved from Eligibility; Annual points at the General carry-forward flow).
 *  Keys are storage keys (persisted as `essSubStep` in the leaveTypeCards:<id> localStorage shape, next to
 *  activeStep / generalSubStep — the e1a51aea shape extended backward-compatibly). The step's OWN storage
 *  key stays 'ess' (Condition's historical accordion key — see STEP_KEYS). Rendered by the SAME reusable
 *  SubStepBar the General flow introduced (components/leave-sub-step-bar.tsx — the reuse contract). */
const ESS_SUB_STEP_KEYS = ['criteria', 'rules', 'expiry'] as const;
type EssSubStepKey = (typeof ESS_SUB_STEP_KEYS)[number];
/** Sub-step → its admin.leave title key (all 6 locales). */
const ESS_SUB_STEP_TITLE_KEY: Record<EssSubStepKey, string> = {
  criteria: 'conditionStep.criteria',
  rules: 'conditionStep.rules',
  expiry: 'conditionStep.expiry',
};

/** Entitlement step sub-flow (7b945408, extended by b8fcae73, shortened again by bc9be1e8 + 0d9cf710):
 *  the THREE sub-steps of step 3, in walk order — 1 Benefit Schemes
 *  (who receives which scheme: the Grades catalogue relocated from the page bottom + the type-scoped scheme
 *  management, so the grade → grade-group → scheme relationship reads in one place), 2 Service Based
 *  Entitlements (how entitlement is calculated: the company-driven grade table, the per-company entitlement
 *  policies timeline and the Preview Scenario checker), 3 Adjustments (what manual adjustments apply: the
 *  One-Off/Festive grant tool + the Run Accrual action relocated from the page header — it processes earned
 *  entitlement, so it belongs with entitlement adjustments). Keys are storage keys (persisted as
 *  `entitlementSubStep` in the leaveTypeCards:<id> localStorage shape, next to activeStep / generalSubStep /
 *  essSubStep — the e1a51aea shape extended backward-compatibly). Rendered by the SAME reusable SubStepBar
 *  the General flow introduced (components/leave-sub-step-bar.tsx — the reuse contract). */
const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'adjustments'] as const;
type EntitlementSubStepKey = (typeof ENTITLEMENT_SUB_STEP_KEYS)[number];
/** The storage key of the sub-step bc9be1e8 retired (Company Entitlements). Kept ONLY so a persisted
 *  leaveTypeCards:<id> payload that still points at it lands where its content went — Service Based
 *  Entitlements — instead of silently snapping back to sub-step 1. Never an EntitlementSubStepKey. */
const RETIRED_COMPANY_ENTITLEMENTS_SUB_STEP = 'policies';
/** Sub-step → its admin.leave title key (all 6 locales). */
const ENTITLEMENT_SUB_STEP_TITLE_KEY: Record<EntitlementSubStepKey, string> = {
  schemes: 'entitlementStep.schemes',
  service: 'entitlementStep.service',
  adjustments: 'entitlementStep.adjustments',
};

type Action = (fd: FormData) => void | Promise<void>;

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  muted:
    'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

const fmt = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(1));

/** Carry-forward enhancement: resolve the enable checkbox's default — the explicit flag when set, else
 *  the back-compat default (carry is on iff the cap is positive). Mirrors `carryEnabled` in core/leave. */
const carryRuleEnabled = (p: { carryForwardEnabled?: boolean | null; carryForwardMax: number }) =>
  typeof p.carryForwardEnabled === 'boolean' ? p.carryForwardEnabled : p.carryForwardMax > 0;

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

// ── General-step front doors (feedback e1a51aea) ──────────────────────────────────────────────────────
// The Earning Method + Carry Forward Policy sub-steps are FRONT DOORS to the per-policy fields that
// already exist under Eligibility: they read the CURRENT active policy row and, on save, post the SAME
// updateLeavePolicyAction the policy edit form posts — no new storage, the effective-dated policy row
// stays the single source of truth (the plan's "existing per-policy controls remain the underlying
// truth"). Because that action rebuilds the policy's accrual JSONB wholesale from the posted fields, each
// front door must re-post every field it is NOT editing as hidden inputs (id / annualDays / validFrom /
// gradeId / companyId + the full carry block), or an earning-only save would silently wipe the carry
// config (and vice versa). Service bands are deliberately NOT posted — omitting the serviceBandsRendered
// marker preserves them (the tri-state in app/admin/actions.ts serviceBandsField).

/** The active (open-ended) policy rows — the ones a front door may edit. */
const activePoliciesOf = (policies: EntitlementPolicy[]) => policies.filter((p) => !p.validTo);

/** Human label for one active policy row in the front-door scope picker (company · grade · from date). */
function frontDoorScopeLabel(t: ReturnType<typeof useTranslations>, p: EntitlementPolicy): string {
  const company = p.companyId && p.companyName ? p.companyName : t('policyCompanyGroupDefault');
  const grade = p.gradeId && p.gradeName ? p.gradeName : t('gradeAll');
  return `${company} · ${grade} · ${t('validFrom', { from: p.validFrom })}`;
}

/** The hidden inputs BOTH front doors post to preserve the policy's identity + non-edited flat fields.
 *  9b0503ac: `leaveTypeId` (the hosting panel's type) rides along so the action's success redirect can
 *  anchor back to this exact type's panel (#type-<id>) instead of bouncing off the page. */
function FrontDoorIdentityFields({ p, leaveTypeId }: { p: EntitlementPolicy; leaveTypeId: string }) {
  return (
    <>
      <input type="hidden" name="id" value={p.id} />
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      <input type="hidden" name="annualDays" value={p.annualDays} />
      <input type="hidden" name="validFrom" value={p.validFrom} />
      <input type="hidden" name="gradeId" value={p.gradeId ?? ''} />
      <input type="hidden" name="companyId" value={p.companyId ?? ''} />
    </>
  );
}

/** The hidden inputs the EARNING front door posts to preserve the policy's stored carry block untouched
 *  (annual types; a non-annual policy mirrors the edit form's `carryForwardMax=0`). carryFlagField reads
 *  `=== 'on'`, so an enabled flag is re-posted as a hidden value="on" input and a disabled one is simply
 *  not rendered (marker present ⇒ absent reads as false, i.e. the stored value). */
function FrontDoorPreservedCarry({ p, isAnnual }: { p: EntitlementPolicy; isAnnual: boolean }) {
  if (!isAnnual) return <input type="hidden" name="carryForwardMax" value="0" />;
  const mode = p.carryForwardExpiryMode === 'months' ? 'months' : 'date';
  return (
    <>
      <input type="hidden" name="carryBlockRendered" value="1" />
      {carryRuleEnabled(p) && <input type="hidden" name="carryForwardEnabled" value="on" />}
      {!!p.carryForwardIncludeEarned && <input type="hidden" name="carryForwardIncludeEarned" value="on" />}
      <input type="hidden" name="carryForwardMax" value={p.carryForwardMax} />
      <input type="hidden" name="carryForwardExpiryMode" value={mode} />
      {mode === 'months' ? (
        <input type="hidden" name="carryForwardExpiryMonths" value={p.carryForwardExpiryMonths ?? ''} />
      ) : (
        <>
          <input type="hidden" name="carryForwardExpiryMonth" value={p.carryForwardExpiryMonth ?? ''} />
          <input type="hidden" name="carryForwardExpiryDay" value={p.carryForwardExpiryDay ?? ''} />
        </>
      )}
    </>
  );
}

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
 */
type EarningChoice = 'none' | 'by_month' | 'by_year' | 'by_quarter';
const earningChoiceOf = (m?: string): EarningChoice =>
  m === 'earned_monthly' ? 'by_month' : m === 'earned_quarterly' ? 'by_quarter' : 'none';
const earningMethodOf = (c: EarningChoice): string =>
  c === 'by_month' ? 'earned_monthly' : c === 'by_quarter' ? 'earned_quarterly' : 'grant_on_hire_prorated';

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
  const [choice, setChoice] = useState<EarningChoice>(earningChoiceOf(rules.accrualMethod ?? undefined));
  // Feedback 9f5164d8 — the rounding half of this form is now three linked controls (method, a customize
  // toggle, and the threshold), so it needs local state where a single uncontrolled <select> sufficed.
  const [rounding, setRounding] = useState<LeaveRoundingMethod>(roundingMethodValue(rules.roundingMethod));
  // Ticked iff a threshold is actually stored. A type on the standard rule stores nothing, so the box opens
  // unticked exactly as the request specifies — and unticking it POSTS a blank threshold, i.e. an explicit
  // "use the standard rule", rather than leaving a stale custom value behind the unticked box.
  const storedThreshold = numOrNullFinite(rules.roundingThreshold);
  const [custom, setCustom] = useState<boolean>(storedThreshold != null);
  const [threshold, setThreshold] = useState<string>(thresholdText(storedThreshold ?? DEFAULT_ROUNDING_THRESHOLD));
  const showThresholds = rounding === 'nearest_half';
  // The worked example needs a NUMBER. A half-typed value (or a cleared field) falls back to the standard
  // rule for the preview only — the posted string is untouched, so the server still sees and judges exactly
  // what was typed.
  const effectiveThreshold =
    showThresholds && custom ? (numOrNullFinite(threshold) ?? DEFAULT_ROUNDING_THRESHOLD) : DEFAULT_ROUNDING_THRESHOLD;
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      {/* Tri-state marker: names the HALF of the rule row this form renders. The carry half is a separate
          form, and without this marker an earning-only save would clear its configuration. */}
      <input type="hidden" name="earningRendered" value="1" />
      {/* the mapped engine value — the select below speaks the reporter's vocabulary */}
      <input type="hidden" name="method" value={earningMethodOf(choice)} />
      <Field label={t('subStep.earningMethodLabel')}>
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value as EarningChoice)}
          aria-label={t('subStep.earningMethodLabel')}
          className={`${inputCls} w-72`}
        >
          <option value="none">{t('subStep.earningNone')}</option>
          <option value="by_month">{t('subStep.earningByMonth')}</option>
          <option value="by_year">{t('subStep.earningByYear')}</option>
          {/* round-trip only: surfaced when the policy already stores quarterly earning */}
          {earningChoiceOf(rules.accrualMethod ?? undefined) === 'by_quarter' && (
            <option value="by_quarter">{t('methodEarnedQuarterly')}</option>
          )}
          {/* disabled pending engine work — no resignation-earning semantics exist yet. f3a64d90 retired the
              shared pendingEngineNote (it also named Anniversary to Calendar, now live) for a dedicated key
              that speaks only about Earn Upon Resignation. */}
          <option value="resignation" disabled title={t('subStep.resignationPendingNote')}>
            {t('subStep.earningResignation')}
          </option>
        </select>
      </Field>
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
          <option value="none">{t('subStep.roundingNone')}</option>
          {/* Feedback 9f5164d8 — the fourth option, listed in the reporter's own order (it sits between
              "no rounding" and the two whole-day options because it is the least aggressive of the three
              that actually change a figure). The other three are UNCHANGED in both value and behaviour. */}
          <option value="nearest_half">{t('subStep.roundingNearestHalf')}</option>
          <option value="up">{t('subStep.roundingUp')}</option>
          <option value="down">{t('subStep.roundingDown')}</option>
        </select>
      </Field>
      {/* The checkbox and the threshold table appear ONLY under "Nearest 0.5 day" — the request is explicit
          that they belong to that method. When another method is selected no `roundingThreshold` field is
          rendered at all, which the action reads as a clear: a threshold is part of the nearest-half
          configuration, not a setting that outlives it. */}
      {showThresholds && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={custom}
              onChange={(e) => setCustom(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            {t('subStep.roundingCustomize')}
          </label>
          {custom && <RoundingThresholdEditor t={t} value={threshold} onChange={setThreshold} />}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('subStep.roundingHelp')}</p>
      {/* A worked example against a real figure, computed with the SAME evaluator the engines use, so what
          the administrator is shown before saving cannot disagree with what is credited afterwards. */}
      {rounding !== 'none' && (
        <p className="text-xs text-muted-foreground">
          {t('subStep.roundingWorkedExample', {
            raw: ROUNDING_EXAMPLE_RAW.toFixed(2),
            rounded: applyRounding(ROUNDING_EXAMPLE_RAW, rounding, effectiveThreshold).toFixed(2),
          })}
        </p>
      )}
      {/* Integration r66: b81d3c52 was cut against main and still referenced the shared
          `pendingEngineNote`, which eee43966/f3a64d90 retired in favour of the dedicated
          `resignationPendingNote` (the old key also named Anniversary to Calendar, now live). */}
      <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.resignationPendingNote')}</p>
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/** Carry Forward Policy sub-step (e1a51aea): a front door to the active policy's carry fields — None
 *  (carry disabled) or Fixed Max (enable + X-days cap + the existing CarryExpiryFields days/months
 *  mode switch). The stored cap/expiry survive a "None" save (only the enable flag turns off). */
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
  const [carryOn, setCarryOn] = useState<boolean>(rules.carryForwardEnabled ?? Number(rules.carryForwardMax ?? 0) > 0);
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
          value={carryOn ? 'fixed_max' : 'none'}
          onChange={(e) => setCarryOn(e.target.value === 'fixed_max')}
          aria-label={t('subStep.carryPolicyLabel')}
          className={`${inputCls} w-56`}
        >
          <option value="none">{t('subStep.carryNone')}</option>
          <option value="fixed_max">{t('subStep.carryFixedMax')}</option>
        </select>
      </Field>
      {carryOn ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('carryCapLabel')}>
            <input name="carryForwardMax" type="number" min="0" step="0.5" defaultValue={cap} className={`${inputCls} w-24`} />
          </Field>
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
        <>
          <input type="hidden" name="carryForwardMax" value={cap} />
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
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  id: string;
  name: string;
  maxDaysPerLeaveYear: number | null;
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
        <Field label={t('conditionStep.applicationLimitMaxLabel')}>
          <input
            name="maxDaysPerLeaveYear"
            type="number"
            min="0.5"
            step="0.5"
            defaultValue={maxDaysPerLeaveYear ?? ''}
            className={cn(inputCls, 'w-full')}
          />
        </Field>
      ) : (
        // Unlimited posts the field EXPLICITLY EMPTY rather than omitting it: the marker is present, so an
        // omitted field and a blank one would both have to mean something, and only one of them can. Blank
        // is the clear.
        <input type="hidden" name="maxDaysPerLeaveYear" value="" />
      )}
      <Button type="submit" size="sm">
        {t('save')}
      </Button>
    </form>
  );
}

/** Shared shell for the two policy front doors: resolves the active policy rows, offers a scope picker
 *  when more than one is active, and renders the given form for the selected row (keyed by policy id so
 *  its local state re-seeds when HR switches scope). */
function PolicyFrontDoor({
  t,
  policies,
  renderForm,
}: {
  t: ReturnType<typeof useTranslations>;
  policies: EntitlementPolicy[];
  renderForm: (p: EntitlementPolicy) => ReactNode;
}) {
  const active = activePoliciesOf(policies);
  const [polId, setPolId] = useState<string>(active[0]?.id ?? '');
  const selected = active.find((x) => x.id === polId) ?? active[0];
  if (!selected) {
    return <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">{t('subStep.noActivePolicy')}</p>;
  }
  return (
    <div className="space-y-2">
      {active.length > 1 && (
        <Field label={t('subStep.frontDoorScopeLabel')}>
          <select
            value={selected.id}
            onChange={(e) => setPolId(e.target.value)}
            aria-label={t('subStep.frontDoorScopeLabel')}
            className={`${inputCls} w-full max-w-md`}
          >
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {frontDoorScopeLabel(t, p)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div key={selected.id}>{renderForm(selected)}</div>
    </div>
  );
}

/**
 * fa3f4ccb — ServiceBandEditor (the service-length band sub-editor, with its BandRow per-range columns)
 * has been REMOVED along with the Company Entitlements band surface it was the only mount for. Service-
 * length steps are configured per benefit scheme in Service Based Entitlements, whose band days already
 * supersede this row's days; a second band table here answered the same question twice.
 *
 * The DATA is untouched: `accrual.serviceBands` still exists on every leave_policy row that has it, the
 * resolver still band-resolves those days (bandDaysFor / resolveGradePolicy), and the forms deliberately
 * post no `serviceBandsRendered` marker so serviceBandsField preserves them. app/admin/actions.ts keeps
 * serviceBandsField for exactly that reason — it is the PRESERVE half of the tri-state, not dead code.
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
 * One leave type as an expandable row. The body manages that type's own effective-dated
 * entitlement policies (add / correct / remove) so there's no separate, disconnected policy
 * form — the two tables stay split underneath, but the editing surface is unified.
 */
/**
 * The five consolidated settings, read from the leave TYPE (9816a5ad step 2, migration 0325 columns).
 * Shaped to overlap `EntitlementPolicy` field-for-field so the Earning Method and Carry Forward forms —
 * which already render exactly these controls — can be pointed at it without being rewritten.
 */
export type LeaveTypeRules = {
  accrualMethod?: string | null;
  carryForwardEnabled?: boolean | null;
  carryForwardMax?: number | null;
  carryForwardExpiryMode?: 'date' | 'months' | null;
  carryForwardExpiryMonths?: number | null;
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  carryForwardIncludeEarned?: boolean | null;
  roundingMethod?: LeaveRoundingMethod | null;
  /** Feedback 9f5164d8 — the custom decimal threshold. Postgres numeric ⇒ may arrive as a string. */
  roundingThreshold?: string | number | null;
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
  isAnnual,
  floor0,
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
  minAdvanceDays,
  expiryValue,
  expiryUnit,
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
  counting,
  perDateApproval,
  duplicateApplicationPolicy,
  allowNegativeBalance,
  balanceSourceTypeId,
  allowUnpaidLeave,
  balanceSourceOptions,
  policies,
  typeRules,
  grades,
  companies,
  schemeEntitlements,
  benefitSchemeSection,
  festiveGrantSection,
  approvalWorkflowSection,
  halfDaySection,
  leaveYearSection,
  previewScenarioSection,
  accrualSection,
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  createPolicyAction,
  updatePolicyAction,
  setTypeRulesAction,
  deletePolicyAction,
  countInScopeAction,
  upsertSchemeEntitlementAction,
  benefitSchemes,
  gradeGroups,
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
  isAnnual: boolean;
  floor0: number;
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
  /** Minimum advance-notice rule (0159): how many days before its start date a leave of this type must be
   *  submitted; null = no requirement. Threaded so the sub-form round-trips. Field hidden for Emergency Leave
   *  (code === 'EMERGENCY' — EL exists precisely for short-notice absence and is never guarded). */
  minAdvanceDays: number | null;
  /** Leave Type Expiry Field (fec49317): age-from-earning expiry pair — after this many months/days from the
   *  date each portion is earned, unused days lapse. Both null = no expiry. Threaded so the sub-form
   *  round-trips. Hidden for Annual (owned by the per-policy carry-forward expiry engine). */
  expiryValue: number | null;
  expiryUnit: string | null;
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
  /** Configurable Negative Leave Balance Validation (0ef0defd): whether employees may submit/edit a leave
   *  application of this type that exceeds their available balance. false ⇒ block over-application (the
   *  default). Threaded so the Yes/No sub-form round-trips its saved value; persisted via touchNegativeBalance. */
  allowNegativeBalance: boolean;
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
  policies: EntitlementPolicy[];
  /** 9816a5ad step 2: the consolidated rules, read from and written back to the leave TYPE. */
  typeRules: LeaveTypeRules;
  grades: GradeOption[];
  /** ADR-0066: companies (subsidiaries) for the per-policy company scope select. */
  companies: CompanyOption[];
  /** Restructure (123c1e76): THIS leave type's benefit-scheme entitlement rows (scheme name + service-tier
   *  days + read-only combined-pool cap), rendered in the per-type Entitlement card. The SAME live rows the
   *  shared Benefit Schemes table shows — filtered by leave type, never duplicated. */
  schemeEntitlements: LeaveTypeSchemeEntitlement[];
  /** 6c775d68: the Benefit Schemes management area, scoped to THIS leave type — a server-composed
   *  <BenefitSchemeConfig scopeLeaveTypeId={id}> slot rendered inside the Entitlement step, below the
   *  per-type table. Slot-shaped so the scheme data is prepared ONCE at page level (no N+1 per type).
   *  387792a4: the config hosts the grade workbench. b1b81a08 narrowed it to TWO panels (Grade Groups ·
   *  Assignment) — grade MASTER data now lives on Settings → System Labels → Organisation Labels, so there
   *  is no gradesPanel slot any more. This ONE section is still the whole Benefit Schemes sub-step. */
  benefitSchemeSection?: ReactNode;
  /** fd7c8e20: the One-Off / Festive Leave Grant tool, moved from the page-bottom section into the
   *  Entitlement step BELOW the Benefit Schemes area — a server-composed <FestiveGrantCard
   *  defaultLeaveTypeId={id}> slot, so the grant form arrives preset to THIS type. Slot-shaped like
   *  benefitSchemeSection: companies/grants data is prepared ONCE at page level (no N+1 per type). */
  festiveGrantSection?: ReactNode;
  /** e1a51aea: the Approval Workflow sub-step's content — a server-composed slot (this type's WorkflowMatrix
   *  scoped to its leaveTypeId, the read-only wildcard rules + per-company default-chain summary, and links
   *  to the Approval tab). Slot-shaped like benefitSchemeSection so the approval data + label bags are
   *  prepared ONCE at page level (no N+1 per type). */
  approvalWorkflowSection?: ReactNode;
  /** 08bc6841: the company-wide Half-Day Deduction card — a server-composed slot (the per-company toggle
   *  rows posting the SAME setLeaveHalfDayFullDeductionAction the Application Rules tab used to host,
   *  now embedded as one card of the Condition step's Leave Application Rules grid with an
   *  applies-company-wide badge). Slot-shaped like benefitSchemeSection: the rows are per-COMPANY (not
   *  per-type), so ONE node is prepared at page level and shared by every panel. */
  halfDaySection?: ReactNode;
  /** 1e4eb8af: the managed Leave Year records (Draft → Open → Closed, their two control dates, the
   *  per-row Advance-Rules / Edit / Delete controls) — a server-composed slot carrying what the retired
   *  Application Rules TAB used to host. It joins the per-type Leave Year Type override inside Custom
   *  Settings, so every leave-year decision is made from the leave type being configured. Slot-shaped
   *  like halfDaySection: the records are per-TENANT (not per-type), so ONE node is prepared at page
   *  level and shared by every panel, and its applies-company-wide badge says so. */
  leaveYearSection?: ReactNode;
  /** 7b945408: the Preview Scenario checker (d778d2d3's LeaveRulePreviewDialog), joining the Service Based
   *  Entitlements sub-step as its checking tool — a server-composed slot (page-level data prep, one shared
   *  node). The PageHeader button is removed separately by item 962077a8; this slot is its new home. */
  previewScenarioSection?: ReactNode;
  /** 7b945408: the Run Accrual action (d778d2d3's EarnedAccrualDialog), relocated into the Adjustments
   *  sub-step — it processes earned entitlement, so it belongs with entitlement adjustments. Server-composed
   *  slot (page-level data prep, one shared node); the PageHeader button is removed by item 962077a8. */
  accrualSection?: ReactNode;
  updateTypeAction: Action;
  archiveTypeAction: Action;
  deleteTypeAction: Action;
  createPolicyAction: Action;
  updatePolicyAction: Action;
  /** 9816a5ad step 2: writes the five consolidated settings to the leave type. */
  setTypeRulesAction: Action;
  deletePolicyAction: Action;
  /** Feedback 9d8cf621: server action returning the count of active employees the selected
   *  companies/grades cover — drives the live "entitled employees" figure next to the chips. */
  countInScopeAction: (p: { companyIds: string[]; gradeIds: string[] }) => Promise<number>;
  /** Restructure (123c1e76): the SAME upsertSchemeEntitlement action the Benefit Schemes table posts —
   *  the per-type Entitlement card's Edit dialog writes through it, so nothing forks. */
  upsertSchemeEntitlementAction: Action;
  /** 9816a5ad — the benefit schemes the Service Based Entitlements table lists once a company is picked, and
   *  the grade-group membership it needs to tell the admin where the old grade-level figures disagree.
   *  Prepared ONCE at page level from rows the page already loads (the benefitSchemeSection precedent). */
  benefitSchemes: ServiceSchemeRow[];
  gradeGroups: { id: string; gradeIds: string[] }[];
}) {
  const t = useTranslations('admin.leave');
  // Organisation Assignment criteria (Enhance Leave Criteria Configuration): the eight criterion labels REUSE
  // the existing profile_option category labels (already shipped in all six locales) — zero new keys. Scoped
  // translator so a call site reads t org-label statically (the i18n coverage test).
  const tOrg = useTranslations('admin.profileOptions.category');
  // Sync Employee Leave View Configuration (11876072): the view-config group headings reuse the employee
  // panel's OWN section titles (leave.breakdown.section.*) so the admin screen reads as a preview of the
  // panel — same words, same order. That translator now lives inside ViewConfigSection (2bc2f2a3).
  // Leave Type Employee Visibility (7b11f1c1): statutory-entitlement codes can never have employee
  // applications blocked (an employee must be able to exercise a lawful entitlement — EA 1955 s.60E/s.60F/
  // s.37/s.60FA). Mirrors STATUTORY_APPLY_CODES in core/leave.ts; kept as a local literal so this client
  // component never pulls server-only code. The service enforces the same rule as the authority.
  const isStatutoryApply = ['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY', 'PATERNITY'].includes(code);
  // Edit Leave Type Code (a7194511): the Code field is editable ONLY for custom (non-statutory) types. The
  // statutory codes above — plus EMERGENCY — are the semantic keys the leave/payroll engine matches on for
  // EA-1955 statutory entitlement, carry-forward and encashment; renaming one would silently switch those
  // rules off, so they stay LOCKED (read-only). Mirrors the service guard (STATUTORY_APPLY_CODES +
  // EMERGENCY_LEAVE_CODE in core/leave.ts) as a local literal so this client component never imports server code.
  const codeLocked = isStatutoryApply || code === 'EMERGENCY';
  const [editingName, setEditingName] = useState(false);
  // Day Type Inclusion (ef6d7146): its own edit-mode toggle (a sub-form inside Eligibility Rules).
  const [editingDayTypes, setEditingDayTypes] = useState(false);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Feedback 9d8cf621 — custom apply-time message: the enable checkbox drives whether the textarea is shown.
  // Default from stored state (a non-empty applyNotice ⇒ enabled), so it round-trips on reload.
  const [applyNoticeEnabled, setApplyNoticeEnabled] = useState<boolean>(!!customMessages?.applyNotice);
  // Feedback 9d8cf621 — "Employee Selection" chips (add-entitlement form): selected companies + grades and the
  // live entitled-employee count. Reset when the add form opens; recomputed via the server action on change.
  const [pickCompanies, setPickCompanies] = useState<string[]>([]);
  const [pickGrades, setPickGrades] = useState<string[]>([]);
  const [entitledCount, setEntitledCount] = useState<number | null>(null);
  const [, startCountTransition] = useTransition();

  const refreshCount = (companyIds: string[], gradeIds: string[]) => {
    startCountTransition(async () => {
      try {
        setEntitledCount(await countInScopeAction({ companyIds, gradeIds }));
      } catch {
        setEntitledCount(null);
      }
    });
  };
  const toggleFrom = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  // Restructure Service-Based Entitlements (2bba9e35): recompute the inline edit form's live covered count
  // from the form's OWN scope selects. The company/grade selects are uncontrolled (defaultValue), so read
  // the current value of BOTH off the shared form element rather than tracking a second piece of state.
  // Empty value ⇒ empty array = countEmployeesInScope's empty-means-all semantics.
  const recountEditScope = (form: HTMLFormElement | null) => {
    if (!form) return;
    const cid = (form.elements.namedItem('companyId') as HTMLSelectElement | null)?.value ?? '';
    const gid = (form.elements.namedItem('gradeId') as HTMLSelectElement | null)?.value ?? '';
    refreshCount(cid ? [cid] : [], gid ? [gid] : []);
  };

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
  // Entitlement sub-step (7b945408): the active sub-step of step 3, persisted in the SAME shape — now
  // { activeStep, generalSubStep, essSubStep, entitlementSubStep }. Older payloads (any earlier subset,
  // the pre-step accordion { key: boolean }) still hydrate — entitlementSubStep simply defaults to
  // sub-step 1 (Benefit Schemes) when the key is absent/unknown.
  const [entitlementSubStep, setEntitlementSubStep] = useState<EntitlementSubStepKey>('schemes');
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`leaveTypeCards:${id}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      // b8fcae73: the Eligibility step is gone, so a payload still pointing at it (either shape) no longer
      // matches STEP_KEYS and would silently fall back to step 1. Remap it to the content's new home —
      // Entitlement · Service Based Entitlements (bc9be1e8 retired the Company Entitlements sub-step that
      // hosted it in between) — and let that remap WIN over any stored entitlementSubStep.
      const wantedEligibility =
        !!parsed &&
        typeof parsed === 'object' &&
        (parsed.activeStep === RETIRED_ELIGIBILITY_STEP ||
          (typeof parsed.activeStep !== 'string' &&
            !STEP_KEYS.some((k) => parsed[k] === true) &&
            parsed[RETIRED_ELIGIBILITY_STEP] === true));
      if (wantedEligibility) {
        setActiveStep('entitlement');
        setEntitlementSubStep('service');
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
      if (
        !wantedEligibility &&
        parsed &&
        typeof parsed.entitlementSubStep === 'string' &&
        (ENTITLEMENT_SUB_STEP_KEYS as readonly string[]).includes(parsed.entitlementSubStep)
      ) {
        setEntitlementSubStep(parsed.entitlementSubStep as EntitlementSubStepKey);
      } else if (
        !wantedEligibility &&
        parsed &&
        parsed.entitlementSubStep === RETIRED_COMPANY_ENTITLEMENTS_SUB_STEP
      ) {
        // bc9be1e8: a browser left on the removed Company Entitlements tab lands on Service Based
        // Entitlements, where that content now lives — not back on sub-step 1 with no explanation.
        setEntitlementSubStep('service');
      }
    } catch {
      /* storage unavailable / malformed ⇒ default step 1 */
    }
  }, [id]);
  const persistSteps = (step: StepKey, sub: GeneralSubStepKey, ess: EssSubStepKey, ent: EntitlementSubStepKey) => {
    try {
      window.localStorage.setItem(
        `leaveTypeCards:${id}`,
        JSON.stringify({ activeStep: step, generalSubStep: sub, essSubStep: ess, entitlementSubStep: ent }),
      );
    } catch {
      /* storage write blocked ⇒ runtime switch still works, just not persisted */
    }
  };
  const selectStep = (key: StepKey) => {
    setActiveStep(key);
    persistSteps(key, generalSubStep, essSubStep, entitlementSubStep);
  };
  const selectGeneralSubStep = (key: GeneralSubStepKey) => {
    setGeneralSubStep(key);
    persistSteps(activeStep, key, essSubStep, entitlementSubStep);
  };
  const selectEssSubStep = (key: EssSubStepKey) => {
    setEssSubStep(key);
    persistSteps(activeStep, generalSubStep, key, entitlementSubStep);
  };
  const selectEntitlementSubStep = (key: EntitlementSubStepKey) => {
    setEntitlementSubStep(key);
    persistSteps(activeStep, generalSubStep, essSubStep, key);
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

  const active = policies.filter((p) => !p.validTo);
  // Leave Entitlement Rules Engine (step 8a — correctness fix): the flat annualDays-only headline would be
  // misleading for a banded policy (it could show a single number that no employee actually gets — e.g. the
  // "under 2 years" figure even though most staff are past that band). Find the winning active policy by
  // annualDays (unchanged tie-break — this is a DISPLAY summary, not the resolver) and, if it carries bands,
  // render the band range instead of the flat number.
  const winning = active.reduce<EntitlementPolicy | null>(
    (best, p) => (!best || p.annualDays > best.annualDays ? p : best),
    null,
  );
  const bestActive = winning?.annualDays ?? 0;
  const winningBands = winning?.serviceBands && winning.serviceBands.length > 0 ? winning.serviceBands : null;
  const bandDaysRange = winningBands
    ? [...new Set(winningBands.map((b) => b.days))].sort((a, b) => a - b)
    : null;
  // fa3f4ccb — the headline is the CONFIGURED figure, not max(floor, configured). It used to show the
  // clamped number, which was the whole complaint: an 8 configured against a statutory 12 displayed as 12
  // and granted as 12, with nothing saying the 8 had been ignored. The amber `belowMinimumBadge` beside it
  // (unchanged, and already built) is now the entire statutory behaviour on this screen: it warns, it does
  // not correct.
  const effective = bestActive;
  const belowFloor = active.length > 0 && !winningBands && bestActive < floor0;
  const above = active.length > 0 && bestActive > floor0;
  const thisYear = new Date().getUTCFullYear();

  return (
    <div id={`type-${id}`} className={cn('space-y-3', archived && 'opacity-60')}>
      {/* Workspace header: the selected type's identity + entitlement summary (formerly the collapsible row
          header — the expand toggle is gone; the workspace's internal left panel now does the selecting). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">{code}</span>
          {archived && <span className={badge.muted}>{t('archivedBadge')}</span>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {bandDaysRange && bandDaysRange.length > 0
              ? t('daysPerYearBandedRange', { min: fmt(bandDaysRange[0]), max: fmt(bandDaysRange[bandDaysRange.length - 1]) })
              : effective > 0
                ? t.rich('daysPerYear', {
                    days: fmt(effective),
                    b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
                  })
                : '—'}
          </span>
          {belowFloor && <span className={badge.amber}>{t('belowMinimumBadge')}</span>}
          {winningBands && <span className={badge.muted}>{t('bandedNote')}</span>}
          {above && <span className={badge.emerald}>{t('policyBadge')}</span>}
        </div>
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
              the R61 step-bar mechanism generalized; later secondary flows MUST reuse it) walks the five
              sub-steps 1 Details · 2 Leave Year Type · 3 Earning Method · 4 Carry Forward Policy ·
              5 Approval Workflow. One sub-step visible at a time; the choice persists per type alongside
              activeStep (leaveTypeCards:<id>). */}
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
                  <ConfirmSubmit
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title={t('deleteTypeConfirmTitle')}
                    description={t('deleteTypeConfirmDescription')}
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
            {isAnnual ? (
              <CarryPolicyForm t={t} rules={typeRules} action={setTypeRulesAction} leaveTypeId={id} />
            ) : (
              <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
                {t('subStep.carryAnnualOnly')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('subStep.carryStepHelp')}</p>
          </div>
          )}
          {/* Sub-step 5 — Approval Workflow (e1a51aea): this type's approval rules from the rule matrix,
              editable right here (server-composed slot, scoped to this leaveTypeId), with company-wide
              chains + templates one click away on the Approval tab. */}
          {generalSubStep === 'workflow' && (
          <div className="space-y-1.5">
            {approvalWorkflowSection ?? (
              <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
                {t('subStep.workflowUnavailable')}
              </p>
            )}
          </div>
          )}
            </CardContent>
          </Card>
          )}
          {activeStep === 'entitlement' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryEntitlement')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-entitlement-${id}`} className="space-y-3">
          {/* Entitlement sub-flow (7b945408, extended by b8fcae73, shortened by bc9be1e8 + 0d9cf710): the
              SAME reusable SubStepBar the General flow introduced (components/leave-sub-step-bar.tsx — the
              reuse contract) walks the three sub-steps 1 Benefit Schemes · 2 Service Based Entitlements ·
              3 Adjustments. One sub-step visible at a time; the choice persists per type alongside
              activeStep/generalSubStep/essSubStep (leaveTypeCards:<id>). The entitlement journey reads: who
              receives which scheme → how entitlement is calculated and how many days each company or grade
              gets → what manual adjustments apply. */}
          <SubStepBar
            steps={ENTITLEMENT_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(ENTITLEMENT_SUB_STEP_TITLE_KEY[k]) }))}
            active={entitlementSubStep}
            onSelect={(k) => selectEntitlementSubStep(k as EntitlementSubStepKey)}
            ariaLabel={t('entitlementStepsLabel')}
          />
          {/* Sub-step 1 — Benefit Schemes (7b945408): who receives which scheme. 387792a4 restructured the
              old vertical scroll into the workbench BenefitSchemeConfig hosts; b1b81a08 narrowed it to two
              panels — Grade Groups · Assignment — with the per-scheme entitlements area below, so the
              grade-group → scheme relationship still reads side by side. The Grade Master panel moved out
              of Leave Config to Settings → System Labels → Organisation Labels. One server-composed slot;
              see the benefitSchemeSection prop doc. */}
          {entitlementSubStep === 'schemes' && (
          <>
          {benefitSchemeSection}
          {/* Restructure Service-Based Leave Entitlements: the per-scheme entitlement table — THIS leave
              type's benefit-scheme entitlement rows (the days each scheme grants per service tier). It
              stays reachable HERE, under Benefit Schemes, where naming schemes is correct; the relocated
              Service Based Entitlements picker (sub-step 2) is company-only. Read-and-edit over the SAME
              live rows via the SAME upsert action (no duplication, nothing can drift). */}
          <div className="space-y-1.5 border-t border-border pt-3">
            <span className="text-xs font-medium text-muted-foreground">{t('schemeEntitlementsTitle')}</span>
            <LeaveTypeEntitlementTable ents={schemeEntitlements} upsertEntitlement={upsertSchemeEntitlementAction} />
          </div>
          </>
          )}
          {/* Sub-step 2 — Service Based Entitlements: the company-driven entitlement table, then the
              per-company policy timeline, then the Preview Scenario checker. 9816a5ad turned the middle
              column from JOB GRADE into BENEFIT SCHEME: picking a company lists that company's schemes with
              their service-tenure days, and a row writes the scheme's own entitlement through the same
              upsert action the Benefit Schemes surface posts. That removes the duplicate maintenance — the
              figures typed here ARE the ones leave calculation reads, not a second set feeding it.
              Grade-level policies are untouched and stay editable on the timeline below, which is what
              anyone no scheme covers still resolves through. */}
          {entitlementSubStep === 'service' && (
          <>
          <ServiceEntitlementTable
            leaveTypeId={id}
            leaveTypeName={name}
            companies={companies}
            schemes={benefitSchemes}
            gradeGroups={gradeGroups}
            entitlements={schemeEntitlements}
            policies={policies.map(
              (p): ServicePolicyRow => ({
                gradeId: p.gradeId ?? null,
                companyId: p.companyId ?? null,
                annualDays: p.annualDays,
                serviceBands: p.serviceBands ?? null,
                validTo: p.validTo,
              }),
            )}
            upsertEntitlement={upsertSchemeEntitlementAction}
          />
          {/* 0d9cf710: the earning-method front door 2bba9e35 mounted here is GONE. Earning Method,
              Rounding Method and the Earn Upon Resignation note are configured in General → Earning Method
              (the generalSubStep === 'earning' mount above) — the same component over the same policy row,
              so this was a second rendering of one setting, not a second setting. Removing the copy leaves
              both controls fully configurable, which item 4c6f69bd's rounding depends on. */}
          {/* bc9be1e8: the per-company entitlement policies timeline — days per company or grade,
              carry-forward, accrual method, effective dates, add / edit / remove. It used to also render
              behind its own Company Entitlements sub-step (b8fcae73), which 2bba9e35 merged into a shared
              gate; that tab is now removed, so this block is Service Based Entitlements' own content and
              the ONLY place a policy can be added or deleted. Do NOT lift it into its own component or
              hoist it above the return — that would move companyEntitlements / addEntitlement /
              isEarned(p.method) OUT of the Entitlement card slice and vacuously pass the eee43966
              regression guards. */}
          {/* 08bc6841: the eligibility rules block (gender / marital / min service / probation) moved
              to the Condition step's Criteria sub-step — this step now focuses purely on entitlement
              policies (who gets how many days). */}
          {/* entitlement timeline */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t('companyEntitlements')}</div>
            {policies.length === 0 && (
              <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
                {t('noCompanyPolicy')}
              </p>
            )}
            {policies.map((p) =>
              editingPolicyId === p.id ? (
                <form
                  key={p.id}
                  action={updatePolicyAction}
                  className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3"
                >
                  <input type="hidden" name="id" value={p.id} />
                  {/* 9b0503ac: the hosting type's id anchors the action's success redirect back to this
                      panel (#type-<id>) — save-and-stay instead of bouncing to /admin/leave. */}
                  <input type="hidden" name="leaveTypeId" value={id} />
                  {/* Feedback 49809272: editing IN PLACE recalculates affected employees' current-cycle
                      balances automatically — tell the admin before they save. */}
                  <p className="w-full text-[11px] text-muted-foreground">{t('recalcInPlaceHint')}</p>
                  {/* b81d3c52 (tri-state, this ticket): the Rounding Method's home is the Earning Method
                      front door. THIS form does not render the Rounding dropdown, so it posts NO
                      `roundingMethodRendered` marker and the writer preserves the stored value — the former
                      hidden pass-through input is gone (removing the coupling flagged as a footgun). */}
                  <Field label={t('daysPerYearLabel')}>
                    <input
                      name="annualDays"
                      type="number"
                      min="0"
                      step="0.5"
                      required
                      defaultValue={p.annualDays}
                      className={`${inputCls} w-24`}
                    />
                  </Field>
                  {/* fa3f4ccb — THE CARRY-FORWARD SURFACE IS GONE FROM COMPANY ENTITLEMENTS. Carry forward
                      (enable flag, cap, expiry, include-earned) is configured on the LEAVE TYPE since
                      9816a5ad step 2 / migrations 0333-0334, and the engines read it from there; leaving a
                      second set of controls here meant editing a figure that mostly did nothing. What
                      remains here is what this row genuinely owns: DAYS, scope and effective date.
                      The stored carry values are RE-POSTED as hidden inputs (FrontDoorPreservedCarry, the
                      existing precedent) because updateLeavePolicyAction rebuilds the accrual JSONB
                      wholesale from what it receives — `carryForwardMax` is NOT tri-state, so a form that
                      simply stopped posting it would zero the cap on every save. That would silently drop
                      carry for the leave types that still fall back to the policy row (only 10 of 67 carry
                      type-level rules today), which is a data change nobody asked for. */}
                  <FrontDoorPreservedCarry p={p} isAnnual={isAnnual} />
                  <Field label={t('effectiveFromLabel')}>
                    <input name="validFrom" type="date" required defaultValue={p.validFrom} className={inputCls} />
                  </Field>
                  {/* Feedback eee43966 — the earning method is set in ONE place only: General → Earning
                      Method. No select here; updateLeavePolicy preserves the row's stored method when the
                      edit posts none, so an eligibility edit can never change how leave is earned. The
                      read-only earned badge on the collapsed row still shows HR the method. */}
                  {grades.length > 0 && (
                    <Field label={t('gradeLabel')}>
                      <select
                        name="gradeId"
                        defaultValue={p.gradeId ?? ''}
                        onChange={(e) => recountEditScope(e.currentTarget.form)}
                        className={`${inputCls} w-40`}
                      >
                        <option value="">{t('gradeAll')}</option>
                        {grades.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {/* ADR-0066: per-company scope. Group default = applies to every company; a specific
                      company OVERRIDES the group default for that company (even when lower). */}
                  <Field label={t('policyCompanyLabel')}>
                    <select
                      name="companyId"
                      defaultValue={p.companyId ?? ''}
                      onChange={(e) => recountEditScope(e.currentTarget.form)}
                      className={`${inputCls} w-44`}
                    >
                      <option value="">{t('policyCompanyGroupDefault')}</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {/* Restructure Service-Based Entitlements (2bba9e35): the SAME live covered-employee count
                      the add form shows, now on the inline edit form — the "before you save it" number for an
                      existing policy. Reuses entitledCount (only one form open at a time). */}
                  {entitledCount != null && (
                    <p className="w-full text-xs font-medium text-foreground">
                      {t('entitledEmployeesCount', { count: entitledCount })}
                    </p>
                  )}
                  {/* fa3f4ccb — THE SERVICE-LENGTH BAND EDITOR IS GONE FROM COMPANY ENTITLEMENTS. Service
                      bands are configured per benefit scheme in Service Based Entitlements above (the
                      scheme's band days supersede this row's days anyway), so a second band table here was
                      a second place to answer one question. NOT posting the `serviceBandsRendered` marker
                      makes serviceBandsField return undefined = PRESERVE, so any bands already stored on
                      this policy row keep working — the engine still reads them (bandDaysFor), they are
                      simply no longer edited here. The row is not rewritten and leave_policy is not
                      emptied: this removes a SURFACE, not data. */}
                  {/* 4ec5a940 — optional "why the change was made" note; recorded on the audit event so HR can
                      answer the reporter's "Why the change was made" column. */}
                  <Field label={t('reasonLabel')}>
                    <input
                      name="reason"
                      type="text"
                      maxLength={500}
                      placeholder={t('reasonPlaceholder')}
                      className={`${inputCls} w-64`}
                    />
                  </Field>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingPolicyId(null);
                      // 2bba9e35: reset the shared count when the edit form closes.
                      setEntitledCount(null);
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </form>
              ) : (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-xs"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-semibold tabular-nums text-foreground">
                      {t('daysPerYearText', { days: fmt(p.annualDays) })}
                    </span>
                    {/* fa3f4ccb — the carry cap / carry-off / carry-expiry summaries are gone with the
                        controls that set them. A read-only carry figure on a row that can no longer edit
                        carry, describing a value the engines read from the leave TYPE, is worse than
                        nothing: it looks like the configuration in force. Carry forward is stated once, in
                        General → Carry Forward Policy. */}
                    <span className="text-muted-foreground">
                      {p.validTo
                        ? t('validFromTo', { from: p.validFrom, to: p.validTo })
                        : t('validFrom', { from: p.validFrom })}
                    </span>
                    {!p.validTo && <span className={badge.emerald}>{t('activeBadge')}</span>}
                    {isEarned(p.method) && (
                      <span className={badge.amber}>
                        {t(p.method === 'earned_quarterly' ? 'methodEarnedQuarterly' : 'methodEarnedMonthly')}
                      </span>
                    )}
                    {p.gradeId && p.gradeName && <span className={badge.muted}>{p.gradeName}</span>}
                    {/* ADR-0066: scope badge — the owning company, or the group-default label. */}
                    <span className={badge.muted}>
                      {p.companyId && p.companyName ? p.companyName : t('policyCompanyGroupDefault')}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingPolicyId(p.id);
                        // Restructure Service-Based Entitlements (2bba9e35): seed the SAME entitledCount the
                        // add form drives (only one of add/edit is open at a time ⇒ one shared state, no
                        // second store) so the "before you save it" number appears the moment Edit opens.
                        // Absent axis ⇒ empty array = countEmployeesInScope's empty-means-all semantics.
                        refreshCount(p.companyId ? [p.companyId] : [], p.gradeId ? [p.gradeId] : []);
                      }}
                    >
                      {t('edit')}
                    </Button>
                    <form action={deletePolicyAction}>
                      <input type="hidden" name="id" value={p.id} />
                      {/* 9b0503ac: keep the admin on this type's panel after the remove (redirect anchor). */}
                      <input type="hidden" name="leaveTypeId" value={id} />
                      <ConfirmSubmit
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        title={t('removePolicyConfirmTitle')}
                        description={t('removePolicyConfirmDescription')}
                        confirmLabel={t('removeConfirmLabel')}
                      >
                        {t('remove')}
                      </ConfirmSubmit>
                    </form>
                  </div>
                </div>
              ),
            )}
          </div>
          {/* add a dated entitlement */}
          {adding ? (
            <form
              action={createPolicyAction}
              className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3"
            >
              <input type="hidden" name="leaveTypeId" value={id} />
              <Field label={t('daysPerYearLabel')}>
                <input
                  name="annualDays"
                  type="number"
                  min="0"
                  step="0.5"
                  required
                  defaultValue={floor0 || 14}
                  className={`${inputCls} w-24`}
                />
              </Field>
              {/* fa3f4ccb — no carry-forward controls on the add form either (see the edit form above for
                  why). A NEW policy row simply carries no carry configuration: the leave TYPE owns that
                  setting now, so posting a fixed 0 here is the honest value rather than a lost one. */}
              <input type="hidden" name="carryForwardMax" value="0" />
              <Field label={t('effectiveFromLabel')}>
                <input name="validFrom" type="date" required defaultValue={`${thisYear}-01-01`} className={inputCls} />
              </Field>
              {/* Feedback b81d3c52 (tri-state, this ticket) — the add form RENDERS the Rounding dropdown, so
                  it posts the `roundingMethodRendered` marker: on create 'up'/'down' set the new row's value
                  and 'none' omits the key (nothing to preserve on create). Defaults to No-Rounding. */}
              <input type="hidden" name="roundingMethodRendered" value="1" />
              <Field label={t('subStep.roundingMethodLabel')}>
                <select name="roundingMethod" defaultValue="none" aria-label={t('subStep.roundingMethodLabel')} className={`${inputCls} w-40`}>
                  <option value="none">{t('subStep.roundingNone')}</option>
                  <option value="up">{t('subStep.roundingUp')}</option>
                  <option value="down">{t('subStep.roundingDown')}</option>
                </select>
              </Field>
              {/* Feedback eee43966 — no earning-method select on the add-a-dated-entitlement form either.
                  This one WAS the reporter's bug: it defaulted to lump sum, and saving superseded the
                  running earned_monthly row with a lump one. createLeavePolicy now inherits the method
                  from the row it supersedes, so a version bump carries the earning method forward. */}
              {/* Feedback 9d8cf621 — "Employee Selection": HR picks one or MORE companies + job grades. The
                  chosen ids post as repeated `companyIds` / `gradeIds` fields (hidden inputs below), and the
                  action fans out to one entitlement per (company × grade). Empty = group default / all grades
                  (today's single row). Selected values render as removable chips + a live entitled-employee
                  count. */}
              <div className="w-full space-y-2 rounded-lg bg-background p-3 lg:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">{t('employeeSelectionLabel')}</span>
                {/* hidden inputs carry the current selection into the POST */}
                {pickCompanies.map((cid) => (
                  <input key={cid} type="hidden" name="companyIds" value={cid} />
                ))}
                {pickGrades.map((gid) => (
                  <input key={gid} type="hidden" name="gradeIds" value={gid} />
                ))}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('policyCompaniesLabel')}</span>
                    <select
                      aria-label={t('policyCompaniesLabel')}
                      value=""
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        const next = toggleFrom(pickCompanies, v);
                        setPickCompanies(next);
                        refreshCount(next, pickGrades);
                      }}
                      className={`${inputCls} w-full`}
                    >
                      <option value="">{t('policyCompanyGroupDefault')}</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-1">
                      {pickCompanies.map((cid) => {
                        const c = companies.find((x) => x.id === cid);
                        return (
                          <button
                            key={cid}
                            type="button"
                            onClick={() => {
                              const next = pickCompanies.filter((v) => v !== cid);
                              setPickCompanies(next);
                              refreshCount(next, pickGrades);
                            }}
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                            aria-label={t('chipRemoveAria', { name: c?.name ?? cid })}
                          >
                            {c?.name ?? cid}
                            <span aria-hidden>×</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {grades.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">{t('policyGradesLabel')}</span>
                      <select
                        aria-label={t('policyGradesLabel')}
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) return;
                          const next = toggleFrom(pickGrades, v);
                          setPickGrades(next);
                          refreshCount(pickCompanies, next);
                        }}
                        className={`${inputCls} w-full`}
                      >
                        <option value="">{t('gradeAll')}</option>
                        {grades.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                      <div className="flex flex-wrap gap-1">
                        {pickGrades.map((gid) => {
                          const g = grades.find((x) => x.id === gid);
                          return (
                            <button
                              key={gid}
                              type="button"
                              onClick={() => {
                                const next = pickGrades.filter((v) => v !== gid);
                                setPickGrades(next);
                                refreshCount(pickCompanies, next);
                              }}
                              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                              aria-label={t('chipRemoveAria', { name: g?.name ?? gid })}
                            >
                              {g?.name ?? gid}
                              <span aria-hidden>×</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                {entitledCount != null && (
                  <p className="text-xs font-medium text-foreground">
                    {t('entitledEmployeesCount', { count: entitledCount })}
                  </p>
                )}
              </div>
              {/* fa3f4ccb — no band editor on the add form either; see the edit form. Omitting the
                  `serviceBandsRendered` marker is a no-op on create (serviceBandsField ⇒ undefined), so a
                  new policy row is created flat and its service-length steps are configured where they
                  belong: the scheme's Service Based Entitlements table. */}
              {/* Feedback 9d8cf621: save button with a confirmation prompt before writing. */}
              <ConfirmSubmit
                size="sm"
                variant="default"
                title={t('savePolicyConfirmTitle')}
                description={t('savePolicyConfirmDescription')}
                confirmLabel={t('saveConfirmLabel')}
              >
                {t('add')}
              </ConfirmSubmit>
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>
                {t('cancel')}
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(true);
                setPickCompanies([]);
                setPickGrades([]);
                setEntitledCount(null);
              }}
            >
              {t('addEntitlement')}
            </Button>
          )}
          {/* 08bc6841: the Leave Type Expiry configuration (fec49317) moved to the Condition step's
              Expiry sub-step — same form, same expiry=1 tri-state marker, same non-Annual gate. */}
          {/* The Preview Scenario checker stays LAST in the sub-step, after the policy block — the
              pre-existing rule that the preview tool follows the service content it checks. */}
          {previewScenarioSection}
          </>
          )}
          {/* Sub-step 4 — Adjustments (7b945408): what manual adjustments apply. */}
          {entitlementSubStep === 'adjustments' && (
          <>
          {/* fd7c8e20: the One-Off / Festive Leave Grant tool, preset to this type — the standalone
              page-bottom section moved into this step (now its Adjustments sub-step). Server-composed
              slot; see the festiveGrantSection prop doc. */}
          {festiveGrantSection}
          {/* 7b945408: the Run Accrual action relocated here from the page header — it processes earned
              entitlement, so it belongs with entitlement adjustments. The SAME self-contained
              EarnedAccrualDialog (d778d2d3). Server-composed slot; see the accrualSection prop doc. */}
          {accrualSection}
          </>
          )}
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
          {/* Condition sub-flow (08bc6841): the SAME reusable SubStepBar the General flow introduced
              (components/leave-sub-step-bar.tsx — the reuse contract) walks the three sub-steps
              1 Criteria · 2 Leave Application Rules · 3 Expiry. One sub-step visible at a time; the
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
            <form action={updateTypeAction} className="space-y-2">
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
                      defaultChecked={opt === (allowNegativeBalance ? 'yes' : 'no')}
                      className="mt-0.5 size-3.5 border-border"
                    />
                    <span>{opt === 'yes' ? t('negativeBalanceYes') : t('negativeBalanceNo')}</span>
                  </label>
                ))}
              </div>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
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
              action={updateTypeAction}
            />
            <p className="text-xs text-muted-foreground">{t('conditionStep.applicationLimitHelp')}</p>
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
          {/* Sub-step 3 — Expiry (08bc6841): the leave expiry configuration moved here from Eligibility.
              Annual types' carry-forward expiry stays with the Carry Forward Policy sub-step of the
              General flow — the pointer below explains where; Emergency Leave carries no balance to
              expire, so it gets an explanatory note instead of a dead form (the fec49317 config-trap
              rationale, kept). */}
          {essSubStep === 'expiry' && (
          <>
          {isAnnual && (
            <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
              {t('conditionStep.expiryAnnualPointer')}
            </p>
          )}
          {!isAnnual && code === 'EMERGENCY' && (
            <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
              {t('conditionStep.expiryEmergencyNote')}
            </p>
          )}
          {/* Leave Type Expiry Field (fec49317). Its own sub-form (own tri-state) posts `expiry=1`.
              Hidden for Annual — Annual already has per-policy carry-forward expiry (a second age-based
              forfeit would double-count) — and for Emergency Leave, which carries no balance. Both inputs
              blank ⇒ clears the expiry; a number + unit configures age-from-earning expiry. */}
          {!isAnnual && code !== 'EMERGENCY' && (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('expirySectionTitle')}</span>
              <form action={updateTypeAction} className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3">
                <input type="hidden" name="id" value={id} />
                {/* preserve the name — this form does not edit it */}
                <input type="hidden" name="name" value={name} />
                {/* marker: tells the action to touch the expiry_value / expiry_unit columns (tri-state guard) */}
                <input type="hidden" name="expiry" value="1" />
                <Field label={t('expiryValueLabel')}>
                  <input
                    name="expiryValue"
                    type="number"
                    min="1"
                    step="1"
                    defaultValue={expiryValue ?? ''}
                    placeholder={t('expiryValuePlaceholder')}
                    className={`${inputCls} w-24`}
                  />
                </Field>
                <Field label={t('expiryUnitLabel')}>
                  <select name="expiryUnit" defaultValue={expiryUnit ?? 'months'} className={`${inputCls} w-32`}>
                    <option value="months">{t('expiryUnitMonths')}</option>
                    <option value="days">{t('expiryUnitDays')}</option>
                  </select>
                </Field>
                <Button type="submit" size="sm">
                  {t('save')}
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">{t('expirySectionHelp')}</p>
            </div>
          )}
          </>
          )}
            </CardContent>
          </Card>
          )}
          {activeStep === 'custom' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryCustom')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-custom-${id}`} className="space-y-3">
          {/* Leave Year Configuration (1e4eb8af, narrowed by 4d6eae7b) — the tenant-wide managed leave-year
              RECORDS, moved off the retired Application Rules tab as the server-composed leaveYearSection
              slot. The records are tenant-wide, hence the applies-company-wide badge — the same honesty the
              relocated Half-Day Deduction card carries in the Condition step.

              THE PER-TYPE LEAVE YEAR TYPE OVERRIDE IS NO LONGER HERE. 4d6eae7b moved it back into the
              General walk as sub-step 2, where the reporter wants it — the cycle is chosen before the
              earning and rounding rules that operate inside it. It is rendered in exactly ONE place: two
              editors over one column, each with its own default, is how a stale value silently overwrites a
              fresh one. Only the records, which are not a property of this leave type, stay behind. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('leaveYearConfigTitle')}</span>
            {leaveYearSection}
          </div>
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
          {/* Leave Type Employee Visibility (7b11f1c1). Its own self-contained sub-form (own tri-state) posts
              `visibility=1` — two checkboxes controlling whether an employee sees this leave type on their
              self-service Leave tab, and whether they may apply for it. Both switches are independent: a
              visible-but-not-can-apply type still shows (and its balance) but is dropped from the apply menu
              and rejected server-side in requestLeave. A statutory-entitlement code (ANNUAL / SICK /
              HOSPITALIZATION / MATERNITY / PATERNITY) cannot have applications blocked — the checkbox is
              disabled + forced on there, and the service rejects it too. null/default ⇒ visible + can-apply
              (backward compatible). */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('visibility.sectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the two visibility columns (tri-state guard) */}
              <input type="hidden" name="visibility" value="1" />
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="visibleToEmployee"
                  defaultChecked={visibleToEmployee !== false}
                  className="size-3.5 rounded border-border"
                />
                {t('visibility.visibleToEmployee')}
              </label>
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
              group, or Hidden entirely. HIDDEN REUSES THE SINGLE VISIBILITY SWITCH (7b11f1c1): choosing Hidden
              sets visible_to_employee=false — there is no second hidden control. The current selection is
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
                  defaultValue={resolvePlacement(code, essPlacement, visibleToEmployee)}
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
