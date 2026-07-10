'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, Field, inputCls, btnPrimary } from '@/components/ui';
import { createPolicyAction, updatePolicyAction } from './actions';

/**
 * 61d77e82 — Payroll Policies configuration wizard. Replaces the single long General-Settings form with a
 * guided 9-step stepper (Policy Information → Cut-Off Window → Salary Proration → Salary Configuration →
 * Negative Net Pay → Overtime → Leave Calculation → Rounding → Review & Save). Mirrors the process/wizard.tsx
 * stepper pattern (numbered header, Previous/Next, plain useState — no workflow engine).
 *
 * The calculation is UNCHANGED: this is purely a re-layout of the SAME fields. All steps live inside ONE
 * <form> and are shown/hidden with the `hidden` attribute, so a native submit posts EVERY field regardless of
 * which step is visible (this is the "submit all fields, not just visited steps" guard from the plan). The
 * field NAMES are byte-identical to the old form, so the server's configFromForm / payRuleFromForm build the
 * exact same config blob. Per-step client validation gates Next/Save; the server (cleanName / resolveRule /
 * cleanPayrollPolicyConfig) stays authoritative.
 */

type Company = { id: string; name: string };
type PayComponent = { id: string; name: string; code: string };
type PreviewRow = { type: string; start: string; end: string };
type SchedulePeriod = { seq: number; start: string; end: string };

export type WizardPolicy = {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  policyType: string;
  status: string;
  payRule: { kind?: string; rate?: number; onlyPullHoursWithinShiftSchedule?: boolean } | null;
  config: Record<string, unknown> | null;
};

export type WizardCutOff = {
  mode?: string;
  anchorDay?: number;
  perType?: Record<string, number | undefined>;
  perFrequency?: Record<string, { anchorDay?: number; perType?: Record<string, number | undefined> }>;
} | null;

const STEP_KEYS = [
  'info',
  'cutOff',
  'proration',
  'salary',
  'negativeNet',
  'overtime',
  'leave',
  'rounding',
  'review',
] as const;
const REVIEW = STEP_KEYS.length - 1;

const ROUNDING_OPTS = ['none', 'up', 'down', 'nearest'] as const;
const LEAVE_DIVISORS = ['calendar_month', 'custom_days', 'cutoff_days', 'working_days'] as const;
const TIME_OFF_DIVISORS = [...LEAVE_DIVISORS, 'custom_hours', 'custom_minutes'] as const;

export function PolicyWizard({
  mode,
  editing,
  companies,
  payComponents,
  policyTypes,
  enabledTypes,
  cutOffPerTypes,
  payrollFrequencies,
  editingFrequency,
  editingCutOff,
  cutOffPreview,
  schedulePreview,
  previewPeriod,
  anchorMin,
  anchorMax,
  cancelHref,
}: {
  mode: 'create' | 'edit';
  editing: WizardPolicy | null;
  companies: Company[];
  payComponents: PayComponent[];
  policyTypes: readonly string[];
  enabledTypes: string[];
  cutOffPerTypes: readonly string[];
  payrollFrequencies: readonly string[];
  editingFrequency: string;
  editingCutOff: WizardCutOff;
  cutOffPreview: PreviewRow[];
  schedulePreview: { frequency: string; periods: SchedulePeriod[] };
  previewPeriod: string;
  anchorMin: number;
  anchorMax: number;
  cancelHref: string;
}) {
  const t = useTranslations('payrollPolicy');
  const enabled = useMemo(() => new Set(enabledTypes), [enabledTypes]);
  const cfg = editing?.config ?? null;
  const g = <T,>(path: string, fallback: T): T => {
    // Read a nested value from the editing config for a prefill default; missing ⇒ fallback (today's behaviour).
    const parts = path.split('.');
    let cur: unknown = cfg;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return fallback;
      cur = (cur as Record<string, unknown>)[p];
    }
    return (cur ?? fallback) as T;
  };
  const num = (v: unknown): string => (v === undefined || v === null || v === '' ? '' : String(v));

  const editingCutOffCustom = editingCutOff?.mode === 'custom';
  const editingPerType = editingCutOff?.perType;
  const editingPerFrequency = editingCutOff?.perFrequency;

  const cfgPror = g<Record<string, unknown> | null>('proration', null);
  const cfgHire = g<Record<string, unknown> | null>('prorationHire', null);
  const cfgResign = g<Record<string, unknown> | null>('prorationResign', null);
  const cfgOt = g<Record<string, unknown> | null>('overtime', null);
  const cfgLeave = g<Record<string, unknown> | null>('leave', null);
  const cfgRound = g<Record<string, unknown> | null>('rounding', null);
  const otDayTypes = (cfgOt?.eligibleDayTypes as string[] | undefined) ?? undefined;
  const dayChecked = (d: string) => (otDayTypes ? otDayTypes.includes(d) : true);
  const otExceedConvert = (cfgOt?.exceedHandling as { action?: string } | undefined)?.action === 'convert';
  const otExceedComponentId = (cfgOt?.exceedHandling as { componentId?: string } | undefined)?.componentId ?? '';

  // Controlled identity/validation fields (the rest are uncontrolled defaultValue — they still submit).
  const [step, setStep] = useState(0);
  const [name, setName] = useState(editing?.name ?? '');
  const [code, setCode] = useState(editing?.code ?? '');
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [policyType, setPolicyType] = useState(editing?.policyType ?? 'monthly');
  const [status, setStatus] = useState(editing?.status ?? 'active');
  const [dailyRate, setDailyRate] = useState(
    editing?.payRule?.kind === 'per_day' ? String(editing.payRule.rate) : '',
  );
  const [hourlyRate, setHourlyRate] = useState(
    editing?.payRule?.kind === 'per_hour' ? String(editing.payRule.rate) : '',
  );
  const [showErrors, setShowErrors] = useState(false);
  const [summary, setSummary] = useState<{ label: string; value: string }[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  // ── Step-1 mandatory-field validation (server stays authoritative) ──
  const nameOk = name.trim().length > 0;
  const companyOk = mode === 'edit' || !!companyId;
  const rateOk =
    policyType === 'daily' ? Number(dailyRate) > 0 : policyType === 'hourly' ? Number(hourlyRate) > 0 : true;
  const step1Ok = nameOk && companyOk && rateOk;
  const canSave = step1Ok; // "prevent saving incomplete policy configurations"

  const stepTitle = (k: string) => t(`wizard.steps.${k}`);

  // Build a plain-language review of the configured values by reading the live form fields.
  const enumLabel = (group: string, v: string | undefined) => (v ? t(`${group}.${v}`) : '');
  const buildSummary = () => {
    const f = formRef.current;
    if (!f) return;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
    const rows: { label: string; value: string }[] = [];
    rows.push({ label: t('fieldName'), value: name || '—' });
    if (code.trim()) rows.push({ label: t('fieldCode'), value: code });
    rows.push({ label: t('fieldType'), value: t(`types.${policyType}`) });
    if (mode === 'create') rows.push({ label: t('fieldCompany'), value: companies.find((c) => c.id === companyId)?.name ?? '—' });
    rows.push({ label: t('fieldStatus'), value: enumLabel('status', status) });
    if (policyType === 'daily' && dailyRate) rows.push({ label: t('fieldDailyRate'), value: dailyRate });
    if (policyType === 'hourly' && hourlyRate) rows.push({ label: t('fieldHourlyRate'), value: hourlyRate });
    rows.push({ label: t('cutOff.frequencyLabel'), value: enumLabel('cutOff.frequency', val('frequency')) });
    rows.push({ label: t('cutOff.modeLabel'), value: t(`cutOff.mode${val('cutOffMode') === 'custom' ? 'Custom' : 'Calendar'}`) });
    rows.push({ label: t('config.prorationDivisor'), value: t(`config.divisor${val('prorationDivisor') === 'custom_days' ? 'Custom' : 'Calendar'}`) });
    rows.push({ label: t('config.negativeNetLabel'), value: enumLabel('config.negative', { retain: 'Retain', set_zero: 'SetZero', carry_forward: 'CarryForward' }[val('negativeNet')] ?? 'Retain') });
    if (val('otMultiplier')) rows.push({ label: t('config.otMultiplier'), value: val('otMultiplier') });
    rows.push({ label: t('config.unpaidLeaveDivisor'), value: enumLabel('config.leaveDivisor', val('unpaidLeaveDivisor')) });
    rows.push({ label: t('config.roundingNetPay'), value: enumLabel('config.rounding', val('roundingNetPay')) });
    const desc = val('description');
    if (desc) rows.push({ label: t('fieldDescription'), value: desc });
    setSummary(rows);
  };

  const goNext = () => {
    if (step === 0 && !step1Ok) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    const nextStep = Math.min(REVIEW, step + 1);
    if (nextStep === REVIEW) buildSummary();
    setStep(nextStep);
  };
  const goPrev = () => setStep((s) => Math.max(0, s - 1));

  const roundingSelect = (fieldName: string, cfgKey: string, label: string) => (
    <Field label={label}>
      <select name={fieldName} defaultValue={(cfgRound?.[cfgKey] as string) ?? 'none'} className={inputCls}>
        {ROUNDING_OPTS.map((r) => (
          <option key={r} value={r}>{t(`config.rounding.${r}`)}</option>
        ))}
      </select>
    </Field>
  );

  const prorationEvent = (prefix: string, evtCfg: Record<string, unknown> | null) => (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('config.prorationDivisor')}>
          <select name={`${prefix}Divisor`} defaultValue={(evtCfg?.divisor as string) ?? 'default'} className={inputCls}>
            <option value="default">{t('config.divisorInherit')}</option>
            <option value="calendar_month">{t('config.divisorCalendar')}</option>
            <option value="custom_days">{t('config.divisorCustom')}</option>
          </select>
        </Field>
        <Field label={t('config.prorationCustomDays')}>
          <input name={`${prefix}CustomDays`} type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={num(evtCfg?.customDays)} placeholder="26" className={inputCls} />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`${prefix}IncludeSaturday`} defaultChecked={(evtCfg?.includeSaturday as boolean) ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSaturday')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`${prefix}IncludeSunday`} defaultChecked={(evtCfg?.includeSunday as boolean) ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSunday')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`${prefix}IncludeHoliday`} defaultChecked={(evtCfg?.includeHoliday as boolean) ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeHoliday')}</label>
      </div>
    </>
  );

  return (
    <Card className="overflow-hidden">
      {/* Progress header — numbered steps, current highlighted, completed green (mirrors process/wizard.tsx). */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-4 py-3">
        {STEP_KEYS.map((k, i) => (
          <button
            type="button"
            key={k}
            onClick={() => {
              // Allow jumping back freely; jumping FORWARD past step 1 requires step-1 validity.
              if (i > 0 && !step1Ok) {
                setShowErrors(true);
                return;
              }
              if (i === REVIEW) buildSummary();
              setStep(i);
            }}
            className="flex shrink-0 items-center gap-2"
          >
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </span>
            <span className={`whitespace-nowrap text-sm ${i === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{stepTitle(k)}</span>
            {i < REVIEW && <span className="mx-1 text-muted-foreground">→</span>}
          </button>
        ))}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t('wizard.stepOf', { n: step + 1, total: STEP_KEYS.length })}</span>
      </div>

      <form
        ref={formRef}
        action={mode === 'edit' ? updatePolicyAction : createPolicyAction}
        onKeyDown={(e) => {
          // Don't let Enter in a text field submit the whole wizard mid-flow — only the explicit Save / Save
          // Draft buttons submit. (Textareas keep their newline behaviour.)
          if (e.key === 'Enter' && step !== REVIEW && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
            e.preventDefault();
          }
        }}
      >
        {editing && <input type="hidden" name="id" value={editing.id} />}

        <div className="p-4">
          {/* ───────── Step 1 · Policy Information ───────── */}
          <div hidden={step !== 0} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {mode === 'create' && (
              <Field label={t('fieldCompany')}>
                <select name="companyId" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t('fieldName')}>
              <input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} className={inputCls} />
              {showErrors && !nameOk && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('wizard.validation.name')}</p>}
            </Field>
            <Field label={t('fieldCode')}>
              <input name="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('codePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('fieldStatus')}>
              <select name="status" value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
                <option value="draft">{t('status.draft')}</option>
              </select>
            </Field>
            <Field label={t('fieldType')}>
              {mode === 'edit' ? (
                <>
                  <input type="hidden" name="policyType" value={policyType} />
                  <select defaultValue={policyType} disabled className={`${inputCls} opacity-70`}>
                    {policyTypes.map((ty) => (
                      <option key={ty} value={ty}>{t(`types.${ty}`)}</option>
                    ))}
                  </select>
                </>
              ) : (
                <select name="policyType" value={policyType} onChange={(e) => setPolicyType(e.target.value)} className={inputCls}>
                  {policyTypes.map((ty) => (
                    <option key={ty} value={ty} disabled={!enabled.has(ty)}>
                      {t(`types.${ty}`)}{!enabled.has(ty) ? ` — ${t('typePending')}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('fieldDailyRate')}>
              <input name="dailyRate" type="number" min="0" step="0.01" inputMode="decimal" value={dailyRate} onChange={(e) => setDailyRate(e.target.value)} placeholder={t('dailyRatePlaceholder')} className={inputCls} />
              {showErrors && policyType === 'daily' && !rateOk && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('wizard.validation.dailyRate')}</p>}
            </Field>
            <Field label={t('fieldHourlyRate')}>
              <input name="hourlyRate" type="number" min="0" step="0.01" inputMode="decimal" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} placeholder={t('hourlyRatePlaceholder')} className={inputCls} />
              {showErrors && policyType === 'hourly' && !rateOk && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('wizard.validation.hourlyRate')}</p>}
            </Field>
            <label className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm sm:col-span-2 dark:border-border dark:bg-muted/20">
              <input type="checkbox" name="onlyPullHoursWithinShift" value="on" defaultChecked={editing?.payRule?.kind === 'per_hour' && editing.payRule.onlyPullHoursWithinShiftSchedule === true} className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary dark:border-border" />
              <span>
                <span className="font-medium text-foreground dark:text-foreground">{t('fieldOnlyWithinShift')}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground dark:text-muted-foreground">{t('onlyWithinShiftHint')}</span>
              </span>
            </label>
            <Field label={t('fieldDescription')}>
              <input name="description" defaultValue={editing?.description ?? ''} placeholder={t('descriptionPlaceholder')} className={inputCls} />
            </Field>
          </div>

          {/* ───────── Step 2 · Cut-Off Window ───────── */}
          <div hidden={step !== 1} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('cutOff.frequencyLabel')}>
                <select name="frequency" defaultValue={editingFrequency} className={inputCls}>
                  {payrollFrequencies.map((f) => (
                    <option key={f} value={f}>{t(`cutOff.frequency.${f}`)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('cutOff.modeLabel')}>
                <select name="cutOffMode" defaultValue={editingCutOffCustom ? 'custom' : 'calendar'} className={inputCls}>
                  <option value="calendar">{t('cutOff.modeCalendar')}</option>
                  <option value="custom">{t('cutOff.modeCustom')}</option>
                </select>
              </Field>
              <Field label={t('cutOff.anchorDay')}>
                <input name="anchorDay" type="number" min={anchorMin} max={anchorMax} step="1" inputMode="numeric" defaultValue={editingCutOffCustom && editingCutOff?.anchorDay ? String(editingCutOff.anchorDay) : ''} placeholder={t('cutOff.anchorDayPlaceholder')} className={inputCls} />
              </Field>
            </div>
            <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.frequencyHint')}</p>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.anchorDayHint')}</p>

            <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('cutOff.perTypeTitle')}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {cutOffPerTypes.map((type) => (
                <Field key={type} label={t(`cutOff.type.${type}`)}>
                  <input name={`cutOff_${type}`} type="number" min={anchorMin} max={anchorMax} step="1" inputMode="numeric" defaultValue={editingPerType?.[type] ? String(editingPerType[type]) : ''} placeholder={t('cutOff.inheritPlaceholder')} className={inputCls} />
                </Field>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.perTypeHint')}</p>

            <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('cutOff.perFrequencyTitle')}</p>
            {(['weekly', 'biweekly'] as const).map((freq) => {
              const block = editingPerFrequency?.[freq];
              return (
                <div key={freq} className="mb-3 rounded-lg border border-border bg-background/40 px-3 py-2 dark:border-border">
                  <p className="mb-2 text-xs font-medium text-foreground dark:text-foreground">{t(`cutOff.frequency.${freq}`)}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <Field label={t('cutOff.anchorDay')}>
                      <input name={`cutOffFreq_${freq}_anchorDay`} type="number" min={anchorMin} max={anchorMax} step="1" inputMode="numeric" defaultValue={block?.anchorDay ? String(block.anchorDay) : ''} placeholder={t('cutOff.inheritPlaceholder')} className={inputCls} />
                    </Field>
                    {cutOffPerTypes.map((type) => (
                      <Field key={type} label={t(`cutOff.type.${type}`)}>
                        <input name={`cutOffFreq_${freq}_${type}`} type="number" min={anchorMin} max={anchorMax} step="1" inputMode="numeric" defaultValue={block?.perType?.[type] ? String(block.perType[type]) : ''} placeholder={t('cutOff.inheritPlaceholder')} className={inputCls} />
                      </Field>
                    ))}
                  </div>
                </div>
              );
            })}
            <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.perFrequencyHint')}</p>
          </div>

          {/* ───────── Step 3 · Salary Proration & Working-Day Reference ───────── */}
          <div hidden={step !== 2} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('config.prorationDivisor')}>
                <select name="prorationDivisor" defaultValue={(cfgPror?.divisor as string) ?? 'calendar_month'} className={inputCls}>
                  <option value="calendar_month">{t('config.divisorCalendar')}</option>
                  <option value="custom_days">{t('config.divisorCustom')}</option>
                </select>
              </Field>
              <Field label={t('config.prorationCustomDays')}>
                <input name="prorationCustomDays" type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={num(cfgPror?.customDays)} placeholder="26" className={inputCls} />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeSaturday" defaultChecked={(cfgPror?.includeSaturday as boolean) ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSaturday')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeSunday" defaultChecked={(cfgPror?.includeSunday as boolean) ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSunday')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeHoliday" defaultChecked={(cfgPror?.includeHoliday as boolean) ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeHoliday')}</label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.prorationHint')}</p>
          </div>

          {/* ───────── Step 4 · Salary Configuration (per-event formulas) ───────── */}
          <div hidden={step !== 3} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <p className="mb-3 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.salaryConfigHint')}</p>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.hireFormula')}</p>
            {prorationEvent('hire', cfgHire)}
            <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.resignFormula')}</p>
            {prorationEvent('resign', cfgResign)}
            <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.incrementFormula')}</p>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="salaryIncrementProration" defaultChecked={(g<boolean>('salaryIncrementProration', false))} className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary" /><span>{t('config.salaryIncrementProration')}<span className="mt-0.5 block text-xs text-muted-foreground">{t('config.incrementHint')}</span></span></label>
          </div>

          {/* ───────── Step 5 · Negative Net Pay ───────── */}
          <div hidden={step !== 4} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <Field label={t('config.negativeNetLabel')}>
              <select name="negativeNet" defaultValue={g<string>('negativeNet', 'retain')} className={inputCls}>
                <option value="retain">{t('config.negativeRetain')}</option>
                <option value="set_zero">{t('config.negativeSetZero')}</option>
                <option value="carry_forward">{t('config.negativeCarryForward')}</option>
              </select>
            </Field>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.negativeNetHint')}</p>
          </div>

          {/* ───────── Step 6 · Overtime ───────── */}
          <div hidden={step !== 5} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('config.otMultiplier')}>
                <input name="otMultiplier" type="number" min={1.5} step="0.1" inputMode="decimal" defaultValue={num(cfgOt?.multiplier)} placeholder="1.5" className={inputCls} />
              </Field>
              <Field label={t('config.otMaxHours')}>
                <input name="otMaxHours" type="number" min={0} step="0.5" inputMode="decimal" defaultValue={num(cfgOt?.maxHoursPerMonth)} placeholder="104" className={inputCls} />
              </Field>
              <Field label={t('config.otMaxAmount')}>
                <input name="otMaxAmount" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={num(cfgOt?.maxAmount)} placeholder="—" className={inputCls} />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="otDay_workday" defaultChecked={dayChecked('workday')} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.otDayWorkday')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="otDay_rest_day" defaultChecked={dayChecked('rest_day')} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.otDayRestDay')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="otDay_holiday" defaultChecked={dayChecked('holiday')} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.otDayHoliday')}</label>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('config.otExceedLabel')}>
                <select name="otExceedAction" defaultValue={otExceedConvert ? 'convert' : 'cap'} className={inputCls}>
                  <option value="cap">{t('config.otExceedCap')}</option>
                  <option value="convert">{t('config.otExceedConvert')}</option>
                </select>
              </Field>
              <Field label={t('config.otExceedComponent')}>
                <select name="otExceedComponentId" defaultValue={otExceedComponentId} className={inputCls}>
                  <option value="">{t('config.otExceedComponentNone')}</option>
                  {payComponents.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.otHint')}</p>
          </div>

          {/* ───────── Step 7 · Leave Calculation ───────── */}
          <div hidden={step !== 6} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('config.unpaidLeaveDivisor')}>
                <select name="unpaidLeaveDivisor" defaultValue={(cfgLeave?.unpaidLeaveDivisor as string) ?? 'calendar_month'} className={inputCls}>
                  {LEAVE_DIVISORS.map((d) => <option key={d} value={d}>{t(`config.leaveDivisor.${d}`)}</option>)}
                </select>
              </Field>
              <Field label={t('config.unpaidTimeOffDivisor')}>
                <select name="unpaidTimeOffDivisor" defaultValue={(cfgLeave?.unpaidTimeOffDivisor as string) ?? 'calendar_month'} className={inputCls}>
                  {TIME_OFF_DIVISORS.map((d) => <option key={d} value={d}>{t(`config.leaveDivisor.${d}`)}</option>)}
                </select>
              </Field>
              <Field label={t('config.encashmentDivisor')}>
                <select name="encashmentDivisor" defaultValue={(cfgLeave?.encashmentDivisor as string) ?? 'calendar_month'} className={inputCls}>
                  {LEAVE_DIVISORS.map((d) => <option key={d} value={d}>{t(`config.leaveDivisor.${d}`)}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('config.leaveCustomDays')}>
                <input name="leaveCustomDays" type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={num(cfgLeave?.customDays)} placeholder="26" className={inputCls} />
              </Field>
              <Field label={t('config.leaveCustomHours')}>
                <input name="leaveCustomHours" type="number" min={0} step="0.5" inputMode="decimal" defaultValue={num(cfgLeave?.customHours)} placeholder="—" className={inputCls} />
              </Field>
              <Field label={t('config.leaveCustomMinutes')}>
                <input name="leaveCustomMinutes" type="number" min={0} step="1" inputMode="numeric" defaultValue={num(cfgLeave?.customMinutes)} placeholder="—" className={inputCls} />
              </Field>
            </div>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.leaveHint')}</p>
          </div>

          {/* ───────── Step 8 · Rounding ───────── */}
          <div hidden={step !== 7} className="rounded-xl border border-border bg-muted/30 px-3 py-3 dark:border-border dark:bg-muted/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {roundingSelect('roundingEarnings', 'earnings', t('config.roundingEarnings'))}
              {roundingSelect('roundingDeductions', 'deductions', t('config.roundingDeductions'))}
              {roundingSelect('roundingNetPay', 'netPay', t('config.roundingNetPay'))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.roundingHint')}</p>
          </div>

          {/* ───────── Step 9 · Review & Save ───────── */}
          <div hidden={step !== REVIEW} className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('wizard.reviewHint')}</p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-border p-4 sm:grid-cols-2">
              {summary.map((r, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1 last:border-0">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">{r.label}</dt>
                  <dd className="text-right text-sm font-medium">{r.value}</dd>
                </div>
              ))}
            </dl>
            {status === 'draft' && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('wizard.reviewDraftNote')}</p>
            )}

            {/* Read-only cut-off / schedule previews (derived from the last-saved config). */}
            <div className="overflow-x-auto rounded-lg border border-border dark:border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">{t('cutOff.previewType')}</th>
                    <th className="px-3 py-1.5 font-medium">{t('cutOff.previewFrom')}</th>
                    <th className="px-3 py-1.5 font-medium">{t('cutOff.previewTo')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cutOffPreview.map((row) => (
                    <tr key={row.type}>
                      <td className="px-3 py-1.5 text-muted-foreground">{t(`cutOff.type.${row.type}`)}</td>
                      <td className="px-3 py-1.5 tabular-nums">{row.start}</td>
                      <td className="px-3 py-1.5 tabular-nums">{row.end}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.previewHint')}</p>
          </div>
        </div>

        {/* Navigation controls — Previous / Next / Save Draft / Save / Cancel. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={goPrev} disabled={step === 0} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-40 hover:bg-muted/50">
              {t('wizard.previous')}
            </button>
            <Link href={cancelHref} className="text-sm font-medium text-muted-foreground hover:text-foreground">{t('wizard.cancel')}</Link>
          </div>
          <div className="flex items-center gap-2">
            {/* Save Draft available on every step (forces status=draft); needs at least a name. */}
            <button type="submit" name="intent" value="draft" disabled={!nameOk} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-40 hover:bg-muted/50">
              {t('wizard.saveDraft')}
            </button>
            {step < REVIEW ? (
              <button type="button" onClick={goNext} className={btnPrimary}>{t('wizard.next')}</button>
            ) : (
              <button type="submit" name="intent" value="save" disabled={!canSave} className={`${btnPrimary} disabled:opacity-40`}>{t('wizard.save')}</button>
            )}
          </div>
        </div>
      </form>
    </Card>
  );
}
