/**
 * Approval categories (feedback 2dec6406) — unit tests for the pure category helpers behind the internal
 * approval-task navigation panel: URL-param parsing (with admin coercion), the shared Attendance-vs-Overtime
 * split predicate, the corrections row filter, section visibility, and the decide-action return-URL builder.
 * Modelled on test/approvals-sort.test.ts (pure, no DB).
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_CATEGORIES,
  APPROVAL_CATEGORIES,
  PANEL_GROUPS,
  approvalsReturnUrl,
  correctionsRowFilter,
  parseApprovalCategory,
  sectionVisible,
  type ApprovalCategory,
  type ApprovalSection,
} from '@/lib/approvals-categories';
import { BULK_CATEGORY_ORDER, isOvertimeCorrection, type BulkCategory } from '@/lib/approvals-bulk';

describe('parseApprovalCategory', () => {
  it('defaults unknown / missing values to all', () => {
    expect(parseApprovalCategory(undefined, { admin: true })).toBe('all');
    expect(parseApprovalCategory('', { admin: true })).toBe('all');
    expect(parseApprovalCategory('bogus', { admin: true })).toBe('all');
    expect(parseApprovalCategory(['leave', 'x'], { admin: true })).toBe('leave'); // takes first
  });

  it('accepts every known category for an admin', () => {
    for (const c of APPROVAL_CATEGORIES) expect(parseApprovalCategory(c, { admin: true })).toBe(c);
  });

  it('coerces admin-only categories to all for a non-admin viewer (the deep-link case)', () => {
    for (const c of ADMIN_ONLY_CATEGORIES) expect(parseApprovalCategory(c, { admin: false })).toBe('all');
    // The manager-stage review queue is NOT admin-only — a manager may select it.
    expect(parseApprovalCategory('managerReviews', { admin: false })).toBe('managerReviews');
    expect(parseApprovalCategory('leave', { admin: false })).toBe('leave');
  });
});

describe('isOvertimeCorrection (the ONE shared split predicate)', () => {
  it('a correction carrying requestedOtMinutes is an overtime request', () => {
    expect(isOvertimeCorrection({ requestedOtMinutes: 90 })).toBe(true);
    expect(isOvertimeCorrection({ requestedOtMinutes: null })).toBe(false);
  });
});

describe('correctionsRowFilter', () => {
  const rows = [
    { id: 'ot', requestedOtMinutes: 90 },
    { id: 'clock', requestedOtMinutes: null },
  ];
  it('attendance keeps only non-OT rows', () => {
    expect(rows.filter(correctionsRowFilter('attendance')).map((r) => r.id)).toEqual(['clock']);
  });
  it('overtime keeps only OT rows', () => {
    expect(rows.filter(correctionsRowFilter('overtime')).map((r) => r.id)).toEqual(['ot']);
  });
  it('all (and unrelated categories) keep both', () => {
    expect(rows.filter(correctionsRowFilter('all')).length).toBe(2);
    expect(rows.filter(correctionsRowFilter('leave')).length).toBe(2);
  });
});

describe('bulk rows from a filtered view', () => {
  // Mirrors how the page builds bulkRows for the shared corrections section: filter first, then classify
  // with the SAME predicate — so a filtered view can never contain rows of the other sub-type.
  const corrections = [
    { id: 'a', requestedOtMinutes: null },
    { id: 'b', requestedOtMinutes: 120 },
    { id: 'c', requestedOtMinutes: null },
  ];
  const build = (category: ApprovalCategory) =>
    corrections
      .filter(correctionsRowFilter(category))
      .map((c) => ({ id: c.id, category: (isOvertimeCorrection(c) ? 'overtime' : 'attendance') as BulkCategory }));

  it('overtime view yields only overtime bulk rows', () => {
    const rows = build('overtime');
    expect(rows.map((r) => r.id)).toEqual(['b']);
    expect(rows.every((r) => r.category === 'overtime')).toBe(true);
  });
  it('attendance view yields only attendance bulk rows', () => {
    const rows = build('attendance');
    expect(rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(rows.every((r) => r.category === 'attendance')).toBe(true);
  });
});

describe('sectionVisible', () => {
  const sections: ApprovalSection[] = [
    'leave',
    'leaveCancellation',
    'claims',
    'replacementLeave',
    'corrections',
    'travel',
    'profileChanges',
    'resignations',
    'managerReviews',
    'hrReviews',
  ];
  it('all shows every section', () => {
    for (const sec of sections) expect(sectionVisible('all', sec)).toBe(true);
  });
  it('a selected category shows only its own section', () => {
    expect(sections.filter((sec) => sectionVisible('leave', sec))).toEqual(['leave']);
    expect(sections.filter((sec) => sectionVisible('claim', sec))).toEqual(['claims']);
  });
  it('attendance and overtime both map to the ONE shared corrections section', () => {
    expect(sections.filter((sec) => sectionVisible('attendance', sec))).toEqual(['corrections']);
    expect(sections.filter((sec) => sectionVisible('overtime', sec))).toEqual(['corrections']);
  });
});

describe('panel structure', () => {
  it('bulk-taxonomy categories appear in BULK_CATEGORY_ORDER across the groups', () => {
    const panelBulk = PANEL_GROUPS.flatMap((g) => g.categories).filter((c) =>
      (BULK_CATEGORY_ORDER as readonly string[]).includes(c),
    );
    expect(panelBulk).toEqual([...BULK_CATEGORY_ORDER]);
  });
});

describe('approvalsReturnUrl (the decide-action redirect builder)', () => {
  it('preserves category and sort on success and error paths alike', () => {
    expect(approvalsReturnUrl({ category: 'leave', sort: 'oldest', toast: 'Leave approved' })).toBe(
      '/approvals?category=leave&sort=oldest&toast=Leave+approved',
    );
    expect(approvalsReturnUrl({ category: 'overtime', sort: 'name_asc', error: 'nope' })).toBe(
      '/approvals?category=overtime&sort=name_asc&error=nope',
    );
  });
  it('omits the default category (all / empty) and an empty sort', () => {
    expect(approvalsReturnUrl({ category: 'all', sort: '', toast: 'ok' })).toBe('/approvals?toast=ok');
    expect(approvalsReturnUrl({})).toBe('/approvals');
  });
});
