/**
 * 9da61c86 fix pass — ADDING A HOLIDAY MUST SHOW THE NEW ROW.
 *
 * The Holiday master started paging this round, and paging quietly broke the reporter's Add New
 * requirement ("after saving, the new record should be reflected in the list automatically"). The master
 * is ordered by date and sliced at 25; the Add form posts the page the admin was on, so a holiday for next
 * year, added from page 1 of a multi-year calendar, was written correctly and then never drawn. The admin
 * got a success and an unchanged table — the product appearing to do nothing.
 *
 * WHY THIS IS A DATABASE TEST AND NOT A SOURCE ASSERTION. The claim spans three files that a unit test of
 * any one of them satisfies: the page posts filterPage/filterSize, the action decides the redirect, and
 * the screen re-renders the list from that address. So each case here runs the REAL server action against
 * a real holiday master, then rebuilds the list exactly as app/admin/holidays/page.tsx does from the
 * address the action redirected to, and asks the only question that matters: IS THE ROW ON THAT PAGE.
 *
 * The redirect helpers are mocked the way test/entitlement-save-stay.test.ts mocks them — redirect()
 * throws in real Next.js to abort the request, so the sentinel carries the target path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new RedirectError(p);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { createHolidayAction, updateHolidayAction } from '../app/admin/actions';
import { createHoliday, listHolidays } from '../core/admin';
import { paginateRows, parsePageQuery } from '../lib/pagination';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  actionCtx = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/** Run an action that ends in redirect() and hand back the address it sent the admin to. */
async function capture(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

/**
 * Rebuild the holiday list for an address the way app/admin/holidays/page.tsx does — same filters, same
 * order, same slice — and answer which rows the admin would actually see.
 */
async function rowsOnScreen(path: string): Promise<string[]> {
  const sp = new URLSearchParams(path.split('?')[1] ?? '');
  const yearRaw = sp.get('year');
  const rows = await listHolidays(actionCtx!, {
    country: sp.get('country') || undefined,
    year: yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : undefined,
  });
  const pq = parsePageQuery({ page: sp.get('page') ?? undefined, size: sp.get('size') ?? undefined });
  return paginateRows(rows, pq).rows.map((r) => r.id);
}

/** A calendar big enough to page: 60 days of 2026, three pages at the default 25. */
async function seedCalendar(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const row = await createHoliday(actionCtx!, { country: 'MY', holidayDate: d, name: `Day ${i}` });
    ids.push(row.id);
  }
  return ids;
}

describe('adding a holiday shows the new row', () => {
  it('lands on the page the new row is on, not the page the form was posted from', async () => {
    await seedCalendar();
    // The admin is on page one of the whole master and adds a holiday for NEXT year: ordered by date it
    // belongs at the very end, three pages away from the form they typed it into.
    const path = await capture(() =>
      createHolidayAction(
        form({
          name: 'Next-year holiday',
          holidayDate: '2027-06-15',
          holidayType: 'public',
          country: 'MY',
          active: 'on',
          filterCountry: '',
          filterYear: '',
          filterPage: '0',
        }),
      ),
    );

    const all = await listHolidays(actionCtx!);
    const created = all.find((h) => h.name === 'Next-year holiday')!;
    expect(created).toBeDefined();
    // THE ASSERTION THIS FILE EXISTS FOR: the row the admin just added is drawn on the page they land on.
    expect(await rowsOnScreen(path)).toContain(created.id);
    // 61 rows at 25 a page puts it on the third page — proving the address moved rather than the list
    // happening to be short enough that page one would have done.
    expect(path).toContain('page=2');
  });

  it('drops a year filter that would hide the new row, and keeps the country filter that would not', async () => {
    await seedCalendar();
    const path = await capture(() =>
      createHolidayAction(
        form({
          name: 'Filtered-out holiday',
          holidayDate: '2027-03-01',
          holidayType: 'public',
          country: 'MY',
          active: 'on',
          filterCountry: 'MY',
          filterYear: '2026',
          filterPage: '1',
        }),
      ),
    );

    const created = (await listHolidays(actionCtx!)).find((h) => h.name === 'Filtered-out holiday')!;
    expect(await rowsOnScreen(path)).toContain(created.id);
    // No page number can show a row the filter excludes, so the excluding filter goes — and only it.
    expect(path).not.toContain('year=');
    expect(path).toContain('country=MY');
  });

  it('follows a holiday whose DATE was edited onto the page it moved to', async () => {
    const ids = await seedCalendar();
    // Move the FIRST row of page one to the end of the calendar. Before this fix the admin was returned to
    // page one, where the row they had just edited was no longer present — an edit that reads as a delete.
    const moved = ids[0];
    const path = await capture(() =>
      updateHolidayAction(
        form({
          id: moved,
          holidayDate: '2027-12-31',
          name: 'Day 0',
          holidayType: 'public',
          active: 'on',
          filterCountry: '',
          filterYear: '',
          filterPage: '0',
        }),
      ),
    );
    expect(await rowsOnScreen(path)).toContain(moved);
  });

  it('still returns an edit that moves nothing to the page it was made on, and invents no ?size=', async () => {
    const ids = await seedCalendar();
    // Row 30 sits on page two. Renaming it must not move the admin — the round trip this round shipped.
    const stayed = ids[30];
    const path = await capture(() =>
      updateHolidayAction(
        form({
          id: stayed,
          holidayDate: '2026-01-31',
          name: 'Renamed in place',
          holidayType: 'public',
          active: 'on',
          filterCountry: '',
          filterYear: '',
          filterPage: '1',
        }),
      ),
    );
    expect(path).toContain('page=1');
    expect(await rowsOnScreen(path)).toContain(stayed);
    // The reader chose no rows-per-page, so the address must not claim they did (the hidden field carries
    // the resolved default whether or not anyone picked it).
    expect(path).not.toContain('size=');
  });
});
