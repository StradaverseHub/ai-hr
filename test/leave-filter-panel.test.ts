/**
 * Advanced Search & Filter for Leave Management (feedback 0773bda9) — static-source guard.
 *
 * The admin /leave surface gained a global search bar, a consolidated Filter panel (with multi-select
 * Leave Type + Status), removable chips, a live count, sortable headers, a pager, and CSV/Excel export.
 * This DB-free guard fails loudly if a future edit drops a searchParam from the contract, removes the
 * admin gate, strips the panel's multi-select support, unguards the export route, or deletes an i18n key.
 * The end-to-end query behaviour is proven independently by test/leave-filters.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('leave filter panel: /leave admin surface', () => {
  const src = read('app/leave/page.tsx');

  it('imports FilterPanel + FilterChips from @/components/filter-panel, mounted on /leave', () => {
    expect(src).toMatch(/import\s*\{[^}]*FilterPanel[^}]*\}\s*from\s*'@\/components\/filter-panel'/);
    expect(src).toMatch(/FilterChips/);
    expect(src.includes('action="/leave"')).toBe(true);
  });

  it('preserves the full searchParams contract', () => {
    for (const param of [
      'q?: string',
      'page?: string',
      'company?: string',
      'bu?: string',
      'dept?: string',
      'loc?: string',
      'type?: string | string[]',
      'status?: string | string[]',
      'from?: string',
      'to?: string',
      'appliedFrom?: string',
      'appliedTo?: string',
      // Approval Information (feedback 0773bda9 gap-close).
      'approvedBy?: string',
      'pendingWith?: string',
      'sort?: string',
      'dir?: string',
    ]) {
      expect(src.includes(param), param).toBe(true);
    }
  });

  it('exposes the Approval Information filters (Approved by + Pending with)', () => {
    // Both filter fields are wired into the panel and their query params flow to the read.
    expect(src.includes("name: 'approvedBy'")).toBe(true);
    expect(src.includes("name: 'pendingWith'")).toBe(true);
    expect(src.includes('listLeaveApprovers')).toBe(true);
    expect(src.includes('approvedBy,')).toBe(true);
    expect(src.includes('pendingWith,')).toBe(true);
  });

  it('gates the search/filter/export UI behind the admin check', () => {
    // The FilterPanel/search bar/export render only under `admin` (isAdmin(session)).
    expect(src.includes('isAdmin(session)')).toBe(true);
    expect(src).toMatch(/admin \? \(/);
    // The paginated read is used for admins; the non-admin path keeps listLeaveRequests.
    expect(src.includes('listLeaveRequestsPage')).toBe(true);
    expect(src.includes('listLeaveRequests(session, scopeIds)')).toBe(true);
  });

  it('feeds multi-select + date filters into the panel and carries a live count + export links', () => {
    expect(src.includes("kind: 'multi'")).toBe(true);
    expect(src.includes("kind: 'date'")).toBe(true);
    expect(src.includes('filters.showingOf')).toBe(true);
    expect(src.includes('/leave/export?')).toBe(true);
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
    expect(src).toMatch(/href=\{action\}/);
    expect(src.includes('hrefWithout')).toBe(true);
    expect(src.includes('removeAriaLabel')).toBe(true);
    // hrefWithout can drop a single value of a multi field (per-value chip removal).
    expect(src).toMatch(/hrefWithout\s*=\s*\(name: string, value\?/);
  });
});

describe('leave export route: admin-gated CSV + Excel', () => {
  const src = read('app/leave/export/route.ts');

  it('403s non-admins and offers both formats', () => {
    expect(src.includes('isAdmin(session)')).toBe(true);
    expect(src.includes('403')).toBe(true);
    expect(src.includes('toCsvReport')).toBe(true);
    expect(src.includes('toXlsxReport')).toBe(true);
    expect(src.includes('listLeaveRequestsPage')).toBe(true);
  });
});

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
