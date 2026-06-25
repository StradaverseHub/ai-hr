'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

export type EntitlementPolicy = {
  id: string;
  annualDays: number;
  carryForwardMax: number;
  /** ADR-0038 carry-forward expiry: month/day the carried-forward portion auto-forfeits; null = never. */
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  /** Accrual cadence (ADR-0040): 'earned_monthly' | 'earned_quarterly' earn through the year; anything
   *  else is a lump grant at hire / year-open. */
  method?: string;
  /** Grade this policy applies to (ADR-0041 2E); null = all grades (company default). */
  gradeId?: string | null;
  gradeName?: string | null;
  validFrom: string;
  validTo: string | null;
};

export type GradeOption = { id: string; name: string };

/** #25 visibility: who may see + apply for this type. null = open to all. */
export type LeaveEligibilityRule = {
  gender?: string;
  maritalStatus?: string;
  minServiceMonths?: number;
};

/** ADR-0048: the four non-full-day durations an admin can enable on a leave type. */
const DURATION_OPTIONS = ['half_day_am', 'half_day_pm', 'hourly'] as const;

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
  policies,
  grades,
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
  policies: EntitlementPolicy[];
  grades: GradeOption[];
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
  const bestActive = active.reduce((m, p) => Math.max(m, p.annualDays), 0);
  const effective = Math.max(floor0, bestActive);
  const belowFloor = active.length > 0 && bestActive < floor0;
  const above = active.length > 0 && bestActive > floor0;
  const thisYear = new Date().getUTCFullYear();

  return (
    <li className={archived ? 'opacity-60' : ''}>
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
            {effective > 0
              ? t.rich('daysPerYear', {
                  days: fmt(effective),
                  b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
                })
              : '—'}
          </span>
          {belowFloor && <span className={badge.amber}>{t('belowMinimumBadge')}</span>}
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
                      <Field label={t('carryExpiryLabel')}>
                        <div className="flex items-center gap-1.5">
                          <input
                            name="carryForwardExpiryMonth"
                            type="number"
                            min="1"
                            max="12"
                            step="1"
                            aria-label={t('carryExpiryMonthLabel')}
                            placeholder={t('carryExpiryMonthLabel')}
                            defaultValue={p.carryForwardExpiryMonth ?? ''}
                            className={`${inputCls} w-16`}
                          />
                          <span className="text-xs text-muted-foreground">/</span>
                          <input
                            name="carryForwardExpiryDay"
                            type="number"
                            min="1"
                            max="31"
                            step="1"
                            aria-label={t('carryExpiryDayLabel')}
                            placeholder={t('carryExpiryDayLabel')}
                            defaultValue={p.carryForwardExpiryDay ?? ''}
                            className={`${inputCls} w-16`}
                          />
                        </div>
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
                    {isAnnual &&
                      p.carryForwardMax > 0 &&
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
                  <Field label={t('carryExpiryLabel')}>
                    <div className="flex items-center gap-1.5">
                      <input
                        name="carryForwardExpiryMonth"
                        type="number"
                        min="1"
                        max="12"
                        step="1"
                        aria-label={t('carryExpiryMonthLabel')}
                        placeholder={t('carryExpiryMonthLabel')}
                        className={`${inputCls} w-16`}
                      />
                      <span className="text-xs text-muted-foreground">/</span>
                      <input
                        name="carryForwardExpiryDay"
                        type="number"
                        min="1"
                        max="31"
                        step="1"
                        aria-label={t('carryExpiryDayLabel')}
                        placeholder={t('carryExpiryDayLabel')}
                        className={`${inputCls} w-16`}
                      />
                    </div>
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
