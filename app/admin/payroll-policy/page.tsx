import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPolicies, POLICY_TYPES, type PolicyRow } from '@/core/payroll-policy';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                <p className="mt-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('cutOff.anchorDayHint')}</p>
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
