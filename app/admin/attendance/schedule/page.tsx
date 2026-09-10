import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { listShiftsForTenant } from '@/core/roster';
import { ClientTabs } from '@/components/personnel-tabs';
import {
  Card,
  PageHeader,
  SectionHeader,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { SCHEDULE_TAB_KEYS, type ScheduleTabKey } from './tabs';

/**
 * Schedule (feedback 1c5602cc, r263) — the tabbed configuration screen for an employee's WORKING PATTERN.
 *
 * ⚠️ READ THE AUDIT BEFORE ADDING A CONTROL HERE. This screen was built after an audit of what the six
 * requested tabs actually have behind them, and the audit is the reason the General tab looks the way it
 * does. Three of the six things the General tab was asked to hold ARE NOT STORED ANYWHERE:
 *
 *   · ROTATION — there is no rotation cycle, anywhere. `core/roster.ts generateRosterFromTemplate` is a
 *     ONE-SHOT action over a date range driven by `shift.weekly_pattern`; nothing persists "advance the
 *     crew one step each week". A "rotation" control would need a table that does not exist.
 *   · DUTY ROSTER CONTROLS — the roster's governing rule is CODE, not configuration:
 *     `core/roster.ts canWriteRosterDate` (today-or-earlier is administrator-only) and RLS
 *     (`app.can_admin_employment`). There is no roster settings row to edit.
 *   · THE MONTHLY OVERTIME-HOUR CAP — `db/schema.ts:2506 maxHoursPerMonth` is real, but it lives on the
 *     PAYROLL POLICY's config JSONB, not on anything schedule-shaped, and it is edited on Payroll.
 *
 * And one is only PARTLY real: the day-type allow-list (db/schema.ts:1287-1295) is a LEAVE-counting
 * vector on `leave_type`, its offDay/restDay keys collapse to one non-working-weekday bucket, and
 * companyHoliday/shutdownDay are STORED-BUT-INERT (their resolver is Phase B).
 *
 * So the General tab shows what IS stored — the shift library and the per-company working week, read from
 * their own tables — and NAMES the four gaps in plain words instead of drawing a box behind each. AGENTS
 * 28: a control drawn at a value nothing wires up is worse than an absent one. Do not "finish" this
 * screen by adding those four controls; finish it by shipping the storage first.
 *
 * WHY IT IS READ-ONLY, WHICH IS A DESIGN DECISION AND NOT AN UNFINISHED EDGE. Everything the General tab
 * shows already HAS an editor: the shift library (/admin/attendance/[shiftId]) and the company work
 * schedule (/admin/attendance-policy/schedule). Adding a second form over `shift` and `attendance_policy`
 * here would be two write paths over one table, which is exactly how the Schedule Assignment screen
 * (0bade264) argued itself into being a link rather than a form — and those editors carry validation
 * (disjoint Full/Half/Off CHECKs, coherent start/end) a copy would have to re-implement and eventually
 * re-implement differently. Every section therefore ends in a link to the editor that owns the value.
 *
 * ALONGSIDE, NOT INSTEAD (the a6fe37fc playbook). The existing "Work Schedule" row → /admin/attendance-
 * policy/schedule is UNTOUCHED by this round and keeps working. Nothing is moved or removed until a round
 * is explicitly the cutover.
 *
 * THE OTHER FIVE TABS ARE NAMED AND EMPTY, ON PURPOSE. Holiday / Overtime / Attendance / Request /
 * Notification render the shell's `emptyLabel` and nothing else, so the shape the reporter asked for is
 * visible and nobody wonders whether a tab was forgotten. They are not placeholders for settings that
 * exist; each will be defined and built as its own piece of work.
 *
 * requireAdmin(), like every other row of the Attendance settings menu it hangs under. The menu is not
 * what protects it.
 */
export default async function ScheduleConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleConfig');
  const tp = await getTranslations('admin.attendancePolicy');
  const sp = await searchParams;

  // Deep-link / reload survival: the shell reflects its tab into `?tab=`, so honour it on the way back in.
  // Read by VALUE against the closed key list — an unknown value falls back to General rather than
  // rendering a tab that does not exist.
  const defaultTab: ScheduleTabKey = (SCHEDULE_TAB_KEYS as readonly string[]).includes(sp.tab ?? '')
    ? (sp.tab as ScheduleTabKey)
    : 'general';

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const [policies, shifts] = await Promise.all([
    listAttendancePolicies(s, visible.map((c) => c.id)),
    listShiftsForTenant(s),
  ]);
  const companyName = new Map(visible.map((c) => [c.id, c.name]));

  const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
  const DAY_LABEL: Record<number, string> = {
    1: tp('dayMon'),
    2: tp('dayTue'),
    3: tp('dayWed'),
    4: tp('dayThu'),
    5: tp('dayFri'),
    6: tp('daySat'),
    7: tp('daySun'),
  };
  /** ISO day numbers → "Mon, Tue, Wed", or an em dash when the set is empty. Never a bare "[]". */
  const days = (list: readonly number[] | null | undefined) => {
    const set = new Set(list ?? []);
    const named = ISO_DAYS.filter((d) => set.has(d)).map((d) => DAY_LABEL[d]);
    return named.length > 0 ? named.join(', ') : '—';
  };
  /** "09:00:00" → "09:00". The DB stores `time`, which round-trips with seconds nobody reads. */
  const hhmm = (v: string | null | undefined) => (v ? v.slice(0, 5) : '—');

  const general = (
    <>
      {/* ── Which shifts are available ─────────────────────────────────────────────────────────────
          The tenant-wide shift library, non-archived, exactly as the roster and the engine see it
          (core/roster.ts listShiftsForTenant — one ordering, so this readout cannot disagree with the
          list the shift library itself renders). Rest is DERIVED, never stored: a weekday in none of
          weekly_pattern / half_pattern / off_pattern is a Rest day, which is what the four-way row
          (b8aa3466, migration 0429) means. */}
      <Card>
        <SectionHeader title={t('shiftsTitle')} count={shifts.length} subtitle={t('shiftsHint')} />
        {shifts.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t('shiftsEmpty')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('colCode')}</th>
                  <th className={thCls}>{t('colName')}</th>
                  <th className={thCls}>{t('colHours')}</th>
                  <th className={thCls}>{t('colFullDays')}</th>
                  <th className={thCls}>{t('colHalfDays')}</th>
                  <th className={thCls}>{t('colOffDays')}</th>
                  <th className={thCls}>{t('colRestDays')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {shifts.map((sh) => {
                  const assigned = new Set<number>([
                    ...(sh.weeklyPattern ?? []),
                    ...(sh.halfPattern ?? []),
                    ...(sh.offPattern ?? []),
                  ]);
                  const rest = ISO_DAYS.filter((d) => !assigned.has(d));
                  const noPattern = (sh.weeklyPattern ?? []).length === 0 && (sh.halfPattern ?? []).length === 0;
                  return (
                    <tr key={sh.id}>
                      <td className="px-3 py-2 font-mono text-xs">{sh.code ?? '—'}</td>
                      <td className="px-3 py-2">
                        <Link href={`/admin/attendance/${sh.id}`} className="text-primary hover:underline">
                          {sh.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {hhmm(sh.startTime)}–{hhmm(sh.endTime)}
                      </td>
                      {/* A shift with no Full and no Half weekday cannot drive roster generation at all
                          (core/roster.ts refuses it), so say that once across the row rather than
                          printing three em dashes that look like a formatting accident. */}
                      {noPattern ? (
                        <td className="px-3 py-2 text-muted-foreground" colSpan={4}>
                          {t('noPattern')}
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2">{days(sh.weeklyPattern)}</td>
                          <td className="px-3 py-2">{days(sh.halfPattern)}</td>
                          <td className="px-3 py-2">{days(sh.offPattern)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{days(rest)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border px-4 py-3">
          <Link href="/admin/attendance" className="text-sm text-primary hover:underline">
            {t('shiftLibraryLink')}
          </Link>
        </div>
      </Card>

      {/* ── Rest days, off days and working-hour limits, per company ───────────────────────────────
          attendance_policy is the schedule for a day with NO shift assigned (core/attendance.ts
          scheduleFor's last fallback), and its working-days list is ALSO read for every employee by
          absence derivation and by roster generation — so it governs the working pattern even where a
          shift exists. `isDefault` marks a company with no row of its own: those figures are the
          code defaults, not something anybody chose, and the row says so. */}
      <Card>
        <SectionHeader title={t('weekTitle')} count={visible.length} subtitle={t('weekHint')} />
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t('weekEmpty')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('colCompany')}</th>
                  <th className={thCls}>{t('colWorkingHours')}</th>
                  <th className={thCls}>{t('colBreak')}</th>
                  <th className={thCls}>{t('colFullDays')}</th>
                  <th className={thCls}>{t('colHalfDays')}</th>
                  <th className={thCls}>{t('colRestDays')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {policies.map((p) => {
                  const assigned = new Set<number>([...(p.workingDays ?? []), ...(p.halfWorkingDays ?? [])]);
                  const rest = ISO_DAYS.filter((d) => !assigned.has(d));
                  return (
                    <tr key={p.companyId}>
                      <td className="px-3 py-2">
                        {companyName.get(p.companyId) ?? p.companyId}
                        {p.isDefault && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {t('usingDefaults')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {hhmm(p.workStart)}–{hhmm(p.workEnd)}
                      </td>
                      <td className="px-3 py-2">{t('breakMinutes', { n: p.breakMinutes })}</td>
                      <td className="px-3 py-2">{days(p.workingDays)}</td>
                      <td className="px-3 py-2">{days(p.halfWorkingDays)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{days(rest)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border px-4 py-3">
          <Link href="/admin/attendance-policy/schedule" className="text-sm text-primary hover:underline">
            {t('workScheduleLink')}
          </Link>
        </div>
      </Card>

      {/* ── The four gaps, named ───────────────────────────────────────────────────────────────────
          THIS CARD IS A DELIVERABLE, not an apology. The approved plan promises: "where a setting
          genuinely does not exist yet we will say so rather than draw a box that does nothing". Each
          entry below is one of those, with the reason and — where the thing IS governed, just not from
          here — where it is governed from. Delete an entry only when its storage actually ships. */}
      <Card>
        <SectionHeader title={t('gapsTitle')} subtitle={t('gapsHint')} />
        <dl className="divide-y divide-border">
          <div className="px-4 py-3">
            <dt className="text-sm font-medium">{t('gapRotationTitle')}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">{t('gapRotationBody')}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-sm font-medium">{t('gapRosterTitle')}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">
              {t('gapRosterBody')}{' '}
              <Link href="/roster" className="text-primary hover:underline">
                {t('rosterLink')}
              </Link>
            </dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-sm font-medium">{t('gapDayTypesTitle')}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">{t('gapDayTypesBody')}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-sm font-medium">{t('gapOtCapTitle')}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">{t('gapOtCapBody')}</dd>
          </div>
        </dl>
      </Card>
    </>
  );

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('pageTitle')} description={t('pageSubtitle')} />
      <ClientTabs<ScheduleTabKey>
        ariaLabel={t('tabsAria')}
        defaultTab={defaultTab}
        emptyLabel={t('notBuiltYet')}
        tabs={[
          { key: 'general', label: t('tabGeneral') },
          { key: 'holiday', label: t('tabHoliday') },
          { key: 'overtime', label: t('tabOvertime') },
          { key: 'attendance', label: t('tabAttendance') },
          { key: 'request', label: t('tabRequest') },
          { key: 'notification', label: t('tabNotification') },
        ]}
        panels={{ general }}
      />
    </div>
  );
}
