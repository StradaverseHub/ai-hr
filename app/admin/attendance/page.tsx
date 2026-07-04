import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { listShifts } from '@/core/roster';
import { formatBreakDisplay } from '@/core/shift-break-display';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ShiftTimeFields } from '@/components/shift-time-fields';
import { ScrollToCompany } from './scroll-to-company';
import { setAttendancePolicyAction } from '../actions';
import { archiveShiftAction, createShiftAction, duplicateShiftAction, updateShiftAction } from './shift-actions';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

/**
 * Attendance Policy — the per-company default working schedule AND (Configurable Multi-Shift Attendance
 * Management) shift-schedule setup. Admin-only via requireAdmin(); shift writes are DB-gated by RLS
 * (migration 0075: shift = app.is_admin_for(company_id)). Shift setup lives here rather than on /roster
 * because it is a policy setting, not a roster-painting task.
 */
export default async function AttendancePolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; companyId?: string; editShift?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const { error, editShift } = await searchParams;

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const policies = await listAttendancePolicies(s, visible.map((c) => c.id));
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));
  // Shifts per visible company (same listShifts read the /roster picker uses — includeArchived defaults off,
  // so archived shifts stay hidden here exactly as they are hidden from the roster shift dropdown).
  const shiftsByCompany = new Map(
    await Promise.all(visible.map(async (c) => [c.id, await listShifts(s, c.id)] as const)),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Suspense fallback={null}>
        <ScrollToCompany />
      </Suspense>
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          const net = Math.max(0, toMin(p.workEnd) - toMin(p.workStart) - p.breakMinutes);
          const shifts = shiftsByCompany.get(c.id) ?? [];
          const editing = editShift ? shifts.find((sh) => sh.id === editShift) : undefined;
          return (
            <Card key={c.id} id={`shifts-${c.id}`} className="scroll-mt-6">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{c.name}</h2>
                {p.isDefault ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                    {t('usingDefaults')}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('netScheduled', { hours: hm(net) })}</span>
                )}
              </div>
              <form action={setAttendancePolicyAction} className="space-y-4 p-4">
                <input type="hidden" name="companyId" value={c.id} />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Field label={t('workStart')}>
                    <input type="time" name="workStart" required defaultValue={p.workStart.slice(0, 5)} className={inputCls} />
                  </Field>
                  <Field label={t('workEnd')}>
                    <input type="time" name="workEnd" required defaultValue={p.workEnd.slice(0, 5)} className={inputCls} />
                  </Field>
                  <Field label={t('breakMinutes')}>
                    <input type="number" name="breakMinutes" min={0} max={480} required defaultValue={p.breakMinutes} className={inputCls} />
                  </Field>
                  <Field label={t('lateAfter')}>
                    <input type="time" name="lateAfter" required defaultValue={p.lateAfter.slice(0, 5)} className={inputCls} />
                  </Field>
                  <Field label={t('halfDayBefore')}>
                    <input type="time" name="halfDayBefore" required defaultValue={p.halfDayBefore.slice(0, 5)} className={inputCls} />
                  </Field>
                </div>

                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-foreground">{t('workingDays')}</legend>
                  <p className="mb-2 text-xs text-muted-foreground">{t('dayTypeHint')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {ISO_DAYS.map((d) => {
                      const dayType: 'full' | 'half' | 'rest' = p.workingDays.includes(d)
                        ? 'full'
                        : p.halfWorkingDays.includes(d)
                          ? 'half'
                          : 'rest';
                      return (
                        <div
                          key={d}
                          className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-1.5"
                        >
                          <span className="text-xs font-medium text-foreground">{t(DAY_KEY[d])}</span>
                          {/* One <select> per weekday posts "full" | "half" | "rest" — decoded server-side in
                              setAttendancePolicyAction into the two ISO-weekday arrays the service expects.
                              Mutual exclusion is structural (one value per day), no extra client JS needed. */}
                          <select
                            name={`dayType_${d}`}
                            defaultValue={dayType}
                            className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                          >
                            <option value="full">{t('dayTypeFull')}</option>
                            <option value="half">{t('dayTypeHalf')}</option>
                            <option value="rest">{t('dayTypeRest')}</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="flex items-center gap-3">
                  <button className={btnPrimary}>{t('save')}</button>
                  <span className="text-xs text-muted-foreground">{t('lateHint')}</span>
                </div>
              </form>

              {/* ── Shift Schedules (Configurable Multi-Shift Attendance Management) ──────────────────── */}
              <div className="border-t border-border">
                <SectionHeader title={t('shiftsSectionTitle')} count={shifts.length} />
                <div className="space-y-4 px-4 py-3">
                  {shifts.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                            <th className="px-4 py-2 font-medium">{t('colShiftName')}</th>
                            <th className="px-4 py-2 font-medium">{t('colTimeIn')}</th>
                            <th className="px-4 py-2 font-medium">{t('colTimeOut')}</th>
                            <th className="px-4 py-2 font-medium">{t('colBreakTime')}</th>
                            <th className="px-4 py-2 font-medium">{t('colWorkingDays')}</th>
                            <th className="px-4 py-2"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {shifts.map((sh) => {
                            const brk = formatBreakDisplay(sh.breakPeriods, sh.breakMinutes);
                            return (
                              <tr key={sh.id} className={editing?.id === sh.id ? 'bg-primary/5' : undefined}>
                                <td className="px-4 py-2.5 font-medium">{sh.code ?? '—'}</td>
                                <td className="px-4 py-2.5">
                                  {sh.name}
                                  {sh.crossesMidnight && (
                                    <span className="ml-1.5 text-xs text-muted-foreground" title={t('crossesMidnight')}>
                                      ⊕
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 tabular-nums">{sh.startTime.slice(0, 5)}</td>
                                <td className="px-4 py-2.5 tabular-nums">{sh.endTime.slice(0, 5)}</td>
                                <td className="px-4 py-2.5">
                                  {brk.text === '' ? (
                                    <span className="text-muted-foreground">{t('noBreak')}</span>
                                  ) : (
                                    <span className="tabular-nums">{brk.text}</span>
                                  )}
                                  {brk.mismatchMinutes != null && (
                                    <span
                                      className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
                                      title={t('breakMismatchNote', { minutes: brk.mismatchMinutes })}
                                    >
                                      {t('breakMismatchBadge', { minutes: brk.mismatchMinutes })}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5">
                                  {sh.weeklyPattern && sh.weeklyPattern.length > 0 ? (
                                    <span className="flex flex-wrap gap-1">
                                      {ISO_DAYS.filter((d) => sh.weeklyPattern!.includes(d)).map((d) => (
                                        <span
                                          key={d}
                                          className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                                        >
                                          {t(DAY_KEY[d])}
                                        </span>
                                      ))}
                                    </span>
                                  ) : (
                                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                      {t('notSet')}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5">
                                  <div className="flex items-center justify-end gap-3">
                                    <Link
                                      href={`/admin/attendance?companyId=${c.id}&editShift=${sh.id}#shifts-${c.id}`}
                                      className="text-xs font-medium text-primary hover:underline"
                                    >
                                      {t('editShift')}
                                    </Link>
                                    <form action={duplicateShiftAction}>
                                      <input type="hidden" name="shiftId" value={sh.id} />
                                      <input type="hidden" name="companyId" value={c.id} />
                                      <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                                        {t('duplicate')}
                                      </button>
                                    </form>
                                    <form action={archiveShiftAction}>
                                      <input type="hidden" name="shiftId" value={sh.id} />
                                      <input type="hidden" name="companyId" value={c.id} />
                                      <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                                        {t('archiveShift')}
                                      </button>
                                    </form>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Create OR edit form. `key` forces React to reset the ShiftTimeFields island's internal
                      state when switching between add and a specific shift's edit. */}
                  <form
                    key={editing?.id ?? 'new'}
                    action={editing ? updateShiftAction : createShiftAction}
                    className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
                  >
                    <input type="hidden" name="companyId" value={c.id} />
                    {editing && <input type="hidden" name="shiftId" value={editing.id} />}
                    <input
                      name="name"
                      required
                      placeholder={t('shiftName')}
                      defaultValue={editing?.name ?? ''}
                      className={`${inputCls} w-40`}
                      aria-label={t('shiftName')}
                    />
                    <input
                      name="code"
                      required
                      placeholder={t('shiftCode')}
                      defaultValue={editing?.code ?? ''}
                      className={`${inputCls} w-24`}
                      aria-label={t('shiftCode')}
                    />
                    <ShiftTimeFields
                      defaultStart={editing?.startTime.slice(0, 5) ?? '09:00'}
                      defaultEnd={editing?.endTime.slice(0, 5) ?? '18:00'}
                      defaultBreaks={(editing?.breakPeriods ?? []).map((bp) => ({ start: bp.start.slice(0, 5), end: bp.end.slice(0, 5) }))}
                      defaultBreakMinutes={editing ? String(editing.breakMinutes) : '60'}
                      defaultOverride={editing?.normalMinutesOverride != null ? String(editing.normalMinutesOverride) : ''}
                    />
                    <select
                      name="differentialKind"
                      defaultValue={editing?.differential?.kind ?? ''}
                      className={inputCls}
                      aria-label={t('diffLabel')}
                    >
                      <option value="">{t('diffNone')}</option>
                      <option value="percent">{t('diffPercent')}</option>
                      <option value="flat_hourly">{t('diffFlatHourly')}</option>
                      <option value="flat_per_shift">{t('diffPerShift')}</option>
                    </select>
                    <input
                      name="differentialValue"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder={t('diffValue')}
                      defaultValue={editing?.differential?.value ?? ''}
                      className={`${inputCls} w-24`}
                      aria-label={t('diffValue')}
                    />
                    {/* Mon–Sun Working/Rest toggle — same has-[:checked] row as the working-days editor above.
                        Checked = working day; unchecked = rest. New shift defaults Mon–Fri. */}
                    <fieldset className="w-full">
                      <legend className="mb-1.5 text-sm font-medium text-foreground">
                        {t('shiftWorkingDays')}{' '}
                        <span className="font-normal text-muted-foreground">
                          ({t('shiftWorking')} / {t('shiftRest')})
                        </span>
                      </legend>
                      <div className="flex flex-wrap gap-1.5">
                        {ISO_DAYS.map((d) => {
                          const checked = editing
                            ? (editing.weeklyPattern?.includes(d) ?? false)
                            : d <= 5;
                          return (
                            <label
                              key={d}
                              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary"
                            >
                              <input
                                type="checkbox"
                                name="weeklyPattern"
                                value={d}
                                defaultChecked={checked}
                                className="h-3.5 w-3.5 accent-primary"
                              />
                              {t(DAY_KEY[d])}
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="flex w-full items-center gap-3">
                      <button className={btnPrimary}>{editing ? t('saveShift') : t('addShift')}</button>
                      {editing && (
                        <Link
                          href={`/admin/attendance?companyId=${c.id}#shifts-${c.id}`}
                          className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {t('cancelEdit')}
                        </Link>
                      )}
                    </div>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('shiftHint')}</p>
                  <p className="text-xs text-muted-foreground">{t('multiBreakStorageHint')}</p>
                </div>
              </div>
            </Card>
          );
        })
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('rosterNote')}</p>
    </div>
  );
}
