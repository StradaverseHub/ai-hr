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
 * any one of them satisfies: the page posts filterPage/filterSize, the action decides the address, and
 * the screen re-renders the list from that address. So each case here runs the REAL server action against
 * a real holiday master, then rebuilds the list exactly as app/admin/holidays/page.tsx does from the
 * address the action answered with, and asks the only question that matters: IS THE ROW ON THAT PAGE.
 *
 * def44f29 — the action RETURNS the address now instead of redirecting to it. Add and Edit moved into a
 * dialog over the list (holiday-dialog.tsx), and a redirect would navigate the route out from under it;
 * so saveHolidayAction answers `{ ok: true, path }` and the island navigates. The question this file asks
 * is unchanged — the path just arrives as a value rather than as a thrown redirect. The refusal path is
 * new and pinned here too: `{ ok: false, error }` and nothing written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let actionCtx: import('../db/client').SessionContext | null = null;
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  // The save must never redirect (the dialog would lose its typing); make one loud if it ever does.
  redirect: (p: string): never => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { saveHolidayAction } from '../app/admin/actions';
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

/** Run the save the way the dialog does and hand back the address it tells the island to navigate to. */
async function save(fields: Record<string, string>): Promise<string> {
  const result = await saveHolidayAction(null, form(fields));
  if (!result.ok) throw new Error(`expected the save to succeed, it was refused: ${result.error}`);
  return result.path;
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
    const path = await save({
      name: 'Next-year holiday',
      holidayDate: '2027-06-15',
      holidayType: 'public',
      country: 'MY',
      state: '',
      active: 'on',
      filterCountry: '',
      filterYear: '',
      filterPage: '0',
    });

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
    const path = await save({
      name: 'Filtered-out holiday',
      holidayDate: '2027-03-01',
      holidayType: 'public',
      country: 'MY',
      state: '',
      active: 'on',
      filterCountry: 'MY',
      filterYear: '2026',
      filterPage: '1',
    });

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
    const path = await save({
      id: moved,
      holidayDate: '2027-12-31',
      name: 'Day 0',
      holidayType: 'public',
      state: '',
      active: 'on',
      filterCountry: '',
      filterYear: '',
      filterPage: '0',
    });
    expect(await rowsOnScreen(path)).toContain(moved);
  });

  it('still returns an edit that moves nothing to the page it was made on, and invents no ?size=', async () => {
    const ids = await seedCalendar();
    // Row 30 sits on page two. Renaming it must not move the admin — the round trip this round shipped.
    const stayed = ids[30];
    const path = await save({
      id: stayed,
      holidayDate: '2026-01-31',
      name: 'Renamed in place',
      holidayType: 'public',
      state: '',
      active: 'on',
      filterCountry: '',
      filterYear: '',
      filterPage: '1',
    });
    expect(path).toContain('page=1');
    expect(await rowsOnScreen(path)).toContain(stayed);
    // The reader chose no rows-per-page, so the address must not claim they did (the hidden field carries
    // the resolved default whether or not anyone picked it).
    expect(path).not.toContain('size=');
  });
});

describe('def44f29 — the save answers the dialog instead of redirecting', () => {
  it('a state chosen in the dialog reaches the row, on Add and on Edit', async () => {
    const ids = await seedCalendar();
    await save({
      name: 'Pesta Kaamatan',
      holidayDate: '2026-05-30',
      holidayType: 'public',
      country: 'MY',
      state: 'Sabah',
      active: 'on',
      filterCountry: '',
      filterYear: '',
      filterPage: '0',
    });
    await save({
      id: ids[0],
      holidayDate: '2026-01-01',
      name: 'Day 0',
      holidayType: 'public',
      state: 'Sarawak',
      active: 'on',
      filterCountry: '',
      filterYear: '',
      filterPage: '0',
    });
    const all = await listHolidays(actionCtx!);
    expect(all.find((h) => h.name === 'Pesta Kaamatan')?.state).toBe('Sabah');
    expect(all.find((h) => h.id === ids[0])?.state).toBe('Sarawak');
  });

  it('a refused save returns the reason, writes nothing, and never redirects', async () => {
    await seedCalendar();
    // Day 0 already sits on 2026-01-01 at national scope: a second national holiday there is a duplicate.
    const result = await saveHolidayAction(
      null,
      form({
        name: 'Duplicate New Year',
        holidayDate: '2026-01-01',
        holidayType: 'public',
        country: 'MY',
        state: '',
        active: 'on',
        filterCountry: '',
        filterYear: '',
        filterPage: '0',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The service's own words — what the dialog paints, and what the admin reads.
    expect(result.error).toMatch(/2026-01-01 already exists/);
    expect(await listHolidays(actionCtx!)).toHaveLength(60);
  });
});
