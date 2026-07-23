/**
 * Personnel relocation guard (item 1b35f17b).
 *
 * The ticket relocates the "Personnel" employee directory out of the top-level menu into the
 * "Manage" section of the sidebar (Manage → Personnel). Nothing else moves: the /personnel route,
 * its guard, and all employee data are unchanged; the separate /admin/personnel entry stays in the
 * Admin group. Visibility is preserved: Personnel remains visible to every employee (no per-row
 * flag), while Approvals/Performance stay manager-up.
 *
 * `GROUPS` is a module-private const in a `'use client'` component, so — per the established
 * precedent (test/sidebar-attendance-group.test.ts) — this is a lightweight source-text check on
 * components/sidebar.tsx rather than an import (no need to render next-intl/lucide in a node test).
 *
 * Since ADR-0080 rung 4 the Performance row lives on the performance PACK
 * (packs/performance/index.ts, `PERFORMANCE_NAV_LINKS`) and mounts into the Manage group through
 * the pack registry (referenced as PERFORMANCE_ROW), so the row checks read the rail's COMBINED
 * sources. Every assertion below is the pre-rung-4 guard unchanged; only where the row's source
 * text lives moved. Nav parity of the mounting itself is covered in test/performance-pack.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
const PACK = fs.readFileSync(path.resolve(__dirname, '../packs/performance/index.ts'), 'utf8');
/** The rail's combined nav sources: hardcoded groups + the registry-mounted performance row. */
const SRC = SIDEBAR + PACK;

/** Count occurrences of the QUOTED href so '/personnel' does not match '/admin/personnel'. */
const countQuoted = (haystack: string, href: string) => haystack.split(`'${href}'`).length - 1;

/** Slice of sidebar source between two `labelKey: '<key>'` group markers (end exclusive). */
function groupBlock(startKey: string, endKey: string): string {
  const start = SIDEBAR.indexOf(`labelKey: '${startKey}'`);
  expect(start, `${startKey} group exists`).toBeGreaterThan(-1);
  const end = SIDEBAR.indexOf(`labelKey: '${endKey}'`, start + 1);
  expect(end, `${endKey} group exists after ${startKey}`).toBeGreaterThan(start);
  return SIDEBAR.slice(start, end);
}

describe('sidebar Personnel relocation (1b35f17b)', () => {
  it('lists /personnel exactly once (single nav row, no duplicate left in the top group)', () => {
    expect(countQuoted(SRC, '/personnel')).toBe(1);
  });

  it('places /personnel inside the Manage group (not the top-level menu)', () => {
    const manage = groupBlock('manage', 'admin');
    expect(manage).toContain(`'/personnel'`);
  });

  it('keeps /personnel visible to all employees (no adminOnly/managerUp flag on its row)', () => {
    const line = SRC.split('\n').find((l) => l.includes(`'/personnel'`));
    expect(line, 'personnel row exists').toBeDefined();
    expect(line).not.toMatch(/adminOnly:\s*true/);
    expect(line).not.toMatch(/managerUp:\s*true/);
  });

  it('gates Approvals and Performance manager-up now that the Manage group flag is dropped', () => {
    for (const href of ['/approvals', '/performance']) {
      const line = SRC.split('\n').find((l) => l.includes(`'${href}'`));
      expect(line, `${href} row exists`).toBeDefined();
      expect(line, `${href} keeps manager-up visibility`).toMatch(/managerUp:\s*true/);
    }
  });

  // ADR-0080 rung 4: the Performance row moved onto the performance pack and mounts by const
  // reference (PERFORMANCE_ROW) — so it is asserted by position here, keeping the group-shape
  // guard whole. Row content parity is test/performance-pack.test.ts.
  it('keeps the performance row (PERFORMANCE_ROW) in the Manage group after Approvals', () => {
    const manage = groupBlock('manage', 'admin');
    const approvals = manage.indexOf(`'/approvals'`);
    const perfRef = manage.indexOf('PERFORMANCE_ROW');
    expect(approvals, '/approvals row exists in the Manage group').toBeGreaterThan(-1);
    expect(perfRef, 'PERFORMANCE_ROW is referenced after /approvals').toBeGreaterThan(approvals);
  });

  it('leaves the /admin/personnel entry untouched in the Admin group', () => {
    expect(countQuoted(SRC, '/admin/personnel')).toBe(1);
    // Everything after the Admin group marker to the end of the GROUPS array.
    const adminIdx = SIDEBAR.indexOf(`labelKey: 'admin'`);
    expect(SIDEBAR.indexOf(`'/admin/personnel'`)).toBeGreaterThan(adminIdx);
  });
});
