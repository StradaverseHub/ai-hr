import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { ensureStandardRule, listAttendanceRules } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import { weekPatternFor, weekPatternGroupFor } from '@/core/week-pattern';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { ScheduleGroupCard } from '../../attendance-policy/schedule-group-card';
import {
  CompanyPolicyCard,
  CompanyPolicyEditPanel,
  CompanyPolicyViewPanel,
} from '../../attendance-policy/company-policy-card';
import { WorkScheduleOvertimeCard } from '../../attendance-policy/work-schedule-overtime-card';
import { policyLastUpdated } from '../../attendance-policy/policy-last-updated';
import { SCHEDULE_PANEL_ANCHOR, resolveSchedulePanel } from '../../attendance-policy/schedule-panel';

/**
 * Schedule (feedback 1c5602cc r263; contested and made list + detail by 665de026, r331) — THE LIST.
 *
 * ══ WHAT THIS SCREEN WAS, AND WHY IT IS NOT THAT ANY MORE ═══════════════════════════════════════════════
 * r263 built it as six tabs; r277 filled two of them; r301 pulled the Schedule Group list, the Company
 * Policy settings and the Work Schedule & Overtime card onto the General tab and made Add / Edit open as a
 * PANEL over them. The result was one page carrying every Schedule Group's settings at once, with a group
 * picker on two tabs that had to be set separately, and an editor that opened on top of four cards it had
 * nothing to do with. The reporter called it crowded and asked for a list, and a page per Schedule Group,
 * titled in their own words: Add Schedule · View Schedule · Edit Schedule.
 *
 * THE SHAPE IS COPIED, NOT INVENTED, and the precedent is next door. app/admin/attendance/schedule-
 * assignment got here the hard way: r263 shipped an inline edit panel over the list, the reporter
 * contested it, r265 made it list + `[employmentId]` detail. Same correction, same screen family, so the
 * two Attendance sub-screens are navigated one way instead of two.
 *
 * ══ ⚠️ WHY FOUR CARDS STAYED HERE, WHEN THE PLAN SAID "ALL THE SETTING SECTIONS MOVE" ═══════════════════
 * Because four of the five cards on the old General tab ARE NOT PER-SCHEDULE-GROUP, and a page per
 * Schedule Group has nowhere to put them. Measured card by card in
 * docs/audits/665de026-schedule-save-classification.md §5:
 *
 *   · Shifts available          → the TENANT's shift library (one row per shift, no group).
 *   · Schedule Group            → the list itself. This is the one that moved: it IS this page now.
 *   · Company Policy Settings   → one row per COMPANY (`attendance_policy`). Its editor writes a company.
 *   · Work Schedule & Overtime  → TENANT overtime rates, backup-shift coverage, registered devices.
 *   · Not configured here       → a statement about the product, not a record.
 *
 * Moving any of them onto a group's page would have meant one of two things: drawing a company's working
 * week on a screen headed by a Schedule Group's name, or retiring four working screens (and breaking the
 * two redirect stubs r301 pointed at them, which is how every old bookmark still lands). Neither is what
 * "no Schedule data is changed, deleted, duplicated or reset" means. So the LIST is the Schedule Group
 * list FIRST, and the four tenant- and company-wide cards follow it.
 *
 * ⚠️ READ THE AUDIT BEFORE ADDING A CONTROL HERE. Three of the six things the General tab was asked to
 * hold ARE NOT STORED ANYWHERE:
 *
 *   · ROTATION — there is no rotation cycle, anywhere. `core/roster.ts generateRosterFromTemplate` is a
 *     ONE-SHOT action over a date range driven by `shift.weekly_pattern`; nothing persists "advance the
 *     crew one step each week". A "rotation" control would need a table that does not exist.
 *   · DUTY ROSTER CONTROLS — the roster's governing rule is CODE, not configuration:
 *     `core/roster.ts canWriteRosterDate` (today-or-earlier is administrator-only) and RLS
 *     (`app.can_admin_employment`). There is no roster settings row to edit.
 *   · THE MONTHLY OVERTIME-HOUR CAP — `db/schema.ts maxHoursPerMonth` is real, but it lives on the
 *     PAYROLL POLICY's config JSONB, not on anything schedule-shaped, and it is edited on Payroll.
 *
 * And one is only PARTLY real: the day-type allow-list is a LEAVE-counting vector on `leave_type`, its
 * offDay/restDay keys collapse to one non-working-weekday bucket, and companyHoliday/shutdownDay are
 * STORED-BUT-INERT (their resolver is Phase B). The "Not configured here" card names all four in plain
 * words instead of drawing a box behind each. A control drawn at a value nothing wires up is worse than an
 * absent one: do not "finish" this screen by adding those four controls; finish it by shipping the storage
 * first. That is exactly what 07ebd04d did for the seventh section — see ./sections.ts.
 *
 * ══ WHAT EACH ROW ACTION DOES, AND WHERE IT LEAVES YOU ═════════════════════════════════════════════════
 * View and Edit open the group's own page (./[ruleId] and ./[ruleId]/edit). Add New Schedule opens ./new.
 * Duplicate, Activate/Deactivate and Delete stay HERE and return here: they are actions ON the list, and a
 * delete has no record page left to return to. Delete is still behind a confirmation and the service still
 * refuses the Standard group and any group a shift still uses.
 *
 * ══ ONE PANEL STILL OPENS ON THIS PAGE, AND IT IS NOT A SCHEDULE GROUP ═════════════════════════════════
 * `?policy=` / `?viewPolicy=` — the COMPANY policy editor and its read-only twin. Its record is a company,
 * so it has no per-group page to move to; it stays where its card is. Every parameter is read by VALUE
 * against what exists for this viewer (../../attendance-policy/schedule-panel.ts). `?editGroup=` is GONE
 * with the panel it addressed.
 *
 * requireAdmin(), like every other row of the Attendance settings menu it hangs under. The menu is not
 * what protects it (test/attendance-menu-relocation.test.ts).
 */
export default async function ScheduleListPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; policy?: string; viewPolicy?: string }>;
}) {
  const s = await requireAdmin();
  const settingsT = await getTranslations('attendanceSettingsHub');
  const t = await getTranslations('admin.scheduleConfig');
  const tp = await getTranslations('admin.attendancePolicy');
  const sp = await searchParams;

  // ⚠️ WHAT `visible` ACTUALLY MEANS HERE, because it is easy to read it as the opposite. `listCompanies`
  // is scoped to the TENANT, not to the viewer (lib/scope.ts:24-28, feedback ab77dc1f), and `getScopeIds`
  // returns its argument UNCHANGED when no `company_scope` cookie is set (lib/scope.ts:11-18). So this
  // narrows by the multi-company SWITCHER only: a company-scoped hr_admin with no switcher selection sees
  // EVERY company's working week on this card, not just the ones their grant reaches. The r263 risk note
  // originally claimed the reverse ("a narrow scope sees only their companies"); it was wrong.
  //
  // Deliberately left as-is rather than quietly tightened: /admin/attendance-policy/schedule used the
  // byte-identical requireAdmin() → listCompanies → getScopeIds pattern over the SAME attendance_policy rows,
  // and since r301 that page IS this one — Company Policy Settings, the devices table and the backup-coverage
  // count all read `visible`. RLS still gates every write per company. When this is tightened, tighten it here
  // once, to `allowedCompanies` (lib/scope.ts scopedSession returns it alongside `allowedCount`).
  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  // r301 — the Schedule Group LIST lives on this page, so the runtime complement of migration 0203 lives with
  // it: make sure the tenant's un-deletable Standard group exists (idempotent; appends an event only when it
  // creates the row) BEFORE listing, exactly as /admin/attendance-policy did.
  await ensureStandardRule(s);
  const visibleIds = visible.map((c) => c.id);
  const [policies, shifts, rules, lastUpdated] = await Promise.all([
    listAttendancePolicies(s, visibleIds),
    listShiftsForTenant(s),
    // r277 — the Schedule Groups. TENANT-WIDE, not company-scoped (6da67ab7 / migration 0319 removed that
    // axis), so unlike the working-week card below this list is not narrowed by the company switcher and
    // must not be: a shift is tenant-wide and binds its group, so there is no company to narrow by.
    // Ordered Standard-first then by name by listAttendanceRules itself.
    listAttendanceRules(s),
    // r301 — Company Policy Settings' "Last updated", off the audit ledger (no updated_at column exists).
    policyLastUpdated(s, visibleIds),
  ]);

  const panel = resolveSchedulePanel(sp, visibleIds);
  const panelCompany = panel ? visible.find((c) => c.id === panel.companyId) : undefined;
  const panelPolicy = panelCompany ? policies.find((p) => p.companyId === panelCompany.id) : undefined;
  const panelNode =
    panel?.kind === 'policy-edit' && panelCompany && panelPolicy ? (
      <CompanyPolicyEditPanel company={panelCompany} policy={panelPolicy} error={sp.error} />
    ) : panel?.kind === 'policy-view' && panelCompany && panelPolicy ? (
      <CompanyPolicyViewPanel company={panelCompany} policy={panelPolicy} error={sp.error} />
    ) : null;

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

  return (
    <div className={pageWideCls}>
      <AttendanceSettingsNavigation />
      <PageHeader back={{ href: '/admin/attendance/settings', label: settingsT('backToSettings') }} title={t('pageTitle')} description={t('listSubtitle')} />
      {/* A refusal from a row action (Duplicate, Activate/Deactivate, Delete) lands here. While a company
          policy panel is open the refusal belongs to the panel and is shown there instead, so the same
          message is never printed twice. */}
      <ErrorBanner message={panelNode ? undefined : sp.error} />

      {/* ── THE LIST ITSELF, FIRST ─────────────────────────────────────────────────────────────────────
          "Attendance → Schedule stays as the LIST: every Schedule Group, its name, enough to tell them
          apart" — the reporter's words. It is the first thing on the page because it is what the page is
          for; the four cards below it are the tenant- and company-wide settings that have no per-group
          page to move to. */}
      <ScheduleGroupCard rules={rules} />

      <div className={panelNode ? 'grid items-start gap-6 min-[1900px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]' : 'space-y-6'}>
        <div className="min-w-0 space-y-6">
          {/* ── Which shifts are available ───────────────────────────────────────────────────────────
              The tenant-wide shift library, non-archived, exactly as the roster and the engine see it
              (core/roster.ts listShiftsForTenant — one ordering, so this readout cannot disagree with the
              list the shift library itself renders). Rest is DERIVED, never stored: a weekday in none of
              weekly_pattern / half_pattern / off_pattern is a Rest day, which is what the four-way row
              (b8aa3466, migration 0429) means.

              r429 (f6819e19) · D8 — REWORDED: this table now shows the WEEK IN FORCE (`weekPatternFor`,
              group-first then shift), not the shift's own raw row. The comment this replaces said the two
              were deliberately "never merged into one column" — that was true while the Shift page still
              edited the shift's own week beside this table and the two readouts answered different
              questions on purpose. The Shift page no longer edits it (D1): a reader comparing "Shifts
              available" against a shift's own page now wants the one answer the engine actually uses, the
              same correction app/admin/attendance/page.tsx's list received. The Schedule Group's OWN
              working-week editor is still the group's page (./sections.ts `workingDay`) and nothing here
              writes to it. */}
          <Card id="shifts-available" className="scroll-mt-6">
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
                      // r429 (f6819e19) · D8 — the SAME resolver the engine, the Shift form's read-only
                      // preview, and the Shift list all use: the group this shift resolves to (blank
                      // ruleId ⇒ the tenant's Standard rule), and the week ACTUALLY IN FORCE.
                      const group = weekPatternGroupFor(rules, sh.ruleId);
                      const resolved = weekPatternFor(
                        group ? { pattern: group.weeklyPattern, halfPattern: group.halfPattern, offPattern: group.offPattern } : null,
                        { pattern: sh.weeklyPattern, halfPattern: sh.halfPattern, offPattern: sh.offPattern },
                      );
                      const assigned = new Set<number>([
                        ...(resolved.pattern ?? []),
                        ...(resolved.halfPattern ?? []),
                        ...(resolved.offPattern ?? []),
                      ]);
                      const rest = ISO_DAYS.filter((d) => !assigned.has(d));
                      const noPattern = (resolved.pattern ?? []).length === 0 && (resolved.halfPattern ?? []).length === 0;
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
                              <td className="px-3 py-2">{days(resolved.pattern)}</td>
                              <td className="px-3 py-2">{days(resolved.halfPattern)}</td>
                              <td className="px-3 py-2">{days(resolved.offPattern)}</td>
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
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border px-4 py-3">
              <Link href="/admin/attendance" className="text-sm text-primary hover:underline">
                {t('shiftLibraryLink')}
              </Link>
            </div>
          </Card>

          <CompanyPolicyCard companies={visible} policies={policies} lastUpdated={lastUpdated} />
          <WorkScheduleOvertimeCard s={s} companies={visible} />

          {/* ── The four gaps, named ───────────────────────────────────────────────────────────────────
              THIS CARD IS A DELIVERABLE, not an apology. The approved plan promises: "where a setting
              genuinely does not exist yet we will say so rather than draw a box that does nothing". Each
              entry below is one of those, with the reason and — where the thing IS governed, just not from
              here — where it is governed from. Delete an entry only when its storage actually ships. */}
          <Card id="not-configured-here" className="scroll-mt-6">
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
        </div>
        {panelNode && (
          <section
            id={SCHEDULE_PANEL_ANCHOR}
            className="order-first min-w-0 scroll-mt-6 space-y-6 min-[1900px]:order-none"
          >
            {panelNode}
          </section>
        )}
      </div>
    </div>
  );
}
