/**
 * Attendance nav consolidation guard (items b3dc0f78 + 5cb199b3 + f60cd403).
 *
 * The ticket (5cb199b3) fixes the sidebar's Attendance grouping: the five attendance-config
 * screens — Holidays, Attendance Policy, Attendance Allowance, Locations, Time Off in Lieu —
 * must all live under the single collapsible "Attendance" parent (built by b3dc0f78), in that
 * relative order, each admin-gated, and none of them duplicated elsewhere in the rail.
 *
 * `GROUPS` / `ATTENDANCE_NODE` are module-private consts in a `'use client'` component, so —
 * per the approved plan's alternative — this is a lightweight source-text check on
 * components/sidebar.tsx rather than an import (no behavior change to the component, and no
 * need to render next-intl/lucide in a node test).
 *
 * Deliberately order-of-SUBSEQUENCE, not adjacency: item e776d17d reserves an "Overtime
 * Configuration" child slot between Clocking Location and TOIL, and future children may be
 * appended, without breaking this guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');

/** The ticket's five relocated screens, in its required relative order. */
const TICKET_HREFS = [
  '/admin/holidays',
  '/admin/attendance',
  '/admin/attendance-allowance',
  '/admin/locations',
  '/admin/toil',
] as const;

/** The ATTENDANCE_NODE literal: from its declaration to the closing `};`. */
function attendanceNodeBlock(): string {
  const start = SRC.indexOf('const ATTENDANCE_NODE');
  expect(start, 'ATTENDANCE_NODE declaration exists in sidebar.tsx').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n};', start);
  expect(end, 'ATTENDANCE_NODE literal is terminated').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** Count occurrences of the QUOTED href so '/admin/attendance' does not match its '-allowance' sibling. */
const countQuoted = (haystack: string, href: string) =>
  haystack.split(`'${href}'`).length - 1;

describe('sidebar Attendance group (5cb199b3 consolidation)', () => {
  const node = attendanceNodeBlock();

  it('keeps the parent labelled with the existing nav.attendance key', () => {
    expect(node).toMatch(/labelKey:\s*'attendance'/);
  });

  it('contains all five ticket screens as children, in the ticket order', () => {
    const positions = TICKET_HREFS.map((href) => {
      const idx = node.indexOf(`'${href}'`);
      expect(idx, `${href} is a child of the Attendance node`).toBeGreaterThan(-1);
      return idx;
    });
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions, 'children follow the ticket order (Holidays → Policy → Allowance → Locations → TOIL)').toEqual(sorted);
  });

  it('admin-gates each of the five children (permissions unchanged by the move)', () => {
    for (const href of TICKET_HREFS) {
      const line = node.split('\n').find((l) => l.includes(`'${href}'`));
      expect(line, `child row for ${href}`).toBeDefined();
      expect(line, `${href} keeps adminOnly visibility`).toMatch(/adminOnly:\s*true/);
    }
  });

  it('lists each of the five hrefs exactly once across the whole sidebar (no duplicate rows left behind)', () => {
    for (const href of TICKET_HREFS) {
      expect(countQuoted(SRC, href), `${href} appears exactly once in sidebar.tsx`).toBe(1);
    }
  });

  // f60cd403: day-to-day Records first, administrative bulk-upload Import always last.
  it('keeps Records (/attendance) as the first child of the Attendance node', () => {
    const first = node.indexOf(`'/attendance'`);
    expect(first, 'Records is a child of the Attendance node').toBeGreaterThan(-1);
    const others = ["'/attendance/import'", "'/roster'", ...TICKET_HREFS.map((h) => `'${h}'`)];
    for (const q of others) {
      const idx = node.indexOf(q);
      expect(idx, `${q} present`).toBeGreaterThan(-1);
      expect(first, `Records precedes ${q}`).toBeLessThan(idx);
    }
  });

  it('keeps Import (/attendance/import) as the last child of the Attendance node', () => {
    const importIdx = node.indexOf(`'/attendance/import'`);
    expect(importIdx, 'Import is a child of the Attendance node').toBeGreaterThan(-1);
    // Every other quoted href in the node appears before Import.
    const others = [`'/attendance'`, `'/roster'`, ...TICKET_HREFS.map((h) => `'${h}'`)];
    for (const q of others) {
      const idx = node.indexOf(q);
      expect(idx, `${q} present`).toBeGreaterThan(-1);
      expect(idx, `${q} precedes Import (Import stays last)`).toBeLessThan(importIdx);
    }
  });

  it('keeps the Import row manager-gated (permissions unchanged by the reorder)', () => {
    const line = node.split('\n').find((l) => l.includes(`'/attendance/import'`));
    expect(line, 'Import row exists').toBeDefined();
    expect(line, 'Import keeps managerUp visibility').toMatch(/managerUp:\s*true/);
  });
});

describe('sidebar Attendance labels (f60cd403 rename)', () => {
  const en = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'),
  ) as { nav: Record<string, string> };

  it('renames Attendance record → Records', () => {
    expect(en.nav.attendanceRecords).toBe('Records');
  });

  it('renames Attendance import → Import', () => {
    expect(en.nav.attendanceImport).toBe('Import');
  });
});
