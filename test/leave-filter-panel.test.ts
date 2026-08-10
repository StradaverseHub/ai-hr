/**
 * Advanced Search & Filter for Leave Management (feedback 0773bda9) — static-source guard.
 *
 * afd0a87c RE-SCOPED THIS FILE. It guarded the admin /leave surface's global search bar, consolidated
 * filter panel, sortable headers, pager and CSV/Excel export — all of which belonged to the ORG-WIDE
 * REQUEST TABLE, which the reporter has since asked to remove outright. What survives on that page is the
 * Employee Details listing, which has a filter panel of its OWN (employeeFilterFields), and the
 * FilterPanel component both used.
 *
 * So the two halves that still have a subject are kept and re-pointed: the component's multi-select /
 * accessibility contract, and the surviving listing's use of it. The request-table half is inverted into
 * a removal guard — a half-removed table leaves a read running for nobody, which is the expensive half.
 * The export route it fed is deleted, so its describe block goes with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('leave filter panel: the HR-admin Employee Details surface', () => {
  // REPOINTED BY 388e53c2. The listing this block is about did not change — it MOVED, from /leave to the
  // Team Leave Tracker route, because the sidebar lights a row by path prefix and every /leave/* screen
  // kept "My Leave" lit while an administrator read somebody else's leave record. So the panel assertions
  // follow the panel, and /leave is asserted to have kept none of it.
  const src = read('app/leave/tracker/page.tsx');
  const leavePage = read('app/leave/page.tsx');

  it('still imports FilterPanel + FilterChips — the Employee Details listing uses them', () => {
    expect(src).toMatch(/import\s*\{[^}]*FilterPanel[^}]*\}\s*from\s*'@\/components\/filter-panel'/);
    expect(src).toMatch(/FilterChips/);
    expect(src.includes('fields={employeeFilterFields}')).toBe(true);
  });

  it('THE PANEL POSTS BACK TO ITS OWN PAGE — a form left on /leave silently leaves the screen', () => {
    // The trap in the lift, and the one no type checker sees: the search form, the FilterPanel and the
    // FilterChips row each hardcoded `action="/leave"`. Carried over unchanged, pressing Search or
    // applying a filter would throw an administrator off the screen they are working on.
    expect(src.match(/action="\/leave\/tracker"/g) ?? []).toHaveLength(3);
    expect(src).not.toMatch(/action="\/leave"/);
  });

  it('the org-wide read is gone, and the self-service read is NOT', () => {
    // The expensive half of a half-removal is a read still running for a table nobody renders.
    //
    // Asserted on the CALL and the IMPORT, not on the bare name: the page legitimately NAMES
    // listLeaveRequestsPage in a comment explaining where the retired filter vocabularies still live, and
    // a substring check would flag that prose as a regression. Same trap as r134's `tList(` and r135's
    // LEAVE_CONFIG_ROW — a guard that reports correct code as wrong is worse than no guard.
    expect(leavePage).not.toContain('listLeaveRequestsPage(session');
    expect(leavePage).not.toMatch(/^\s*listLeaveRequestsPage,\s*$/m);
    // The employee's own history still loads — /leave is still their My Absence home.
    expect(leavePage.includes('listLeaveRequests(session, scopeIds)')).toBe(true);
    // And the listing that replaced it as the admin's landing view survives, at its new address.
    expect(src.includes('listEmployeesPage(s, {')).toBe(true);
    expect(leavePage.includes('listEmployeesPage'), 'the listing must not be left behind too').toBe(false);
  });

  it('the Employee Details panel is still admin-gated and still multi-select', () => {
    // The gate moved from a `{admin && (…)}` block to an EARLY RETURN on the same predicate, which is
    // strictly stronger: it suppresses the READS as well as the markup.
    expect(src.includes('isAdmin(s)')).toBe(true);
    expect(src).toMatch(/if \(admin\) \{/);
    expect(src.includes("kind: 'multi'")).toBe(true);
  });

  it('the retired request table takes its whole query contract with it', () => {
    // INVERTED from "preserves the full searchParams contract". Declaring a param nothing reads advertises
    // a filter that silently does nothing; a saved link carrying one now simply arrives unfiltered, which
    // the approved plan discloses. Asserted on the DECLARATION, so a re-added param without a reader fails.
    for (const param of [
      'q?: string',
      'company?: string',
      'bu?: string',
      'dept?: string',
      'loc?: string',
      'duration?: string',
      'appliedFrom?: string',
      'appliedTo?: string',
      'approvedBy?: string',
      'pendingWith?: string',
      'sort?: string',
      'dir?: string',
    ]) {
      expect(leavePage.includes(param), `${param} should be gone with the request table`).toBe(false);
    }
    // `emp` and the ed* contract SURVIVE — on the page that reads them. Their spelling is unchanged, so
    // every admin link already saved keeps working against the new base path.
    expect(src.includes('emp?: string | string[]')).toBe(true);
    for (const param of ['edQ?: string', 'edPage?: string', 'edCompany?: string | string[]']) {
      expect(src.includes(param), param).toBe(true);
      expect(leavePage.includes(param), `${param} still declared on /leave`).toBe(false);
    }
  });
});

describe('leave filter panel: component supports multi-select additively', () => {
  const src = read('components/filter-panel.tsx');

  it('renders a checkbox group for the multi kind while keeping GET/a11y fundamentals', () => {
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src.includes("kind: 'multi'")).toBe(true);
    expect(src.includes('type="checkbox"')).toBe(true);
    expect(src.includes('method="get"')).toBe(true);
    expect(src).toMatch(/action=\{action\}/);
    // Clear-all links back to the page's own base path. Feedback 650b6eb8 made that base carry the FOREIGN
    // params of a second listing on the same page (`hidden`), so the assertion follows the helper rather
    // than the bare `action` it used to be — clearing one listing must not clear the other.
    expect(src).toMatch(/href=\{baseHref\(action, hidden\)\}/);
    expect(src).toContain('const baseHref = (action: string, hidden: FilterPanelProps[\'hidden\']) => {');
    expect(src.includes('hrefWithout')).toBe(true);
    expect(src.includes('removeAriaLabel')).toBe(true);
    // hrefWithout can drop a single value of a multi field (per-value chip removal).
    expect(src).toMatch(/hrefWithout\s*=\s*\(name: string, value\?/);
  });
});

// afd0a87c — the 'leave export route: admin-gated CSV + Excel' block is gone with app/leave/export/route.ts.
// That route served the retired org-wide register and its only links in the whole application were on the
// section that has been removed; an unreachable admin download is worse than none. The surviving
// per-employee download is app/leave/employee-records/export/route.ts, guarded by its own tests.

describe('leave filter panel: i18n keys exist in en.json', () => {
  it('leave.filters carries the panel + page strings', () => {
    const en = JSON.parse(read('messages/en.json')) as { leave: { filters: Record<string, string> } };
    for (const key of [
      'filter',
      'apply',
      'clearAll',
      'activeCount',
      'removeFilter',
      'search',
      'searchPlaceholder',
      'company',
      'businessUnit',
      'department',
      'location',
      'leaveType',
      'statusLabel',
      'dateFrom',
      'dateTo',
      'appliedFrom',
      'appliedTo',
      'showingOf',
      'emptyFiltered',
      'newer',
      'older',
      'rangeOf',
      'export',
      'exportCsv',
      'exportExcel',
      'sortAria',
      // Approval Information (feedback 0773bda9 gap-close).
      'pendingWith',
      'approvedBy',
      'anyStage',
      'anyApprover',
      'decidedByLine',
      'pendingWithLine',
    ]) {
      expect(en.leave.filters[key], `leave.filters.${key}`).toBeTruthy();
    }
  });

  it('leave.filters.stage carries both approver-kind labels', () => {
    const en = JSON.parse(read('messages/en.json')) as {
      leave: { filters: { stage: Record<string, string> } };
    };
    expect(en.leave.filters.stage.direct_manager).toBeTruthy();
    expect(en.leave.filters.stage.hr_admin).toBeTruthy();
  });
});
