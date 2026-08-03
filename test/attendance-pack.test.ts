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
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Clock,
  FileUp,
  HandCoins,
  Hourglass,
  MapPin,
  SlidersHorizontal,
} from 'lucide-react';
import { attendancePack } from '../packs/attendance';
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

describe('ADR-0080 rung 2: nav parity with the pre-retrofit sidebar', () => {
  // components/sidebar.tsx ATTENDANCE_NODE as of the commit before rung 2, captured VERBATIM
  // (b3dc0f78 consolidation + 5cb199b3 + f60cd403 order + 5249d43f clock-first). This is the
  // pixel/behaviour-parity oracle: same rows, same order, same icon refs, same gates.
  const EXPECTED = [
    { href: '/attendance/clock', labelKey: 'attendanceClock', icon: Clock },
    { href: '/attendance', labelKey: 'attendanceRecords', icon: Clock },
    { href: '/admin/holidays', labelKey: 'holidays', icon: CalendarDays, adminOnly: true },
    // a324a4b3 renamed three labelKeys so each names the screen it opens. The rendered STRINGS are
    // unchanged (they were already right — R17 c9f7211), so this stays a parity oracle: only the key
    // spelling moved. attendancePolicy → shiftSettings, attendancePolicyConfig → attendancePolicy,
    // toilPolicy → timeOffInLieu. The strings themselves are pinned in the describe block below.
    { href: '/admin/attendance', labelKey: 'shiftSettings', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-policy', labelKey: 'attendancePolicy', icon: SlidersHorizontal, adminOnly: true },
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    { href: '/admin/toil', labelKey: 'timeOffInLieu', icon: Hourglass, adminOnly: true },
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true },
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true },
  ] as const;

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
    expect(NODES.map((n) => n.labelKey)).toEqual(['myAttendance', 'attendance']);
    // rev2 had both in 'main' because the merged node mixed three gates. rev3 is the reporter's own
    // correction — the CONFIG menu belongs in Administration between Leave config and Claims config — and
    // it is only safe there because the mixed rows moved out first. See the regression guard below.
    expect(NODES.map((n) => n.group)).toEqual(['main', 'admin']);
    // The two managerUp rows are flat Manage rows now, not children of anything.
    expect(MANAGE_LINKS.map((l) => l.href).sort()).toEqual(['/attendance/import', '/roster']);
  });

  it('orders the Attendance CONFIG menu as the reporter listed the settings', () => {
    const merged = NODES.find((n) => n.labelKey === 'attendance')!;
    // Six rows, all config, all adminOnly. Records / Roster / Import are no longer here — see rev3.
    expect(merged.children.map((c) => c.href)).toEqual([
      '/admin/holidays',
      '/admin/attendance', // Shift settings
      '/admin/attendance-policy',
      '/admin/attendance-allowance',
      '/admin/locations', // Clocking location
      '/admin/toil', // Time off in lieu
    ]);
    // Self-service keeps Clock in/out first (5249d43f) with Records beside it.
    const mine = NODES.find((n) => n.labelKey === 'myAttendance')!;
    expect(mine.children.map((c) => c.href)).toEqual(['/attendance/clock', '/attendance']);
  });

  it('keeps every pre-retrofit row exactly once, with identical icon refs and gates', () => {
    expect(flattened).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want) => {
      const got = flattened.filter((c) => c.href === want.href);
      expect(got, `${want.href} appears exactly once`).toHaveLength(1);
      expect(got[0].labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got[0].icon, `${want.href} icon ref`).toBe(want.icon);
      expect(got[0].adminOnly, `${want.href} adminOnly`).toBe('adminOnly' in want ? want.adminOnly : undefined);
      expect(got[0].managerUp, `${want.href} managerUp`).toBe('managerUp' in want ? want.managerUp : undefined);
    });
  });

  it('preserves the pre-retrofit relative order WITHIN each node', () => {
    // Rows may land in different nodes, but a row that came before another must not come after it now.
    // Asserted per node, because across nodes the order is the sidebar's group layout, not the pack's.
    // Widened to string[]: EXPECTED is `as const`, so map() yields a union of the ten literal hrefs
    // and indexOf() then refuses a plain string. The comparison is by position, not by literal type.
    const wantOrder: string[] = EXPECTED.map((r) => r.href);
    for (const container of [...NODES.map((n) => ({ name: n.group, rows: n.children })), { name: 'navLinks', rows: MANAGE_LINKS }]) {
      const positions = container.rows.map((c) => wantOrder.indexOf(c.href));
      expect(positions, `${container.name} keeps pre-retrofit order`).toEqual([...positions].sort((a, b) => a - b));
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
    const merged = NODES.find((n) => n.labelKey === 'attendance')!;
    const gate = (href: string) => {
      const c = merged.children.find((x) => x.href === href)!;
      return { adminOnly: c.adminOnly, managerUp: c.managerUp };
    };
    // rev3 — Records and the two managerUp rows LEFT this node, so their gates are checked at their new
    // homes. Records must still carry none, and Roster/Import must still be managerUp: a move that
    // widened or narrowed either would be the silent permissions change this whole item risks.
    const mine = NODES.find((n) => n.labelKey === 'myAttendance')!;
    const records = mine.children.find((c) => c.href === '/attendance')!;
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
    for (const href of [
      '/admin/holidays',
      '/admin/attendance',
      '/admin/attendance-policy',
      '/admin/attendance-allowance',
      '/admin/locations',
      '/admin/toil',
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
    const mine = NODES.find((n) => n.labelKey === 'myAttendance')!;
    expect(mine.children.map((c) => c.href)).toEqual(['/attendance/clock', '/attendance']);
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
    for (const { href } of EXPECTED) {
      expect(sidebar.includes(`'${href}'`), `${href} no longer hardcoded in sidebar.tsx`).toBe(false);
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
    .navNodes!.find((n) => n.labelKey === 'attendance')!
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
      '/admin/holidays': 'Holidays',
      // The shared shift library (R33). This row is the reporter's "Shift Setting" — it exists, and it
      // has said so since R17; only its key still said "attendancePolicy".
      '/admin/attendance': 'Shift settings',
      '/admin/attendance-policy': 'Attendance policy',
      '/admin/attendance-allowance': 'Attendance allowance',
      '/admin/locations': 'Clocking location',
      // Plain words, not the TOIL abbreviation — and the same words the screen's own title uses.
      '/admin/toil': 'Time off in lieu',
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
      expect(row.labelKey, `${row.href}: key must name its own label`).toBe(camel(en.nav[row.labelKey]!));
    }
  });

  it('leaves no orphaned nav keys behind, and does not touch the same-named admin namespaces', () => {
    for (const loc of LOCALES) {
      const cat = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      ) as { nav: Record<string, unknown>; admin: Record<string, unknown> };
      expect(cat.nav.attendancePolicyConfig, `${loc}: dead nav.attendancePolicyConfig`).toBeUndefined();
      expect(cat.nav.toilPolicy, `${loc}: dead nav.toilPolicy`).toBeUndefined();
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
