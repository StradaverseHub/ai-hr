/**
 * Schedule configuration screen (feedback 1c5602cc, r263) — the promises this round made in writing.
 *
 * The screen itself is read-only, so there is no calculation to pin. What CAN silently break — and what
 * every one of these assertions is aimed at — are the four promises the approved plan made to the
 * reporter, each of which a later round could undo without any other test noticing:
 *
 *   1. ALONGSIDE, NOT INSTEAD. The a6fe37fc playbook's whole rule is that the old screen keeps working
 *      until a round is explicitly the cutover. Nothing else pins that the "Work Schedule" row and its
 *      route survived THIS round: delete either and every other guard stays green.
 *   2. REGISTERED IN THE SAME COMMIT. test/function-access.test.ts fails in both directions, so it
 *      already catches a page shipped without a column — but it does so generically. This says which
 *      route, so the failure names the screen instead of a diff of a route set.
 *   3. THE REPORTER'S SECTIONS, IN THE REPORTER'S ORDER. The order is the reporter's own list and is the
 *      thing that makes the shape recognisable to them.
 *   4. ⚠️ ONLY THE SECTIONS WITH STORAGE BEHIND THEM ARE BUILT. This is the scope fence and the
 *      assertion most worth having. The remaining ones ship NAMED AND EMPTY on purpose (a control drawn
 *      at a value nothing stores is worse than an absent one), and the tempting "improvement" for a
 *      later round is to fill one in with a plausible-looking box. Adding a key to the built set fails,
 *      loudly, with the reason.
 *
 * ══ 665de026 (r331) — THE SCREEN IS LIST + DETAIL NOW, AND THIS FILE MOVED WITH IT ════════════════════
 * The reporter contested r301's shape: one page carried every Schedule Group's settings at once and Add /
 * Edit opened over the top of them. Attendance › Schedule is the LIST; each group has its own View
 * Schedule and Edit Schedule page; Add New Schedule has its own Add Schedule page. Every assertion below
 * that named a TAB has been repointed at the SECTION that replaced it — none was deleted and none was
 * loosened, and two got STRICTER because the thing they were guarding grew:
 *
 *   · the tab-key list became the section-key list and gained a SEVENTH entry, `workingDay`, which
 *     07ebd04d (migration 0483) made buildable and this round built. The built-set assertion therefore
 *     asserts FOUR, not three, and it now reads the declared `SCHEDULE_BUILT_SECTIONS` rather than a
 *     regex over `panels={{ … }}` — the page has no tab shell to regex any more.
 *   · "exactly one control over the deduction switch exists" now has TWO mounts of rules/rule-form.tsx
 *     to allow (Add Schedule and the Edit Schedule sections), so it names both instead of one. The
 *     invariant it protects — ONE file draws that control — is unchanged and still asserted.
 *
 *   5. THE "Not configured here" CARD STAYS TRUE. Its four entries each assert an ABSENCE, and an
 *      absence expires silently. The last describe block ties each entry to the absence it claims (r263
 *      verify: the page's "delete an entry when its storage ships" comment was a request, not a guard).
 *
 * Static-over-source for the page, the house idiom for a guarded route (test/attendance-menu-
 * relocation.test.ts says why: requireAdmin() resolves a real session the harness cannot mint). No DB.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { attendancePack } from '../packs/attendance';
import { SCHEDULE_BUILT_SECTIONS, SCHEDULE_SECTION_KEYS } from '../app/admin/attendance/schedule/sections';
import { DAY_TYPE_INCLUSION_KEYS } from '../core/leave';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const NEW_ROUTE = '/admin/attendance/schedule';
/** The screen 1c5602cc deliberately did NOT touch, and e4471e3c (r287) consolidated INTO the one above. */
const OLD_WORK_SCHEDULE_ROUTE = '/admin/attendance-policy/schedule';
/** e4471e3c — the Schedule Group library, consolidated in the same round. */
const OLD_SCHEDULE_GROUP_ROUTE = '/admin/attendance-policy';
/** Both rows the reporter asked to be folded into Schedule. Their ROUTES survive; their rows do not. */
const CONSOLIDATED = [OLD_SCHEDULE_GROUP_ROUTE, OLD_WORK_SCHEDULE_ROUTE] as const;
const PAGE_REL = 'app/admin/attendance/schedule/page.tsx';

const navHrefs = (attendancePack.navNodes ?? []).flatMap((n) => (n.children ?? []).map((c) => c.href));

describe('e4471e3c (r287) — the Schedule screen ABSORBED Schedule Group and Work Schedule', () => {
  it('the Schedule screen is reached from the Attendance menu — as a card behind the Settings row, no longer a row', () => {
    // r431 (bdfe4968) — Schedule is one of the five setup screens that became cards on the Attendance
    // Settings page. Both halves are asserted: the row is gone, AND the Settings row (which owns the
    // address for highlighting) and the card (which is the only way in) are there.
    expect(navHrefs, `${NEW_ROUTE} must not be a nav row any more — it is a Settings card.`).not.toContain(NEW_ROUTE);
    expect(navHrefs, 'the Settings row is the way into it').toContain('/admin/attendance/settings');
    const settings = (attendancePack.navNodes ?? []).flatMap((n) => n.children ?? []).find((c) => c.href === '/admin/attendance/settings');
    expect(settings?.ownedSubpaths, 'and it stays lit on the Schedule screen').toContain(NEW_ROUTE);
    expect(read('app/admin/attendance/settings/cards.ts'), 'the Settings page links to Schedule').toContain(`href: '${NEW_ROUTE}'`);
  });

  /**
   * ⚠️ THIS CASE WAS THE EXACT OPPOSITE ONE ROUND AGO, AND THAT WAS DELIBERATE IN BOTH DIRECTIONS.
   *
   * 1c5602cc adopted the a6fe37fc playbook in writing — build alongside, prove the old behaviour
   * unchanged, and retire the old row only in a round that is EXPLICITLY the cutover — so this file
   * asserted that the "Work Schedule" row was still there, and its own failure message named the
   * condition for flipping it: "If this is that round, retire the row and this assertion together,
   * deliberately." The reporter answered the open question by raising e4471e3c, which asks for Schedule
   * Group AND Work Schedule to be consolidated into this sub-menu. So this IS that round, and the
   * assertion is flipped rather than deleted — the guard's job did not change, only which way it points.
   *
   * It is also STRICTER than the assertion it replaces. Retiring a row is only safe if the screen behind
   * it survives, stays registered, and stays reachable, so all four are asserted together: no row, page
   * on disk, route registered (a screenKey is a permission identity — dropping it revokes grants), and a
   * link from THIS screen, which is now the only way in.
   */
  it('the two consolidated rows are GONE from the menu — and their screens are not', () => {
    for (const route of CONSOLIDATED) {
      expect(
        navHrefs,
        `${route} still has a nav row. e4471e3c asked for Schedule Group and Work Schedule to be ` +
          `consolidated into ${NEW_ROUTE}; if that is being reversed, reverse this case with it.`,
      ).not.toContain(route);
      expect(
        existsSync(path.join(root, `app${route}/page.tsx`)),
        `${route} lost its page. The ROUTES survive — as the owning editors in r287, and since r301 ` +
          `(6d091cc0) as requireAdmin() redirects to the General-tab card that holds their content — so ` +
          `retiring the row must never delete the page: bookmarks, the module gate and the screenKey ride it.`,
      ).toBe(true);
      expect(
        REGISTERED_ROUTES.has(route),
        `${route} is no longer registered in lib/permissions.ts. screenKey 'attendancePolicyConfig' is a ` +
          `PERMISSION IDENTITY: removing or renaming it silently revokes whatever stored role ` +
          `configuration references it.`,
      ).toBe(true);
    }
  });

  /**
   * ⚠️ 6d091cc0 (r301) — THIS CASE USED TO PIN TWO LINKS AWAY, AND THE REPORTER ASKED FOR THEM TO GO.
   *
   * It asserted `href="/admin/attendance-policy/schedule"` on the General tab and a link to
   * `/admin/attendance-policy/rules/` on the group tabs, because those links were "the only way in" to the
   * screens that still owned the moved settings. The reporter then asked for Schedule Group and Work Schedule &
   * Overtime Configuration to be managed ON the General tab with no links away, and approved that plan. So the
   * guard's job — "the settings the menu no longer lists are still reachable" — is kept, and asserted MORE
   * strictly than before: the content is rendered here (not merely linked), both old addresses are guarded
   * redirects that land on the matching card, and the group tabs open the editor on this page.
   */
  it('…and this screen RENDERS what both held; their old addresses are guarded redirects to the matching card', () => {
    const src = read(PAGE_REL);
    // The three consolidated cards are mounted by this page, in the approved order.
    const order = ['<ScheduleGroupCard', "t('shiftsTitle')", '<CompanyPolicyCard', '<WorkScheduleOvertimeCard', "t('gapsTitle')"].map((m) =>
      src.indexOf(m),
    );
    expect(order.every((i) => i > -1), 'all three cards and the gaps card are rendered on the list page').toBe(true);
    // 665de026 — THE ORDER FLIPPED AT THE TOP, DELIBERATELY. "Shifts available" led the General tab in
    // r301 because the tab was a reference screen. The reporter asked for this page to BE the list of
    // Schedule Groups, so the Schedule Group card leads it and the tenant- and company-wide cards follow;
    // a list whose first card is something other than the thing being listed is the crowding complaint in
    // a different costume. The other four keep their approved relative order.
    expect([...order].sort((a, b) => a - b), 'in the approved order, Schedule Groups first').toEqual(order);
    // The two links away are GONE — an href to either old page would be a way off the one setup screen.
    expect(src, 'the General tab no longer links to the Work Schedule page').not.toContain(`href="${OLD_WORK_SCHEDULE_ROUTE}"`);
    expect(src, 'nor to the Schedule Group list').not.toContain(`href="${OLD_SCHEDULE_GROUP_ROUTE}"`);
    expect(src, 'nor to the retired editor routes').not.toContain('/admin/attendance-policy/rules/');
    // 665de026 — the row actions open the group's own PAGES, and the panel that used to open over this
    // list is gone with the `?editGroup=` parameter that addressed it. The card is the file that links.
    const card = read('app/admin/attendance-policy/schedule-group-card.tsx');
    for (const helper of ['scheduleGroupNewPath()', 'scheduleGroupViewPath(r.id)', 'scheduleGroupEditPath(r.id)']) {
      expect(card, `the Schedule Group list links to ${helper}`).toContain(helper);
    }
    expect(src, 'and no Schedule Group editor panel opens over the list any more').not.toContain('ScheduleGroupEditorPanel');
    // Both old addresses: guard first, then a redirect to the card that now holds their content.
    const stubs: [string, string][] = [
      [OLD_SCHEDULE_GROUP_ROUTE, 'SCHEDULE_GROUPS_ANCHOR'],
      [OLD_WORK_SCHEDULE_ROUTE, 'WORK_SCHEDULE_OVERTIME_ANCHOR'],
    ];
    for (const [route, anchor] of stubs) {
      const stub = read(`app${route}/page.tsx`);
      expect(stub, `${route} still refuses a non-administrator itself`).toMatch(/await requireAdmin\(\);\s*redirect\(/);
      expect(stub, `${route} redirects to its card on the General tab`).toContain(`redirect(\`\${SCHEDULE}#\${${anchor}}\`)`);
    }
    const panel = read('app/admin/attendance-policy/schedule-panel.ts');
    expect(panel).toContain(`export const SCHEDULE = '${NEW_ROUTE}';`);
    // 665de026 — the three per-group addresses are built in ONE place, from SCHEDULE, so a link and a
    // redirect can never disagree about where a Schedule Group lives.
    expect(panel).toContain('export const scheduleGroupNewPath = () => `${SCHEDULE}/new`;');
    expect(panel).toContain('export const scheduleGroupEditPath = (ruleId: string) => `${scheduleGroupViewPath(ruleId)}/edit`;');
    expect(panel).toContain("export const SCHEDULE_GROUPS_ANCHOR = 'schedule-groups';");
    expect(panel).toContain("export const WORK_SCHEDULE_OVERTIME_ANCHOR = 'work-schedule-overtime';");
  });

  it('both routes are registered in the function-access matrix', () => {
    expect(
      REGISTERED_ROUTES.has(NEW_ROUTE),
      `${NEW_ROUTE} is not registered in lib/permissions.ts. The guarded page and its registry entry must ` +
        `land in the SAME commit — test/function-access.test.ts fails in both directions.`,
    ).toBe(true);
    expect(REGISTERED_ROUTES.has(OLD_WORK_SCHEDULE_ROUTE)).toBe(true);
  });

  it('the page guards itself, and does not rely on the menu to hide it', () => {
    expect(read('app/admin/attendance/schedule/page.tsx')).toMatch(/requireAdmin\(\)/);
  });
});

describe('1c5602cc — the reporter\'s named sections; r277 built two, 665de026 built the seventh', () => {
  it('the sections are the reporter\'s, reordered once more for r429', () => {
    // 665de026 — SEVEN, not six. The reporter's original list had six; they listed "Working Day /
    // Schedule Pattern" SEVENTH, and 07ebd04d (r331, migration 0483) gave it storage on attendance_rule,
    // so that round built it, appended rather than inserted.
    //
    // r429 (f6819e19) · D7 — MOVED TO SECOND. The Shift page's own week row is retired (D1): this section
    // is now the ONLY place a working week is set at all, and it is this round's main screen. The other
    // five keep their relative order.
    expect([...SCHEDULE_SECTION_KEYS]).toEqual([
      'general',
      'workingDay',
      'holiday',
      'overtime',
      'attendance',
      'request',
      'notification',
    ]);
  });

  /**
   * ⚠️ THE SCOPE FENCE, AND IT HAS MOVED ONCE — DELIBERATELY, WITH A REASON WRITTEN DOWN.
   *
   * 1c5602cc built General and left five tabs NAMED AND EMPTY, and this assertion said `['general']`. Its
   * own message named the condition under which it should change: "Do not fill one in with a control
   * unless the storage behind it actually ships; when it does, raise that tab as its own item and change
   * this assertion with it." That is exactly what happened.
   *
   * r277 (e5ff7189 + d91aee93, each raised and approved as its own item) filled in Attendance and
   * Overtime, and NOTHING on either tab is a control drawn at a value nothing stores. Every figure they
   * render is a column that has existed on `attendance_rule` since 88e94371 and is already configured on
   * both production rule sets: the two grace periods, the late-in / early-out interval-and-minutes pairs
   * and the recording switch, the before-shift overtime switch, and the per-band rounding mode and step
   * from `attendance_rule_ot_row`. AGENTS 28 is not weakened here; it is satisfied.
   *
   * THE FENCE IS STILL A FENCE. Holiday, Request and Notification remain named and empty, and the settings
   * that belong to LATER stages of the two approved plans must not arrive on Attendance or Overtime
   * either — pairing method, minimum interval between clockings, skip-lateness on an incomplete clocking,
   * deduct-break, the clocking-method switches, Enable Overtime, the after-shift switch, backdated
   * overtime without clocking, approval method, Intersect, and offset-overtime-by-lateness (which is the
   * only one of them that moves money and ships alone). Adding a panel key here still fails, loudly.
   */
  it('exactly four sections are built — Holiday / Request / Notification still render EMPTY', () => {
    // 665de026 — READ FROM THE DECLARED SET, NOT FROM A REGEX OVER THE PAGE. Until this round the page
    // handed `panels={{ … }}` to a tab shell and this case matched that object; the screen has no tab
    // shell now, so the declaration moved into ./sections.ts where the page and this guard read the same
    // list. That is stricter, not looser: a section added to the built set but never rendered fails the
    // non-vacuity case below, and one rendered without being declared fails here.
    const supplied = [...SCHEDULE_BUILT_SECTIONS].sort();
    expect(
      supplied,
      `The built sections are General (1c5602cc), Attendance (e5ff7189 stage 1), Overtime ` +
        `(d91aee93 stage 1) and Working Day / Schedule Pattern (665de026, on the storage 07ebd04d shipped ` +
        `in migration 0483) — no more and no fewer. Holiday / Request / Notification ship NAMED AND EMPTY ` +
        `so the shape is visible and nobody wonders whether they were forgotten. Do not fill one in with a ` +
        `control unless the storage behind it actually ships; when it does, raise that section as its own ` +
        `item and change this assertion with it, as r277 and 665de026 both did.`,
    ).toEqual(['attendance', 'general', 'overtime', 'workingDay']);
    /**
     * Non-vacuity, and it is asserted over the WIRING rather than over the declarations.
     *
     * A first pass of this case checked that `const <key> = ` existed for each built section. Measured
     * against a real mutation — `workingDay: notBuilt('workingDay')` in the `bodyFor` map, with the
     * `const workingDay` left in place — it PASSED while the section rendered the "not built yet" line.
     * A section is built when the page renders it, not when a variable holding it exists, so the map is
     * what is read.
     */
    const sections = read('app/admin/attendance/schedule/group-sections.tsx');
    const map = /const bodyFor: Record<ScheduleSectionKey, ReactNode> = \{([\s\S]*?)\n  \};/.exec(sections);
    expect(map, 'group-sections.tsx no longer maps every section key to a body').not.toBeNull();
    const wiring = Object.fromEntries(
      map![1]
        .split(',')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [k, v] = line.split(':');
          return [k.trim(), (v ?? k).trim()];
        }),
    );
    expect(Object.keys(wiring).sort(), 'every section key is wired').toEqual([...SCHEDULE_SECTION_KEYS].sort());
    for (const key of SCHEDULE_BUILT_SECTIONS) {
      expect(wiring[key], `the ${key} section is declared built and must not render the "not built" line`).not.toMatch(
        /notBuilt/,
      );
    }
    // …and the ones that are NOT built render the one honest sentence, through the shared helper.
    for (const key of SCHEDULE_SECTION_KEYS.filter((k) => !SCHEDULE_BUILT_SECTIONS.includes(k as never))) {
      expect(wiring[key], `${key} is named and empty`).toBe(`notBuilt('${key}')`);
    }
    expect(sections, 'and "empty" is a sentence, not a blank card').toContain("t('notBuiltYet')");
  });

  /**
   * ⚠️ THE SCOPE FENCE, SECOND HALF — e4471e3c (r287) MADE THESE TABS EDITABLE, SO THE FENCE HAD TO GROW
   * A NEW SIDE.
   *
   * Until this round the fence only had to stop a later-stage setting being DRAWN here, because nothing
   * on the screen could be saved. Now it can: the Attendance and Overtime tabs write. So the list of
   * things that must not appear gains the one setting the approved plan carried forward as its single
   * deliberate exception, and it is the most important entry on the list.
   *
   * `apply_deductions` + `deductions_effective_from` (7c834696 stage 1, migration 0394) stay on the
   * Schedule Group editor. The effective-from date is stamped by the SERVICE when the switch flips and
   * can never be typed, and a DB CHECK makes "deductions on with no start date" unrepresentable —
   * together, that is what stops a deduction reaching a payroll month that is already closed. A second
   * form over that switch is a second way to get that date wrong. The tab SHOWS the switch and says where
   * it is edited; what it must never grow is a control.
   *
   * The action refuses it too — app/admin/attendance/schedule/actions.ts never reads a form field by that
   * name, and test/schedule-tab-writers.test.ts proves that against a real row including for a crafted
   * request body. This case is the other half: the CONTROL must not appear, because a control that saves
   * nothing is its own defect even when the writer is safe.
   */
  it('the deduction switch is NOT editable here — the one setting that deliberately did not move', () => {
    // 665de026 — the Attendance SECTION moved off the list page onto the per-group screen, so the source
    // this case reads moved with it. The invariant is identical and is now asserted over BOTH files:
    // neither the list nor a group's page may grow a second control over the switch.
    const src = read('app/admin/attendance/schedule/group-sections.tsx') + read('app/admin/attendance/schedule/page.tsx');
    expect(
      src,
      'no input, checkbox or select named applyDeductions may exist on this screen. It is edited on the ' +
        'Schedule Group editor and only there; see the note beside the card and ./actions.ts.',
    ).not.toMatch(/name=["'{`]?applyDeductions/);
    expect(
      src,
      'nor may the effective-from date become a field — the service stamps it, it is never typed',
    ).not.toMatch(/name=["'{`]?deductionsEffectiveFrom/);
    // Stated positively, so the guard cannot be satisfied by the screen simply not mentioning the switch:
    // the reporter must still be able to SEE its state and find out where to change it.
    expect(src, 'the switch is still shown').toContain('applyDeductions');
    // 665de026 — `deductionsElsewhere` became `deductionsHere`, and the rename is the point rather than a
    // tidy-up: the editor that owns the switch is no longer a page away, it is the General section at the
    // top of THIS screen, so a sentence saying "edited on the Schedule Group itself" would have sent the
    // reader looking for a screen that no longer exists. The old key was deleted from all six catalogues
    // in the same change.
    expect(src, 'with the sentence explaining where it is edited').toContain("t('deductionsHere')");
    // r301 — the editor that owns it is the SAME editor, rules/rule-form.tsx. So "the switch is not
    // editable here" keeps its meaning — no SECOND control over it — and is asserted as exactly that:
    // rule-form.tsx is the only file under app/ that draws it.
    // 665de026 — it is mounted TWICE now, and both mounts are named below rather than the count being
    // relaxed: Add Schedule (a new group's identity is all that can exist before the row does) and the
    // Edit Schedule sections. A THIRD mount, or a mount from anywhere outside the Schedule screens, still
    // fails here.
    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return walk(rel);
        return /\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const appFiles = walk('app');
    expect(
      appFiles.filter((f) => /name=["'{`]?applyDeductions/.test(read(f))),
      'exactly one control over the deduction switch exists, and it is the Schedule Group editor’s',
    ).toEqual(['app/admin/attendance-policy/rules/rule-form.tsx']);
    // Resolved, not string-matched: any file importing THAT rule-form.tsx, by whatever relative spelling or the
    // @/ alias (app/admin/leave-approval has an unrelated RuleForm of its own). Type-only imports are not mounts.
    const importsRuleForm = (f: string) =>
      [...read(f).matchAll(/import\s+(?!type\b)[^;]*?from '([^']*rule-form)'/g)].some((m) => {
        const spec = m[1];
        const resolved = spec.startsWith('@/') ? spec.slice(2) : path.posix.join(path.posix.dirname(f), spec);
        return resolved === 'app/admin/attendance-policy/rules/rule-form';
      });
    expect(
      appFiles.filter((f) => importsRuleForm(f)).sort(),
      'and that editor is mounted by the Add Schedule page and the Edit Schedule sections, and nothing else',
    ).toEqual(
      ['app/admin/attendance/schedule/group-sections.tsx', 'app/admin/attendance/schedule/new/page.tsx'].sort(),
    );
  });

  it('the built sections show settings that ALREADY EXIST, and read them from the Schedule Group', () => {
    // Non-vacuity for the assertion above: "attendance" and "overtime" could be present as empty
    // fragments and the key-set check would still pass. These are the stored columns the plans promised,
    // named one by one, so a section emptied out in a later round fails here rather than silently.
    const src = read('app/admin/attendance/schedule/group-sections.tsx');
    for (const field of [
      'lateGracePeriodMinutes',
      'earlyGracePeriodMinutes',
      'lateAfterMinutes',
      'lateDeductMinutes',
      'earlyAfterMinutes',
      'earlyDeductMinutes',
      'applyDeductions',
      'applyToEarlyOt',
      'roundingMode',
      'roundToMinutes',
      // 665de026 — the seventh section's three columns (07ebd04d, migration 0483). They are listed HERE,
      // beside the six r277 settings, for the same reason those are: each is a stored column, and a
      // section quietly emptied out in a later round must fail rather than disappear.
      'weeklyPattern',
      'halfPattern',
      'offPattern',
    ]) {
      expect(src, `the built sections render attendance_rule.${field}`).toContain(field);
    }
    // And they render it FOR ONE GROUP — which, since 665de026, is the PAGE rather than a picker on it.
    // That is the item: the reporter asked for one Schedule Group to be one screen.
    expect(src, 'the sections are rendered for a single rule').toMatch(/rule: AttendanceRuleView;/);
    expect(
      read('app/admin/attendance/schedule/page.tsx'),
      'and the groups come from the rule library, tenant-wide',
    ).toMatch(/listAttendanceRules/);
    expect(src, 'there is no group picker on a group\'s own page').not.toMatch(/selectedGroup/);
  });

  /**
   * ⚠️ THE ONE SENTENCE THIS SCREEN MAY NEVER SAY.
   *
   * `late_deduct_minutes` and `early_out_deduct_minutes` are derived and STORED, and nothing in
   * core/payroll.ts or core/pay-components.ts reads either. A screen that calls them a deduction from PAY
   * asserts a behaviour the system deliberately has not built, and the reporter would discover the truth
   * on a payslip that did not move. The wording is the deliverable, so it is pinned.
   */
  it('never describes the late / early minutes as reducing pay', () => {
    const en = JSON.parse(read('messages/en.json')).admin.scheduleConfig;
    const prose = [en.recordRulesTitle, en.recordRulesHint, en.colRecorded, en.recordSwitchLabel, en.notPayNote].join(' ');
    for (const forbidden of [/deduct(s|ed|ion)? from (their |the )?pay/i, /reduce[sd]? (their |the )?(pay|salary|wage)/i, /docked/i]) {
      expect(prose, `the Attendance tab must not claim these minutes change pay (${forbidden})`).not.toMatch(forbidden);
    }
    // Stated positively, so the guard cannot be satisfied by saying nothing at all.
    expect(en.notPayNote, 'the tab says plainly that no payslip is reduced').toMatch(/no payslip is reduced/i);
    // …and the claim stays true only while payroll really does not read the figure.
    for (const f of ['core/payroll.ts', 'core/pay-components.ts']) {
      const src = read(f);
      expect(src, `${f} must not read lateDeductMinutes`).not.toMatch(/lateDeductMinutes|late_deduct_minutes/);
      expect(src, `${f} must not read earlyOutDeductMinutes`).not.toMatch(/earlyOutDeductMinutes|early_out_deduct_minutes/);
    }
  });
});

describe('1c5602cc — every string on the screen exists in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  // The page resolves these through two namespaces; the i18n coverage guard sees the static t('…')
  // calls, but not that BOTH namespaces are present in every locale for this screen specifically.
  // 665de026 — the screen is FOUR files now (the list, the three per-group pages) plus the shared
  // sections module, so the sweep reads all of them rather than only the page that used to hold
  // everything. Widened, never narrowed: every file below resolves admin.scheduleConfig through a `t`
  // binding, and a key used on the Edit page but missing from ta.json would have gone unnoticed if this
  // had stayed pointed at the list.
  const SCREEN_FILES = [
    'app/admin/attendance/schedule/page.tsx',
    'app/admin/attendance/schedule/group-sections.tsx',
    'app/admin/attendance/schedule/new/page.tsx',
    'app/admin/attendance/schedule/[ruleId]/page.tsx',
    'app/admin/attendance/schedule/[ruleId]/edit/page.tsx',
  ];
  const usedKeys = () => {
    // Lookbehind excludes the OTHER namespace bindings — `tp('dayMon')` (admin.attendancePolicy),
    // `tr('save')` (admin.attendanceRule) and `trs('dayKindFull')` (roster) — those keys are not ours
    // and must not be demanded of this namespace.
    return SCREEN_FILES.flatMap((f) =>
      [...read(f).matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]),
    );
  };

  it('the screen really does use the scheduleConfig namespace (guard against a vacuous sweep)', () => {
    const keys = usedKeys();
    expect(keys.length).toBeGreaterThan(20);
    // 665de026 — `tabGeneral` became `sectionGeneral` when the tabs became sections; the value in every
    // catalogue is the word it always was.
    expect(keys).toContain('sectionGeneral');
    expect(keys).toContain('sectionWorkingDay');
    expect(keys).toContain('gapRotationTitle');
    // Every one of the four per-group pages is actually swept, not just the list.
    for (const f of SCREEN_FILES) expect(read(f), `${f} resolves admin.scheduleConfig`).toContain("getTranslations('admin.scheduleConfig')");
  });

  for (const loc of LOCALES) {
    it(`${loc}: admin.scheduleConfig and nav.schedule resolve, with no key left blank`, () => {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const ns = msgs.admin?.scheduleConfig;
      expect(ns, `messages/${loc}.json has no admin.scheduleConfig namespace.`).toBeTruthy();
      expect(msgs.nav?.schedule, `messages/${loc}.json has no nav.schedule label.`).toBeTruthy();
      const missing = usedKeys().filter((k) => !ns[k] || String(ns[k]).trim() === '');
      expect(missing, `[${loc}] missing/blank admin.scheduleConfig keys: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

/**
 * ── THE STALENESS GUARD FOR THE "Not configured here" CARD ─────────────────────────────────────────────
 *
 * The card is a deliverable of this round: the plan promised "where a setting genuinely does not exist yet
 * we will say so rather than draw a box that does nothing", and the four entries are that promise kept.
 * But every entry is a claim about what is stored TODAY, and each one stops being true the moment the
 * storage behind it ships. Nothing would have failed when that happened: the card would have gone on
 * telling the reporter a setting they can now edit does not exist, which is worse than never naming the gap
 * — the page comment "Delete an entry only when its storage actually ships" is a request, not a guard.
 *
 * So each case below re-checks the ABSENCE its entry asserts, in the file where the storage would have to
 * appear, and names the i18n keys to delete in all six locales plus the <dl> row in the page. A failure
 * here is good news: the round that fills the gap has arrived, and the card must shrink with it.
 *
 * These are absence proofs, so they are necessarily approximate about NAMES — a rotation cycle stored as
 * `crew_cycle` would slip past the identifier scan. What they cannot miss is the SHAPE of each claim
 * (a pure predicate becoming a stored one; the cap acquiring a second editor; the inert day types being
 * read), which is what actually makes each sentence false.
 */
describe('1c5602cc — the "Not configured here" card is tied to the absences it claims', () => {
  const PAGE = 'app/admin/attendance/schedule/page.tsx';
  /** Every gap entry the page actually renders: `t('gapRotationTitle')` → `gapRotation`. */
  const renderedGaps = () =>
    [...new Set([...read(PAGE).matchAll(/t\('(gap[A-Z]\w*?)(?:Title|Body)'\)/g)].map((m) => m[1]))].sort();

  /** Source with line and block comments removed — prose about a concept is not storage OF it. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  /** Every SQL identifier db/schema.ts declares: table names and column names alike. */
  const schemaIdentifiers = () => [
    ...new Set([...stripComments(read('db/schema.ts')).matchAll(/\w+\(\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1])),
  ];

  it('the card and this guard cover the SAME four gaps', () => {
    expect(
      renderedGaps(),
      `A gap entry was added to or removed from the "Not configured here" card without its staleness ` +
        `guard moving with it. Every entry on that card is a claim that something is not stored; each one ` +
        `needs a case below that fails when it becomes stored, or the card silently rots into a lie.`,
    ).toEqual(['gapDayTypes', 'gapOtCap', 'gapRoster', 'gapRotation']);
  });

  it('gapRotation — no rotation cycle is stored anywhere', () => {
    // `rotat` only: this repo already stores a payroll cycle and a review cycle, so a bare `cycle`
    // scan is all false alarm. A rotation column would carry the word the reporter used.
    const stored = schemaIdentifiers().filter((n) => /rotat/.test(n));
    const inGenerator = [...stripComments(read('core/roster.ts')).matchAll(/\brotation\b/g)].length;
    expect(
      { stored, inGenerator },
      `admin.scheduleConfig.gapRotationTitle/gapRotationBody say a repeating rotation cycle is "not stored ` +
        `anywhere" and that a control for it "would need storage that does not exist yet". Something ` +
        `rotation-shaped now exists. If rotation storage has shipped, DELETE gapRotationTitle and ` +
        `gapRotationBody from all six messages/*.json and drop their <dl> row from ${PAGE} — then build ` +
        `the control the card was standing in for.`,
    ).toEqual({ stored: [], inGenerator: 0 });
  });

  it('gapRoster — the roster rule is still a pure predicate, not a stored setting', () => {
    const src = read('core/roster.ts');
    const decl = src.match(/export const canWriteRosterDate[\s\S]*?;/);
    expect(
      decl,
      `core/roster.ts no longer exports canWriteRosterDate as a single expression. ` +
        `admin.scheduleConfig.gapRosterBody describes it in words to the reporter ("Only an HR ` +
        `administrator may change a roster date that is today or earlier"); re-point this guard at ` +
        `whatever replaced it, or correct the sentence.`,
    ).not.toBeNull();
    const body = decl![0];
    const settingsShaped = /await|\bdb\b|\.select\(|Setting|Config/.test(body);
    const storedSettings = schemaIdentifiers().filter((n) => /roster/.test(n) && /setting|config|option|rule/.test(n));
    expect(
      { settingsShaped, storedSettings },
      `admin.scheduleConfig.gapRosterTitle/gapRosterBody say the Duty Roster's rules are "Fixed rules, not ` +
        `settings ... Neither can be turned off from a screen". The predicate now consults something, or a ` +
        `roster settings row now exists — either way the sentence is false. DELETE gapRosterTitle, ` +
        `gapRosterBody and rosterLink from all six messages/*.json and drop their <dl> row from ${PAGE}, ` +
        `and put the real control on this tab instead.`,
    ).toEqual({ settingsShaped: false, storedSettings: [] });
  });

  it('gapDayTypes — the five day types are fixed, and two of them are still inert', () => {
    expect(
      [...DAY_TYPE_INCLUSION_KEYS],
      `admin.scheduleConfig.gapDayTypesBody tells the reporter "The five day types are fixed". The ` +
        `allow-list changed. Rewrite gapDayTypesBody in all six messages/*.json to match the new set.`,
    ).toEqual(['offDay', 'restDay', 'publicHoliday', 'companyHoliday', 'shutdownDay']);

    // The counting kernel is where "recorded but not yet acted on" is decided: `dayWeight` weighs a holiday
    // by `inclusion.publicHoliday` alone and collapses restDay/offDay into one bucket (core/leave.ts, the
    // Phase A comments). Phase B is exactly the change that makes it read the other two.
    const kernel = read('core/leave.ts').match(/function dayWeight\([\s\S]*?\n}/);
    expect(kernel, 'core/leave.ts no longer declares dayWeight — re-point this guard at the counting kernel.').not.toBeNull();
    const reads = ['companyHoliday', 'shutdownDay'].filter((k) => kernel![0].includes(`inclusion.${k}`));
    expect(
      reads,
      `admin.scheduleConfig.gapDayTypesBody says company holiday and shutdown day are "recorded but not yet ` +
        `acted on". dayWeight now reads ${reads.join(' and ')}, so Phase B has landed and the sentence is ` +
        `false. Rewrite gapDayTypesBody in all six messages/*.json — and if the day types became editable, ` +
        `delete gapDayTypesTitle/gapDayTypesBody and their <dl> row from ${PAGE} entirely.`,
    ).toEqual([]);
  });

  it('gapOtCap — the monthly overtime cap is still owned and edited by Payroll alone', () => {
    expect(
      read('db/schema.ts').includes('maxHoursPerMonth'),
      `db/schema.ts no longer declares maxHoursPerMonth. admin.scheduleConfig.gapOtCapBody points the ` +
        `reporter at Payroll for it; if the cap moved or went away, that sentence must move with it.`,
    ).toBe(true);

    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(rel);
        return /\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const editors = walk('app').filter((f) => read(f).includes('maxHoursPerMonth'));
    expect(
      editors.sort(),
      `admin.scheduleConfig.gapOtCapBody tells the reporter the monthly overtime-hour limit is "Stored on ` +
        `the payroll policy, not on the schedule, and edited under Payroll. Shown there so one figure has ` +
        `one owner." A screen outside app/admin/payroll-policy now touches it, so it has two owners or a ` +
        `new one. If it is now edited (or shown) on the schedule, DELETE gapOtCapTitle/gapOtCapBody from ` +
        `all six messages/*.json and render the figure instead — that is the one plan promise this round ` +
        `did not deliver.`,
    ).toEqual(['app/admin/payroll-policy/actions.ts', 'app/admin/payroll-policy/policy-wizard.tsx', PAGE].sort());
  });
});
