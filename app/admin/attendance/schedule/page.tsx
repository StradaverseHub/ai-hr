import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { listAttendanceRules, type AttendanceRuleView } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import { ClientTabs } from '@/components/personnel-tabs';
import {
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  SectionHeader,
  btnPrimary,
  inputCls,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { WorkScheduleForm } from '../../attendance-policy/schedule/work-schedule-form';
import { SCHEDULE_TAB_KEYS, type ScheduleTabKey } from './tabs';
import { saveScheduleGroupAttendanceAction, saveScheduleGroupOvertimeAction } from './actions';

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
 * ⚠️ IT WAS READ-ONLY UNTIL e4471e3c (r287), AND THE REVERSAL IS THE REPORTER'S, NOT A DRIFT.
 *
 * r263 and r277 built these tabs as read-only mirrors, each section ending in a link to the editor that
 * owns the value, and said why in writing: a second form over one table is two write paths, and those
 * editors carry validation (disjoint Full/Half/Rest, coherent start/end, the continuous-ladder check on
 * the overtime bands) a copy would have to re-implement and would eventually re-implement differently.
 * The reporter approved that. They have since asked for the opposite — "Schedule Group and Work Schedule
 * shall be consolidated into the existing Schedule sub-menu ... to provide a single centralised Schedule
 * configuration area" — and that is a fair change of mind, so r287 makes these tabs edit.
 *
 * THE ORIGINAL REASONING IS NOT DISCARDED; IT IS SATISFIED A DIFFERENT WAY. Nothing here is a second
 * form over a table:
 *
 *   · THE GENERAL TAB renders app/admin/attendance-policy/schedule/work-schedule-form.tsx, which IS the Work Schedule page's
 *     editor — the same component, the same field names, the same `setAttendancePolicyAction`. One
 *     writer, two mounts, so the two screens cannot store different rows and cannot drift.
 *   · THE ATTENDANCE AND OVERTIME TABS post to ./actions.ts, which re-reads the stored Schedule Group,
 *     carries every column forward verbatim and overlays ONLY the fields the tab renders, then writes
 *     through the SAME `updateAttendanceRule` the rule editor calls. Posting to it cannot change a
 *     setting the tab does not show. Read that file before touching either action: posting a partial
 *     form to `updateAttendanceRuleAction` instead would have turned the deduction switch OFF and
 *     DELETED every overtime band, silently.
 *
 * ⚠️ THE ONE SETTING THAT DID NOT MOVE. `apply_deductions` + `deductions_effective_from` stay on the
 * Schedule Group editor. The effective-from date is STAMPED BY THE SERVICE when the switch flips and can
 * never be typed, and a DB CHECK (migration 0394) makes "deductions on with no start date"
 * unrepresentable — that is what stops a deduction reaching a closed payroll period. A second form over
 * that switch is a second way to get the date wrong. The Attendance tab shows it read-only and says
 * where it is edited. The reporter was told this in the plan they approved. Do not add a checkbox.
 *
 * Also NOT editable here, for the same "the editor owns rules a copy would re-implement" reason: the
 * shift library (its own screen), and the overtime BAND boundaries and RATES, which are the ladder the
 * continuous-ladder validation guards, and are money.
 *
 * THE CUTOVER HAPPENED (the a6fe37fc playbook, completed). r263 built alongside; the "Schedule Group" and
 * "Work Schedule" nav rows are gone as of this round. Both ROUTES survive as the owning editors for what
 * did not move, they keep their lib/permissions.ts registration under the `attendancePolicyConfig`
 * screenKey (a permission identity — renaming or removing it would silently revoke grants), and this
 * screen links to both. Those links are the only way in now, so they are pinned by
 * test/schedule-config-screen.test.ts.
 *
 * ⚠️ r277 (e5ff7189 / d91aee93 stage 1) — ATTENDANCE AND OVERTIME ARE NO LONGER EMPTY, AND THE REASON IS
 * THE OPPOSITE OF "we filled a tab in". Both tabs now render settings that ALREADY EXIST and have existed
 * since 88e94371: the grace periods, the late-in / early-out interval-and-minutes rules and the recording
 * switch, and the before-shift overtime switch with the per-band rounding table. Every one of them is
 * stored on `attendance_rule` — the object the rail now calls the SCHEDULE GROUP (870b79e2) — and every
 * one of them was already configured on both production rule sets. AGENTS 28 is satisfied because nothing
 * here is drawn at a value nothing stores; what changed is that the values are now visible where the
 * reporter looks for them.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, because the approved plans put it in a later stage and say so in
 * writing: pairing method, minimum interval between clockings, skip-lateness-on-incomplete-clocking,
 * deduct-break-from-the-calculation, the clocking-method switches, Enable Overtime (shift.ot_rule),
 * after-shift overtime, backdated overtime without clocking, overtime approval method, Intersect, and —
 * alone and last, because it is the only one that moves money — offset overtime by lateness. Do not
 * "finish" these tabs with any of them; each ships as its own stage with its own before and after.
 *
 * HOLIDAY / REQUEST / NOTIFICATION ARE STILL NAMED AND EMPTY, ON PURPOSE. They render the shell's
 * `emptyLabel` and nothing else, so the shape the reporter asked for is visible and nobody wonders
 * whether a tab was forgotten. They are not placeholders for settings that exist; each will be defined
 * and built as its own piece of work.
 *
 * requireAdmin(), like every other row of the Attendance settings menu it hangs under. The menu is not
 * what protects it.
 */
export default async function ScheduleConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; group?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleConfig');
  const tp = await getTranslations('admin.attendancePolicy');
  // r277 — the rounding-mode words come from the namespace that OWNS them (the rule editor's own
  // None / Down / Up), not from a second copy under this screen's namespace. Two spellings of one
  // setting is how two screens start describing the same stored value differently.
  const tr = await getTranslations('admin.attendanceRule');
  const sp = await searchParams;

  // Deep-link / reload survival: the shell reflects its tab into `?tab=`, so honour it on the way back in.
  // Read by VALUE against the closed key list — an unknown value falls back to General rather than
  // rendering a tab that does not exist.
  const defaultTab: ScheduleTabKey = (SCHEDULE_TAB_KEYS as readonly string[]).includes(sp.tab ?? '')
    ? (sp.tab as ScheduleTabKey)
    : 'general';

  // ⚠️ WHAT `visible` ACTUALLY MEANS HERE, because it is easy to read it as the opposite. `listCompanies`
  // is scoped to the TENANT, not to the viewer (lib/scope.ts:24-28, feedback ab77dc1f), and `getScopeIds`
  // returns its argument UNCHANGED when no `company_scope` cookie is set (lib/scope.ts:11-18). So this
  // narrows by the multi-company SWITCHER only: a company-scoped hr_admin with no switcher selection sees
  // EVERY company's working week on this card, not just the ones their grant reaches. The r263 risk note
  // originally claimed the reverse ("a narrow scope sees only their companies"); it was wrong.
  //
  // Deliberately left as-is for this round rather than quietly tightened: /admin/attendance-policy/schedule
  // — the screen this card reads from and links to — uses the byte-identical requireAdmin() → listCompanies
  // → getScopeIds pattern over the SAME attendance_policy rows (its :46-52), so the same admin already sees
  // the same list there. Read-only, no writes, RLS unchanged. Narrowing one screen and not the other would
  // make two views of one table disagree; when this is tightened, tighten BOTH to `allowedCompanies`
  // (lib/scope.ts scopedSession returns it alongside `allowedCount` for exactly this).
  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const [policies, shifts, rules] = await Promise.all([
    listAttendancePolicies(s, visible.map((c) => c.id)),
    listShiftsForTenant(s),
    // r277 — the Schedule Groups. TENANT-WIDE, not company-scoped (6da67ab7 / migration 0319 removed that
    // axis), so unlike the working-week card above this list is not narrowed by the company switcher and
    // must not be: a shift is tenant-wide and binds its group, so there is no company to narrow by.
    // Ordered Standard-first then by name by listAttendanceRules itself — one ordering shared with the
    // group screen, so the two cannot disagree about which group is "first".
    listAttendanceRules(s),
  ]);
  const companyName = new Map(visible.map((c) => [c.id, c.name]));

  /**
   * r277 — WHICH GROUP THE ATTENDANCE AND OVERTIME TABS ARE SHOWING.
   *
   * Read by VALUE against the groups that exist, exactly as `?tab=` is read against the closed key list:
   * an unknown or stale id falls back to the first group (Standard) rather than rendering a blank screen
   * or, worse, a screen whose header names a group whose settings are not the ones below it.
   */
  const selectedGroup: AttendanceRuleView | null = rules.find((r) => r.id === sp.group) ?? rules[0] ?? null;

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
        {/* 870b79e2 — TWO links, because this table has two owners. Each shift's hours and pattern are
            edited in the shift library; the lateness / early-out / overtime rules every one of these
            shifts follows live on its SCHEDULE GROUP, which is the screen the reporter could not find
            while the rail called it "Overtime Pattern". The General tab is where they arrive, so the
            pointer belongs here as well as on the two tabs that render the group's settings. */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border px-4 py-3">
          <Link href="/admin/attendance" className="text-sm text-primary hover:underline">
            {t('shiftLibraryLink')}
          </Link>
          <Link href="/admin/attendance-policy" className="text-sm text-primary hover:underline">
            {t('groupLibraryLink')}
          </Link>
        </div>
      </Card>

      {/* ── Rest days, off days and working-hour limits, per company ───────────────────────────────
          e4471e3c (r287) — EDITABLE HERE NOW, and it is the same editor, not a copy of it.

          attendance_policy is the schedule for a day with NO shift assigned (core/attendance.ts
          scheduleFor's last fallback), and its working-days list is ALSO read for every employee by
          absence derivation and by roster generation — so it governs the working pattern even where a
          shift exists. `isDefault` marks a company with no row of its own: those figures are the code
          defaults, not something anybody chose, and the card says so.

          Until this round the tab showed these values and pointed at "Work Schedule" to change them. The
          reporter asked for that sub-menu to be consolidated into this screen, so the editor MOVED into
          app/admin/attendance-policy/schedule/work-schedule-form.tsx and is rendered here and on its own page, posting the same
          field names to the same server action. One writer, two mounts — see that file for why a
          hand-drawn form over the fields this tab happened to display would have wiped four settings it
          does not show. */}
      <Card>
        <SectionHeader title={t('weekTitle')} count={visible.length} subtitle={t('weekHint')} />
        {visible.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('weekEmpty')}</p>}
      </Card>
      {visible.map((c) => {
        const p = policies.find((x) => x.companyId === c.id);
        return p ? (
          <WorkScheduleForm key={c.id} company={{ id: c.id, name: companyName.get(c.id) ?? c.id }} policy={p} returnTo="schedule-tab" />
        ) : null;
      })}
      <Card>
        {/* What is LEFT on the Work Schedule page, which survives as the owning editor for it: the tenant
            overtime RATES (a statutory ruleset, not attendance_policy), the registered clocking devices
            and the backup-shift coverage card. None of those is a schedule setting, so none of them moved
            — and with the menu row gone this link is how an administrator reaches them. */}
        <div className="px-4 py-3">
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

  /**
   * r277 — THE GROUP SELECTOR, rendered at the top of both new tabs.
   *
   * A row of plain GET links, not a <select>. Three reasons, in order of weight: a native select that
   * navigates needs a client island and this page has none (the screen is a Server Component and the
   * closest thing to a boundary bug it could ship is one it does not have); a link is deep-linkable and
   * shareable, which is how an administrator sends a colleague "look at THIS group"; and the tab key
   * travels in the href, so picking a group does not bounce the reader back to General.
   *
   * ClientTabs reflects the active tab into `?tab=` with replaceState and touches no other parameter, so
   * `?group=` survives a tab switch in the other direction too.
   */
  const groupPicker = (tab: ScheduleTabKey) => (
    <Card>
      <SectionHeader title={t('groupTitle')} count={rules.length} subtitle={t('groupHint')} />
      {rules.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t('groupEmpty')}</p>
      ) : (
        <div className="flex flex-wrap gap-2 p-4">
          {rules.map((r) => {
            const on = r.id === selectedGroup?.id;
            return (
              <Link
                key={r.id}
                href={`/admin/attendance/schedule?tab=${tab}&group=${r.id}`}
                aria-current={on ? 'true' : undefined}
                className={
                  on
                    ? 'rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground'
                    : 'rounded-xl border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground'
                }
              >
                {r.name}
                {r.isDefault && <span className="ml-2 text-[11px] opacity-80">{t('groupDefault')}</span>}
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );

  /** "Edit this Schedule Group" — the link every card on this screen ends in, pointing at the ONE editor
   *  that owns these values. Same shape as the General tab's three cards. */
  const groupEditLink = selectedGroup && (
    <div className="border-t border-border px-4 py-3">
      <Link href={`/admin/attendance-policy/rules/${selectedGroup.id}`} className="text-sm text-primary hover:underline">
        {t('groupLink')}
      </Link>
    </div>
  );

  /**
   * e5ff7189 stage 1 — THE ATTENDANCE TAB: the four settings the reporter asked for, which already exist.
   *
   * ⚠️ THE WORDING OF THE DEDUCTION CARD IS LOAD-BEARING AND IS NOT A STYLE CHOICE. `late_deduct_minutes`
   * and `early_out_deduct_minutes` are derived in core/attendance.ts and STORED on the attendance row, and
   * nothing in core/payroll.ts or core/pay-components.ts reads either of them — grepped, not assumed. So
   * this screen must never call them a deduction FROM PAY: it says the minutes are RECORDED, and the note
   * at the foot of the card says in plain words that no payslip is reduced by them. Describing them as
   * money would be the screen asserting a behaviour the system deliberately has not built.
   */
  const attendance = (
    <>
      {groupPicker('attendance')}
      {selectedGroup == null ? null : (
        <>
          {/* ── EDITABLE, as of e4471e3c (r287) ──────────────────────────────────────────────────────
              One form over both cards, so the six figures that describe "when does a clocking count as
              late or early, and how many minutes are recorded" are saved together. It posts to this
              screen's OWN narrow action, NOT to updateAttendanceRuleAction — that one builds a complete
              rule out of the submission and would have turned the deduction switch off and deleted every
              overtime band. See app/admin/attendance/schedule/actions.ts. */}
          <form action={saveScheduleGroupAttendanceAction} className="space-y-6">
            <input type="hidden" name="ruleId" value={selectedGroup.id} />

            <Card>
              <SectionHeader title={t('graceTitle')} subtitle={t('graceHint', { group: selectedGroup.name })} />
              <div className="grid gap-3 p-4 sm:grid-cols-2">
                <Field label={t('graceLate')}>
                  <input
                    type="number"
                    min={0}
                    name="lateGracePeriodMinutes"
                    defaultValue={selectedGroup.lateGracePeriodMinutes}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('graceEarly')}>
                  <input
                    type="number"
                    min={0}
                    name="earlyGracePeriodMinutes"
                    defaultValue={selectedGroup.earlyGracePeriodMinutes}
                    className={inputCls}
                  />
                </Field>
              </div>
            </Card>

            <Card>
              <SectionHeader title={t('recordRulesTitle')} subtitle={t('recordRulesHint')} />
              <div className={tableWrapCls}>
                <table className="w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>{t('colRule')}</th>
                      <th className={thCls}>{t('colAfter')}</th>
                      <th className={thCls}>{t('colRecorded')}</th>
                    </tr>
                  </thead>
                  <tbody className={tbodyCls}>
                    <tr>
                      <td className="px-3 py-2">{t('ruleLate')}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          name="lateAfterMinutes"
                          defaultValue={selectedGroup.lateAfterMinutes}
                          aria-label={`${t('ruleLate')} — ${t('colAfter')}`}
                          className={inputCls}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          name="lateDeductMinutes"
                          defaultValue={selectedGroup.lateDeductMinutes}
                          aria-label={`${t('ruleLate')} — ${t('colRecorded')}`}
                          className={inputCls}
                        />
                      </td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2">{t('ruleEarly')}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          name="earlyAfterMinutes"
                          defaultValue={selectedGroup.earlyAfterMinutes}
                          aria-label={`${t('ruleEarly')} — ${t('colAfter')}`}
                          className={inputCls}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          name="earlyDeductMinutes"
                          defaultValue={selectedGroup.earlyDeductMinutes}
                          aria-label={`${t('ruleEarly')} — ${t('colRecorded')}`}
                          className={inputCls}
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('notPayNote')}</p>
              <div className="flex items-center gap-3 border-t border-border px-4 py-3">
                <button className={btnPrimary}>{tr('save')}</button>
              </div>
            </Card>
          </form>

          {/* ⚠️ THE ONE SETTING THAT DID NOT MOVE, AND IT IS READ-ONLY HERE ON PURPOSE.
              `apply_deductions` + `deductions_effective_from` (7c834696 stage 1, migration 0394): the
              effective-from date is STAMPED BY THE SERVICE the moment the switch flips and can never be
              typed, and a DB CHECK makes "deductions on with no start date" unrepresentable. Together that
              is what stops a deduction reaching a payroll month that is already closed. A second form over
              this switch would be a second way to get that date wrong, so it stays on the Schedule Group
              editor and this card shows it and says where it is edited. The reporter was told this in the
              plan they approved. DO NOT "finish" this tab by adding a checkbox here. */}
          <Card>
            <SectionHeader title={tr('deductionsSectionTitle')} />
            <dl className="divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="text-sm font-medium">{t('recordSwitchLabel')}</dt>
                <dd className="text-sm text-foreground">
                  {selectedGroup.applyDeductions ? t('settingOn') : t('settingOff')}
                  {selectedGroup.applyDeductions && selectedGroup.deductionsEffectiveFrom && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('recordSwitchFrom', { date: selectedGroup.deductionsEffectiveFrom })}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
              {t('deductionsElsewhere')}
            </p>
            {groupEditLink}
          </Card>
        </>
      )}
    </>
  );

  /**
   * d91aee93 stage 1 — THE OVERTIME TAB: the settings the reporter asked for that already exist, and the
   * per-band rounding is FINER than what they asked for, not coarser — they asked for one rounding method
   * and one step for the whole group; each band has carried its own since migration 0439.
   *
   * The Overtime Pattern is NOT a field on this tab, and that is the 870b79e2 answer restated: the
   * Overtime Pattern IS the Schedule Group. It is the thing these settings belong to, so it is the
   * selector at the top, not a dropdown inside.
   *
   * e4471e3c (r287) — EDITABLE NOW, but only the two things this tab has always shown: the before-shift
   * switch and each band's rounding. The band BOUNDARIES and the RATES stay on the Schedule Group editor
   * with the deduction switch — they are the overtime ladder, they carry a continuous-ladder validation,
   * and the rate is money. The action rebuilds the band table from the STORED rows and overlays rounding
   * matched BY ROW ID, so nothing here can move a boundary or a rate.
   */
  const overtime = (
    <>
      {groupPicker('overtime')}
      {selectedGroup == null ? null : (
        <form action={saveScheduleGroupOvertimeAction} className="space-y-6">
          <input type="hidden" name="ruleId" value={selectedGroup.id} />
          {/* ⚠️ THE MARKER, read as a VALUE by the action and never by presence. A browser omits an
              unchecked checkbox, so without this "turned off" and "this form did not carry the control"
              are the same bytes — the trap 7c834696 hit on this exact setting. */}
          <input type="hidden" name="earlyOtEditor" value="1" />

          <Card>
            <SectionHeader title={t('otEarlyTitle')} subtitle={t('otEarlyHint')} />
            <div className="px-4 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm has-[:checked]:text-primary">
                <input
                  type="checkbox"
                  name="applyToEarlyOt"
                  defaultChecked={selectedGroup.applyToEarlyOt}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t('otEarlyLabel')}
              </label>
            </div>
          </Card>

          <Card>
            <SectionHeader
              title={t('otRoundingTitle')}
              count={selectedGroup.otRows.length}
              subtitle={t('otRoundingHint')}
            />
            {selectedGroup.otRows.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t('otRoundingEmpty')}</p>
            ) : (
              <div className={tableWrapCls}>
                <table className="w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>{t('colBand')}</th>
                      <th className={thCls}>{t('colRoundingMode')}</th>
                      <th className={thCls}>{t('colRoundTo')}</th>
                    </tr>
                  </thead>
                  <tbody className={tbodyCls}>
                    {selectedGroup.otRows.map((row) => (
                      <tr key={row.id}>
                        {/* A band whose "To" is at or below its "From" is OPEN-ENDED (db/schema.ts), which
                            is a different sentence from a range and must read as one — "120 minutes and
                            above", never "120–0 minutes". The band itself is NOT editable here. */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          {row.toMinutes <= row.fromMinutes
                            ? t('bandOpenEnded', { from: row.fromMinutes })
                            : t('bandRange', { from: row.fromMinutes, to: row.toMinutes })}
                        </td>
                        <td className="px-3 py-2">
                          {/* ⚠️ KEYED ON THE BAND'S "FROM" BOUNDARY — not on its position, and NOT on
                              `row.id`. `updateAttendanceRule` replaces the band table wholesale, so every
                              row id changes on every save of this rule; an id-keyed field silently stops
                              matching after any save made since this page was rendered, and the rounding
                              edit would be discarded without a word. The "From" boundary is unique per
                              rule (the continuous-ladder validation guarantees it) and survives the
                              re-insert. See ./actions.ts. */}
                          <select
                            name={`roundingMode_${row.fromMinutes}`}
                            defaultValue={row.roundingMode}
                            aria-label={t('colRoundingMode')}
                            className={inputCls}
                          >
                            <option value="none">{tr('roundingModeNone')}</option>
                            <option value="down">{tr('roundingModeDown')}</option>
                            <option value="up">{tr('roundingModeUp')}</option>
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            name={`roundToMinutes_${row.fromMinutes}`}
                            defaultValue={row.roundToMinutes ?? ''}
                            aria-label={t('colRoundTo')}
                            className={inputCls}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center gap-3 border-t border-border px-4 py-3">
              <button className={btnPrimary}>{tr('save')}</button>
            </div>
            {groupEditLink}
          </Card>
        </form>
      )}
    </>
  );

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('pageTitle')} description={t('pageSubtitle')} />
      {/* r287 — the tabs WRITE now, so a refusal has to land somewhere the operator can read it. The
          save actions redirect back to the tab they were made on carrying ?error=. */}
      <ErrorBanner message={sp.error} />
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
        /* r277 — THREE panels now. Holiday / Request / Notification are still deliberately absent, so the
           shell renders `notBuiltYet` for them; see the audit at the top of this file for the list of
           settings that belong to LATER stages of e5ff7189 and d91aee93 and must not be added here.
           test/schedule-config-screen.test.ts holds this exact set. */
        panels={{ general, attendance, overtime }}
      />
    </div>
  );
}
