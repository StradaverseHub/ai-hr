/**
 * Attendance nav consolidation guard (items b3dc0f78 + 5cb199b3 + f60cd403).
 *
 * The ticket (5cb199b3) fixes the sidebar's Attendance grouping: the five attendance-config
 * screens — Holidays, Attendance Policy, Attendance Allowance, Locations, Time Off in Lieu —
 * must all live under the single collapsible "Attendance" parent (built by b3dc0f78), in that
 * relative order, each admin-gated, and none of them duplicated elsewhere in the rail.
 *
 * Since ADR-0080 rung 2 the node's rows live on the attendance PACK (packs/attendance/index.ts,
 * `ATTENDANCE_NAV`) and mount into components/sidebar.tsx through the pack registry, so the node
 * checks read the pack source and the no-duplicate checks span BOTH files (a row must appear
 * exactly once across the rail's combined sources). Every assertion below is the pre-rung-2 guard
 * unchanged; only where the node's source text lives moved. Nav parity of the mounting itself is
 * covered in test/attendance-pack.test.ts.
 *
 * Deliberately order-of-SUBSEQUENCE, not adjacency: item e776d17d reserves an "Overtime
 * Configuration" child slot between Clocking Location and TOIL, and future children may be
 * appended, without breaking this guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
const PACK = fs.readFileSync(path.resolve(__dirname, '../packs/attendance/index.ts'), 'utf8');
/** The rail's combined nav sources: hardcoded groups + the registry-mounted attendance node. */
const SRC = SIDEBAR + PACK;

/** The ticket's five relocated screens, in its required relative order. */
const TICKET_HREFS = [
  '/admin/holidays',
  '/admin/attendance',
  '/admin/attendance-allowance',
  '/admin/locations',
  '/admin/toil',
] as const;

/** The ATTENDANCE_NAV literal (packs/attendance/index.ts): declaration to the closing `};`. */
function attendanceNodeBlock(): string {
  const start = PACK.indexOf('const ATTENDANCE_NAV');
  expect(start, 'ATTENDANCE_NAV declaration exists in packs/attendance/index.ts').toBeGreaterThan(-1);
  const end = PACK.indexOf('\n};', start);
  expect(end, 'ATTENDANCE_NAV literal is terminated').toBeGreaterThan(start);
  return PACK.slice(start, end);
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

  it('lists each of the five hrefs exactly once across the rail sources (no duplicate rows left behind)', () => {
    for (const href of TICKET_HREFS) {
      expect(countQuoted(SRC, href), `${href} appears exactly once across sidebar.tsx + packs/attendance/index.ts`).toBe(1);
    }
  });

  // f60cd403: day-to-day rows first, administrative bulk-upload Import always last. (5249d43f inserted
  // Clock in/out ABOVE Records — see the dedicated describe below — so Records now leads the REST.)
  it('keeps Records (/attendance) ahead of the config/roster/import children', () => {
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

// Feedback 5249d43f: the employee-facing "Clock in/out" page is the PRIMARY day-to-day action, so it sits
// FIRST in the Attendance node — above Records — visible to every employee (self-service, like /me).
describe('sidebar Attendance group — Clock in/out first (5249d43f)', () => {
  const node = attendanceNodeBlock();

  it('inserts Clock in/out (/attendance/clock) as the FIRST child of the Attendance node', () => {
    const clockIdx = node.indexOf(`'/attendance/clock'`);
    expect(clockIdx, 'Clock in/out is a child of the Attendance node').toBeGreaterThan(-1);
    const others = [`'/attendance'`, `'/roster'`, `'/attendance/import'`, ...TICKET_HREFS.map((h) => `'${h}'`)];
    for (const q of others) {
      const idx = node.indexOf(q);
      expect(idx, `${q} present`).toBeGreaterThan(-1);
      expect(clockIdx, `Clock in/out precedes ${q}`).toBeLessThan(idx);
    }
  });

  it('keeps Clock in/out visible to every employee (no adminOnly/managerUp gate)', () => {
    const line = node.split('\n').find((l) => l.includes(`'/attendance/clock'`));
    expect(line, 'Clock in/out row exists').toBeDefined();
    expect(line, 'Clock in/out carries no visibility gate').not.toMatch(/adminOnly|managerUp/);
  });

  it('appears exactly once across the rail sources', () => {
    expect(countQuoted(SRC, '/attendance/clock')).toBe(1);
  });

  it('has its nav label in en.json', () => {
    const en = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'),
    ) as { nav: Record<string, string> };
    expect(en.nav.attendanceClock).toBe('Clock in/out');
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
