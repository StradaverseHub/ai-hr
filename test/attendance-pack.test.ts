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
    { href: '/admin/attendance', labelKey: 'attendancePolicy', icon: CalendarClock, adminOnly: true },
    { href: '/admin/attendance-policy', labelKey: 'attendancePolicyConfig', icon: SlidersHorizontal, adminOnly: true },
    { href: '/admin/attendance-allowance', labelKey: 'attendanceAllowance', icon: HandCoins, adminOnly: true },
    { href: '/admin/locations', labelKey: 'clockingLocation', icon: MapPin, adminOnly: true },
    { href: '/admin/toil', labelKey: 'toilPolicy', icon: Hourglass, adminOnly: true },
    { href: '/roster', labelKey: 'roster', icon: CalendarRange, managerUp: true },
    { href: '/attendance/import', labelKey: 'attendanceImport', icon: FileUp, managerUp: true },
  ] as const;

  // 0bb0e303 split the node three ways, so parity is no longer "one node with ten rows in order".
  // The guarantee that MATTERS survives intact and is what is asserted below: every pre-retrofit row
  // still exists exactly once, with its icon and gates untouched, and the relative order is preserved.
  // Regrouping rows is the visible change the reporter asked for; losing one, or quietly widening a
  // gate while moving it, is not — and only the second kind of change should be able to fail here.
  const NODES = attendancePack.navNodes!;
  const flattened = NODES.flatMap((n) => n.children);

  it('splits into exactly three nodes, one per audience, each in its declared group', () => {
    expect(NODES.map((n) => n.group)).toEqual(['main', 'manage', 'admin']);
    expect(NODES.map((n) => n.labelKey)).toEqual(['myAttendance', 'attendance', 'attendance']);
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
    for (const n of NODES) {
      const positions = n.children.map((c) => wantOrder.indexOf(c.href));
      expect(positions, `${n.group} node keeps pre-retrofit order`).toEqual([...positions].sort((a, b) => a - b));
      expect(positions.every((i) => i >= 0), `${n.group} node has no unknown row`).toBe(true);
    }
  });

  it('THE REGRESSION GUARD: the two managerUp rows stay OUT of the admin node', () => {
    // The Administration sidebar group is gated adminOnly as a WHOLE. A managerUp row placed inside it
    // renders for nobody but admins, silently removing Roster and Import from every manager who can
    // reach them today. That is the one way this split could quietly take access away, so it is pinned.
    const admin = NODES.find((n) => n.group === 'admin')!;
    expect(admin.children.every((c) => c.adminOnly === true)).toBe(true);
    const manage = NODES.find((n) => n.group === 'manage')!;
    expect(manage.children.map((c) => c.href)).toEqual(['/roster', '/attendance/import']);
    expect(manage.children.every((c) => c.managerUp === true)).toBe(true);
  });

  it('My Attendance carries self-service ONLY — no admin or manager row leaked in', () => {
    const mine = NODES.find((n) => n.group === 'main')!;
    expect(mine.children.map((c) => c.href)).toEqual(['/attendance/clock', '/attendance']);
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
