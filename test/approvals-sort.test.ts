/**
 * Approvals sort helper (feedback 09cda965) — unit tests for the pure render-layer sort that orders
 * each /approvals section by the ?sort= choice. Display-only; the helpers are what the server page calls.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SORTS,
  DEFAULT_APPROVAL_SORT,
  parseApprovalSort,
  sortApprovalRows,
  type ApprovalSort,
} from '@/lib/approvals-sort';

type Row = { id: string; employee: string; createdAt: Date | string };

// Names deliberately NOT in creation order so name vs date sorts differ.
const rows: Row[] = [
  { id: 'r1', employee: 'John Tan', createdAt: new Date('2026-07-12T09:00:00Z') },
  { id: 'r2', employee: 'Ahmad', createdAt: new Date('2026-07-14T09:00:00Z') },
  { id: 'r3', employee: 'Sarah Lim', createdAt: '2026-07-13T09:00:00Z' }, // string createdAt on purpose
];
const acc = {
  id: (r: Row) => r.id,
  name: (r: Row) => r.employee,
  createdAt: (r: Row) => r.createdAt,
};
const order = (rs: Row[], sort: ApprovalSort) => sortApprovalRows(rs, sort, acc).map((r) => r.id);

describe('parseApprovalSort', () => {
  it('defaults unknown / missing to latest-first', () => {
    expect(parseApprovalSort(undefined)).toBe('latest');
    expect(parseApprovalSort('')).toBe('latest');
    expect(parseApprovalSort('bogus')).toBe('latest');
    expect(parseApprovalSort(['name_asc', 'x'])).toBe('name_asc'); // takes first
    expect(DEFAULT_APPROVAL_SORT).toBe('latest');
  });
  it('accepts every known option', () => {
    for (const s of APPROVAL_SORTS) expect(parseApprovalSort(s)).toBe(s);
  });
});

describe('sortApprovalRows', () => {
  it('latest = newest createdAt first (mixed Date/string handled)', () => {
    expect(order(rows, 'latest')).toEqual(['r2', 'r3', 'r1']); // 14, 13, 12 Jul
  });
  it('oldest = oldest createdAt first', () => {
    expect(order(rows, 'oldest')).toEqual(['r1', 'r3', 'r2']); // 12, 13, 14 Jul
  });
  it('name_asc = A→Z by employee name', () => {
    expect(order(rows, 'name_asc')).toEqual(['r2', 'r1', 'r3']); // Ahmad, John, Sarah
  });
  it('name_desc = Z→A by employee name', () => {
    expect(order(rows, 'name_desc')).toEqual(['r3', 'r1', 'r2']); // Sarah, John, Ahmad
  });
  it('does NOT mutate the input array', () => {
    const before = rows.map((r) => r.id);
    sortApprovalRows(rows, 'name_asc', acc);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
  it('is stable & id-keyed: equal sort keys keep a deterministic id order', () => {
    const t = new Date('2026-07-10T00:00:00Z');
    // Same createdAt AND same name → tie-break must be request id, ascending, regardless of input order.
    const tied: Row[] = [
      { id: 'b', employee: 'Same', createdAt: t },
      { id: 'a', employee: 'Same', createdAt: t },
      { id: 'c', employee: 'Same', createdAt: t },
    ];
    expect(order(tied, 'latest')).toEqual(['a', 'b', 'c']);
    expect(order(tied, 'name_asc')).toEqual(['a', 'b', 'c']);
    expect(order(tied, 'name_desc')).toEqual(['a', 'b', 'c']);
  });
  it('missing/blank name sorts last on A→Z', () => {
    const withBlank: Row[] = [
      { id: 'x', employee: '', createdAt: new Date('2026-07-01T00:00:00Z') },
      { id: 'y', employee: 'Zed', createdAt: new Date('2026-07-02T00:00:00Z') },
    ];
    expect(order(withBlank, 'name_asc')).toEqual(['x', 'y']); // '' < 'Zed'
  });
});
