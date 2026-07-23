'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { ServiceBand } from '@/core/leave-compute';
import { ESS_VIEW_CHECKLIST_GROUPS } from '@/components/leave/entitlement-panel-config';
import { LEAVE_FORMULA_COMPONENT_KEYS, type LeaveFormulaEntry } from '@/core/leave-formula';
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
import { LeaveTypeEntitlementTable, type LeaveTypeSchemeEntitlement } from './benefit-scheme-config';
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

/** Step flow (c979aa8b): the five configuration steps, in walk order — 1 General Setting, 2 Eligibility,
 *  3 Entitlement, 4 Condition, 5 Custom Settings. The keys are the SAME storage keys the pre-step accordion
 *  used ('ess' is Condition's historical key — kept deliberately so persisted state survives, see the
 *  leaveTypeCards migration in LeaveTypePanel). */
const STEP_KEYS = ['general', 'eligibility', 'entitlement', 'ess', 'custom'] as const;
type StepKey = (typeof STEP_KEYS)[number];
/** Step → its admin.leave title key (the same category* keys the accordion cards used, all 6 locales). */
const STEP_TITLE_KEY: Record<StepKey, string> = {
  general: 'categoryGeneral',
  eligibility: 'categoryEligibilityEntitlement',
  entitlement: 'categoryEntitlement',
  ess: 'categoryEssPolicy',
  custom: 'categoryCustom',
};

const isEarned = (m?: string) => m === 'earned_monthly' || m === 'earned_quarterly';
/** Normalise to a select value: earned methods pass through, everything else is the lump option. */
const methodValue = (m?: string) => (isEarned(m) ? m! : 'grant_on_hire_prorated');

/** General step sub-flow (e1a51aea): the five sub-steps of step 1, in walk order — 1 Details, 2 Leave Year
 *  Type, 3 Earning Method, 4 Carry Forward Policy, 5 Approval Workflow. The keys are storage keys (persisted
 *  as `generalSubStep` in the leaveTypeCards:<id> localStorage shape, next to activeStep) — 'workflow' is
 *  deliberately NOT named after the retired accordion card keys (approval/display/calculation), which must
 *  never reappear in this file (see leave-type-config-categories.test.ts). */
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

/** Entitlement step sub-flow (7b945408): the three sub-steps of step 3, in walk order — 1 Benefit Schemes
 *  (who receives which scheme: the Grades catalogue relocated from the page bottom + the type-scoped scheme
 *  management, so the grade → grade-group → scheme relationship reads in one place), 2 Service Based
 *  Entitlements (how entitlement is calculated: the per-type entitlement table + the Preview Scenario
 *  checker), 3 Adjustments (what manual adjustments apply: the One-Off/Festive grant tool + the Run Accrual
 *  action relocated from the page header — it processes earned entitlement, so it belongs with entitlement
 *  adjustments). Keys are storage keys (persisted as `entitlementSubStep` in the leaveTypeCards:<id>
 *  localStorage shape, next to activeStep / generalSubStep / essSubStep — the e1a51aea shape extended
 *  backward-compatibly). Rendered by the SAME reusable SubStepBar the General flow introduced
 *  (components/leave-sub-step-bar.tsx — the reuse contract). */
const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'adjustments'] as const;
type EntitlementSubStepKey = (typeof ENTITLEMENT_SUB_STEP_KEYS)[number];
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

/** The hidden inputs BOTH front doors post to preserve the policy's identity + non-edited flat fields. */
function FrontDoorIdentityFields({ p }: { p: EntitlementPolicy }) {
  return (
    <>
      <input type="hidden" name="id" value={p.id} />
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
  p,
  isAnnual,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  p: EntitlementPolicy;
  isAnnual: boolean;
  action: Action;
}) {
  const [choice, setChoice] = useState<EarningChoice>(earningChoiceOf(p.method));
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <FrontDoorIdentityFields p={p} />
      <FrontDoorPreservedCarry p={p} isAnnual={isAnnual} />
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
          {earningChoiceOf(p.method) === 'by_quarter' && (
            <option value="by_quarter">{t('methodEarnedQuarterly')}</option>
          )}
          {/* disabled pending engine work — no resignation-earning semantics exist yet */}
          <option value="resignation" disabled title={t('subStep.pendingEngineNote')}>
            {t('subStep.earningResignation')}
          </option>
        </select>
      </Field>
      <p className="text-xs text-muted-foreground">{t('subStep.earningMappingHelp')}</p>
      <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.pendingEngineNote')}</p>
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
  p,
  action,
}: {
  t: ReturnType<typeof useTranslations>;
  p: EntitlementPolicy;
  action: Action;
}) {
  const [carryOn, setCarryOn] = useState<boolean>(carryRuleEnabled(p));
  return (
    <form action={action} className="space-y-2 rounded-lg bg-background p-3">
      <FrontDoorIdentityFields p={p} />
      {/* preserve the method — this front door only edits carry */}
      <input type="hidden" name="method" value={methodValue(p.method)} />
      <input type="hidden" name="carryBlockRendered" value="1" />
      {carryOn && <input type="hidden" name="carryForwardEnabled" value="on" />}
      {!!p.carryForwardIncludeEarned && <input type="hidden" name="carryForwardIncludeEarned" value="on" />}
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
            <input
              name="carryForwardMax"
              type="number"
              min="0"
              step="0.5"
              defaultValue={p.carryForwardMax}
              className={`${inputCls} w-24`}
            />
          </Field>
          <CarryExpiryFields
            t={t}
            mode={p.carryForwardExpiryMode}
            month={p.carryForwardExpiryMonth}
            day={p.carryForwardExpiryDay}
            months={p.carryForwardExpiryMonths}
          />
        </div>
      ) : (
        // None = disabled carry: keep the stored cap/expiry so switching back to Fixed Max restores them.
        <>
          <input type="hidden" name="carryForwardMax" value={p.carryForwardMax} />
          <input
            type="hidden"
            name="carryForwardExpiryMode"
            value={p.carryForwardExpiryMode === 'months' ? 'months' : 'date'}
          />
          {p.carryForwardExpiryMode === 'months' ? (
            <input type="hidden" name="carryForwardExpiryMonths" value={p.carryForwardExpiryMonths ?? ''} />
          ) : (
            <>
              <input type="hidden" name="carryForwardExpiryMonth" value={p.carryForwardExpiryMonth ?? ''} />
              <input type="hidden" name="carryForwardExpiryDay" value={p.carryForwardExpiryDay ?? ''} />
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
 * Leave Entitlement Rules Engine — the service-length band sub-editor. Maintains rows client-side (add /
 * remove) and serializes them into a hidden JSON field + a `serviceBandsRendered=1` marker on submit (the
 * exact carryBlockRendered/carryFlagField precedent — see app/admin/actions.ts's serviceBandsField), so the
 * action can tell "block rendered, editor now empty" (⇒ clear) apart from "block not shown at all" (⇒
 * preserve). Contiguity (first from 0, last open-ended, no gaps) is enforced server-side; this editor keeps
 * the UI simple (from / to / days rows) and lets the server reject a malformed shape with a clear message.
 */
/** Feedback 9d8cf621: the entitlement-rules table row. Extends the engine's `ServiceBand` (from/to/days —
 *  the only fields the resolver reads) with the reporter's per-range config columns. These extra fields ride
 *  the serviceBands JSON untouched (the write-time validator + defensive resolver ignore unknown keys), so
 *  they are captured/persisted per range without a migration or an engine change. */
type BandRow = ServiceBand & {
  carryForwardDays?: number | null;
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  maxBalanceDays?: number | null;
};

const numOrNull = (v: string): number | null => (v === '' ? null : Number(v));

function ServiceBandEditor({ t, initial }: { t: ReturnType<typeof useTranslations>; initial: ServiceBand[] | null | undefined }) {
  const [rows, setRows] = useState<BandRow[]>((initial as BandRow[] | null | undefined) ?? []);

  const update = (i: number, patch: Partial<BandRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));
  const add = () => {
    const lastTo = rows.length > 0 ? rows[rows.length - 1].toYears : null;
    setRows((prev) => [...prev, { fromYears: lastTo ?? 0, toYears: null, days: 0 }]);
  };

  return (
    <div className="w-full space-y-1.5 rounded-lg bg-background p-3 lg:col-span-2">
      <input type="hidden" name="serviceBandsRendered" value="1" />
      <input type="hidden" name="serviceBands" value={JSON.stringify(rows)} />
      <span className="text-xs font-medium text-muted-foreground">{t('serviceBandsLabel')}</span>
      <p className="text-xs text-muted-foreground">{t('serviceBandsHelp')}</p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">{t('serviceBandsEmpty')}</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-1.5 py-1 font-medium">{t('bandColFromYear')}</th>
                <th className="px-1.5 py-1 font-medium">{t('bandColToYear')}</th>
                <th className="px-1.5 py-1 font-medium">{t('bandColEntitledDays')}</th>
                <th className="px-1.5 py-1 font-medium">{t('bandColCarryDays')}</th>
                <th className="px-1.5 py-1 font-medium">{t('bandColCarryExpiry')}</th>
                <th className="px-1.5 py-1 font-medium">{t('bandColMaxBalance')}</th>
                <th className="px-1.5 py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="align-middle">
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      aria-label={t('bandColFromYear')}
                      value={r.fromYears}
                      onChange={(e) => update(i, { fromYears: Number(e.target.value) || 0 })}
                      className={`${inputCls} w-16`}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      aria-label={t('bandColToYear')}
                      value={r.toYears ?? ''}
                      placeholder={t('serviceBandOpenEnded')}
                      onChange={(e) => update(i, { toYears: e.target.value === '' ? null : Number(e.target.value) || 0 })}
                      className={`${inputCls} w-16`}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      aria-label={t('bandColEntitledDays')}
                      value={r.days}
                      onChange={(e) => update(i, { days: Number(e.target.value) || 0 })}
                      className={`${inputCls} w-20`}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      aria-label={t('bandColCarryDays')}
                      value={r.carryForwardDays ?? ''}
                      onChange={(e) => update(i, { carryForwardDays: numOrNull(e.target.value) })}
                      className={`${inputCls} w-20`}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="1"
                        max="12"
                        step="1"
                        aria-label={t('carryExpiryMonthLabel')}
                        placeholder={t('carryExpiryMonthLabel')}
                        value={r.carryForwardExpiryMonth ?? ''}
                        onChange={(e) => update(i, { carryForwardExpiryMonth: numOrNull(e.target.value) })}
                        className={`${inputCls} w-14`}
                      />
                      <span className="text-muted-foreground">/</span>
                      <input
                        type="number"
                        min="1"
                        max="31"
                        step="1"
                        aria-label={t('carryExpiryDayLabel')}
                        placeholder={t('carryExpiryDayLabel')}
                        value={r.carryForwardExpiryDay ?? ''}
                        onChange={(e) => update(i, { carryForwardExpiryDay: numOrNull(e.target.value) })}
                        className={`${inputCls} w-14`}
                      />
                    </div>
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      aria-label={t('bandColMaxBalance')}
                      value={r.maxBalanceDays ?? ''}
                      onChange={(e) => update(i, { maxBalanceDays: numOrNull(e.target.value) })}
                      className={`${inputCls} w-20`}
                    />
                  </td>
                  <td className="px-1.5 py-1 text-right">
                    <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)}>
                      {t('remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button type="button" size="sm" variant="outline" onClick={add} aria-label={t('serviceBandAdd')}>
        {t('bandAddPlus')}
      </Button>
    </div>
  );
}

/**
 * Leave Type Visual Configuration Enhancement (639fdf77): the self-contained visual sub-form — a SEARCHABLE
 * icon picker (filter the curated registry by keyword → clickable grid + live preview, posts `icon`) + a
 * 7-token colour swatch radio (posts `color`) + Save. Own tri-state marker `visual=1` so an unrelated
 * sub-form save never resets the two columns. Both init from the stored values. Purely cosmetic — the picked
 * icon + colour only change how the type LOOKS on the employee Leave tab.
 */
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
export function LeaveTypePanel({
  id,
  name,
  code,
  description,
  paid,
  archived,
  inUse,
  isAnnual,
  floorLabel,
  floor0,
  eligibility,
  durations,
  requiresDocument,
  mandatoryAfterDays,
  allowedMimeTypes,
  maxDocBytes,
  employeeRemarkRequired,
  hrRemarkRequired,
  backdatingLimitDays,
  minAdvanceDays,
  expiryValue,
  expiryUnit,
  customMessages,
  essViewConfig,
  formulaExplanations,
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
  policies,
  grades,
  companies,
  schemeEntitlements,
  benefitSchemeSection,
  festiveGrantSection,
  approvalWorkflowSection,
  halfDaySection,
  gradesSection,
  previewScenarioSection,
  accrualSection,
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  createPolicyAction,
  updatePolicyAction,
  deletePolicyAction,
  countInScopeAction,
  upsertSchemeEntitlementAction,
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
  floorLabel: string | null;
  floor0: number;
  eligibility: LeaveEligibilityRule | null;
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
  /** Leave Entitlement Formula Management (79011509): stored per-component explanation map, threaded so each
   *  component's description / formula / result textareas round-trip their saved value. null / missing key ⇒
   *  no explanation (the employee-panel info icon stays hidden). */
  formulaExplanations: Record<string, LeaveFormulaEntry> | null;
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
  policies: EntitlementPolicy[];
  grades: GradeOption[];
  /** ADR-0066: companies (subsidiaries) for the per-policy company scope select. */
  companies: CompanyOption[];
  /** Restructure (123c1e76): THIS leave type's benefit-scheme entitlement rows (scheme name + service-tier
   *  days + read-only combined-pool cap), rendered in the per-type Entitlement card. The SAME live rows the
   *  shared Benefit Schemes table shows — filtered by leave type, never duplicated. */
  schemeEntitlements: LeaveTypeSchemeEntitlement[];
  /** 6c775d68: the Benefit Schemes management area, scoped to THIS leave type — a server-composed
   *  <BenefitSchemeConfig scopeLeaveTypeId={id}> slot rendered inside the Entitlement step, below the
   *  per-type table. Slot-shaped so the scheme data is prepared ONCE at page level (no N+1 per type). */
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
  /** 7b945408: the Grades catalogue (tenant-wide master data), relocated from the standalone page-bottom
   *  section into the Entitlement step's Benefit Schemes sub-step — a server-composed slot (the 03557e76
   *  CollapsibleCardSection fold + GradeCatalog, marked with the company-wide badge convention). Grades are
   *  per-TENANT (not per-type), so ONE node is prepared at page level and shared by every panel. */
  gradesSection?: ReactNode;
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
  deletePolicyAction: Action;
  /** Feedback 9d8cf621: server action returning the count of active employees the selected
   *  companies/grades cover — drives the live "entitled employees" figure next to the chips. */
  countInScopeAction: (p: { companyIds: string[]; gradeIds: string[] }) => Promise<number>;
  /** Restructure (123c1e76): the SAME upsertSchemeEntitlement action the Benefit Schemes table posts —
   *  the per-type Entitlement card's Edit dialog writes through it, so nothing forks. */
  upsertSchemeEntitlementAction: Action;
}) {
  const t = useTranslations('admin.leave');
  // Sync Employee Leave View Configuration (11876072): the ESS-view checklist group headings reuse the
  // employee panel's OWN section titles (leave.breakdown.section.*) so the admin screen reads as a preview of
  // the panel — same words, same order.
  const tBreakdown = useTranslations('leave.breakdown');
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
  const [editingEligibility, setEditingEligibility] = useState(false);
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

  // Step flow (c979aa8b — was the 123c1e76 five-card accordion): ONE section visible at a time, chosen by
  // the numbered horizontal step bar (1 General … 5 Custom). The active step is per-type client state,
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
      if (parsed && typeof parsed.activeStep === 'string' && (STEP_KEYS as readonly string[]).includes(parsed.activeStep)) {
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
        parsed &&
        typeof parsed.entitlementSubStep === 'string' &&
        (ENTITLEMENT_SUB_STEP_KEYS as readonly string[]).includes(parsed.entitlementSubStep)
      ) {
        setEntitlementSubStep(parsed.entitlementSubStep as EntitlementSubStepKey);
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

  // #25 visibility: a composable human summary of the eligibility rule (avoids a key-per-permutation
  // matrix across 6 locales). e.g. "Female only · ≥ 12 months service", or "Open to all employees".
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
  // Multi-select (#badc5966): join the selected labels for a field with "or" ("Male or Female"), then join
  // fields with a space ("Married Male or Female only"). asEligList tolerates legacy scalar rows.
  const orJoin = (labels: (string | null)[]) => labels.filter(Boolean).join(` ${t('eligibilitySummaryOr')} `);
  const eligibilitySummary = () => {
    const genders = asEligList(eligibility?.gender);
    const maritals = asEligList(eligibility?.maritalStatus);
    // Probation (d6bdbd55) is a separate prop, not inside `eligibility` — fold it into the same "open to all"
    // vs restricted decision so a probation-only rule doesn't read as unrestricted.
    if (
      (!eligibility || (genders.length === 0 && maritals.length === 0 && !eligibility.minServiceMonths)) &&
      !probationEligibility
    ) {
      return t('eligibilityOpenToAll');
    }
    const parts: string[] = [];
    const maritalText = orJoin(maritals.map(maritalLabel));
    const genderText = orJoin(genders.map(genderLabel));
    const who = [maritalText, genderText].filter(Boolean).join(' ');
    if (who) parts.push(t('eligibilitySummaryOnly', { who }));
    if (eligibility?.minServiceMonths) {
      // Min-service unit (#f88f0a63): render "≥ N months/days service". Absent unit ⇒ months (legacy compat).
      const unit = eligibility.minServiceUnit === 'days' ? t('expiryUnitDays') : t('expiryUnitMonths');
      parts.push(t('eligibilitySummaryService', { n: eligibility.minServiceMonths, unit }));
    }
    if (probationEligibility === 'confirmed_only') parts.push(t('eligibilitySummaryConfirmedOnly'));
    else if (probationEligibility === 'probation_only') parts.push(t('eligibilitySummaryProbationOnly'));
    return parts.join(' · ');
  };

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
  const effective = Math.max(floor0, bestActive);
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
          {/* statutory floor (read-only) */}
          <div className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-xs">
            <span className="text-muted-foreground">{t('statutoryMinimum')}</span>
            <span className="tabular-nums">
              {floorLabel ? t('daysValue', { days: floorLabel }) : t('none')}
            </span>
          </div>
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
          {/* Sub-step 2 — Leave Year Type (e1a51aea): a per-TYPE cycle override of the company leave cycle
              (Application Rules tab). Its own sub-form + `yearCycle=1` tri-state marker so an unrelated save
              never resets it. Anniversary-to-Calendar is rendered DISABLED pending engine work (no hybrid-
              year calculation semantics exist — see the plan's GOOD TO KNOW); the service rejects it too. */}
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
                  defaultValue={yearCycleOverride === 'a2a' || yearCycleOverride === 'c2c' ? yearCycleOverride : ''}
                  aria-label={t('subStep.yearTypeLabel')}
                  className={`${inputCls} w-72`}
                >
                  <option value="">{t('subStep.yearTypeCompanyDefault')}</option>
                  <option value="a2a">{t('subStep.yearTypeA2a')}</option>
                  {/* disabled pending engine work — the hybrid year has no calculation semantics yet */}
                  <option value="a2c" disabled title={t('subStep.pendingEngineNote')}>
                    {t('subStep.yearTypeA2c')}
                  </option>
                  <option value="c2c">{t('subStep.yearTypeC2c')}</option>
                </select>
              </Field>
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('subStep.pendingEngineNote')}</p>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('subStep.yearTypeHelp')}</p>
          </div>
          )}
          {/* Sub-step 3 — Earning Method (e1a51aea): a front door to the ACTIVE policy's per-policy method
              (posts the SAME updatePolicyAction as the Eligibility edit form — no new storage; the
              per-policy selects there keep working, the policy row is the single source of truth). */}
          {generalSubStep === 'earning' && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('subStep.earning')}</span>
            <PolicyFrontDoor
              t={t}
              policies={policies}
              renderForm={(p) => <EarningMethodForm t={t} p={p} isAnnual={isAnnual} action={updatePolicyAction} />}
            />
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
              <PolicyFrontDoor
                t={t}
                policies={policies}
                renderForm={(p) => <CarryPolicyForm t={t} p={p} action={updatePolicyAction} />}
              />
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
          {activeStep === 'eligibility' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryEligibilityEntitlement')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-eligibility-${id}`} className="space-y-3">
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
                  {/* Feedback 49809272: editing IN PLACE recalculates affected employees' current-cycle
                      balances automatically — tell the admin before they save. */}
                  <p className="w-full text-[11px] text-muted-foreground">{t('recalcInPlaceHint')}</p>
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
                  {isAnnual ? (
                    <>
                      {/* Carry-forward enhancement: marker lets the action tell "block rendered, checkbox
                          unchecked" (⇒ false) apart from "block not shown" (⇒ leave default). */}
                      <input type="hidden" name="carryBlockRendered" value="1" />
                      <Field label={t('carryEnabledLabel')}>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('carryEnabledHelp')}>
                          <input
                            type="checkbox"
                            name="carryForwardEnabled"
                            defaultChecked={carryRuleEnabled(p)}
                            className="h-4 w-4 rounded border-border"
                          />
                          {t('carryEnabledLabel')}
                        </label>
                      </Field>
                      <Field label={t('carryCapLabel')}>
                        <input
                          name="carryForwardMax"
                          type="number"
                          min="0"
                          step="0.5"
                          defaultValue={p.carryForwardMax}
                          className={`${inputCls} w-24`}
                        />
                      </Field>
                      <CarryExpiryFields
                        t={t}
                        mode={p.carryForwardExpiryMode}
                        month={p.carryForwardExpiryMonth}
                        day={p.carryForwardExpiryDay}
                        months={p.carryForwardExpiryMonths}
                      />
                      <Field label={t('carryIncludeEarnedLabel')}>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('carryIncludeEarnedHelp')}>
                          <input
                            type="checkbox"
                            name="carryForwardIncludeEarned"
                            defaultChecked={!!p.carryForwardIncludeEarned}
                            className="h-4 w-4 rounded border-border"
                          />
                          {t('carryIncludeEarnedHelp')}
                        </label>
                      </Field>
                    </>
                  ) : (
                    <input type="hidden" name="carryForwardMax" value="0" />
                  )}
                  <Field label={t('effectiveFromLabel')}>
                    <input name="validFrom" type="date" required defaultValue={p.validFrom} className={inputCls} />
                  </Field>
                  <Field label={t('accrualMethodLabel')}>
                    <select name="method" defaultValue={methodValue(p.method)} className={`${inputCls} w-40`}>
                      <option value="grant_on_hire_prorated">{t('methodLumpSum')}</option>
                      <option value="earned_monthly">{t('methodEarnedMonthly')}</option>
                      <option value="earned_quarterly">{t('methodEarnedQuarterly')}</option>
                    </select>
                  </Field>
                  {grades.length > 0 && (
                    <Field label={t('gradeLabel')}>
                      <select name="gradeId" defaultValue={p.gradeId ?? ''} className={`${inputCls} w-40`}>
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
                    <select name="companyId" defaultValue={p.companyId ?? ''} className={`${inputCls} w-44`}>
                      <option value="">{t('policyCompanyGroupDefault')}</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <ServiceBandEditor t={t} initial={p.serviceBands} />
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
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditingPolicyId(null)}>
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
                    {isAnnual && p.carryForwardMax > 0 && (
                      <span className="text-muted-foreground">
                        {t('carryCapText', { max: fmt(p.carryForwardMax) })}
                      </span>
                    )}
                    {/* Carry-forward enhancement: a single explicit indicator when carry is disabled —
                        a cap-set-but-disabled policy is otherwise confusing now the toggle exists. */}
                    {isAnnual && !carryRuleEnabled(p) && (
                      <span className={badge.muted}>{t('carryOffText')}</span>
                    )}
                    {/* R4 Build #1: months-mode expiry summary ("expires 3 mo after year-end"). */}
                    {isAnnual &&
                      p.carryForwardMax > 0 &&
                      p.carryForwardExpiryMode === 'months' &&
                      p.carryForwardExpiryMonths != null && (
                        <span className="text-muted-foreground">
                          {t('carryExpiryMonthsText', { months: p.carryForwardExpiryMonths })}
                        </span>
                      )}
                    {isAnnual &&
                      p.carryForwardMax > 0 &&
                      p.carryForwardExpiryMode !== 'months' &&
                      p.carryForwardExpiryMonth != null &&
                      p.carryForwardExpiryDay != null && (
                        <span className="text-muted-foreground">
                          {t('carryExpiryText', { date: `${p.carryForwardExpiryDay}/${p.carryForwardExpiryMonth}` })}
                        </span>
                      )}
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
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingPolicyId(p.id)}>
                      {t('edit')}
                    </Button>
                    <form action={deletePolicyAction}>
                      <input type="hidden" name="id" value={p.id} />
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
              {isAnnual ? (
                <>
                  {/* Carry-forward enhancement: marker + enable toggle (defaults on, matching the cap > 0
                      back-compat convention since a new policy usually sets a cap to enable carry). */}
                  <input type="hidden" name="carryBlockRendered" value="1" />
                  <Field label={t('carryEnabledLabel')}>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('carryEnabledHelp')}>
                      <input
                        type="checkbox"
                        name="carryForwardEnabled"
                        defaultChecked
                        className="h-4 w-4 rounded border-border"
                      />
                      {t('carryEnabledLabel')}
                    </label>
                  </Field>
                  <Field label={t('carryCapLabel')}>
                    <input
                      name="carryForwardMax"
                      type="number"
                      min="0"
                      step="0.5"
                      defaultValue="0"
                      className={`${inputCls} w-24`}
                    />
                  </Field>
                  <CarryExpiryFields t={t} mode="date" />
                  <Field label={t('carryIncludeEarnedLabel')}>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('carryIncludeEarnedHelp')}>
                      <input
                        type="checkbox"
                        name="carryForwardIncludeEarned"
                        className="h-4 w-4 rounded border-border"
                      />
                      {t('carryIncludeEarnedHelp')}
                    </label>
                  </Field>
                </>
              ) : (
                <input type="hidden" name="carryForwardMax" value="0" />
              )}
              <Field label={t('effectiveFromLabel')}>
                <input name="validFrom" type="date" required defaultValue={`${thisYear}-01-01`} className={inputCls} />
              </Field>
              <Field label={t('accrualMethodLabel')}>
                <select name="method" defaultValue="grant_on_hire_prorated" className={`${inputCls} w-40`}>
                  <option value="grant_on_hire_prorated">{t('methodLumpSum')}</option>
                  <option value="earned_monthly">{t('methodEarnedMonthly')}</option>
                  <option value="earned_quarterly">{t('methodEarnedQuarterly')}</option>
                </select>
              </Field>
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
              <ServiceBandEditor t={t} initial={null} />
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
            </CardContent>
          </Card>
          )}
          {activeStep === 'entitlement' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryEntitlement')}</CardTitle>
            </CardHeader>
            <CardContent id={`cat-entitlement-${id}`} className="space-y-3">
          {/* Entitlement sub-flow (7b945408): the SAME reusable SubStepBar the General flow introduced
              (components/leave-sub-step-bar.tsx — the reuse contract) walks the three sub-steps
              1 Benefit Schemes · 2 Service Based Entitlements · 3 Adjustments. One sub-step visible at a
              time; the choice persists per type alongside activeStep/generalSubStep/essSubStep
              (leaveTypeCards:<id>). The entitlement journey reads: who receives which scheme → how
              entitlement is calculated → what manual adjustments apply. */}
          <SubStepBar
            steps={ENTITLEMENT_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(ENTITLEMENT_SUB_STEP_TITLE_KEY[k]) }))}
            active={entitlementSubStep}
            onSelect={(k) => selectEntitlementSubStep(k as EntitlementSubStepKey)}
            ariaLabel={t('entitlementStepsLabel')}
          />
          {/* Sub-step 1 — Benefit Schemes (7b945408): who receives which scheme. The Grades catalogue
              (tenant-wide master data, relocated from the standalone page-bottom section — gradesSection
              slot) leads, then the type-scoped scheme management (6c775d68 — grade groups, schemes,
              per-scheme entitlements, combined limits), so the grade → grade-group → scheme relationship
              is finally visible in one place. Both are server-composed slots; see the prop docs. */}
          {entitlementSubStep === 'schemes' && (
          <>
          {gradesSection}
          {benefitSchemeSection}
          </>
          )}
          {/* Sub-step 2 — Service Based Entitlements (7b945408): how entitlement is calculated. */}
          {entitlementSubStep === 'service' && (
          <>
          {/* Restructure (123c1e76): the per-type Entitlement table — THIS leave type's benefit-scheme
              entitlement rows (the days each scheme grants per service tier), which previously appeared only
              in the shared Benefit Schemes area. Read-and-edit over the SAME live rows via the SAME upsert
              action (no duplication, nothing can drift); scheme-wide management — adding/removing rows,
              copying between schemes, combined-limit grouping — stays in the Benefit Schemes sub-step. */}
          <LeaveTypeEntitlementTable ents={schemeEntitlements} upsertEntitlement={upsertSchemeEntitlementAction} />
          {/* 7b945408: the Preview Scenario checker joins this sub-step as its checking tool — the SAME
              self-contained LeaveRulePreviewDialog (d778d2d3). Server-composed slot; see the
              previewScenarioSection prop doc. */}
          {previewScenarioSection}
          </>
          )}
          {/* Sub-step 3 — Adjustments (7b945408): what manual adjustments apply. */}
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
          {essSubStep === 'criteria' && (
          <>
          {/* #25 visibility — eligibility rules (who can see + apply) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">{t('eligibilityTitle')}</span>
              {!editingEligibility && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditingEligibility(true)}>
                  {t('eligibilityEdit')}
                </Button>
              )}
            </div>
            {editingEligibility ? (
              <form
                action={updateTypeAction}
                className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3"
                onSubmit={() => setEditingEligibility(false)}
              >
                <input type="hidden" name="id" value={id} />
                {/* preserve the name — this form does not edit it */}
                <input type="hidden" name="name" value={name} />
                {/* marker: tells the action to touch the eligibility column (tri-state guard) */}
                <input type="hidden" name="eligibility" value="1" />
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
                  name="gender"
                  label={t('eligibilityGenderLabel')}
                  options={ELIGIBILITY_GENDER_OPTIONS.map((g) => ({ value: g, label: genderLabel(g) ?? g }))}
                  defaultSelected={asEligList(eligibility?.gender)}
                  addPlaceholder={t('eligibilityChipAddPlaceholder')}
                  removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                />
                <ChipMultiSelect
                  name="maritalStatus"
                  label={t('eligibilityMaritalLabel')}
                  options={ELIGIBILITY_MARITAL_OPTIONS.map((m) => ({ value: m, label: maritalLabel(m) ?? m }))}
                  defaultSelected={asEligList(eligibility?.maritalStatus)}
                  addPlaceholder={t('eligibilityChipAddPlaceholder')}
                  removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                />
                <Field label={t('eligibilityMinServiceLabel')}>
                  {/* Min-service unit (#f88f0a63): duration input + a unit select (Months / Days) beside it,
                      mirroring the expiry {value, unit} field. Absent stored unit ⇒ 'months' default so a
                      legacy row shows exactly as before. */}
                  <div className="flex items-center gap-1.5">
                    <input
                      name="minServiceMonths"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={eligibility?.minServiceMonths ?? ''}
                      className={`${inputCls} w-20`}
                    />
                    <select
                      name="minServiceUnit"
                      defaultValue={eligibility?.minServiceUnit ?? 'months'}
                      aria-label={t('eligibilityMinServiceUnitLabel')}
                      className={`${inputCls} w-28`}
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
                    className={`${inputCls} w-56`}
                  >
                    <option value="">{t('eligibilityProbationNone')}</option>
                    <option value="confirmed_only">{t('eligibilityProbationConfirmedOnly')}</option>
                    <option value="probation_only">{t('eligibilityProbationProbationOnly')}</option>
                  </select>
                </Field>
                <p className="w-full text-xs text-muted-foreground">{t('eligibilityMultiHint')}</p>
                <Button type="submit" size="sm">
                  {t('save')}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditingEligibility(false)}>
                  {t('cancel')}
                </Button>
              </form>
            ) : (
              <div className="rounded-lg bg-background px-3 py-2 text-xs text-foreground">{eligibilitySummary()}</div>
            )}
            <p className="text-xs text-muted-foreground">{t('eligibilityHelp')}</p>
            <p className="text-xs text-muted-foreground">{t('eligibilityUndisclosedNote')}</p>
          </div>
          </>
          )}
          {/* Sub-step 2 — Leave Application Rules (08bc6841): the seven existing rule groups, re-laid as
              a responsive card grid instead of the old vertical stack — every sub-form keeps its own edit
              marker (durations=1, document=1, negativeBalance=1, backdating=1, minAdvance=1,
              duplicatePolicy=1, dayTypeInclusion=1) so saves stay per-group, and the EMERGENCY gates on
              backdating/advance-notice are intact. Nothing about the rules themselves changed. The
              relocated company-wide Half-Day Deduction card (halfDaySection slot) completes the grid. */}
          {essSubStep === 'rules' && (
          <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {/* ADR-0048 — allowed leave durations (full day is always available) */}
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('allowedDurationsLabel')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
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
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('documentSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
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
                  className={`${inputCls} w-24`}
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
                  className={`${inputCls} w-24`}
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
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('negativeBalanceSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
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
          {/* Configurable backdated-leave restriction (0133). Its own sub-form (own tri-state) posts
              `backdating=1`. Hidden for Emergency Leave — EL is inherently retroactive and is never guarded,
              so showing the field would let HR set a value that is silently ignored (the EL config-trap). */}
          {code !== 'EMERGENCY' && (
            <div className="space-y-1.5 rounded-lg border border-border p-3">
              <span className="text-xs font-medium text-muted-foreground">{t('backdatingSectionTitle')}</span>
              <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
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
                    className={`${inputCls} w-24`}
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
            <div className="space-y-1.5 rounded-lg border border-border p-3">
              <span className="text-xs font-medium text-muted-foreground">{t('advanceNoticeSectionTitle')}</span>
              <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
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
                    className={`${inputCls} w-24`}
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
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <span className="text-xs font-medium text-muted-foreground">{t('duplicatePolicySectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
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
          <div className="space-y-1.5 rounded-lg border border-border p-3">
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
                className="space-y-2 rounded-lg bg-background p-3"
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
              <div className="rounded-lg bg-background px-3 py-2 text-xs text-foreground">
                {dayTypeInclusionSummary()}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('dayTypeInclusion.help')}</p>
            <p className="text-xs text-muted-foreground">{t('dayTypeInclusion.statutoryNote')}</p>
          </div>
          {/* 08bc6841: the relocated company-wide Half-Day Deduction card — see the halfDaySection prop. */}
          {halfDaySection}
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
          {/* Restructure (123c1e76): the former "Leave Information Display" card's four sub-forms (ESS view
              checklist, formula explanations, employee visibility, ESS placement) now live INSIDE the Custom
              Settings card — every sub-form below is byte-identical, only the card wrapper changed. */}
          {/* Employee Leave View Configuration (65dec703 / dup 1fedb473). Its own self-contained sub-form
              (own tri-state) posts `essView=1` — a checklist of the breakdown components an employee sees in
              My Profile → Leave for THIS leave type. An unchecked box does not post; the action rebuilds the
              full { key: boolean } map from the closed key list, so unticked ⇒ hidden in ESS. Gating applies
              to /me only — admin/HR always see everything. null/missing ⇒ visible (backward compatible).
              Sync (11876072): the checkboxes are no longer a flat grid — they are GROUPED into the same
              sections, in the same order, the employee breakdown panel shows (ESS_VIEW_CHECKLIST_GROUPS is
              derived from ENTITLEMENT_PANEL_SECTIONS, the panel's own descriptor, so the two cannot drift).
              Keys no panel section references land in a trailing "Other" group. Same keys, same effects —
              only the arrangement changed. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('essView.sectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the ess_view_config column (tri-state guard) */}
              <input type="hidden" name="essView" value="1" />
              <div className="space-y-3">
                {ESS_VIEW_CHECKLIST_GROUPS.map((group) => (
                  <fieldset key={group.key} className="space-y-1.5">
                    {/* Heading = the panel section's own title (leave.breakdown.section.*); the orphan group
                        uses the admin-side "Other" label. */}
                    <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.labelKey ? tBreakdown(group.labelKey) : t('essView.groupOther')}
                    </legend>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {group.keys.map((key) => (
                        <label key={key} className="flex items-center gap-2 text-xs text-foreground">
                          <input
                            type="checkbox"
                            name={`essView_${key}`}
                            defaultChecked={essViewConfig?.[key] !== false}
                            className="size-3.5 rounded border-border"
                          />
                          {t(`essView.${key}`)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('essView.help')}</p>
          </div>
          {/* Leave Entitlement Formula Management (79011509). Its own self-contained sub-form (own tri-state)
              posts `formula=1` — an HR-owned, per-component plain-language explanation store surfaced to
              employees on the leave breakdown panel (feedback b8b665ff shows it behind a per-row info icon).
              Each of the seven §7 calculation components is an expand/collapse block with a short Description
              and a free-text Formula explanation (plus an optional Result/date note). Explanation layer only —
              editing these NEVER changes any entitlement figure. Empty fields are dropped by the service; an
              all-blank map clears the column. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('formula.sectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the formula_explanations column (tri-state guard) */}
              <input type="hidden" name="formula" value="1" />
              <div className="space-y-1.5">
                {LEAVE_FORMULA_COMPONENT_KEYS.map((key) => {
                  const entry = formulaExplanations?.[key];
                  const configured = !!(entry && (entry.description || entry.formula || entry.result));
                  return (
                    <details key={key} open={configured} className="rounded-md border border-border">
                      <summary className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-xs font-medium text-foreground">
                        <span>{t(`formula.component.${key}`)}</span>
                        {configured && <span className="text-[10px] font-normal text-primary">{t('formula.configured')}</span>}
                      </summary>
                      <div className="space-y-2 border-t border-border px-2.5 py-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('formula.descriptionLabel')}
                          <textarea
                            name={`formula_${key}_description`}
                            defaultValue={entry?.description ?? ''}
                            rows={2}
                            className={`${inputCls} text-xs`}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('formula.formulaLabel')}
                          <textarea
                            name={`formula_${key}_formula`}
                            defaultValue={entry?.formula ?? ''}
                            rows={2}
                            className={`${inputCls} text-xs`}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('formula.resultLabel')}
                          <input
                            name={`formula_${key}_result`}
                            defaultValue={entry?.result ?? ''}
                            className={`${inputCls} text-xs`}
                          />
                        </label>
                      </div>
                    </details>
                  );
                })}
              </div>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('formula.help')}</p>
          </div>
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
