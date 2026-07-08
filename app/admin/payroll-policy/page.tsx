import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPolicies, POLICY_TYPES, type PolicyRow } from '@/core/payroll-policy';
import { listPayComponents } from '@/core/pay-components';
import { CUT_OFF_PER_TYPES, PAYROLL_FREQUENCIES, cutOffWindowFor, payrollFrequencyOf, payrollScheduleFor } from '@/core/payroll-policy-config';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { copyPolicyAction, createPolicyAction, deletePolicyAction, setStatusAction, updatePolicyAction } from './actions';

const PAGE = '/admin/payroll-policy';
// 2.1.4 — Monthly, Daily, Hourly and Custom-period are all selectable. Hourly persists its per-hour rate + the
// "only pull hours within shift schedule" toggle; the live end-to-end hourly payslip computation is a deferred
// follow-up (gated on the rate-storage decision). Custom-period persists a cut-off WINDOW (an anchor day for a
// non-calendar operational window) — recorded + validated now, but NOT yet applied to payroll calculation
// (deferred follow-up); statutory months stay calendar-bound by law.
const ENABLED_TYPES = new Set(['monthly', 'daily', 'hourly', 'custom_period']);
// Anchor-day bounds mirror core/payroll-policy-config.ts (1..28 — avoids the 29–31 month-length trap).
const ANCHOR_MIN = 1;
const ANCHOR_MAX = 28;
type SortKey = 'name' | 'type' | 'status' | 'updated';

export default async function PayrollPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; edit?: string; q?: string; type?: string; status?: string; sort?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollPolicy');
  const { error, edit, q, type, status, sort } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const policies = await listPolicies(s, scopeIds);
  // f3148da1 Step 4 — pay components offered as the "convert OT excess to pay item" target (earnings only).
  const payComponents = (await listPayComponents(s)).filter((c) => c.kind === 'allowance');

  // Search / filter / sort (the catalog is small — applied in-page over the server-rendered list).
  const sortKey: SortKey = (['name', 'type', 'status', 'updated'] as const).includes(sort as SortKey) ? (sort as SortKey) : 'name';
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? '—';
  let rows = policies.filter((p) => {
    if (q && !`${p.name} ${p.description ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (type && p.policyType !== type) return false;
    if (status && p.status !== status) return false;
    return true;
  });
  rows = [...rows].sort((a, b) => {
    if (sortKey === 'type') return a.policyType.localeCompare(b.policyType);
    if (sortKey === 'status') return a.status.localeCompare(b.status);
    if (sortKey === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return a.name.localeCompare(b.name);
  });

  const editing: PolicyRow | null = edit ? policies.find((p) => p.id === edit) ?? null : null;
  // 2.1.4 — the editing policy's stored cut-off window (custom_period only), for prefilling the form.
  const editingCutOff = editing?.config?.cutOff;
  const editingCutOffCustom = editingCutOff?.mode === 'custom';
  // c7fdfcf6 (Payroll Schedule) — the per-type anchor overrides + frequency, for prefilling the form.
  const editingPerType = editingCutOff?.perType;
  const editingFrequency = payrollFrequencyOf(editing?.config ?? null);
  // c7fdfcf6 gap-fix — the per-frequency cut-off override blocks (Weekly / Bi-Weekly), for prefilling the form.
  const editingPerFrequency = editingCutOff?.perFrequency;
  // c7fdfcf6 — From/To preview: for the CURRENT month, the window each transaction type's saved cut-off resolves
  // to (derived, not stored — consecutive periods are contiguous + non-overlapping by construction). Read-only:
  // it reflects the LAST SAVED config, so the operator sees exactly which dates each run will pick up.
  const previewPeriod = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const cutOffPreview = (['salary', ...CUT_OFF_PER_TYPES] as const).map((type) => ({
    type,
    window: cutOffWindowFor(type, editing?.config ?? null, null, previewPeriod),
  }));
  // c7fdfcf6 gap-fix — the GENERATED cut-off periods for the saved frequency (monthly ⇒ 1 cycle; weekly/biweekly
  // ⇒ the tiled 7/14-day cycles). Shows the operator exactly which periods each payroll run will produce.
  const schedulePreview = payrollScheduleFor(editing?.config ?? null, null, previewPeriod);
  // f3148da1 — the editing policy's General-Settings config, for prefilling the Steps 2–5 sections.
  const cfg = editing?.config ?? null;
  const cfgOt = cfg?.overtime;
  const otDayTypes = cfgOt?.eligibleDayTypes; // undefined = all three (no restriction)
  const dayChecked = (d: 'workday' | 'rest_day' | 'holiday') => (otDayTypes ? otDayTypes.includes(d) : true);
  const cfgLeave = cfg?.leave;
  const cfgPror = cfg?.proration;
  // f3148da1 Step 3 — the three per-event basic-salary formulas (new hire / resigned / increment).
  const cfgHire = cfg?.prorationHire;
  const cfgResign = cfg?.prorationResign;
  const cfgRound = cfg?.rounding;
  const otExceedConvert = cfgOt?.exceedHandling?.action === 'convert';
  const ROUNDING_OPTS = ['none', 'up', 'down', 'nearest'] as const;
  const LEAVE_DIVISORS = ['calendar_month', 'custom_days', 'cutoff_days', 'working_days'] as const;
  // f3148da1 Step 5 (R17 gap-fix reinstatement) — the Unpaid Time Off Deduction Formula additionally supports
  // per-hour / per-minute valuation (a partial-day absence can be valued by time, not only by a day divisor).
  const TIME_OFF_DIVISORS = [...LEAVE_DIVISORS, 'custom_hours', 'custom_minutes'] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} back={await settingsBack()} />
      {error && <ErrorBanner message={error} />}

      <p className="rounded-[1.25rem] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {t('previewNotice')}
      </p>

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <SectionHeader title={t('catalogTitle')} count={rows.length} />

            {/* Search / filter / sort — a GET form so the controls are server-driven (no client state). */}
            <form method="get" className="flex flex-wrap items-end gap-2 px-4 pt-3">
              <input
                name="q"
                defaultValue={q ?? ''}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchLabel')}
                className={`${inputCls} w-48`}
              />
              <select name="type" defaultValue={type ?? ''} aria-label={t('filterType')} className={`${inputCls} w-auto`}>
                <option value="">{t('filterTypeAll')}</option>
                {POLICY_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(`types.${ty}`)}</option>
                ))}
              </select>
              <select name="status" defaultValue={status ?? ''} aria-label={t('filterStatus')} className={`${inputCls} w-auto`}>
                <option value="">{t('filterStatusAll')}</option>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
              <select name="sort" defaultValue={sortKey} aria-label={t('sortLabel')} className={`${inputCls} w-auto`}>
                <option value="name">{t('sortName')}</option>
                <option value="type">{t('sortType')}</option>
                <option value="status">{t('sortStatus')}</option>
                <option value="updated">{t('sortUpdated')}</option>
              </select>
              <button className={btnPrimary}>{t('apply')}</button>
            </form>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colName')}</th>
                    <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                    <th className="px-4 py-2 font-medium">{t('colType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('colAssigned')}</th>
                    <th className="px-4 py-2 font-medium">{t('colUpdated')}</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((p) => (
                    <tr key={p.id} className={editing?.id === p.id ? 'bg-primary/5' : undefined}>
                      <td className="px-4 py-2.5 font-medium">
                        {p.name}
                        {p.description && <span className="ml-2 text-xs text-muted-foreground">{p.description}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{companyName(p.companyId)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{t(`types.${p.policyType}`)}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={p.status === 'active' ? 'success' : 'default'}>{t(`status.${p.status}`)}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">{p.assignedCount}</td>
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{new Date(p.updatedAt).toISOString().slice(0, 10)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <Link href={`${PAGE}?edit=${p.id}`} className="text-xs font-medium text-primary hover:underline">
                            {t('edit')}
                          </Link>
                          {/* 2.1.2 — Copy: duplicate the policy (type + rate + config) under a "(copy)" name. */}
                          <form action={copyPolicyAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="name" value={`${p.name} ${t('copySuffix')}`} />
                            <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                              {t('copy')}
                            </button>
                          </form>
                          <form action={setStatusAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="status" value={p.status === 'active' ? 'inactive' : 'active'} />
                            <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                              {p.status === 'active' ? t('deactivate') : t('activate')}
                            </button>
                          </form>
                          <form action={deletePolicyAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <ConfirmSubmit
                              title={t('deleteTitle')}
                              description={t('deleteDescription', { name: p.name })}
                              confirmLabel={t('delete')}
                              size="sm"
                            >
                              {t('delete')}
                            </ConfirmSubmit>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{t('empty')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <SectionHeader title={editing ? t('editTitle', { name: editing.name }) : t('addTitle')} />
            <form
              key={editing?.id ?? 'new'}
              action={editing ? updatePolicyAction : createPolicyAction}
              className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"
            >
              {editing && <input type="hidden" name="id" value={editing.id} />}
              {!editing && (
                <Field label={t('fieldCompany')}>
                  <select name="companyId" required className={inputCls}>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={t('fieldName')}>
                <input name="name" required defaultValue={editing?.name ?? ''} placeholder={t('namePlaceholder')} className={inputCls} />
              </Field>
              <Field label={t('fieldType')}>
                {/* Edit keeps the existing type read-only (the calculation type is fixed once chosen) — a hidden
                    field carries it so the action still receives it; create exposes the enabled types and
                    disables the ones not yet signed off. */}
                {editing ? (
                  <>
                    <input type="hidden" name="policyType" value={editing.policyType} />
                    <select defaultValue={editing.policyType} disabled className={`${inputCls} opacity-70`}>
                      {POLICY_TYPES.map((ty) => (
                        <option key={ty} value={ty}>{t(`types.${ty}`)}</option>
                      ))}
                    </select>
                  </>
                ) : (
                  <select name="policyType" defaultValue="monthly" className={inputCls}>
                    {POLICY_TYPES.map((ty) => (
                      <option key={ty} value={ty} disabled={!ENABLED_TYPES.has(ty)}>
                        {t(`types.${ty}`)}{!ENABLED_TYPES.has(ty) ? ` — ${t('typePending')}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {/* 2.1.2 — per-day rate. Always rendered (server component, no client toggle); the action reads it
                  ONLY when the type is daily. Pre-filled when editing a daily policy. */}
              <Field label={t('fieldDailyRate')}>
                <input
                  name="dailyRate"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  defaultValue={editing?.payRule?.kind === 'per_day' ? String(editing.payRule.rate) : ''}
                  placeholder={t('dailyRatePlaceholder')}
                  className={inputCls}
                />
              </Field>
              {/* 2.1.3 — per-hour rate. Always rendered; the action reads it ONLY when the type is hourly.
                  Pre-filled when editing an hourly policy. */}
              <Field label={t('fieldHourlyRate')}>
                <input
                  name="hourlyRate"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  defaultValue={editing?.payRule?.kind === 'per_hour' ? String(editing.payRule.rate) : ''}
                  placeholder={t('hourlyRatePlaceholder')}
                  className={inputCls}
                />
              </Field>
              {/* 2.1.3 — "Only pull hours within shift schedule" toggle. A plain checkbox (server component, no
                  client state); the action reads it ONLY for an hourly policy. Pre-checked when editing an
                  hourly policy that has the flag on. */}
              <label className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm sm:col-span-2 dark:border-border dark:bg-muted/20">
                <input
                  type="checkbox"
                  name="onlyPullHoursWithinShift"
                  value="on"
                  defaultChecked={
                    editing?.payRule?.kind === 'per_hour' && editing.payRule.onlyPullHoursWithinShiftSchedule === true
                  }
                  className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary dark:border-border"
                />
                <span>
                  <span className="font-medium text-foreground dark:text-foreground">{t('fieldOnlyWithinShift')}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground dark:text-muted-foreground">
                    {t('onlyWithinShiftHint')}
                  </span>
                </span>
              </label>
              {/* 2.1.4 — Custom-period cut-off WINDOW. Always rendered (server component, no client toggle); the
                  action reads it ONLY when the type is custom_period. "Calendar month" (default) leaves the
                  window calendar-bound (byte-identical); "Custom period" anchors a non-calendar window on the
                  given day. The window is RECORDED + VALIDATED but not yet applied to payroll calculation — a
                  deferred follow-up; statutory months (EPF/SOCSO/EIS/PCB) stay calendar-bound by law. */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-2 text-sm font-medium text-foreground dark:text-foreground">{t('cutOff.title')}</p>
                {/* c7fdfcf6 — payroll frequency (Weekly / Bi-Weekly / Monthly). Weekly/bi-weekly are operational
                    cadences; statutory contributions still aggregate into the calendar month by law. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('cutOff.frequencyLabel')}>
                    <select name="frequency" defaultValue={editingFrequency} className={inputCls}>
                      {PAYROLL_FREQUENCIES.map((f) => (
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
                    <input
                      name="anchorDay"
                      type="number"
                      min={ANCHOR_MIN}
                      max={ANCHOR_MAX}
                      step="1"
                      inputMode="numeric"
                      defaultValue={editingCutOffCustom && editingCutOff?.anchorDay ? String(editingCutOff.anchorDay) : ''}
                      placeholder={t('cutOff.anchorDayPlaceholder')}
                      className={inputCls}
                    />
                  </Field>
                </div>
                <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.frequencyHint')}</p>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.anchorDayHint')}</p>

                {/* c7fdfcf6 — per-type cut-off overrides. Each transaction type (Claim / Overtime / Leave /
                    Attendance) may close on its own anchor day; blank ⇒ inherit the Salary anchor above. Only
                    read when mode='custom'. */}
                <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('cutOff.perTypeTitle')}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {CUT_OFF_PER_TYPES.map((type) => (
                    <Field key={type} label={t(`cutOff.type.${type}`)}>
                      <input
                        name={`cutOff_${type}`}
                        type="number"
                        min={ANCHOR_MIN}
                        max={ANCHOR_MAX}
                        step="1"
                        inputMode="numeric"
                        defaultValue={editingPerType?.[type] ? String(editingPerType[type]) : ''}
                        placeholder={t('cutOff.inheritPlaceholder')}
                        className={inputCls}
                      />
                    </Field>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.perTypeHint')}</p>

                {/* c7fdfcf6 gap-fix — PER-FREQUENCY cut-off overrides. When the payroll frequency is Weekly or
                    Bi-Weekly, that frequency can carry its OWN anchor day + per-type days, so Weekly / Bi-Weekly /
                    Monthly each have independent cut-off periods. Blank ⇒ inherit the base (Monthly) cut-off. */}
                <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('cutOff.perFrequencyTitle')}</p>
                {(['weekly', 'biweekly'] as const).map((freq) => {
                  const block = editingPerFrequency?.[freq];
                  return (
                    <div key={freq} className="mb-3 rounded-lg border border-border bg-background/40 px-3 py-2 dark:border-border">
                      <p className="mb-2 text-xs font-medium text-foreground dark:text-foreground">{t(`cutOff.frequency.${freq}`)}</p>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                        <Field label={t('cutOff.anchorDay')}>
                          <input
                            name={`cutOffFreq_${freq}_anchorDay`}
                            type="number"
                            min={ANCHOR_MIN}
                            max={ANCHOR_MAX}
                            step="1"
                            inputMode="numeric"
                            defaultValue={block?.anchorDay ? String(block.anchorDay) : ''}
                            placeholder={t('cutOff.inheritPlaceholder')}
                            className={inputCls}
                          />
                        </Field>
                        {CUT_OFF_PER_TYPES.map((type) => (
                          <Field key={type} label={t(`cutOff.type.${type}`)}>
                            <input
                              name={`cutOffFreq_${freq}_${type}`}
                              type="number"
                              min={ANCHOR_MIN}
                              max={ANCHOR_MAX}
                              step="1"
                              inputMode="numeric"
                              defaultValue={block?.perType?.[type] ? String(block.perType[type]) : ''}
                              placeholder={t('cutOff.inheritPlaceholder')}
                              className={inputCls}
                            />
                          </Field>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.perFrequencyHint')}</p>

                {/* c7fdfcf6 gap-fix — the GENERATED cut-off cycles for the saved frequency. Monthly shows one
                    cycle; Weekly / Bi-Weekly show the tiled 7 / 14-day cycles the run will produce. Read-only. */}
                <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('cutOff.scheduleTitle', { frequency: t(`cutOff.frequency.${schedulePreview.frequency}`), period: previewPeriod })}
                </p>
                <div className="overflow-x-auto rounded-lg border border-border dark:border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-left uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">{t('cutOff.scheduleCycle')}</th>
                        <th className="px-3 py-1.5 font-medium">{t('cutOff.previewFrom')}</th>
                        <th className="px-3 py-1.5 font-medium">{t('cutOff.previewTo')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {schedulePreview.periods.map((p) => (
                        <tr key={p.seq}>
                          <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{p.seq}</td>
                          <td className="px-3 py-1.5 tabular-nums">{p.start}</td>
                          <td className="px-3 py-1.5 tabular-nums">{p.end}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.scheduleHint')}</p>

                {/* c7fdfcf6 — From/To preview: the window each type's SAVED cut-off resolves to for the current
                    month. Read-only; derived from the last saved config. */}
                <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('cutOff.previewTitle', { period: previewPeriod })}
                </p>
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
                          <td className="px-3 py-1.5 tabular-nums">{row.window.start}</td>
                          <td className="px-3 py-1.5 tabular-nums">{row.window.end}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.previewHint')}</p>
              </div>

              {/* ───────── f3148da1 · General Settings (Steps 2–5) — server-rendered, no client state.
                  Every field defaults to today's behaviour; cleanPayrollPolicyConfig clamps + collapses an
                  all-default blob back to NULL so an untouched form stays byte-identical. ───────── */}

              {/* Step 2 — Working-day reference / default proration basis (shared fallback for every event) */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-2 text-sm font-medium text-foreground dark:text-foreground">{t('config.prorationTitle')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('config.prorationDivisor')}>
                    <select name="prorationDivisor" defaultValue={cfgPror?.divisor ?? 'calendar_month'} className={inputCls}>
                      <option value="calendar_month">{t('config.divisorCalendar')}</option>
                      <option value="custom_days">{t('config.divisorCustom')}</option>
                    </select>
                  </Field>
                  <Field label={t('config.prorationCustomDays')}>
                    <input name="prorationCustomDays" type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={cfgPror?.customDays ?? ''} placeholder="26" className={inputCls} />
                  </Field>
                </div>
                <div className="mt-2 flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeSaturday" defaultChecked={cfgPror?.includeSaturday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSaturday')}</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeSunday" defaultChecked={cfgPror?.includeSunday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSunday')}</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeHoliday" defaultChecked={cfgPror?.includeHoliday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeHoliday')}</label>
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.prorationHint')}</p>
              </div>

              {/* Step 3 — Salary Configuration: the three per-event basic-salary formulas (each independently
                  configurable; an event left at "default" inherits the Step-2 basis above ⇒ byte-identical). */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-1 text-sm font-medium text-foreground dark:text-foreground">{t('config.salaryConfigTitle')}</p>
                <p className="mb-3 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.salaryConfigHint')}</p>

                {/* New Hire Basic Salary Formula */}
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.hireFormula')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('config.prorationDivisor')}>
                    <select name="hireDivisor" defaultValue={cfgHire?.divisor ?? 'default'} className={inputCls}>
                      <option value="default">{t('config.divisorInherit')}</option>
                      <option value="calendar_month">{t('config.divisorCalendar')}</option>
                      <option value="custom_days">{t('config.divisorCustom')}</option>
                    </select>
                  </Field>
                  <Field label={t('config.prorationCustomDays')}>
                    <input name="hireCustomDays" type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={cfgHire?.customDays ?? ''} placeholder="26" className={inputCls} />
                  </Field>
                </div>
                <div className="mt-2 flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hireIncludeSaturday" defaultChecked={cfgHire?.includeSaturday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSaturday')}</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hireIncludeSunday" defaultChecked={cfgHire?.includeSunday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSunday')}</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hireIncludeHoliday" defaultChecked={cfgHire?.includeHoliday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeHoliday')}</label>
                </div>

                {/* Resigned Employee Basic Salary Formula */}
                <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.resignFormula')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('config.prorationDivisor')}>
                    <select name="resignDivisor" defaultValue={cfgResign?.divisor ?? 'default'} className={inputCls}>
                      <option value="default">{t('config.divisorInherit')}</option>
                      <option value="calendar_month">{t('config.divisorCalendar')}</option>
                      <option value="custom_days">{t('config.divisorCustom')}</option>
                    </select>
                  </Field>
                  <Field label={t('config.prorationCustomDays')}>
                    <input name="resignCustomDays" type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={cfgResign?.customDays ?? ''} placeholder="26" className={inputCls} />
                  </Field>
                </div>
                <div className="mt-2 flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="resignIncludeSaturday" defaultChecked={cfgResign?.includeSaturday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSaturday')}</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="resignIncludeSunday" defaultChecked={cfgResign?.includeSunday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeSunday')}</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="resignIncludeHoliday" defaultChecked={cfgResign?.includeHoliday ?? false} className="h-4 w-4 rounded border-border text-primary focus:ring-primary" />{t('config.includeHoliday')}</label>
                </div>

                {/* Salary Increment Basic Salary Formula */}
                <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.incrementFormula')}</p>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="salaryIncrementProration" defaultChecked={cfg?.salaryIncrementProration ?? false} className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary" /><span>{t('config.salaryIncrementProration')}<span className="mt-0.5 block text-xs text-muted-foreground">{t('config.incrementHint')}</span></span></label>
              </div>

              {/* Step 2 — Negative net pay */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-2 text-sm font-medium text-foreground dark:text-foreground">{t('config.negativeNetTitle')}</p>
                <Field label={t('config.negativeNetLabel')}>
                  <select name="negativeNet" defaultValue={cfg?.negativeNet ?? 'retain'} className={inputCls}>
                    <option value="retain">{t('config.negativeRetain')}</option>
                    <option value="set_zero">{t('config.negativeSetZero')}</option>
                    <option value="carry_forward">{t('config.negativeCarryForward')}</option>
                  </select>
                </Field>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.negativeNetHint')}</p>
              </div>

              {/* Step 4 — Overtime */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-2 text-sm font-medium text-foreground dark:text-foreground">{t('config.overtimeTitle')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('config.otMultiplier')}>
                    <input name="otMultiplier" type="number" min={1.5} step="0.1" inputMode="decimal" defaultValue={cfgOt?.multiplier ?? ''} placeholder="1.5" className={inputCls} />
                  </Field>
                  <Field label={t('config.otMaxHours')}>
                    <input name="otMaxHours" type="number" min={0} step="0.5" inputMode="decimal" defaultValue={cfgOt?.maxHoursPerMonth ?? ''} placeholder="104" className={inputCls} />
                  </Field>
                  <Field label={t('config.otMaxAmount')}>
                    <input name="otMaxAmount" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={cfgOt?.maxAmount ?? ''} placeholder="—" className={inputCls} />
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
                    <select name="otExceedComponentId" defaultValue={cfgOt?.exceedHandling?.componentId ?? ''} className={inputCls}>
                      <option value="">{t('config.otExceedComponentNone')}</option>
                      {payComponents.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.otHint')}</p>
              </div>

              {/* Step 5 — Leave */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-2 text-sm font-medium text-foreground dark:text-foreground">{t('config.leaveTitle')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('config.unpaidLeaveDivisor')}>
                    <select name="unpaidLeaveDivisor" defaultValue={cfgLeave?.unpaidLeaveDivisor ?? 'calendar_month'} className={inputCls}>
                      {LEAVE_DIVISORS.map((d) => <option key={d} value={d}>{t(`config.leaveDivisor.${d}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('config.unpaidTimeOffDivisor')}>
                    <select name="unpaidTimeOffDivisor" defaultValue={cfgLeave?.unpaidTimeOffDivisor ?? 'calendar_month'} className={inputCls}>
                      {TIME_OFF_DIVISORS.map((d) => <option key={d} value={d}>{t(`config.leaveDivisor.${d}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('config.encashmentDivisor')}>
                    <select name="encashmentDivisor" defaultValue={cfgLeave?.encashmentDivisor ?? 'calendar_month'} className={inputCls}>
                      {LEAVE_DIVISORS.map((d) => <option key={d} value={d}>{t(`config.leaveDivisor.${d}`)}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('config.leaveCustomDays')}>
                    <input name="leaveCustomDays" type="number" min={1} max={31} step="1" inputMode="numeric" defaultValue={cfgLeave?.customDays ?? ''} placeholder="26" className={inputCls} />
                  </Field>
                  <Field label={t('config.leaveCustomHours')}>
                    <input name="leaveCustomHours" type="number" min={0} step="0.5" inputMode="decimal" defaultValue={cfgLeave?.customHours ?? ''} placeholder="—" className={inputCls} />
                  </Field>
                  <Field label={t('config.leaveCustomMinutes')}>
                    <input name="leaveCustomMinutes" type="number" min={0} step="1" inputMode="numeric" defaultValue={cfgLeave?.customMinutes ?? ''} placeholder="—" className={inputCls} />
                  </Field>
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.leaveHint')}</p>
              </div>

              {/* Rounding */}
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-3 sm:col-span-2 dark:border-border dark:bg-muted/20">
                <p className="mb-2 text-sm font-medium text-foreground dark:text-foreground">{t('config.roundingTitle')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('config.roundingEarnings')}>
                    <select name="roundingEarnings" defaultValue={cfgRound?.earnings ?? 'none'} className={inputCls}>
                      {ROUNDING_OPTS.map((r) => <option key={r} value={r}>{t(`config.rounding.${r}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('config.roundingDeductions')}>
                    <select name="roundingDeductions" defaultValue={cfgRound?.deductions ?? 'none'} className={inputCls}>
                      {ROUNDING_OPTS.map((r) => <option key={r} value={r}>{t(`config.rounding.${r}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('config.roundingNetPay')}>
                    <select name="roundingNetPay" defaultValue={cfgRound?.netPay ?? 'none'} className={inputCls}>
                      {ROUNDING_OPTS.map((r) => <option key={r} value={r}>{t(`config.rounding.${r}`)}</option>)}
                    </select>
                  </Field>
                </div>
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('config.roundingHint')}</p>
              </div>

              <Field label={t('fieldDescription')}>
                <input name="description" defaultValue={editing?.description ?? ''} placeholder={t('descriptionPlaceholder')} className={`${inputCls} sm:col-span-2`} />
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('typeHint')}</p>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('dailyHint')}</p>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('hourlyHint')}</p>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('customPeriodHint')}</p>
              <div className="flex items-center gap-3 sm:col-span-2">
                <button className={btnPrimary}>{editing ? t('saveChanges') : t('savePolicy')}</button>
                {editing && (
                  <Link href={PAGE} className="text-sm font-medium text-muted-foreground hover:text-foreground">
                    {t('cancelEdit')}
                  </Link>
                )}
              </div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
