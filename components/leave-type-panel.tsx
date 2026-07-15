'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { ServiceBand } from '@/core/leave-compute';
import { ESS_VIEW_COMPONENT_KEYS } from '@/core/ess-view';
import { resolvePlacement, ESS_PLACEMENTS } from '@/lib/leave-groups';
import { Search, ChevronRight } from 'lucide-react';
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
  dayTypeInclusion,
  color,
  icon,
  leaveUnit,
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
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  createPolicyAction,
  updatePolicyAction,
  deletePolicyAction,
  countInScopeAction,
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
  updateTypeAction: Action;
  archiveTypeAction: Action;
  deleteTypeAction: Action;
  createPolicyAction: Action;
  updatePolicyAction: Action;
  deletePolicyAction: Action;
  /** Feedback 9d8cf621: server action returning the count of active employees the selected
   *  companies/grades cover — drives the live "entitled employees" figure next to the chips. */
  countInScopeAction: (p: { companyIds: string[]; gradeIds: string[] }) => Promise<number>;
}) {
  const t = useTranslations('admin.leave');
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
  const [expanded, setExpanded] = useState(false);
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

  // Leave Type master page (feedback 097de541): the master table's Edit action links to #type-<id>; expand
  // this row when the URL hash targets it (on mount and on later hashchange) so the edit surface is visible
  // rather than scrolling to a collapsed row.
  useEffect(() => {
    const openIfTargeted = () => {
      if (typeof window !== 'undefined' && window.location.hash === `#type-${id}`) setExpanded(true);
    };
    openIfTargeted();
    window.addEventListener('hashchange', openIfTargeted);
    return () => window.removeEventListener('hashchange', openIfTargeted);
  }, [id]);

  // Collapsible category panels (f623d50a): each of the 7 category cards inside the expanded row is an
  // independent accordion. Open/closed state is per-card client state, keyed by the leave-type id so two open
  // rows don't share it. It is persisted to localStorage so it SURVIVES the stay-on-save redirect (b9dac2d1
  // keystone re-mounts the panel on the entitlements tab) — the section HR was editing stays open after Save.
  // Default = all collapsed for the compact view; hydrate from storage in an effect (client-only ⇒ no SSR
  // hydration mismatch; a brief closed→restored flash is acceptable).
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`leaveTypeCards:${id}`);
      if (raw) setOpenCards(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* storage unavailable / malformed ⇒ keep all collapsed */
    }
  }, [id]);
  const toggleCard = (key: string) =>
    setOpenCards((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(`leaveTypeCards:${id}`, JSON.stringify(next));
      } catch {
        /* storage write blocked ⇒ runtime toggle still works, just not persisted */
      }
      return next;
    });
  const cardHeaderBtn =
    'flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40';

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
    if (!eligibility || (genders.length === 0 && maritals.length === 0 && !eligibility.minServiceMonths)) {
      return t('eligibilityOpenToAll');
    }
    const parts: string[] = [];
    const maritalText = orJoin(maritals.map(maritalLabel));
    const genderText = orJoin(genders.map(genderLabel));
    const who = [maritalText, genderText].filter(Boolean).join(' ');
    if (who) parts.push(t('eligibilitySummaryOnly', { who }));
    if (eligibility.minServiceMonths) {
      // Min-service unit (#f88f0a63): render "≥ N months/days service". Absent unit ⇒ months (legacy compat).
      const unit = eligibility.minServiceUnit === 'days' ? t('expiryUnitDays') : t('expiryUnitMonths');
      parts.push(t('eligibilitySummaryService', { n: eligibility.minServiceMonths, unit }));
    }
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
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('general')} aria-expanded={!!openCards.general} aria-controls={`cat-general-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryGeneral')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.general && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.general && (
            <CardContent id={`cat-general-${id}`} className="space-y-3">
          {/* type-level controls */}
          {editingName ? (
            <form
              action={updateTypeAction}
              /* 6ef6e355 — responsive grid re-layout. Was a single `flex flex-wrap items-end gap-2` row where the
                 Paid checkbox sat wedged between text inputs and Description was a fixed oversized box. Now a
                 breakpoint-aware grid: 1 col (mobile) → 2 (sm) → 4 (lg). Compact fields pack the top row, Paid is
                 pushed to the far-right cell, Description spans the full width and flows fluid, and Save/Cancel get
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
                  Paid so the compact fields pack the first grid row and Paid lands in the last (right-most) cell. */}
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
              <Field label={t('leaveUnitLabel')}>
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
                  6ef6e355: pushed to the right edge of its cell (`justify-self-end`) so it no longer sits squeezed
                  between text inputs. */}
              <Field label={t('paidLabel')} className="justify-self-end">
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
            </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('eligibility')} aria-expanded={!!openCards.eligibility} aria-controls={`cat-eligibility-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryEligibilityEntitlement')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.eligibility && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.eligibility && (
            <CardContent id={`cat-eligibility-${id}`} className="space-y-3">
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
                {/* Multi-select (#badc5966 → 2cc30077): compact ChipMultiSelect pickers per field, posting
                    repeated name="gender" / name="maritalStatus" (one hidden input per value — identical
                    FormData shape to the old checkbox group, so updateLeaveTypeAction's getAll() is unchanged).
                    An employee qualifies if their attribute matches ANY selected value; select nothing ⇒ no
                    restriction on that field (open to all). Select-all / clear-all + a collapsed "All selected"
                    / "{n} selected" summary keep the editor tidy as the option lists grow. */}
                <Field label={t('eligibilityGenderLabel')}>
                  <ChipMultiSelect
                    name="gender"
                    options={ELIGIBILITY_GENDER_OPTIONS.map((g) => ({ value: g, label: genderLabel(g) ?? g }))}
                    defaultSelected={asEligList(eligibility?.gender)}
                    addPlaceholder={t('eligibilityChipAddPlaceholder')}
                    removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                    selectAllLabel={t('eligibilitySelectAll')}
                    clearAllLabel={t('eligibilityClearAll')}
                    allSelectedLabel={t('eligibilityAllSelected')}
                    countLabelFor={(n) => t('eligibilityNSelected', { count: n })}
                  />
                </Field>
                <Field label={t('eligibilityMaritalLabel')}>
                  <ChipMultiSelect
                    name="maritalStatus"
                    options={ELIGIBILITY_MARITAL_OPTIONS.map((m) => ({ value: m, label: maritalLabel(m) ?? m }))}
                    defaultSelected={asEligList(eligibility?.maritalStatus)}
                    addPlaceholder={t('eligibilityChipAddPlaceholder')}
                    removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                    selectAllLabel={t('eligibilitySelectAll')}
                    clearAllLabel={t('eligibilityClearAll')}
                    allSelectedLabel={t('eligibilityAllSelected')}
                    countLabelFor={(n) => t('eligibilityNSelected', { count: n })}
                  />
                </Field>
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
            </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('ess')} aria-expanded={!!openCards.ess} aria-controls={`cat-ess-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryEssPolicy')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.ess && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.ess && (
            <CardContent id={`cat-ess-${id}`} className="space-y-3">
          {/* Feedback 9d8cf621: the "Payroll impact" controls moved to the Payroll Related tab (per-type list
              there). Both were self-contained sub-forms, so moving/removing them here never touches any other
              column on save. */}
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
          {/* Configurable Negative Leave Balance Validation (0ef0defd). Its own self-contained <form> +
              `negativeBalance=1` tri-state marker so an unrelated save never resets it. A Yes/No radio controls
              whether an employee may submit (or edit) a leave application whose days exceed their available
              balance. Default 'No' = block over-application at submit + edit (core/leave.ts); 'Yes' permits
              going negative (the approval-time guard still applies). */}
          <div className="space-y-1.5">
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
          {/* Minimum advance-notice rule (0159 / feedback 0b0fb6c3). Its own sub-form (own tri-state) posts
              `minAdvance=1`, mirroring the backdating block above. Hidden for Emergency Leave — EL exists
              precisely for short-notice absence and is never guarded (it decomposes before the gate), so
              showing the field would let HR set a value that is silently ignored (the EL config-trap). */}
          {code !== 'EMERGENCY' && (
            <div className="space-y-1.5">
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
          <div className="space-y-1.5">
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
            </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('approval')} aria-expanded={!!openCards.approval} aria-controls={`cat-approval-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryApproval')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.approval && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.approval && (
            <CardContent id={`cat-approval-${id}`} className="space-y-3">
          {/* Partial Leave Approval (ADR-0068 · re-added ac6c2025). Its own sub-form (own tri-state) posts
              `partialApproval=1`, so a rename / eligibility / durations / document / payroll / backdating edit
              that omits the marker leaves per_date_approval untouched. This is the HR-facing enable switch for
              the per-date approval modal that is already live on the approvals inbox — previously removable only
              via seed data after feedback 9d8cf621 dropped this toggle. Backend wiring (app/admin/actions.ts
              touchPartial + core/admin.ts) was left intact; this restores the surface that drives it.
              The feature only fires for FULL-DAY, WORKING-DAYS-counted, non-REPLACEMENT types in a company whose
              leave approval chain is single-step; when the type can never satisfy that, we still let the admin
              set the flag but show a greyed note explaining it won't apply (rather than silently no-op). */}
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
            </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('display')} aria-expanded={!!openCards.display} aria-controls={`cat-display-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryDisplay')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.display && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.display && (
            <CardContent id={`cat-display-${id}`} className="space-y-3">
          {/* Employee Leave View Configuration (65dec703 / dup 1fedb473). Its own self-contained sub-form
              (own tri-state) posts `essView=1` — a checklist of the breakdown components an employee sees in
              My Profile → Leave for THIS leave type. An unchecked box does not post; the action rebuilds the
              full { key: boolean } map from the closed key list, so unticked ⇒ hidden in ESS. Gating applies
              to /me only — admin/HR always see everything. null/missing ⇒ visible (backward compatible). */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('essView.sectionTitle')}</span>
            <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
              <input type="hidden" name="id" value={id} />
              {/* preserve the name — this form does not edit it */}
              <input type="hidden" name="name" value={name} />
              {/* marker: tells the action to touch the ess_view_config column (tri-state guard) */}
              <input type="hidden" name="essView" value="1" />
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {ESS_VIEW_COMPONENT_KEYS.map((key) => (
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
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('essView.help')}</p>
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
            </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('calculation')} aria-expanded={!!openCards.calculation} aria-controls={`cat-calculation-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryCalculation')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.calculation && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.calculation && (
            <CardContent id={`cat-calculation-${id}`} className="space-y-3">
          {/* Day Type Inclusion (feedback ef6d7146) — five independent toggles deciding which day types are
              counted when calculating a leave's duration. Lives inside Eligibility Rules (reporter's request),
              its own self-contained <form> + `dayTypeInclusion=1` tri-state marker so an unrelated save never
              resets it. Simple toggle list — no matrix — matching the reporter's UX ask. */}
          <div className="space-y-1.5">
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
            </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader className="p-0">
              <button type="button" onClick={() => toggleCard('custom')} aria-expanded={!!openCards.custom} aria-controls={`cat-custom-${id}`} className={cardHeaderBtn}>
                <CardTitle>{t('categoryCustom')}</CardTitle>
                <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', openCards.custom && 'rotate-90')} />
              </button>
            </CardHeader>
            {openCards.custom && (
            <CardContent id={`cat-custom-${id}`} className="space-y-3">
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
            )}
          </Card>
        </div>
      )}
    </li>
  );
}
