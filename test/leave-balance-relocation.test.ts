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

describe('R37 e5a158d3: /leave now hosts the detailed balance table', () => {
  it('renders LeaveBalanceTable derived through the shared deriveBalanceRow helper', () => {
    expect(leavePage).toMatch(/<LeaveBalanceTable/);
    expect(leavePage).toMatch(/deriveBalanceRow\(b, bd \?\? null\)/);
  });

  it('preserves the per-row EntitlementBreakdown side-sheet with ESS gating', () => {
    expect(leavePage).toMatch(/<EntitlementBreakdown/);
    expect(leavePage.includes('applyEssConfig')).toBe(true);
    // The breakdown's as-at form posts back to /leave (not /me).
    expect(leavePage).toMatch(/action="\/leave"/);
  });

  it('drives every row from ONE shared ?asOf= GET form (invalid/empty ⇒ today)', () => {
    expect(leavePage).toMatch(/method="GET"/);
    expect(leavePage).toMatch(/name="asOf"/);
    expect(leavePage).toMatch(/breakdownAsOf = sp\.asOf && \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(sp\.asOf\) \? sp\.asOf : today/);
  });
});

describe('R37 e5a158d3: same source, scoped to the viewer (no data change)', () => {
  it('feeds the table from the per-employment leaveBalances + leaveEntitlementBreakdown (same as /me used)', () => {
    // /leave uses the VIEWER's own employment — the self-service detailed view, not the admin pivot.
    expect(leavePage).toMatch(/leaveBalances\(session, me\.employmentId, locale\)/);
    expect(leavePage).toMatch(/leaveEntitlementBreakdown\(session, me\.employmentId, b\.leaveTypeId, breakdownAsOf, locale\)/);
    // a7cbd895 (My Absence): the ENTIRE /me Leave tab has since moved to /leave, so /me reads no leave
    // sources at all anymore — the /leave reads above are now the single self-service source.
    expect(mePage.includes('leaveBalances(')).toBe(false);
    expect(mePage.includes('leaveEntitlementBreakdown(')).toBe(false);
  });

  it('drops the old all-employee pivot balance view (leaveBalancesAll) from /leave', () => {
    expect(leavePage.includes('leaveBalancesAll')).toBe(false);
    // The hidden default-placement filter is preserved (mirrors /me detailedBalances).
    expect(leavePage).toMatch(/selfBalances\.filter\(\(b\) => b\.placement !== 'hidden'\)/);
  });
});

describe('R37 e5a158d3: /me no longer renders the detailed table (relocated away)', () => {
  it('removes the LeaveBalanceTable composition + its import from /me', () => {
    expect(mePage.includes('<LeaveBalanceTable')).toBe(false);
    expect(mePage.includes("from '@/components/leave/leave-balance-table'")).toBe(false);
  });
});

describe('R37 e5a158d3: RSC server/client boundary is respected on /leave', () => {
  it('/leave is a server component (no "use client") that imports deriveBalanceRow from the server-safe module', () => {
    expect(leavePage.trimStart().startsWith("'use client'")).toBe(false);
    // The pure helper must come from leave-balance-row (NON-'use client'), never the client table.
    expect(leavePage).toMatch(/import \{ deriveBalanceRow \} from '@\/components\/leave\/leave-balance-row'/);
  });

  it('leave-balance-row.ts (the module the server page CALLS) is not a client module', () => {
    const helper = read('/components/leave/leave-balance-row.ts');
    expect(helper.trimStart().startsWith("'use client'")).toBe(false);
    expect(helper.trimStart().startsWith('"use client"')).toBe(false);
  });
});
