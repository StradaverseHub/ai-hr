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

  it('keeps Records in the SELF-SERVICE node, not the config node (a324a4b3 rev3)', () => {
    // rev2 put Records at the top of the merged menu. rev3 moved that menu into the group-gated
    // Administration section, where a row with no gate of its own renders for nobody but administrators —
    // so Records went back to My Attendance. An employee still finds their own record without passing
    // through anything administrative; it is simply reached from the self-service node again.
    const mine = nodeBlock('MY_ATTENDANCE_NAV');
    expect(mine.indexOf(`{ href: '/attendance',`), 'Records is a child of My Attendance').toBeGreaterThan(-1);
    expect(node.indexOf(`{ href: '/attendance',`), 'Records is NOT in the admin-gated config node').toBe(-1);
    const recordsIdx = mine.indexOf(`{ href: '/attendance',`);
    for (const href of TICKET_HREFS) {
      // The config rows live in the other node entirely now, so "Records comes first" is expressed as
      // "Records is not among them" rather than as a position comparison across two files' worth of text.
      expect(node.indexOf(`'${href}'`), `${href} is a config row`).toBeGreaterThan(-1);
      expect(recordsIdx, 'Records resolved in the self-service node').toBeGreaterThan(-1);
    }
    // …and it carries NO gate. Read from the SELF-SERVICE node, which is where the row now lives.
    const line = mine.split('\n').find((l) => l.includes(`{ href: '/attendance',`));
    expect(line, 'Records row exists').toBeDefined();
    expect(line, 'Records stays visible to every employee').not.toMatch(/adminOnly|managerUp/);
  });

  it('keeps Import (/attendance/import) last in the merged node, still manager-gated', () => {
    // f60cd403: administrative bulk-upload stays last. Import moved to the Manage node with Roster
    // (0bb0e303) and back into the merged node with it (a324a4b3 rev2), so "last" is measured there
    // now — the rule is unchanged, the node is not.
    // rev3 — Roster and Import left the node for flat Manage rows, because the node moved behind the
    // group-level admin gate and both are managerUp. "Import last" is now measured in that link list.
    const links = PACK.slice(PACK.indexOf('const ATTENDANCE_MANAGE_LINKS'));
    const importIdx = links.indexOf(`'/attendance/import'`);
    expect(importIdx, 'Import is a Manage row').toBeGreaterThan(-1);
    const rosterIdx = links.indexOf(`'/roster'`);
    expect(rosterIdx, 'Roster present').toBeGreaterThan(-1);
    expect(node.indexOf(`'/attendance/import'`), 'Import is NOT in the admin-gated node').toBe(-1);
    expect(node.indexOf(`'/roster'`), 'Roster is NOT in the admin-gated node').toBe(-1);
    expect(rosterIdx, 'Roster precedes Import (Import stays last)').toBeLessThan(importIdx);
    // "Last" is measured within the Manage link list now — the config rows are in a different container,
    // so a position comparison against them would compare offsets in unrelated blocks of text.
    expect(links.indexOf(`'/attendance/import'`), 'Import is the last Manage row').toBe(
      Math.max(links.indexOf(`'/attendance/import'`), links.indexOf(`'/roster'`)),
    );

    const line = links.split('\n').find((l) => l.includes(`'/attendance/import'`));
    expect(line, 'Import row exists').toBeDefined();
    expect(line, 'Import keeps managerUp visibility').toMatch(/managerUp:\s*true/);
    const rosterLine = links.split('\n').find((l) => l.includes(`'/roster'`));
    expect(rosterLine, 'Roster keeps managerUp visibility').toMatch(/managerUp:\s*true/);
  });
});

// Feedback 5249d43f: the employee-facing "Clock in/out" page is the PRIMARY day-to-day action, so it sits
// FIRST in the Attendance node — above Records — visible to every employee (self-service, like /me).
describe('sidebar Attendance group — Clock in/out and Records are the staff node (5249d43f)', () => {
  // Clock in/out and Records were the staff node from 0bb0e303; rev2 moved Records into the merged menu;
  // rev3 moved that menu behind the group-level admin gate and so sent Records back. Clock in/out never
  // moved at all. "Clock first" is measured here — and since 0bb0e303 rev2 it is first of THREE, not two:
  // Attendance Request joined them (declared in its own `it` below).
  const node = nodeBlock('MY_ATTENDANCE_NAV');

  it('keeps Clock in/out first, with Records beside it and neither in the config node', () => {
    const clockIdx = node.indexOf(`'/attendance/clock'`);
    const recordsIdx = node.indexOf(`{ href: '/attendance',`);
    expect(clockIdx, 'Clock in/out is a child of My Attendance').toBeGreaterThan(-1);
    expect(recordsIdx, 'Records is a child of My Attendance').toBeGreaterThan(-1);
    expect(clockIdx, 'Clock in/out is still first (5249d43f)').toBeLessThan(recordsIdx);
    // Neither appears in the config node — listed in two places is its own bug, and a self-service row
    // inside the admin-gated node would render for nobody but administrators.
    expect(nodeBlock('ATTENDANCE_NAV').indexOf(`'/attendance/clock'`), 'Clock in/out did NOT move').toBe(-1);
    expect(nodeBlock('ATTENDANCE_NAV').indexOf(`{ href: '/attendance',`), 'Records is not in config').toBe(-1);
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

  // 0bb0e303 rev2 — the third staff row. DECLARED here rather than letting the assertions above simply
  // tolerate it: this guard's whole value is that the membership of the self-service node is written
  // down, so a row that arrives without a line here is still a failure.
  it('carries Attendance Request THIRD, ungated, exactly once across the rail', () => {
    const clockIdx = node.indexOf(`'/attendance/clock'`);
    const recordsIdx = node.indexOf(`{ href: '/attendance',`);
    const requestsIdx = node.indexOf(`'/attendance/requests'`);
    expect(requestsIdx, 'Attendance Request is a child of My Attendance').toBeGreaterThan(-1);
    expect(clockIdx, 'Clock in/out still precedes it').toBeLessThan(requestsIdx);
    expect(recordsIdx, 'Records still precedes it').toBeLessThan(requestsIdx);

    // NOT in the config node: that node sits in the group-gated Administration section, where a
    // self-service row renders for administrators and nobody else — which for a request form staff are
    // meant to file themselves would be a silent removal, not a menu tidy-up.
    expect(nodeBlock('ATTENDANCE_NAV').indexOf(`'/attendance/requests'`), 'not in the config node').toBe(-1);

    const line = node.split('\n').find((l) => l.includes(`'/attendance/requests'`));
    expect(line, 'Attendance Request row exists').toBeDefined();
    expect(line, 'Attendance Request carries no visibility gate').not.toMatch(/adminOnly|managerUp/);
    expect(line, 'labelled by the new nav key').toContain(`labelKey: 'attendanceRequest'`);

    expect(countQuoted(SRC, '/attendance/requests')).toBe(1);
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
