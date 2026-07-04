'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ServiceBand } from '@/core/leave-compute';
import { Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

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

/** #25 visibility: who may see + apply for this type. null = open to all. */
export type LeaveEligibilityRule = {
  gender?: string;
  maritalStatus?: string;
  minServiceMonths?: number;
};

/** ADR-0048: the four non-full-day durations an admin can enable on a leave type. */
const DURATION_OPTIONS = ['half_day_am', 'half_day_pm', 'hourly'] as const;

/** Supporting-document config: the closed set of allowed mime types (PDF / JPG / PNG). */
const DOC_MIME_OPTIONS = [
  { mime: 'application/pdf', label: 'fileTypePdf' as const },
  { mime: 'image/jpeg', label: 'fileTypeJpg' as const },
  { mime: 'image/png', label: 'fileTypePng' as const },
] as const;

const isEarned = (m?: string) => m === 'earned_monthly' || m === 'earned_quarterly';
/** Normalise to a select value: earned methods pass through, everything else is the lump option. */
const methodValue = (m?: string) => (isEarned(m) ? m! : 'grant_on_hire_prorated');

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

/**
 * Leave Entitlement Rules Engine — the service-length band sub-editor. Maintains rows client-side (add /
 * remove) and serializes them into a hidden JSON field + a `serviceBandsRendered=1` marker on submit (the
 * exact carryBlockRendered/carryFlagField precedent — see app/admin/actions.ts's serviceBandsField), so the
 * action can tell "block rendered, editor now empty" (⇒ clear) apart from "block not shown at all" (⇒
 * preserve). Contiguity (first from 0, last open-ended, no gaps) is enforced server-side; this editor keeps
 * the UI simple (from / to / days rows) and lets the server reject a malformed shape with a clear message.
 */
function ServiceBandEditor({ t, initial }: { t: ReturnType<typeof useTranslations>; initial: ServiceBand[] | null | undefined }) {
  const [rows, setRows] = useState<ServiceBand[]>(initial ?? []);

  const update = (i: number, patch: Partial<ServiceBand>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));
  const add = () => {
    const lastTo = rows.length > 0 ? rows[rows.length - 1].toYears : null;
    setRows((prev) => [...prev, { fromYears: lastTo ?? 0, toYears: null, days: 0 }]);
  };

  return (
    <div className="space-y-1.5 rounded-lg bg-background p-3">
      <input type="hidden" name="serviceBandsRendered" value="1" />
      <input type="hidden" name="serviceBands" value={JSON.stringify(rows)} />
      <span className="text-xs font-medium text-muted-foreground">{t('serviceBandsLabel')}</span>
      <p className="text-xs text-muted-foreground">{t('serviceBandsHelp')}</p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">{t('serviceBandsEmpty')}</p>}
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t('serviceBandFrom')}</span>
          <input
            type="number"
            min="0"
            step="1"
            value={r.fromYears}
            onChange={(e) => update(i, { fromYears: Number(e.target.value) || 0 })}
            className={`${inputCls} w-16`}
          />
          <span className="text-xs text-muted-foreground">{t('serviceBandTo')}</span>
          <input
            type="number"
            min="0"
            step="1"
            value={r.toYears ?? ''}
            placeholder={t('serviceBandOpenEnded')}
            onChange={(e) => update(i, { toYears: e.target.value === '' ? null : Number(e.target.value) || 0 })}
            className={`${inputCls} w-16`}
          />
          <span className="text-xs text-muted-foreground">{t('serviceBandDays')}</span>
          <input
            type="number"
            min="0"
            step="0.5"
            value={r.days}
            onChange={(e) => update(i, { days: Number(e.target.value) || 0 })}
            className={`${inputCls} w-20`}
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)}>
            {t('remove')}
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={add}>
        {t('serviceBandAdd')}
      </Button>
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
  customMessages,
  paid,
  sendToPayroll,
  counting,
  perDateApproval,
  policies,
  grades,
  companies,
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  createPolicyAction,
  updatePolicyAction,
  deletePolicyAction,
}: {
  id: string;
  name: string;
  code: string;
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
  /** Custom validation messages (custom-messages migration): admin-authored override text keyed by rule config
   *  field (currently only `backdatingLimitDays`). Threaded so the "Custom system message" textarea round-trips.
   *  null / absent key = show the built-in localized default. */
  customMessages: Record<string, string> | null;
  /** Whether this type is paid — drives the read-only "Affects payroll deduction" display (derived = !paid). */
  paid: boolean;
  /** Unpaid payroll-impact: emit the on-approval payroll signal. Editable in the "Payroll impact" sub-form. */
  sendToPayroll: boolean;
  /** How this type is counted ('working_days' | 'calendar_days'). Partial approval only fires for
   *  working_days types — threaded so the per-date toggle can warn when it won't apply. */
  counting: string;
  /** Partial Leave Approval (ADR-0068): whether managers can approve/reject individual dates within a
   *  multi-day request. Editable in the "Per-date approval" sub-form. */
  perDateApproval: boolean;
  policies: EntitlementPolicy[];
  grades: GradeOption[];
  /** ADR-0066: companies (subsidiaries) for the per-policy company scope select. */
  companies: CompanyOption[];
  updateTypeAction: Action;
  archiveTypeAction: Action;
  deleteTypeAction: Action;
  createPolicyAction: Action;
  updatePolicyAction: Action;
  deletePolicyAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingEligibility, setEditingEligibility] = useState(false);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // #25 visibility: a composable human summary of the eligibility rule (avoids a key-per-permutation
  // matrix across 6 locales). e.g. "Female only · ≥ 12 months service", or "Open to all employees".
  const genderLabel = (g?: string) =>
    g === 'male' ? t('eligibilityGenderMale') : g === 'female' ? t('eligibilityGenderFemale') : null;
  const maritalLabel = (m?: string) =>
    m === 'single'
      ? t('eligibilityMaritalSingle')
      : m === 'married'
        ? t('eligibilityMaritalMarried')
        : m === 'other'
          ? t('eligibilityMaritalOther')
          : null;
  const eligibilitySummary = () => {
    if (!eligibility || (!eligibility.gender && !eligibility.maritalStatus && !eligibility.minServiceMonths)) {
      return t('eligibilityOpenToAll');
    }
    const parts: string[] = [];
    const who = [maritalLabel(eligibility.maritalStatus), genderLabel(eligibility.gender)].filter(Boolean).join(' ');
    if (who) parts.push(t('eligibilitySummaryOnly', { who }));
    if (eligibility.minServiceMonths) parts.push(t('eligibilitySummaryService', { n: eligibility.minServiceMonths }));
    return parts.join(' · ');
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
    <li id={`type-${id}`} className={archived ? 'opacity-60' : ''}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <svg
            viewBox="0 0 20 20"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
          >
            <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">{code}</span>
          {archived && <span className={badge.muted}>{t('archivedBadge')}</span>}
        </button>

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

      {expanded && (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3">
          {/* type-level controls */}
          {editingName ? (
            <form action={updateTypeAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={id} />
              <input name="name" defaultValue={name} aria-label={t('nameLabel')} className={`${inputCls} w-52`} />
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditingName(false)}>
                {t('cancel')}
              </Button>
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
                <Field label={t('eligibilityGenderLabel')}>
                  <select name="gender" defaultValue={eligibility?.gender ?? ''} className={`${inputCls} w-36`}>
                    <option value="">{t('eligibilityGenderAny')}</option>
                    <option value="male">{t('eligibilityGenderMale')}</option>
                    <option value="female">{t('eligibilityGenderFemale')}</option>
                  </select>
                </Field>
                <Field label={t('eligibilityMaritalLabel')}>
                  <select
                    name="maritalStatus"
                    defaultValue={eligibility?.maritalStatus ?? ''}
                    className={`${inputCls} w-36`}
                  >
                    <option value="">{t('eligibilityMaritalAny')}</option>
                    <option value="single">{t('eligibilityMaritalSingle')}</option>
                    <option value="married">{t('eligibilityMaritalMarried')}</option>
                    <option value="other">{t('eligibilityMaritalOther')}</option>
                  </select>
                </Field>
                <Field label={t('eligibilityMinServiceLabel')}>
                  <div className="flex items-center gap-1.5">
                    <input
                      name="minServiceMonths"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={eligibility?.minServiceMonths ?? ''}
                      className={`${inputCls} w-20`}
                    />
                    <span className="text-xs text-muted-foreground">{t('eligibilityMinServiceSuffix')}</span>
                  </div>
                </Field>
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

          {/* ADR-0048 — allowed leave durations (full day is always available) */}
          <div className="space-y-1.5">
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
          <div className="space-y-1.5">
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

          {/* Payroll impact — the two checkboxes the feedback names. "Affects payroll deduction" is read-only,
              derived from !paid (no second stored column); only "Send to payroll module" is editable. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('payrollImpactSectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the send_to_payroll column (tri-state guard) */}
              <input type="hidden" name="payrollImpact" value="1" />
              {/* derived, informational, NOT posted — the disabled checkbox reflects whether the type is paid */}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={!paid} disabled className="size-3.5 rounded border-border" />
                {t('affectsPayrollDeductionLabel')}
              </label>
              <p className="text-xs text-muted-foreground">{t('affectsPayrollDeductionHelp')}</p>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  name="sendToPayroll"
                  defaultChecked={sendToPayroll}
                  className="size-3.5 rounded border-border"
                />
                {t('sendToPayrollLabel')}
              </label>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('payrollImpactHelp')}</p>
          </div>

          {/* Partial Leave Approval (ADR-0068). Its own sub-form (own tri-state) posts `partialApproval=1`.
              The feature only fires for FULL-DAY, WORKING-DAYS-counted, non-REPLACEMENT types in a company
              whose leave approval chain is single-step; when the type can never satisfy that, we still let the
              admin set the flag but show a greyed note explaining it won't apply (rather than silently no-op). */}
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

          {/* Configurable backdated-leave restriction (0133). Its own sub-form (own tri-state) posts
              `backdating=1`. Hidden for Emergency Leave — EL is inherently retroactive and is never guarded,
              so showing the field would let HR set a value that is silently ignored (the EL config-trap). */}
          {code !== 'EMERGENCY' && (
            <div className="space-y-1.5">
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
              {grades.length > 0 && (
                <Field label={t('gradeLabel')}>
                  <select name="gradeId" defaultValue="" className={`${inputCls} w-40`}>
                    <option value="">{t('gradeAll')}</option>
                    {grades.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {/* ADR-0066: per-company scope on a new entitlement. */}
              <Field label={t('policyCompanyLabel')}>
                <select name="companyId" defaultValue="" className={`${inputCls} w-44`}>
                  <option value="">{t('policyCompanyGroupDefault')}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <ServiceBandEditor t={t} initial={null} />
              <Button type="submit" size="sm">
                {t('add')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>
                {t('cancel')}
              </Button>
            </form>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
              {t('addEntitlement')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
