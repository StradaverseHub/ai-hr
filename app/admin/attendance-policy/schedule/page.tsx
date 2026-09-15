import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { employmentsWithoutBackupShift } from '@/core/roster';
import { listRegisteredDevices } from '@/core/attendance-device';
import { packFor } from '@/localization/registry';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { StatutoryComponentForm } from '@/components/statutory-component-form';
import { WorkScheduleForm } from './work-schedule-form';
import { revokeDeviceAction } from '../device-actions';

const RULES = '/admin/attendance-policy';
const SELF = '/admin/attendance-policy/schedule';


/**
 * af7a8eb4 · "Company work schedule & overtime rates", on its own page.
 *
 * Everything here was RELOCATED verbatim from /admin/attendance-policy, which the reporter asked to be the
 * calculation-rule list and nothing else: the backup-shift coverage card, the tenant-global Overtime rates,
 * one work-schedule form per company, and the registered-devices table. NOTHING is deleted and no value
 * changes — moving is not deleting.
 *
 * Why the schedule is RETAINED at all (unchanged through 6da67ab7): this is the schedule for a day with NO
 * shift assigned, and a shift cannot supply hours for a day it was never assigned to. Removing it is a
 * separate, still-open decision.
 *
 * ── e4471e3c (r287): THE MENU ROW WENT, THE SCREEN DID NOT ─────────────────────────────────────────
 * The reporter asked for the Work Schedule sub-menu to be consolidated into Attendance > Schedule, so the
 * "Work Schedule" nav row is gone and the per-company working-week editor is rendered on that screen's
 * General tab. This PAGE is deliberately kept, for two reasons the plan states:
 *
 *   · it still owns things that did NOT move — the tenant Overtime RATES (a statutory ruleset, not
 *     attendance_policy), the registered-device table and the backup-shift coverage card; and
 *   · `lib/permissions.ts` registers this route under the `attendancePolicyConfig` screenKey, which is a
 *     permission identity: removing the route would silently revoke grants.
 *
 * It is reached from the Schedule screen's General tab, which links here, and from the Schedule Group
 * list's header button. The working-week form below is the SAME component the tab renders
 * (app/admin/attendance-policy/schedule/work-schedule-form.tsx) posting to the SAME action — one writer, two mounts, so the two
 * screens cannot store different rows.
 *
 * Admin-only via requireAdmin(); each company's policy write is DB-gated by RLS. This page keeps the
 * max-w-4xl reading width the settings had — it is a stack of paired time inputs, which full width makes
 * harder to fill in, not easier.
 */
export default async function AttendanceSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const tr = await getTranslations('admin.attendanceRule');
  const { error } = await searchParams;

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const policies = await listAttendancePolicies(s, visible.map((c) => c.id));
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  const multiCompany = visible.length > 1;
  const companyName = new Map(visible.map((c) => [c.id, c.name]));

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
    cancelHref: SELF,
  };
  const rm = (n: number) => `RM ${n.toLocaleString('en-MY')}`;

  // b8aa3466 — the backup-shift coverage gate, made visible on the screen it gates. The reporter asked for
  // the company work schedule to come OFF the rules page; it can only come off once nobody is calculated
  // from it, and this banner is how you can tell. It is a live count, not a one-off audit: hire someone
  // without a backup shift and the amber state comes back.
  //
  // Coverage reaching zero does NOT make this whole card dead, and the note says so. Universal coverage
  // only closes scheduleFor's third fallback (core/attendance.ts — roster row → backup shift → policy).
  // The working-days list is ALSO read, for every employee shift or no shift, by absence derivation
  // (core/attendance.ts ~2014) and roster generation (core/roster.ts) — and the overtime rates below are
  // the tenant's only editor for the statutory wage ceiling and the rest-day/holiday multipliers.
  // b8aa3466 — scoped to the SAME companies every other list on this page uses (`visible`, from
  // getScopeIds). An unscoped count here reported employees the viewer cannot open.
  const uncovered = await employmentsWithoutBackupShift(s, { companyIds: visible.map((c) => c.id) });
  const UNCOVERED_SHOWN = 10;
  const uncoveredNames = uncovered
    .slice(0, UNCOVERED_SHOWN)
    .map((u) => (u.employeeCode ? `${u.employeeCode} ${u.name}` : u.name))
    .join(', ');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={tr('scheduleSectionTitle')}
        description={tr('scheduleSectionIntro')}
        back={{ href: RULES, label: tr('scheduleBackToRules') }}
      />
      <ErrorBanner message={error} />

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
            returnTo={SELF}
          />
        </Card>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          // r287 — the editor MOVED into a shared component so the Schedule screen's General tab renders
          // the identical form posting to the identical action. `returnTo` is what sends a save back to
          // the screen it was made on; it is resolved against a closed list server-side, never as a URL.
          return <WorkScheduleForm key={c.id} company={{ id: c.id, name: c.name }} policy={p} returnTo="work-schedule" />;
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
