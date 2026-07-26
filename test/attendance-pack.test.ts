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

  const nav = attendancePack.nav!;

  it('keeps the parent node identical (nav.attendance label, Clock icon)', () => {
    expect(nav.labelKey).toBe('attendance');
    expect(nav.icon).toBe(Clock);
  });

  it('carries exactly the pre-retrofit rows, in order, with identical icon refs and gates', () => {
    expect(nav.children).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want, i) => {
      const got = nav.children[i];
      expect(got.href, `row ${i} href`).toBe(want.href);
      expect(got.labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got.icon, `${want.href} icon ref`).toBe(want.icon);
      expect(got.adminOnly, `${want.href} adminOnly`).toBe('adminOnly' in want ? want.adminOnly : undefined);
      expect(got.managerUp, `${want.href} managerUp`).toBe('managerUp' in want ? want.managerUp : undefined);
    });
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
