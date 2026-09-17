import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { employmentsWithoutBackupShift } from '@/core/roster';
import { listRegisteredDevices } from '@/core/attendance-device';
import { packFor } from '@/localization/registry';
import { Card } from '@/components/ui';
import { StatutoryComponentForm } from '@/components/statutory-component-form';
import { revokeDeviceAction } from './device-actions';
import { SCHEDULE, WORK_SCHEDULE_OVERTIME_ANCHOR } from './schedule-panel';

/** How many uncovered employees are named before the list collapses into "+N". Unchanged from b8aa3466. */
const UNCOVERED_SHOWN = 10;

/**
 * 6d091cc0 (r301) — WORK SCHEDULE & OVERTIME RATES on Attendance › Schedule › General.
 *
 * ── MOVED VERBATIM FROM /admin/attendance-policy/schedule ─────────────────────────────────────────────────
 * The three blocks that page still owned after r287 — backup-shift coverage (b8aa3466), the tenant overtime
 * rates (e776d17d) and the registered clocking devices with Revoke (5249d43f) — rendered here from the same
 * reads, posting to the same writers. That route is a redirect to this card now (#work-schedule-overtime).
 * Nothing is copied or reset: the rates are still the resolved MY statutory ruleset, published through the one
 * `setStatutoryComponentAction` / 'ot' slice path, and Revoke is still `revokeDevice`.
 *
 * ── THE TWO RETURN ADDRESSES ARE PLAIN PATHS, AND ONE OF THEM HAS TO BE ────────────────────────────────────
 * `setStatutoryComponentAction` accepts a `returnTo` only if it matches /^\/[A-Za-z0-9/_-]*$/ (its open-redirect
 * guard) and then APPENDS `?toast=` / `?error=` itself — so a return address carrying `?tab=` or `#…` would be
 * refused and the admin sent to Payroll. The plain Schedule path is the General tab (the default tab), which is
 * exactly where this card is. device-actions.ts returns to the same path.
 *
 * ── PERFORMANCE: THESE READS RUN ON EVERY RENDER OF THE SCHEDULE PAGE, DELIBERATELY ──────────────────────
 * The page renders all six tab panels at once and the tab shell switches between them in the browser without a
 * request (components/personnel-tabs.tsx). The server never learns which tab is showing, so "load this only for
 * General" would leave the General tab empty for anyone who arrived on ?tab=attendance and clicked General. The
 * three reads run in parallel. The devices list grows with headcount; it is one indexed join per render.
 *
 * Company scope: the same `visible` companies the page already narrows every per-company list by.
 */
export async function WorkScheduleOvertimeCard({
  s,
  companies,
}: {
  s: SessionContext;
  companies: readonly { id: string; name: string }[];
}) {
  const t = await getTranslations('admin.attendancePolicy');
  const ts = await getTranslations('admin.scheduleConfig');
  const companyIds = companies.map((c) => c.id);
  const pack = packFor('MY');

  const [devices, uncovered, otRuleset] = await Promise.all([
    listRegisteredDevices(s, companyIds),
    employmentsWithoutBackupShift(s, { companyIds }),
    pack ? pack.statutoryConfig.readActive(s).then((r) => r.ruleset) : Promise.resolve(null),
  ]);

  const multiCompany = companies.length > 1;
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');
  const rm = (n: number) => `RM ${n.toLocaleString('en-MY')}`;

  // Overtime rates (feedback e776d17d) — the SAME resolved MY ruleset the statutory page reads, edited through
  // the SAME 'ot' slice / setStatutoryComponentAction write path. Tenant-global, renders once.
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
    cancelHref: `${SCHEDULE}#overtime-rates`,
  };

  const uncoveredNames = uncovered
    .slice(0, UNCOVERED_SHOWN)
    .map((u) => (u.employeeCode ? `${u.employeeCode} ${u.name}` : u.name))
    .join(', ');

  return (
    <Card id={WORK_SCHEDULE_OVERTIME_ANCHOR} className="scroll-mt-6 overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">{ts('wsOtTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{ts('wsOtHint')}</p>
      </div>

      <div className="grid gap-4 p-4 2xl:grid-cols-2">
        {/* ── Overtime rates (relocated from Payroll > Statutory Configuration — feedback e776d17d) ──────── */}
        {otRuleset && otComponentDefaults && (
          <section id="overtime-rates" className="scroll-mt-6 rounded-xl border border-border p-4">
            <h3 className="text-sm font-semibold text-foreground">{t('otRatesTitle')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('otRatesIntro')}</p>
            <div className="mt-3 grid gap-x-8 sm:grid-cols-3 2xl:grid-cols-1">
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
            {/* returnTo: the PLAIN Schedule path — see the header; the action refuses one with ? or #. */}
            <StatutoryComponentForm
              defaults={otComponentDefaults}
              labels={otComponentLabels}
              lockedBody="ot"
              returnTo={SCHEDULE}
            />
          </section>
        )}

        {/* b8aa3466 — backup-shift coverage. Amber while anyone is still calculated from the company schedule;
            neutral, and explicit about what that schedule is still for, once nobody is. */}
        <section id="backup-shift-coverage" className="scroll-mt-6 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-foreground">{t('coverageTitle')}</h3>
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
        </section>
      </div>

      {/* ── Registered clocking devices (feedback 5249d43f), with per-row Revoke. Revoking blocks web clocking
          from that device (while the company's requirement is on) until the employee registers it again. ── */}
      <section id="registered-devices" className="scroll-mt-6 border-t border-border">
        <div className="px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{t('devicesTitle')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('devicesIntro')}</p>
        </div>
        {devices.length === 0 ? (
          <p className="px-4 pb-6 pt-2 text-center text-sm text-muted-foreground">{t('devicesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-y border-border text-left text-xs text-muted-foreground">
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
      </section>
    </Card>
  );
}
