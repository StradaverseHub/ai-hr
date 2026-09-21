/**
 * Attendance module pack (ADR-0080 D8/D11, retrofit ladder rung 2 — the pattern-prover).
 *
 * Verifies the three mechanical halves of the retrofit with behaviour unchanged:
 *   1. Registry: `packs/attendance` registers a module pack the registry resolves by id.
 *   2. Nav parity: the pack's nav node is ROW-FOR-ROW the sidebar's pre-rung-2 ATTENDANCE_NODE —
 *      same labelKeys, hrefs, icon refs, visibility flags, same order — and components/sidebar.tsx
 *      mounts it via the registry instead of hardcoding it (the EXPECTED table below is the
 *      pre-change literal, captured verbatim; any drift is a rendering change by definition).
 *   3. Facade: `packs/attendance/service` re-exports the implementation — outside callers get the
 *      exact same function references, so switching import paths cannot change behaviour.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CalendarCheck,
  CalendarClock,
  CalendarCog,
  CalendarDays,
  CalendarRange,
  ClipboardList,
  CreditCard,
  Table2,
  Clock,
  FilePen,
  FileUp,
  HandCoins,
  Hourglass,
  MapPin,
  Plane,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { attendancePack } from '../packs/attendance';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { listPacks, modulePackById, packById } from '../packs/registry';
import * as facade from '../packs/attendance/service';
import * as coreAttendance from '../core/attendance';
import * as coreAllowance from '../core/attendance-allowance';
import * as coreDerive from '../core/attendance-derive';
import * as coreDevice from '../core/attendance-device';
import * as coreRule from '../core/attendance-rule';
import * as coreClockingLocation from '../core/clocking-location';

describe('ADR-0080 rung 2: attendance pack registration', () => {
  it('registers as a module pack the registry resolves by id', () => {
    expect(packById('attendance')).toBe(attendancePack);
    expect(modulePackById('attendance')).toBe(attendancePack);
    expect(attendancePack.kind).toBe('module');
    expect(listPacks('module').map((p) => p.id)).toContain('attendance');
  });

  it('declares the audited satellite tables (D11 criterion 2)', () => {
    const tables = (attendancePack.satelliteTables ?? []).map((t) => t.table);
    expect(tables).toEqual([
      'attendance',
      'attendance_punch',
      'attendance_correction',
      'attendance_policy',
      'attendance_rule',
      'attendance_rule_ot_row',
      'attendance_allowance_policy',
      'clocking_location',
      'employee_clocking_location',
      'employee_device',
    ]);
  });

  it('declares its service facade path (D11 criterion 3 pointer)', () => {
    expect(attendancePack.serviceFacade).toBe('packs/attendance/service');
  });
});

/**
 * r314 (fe2360f9 + 7c80a168) — the hrefs that appear TWICE on purpose: once adminOnly in the Attendance
 * node, once managerUp as a flat Manage row. Module-scoped because two separate describes assert on it:
 * the parity block (a duplicate that is NOT one of these still fails, and removing either half fails)
 * and the label block (a pair shares ONE label key, so both menus name the screen the same).
 */
const PAIRED_HREFS: readonly string[] = ['/roster', '/attendance/import'];

describe('ADR-0080 rung 2: nav parity with the pre-retrofit sidebar', () => {
  // components/sidebar.tsx ATTENDANCE_NODE as of the commit before rung 2, captured VERBATIM
  // (b3dc0f78 consolidation + 5cb199b3 + f60cd403 order + 5249d43f clock-first). This is the
  // pixel/behaviour-parity oracle: same rows, same order, same icon refs, same gates.
  const EXPECTED = [
    { href: '/attendance/clock', labelKey: 'attendanceClock', icon: Clock },
    /**
     * f3e6c36e (r287) — THE SAME ROW, RE-POINTED. This is the employee's Records row: second in the
     * self-service node, ungated, Clock glyph, present since the pre-retrofit capture. It has NOT left the
     * pack, so it is not a MOVED_OUT entry; its ADDRESS and its LABEL changed together, which is the
     * ad52212d / 870b79e2 precedent for updating an oracle line rather than re-declaring the row.
     *
     * WHAT IT WAS: `{ href: '/attendance', labelKey: 'attendanceRecords' }` — pointing at the screen BOTH
     * audiences shared. That is deliberately written out here so the update does not erase the record.
     *
     * WHY IT MOVED: the reporter asked twice, in writing, for the administrative Record function to leave
     * My Attendance. `/attendance` could not simply be moved (the Administration group gates adminOnly at
     * GROUP level, so the row would vanish for staff rather than become admin-only — a324a4b3 rev2's
     * regression, still pinned by test/sidebar-attendance-group.test.ts). The approved plan splits instead:
     * the employee gets their own screen at `/attendance/my-records` and `/attendance` is left to the
     * admin row. Every parity property this oracle exists for is unchanged and still asserted below —
     * same icon ref, still ungated, still exactly once, still second in its node.
     */
    { href: '/attendance/my-records', labelKey: 'myRecords', icon: Clock },
    { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays, adminOnly: true },
    // a324a4b3 renamed three labelKeys so each names the screen it opens. The rendered STRINGS are
    // unchanged (they were already right — R17 c9f7211), so this stays a parity oracle: only the key
    // spelling moved. attendancePolicy → shiftSettings, attendancePolicyConfig → attendancePolicy,
    // toilPolicy → timeOffInLieu. The strings themselves are pinned in the describe block below.
    //
    // ad52212d round 1 renamed two of them AGAIN, and this time the STRINGS moved too: the rows are the
    // reporter's settings categories now, so "Shift settings" → "Shift" (the word "settings" is the node
    // above them) and "Attendance policy" → "Overtime Pattern". Parity is still about the ROW — same href,
    // same icon ref, same gate, still exactly once — which is what the assertions below read.
    //
    // 870b79e2 (r277) renamed the second of those two a THIRD time, and the string moved with it again:
    // "Overtime Pattern" → "Schedule Group". Same href, same icon ref, same gate, still exactly once —
    // which is everything this oracle asserts. The key is updated here rather than the row being
    // re-declared in ADDED_SINCE, for the same reason ad52212d's renames were: this is the SAME row,
    // and moving it would erase the record that it has been present since the pre-retrofit capture.
    { href: '/admin/attendance', labelKey: 'shift', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-policy', labelKey: 'scheduleGroup', icon: SlidersHorizontal, adminOnly: true },
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    { href: '/admin/toil', labelKey: 'timeOffInLieu', icon: Hourglass, adminOnly: true },
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true },
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true },
  ] as const;

  // Rows added to the pack SINCE the pre-retrofit capture. EXPECTED is a frozen historical oracle — it is
  // the sidebar literal as it stood, and rewriting it would destroy the only record of what parity means —
  // so a genuinely new row is DECLARED here instead. The parity assertions below then hold unchanged for
  // the ten original rows, while an undeclared eleventh still fails: growth has to be deliberate.
  const ADDED_SINCE = [
    // r274 (2420718d) — Employee Attendance. The SCREEN is not new and neither is its address: it began as
    // a second, administrator-gated way into `/attendance`, which is `scopedSession` and shows each viewer
    // their own scope, and it was the ONLY href in this pack listed twice.
    //
    // f3e6c36e (r287) — IT IS NO LONGER A DUPLICATE. The employee's row moved to its own screen
    // (`/attendance/my-records`, see EXPECTED above), so `/attendance` is reached from this row alone and
    // the duplicate-href assertion below is now an empty list. The row itself is untouched: same href,
    // same key, same glyph, same gate.
    { href: '/attendance', labelKey: 'employeeAttendance', icon: Clock, adminOnly: true },
    // 0bb0e303 rev2 — Attendance Request, the third self-service row. Ungated like Clock in/out and
    // Records: the forms it opens are the caller's own requests (see the node in packs/attendance/index.ts).
    { href: '/attendance/requests', labelKey: 'attendanceRequest', icon: FilePen },
    // 1e9145d4 — Plan OT, the FOURTH self-service row: overtime agreed before it is worked. Ungated for
    // the same reason as its three siblings (it is the caller's own request), and carrying Hourglass
    // rather than a third Clock or a second FilePen, because the collapsed rail renders glyphs only.
    { href: '/attendance/plan-ot', labelKey: 'planOvertime', icon: Hourglass },
    // ad52212d round 1 — Work Schedule. The SCREEN is not new (af7a8eb4 moved the company work schedule,
    // overtime rates, backup-shift coverage and registered devices onto this route); what was new is that
    // it had no menu row at all and was reachable only from a button on the rule list, which is why the
    // reporter read the whole category as missing. adminOnly like every other row in this node.
    { href: '/admin/attendance-policy/schedule', labelKey: 'workSchedule', icon: CalendarCheck, adminOnly: true },
    // 0bade264 (r209) — Schedule Assignment: every employee's current shift arrangement in one list. The
    // SCREEN is new; the arrangement it lists is not, and neither is the editor its View / Edit opens
    // (the personnel profile's Shift arrangement card). adminOnly like every sibling in that node.
    { href: '/admin/attendance/schedule-assignment', labelKey: 'scheduleAssignment', icon: Users, adminOnly: true },
    // c6bb5f5a — My Travel and My Attendance Request Status, the fifth and sixth self-service rows.
    // NEITHER FUNCTION IS NEW; both were reachable only by scrolling down the shared /attendance/requests
    // screen, which is why the reporter read them as missing. Declared here for the same reason every row
    // above is: growth has to be deliberate, and an undeclared row still fails the parity assertions.
    // Ungated like their four siblings — each screen shows the caller their OWN requests.
    { href: '/attendance/travel', labelKey: 'myTravel', icon: Plane },
    { href: '/attendance/request-status', labelKey: 'myAttendanceRequestStatus', icon: ClipboardList },
    // 1c5602cc (r263) — Schedule: the tabbed configuration screen for an employee's working pattern
    // (General built; Holiday / Overtime / Attendance / Request / Notification named and EMPTY). The
    // SCREEN is new; almost nothing it shows is — it reads the shift library and the per-company working
    // week from the tables that already hold them. It sits BESIDE "Work Schedule" and does not replace
    // it: a later round is explicitly the cutover, so both rows are expected here at once.
    { href: '/admin/attendance/schedule', labelKey: 'schedule', icon: CalendarCog, adminOnly: true },
    // 44bc1c33 (r306) — CARD ASSIGNMENT. The employee↔Card/Clocking ID mapping a physical terminal needs
    // when its card numbers are not the employee codes. A genuinely new row for a genuinely new screen:
    // `importAttendancePunches` matched only employee code and IC, so such a file imported NOTHING and
    // there was nowhere to fix it. Admin-only and beside Shift because it is device configuration.
    { href: '/admin/card-assignment', labelKey: 'cardAssignment', icon: CreditCard, adminOnly: true },
    // 22d67223 (r311) — ATTENDANCE BREAKDOWN DETAIL, the audit view: every figure the engine recorded for
    // one employee, day by day, across a range. It is the EXACT COUNTERPART of 570fd56e (r306), which took
    // the eight calculation columns OFF Individual Attendance because that screen is for reviewing a month.
    // Those columns were moved, not deleted, and this is where they were moved TO — so the pair only makes
    // sense read together, and neither row may be removed on the argument that the other covers it.
    // It leads with '/attendance' rather than sitting among the settings for the reason that oracle already
    // states below: it is a READING, not a configuration screen.
    { href: '/attendance/breakdown', labelKey: 'attendanceBreakdown', icon: Table2, adminOnly: true },
    // r314 (fe2360f9 + 7c80a168) — ROSTER and IMPORT return to this node as adminOnly DUPLICATES of the
    // managerUp rows in Manage, which stay. a324a4b3 rev3 took them out because a managerUp row inside
    // the admin-gated group is invisible to managers, and rejected the duplicated menu; the reporter was
    // shown that trade in writing and chose the duplication rather than lose the manager rows. Both sets
    // are asserted, here and in test/attendance-menu-relocation.test.ts.
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, adminOnly: true },
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, adminOnly: true },
  ] as const;

  /**
   * Rows that have LEFT the pack since the capture — the mirror of ADDED_SINCE, and for the same reason.
   *
   * EXPECTED is frozen, so a departure cannot be expressed by deleting its line: that would erase the
   * record of what parity meant and turn "row vanished" back into a silent pass. It is declared here
   * instead, with where it went, and the parity assertions below subtract it explicitly — so a row that
   * disappears WITHOUT a line here still fails, which is the whole point of the oracle.
   *
   * 4509d2b8 — Holidays moved to components/sidebar.tsx SYSTEM_SETTINGS_NODE. It is not an attendance
   * service (core/holidays.ts is spine: leave, attendance and payroll all read the one list), and while
   * its row lived here MODULE_OF_HREF gated it behind the BILLABLE `attendance` module, hiding the
   * holiday calendar from Leave-only tenants whose leave maths depends on it. The row's own href, icon,
   * labelKey and adminOnly gate are unchanged — only its container. Pinned at its new home by
   * test/sidebar-system-settings-group.test.ts and test/holidays-system-settings-relocation.test.ts.
   */
  const MOVED_OUT = [
    { href: '/admin/holidays', to: 'components/sidebar.tsx SYSTEM_SETTINGS_NODE' },
  ] as const;
  const movedOutHrefs: string[] = MOVED_OUT.map((r) => r.href);

  /**
   * e4471e3c (r287) — rows whose NAV ENTRY was retired while the SCREEN stayed. A THIRD list, and it is
   * deliberately not MOVED_OUT.
   *
   * MOVED_OUT means "this row now hangs off a different menu", and its sibling assertions say so: the
   * href must be absent from the pack AND present in components/sidebar.tsx. These two rows are a
   * different thing — they are in NO menu at all. The reporter asked for Schedule Group and Work Schedule
   * to be consolidated into the Schedule sub-menu, so their rows went and the Schedule screen absorbed
   * the settings; the ROUTES survive as the owning editors for what did NOT move (the deduction switch,
   * the overtime bands and rates, the tenant overtime rates, the registered devices), and they keep their
   * lib/permissions.ts registration, because a screenKey is a permission identity.
   *
   * Declaring them here rather than deleting their EXPECTED / ADDED_SINCE lines keeps the oracle's whole
   * point intact: a row that disappears WITHOUT a line here still fails. And the case below turns the
   * declaration into an obligation — a retired row must still have a reachable, registered route, so
   * "retire the row" can never become a way to quietly strand a screen.
   */
  const RETIRED = [
    {
      href: '/admin/attendance-policy',
      why: 'Schedule Group — consolidated into Attendance > Schedule (e4471e3c); since 6d091cc0 (r301) the list is a card on its General tab and the editor a panel there, and this route is a requireAdmin() redirect to that card (#schedule-groups), kept registered because the screenKey is a permission identity.',
    },
    {
      href: '/admin/attendance-policy/schedule',
      why: 'Work Schedule — its per-company working-week editor is the Company Policy Settings card on the Schedule screen’s General tab, and since 6d091cc0 (r301) the tenant overtime rates, registered devices and backup-shift coverage are the Work Schedule & Overtime Rates card beside it. This route is a requireAdmin() redirect to that card (#work-schedule-overtime), kept registered because the screenKey is a permission identity.',
    },
  ] as const;
  const retiredHrefs: string[] = RETIRED.map((r) => r.href);

  /**
   * 3fb1a611 (r299) — rows whose SCREEN WAS FOLDED INTO ANOTHER SCREEN: the page became a redirect stub and
   * its content lives at `into`. A FOURTH list, deliberately not RETIRED, whose obligation is "the page
   * survives and stays registered" — exactly what a folded screen must NOT do (a stub is not a guarded page,
   * so test/function-access.test.ts refuses it as a registered route). The obligation here is the folded
   * version of the same promise: the row is gone, the old address still resolves (a redirect to `into`), and
   * `into` is a registered route — so folding can never strand the content either.
   */
  const FOLDED = [
    {
      href: '/admin/toil',
      into: '/admin/leave-config/leave-credit',
      why: 'Time off in lieu — its ledger summary and both settlement sweeps are on Leave Config › Leave Credit, beside every credit movement they settle (one screen per fact). That screen is gated on the toil module and opens a read-only wind-down view when the module lapses with credits outstanding.',
    },
  ] as const;
  const foldedHrefs: string[] = FOLDED.map((r) => r.href);
  /** Every href that is no longer expected in this pack's nav, whatever the reason. */
  const goneHrefs = [...movedOutHrefs, ...retiredHrefs, ...foldedHrefs];

  /**
   * The My Attendance node's rows, in order — stated ONCE and asserted from two cases below, which used
   * to carry two hand-typed copies of the same list.
   *
   * c6bb5f5a TOOK IT FROM FOUR ROWS TO SIX, and that is a deliberate reversal of what the fourth row's
   * comment used to describe. 2166ef79 had folded Self Overtime, Travel Request and the request history
   * onto ONE screen (/attendance/requests) — Plan OT's route was left forwarding into a tab on it. The
   * reporter has since asked for the opposite, in writing and confirmed: four functions, four screens.
   * So plan-ot renders its own list again, and Travel and the request history get the rows they never
   * had. Clock in/out and Records are untouched, in their original positions.
   *
   * f3e6c36e (r287) — STILL SIX ROWS, AND RECORDS IS STILL SECOND; what changed is where the second row
   * POINTS. It was `/attendance`, the screen shared with the administrator's Employee Attendance row; it
   * is now `/attendance/my-records`, the employee's own. The reporter asked twice for the administrative
   * Record function to leave this menu and reaffirmed after being told why it could not simply be moved,
   * so the approved plan splits the screen instead of moving the row. The membership rule this list has
   * always guarded is unchanged: six rows, written down, none of them gated.
   */
  const SELF_SERVICE_ROWS = [
    '/attendance/clock',
    '/attendance/my-records',
    '/attendance/requests',
    // 1e9145d4 — Plan OT lands after Attendance Request, exactly where the reporter's screenshot put it.
    '/attendance/plan-ot',
    // c6bb5f5a — the two rows this round added, after the four that were already here.
    '/attendance/travel',
    '/attendance/request-status',
  ];

  // 0bb0e303 split the node three ways and a324a4b3 rev2 merged two of the three back, so parity is
  // no longer "one node with ten rows in order" and no longer "three nodes by audience" either.
  // The guarantee that MATTERS survives every regrouping and is what is asserted below: every
  // pre-retrofit row still exists exactly once, with its icon and gates untouched, and the relative
  // order is preserved. Regrouping rows is the visible change the reporter asked for; losing one, or
  // quietly widening a gate while moving it, is not — and only the second kind should fail here.
  const NODES = attendancePack.navNodes!;
  // a324a4b3 rev3 — two rows left the nodes entirely and became flat Manage rows (navLinks). The parity
  // oracle is about the ROWS, not about which container holds them, so both sources are flattened here.
  const MANAGE_LINKS = attendancePack.navLinks ?? [];
  const flattened = [...NODES.flatMap((n) => n.children), ...MANAGE_LINKS];

  it('declares TWO nodes — self-service in main, config in admin (a324a4b3 rev3)', () => {
    // ad52212d round 1 renamed the config node's label key `attendance` → `attendanceSettings`: it is the
    // reporter's "Attendance › Settings" sub-menu. 0bade264 (r209) put the STRING back to plain
    // "Attendance" at their request and left the key alone — see test/attendance-menu-relocation.test.ts
    // for why the key cannot become `attendance` again and what pays for the collision that would create.
    // Two nodes, same groups, same rows.
    expect(NODES.map((n) => n.labelKey)).toEqual(['myAttendance', 'attendanceSettings']);
    // rev2 had both in 'main' because the merged node mixed three gates. rev3 is the reporter's own
    // correction — the CONFIG menu belongs in Administration between Leave config and Claims config — and
    // it is only safe there because the mixed rows moved out first. See the regression guard below.
    expect(NODES.map((n) => n.group)).toEqual(['main', 'admin']);
    // The two managerUp rows are flat Manage rows now, not children of anything.
    expect(MANAGE_LINKS.map((l) => l.href).sort()).toEqual(['/attendance/import', '/roster']);
  });

  it('orders the Attendance CONFIG menu as the reporter listed the settings', () => {
    const merged = NODES.find((n) => n.labelKey === 'attendanceSettings')!;
    // ad52212d ROUND 1 — the order the reporter asked for: their THREE named settings categories first
    // (Shift → Overtime Pattern → Work Schedule), then the remaining configuration screens in the
    // 5cb199b3 ticket order they have always held among themselves. All config, all adminOnly.
    // Records / Roster / Import are still not here — see rev3.
    //
    // 4509d2b8 — SIX rows, not seven: Holidays left for System Settings (MOVED_OUT above). The three
    // categories still lead and the tail keeps its ticket order among the screens that stayed.
    //
    // 0bade264 (r209) — SEVEN rows: Schedule Assignment lands FOURTH, after the reporter's three named
    // categories and ahead of the 5cb199b3 tail. It is not a fourth category of settings — it is the
    // screen that USES the shift library the three above configure — so it goes after them, and the tail
    // keeps the ticket order it has always held among its own members.
    expect(merged.children.map((c) => c.href)).toEqual([
      // r274 (2420718d) — EMPLOYEE ATTENDANCE LEADS, and it is not a settings category. The reporter asked
      // for "all administrative attendance functions under ADMIN > Attendance"; this is the one that is a
      // READING rather than a setting, so it sits above the configuration rows rather than among them.
      // It shares its href with Records in MY_ATTENDANCE_NAV deliberately — see the note on the row.
      '/attendance', // Employee Attendance
      // 22d67223 (r311) — Attendance Breakdown, SECOND and not among the settings: by this list's own
      // rule the readings lead and the configuration rows follow, and this is the second reading.
      '/attendance/breakdown',
      // r314 — the two administrative READINGS/operations, before the settings rows, by this list's own
      // rule that readings lead. Import after Roster (f60cd403): bulk upload is used less than the roster.
      '/roster',
      '/attendance/import',
      '/admin/attendance', // Shift
      '/admin/card-assignment', // Card Assignment (44bc1c33) — device configuration, beside Shift
      // e4471e3c (r287) — THE CUTOVER. '/admin/attendance-policy' (Schedule Group) and
      // '/admin/attendance-policy/schedule' (Work Schedule) STOOD HERE and are gone, because the reporter
      // asked for both to be consolidated into the Schedule row below: "to provide a single centralised
      // Schedule configuration area for all schedule-related settings and avoid duplicated or separated
      // schedule configuration screens". Their ROUTES survive as the owning editors for what did not
      // move — see RETIRED above, and the case that makes that survival an obligation rather than a note.
      '/admin/attendance/schedule', // Schedule (tabbed configuration — now the only schedule-config row)
      '/admin/attendance/schedule-assignment', // Schedule Assignment
      '/admin/attendance-allowance',
      '/admin/locations', // Clocking location
      // 3fb1a611 (r299) — '/admin/toil' (Time off in lieu) STOOD HERE and is gone: RETIRED above.
    ]);
    // Self-service keeps Clock in/out first (5249d43f) with Records beside it, and Attendance Request
    // third (0bb0e303 rev2) — the reporter's order: clock in and out, look at your record, file a request.
    const mine = NODES.find((n) => n.labelKey === 'myAttendance')!;
    expect(mine.children.map((c) => c.href)).toEqual(SELF_SERVICE_ROWS);
  });

  it('keeps every pre-retrofit row exactly once, with identical icon refs and gates', () => {
    expect(flattened).toHaveLength(
      EXPECTED.length + ADDED_SINCE.length - MOVED_OUT.length - RETIRED.length - FOLDED.length,
    );
    /**
     * r274 — MATCHED ON href + labelKey, not href alone, because `/attendance` was then listed twice on
     * purpose: Records for every employee in the self-service node, and the admin-gated Employee
     * Attendance row in the config node, because that group hides as a whole and a move would have taken
     * the screen away from staff.
     *
     * f3e6c36e (r287) — THAT DUPLICATION IS GONE, and the match is deliberately LEFT on href + labelKey
     * anyway. Narrowing it back to href alone would be a silent re-tightening that hides the next
     * deliberate pair; the empty-dupes assertion below is what now states, positively, that no href is
     * listed twice at all. Those two together are strictly stronger than either.
     */
    [...EXPECTED, ...ADDED_SINCE]
      .filter((want) => !goneHrefs.includes(want.href))
      .forEach((want) => {
        const got = flattened.filter((c) => c.href === want.href && c.labelKey === want.labelKey);
        // r314 — a DECLARED PAIR appears twice by the owner's decision; everything else still once.
        expect(got, `${want.href} (${want.labelKey}) appears ${PAIRED_HREFS.includes(want.href) ? 'twice' : 'exactly once'}`)
          .toHaveLength(PAIRED_HREFS.includes(want.href) ? 2 : 1);
        expect(got[0].labelKey, `${want.href} labelKey`).toBe(want.labelKey);
        expect(got[0].icon, `${want.href} icon ref`).toBe(want.icon);
        // A declared pair carries DIFFERENT gates on its two copies by design (one adminOnly, one
        // managerUp), so asserting one declaration against got[0] would be asserting an arbitrary half.
        // The pair block below asserts both halves positively, which is the stronger statement.
        if (!PAIRED_HREFS.includes(want.href)) {
          expect(got[0].adminOnly, `${want.href} adminOnly`).toBe('adminOnly' in want ? want.adminOnly : undefined);
          expect(got[0].managerUp, `${want.href} managerUp`).toBe('managerUp' in want ? want.managerUp : undefined);
        }
      });
    // NO href is listed twice. This assertion has been TIGHTENED, not loosened: r274 allowed exactly one
    // duplicate (`/attendance`, deliberately, as the only way one screen could serve two audiences from
    // two menus), and f3e6c36e removed the CAUSE rather than the symptom by giving the employee their own
    // screen. An empty list is the strongest form this line has ever taken, and it is what keeps
    // "match on href + labelKey" above from becoming a way to hide a duplicate.
    /**
     * ⚠️ r314 (fe2360f9 + 7c80a168) — THIS LIST IS NO LONGER EMPTY, AND THAT IS A DECISION, NOT A DRIFT.
     *
     * Its history is the argument: r274 allowed exactly one deliberate duplicate because it was the only
     * way one screen could serve two audiences from two menus; f3e6c36e removed the CAUSE by giving the
     * employee their own screen and tightened this to []. r314 reintroduces two, for the r274 reason
     * exactly — the reporter asked for Roster and Import under Admin, was shown in writing that moving
     * them there takes both rows from every manager, and chose to have them in both places.
     *
     * So the assertion NAMES what may be duplicated instead of permitting duplicates. An undeclared
     * duplicate still fails, which is what this line has always been for.
     */
    const dupes = [...new Set(flattened.map((c) => c.href))].filter(
      (h) => flattened.filter((c) => c.href === h).length > 1,
    );
    expect(dupes.sort(), 'only the declared admin/manager pairs may appear twice').toEqual([...PAIRED_HREFS].sort());
    // …and each pair is one adminOnly row and one managerUp row. Two adminOnly copies would mean the
    // manager row was quietly dropped — the exact loss the reporter was promised would not happen.
    for (const href of PAIRED_HREFS) {
      const pair = flattened.filter((c) => c.href === href);
      expect(pair.filter((c) => c.adminOnly === true), `${href}: one adminOnly copy`).toHaveLength(1);
      expect(pair.filter((c) => c.managerUp === true), `${href}: one managerUp copy`).toHaveLength(1);
    }
    // The two rows the split produced, named, so "no duplicates" cannot be satisfied by losing one of
    // them. `/attendance` is the administrator's, gated; `/attendance/my-records` is the employee's own
    // and carries no gate. That pairing IS the item, so it is asserted positively rather than implied.
    const adminRow = flattened.filter((c) => c.href === '/attendance');
    expect(adminRow.map((c) => c.labelKey)).toEqual(['employeeAttendance']);
    expect(adminRow[0].adminOnly, 'the admin entry is gated').toBe(true);
    const mineRow = flattened.filter((c) => c.href === '/attendance/my-records');
    expect(mineRow.map((c) => c.labelKey)).toEqual(['myRecords']);
    expect(mineRow[0].adminOnly, 'the employee entry stays ungated').toBeUndefined();
    expect(mineRow[0].managerUp, 'the employee entry stays ungated').toBeUndefined();
  });

  it('a row declared MOVED_OUT is gone from the pack entirely — not left behind as a second copy', () => {
    // The other half of the subtraction above. Without this, "declare it moved out" would be a way to
    // switch off coverage for a row that is quietly still here (or, worse, here TWICE — which would put
    // it back into MODULE_OF_HREF and undo the un-gating that was the point of moving it).
    for (const row of MOVED_OUT) {
      expect(
        flattened.filter((c) => c.href === row.href),
        `${row.href} left the attendance pack for ${row.to}`,
      ).toHaveLength(0);
    }
  });

  /**
   * e4471e3c (r287) — RETIRING A ROW IS AN OBLIGATION, NOT A DELETION.
   *
   * "Declare it retired" must never become a way to make a screen unreachable and still be green. So each
   * entry owes three things: the row really is gone from the pack, the PAGE still exists on disk, and the
   * route is still registered in lib/permissions.ts — the last one matters most, because `screenKey` is a
   * permission identity and dropping a route is how a stored role configuration silently loses a grant.
   *
   * Reachability itself — that the Schedule screen links to both of them, which is the only way in now —
   * is pinned next door in test/schedule-config-screen.test.ts, beside the screen that does the linking.
   */
  it('a RETIRED row is gone from the nav, and its SCREEN and matrix column are not', () => {
    for (const row of RETIRED) {
      expect(
        flattened.filter((c) => c.href === row.href),
        `${row.href} still has a nav row. ${row.why}`,
      ).toHaveLength(0);
      const page = path.resolve(__dirname, '..', `app${row.href}`, 'page.tsx');
      expect(fs.existsSync(page), `${row.href} lost its page. ${row.why}`).toBe(true);
      expect(
        REGISTERED_ROUTES.has(row.href),
        `${row.href} is no longer registered in lib/permissions.ts. The screenKey is a permission ` +
          `identity — removing the route revokes whatever stored role configuration references it, ` +
          `silently. ${row.why}`,
      ).toBe(true);
    }
  });

  it('3fb1a611: a FOLDED row is gone from the nav, its old address redirects, and its destination is registered', () => {
    for (const row of FOLDED) {
      expect(flattened.filter((c) => c.href === row.href), `${row.href} still has a nav row. ${row.why}`).toHaveLength(0);
      const page = fs.readFileSync(path.resolve(__dirname, '..', `app${row.href}`, 'page.tsx'), 'utf8');
      expect(page, `${row.href} must redirect to ${row.into}. ${row.why}`).toContain(`redirect(\`${row.into}`);
      expect(REGISTERED_ROUTES.has(row.href), `${row.href} is a stub and must not stay registered`).toBe(false);
      expect(REGISTERED_ROUTES.has(row.into), `${row.into} must be a registered route. ${row.why}`).toBe(true);
    }
  });

  it('preserves the pre-retrofit relative order WITHIN each node', () => {
    // Rows may land in different nodes, but a row that came before another must not come after it now.
    // Asserted per node, because across nodes the order is the sidebar's group layout, not the pack's.
    // Widened to string[]: EXPECTED is `as const`, so map() yields a union of the ten literal hrefs
    // and indexOf() then refuses a plain string. The comparison is by position, not by literal type.
    const wantOrder: string[] = EXPECTED.map((r) => r.href);
    // Rows added since the capture (ADDED_SINCE) have no pre-retrofit position to preserve, so they are
    // excluded from the sequence rather than compared against one — but they still have to be DECLARED:
    // the unknown-row assertion below is what keeps this from becoming "any new href is fine".
    const added: string[] = ADDED_SINCE.map((r) => r.href);
    // ad52212d ROUND 1 — THE CONFIG NODE IS EXEMPT FROM THE SEQUENCE, AND ONLY FROM THE SEQUENCE.
    //
    // Re-ordering those rows is the change the reporter asked for by name: their three settings categories
    // lead, the other four follow. So the pre-retrofit SEQUENCE cannot hold there any more, and pretending
    // it does would mean either not shipping the item or writing an assertion that is false. What the
    // guard exists to catch — a row silently vanishing, or a row nobody declared appearing — is unaffected
    // and is still checked below for every container including this one. The exact new order is pinned in
    // its own case above ("orders the Attendance CONFIG menu as the reporter listed the settings"), so the
    // arrangement is still written down; it just moved to the assertion that states it positively.
    const REORDERED = 'attendanceSettings';
    for (const container of [
      ...NODES.map((n) => ({ name: n.group, labelKey: n.labelKey, rows: n.children })),
      { name: 'navLinks', labelKey: 'navLinks', rows: MANAGE_LINKS },
    ]) {
      const positions = container.rows.filter((c) => !added.includes(c.href)).map((c) => wantOrder.indexOf(c.href));
      if (container.labelKey !== REORDERED) {
        expect(positions, `${container.name} keeps pre-retrofit order`).toEqual([...positions].sort((a, b) => a - b));
      }
      expect(positions.every((i) => i >= 0), `${container.name} has no unknown row`).toBe(true);
    }
  });

  it('THE REGRESSION GUARD: a node in a wholesale-gated group contains ONLY rows that gate be that strictly', () => {
    // THIS ASSERTION HAS NOW BEEN INVERTED TWICE AND THE RULE BEHIND IT HAS NEVER CHANGED — read that
    // before inverting it a third time.
    //
    // 0bb0e303 kept the two managerUp rows OUT of the admin node. rev2 said no attendance node may sit
    // in 'admin' at all, and added: "If a future change moves this node into Admin, THIS is the test that
    // must fail." It did fail, exactly as intended, when rev3 made that move — because the reporter asked
    // for it in as many words.
    //
    // So the guard is restated at the level it always meant: the Administration sidebar group is gated
    // adminOnly as a WHOLE and the sidebar filters group-first, so a row inside it renders for nobody but
    // administrators REGARDLESS of its own flag. A node may therefore live there only if every one of its
    // children is already adminOnly. That is what made rev3 safe, and it is what a future edit would
    // violate by dropping Records or a managerUp row back in.
    for (const n of NODES) {
      if (n.group !== 'admin') continue;
      const widened = n.children.filter((c) => c.adminOnly !== true);
      expect(
        widened.map((c) => c.href),
        `these rows would become admin-only just by sitting in the '${n.group}' group`,
      ).toEqual([]);
    }
    // And the converse: anything NOT admin-only must live somewhere ungated at group level.
    for (const n of NODES) {
      if (n.group === 'admin') continue;
      expect(n.group, `${n.labelKey} must not hide self-service rows`).toBe('main');
    }
    expect(MANAGE_LINKS.every((l) => l.group === 'manage'), 'the managerUp rows sit in per-row-gated Manage').toBe(true);
  });

  it('THE OTHER HALF: the merged node keeps each row’s own gate, and Records keeps none', () => {
    const merged = NODES.find((n) => n.labelKey === 'attendanceSettings')!;
    const gate = (href: string) => {
      const c = merged.children.find((x) => x.href === href)!;
      return { adminOnly: c.adminOnly, managerUp: c.managerUp };
    };
    // rev3 — Records and the two managerUp rows LEFT this node, so their gates are checked at their new
    // homes. Records must still carry none, and Roster/Import must still be managerUp: a move that
    // widened or narrowed either would be the silent permissions change this whole item risks.
    const mine = NODES.find((n) => n.labelKey === 'myAttendance')!;
    // f3e6c36e (r287) — read at the employee's OWN route now. The gate rule is unchanged and is the point:
    // whatever address the employee's Records row points at, it must carry no gate, or an employee loses
    // sight of their own attendance. Re-pointing it at `/attendance` here would make this case pass
    // against the admin row and quietly stop covering the employee's.
    const records = mine.children.find((c) => c.href === '/attendance/my-records')!;
    expect({ adminOnly: records.adminOnly, managerUp: records.managerUp }).toEqual({
      adminOnly: undefined,
      managerUp: undefined,
    });
    for (const href of ['/roster', '/attendance/import']) {
      const row = MANAGE_LINKS.find((l) => l.href === href)!;
      expect({ adminOnly: row.adminOnly, managerUp: row.managerUp }, `${href} stays managerUp`).toEqual({
        adminOnly: undefined,
        managerUp: true,
      });
    }
    // 4509d2b8 — /admin/holidays is no longer in this list because it is no longer in this node. Its new
    // row (position, key, glyph) is pinned by test/sidebar-system-settings-group.test.ts, and its
    // requireAdmin PAGE guard — the thing that actually protects it, whatever the rail renders — by
    // test/holidays-system-settings-relocation.test.ts.
    // e4471e3c (r287) — '/admin/attendance-policy' and '/admin/attendance-policy/schedule' are NOT in this
    // list any more, because they are not rows any more (RETIRED above). Their PAGES still carry their own
    // requireAdmin, which is what actually protects them and is asserted in
    // test/attendance-menu-relocation.test.ts — and that coverage matters MORE now, not less: with no menu
    // row at all, the page guard is the only thing standing between a deep link and the screen.
    // 3fb1a611 (r299) — '/admin/toil' left this list with its row (RETIRED above).
    for (const href of [
      '/admin/attendance',
      // 22d67223 — the breakdown names one employee's every recorded figure for a range, so it is the
      // same audience as Employee Attendance above it: administrators, never a manager or the employee.
      '/attendance/breakdown',
      // r314 — these two are adminOnly IN THIS NODE specifically: the group gates before the rows, so a
      // managerUp row here would vanish for managers. Their Manage twins carry managerUp instead.
      '/roster',
      '/attendance/import',
      // 44bc1c33 — a card maps a device number to a person, so it is admin configuration, never a row a
      // manager or an employee reaches.
      '/admin/card-assignment',
      '/admin/attendance-allowance',
      '/admin/locations',
    ]) {
      expect(gate(href), `${href} stays adminOnly`).toEqual({ adminOnly: true, managerUp: undefined });
    }
    // …and the NODE itself carries no gate of its own — NavNodeGroupDescriptor has no node-level flag,
    // so a mixed node can only ever be per-row. Pinned as data so a future flag cannot slip in unseen.
    expect('adminOnly' in merged || 'managerUp' in merged).toBe(false);
  });

  it('My Attendance carries self-service ONLY — no admin or manager row leaked in', () => {
    // rev2 pulled Records up into the merged menu; rev3 sent it back, because that menu now lives in the
    // group-gated Administration section and a self-service row inside it would render for nobody but
    // administrators. Clock in/out stays first (5249d43f).
    // 0bb0e303 rev2 added the third row, Attendance Request. It is the one row of the three whose gating
    // could plausibly be argued either way — the forms it opens end up in a manager's approvals inbox —
    // so it is pinned here: a gate on it would take the request forms away from the staff who file them,
    // which is the opposite of what the item asked for.
    const mine = NODES.find((n) => n.labelKey === 'myAttendance')!;
    expect(mine.children.map((c) => c.href)).toEqual(SELF_SERVICE_ROWS);
    // The invariant that has held through every regrouping: nothing gated lives in the ungated node.
    expect(mine.children.every((c) => !c.adminOnly && !c.managerUp)).toBe(true);
  });

  it('sidebar.tsx mounts the node via the registry and hardcodes none of the rows', () => {
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    // The registration moved out of the sidebar into packs/register-all.ts (ADR-0077 slice 1) so that
    // SERVER code can enumerate module packs too — a client-component side effect left listPacks()
    // empty on the server. The property under test is unchanged and still end-to-end: the pack is
    // registered, AND the sidebar pulls in the file that registers it. Asserting only the first half
    // would pass with the sidebar importing nothing at all.
    const registerAll = fs.readFileSync(path.resolve(__dirname, '../packs/register-all.ts'), 'utf8');
    expect(registerAll, 'registers the pack (static side-effect import)').toContain(`import '@/packs/attendance'`);
    expect(sidebar, 'sidebar pulls in the shared pack wiring').toContain(`import '@/packs/register-all'`);
    expect(sidebar, 'resolves the node through the registry').toContain(`modulePackById('attendance')`);
    for (const { href } of [...EXPECTED, ...ADDED_SINCE].filter((r) => !movedOutHrefs.includes(r.href))) {
      expect(sidebar.includes(`'${href}'`), `${href} no longer hardcoded in sidebar.tsx`).toBe(false);
    }
    // …and the INVERSE for a row that has left the pack. 4509d2b8's Holidays row is hardcoded in
    // sidebar.tsx ON PURPOSE — it belongs to no pack now, it is a spine screen in the System Settings
    // node — so "not hardcoded" is the wrong assertion for it and "present" is the right one. Written as
    // a positive check rather than an exemption: a MOVED_OUT row that is in neither file is a lost screen.
    for (const { href, to } of MOVED_OUT) {
      expect(sidebar.includes(`'${href}'`), `${href} is hardcoded in sidebar.tsx now — it moved to ${to}`).toBe(true);
    }
  });
});

/**
 * a324a4b3 — each Attendance row is labelled after the screen it opens, and the KEY says so too.
 *
 * WHY THIS FILE AND NOT test/i18n-coverage.test.ts. That guard's check C attributes static t() keys to a
 * namespace, and it only walks `app/` and `components/` — nav rows live in `packs/`, are resolved through
 * a `labelKey` variable rather than a literal t('…'), and the sidebar is a multi-namespace file anyway
 * (check C skips those outright, `test/i18n-coverage.test.ts:84`). So NOTHING in the suite could see a nav
 * row pointing at a key that does not exist, or at one whose string names a different screen. This does.
 *
 * WHAT WENT WRONG, and what these assertions would have caught. R33 (f21d6eee) moved the screens and R17
 * (c9f7211) moved the STRINGS with them, but left the keys: `attendancePolicy` resolved to "Shift
 * settings", `attendancePolicyConfig` to "Attendance policy". Every row rendered correctly and had for
 * three weeks — but the item was raised, planned and sized off a reading of the two key names, and the
 * next reader would either repeat that or "correct" the catalog values to match the keys and break six
 * locales for real. The third test below is the one that pins it: key ≡ its own English label.
 *
 * KNOWN RESIDUAL, deliberately NOT asserted here: /admin/attendance-policy's own PageHeader reads
 * `admin.attendanceRule.moduleTitle` = "Lateness, Early Out & Overtime Settings" (88e94371 landed the rule
 * library on the route R33 had created for the attendance policy), while its nav row reads "Attendance
 * policy" — the name the approved plan pins. Nav row and page header therefore still differ for that one
 * screen. Asserting the pair equal would fail; asserting them unequal would bless it. It is reported
 * instead, because choosing which of the two names wins is a decision for the reporter, not for a rename.
 */
describe('a324a4b3: Attendance nav labels name their screens, in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalog = (loc: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8')) as {
      nav: Record<string, string | undefined>;
    };
  const en = catalog('en');
  // The six admin config rows. Derived by their own adminOnly FLAG since a324a4b3 rev2 merged them
  // into the day-to-day node — there is no longer an 'admin'-group node to look them up by.
  const adminRows = attendancePack
    .navNodes!.find((n) => n.labelKey === 'attendanceSettings')!
    .children.filter((c) => c.adminOnly === true);
  const allRows = attendancePack.navNodes!.flatMap((n) => n.children);

  it('every Attendance row labelKey resolves to a non-empty nav string in every locale', () => {
    for (const loc of LOCALES) {
      const nav = catalog(loc).nav;
      for (const row of allRows) {
        expect(typeof nav[row.labelKey], `${loc}: nav.${row.labelKey} (${row.href})`).toBe('string');
        expect(nav[row.labelKey], `${loc}: nav.${row.labelKey} is blank`).not.toBe('');
      }
    }
  });

  it('the Administration rows read as the screens they open', () => {
    const labels = Object.fromEntries(adminRows.map((r) => [r.href, en.nav[r.labelKey]]));
    expect(labels).toEqual({
      // r274 (2420718d) — the reporter's own name for it. The screen is unchanged and so is its address;
      // what is new is an administrator-gated way in that says what they will find there, because from
      // this node the same screen lists every employee rather than the viewer's own month.
      '/attendance': 'Employee Attendance',
      // 22d67223 (r311) — says what it opens: the breakdown OF attendance, not a report about it.
      '/attendance/breakdown': 'Attendance Breakdown',
      // r314 — the SAME labels their Manage twins carry; two rows for one screen must not read as two
      // different functions.
      '/roster': 'Roster',
      '/attendance/import': 'Import',
      // 4509d2b8 — '/admin/holidays': 'Holidays' used to lead this oracle. The row moved to System
      // Settings; nav.holidays is NOT removed (it labels the row at its new home and the lib/permissions.ts
      // 'holidays' column), it is simply no longer one of THIS node's rows.
      // The shared shift library (R33). This row is the reporter's "Shift Setting" — it exists, and it
      // has said so since R17; only its key still said "attendancePolicy".
      // ad52212d round 1 — plain "Shift": it is a category under a node already called "Attendance
      // settings", and repeating the word inside it is the sprawl the reporter is complaining about.
      '/admin/attendance': 'Shift',
      // 44bc1c33 (r306) — the row says what it opens: the mapping between an employee and the Card /
      // Clocking ID their physical terminal records. Not "Card", which would read as a payment card.
      '/admin/card-assignment': 'Card Assignment',
      // ad52212d round 1 — "Overtime Pattern", the reporter's own name for what this screen already is:
      // a reusable library of hour-banded overtime rates (attendance_rule + attendance_rule_ot_row).
      //
      // ⚠️ 870b79e2 (r277) REVERSED THAT NAME, AND THE REASON IS THE OTHER HALF OF THE TABLE. ad52212d read
      // attendance_rule as an overtime pattern; it is not only that. The same row owns the Lateness and
      // Early Out sections (late_grace_period_minutes, late_after/deduct, and the four early twins) and the
      // screen's own H1 has always said so — "Lateness, Early Out & Overtime Settings". The word OVERTIME
      // alone in the rail is why the reporter spent three items asking us to build a shared, named group of
      // attendance rules that they already owned and were already sharing across four of five shifts. So
      // the row now carries the name THEY use for the object: "Schedule Group". The H1 is unchanged and
      // still carries the literal description; this string is the NAME.
      // ⚠️ e4471e3c (r287) — TWO ENTRIES STOOD HERE AND ARE GONE, and the labels are the clearest record of
      // WHY the reporter asked for the consolidation, so they are written out rather than deleted:
      //
      //     '/admin/attendance-policy': 'Schedule Group'
      //     '/admin/attendance-policy/schedule': 'Work Schedule'
      //
      // Four rows under Attendance carried the word Schedule — Schedule, Schedule Group, Work Schedule
      // and Schedule Assignment — and two of them held settings the Schedule screen already displayed.
      // The uniqueness assertion at the foot of this case was doing real work on exactly that crowding,
      // and the r263 comment it replaced said these two "are expected to READ similarly only until the
      // cutover round decides whether Work Schedule is absorbed". This is that round; it absorbed both.
      // `nav.scheduleGroup` and `nav.workSchedule` are NOT retired from the catalogues — see the orphan
      // case at the foot of this file for which keys are dead and which are still live elsewhere.
      //
      // 1c5602cc (r263) — the KEY is `nav.schedule` and it resolves to "Schedule", the page's own title.
      // a324a4b3's whole lesson: a key that does not equal the string it resolves to is what got this
      // module re-planned off a misreading, so the new row keeps them equal from the first commit.
      '/admin/attendance/schedule': 'Schedule',
      // 0bade264 (r209) — the reporter's own name for the new screen. Both words matter: it is the
      // SCHEDULE (which shift) ASSIGNED (to whom), not another settings category.
      '/admin/attendance/schedule-assignment': 'Schedule Assignment',
      '/admin/attendance-allowance': 'Attendance allowance',
      '/admin/locations': 'Clocking location',
      // 3fb1a611 (r299) — '/admin/toil': 'Time off in lieu' STOOD HERE: the row is RETIRED (a redirect stub to
      // Leave Config › Leave Credit). `nav.timeOffInLieu` stays in the catalogues, unrendered.
    });
    // …and no two rows share a name, which is the other half of what made the menu unreadable.
    expect(new Set(Object.values(labels)).size).toBe(adminRows.length);
  });

  it('THE GUARD: each Administration labelKey is the camelCase of its own English label', () => {
    // A key that drifts from its string is not cosmetic — it is what this item was misdiagnosed from.
    const camel = (s: string) =>
      s
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join('');
    for (const row of adminRows) {
      /**
       * r314 — THE DECLARED PAIRS ARE EXEMPT, and the exemption is the point rather than a hole. These
       * two rows deliberately carry the SAME labelKey as their managerUp twins in Manage, so that one
       * screen reads identically from both menus. `attendanceImport` is the key that pair has always
       * used (its string is "Import", inside an attendance namespace); forcing it to `import` here would
       * either rename the Manage row's key too or split one screen into two names — which is the drift
       * this guard exists to prevent, arrived at from the other direction.
       */
      if (PAIRED_HREFS.includes(row.href)) continue;
      expect(row.labelKey, `${row.href}: key must name its own label`).toBe(camel(en.nav[row.labelKey]!));
    }
    // …and the pairs are checked the way that IS meaningful for them: both menus name the screen the
    // same. Read off the pack directly — this describe has no flattened list of its own.
    for (const href of PAIRED_HREFS) {
      const fromNodes = attendancePack.navNodes!.flatMap((n) => n.children).filter((c) => c.href === href);
      const fromLinks = (attendancePack.navLinks ?? []).filter((l) => l.href === href);
      expect(fromNodes, `${href}: one admin-node entry`).toHaveLength(1);
      expect(fromLinks, `${href}: one Manage entry`).toHaveLength(1);
      expect(fromLinks[0].labelKey, `${href}: both entries must use one label key`).toBe(fromNodes[0].labelKey);
    }
  });

  it('leaves no orphaned nav keys behind, and does not touch the same-named admin namespaces', () => {
    for (const loc of LOCALES) {
      const cat = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      ) as { nav: Record<string, unknown>; admin: Record<string, unknown> };
      expect(cat.nav.attendancePolicyConfig, `${loc}: dead nav.attendancePolicyConfig`).toBeUndefined();
      expect(cat.nav.toilPolicy, `${loc}: dead nav.toilPolicy`).toBeUndefined();
      // ad52212d round 1 retired two more, the same way: renamed in place, not left behind as a second
      // spelling of a live row. nav.attendance SURVIVES — it labels the /attendance Records column in
      // lib/permissions.ts, which is a different screen from this node.
      expect(cat.nav.shiftSettings, `${loc}: dead nav.shiftSettings`).toBeUndefined();
      expect(cat.nav.attendancePolicy, `${loc}: dead nav.attendancePolicy`).toBeUndefined();
      expect(typeof cat.nav.attendance, `${loc}: nav.attendance is still used by the matrix`).toBe('string');
      // 0bade264 (r209) — AND IT MUST NOT SAY THE SAME THING AS THE MENU ABOVE IT, IN ANY LOCALE. This
      // node's label went back to plain "Attendance" at the reporter's request while `nav.attendance`
      // WAS that same word, so the rename only works because that column became "Attendance Records".
      // Translating one half and not the other re-creates the duplicate in that language alone, which
      // i18n-check.mjs cannot see: it checks that a key exists, never that its value was updated.
      expect(
        cat.nav.attendance,
        `${loc}: nav.attendance must not read the same as the Administration menu (nav.attendanceSettings)`,
      ).not.toBe(cat.nav.attendanceSettings);
      // admin.attendancePolicy / admin.toilPolicy are the SCREENS' own namespaces and share the old
      // names by coincidence. Renaming them would blank two pages; this proves they were left alone.
      expect(typeof cat.admin.attendancePolicy, `${loc}: admin.attendancePolicy`).toBe('object');
      expect(typeof cat.admin.toilPolicy, `${loc}: admin.toilPolicy`).toBe('object');
    }
  });
});

describe('ADR-0080 rung 2: service facade re-exports the implementation unchanged', () => {
  it('exposes the exact same function references as the six core modules', () => {
    // One representative per module + the widely-consumed helpers; identity (toBe) proves the
    // facade cannot change behaviour for callers that switched import paths.
    expect(facade.checkIn).toBe(coreAttendance.checkIn);
    expect(facade.checkOut).toBe(coreAttendance.checkOut);
    expect(facade.decideAttendanceCorrection).toBe(coreAttendance.decideAttendanceCorrection);
    expect(facade.isoWeekday).toBe(coreAttendance.isoWeekday);
    expect(facade.setAttendancePolicy).toBe(coreAttendance.setAttendancePolicy);
    expect(facade.evaluateAllowancesForPeriod).toBe(coreAllowance.evaluateAllowancesForPeriod);
    expect(facade.transferAllowancesToBatch).toBe(coreAllowance.transferAllowancesToBatch);
    expect(facade.otByRate).toBe(coreDerive.otByRate);
    expect(facade.statusOf).toBe(coreDerive.statusOf);
    expect(facade.flagOf).toBe(coreDerive.flagOf);
    expect(facade.registerDevice).toBe(coreDevice.registerDevice);
    expect(facade.DeviceNotRegisteredError).toBe(coreDevice.DeviceNotRegisteredError);
    expect(facade.listAttendanceRules).toBe(coreRule.listAttendanceRules);
    expect(facade.listClockingLocations).toBe(coreClockingLocation.listClockingLocations);
    expect(facade.setEmployeeClockingLocations).toBe(coreClockingLocation.setEmployeeClockingLocations);
    expect(facade.setGeofencing).toBe(coreClockingLocation.setGeofencing);
  });

  it('re-exports the ambiguous DayContext type explicitly (compile-time check)', () => {
    // Both core/attendance and core/attendance-derive export DayContext; the facade pins one.
    const ctx: facade.DayContext = 'holiday';
    expect(ctx).toBe('holiday');
  });
});
