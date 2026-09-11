/**
 * 3e831868 — Holiday Master Simplification.
 *
 * Verifies the four load-bearing pieces of the build:
 *   1. Service backward-compat: the simplified update path omits holidayCode/description, so updateHoliday
 *      PRESERVES their stored values (undefined = leave unchanged) while still editing date/name/type/
 *      active/tentative. create/update/delete all still round-trip. This is the guarantee the new action
 *      layer relies on (the columns stay populated even though the UI no longer edits them).
 *   2. Page source: the holiday form + list no longer render Holiday Code / Description inputs, and the new
 *      compact table header columns (National/State · Status · Action) are present.
 *   3. Action source: createHolidayAction / updateHolidayAction no longer read holidayCode / description.
 *   4. i18n: 'company' is relabelled "Replacement holiday" (value unchanged — the dropdown still emits
 *      exactly public/company/optional), and the new column keys exist + are non-empty in all 6 locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHoliday, deleteHoliday, listHolidays, updateHoliday } from '../core/admin';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('holiday master simplification (3e831868)', () => {
  it('update preserves holidayCode/description when omitted, and still edits the master fields', async () => {
    const ctx = adminCtx(b);
    const created = await createHoliday(ctx, {
      country: 'MY',
      holidayDate: '2027-01-01',
      name: 'New Year',
      holidayCode: 'NY',
      description: 'Gazetted national holiday',
      holidayType: 'public',
      active: true,
    });

    // Simulate the new (simplified) action: date/name/type/active/tentative only — NO code/description.
    await updateHoliday(ctx, {
      id: created.id,
      holidayDate: '2027-01-02',
      name: 'New Year (observed)',
      holidayType: 'company', // stored value stays 'company' (relabel is i18n-only)
      active: false,
      tentative: true,
    });

    const [row] = await listHolidays(ctx, { country: 'MY', year: 2027 });
    expect(row.name).toBe('New Year (observed)');
    expect(row.holidayDate).toBe('2027-01-02');
    expect(row.holidayType).toBe('company');
    expect(row.active).toBe(false);
    expect(row.tentative).toBe(true);
    // The dropped fields keep their stored values — NOT wiped to null.
    expect(row.holidayCode).toBe('NY');
    expect(row.description).toBe('Gazetted national holiday');

    await deleteHoliday(ctx, { id: created.id });
    expect(await listHolidays(ctx, { country: 'MY', year: 2027 })).toHaveLength(0);
  });

  it('National/State derives from state (null = national, else the state label)', async () => {
    const ctx = adminCtx(b);
    const nat = await createHoliday(ctx, { country: 'MY', holidayDate: '2027-05-01', name: 'Labour Day' });
    const st = await createHoliday(ctx, {
      country: 'MY',
      holidayDate: '2027-06-02',
      name: 'Harvest Festival',
      state: 'Sabah',
    });
    const rows = await listHolidays(ctx, { country: 'MY', year: 2027 });
    expect(rows.find((r) => r.id === nat.id)!.state).toBeNull();
    expect(rows.find((r) => r.id === st.id)!.state).toBe('Sabah');
  });

  it('page source: no Holiday Code / Description inputs; compact table columns present', () => {
    const src = read('app/admin/holidays/page.tsx');
    expect(src).not.toMatch(/name="holidayCode"/);
    expect(src).not.toMatch(/name="description"/);
    expect(src).not.toMatch(/holidayCodeLabel|descriptionLabel/);
    // Compact single-row table with the required column headers.
    expect(src).toMatch(/<table/);
    expect(src).toContain("t('nationalStateColumn')");
    expect(src).toContain("t('statusLabel')");
    expect(src).toContain("t('actionLabel')");
    // National/State cell derives from h.state.
    expect(src).toMatch(/h\.state \? h\.state : t\('national'\)/);
    // Exactly the three holiday types drive the dropdown.
    expect(src).toContain("const HOLIDAY_TYPES = ['public', 'company', 'optional']");
  });

  it('action source: the save no longer reads holidayCode / description', () => {
    // def44f29 — createHolidayAction + updateHolidayAction became ONE value-returning saveHolidayAction
    // (the dialog over the list). Same pin, new block: the slice must be non-empty, or a renamed action
    // would make both negatives pass on an empty string.
    const src = read('app/admin/actions.ts');
    const start = src.indexOf('export async function saveHolidayAction');
    const end = src.indexOf('export async function deleteHolidayAction');
    expect(start, 'saveHolidayAction exists').toBeGreaterThan(-1);
    expect(end, 'deleteHolidayAction follows it').toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/formData\.get\('holidayCode'\)/);
    expect(block).not.toMatch(/formData\.get\('description'\)/);
  });

  it('i18n: company relabelled to Replacement holiday; dropdown values unchanged; new keys in 6 locales', () => {
    for (const loc of LOCALES) {
      const d = JSON.parse(read(`messages/${loc}.json`));
      const h = d.admin.holidays;
      // Value set is EXACTLY the three types (i18n-only relabel — no type added/removed).
      expect(Object.keys(h.holidayType).sort()).toEqual(['company', 'optional', 'public']);
      // New compact-table column labels exist and are non-empty (no English fallback).
      for (const k of ['nationalStateColumn', 'statusLabel', 'actionLabel']) {
        expect(typeof h[k]).toBe('string');
        expect(h[k].length).toBeGreaterThan(0);
      }
    }
    const en = JSON.parse(read('messages/en.json')).admin.holidays;
    expect(en.holidayType.company).toBe('Replacement holiday');
    expect(en.holidayType.public).toBe('Public holiday');
    expect(en.holidayType.optional).toBe('Optional');
  });
});
