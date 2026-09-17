import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { AttendancePolicyView } from '@/core/attendance';
import { Card, ErrorBanner } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { WorkScheduleForm } from './schedule/work-schedule-form';
import { COMPANY_POLICY_ANCHOR, SCHEDULE, policyEditHref, policyViewHref } from './schedule-panel';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = {
  1: 'dayMon',
  2: 'dayTue',
  3: 'dayWed',
  4: 'dayThu',
  5: 'dayFri',
  6: 'daySat',
  7: 'daySun',
};
/** "09:00:00" → "09:00". The column is `time`, which round-trips with seconds nobody reads. */
const hhmm = (v: string) => v.slice(0, 5);
const OT_APPROVAL_KEY = {
  requested: 'otApprovalRequested',
  system_calculated: 'otApprovalSystem',
  smaller_of: 'otApprovalSmaller',
  greater_of: 'otApprovalGreater',
} as const;

type Company = { id: string; name: string };

async function dayNames() {
  const tp = await getTranslations('admin.attendancePolicy');
  /** ISO day numbers → "Mon, Tue, Wed", or an em dash when the set is empty. Never a bare "[]". */
  return (list: readonly number[]) => {
    const set = new Set(list);
    const named = ISO_DAYS.filter((d) => set.has(d)).map((d) => tp(DAY_KEY[d]));
    return named.length > 0 ? named.join(', ') : '—';
  };
}

/**
 * 6d091cc0 (r301) — COMPANY POLICY SETTINGS: one row per company, because that is what the table is.
 *
 * ── THE SHAPE COMES FROM THE SCHEMA ────────────────────────────────────────────────────────────────────────
 * `attendance_policy` is ONE row per company (unique on company_id), written whole by setAttendancePolicy. There
 * is no separate "attendance policy", "working-hour policy" or "rounding" record to list, and the plan told the
 * reporter so. Until this round the General tab stacked one full editor per company down the page; now each
 * company is a row, and View / Edit open that one company in a panel.
 *
 * ── "Saved" / "Using defaults" ────────────────────────────────────────────────────────────────────────────
 * `isDefault` is true only where the company has NO row, i.e. every reader falls back to the built-in defaults
 * (core/attendance.ts DEFAULTS; the device gate reads OFF). A provisioned company HAS a row from day one
 * (db/provision.ts), so it reads Saved even if nobody has changed it — which is exactly why Last updated says
 * "Not recorded" rather than inventing a date for it. See ./policy-last-updated.ts.
 *
 * ── THERE IS NO DELETE, ON PURPOSE ─────────────────────────────────────────────────────────────────────────
 * There is no delete service, and adding one would not tidy a list: it would silently put the company back on
 * Monday-to-Friday defaults and switch the registered-device requirement off. The card says so in words.
 *
 * Company scope is the same `visible` list the page has always used for this data (see the page's note on
 * `getScopeIds`): nothing about who can see or change a company's setting moves in this round.
 */
export async function CompanyPolicyCard({
  companies,
  policies,
  lastUpdated,
}: {
  companies: readonly Company[];
  policies: readonly AttendancePolicyView[];
  lastUpdated: ReadonlyMap<string, Date>;
}) {
  const t = await getTranslations('admin.scheduleConfig');
  const tp = await getTranslations('admin.attendancePolicy');
  const tr = await getTranslations('admin.attendanceRule');
  const days = await dayNames();

  return (
    <Card id={COMPANY_POLICY_ANCHOR} className="scroll-mt-6 overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">
          {t('policyTitle')}
          <span className="ml-2 text-muted-foreground">({companies.length})</span>
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('weekHint')}</p>
      </div>
      {companies.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t('weekEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 font-medium">{t('colSetting')}</th>
                <th className="px-4 py-2 font-medium">{t('colWorkingHours')}</th>
                <th className="px-4 py-2 font-medium">{t('colLastUpdated')}</th>
                <th className="px-4 py-2 text-right font-medium">{tr('colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => {
                const p = policies.find((x) => x.companyId === c.id);
                if (!p) return null;
                const at = lastUpdated.get(c.id);
                return (
                  // `policy-row-…`, NOT `policy-…`: the editor card (WorkScheduleForm) owns `policy-<companyId>`
                  // and renders in the panel on the same page — two elements must never share one id.
                  <tr key={c.id} id={`policy-row-${c.id}`} className="border-b border-border/60">
                    <td className="px-4 py-2 font-medium text-foreground">{c.name}</td>
                    <td className="px-4 py-2">
                      {p.isDefault ? (
                        <span className="whitespace-nowrap rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                          {tp('usingDefaults')}
                        </span>
                      ) : (
                        <span className="whitespace-nowrap rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                          {t('policySaved')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className="whitespace-nowrap tabular-nums">
                        {hhmm(p.workStart)}–{hhmm(p.workEnd)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t('colFullDays')}: {days(p.workingDays)}
                        {p.halfWorkingDays.length > 0 && ` · ${t('colHalfDays')}: ${days(p.halfWorkingDays)}`}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                      {/* The latest attendance-policy.updated for this company, as a Kuala Lumpur calendar date.
                          No event: a company with no row has never been saved (—); a SAVED row with no event
                          was written by provisioning, and the date is genuinely unknown (Not recorded). */}
                      {at ? todayInKualaLumpur(at) : p.isDefault ? '—' : t('lastUpdatedNotRecorded')}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-3">
                        <Link href={policyViewHref(c.id)} className="text-primary hover:underline">
                          {t('policyView')}
                        </Link>
                        <Link href={policyEditHref(c.id)} className="text-primary hover:underline">
                          {tr('edit')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('policyNoDelete')}</p>
    </Card>
  );
}

/** Close a policy panel: back to the plain General tab, on the card the panel was opened from. */
const CLOSE_HREF = `${SCHEDULE}#${COMPANY_POLICY_ANCHOR}`;

/**
 * VIEW — one company's setting, read-only. Every figure is the stored row (or the defaults the readers fall
 * back to, labelled as such); nothing here can be submitted.
 */
export async function CompanyPolicyViewPanel({
  company,
  policy,
  error,
}: {
  company: Company;
  policy: AttendancePolicyView;
  error?: string;
}) {
  const t = await getTranslations('admin.scheduleConfig');
  const tp = await getTranslations('admin.attendancePolicy');
  const days = await dayNames();
  const assigned = new Set([...policy.workingDays, ...policy.halfWorkingDays]);
  const rest = ISO_DAYS.filter((d) => !assigned.has(d));
  const rows: [string, string][] = [
    [t('colSetting'), policy.isDefault ? tp('usingDefaults') : t('policySaved')],
    [tp('workStart'), hhmm(policy.workStart)],
    [tp('workEnd'), hhmm(policy.workEnd)],
    [tp('breakMinutes'), String(policy.breakMinutes)],
    [tp('lateAfter'), hhmm(policy.lateAfter)],
    [tp('halfDayBefore'), hhmm(policy.halfDayBefore)],
    [t('colFullDays'), days(policy.workingDays)],
    [t('colHalfDays'), days(policy.halfWorkingDays)],
    [t('colRestDays'), days(rest)],
    [tp('otApprovalCalcLabel'), tp(OT_APPROVAL_KEY[policy.otApprovalCalculation])],
    [tp('requireDeviceLegend'), policy.requireRegisteredDevice ? t('deviceRequired') : t('deviceNotRequired')],
  ];
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('policyViewTitle', { company: company.name })}</h2>
        <Link href={CLOSE_HREF} className="text-sm text-muted-foreground hover:text-foreground">
          {t('panelClose')}
        </Link>
      </div>
      {error && (
        <div className="px-4 pt-3">
          <ErrorBanner message={error} />
        </div>
      )}
      <dl className="divide-y divide-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-4 py-2 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-border px-4 py-3">
        <Link href={policyEditHref(company.id)} className="text-sm text-primary hover:underline">
          {t('policyEditThis')}
        </Link>
      </div>
    </Card>
  );
}

/**
 * EDIT — that company's existing WorkScheduleForm, and nothing else. It is already a single-company upsert
 * (its hidden companyId, setAttendancePolicyAction), so "saving changes only that company" is the form's own
 * property, not something this panel adds.
 */
export async function CompanyPolicyEditPanel({
  company,
  policy,
  error,
}: {
  company: Company;
  policy: AttendancePolicyView;
  error?: string;
}) {
  const t = await getTranslations('admin.scheduleConfig');
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="text-sm font-semibold text-foreground">{t('policyEditTitle', { company: company.name })}</h2>
        <Link href={CLOSE_HREF} className="text-sm text-muted-foreground hover:text-foreground">
          {t('panelClose')}
        </Link>
      </div>
      <ErrorBanner message={error} />
      <WorkScheduleForm company={company} policy={policy} />
    </div>
  );
}
