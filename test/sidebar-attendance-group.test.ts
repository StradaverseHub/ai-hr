/**
 * Attendance nav consolidation guard (items b3dc0f78 + 5cb199b3 + f60cd403).
 *
 * The ticket (5cb199b3) fixes the sidebar's Attendance grouping: the five attendance-config
 * screens — Holidays, Attendance Policy, Attendance Allowance, Locations, Time Off in Lieu —
 * must all live under the single collapsible "Attendance" parent (built by b3dc0f78), in that
 * relative order, each admin-gated, and none of them duplicated elsewhere in the rail.
 *
 * Since ADR-0080 rung 2 the node's rows live on the attendance PACK (packs/attendance/index.ts) and
 * mount into components/sidebar.tsx through the pack registry, so the node checks read the pack source
 * and the no-duplicate checks span BOTH files (a row must appear exactly once across the rail's
 * combined sources).
 *
 * 0bb0e303 then split the ONE node into three by audience — MY_ATTENDANCE_NAV (staff),
 * ATTENDANCE_MANAGE_NAV (roster + import), ATTENDANCE_ADMIN_NAV (the five config screens) — and
 * a324a4b3 rev2 merged the manager and admin nodes back into a single `ATTENDANCE_NAV`, which is the
 * literal this guard reads again. MY_ATTENDANCE_NAV survives, carrying Clock in/out alone.
 *
 * WHAT SURVIVES BOTH MOVES, and is what is asserted below: the five config screens still travel
 * TOGETHER in one node, in the ticket's order, each still admin-gated, and every row still appears
 * exactly once across the rail. Those were the ticket's actual guarantees, and the merge restores the
 * one thing the split had cost — "Records precedes the config rows WITHIN one node" is true again and
 * is re-asserted below, alongside the full screenshot order in test/attendance-pack.test.ts.
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

/** One of the node literals (packs/attendance/index.ts): declaration to the closing `};`. */
function nodeBlock(constName: string): string {
  const start = PACK.indexOf(`const ${constName}`);
  expect(start, `${constName} declaration exists in packs/attendance/index.ts`).toBeGreaterThan(-1);
  const end = PACK.indexOf('\n};', start);
  expect(end, `${constName} literal is terminated`).toBeGreaterThan(start);
  return PACK.slice(start, end);
}

/** Count occurrences of the QUOTED href so '/admin/attendance' does not match its '-allowance' sibling. */
const countQuoted = (haystack: string, href: string) =>
  haystack.split(`'${href}'`).length - 1;

describe('sidebar Attendance group (5cb199b3 consolidation, after the a324a4b3 rev2 re-merge)', () => {
  // The five config screens moved WHOLESALE into the merged node — that is the node this guard follows.
  const node = nodeBlock('ATTENDANCE_NAV');

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

  it('keeps the five config screens TOGETHER — none leaked into the My Attendance node', () => {
    // The consolidation ticket's real guarantee: an administrator finds all five in one place. Both the
    // split and the re-merge moved the node they live in; neither may have scattered them across nodes.
    // ATTENDANCE_MANAGE_NAV is gone (a324a4b3 rev2 merged it in), so the only other node is the staff one.
    const staff = nodeBlock('MY_ATTENDANCE_NAV');
    expect(PACK, 'the manager node was merged away, not left behind as a third copy').not.toContain(
      'const ATTENDANCE_MANAGE_NAV',
    );
    expect(PACK, 'the admin node was merged away, not left behind as a third copy').not.toContain(
      'const ATTENDANCE_ADMIN_NAV',
    );
    for (const href of TICKET_HREFS) {
      expect(staff.indexOf(`'${href}'`), `${href} is NOT in My Attendance`).toBe(-1);
    }
  });

  it('restores Records above the config rows inside the one node (a324a4b3 rev2)', () => {
    // The guarantee the 0bb0e303 split had to give up and the merge gives back: an employee opening
    // Attendance finds their own Records first, before any administrative screen.
    const recordsIdx = node.indexOf(`{ href: '/attendance',`);
    expect(recordsIdx, 'Records is a child of the merged node').toBeGreaterThan(-1);
    for (const href of TICKET_HREFS) {
      expect(recordsIdx, `Records precedes ${href}`).toBeLessThan(node.indexOf(`'${href}'`));
    }
    // …and it carries NO gate: merging it in among adminOnly siblings must not have caught one.
    const line = node.split('\n').find((l) => l.includes(`{ href: '/attendance',`));
    expect(line, 'Records row exists').toBeDefined();
    expect(line, 'Records stays visible to every employee').not.toMatch(/adminOnly|managerUp/);
  });

  it('keeps Import (/attendance/import) last in the merged node, still manager-gated', () => {
    // f60cd403: administrative bulk-upload stays last. Import moved to the Manage node with Roster
    // (0bb0e303) and back into the merged node with it (a324a4b3 rev2), so "last" is measured there
    // now — the rule is unchanged, the node is not.
    const importIdx = node.indexOf(`'/attendance/import'`);
    expect(importIdx, 'Import is a child of the merged node').toBeGreaterThan(-1);
    const rosterIdx = node.indexOf(`'/roster'`);
    expect(rosterIdx, 'Roster present').toBeGreaterThan(-1);
    expect(rosterIdx, 'Roster precedes Import (Import stays last)').toBeLessThan(importIdx);
    // Last means last: every other row of the node precedes Import.
    for (const href of TICKET_HREFS) {
      expect(node.indexOf(`'${href}'`), `${href} precedes Import`).toBeLessThan(importIdx);
    }

    const line = node.split('\n').find((l) => l.includes(`'/attendance/import'`));
    expect(line, 'Import row exists').toBeDefined();
    expect(line, 'Import keeps managerUp visibility').toMatch(/managerUp:\s*true/);
    const rosterLine = node.split('\n').find((l) => l.includes(`'/roster'`));
    expect(rosterLine, 'Roster keeps managerUp visibility').toMatch(/managerUp:\s*true/);
  });
});

// Feedback 5249d43f: the employee-facing "Clock in/out" page is the PRIMARY day-to-day action, so it sits
// FIRST in the Attendance node — above Records — visible to every employee (self-service, like /me).
describe('sidebar Attendance group — Clock in/out stays in My Attendance (5249d43f)', () => {
  // Clock in/out and Records were the staff node from 0bb0e303; a324a4b3 rev2 moved Records into the
  // merged Attendance menu and Clock in/out stayed. The "clock first" rule is measured here still —
  // INVERTED from "first of two" to "the node's only row", which is what first now means.
  const node = nodeBlock('MY_ATTENDANCE_NAV');

  it('keeps Clock in/out (/attendance/clock) as the staff node’s row, Records having moved out', () => {
    const clockIdx = node.indexOf(`'/attendance/clock'`);
    expect(clockIdx, 'Clock in/out is a child of My Attendance').toBeGreaterThan(-1);
    // The reporter's screenshot omits Clock in/out, so it was NOT folded into the merged menu; and
    // Records was pulled out of here, so it must not still be listed in both places.
    expect(node.indexOf(`{ href: '/attendance',`), 'Records moved to the merged node').toBe(-1);
    expect(nodeBlock('ATTENDANCE_NAV').indexOf(`'/attendance/clock'`), 'Clock in/out did NOT move').toBe(-1);
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
