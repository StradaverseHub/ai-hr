/** ADR 0181 decision 5 (Phase 4): the capped-total and keyset paging contract (lib/pagination.ts) and the one-parameter
 * company list (db/sql-arrays.ts). Pure helpers, no database. */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ALL_ROW_CEILING,
  LIST_COUNT_CAP,
  cappedTotal,
  isKeysetPageState,
  keysetFetchLimit,
  keysetPageState,
  keysetSlice,
  listCountCap,
  pageState,
  parseKeysetPageQuery,
  parsePageQuery,
} from '../lib/pagination';
import { anyUuid, uuidArrayParam } from '../db/sql-arrays';

const A = '0b6f1d1e-3c55-4c6a-9a43-0d2f0c6f1a01';
const B = '7d1e9b2a-5f0c-4e8b-8a7d-2b9c4e1f3a02';
const C = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c03';

describe('capped totals', () => {
  it('is exact below the cap and "cap+" above it, unless exact was asked for', () => {
    expect(LIST_COUNT_CAP).toBe(1000);
    expect(cappedTotal(999, 1000)).toEqual({ count: 999, capped: false });
    expect(cappedTotal(1000, 1000)).toEqual({ count: 1000, capped: false });
    expect(cappedTotal(1001, 1000)).toEqual({ count: 1000, capped: true });
    expect(cappedTotal(54_321, 1000, true)).toEqual({ count: 54_321, capped: false });
  });
  it('counts up to the "All" ceiling when All is shown, so its truncation notice stays truthful', () => {
    expect(listCountCap(25)).toBe(LIST_COUNT_CAP);
    expect(listCountCap('all')).toBe(Math.max(LIST_COUNT_CAP, ALL_ROW_CEILING));
  });
});

describe('keyset page query', () => {
  it('opens the first page without a cursor, whatever ?page= says (no OFFSET is ever derived)', () => {
    const q = parseKeysetPageQuery({ page: '7', size: '50' });
    expect(q).toMatchObject({ page: 0, size: 50, limit: 50, offset: 0, last: false, exactCount: false });
    expect(q.after).toBeUndefined();
    expect(q.before).toBeUndefined();
  });
  it('accepts a row identifier as the cursor and keeps ?page= only as the position counter', () => {
    expect(parseKeysetPageQuery({ page: '3', after: A })).toMatchObject({ page: 3, after: A, offset: 0 });
    expect(parseKeysetPageQuery({ page: '2', before: B.toUpperCase() })).toMatchObject({ page: 2, before: B });
    // A Next from the first page always lands on at least page 1.
    expect(parseKeysetPageQuery({ after: A }).page).toBe(1);
  });
  it('refuses a malformed cursor (names and other values never travel as a cursor)', () => {
    for (const bad of ['Tan Ah Kow', "'; drop table person; --", '1234', A + 'x']) {
      const q = parseKeysetPageQuery({ page: '4', after: bad, before: bad });
      expect(q.after).toBeUndefined();
      expect(q.before).toBeUndefined();
      expect(q.page).toBe(0);
    }
  });
  it('after wins over before; last only without a cursor; "Count exactly" is count=exact', () => {
    expect(parseKeysetPageQuery({ after: A, before: B })).toMatchObject({ after: A, before: undefined });
    expect(parseKeysetPageQuery({ last: '1' })).toMatchObject({ last: true });
    expect(parseKeysetPageQuery({ last: '1', after: A })).toMatchObject({ last: false, after: A });
    expect(parseKeysetPageQuery({ count: 'exact' }).exactCount).toBe(true);
    expect(parseKeysetPageQuery({ count: 'yes' }).exactCount).toBe(false);
  });
  it('"All" has no cursor and no Last', () => {
    const q = parseKeysetPageQuery({ size: 'all', after: A, last: '1' });
    expect(q).toMatchObject({ size: 'all', limit: ALL_ROW_CEILING, last: false });
    expect(q.after).toBeUndefined();
  });
});

describe('keyset slice', () => {
  const rows = [1, 2, 3, 4];
  it('fetches one extra row to learn whether a next page exists', () => {
    expect(keysetFetchLimit({ limit: 3 })).toBe(4);
    expect(keysetSlice(rows, { limit: 3, last: false }, true)).toEqual({ rows: [1, 2, 3], hasPrev: false, hasNext: true });
    expect(keysetSlice(rows.slice(0, 3), { limit: 3, last: false }, true)).toEqual({ rows: [1, 2, 3], hasPrev: false, hasNext: false });
    expect(keysetSlice(rows, { limit: 3, after: A, last: false }, true)).toEqual({ rows: [1, 2, 3], hasPrev: true, hasNext: true });
  });
  it('puts a backwards read (Previous, Last) back in list order', () => {
    expect(keysetSlice([9, 8, 7, 6], { limit: 3, before: A, last: false }, true)).toEqual({ rows: [7, 8, 9], hasPrev: true, hasNext: true });
    expect(keysetSlice([9, 8], { limit: 3, before: A, last: false }, true)).toEqual({ rows: [8, 9], hasPrev: false, hasNext: true });
    expect(keysetSlice([9, 8, 7, 6], { limit: 3, last: true }, true)).toEqual({ rows: [7, 8, 9], hasPrev: true, hasNext: false });
  });
  it('a lost anchor serves the first page forwards', () => {
    expect(keysetSlice(rows, { limit: 3, before: A, last: false }, false)).toEqual({ rows: [1, 2, 3], hasPrev: false, hasNext: true });
  });
});

describe('keyset page state', () => {
  it('counts positions from the page counter and marks a capped total', () => {
    const q = parseKeysetPageQuery({ page: '2', size: '25', after: A });
    const state = keysetPageState(q, { total: { count: 1000, capped: true }, hasPrev: true, hasNext: true, anchorFound: true }, [B, C]);
    expect(isKeysetPageState(state)).toBe(true);
    expect(state).toMatchObject({ page: 2, from: 51, to: 52, total: 1000, capped: true, hasPrev: true, hasNext: true,
      firstId: B, lastId: C, canLast: false });
  });
  it('offers Last only when the total is exact, and places the last page from it', () => {
    const q = parseKeysetPageQuery({ size: '25', last: '1' });
    const state = keysetPageState(q, { total: { count: 60, capped: false }, hasPrev: true, hasNext: false, anchorFound: true },
      Array.from({ length: 10 }, (_, i) => `${i}`));
    expect(state).toMatchObject({ page: 2, from: 51, to: 60, canLast: false, hasNext: false, hasPrev: true });
    const first = keysetPageState(parseKeysetPageQuery({ size: '25' }),
      { total: { count: 60, capped: false }, hasPrev: false, hasNext: true, anchorFound: true }, [A]);
    expect(first.canLast).toBe(true);
  });
  it('resets the counter to the first page when the anchor was lost', () => {
    const q = parseKeysetPageQuery({ page: '9', size: '25', after: A });
    const state = keysetPageState(q, { total: { count: 40, capped: false }, hasPrev: false, hasNext: true, anchorFound: false }, [B]);
    expect(state).toMatchObject({ page: 0, from: 1, to: 1, hasPrev: false });
  });
  it('an OFFSET page state is not a keyset state', () => {
    expect(isKeysetPageState(pageState(parsePageQuery({}), 3, 3))).toBe(false);
  });
});

describe('one statement shape for company lists', () => {
  const dialect = new PgDialect();
  const render = (ids: string[]) => dialect.sqlToQuery(anyUuid(sql.raw('company_id'), ids));
  it('sends one parameter whatever the number of companies', () => {
    const one = render([A]);
    const many = render(Array.from({ length: 74 }, (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`));
    expect(one.sql).toBe('company_id = any($1::uuid[])');
    expect(many.sql).toBe(one.sql);
    expect(one.params).toEqual([`{${A}}`]);
    expect(many.params).toHaveLength(1);
  });
  it('refuses anything that is not a UUID before it reaches the database', () => {
    expect(() => uuidArrayParam([A, 'x'])).toThrow(RangeError);
    expect(() => uuidArrayParam(['{' + A + '}'])).toThrow(RangeError);
    expect(dialect.sqlToQuery(uuidArrayParam([])).params).toEqual(['{}']);
  });
});
