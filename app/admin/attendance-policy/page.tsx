import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { employmentsWithoutBackupShift } from '@/core/roster';
import { listRegisteredDevices } from '@/core/attendance-device';
import { ensureStandardRule, listAttendanceRules } from '@/core/attendance-rule';
import { packFor } from '@/localization/registry';
import { Badge, Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { StatutoryComponentForm } from '@/components/statutory-component-form';
import { setAttendancePolicyAction } from '../actions';
import { deleteAttendanceRuleAction } from './rule-actions';
import { revokeDeviceAction } from './device-actions';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

/**
 * Attendance policy — R33 f21d6eee: the per-company default working schedule (start/end, break, lateness,
 * working days, OT-approval calculation) AND the tenant-global Overtime rates. Relocated off the Shift
 * Settings page (/admin/attendance), which is now purely the shared shift library. These settings are NOT
 * shift patterns — they drive attendance + pay calculation and must remain configurable. Admin-only via
 * requireAdmin(); each company's policy write is DB-gated by RLS.
 */
export default async function AttendancePolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const { error } = await searchParams;

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const policies = await listAttendancePolicies(s, visible.map((c) => c.id));
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  // 88e94371 — the attendance-rule library. Ensure the tenant's un-deletable Standard rule exists
  // (idempotent), then list every rule. This is the runtime complement of migration 0203.
  // 6da67ab7: the library is tenant-wide — no company column, no company filter. A rule reaches an employee
  // through the SHIFT they are assigned to, and shifts are tenant-wide too.
  const tr = await getTranslations('admin.attendanceRule');
  const multiCompany = visible.length > 1;
  const companyName = new Map(visible.map((c) => [c.id, c.name]));
  await ensureStandardRule(s);
  const rules = await listAttendanceRules(s);

  // Feedback 5249d43f — every active registered clocking device in scope, with per-row revoke (the admin
  // control balancing self-service registration). Lives here because the enforcement switch does too.
  const devices = await listRegisteredDevices(s, visible.map((c) => c.id));
  const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

  // Overtime rates (feedback e776d17d) — the SAME resolved MY ruleset the statutory page reads, edited
  // through the SAME 'ot' slice / setStatutoryComponentAction write path. Tenant-global, renders once.
  const pack = packFor('MY');
  const otRuleset = pack ? (await pack.statutoryConfig.readActive(s)).ruleset : null;
  const otComponentDefaults = otRuleset
    ? {
        epf: {
          employeeRate: otRuleset.epf.employeeRate,
          employerRateLow: otRuleset.epf.employerRateLow,
          employerRateHigh: otRuleset.epf.employerRateHigh,
          employerThreshold: otRuleset.epf.employerThreshold,
        },
        ot: {
          wageCeiling: otRuleset.ot.wageCeiling,
          restDayExcessMultiplier: otRuleset.ot.restDayExcessMultiplier ?? 2,
          holidayExcessMultiplier: otRuleset.ot.holidayExcessMultiplier ?? 3,
        },
        // Rung 5c — the HRDF-levy fallback comes from the pack (D6 vocabulary) not a direct MY import.
        hrdf: otRuleset.hrdf ?? pack!.payroll.hrdfDefault,
      }
    : null;
  const otComponentLabels = {
    effectiveFrom: t('otEffectiveFrom'),
    version: t('otVersion'),
    notes: t('otNotes'),
    otWageCeiling: t('otWageCeiling'),
    otRestDayExcessMultiplier: t('otRestDayExcessMultiplier'),
    otHolidayExcessMultiplier: t('otHolidayExcessMultiplier'),
    publish: t('otPublish'),
    cancelEdit: t('otCancel'),
    cancelHref: '/admin/attendance-policy',
  };
  const rm = (n: number) => `RM ${n.toLocaleString('en-MY')}`;

  // b8aa3466 — the backup-shift coverage gate, made visible on the screen it gates. The reporter asked for
  // the company work schedule to come OFF this page; it can only come off once nobody is calculated from
  // it, and this banner is how you can tell. It is a live count, not a one-off audit: hire someone without
  // a backup shift and the amber state comes back.
  //
  // Coverage reaching zero does NOT make this whole card dead, and the note says so. Universal coverage
  // only closes scheduleFor's third fallback (core/attendance.ts — roster row → backup shift → policy).
  // The working-days list is ALSO read, for every employee shift or no shift, by absence derivation
  // (core/attendance.ts ~2014) and roster generation (core/roster.ts) — and the overtime rates below are
  // the tenant's only editor for the statutory wage ceiling and the rest-day/holiday multipliers.
  const uncovered = await employmentsWithoutBackupShift(s);
  const UNCOVERED_SHOWN = 10;
  const uncoveredNames = uncovered
    .slice(0, UNCOVERED_SHOWN)
    .map((u) => (u.employeeCode ? `${u.employeeCode} ${u.name}` : u.name))
    .join(', ');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={tr('moduleTitle')}
        description={tr('moduleDescription')}
        actions={
          <Link href="/admin/attendance-policy/rules/new" className={btnPrimary}>
            {tr('addNew')}
          </Link>
        }
      />
      <ErrorBanner message={error} />

      {/* ── 88e94371 · Rule library: the reporter's "simple list of available attendance calculation rules" ── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{tr('libraryTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{tr('libraryIntro')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{tr('colName')}</th>
                <th className="px-4 py-2 font-medium">{tr('colDescription')}</th>
                <th className="px-4 py-2 font-medium">{tr('colDefault')}</th>
                <th className="px-4 py-2 font-medium">{tr('colStatus')}</th>
                <th className="px-4 py-2 text-right font-medium">{tr('colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="px-4 py-2 font-medium text-foreground">{r.name}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.description ?? '—'}</td>
                  <td className="px-4 py-2">{r.isDefault ? <Badge>{tr('defaultBadge')}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2">
                    <span className={r.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                      {r.status === 'active' ? tr('statusActive') : tr('statusInactive')}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <Link href={`/admin/attendance-policy/rules/${r.id}`} className="text-primary hover:underline">
                        {tr('edit')}
                      </Link>
                      {!r.isDefault && (
                        <form action={deleteAttendanceRuleAction}>
                          <input type="hidden" name="ruleId" value={r.id} />
                          <button className="text-destructive hover:underline">{tr('delete')}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── Company work schedule & statutory overtime rates. RETAINED through 6da67ab7 for one reason: this
          is the schedule for a day with NO shift assigned, and a shift cannot supply hours for a day it was
          never assigned to. The calculation rules above are the part that moved onto the shift. ─────────── */}
      <div className="border-t border-border pt-2">
        <h2 className="text-sm font-semibold text-foreground">{tr('scheduleSectionTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{tr('scheduleSectionIntro')}</p>
      </div>

      {/* b8aa3466 — backup-shift coverage. Amber while anyone is still calculated from the schedule below;
          neutral, and explicit about what the schedule is still for, once nobody is. */}
      <Card id="backup-shift-coverage" className="scroll-mt-6 p-4">
        <h2 className="text-sm font-semibold text-foreground">{t('coverageTitle')}</h2>
        {uncovered.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('coverageAllCovered')}</p>
        ) : (
          <div className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <p>{t('coverageGap', { count: uncovered.length })}</p>
            <p className="mt-1">
              {t('coverageGapNames', {
                names:
                  uncovered.length > UNCOVERED_SHOWN
                    ? `${uncoveredNames}, +${uncovered.length - UNCOVERED_SHOWN}`
                    : uncoveredNames,
              })}
            </p>
          </div>
        )}
      </Card>

      {/* ── Overtime rates (relocated from Payroll > Statutory Configuration — feedback e776d17d) ──────── */}
      {otRuleset && otComponentDefaults && (
        <Card id="overtime-rates" className="scroll-mt-6 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('otRatesTitle')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('otRatesIntro')}</p>
            </div>
          </div>
          <div className="mt-3 grid gap-x-8 sm:grid-cols-3">
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-sm text-muted-foreground">{t('otWageCeiling')}</span>
              <span className="font-mono text-sm font-medium tabular-nums">{rm(otRuleset.ot.wageCeiling)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-sm text-muted-foreground">{t('otRestDayExcessMultiplier')}</span>
              <span className="font-mono text-sm font-medium tabular-nums">
                {`${otRuleset.ot.restDayExcessMultiplier ?? 2}×`}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-sm text-muted-foreground">{t('otHolidayExcessMultiplier')}</span>
              <span className="font-mono text-sm font-medium tabular-nums">
                {`${otRuleset.ot.holidayExcessMultiplier ?? 3}×`}
              </span>
            </div>
          </div>
          <p className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t('otWageCeilingLegalNote')}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t('otMultipliersNote')}</p>
          <StatutoryComponentForm
            defaults={otComponentDefaults}
            labels={otComponentLabels}
            lockedBody="ot"
            returnTo="/admin/attendance-policy"
          />
        </Card>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          const net = Math.max(0, toMin(p.workEnd) - toMin(p.workStart) - p.breakMinutes);
          return (
            <Card key={c.id} id={`policy-${c.id}`} className="scroll-mt-6">
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
                              setAttendancePolicyAction into the two ISO-weekday arrays the service expects. */}
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

                {/* ADR-0069: how an approved overtime request's minutes are resolved against the engine's figure. */}
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-foreground">{t('otApprovalCalc')}</legend>
                  <Field label={t('otApprovalCalcLabel')}>
                    <select
                      name="otApprovalCalculation"
                      defaultValue={p.otApprovalCalculation}
                      className={inputCls}
                    >
                      <option value="requested">{t('otApprovalRequested')}</option>
                      <option value="system_calculated">{t('otApprovalSystem')}</option>
                      <option value="smaller_of">{t('otApprovalSmaller')}</option>
                      <option value="greater_of">{t('otApprovalGreater')}</option>
                    </select>
                  </Field>
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('otApprovalCalcHint')}</p>
                </fieldset>

                {/* Feedback 5249d43f: registered-device enforcement. Ships OFF so nobody is locked out;
                    flip ON per company once its teams have registered their devices. */}
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-foreground">{t('requireDeviceLegend')}</legend>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      name="requireRegisteredDevice"
                      defaultChecked={p.requireRegisteredDevice}
                      className="size-4 accent-primary"
                    />
                    {t('requireDeviceLabel')}
                  </label>
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('requireDeviceHint')}</p>
                </fieldset>

                <div className="flex items-center gap-3">
                  <button className={btnPrimary}>{t('save')}</button>
                  <span className="text-xs text-muted-foreground">{t('lateHint')}</span>
                </div>
              </form>
            </Card>
          );
        })
      )}

      {/* ── Registered clocking devices (feedback 5249d43f): the admin view of every employee's
          self-registered devices, with per-row revoke. Revoking blocks web clocking from that device
          (while the enforcement switch above is ON) until the employee registers it again. ─────────── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('devicesTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('devicesIntro')}</p>
        </div>
        {devices.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('devicesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('devColEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('devColDevice')}</th>
                  {multiCompany && <th className="px-4 py-2 font-medium">{t('devColCompany')}</th>}
                  <th className="px-4 py-2 font-medium">{t('devColRegistered')}</th>
                  <th className="px-4 py-2 font-medium">{t('devColLastUsed')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('devColAction')}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b border-border/60">
                    <td className="px-4 py-2 font-medium text-foreground">
                      {d.employee}
                      {d.employeeCode && <span className="ml-1.5 text-xs text-muted-foreground">{d.employeeCode}</span>}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{d.label}</td>
                    {multiCompany && (
                      <td className="px-4 py-2 text-muted-foreground">{companyName.get(d.companyId) ?? '—'}</td>
                    )}
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{fmtDate(d.registeredAt)}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{fmtDate(d.lastUsedAt)}</td>
                    <td className="px-4 py-2">
                      <form action={revokeDeviceAction} className="flex justify-end">
                        <input type="hidden" name="deviceId" value={d.id} />
                        <button className="text-destructive hover:underline">{t('devRevoke')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
