/**
 * Leave Balance detail relocation (R37 · feedback e5a158d3).
 *
 * "Move Leave Balance detail from My Profile to Leave page." The dense Workday-style detailed balance
 * table (per-type rows via deriveBalanceRow + a per-row EntitlementBreakdown side-sheet + ONE shared
 * as-at-date GET form) used to live on the /me Leave tab; it now lives on the dedicated /leave page. This
 * is a pure RELOCATION — no data/logic change: both the old /me table and the new /leave table read from
 * the SAME source (leaveBalances + leaveEntitlementBreakdown) and derive rows through the SAME pure helper
 * (deriveBalanceRow), so figures/breakdowns/calculations/ESS-visibility are byte-identical to before.
 *
 * DB-free source guard (the suite has no DOM runner): the RSC pages can't be rendered here, so we assert
 * the composition + the source-of-truth wiring + the RSC boundary discipline statically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const leavePage = read('/app/leave/page.tsx');
const mePage = read('/app/me/page.tsx');
// r302 (6c9802c9) — the per-year dashboard read the page now calls, and the island that renders it.
const myLeave = read('/core/my-leave.ts');
const dashboardCmp = read('/components/leave/my-leave-dashboard.tsx');

// ── UPDATED BY r302 (board 6c9802c9), which REVERSES the decision these blocks pinned ─────────────────────────
// The approved My Leave dashboard plan removes the "My balances" card — the LeaveBalanceTable, its shared As-at
// form and its collapsible cookie — and replaces the As-at date with a Year selector. The R37 invariants that
// still hold are kept and repointed rather than deleted: the balance view is the VIEWER's own, from the SAME
// sources (leaveBalances for which types, leaveEntitlementBreakdown for the figures), ESS-gated, with the
// breakdown side-sheet posting back to /leave — and the old all-employee pivot never returns.
describe('R37 e5a158d3 → r302: /leave hosts the viewer’s own balances, now as the per-year dashboard', () => {
  it('the table is gone; the dashboard island renders cards from the server read', () => {
    expect(leavePage).not.toMatch(/<LeaveBalanceTable/);
    expect(leavePage).not.toMatch(/deriveBalanceRow\(/);
    expect(leavePage).toMatch(/<MyLeaveDashboard\s/);
    // UPDATED BY r397: the read moved, unchanged, into the page's loader (app/leave/my-leave-data.ts).
    expect(read('/app/leave/my-leave-data.ts')).toContain('myLeaveDashboard(session, me.employmentId, { today, year: sp.leaveYear, locale })');
    expect(leavePage).toContain('await loadMyLeave({ session, scopeIds, me, sp, locale, today })');
  });

  it('preserves the per-type breakdown side-sheet with ESS gating, posting back to /leave', () => {
    expect(dashboardCmp).toMatch(/<LeaveDetailsPanel/);
    expect(dashboardCmp.includes('applyEssConfig')).toBe(true);
    expect(dashboardCmp).toMatch(/action="\/leave"/);
    // The figures themselves are gated on the server, before they cross to the client.
    expect(myLeave).toContain("shows('available')");
    expect(myLeave).toContain("shows('taken')");
  });

  it('the As-at GET form is replaced by ONE Year GET form (an unknown year ⇒ the current one)', () => {
    expect(leavePage).toMatch(/method="GET"/);
    expect(leavePage).toMatch(/name="leaveYear"/);
    expect(leavePage).not.toMatch(/name="asOf"/);
    expect(leavePage).not.toContain('breakdownAsOf');
    expect(myLeave).toContain('export function resolveSelectedLeaveYear(');
  });
});

describe('R37 e5a158d3: same source, scoped to the viewer (no data change)', () => {
  it('feeds the dashboard from the per-employment leaveBalances + leaveEntitlementBreakdown', () => {
    // /leave uses the VIEWER's own employment — the self-service view, not the admin pivot. r302 moved the two
    // reads into core/my-leave.ts; they are the same reads, per leave year.
    expect(myLeave).toMatch(/leaveBalances\(ctx, employmentId, locale, \{ includeArchived: false \}\)/);
    // UPDATED BY r397: one BATCHED read for every card (leaveEntitlementBreakdowns, core/read.ts), whose items
    // run leaveEntitlementBreakdown's own body — the same source, per card and per year.
    expect(myLeave).toMatch(/leaveEntitlementBreakdowns\(ctx, employmentId, shownPlans\.map\(\(p\) => \(\{ leaveTypeId: p\.storyId, asOf: p\.asOf \}\)\), locale\)/);
    // a7cbd895 (My Absence): the ENTIRE /me Leave tab has since moved to /leave, so /me reads no leave
    // sources at all anymore.
    expect(mePage.includes('leaveBalances(')).toBe(false);
    expect(mePage.includes('leaveEntitlementBreakdown(')).toBe(false);
  });

  it('drops the old all-employee pivot balance view (leaveBalancesAll) from /leave', () => {
    expect(leavePage.includes('leaveBalancesAll')).toBe(false);
    expect(myLeave.includes('leaveBalancesAll')).toBe(false);
    // The hidden default-placement filter is preserved.
    expect(myLeave).toMatch(/\.filter\(\s*\(b\) => b\.placement !== 'hidden',?\s*\)/);
  });
});

describe('R37 e5a158d3: /me no longer renders the detailed table (relocated away)', () => {
  it('removes the LeaveBalanceTable composition + its import from /me', () => {
    expect(mePage.includes('<LeaveBalanceTable')).toBe(false);
    expect(mePage.includes("from '@/components/leave/leave-balance-table'")).toBe(false);
  });
});

describe('R37 e5a158d3: RSC server/client boundary is respected on /leave', () => {
  it('/leave is a server component (no "use client"); the dashboard it renders is the client island', () => {
    expect(leavePage.trimStart().startsWith("'use client'")).toBe(false);
    // UPDATED BY r302: the page calls no row helper any more — the figures come from core/my-leave.ts (server)
    // and the dashboard component is a client island the page RENDERS, never calls.
    expect(dashboardCmp.trimStart().startsWith("'use client'")).toBe(true);
    expect(leavePage).not.toMatch(/MyLeaveDashboard\(/);
    expect(myLeave.trimStart().startsWith("'use client'")).toBe(false);
  });

  it('leave-balance-row.ts (the module the server page CALLS) is not a client module', () => {
    const helper = read('/components/leave/leave-balance-row.ts');
    expect(helper.trimStart().startsWith("'use client'")).toBe(false);
    expect(helper.trimStart().startsWith('"use client"')).toBe(false);
  });
});
