import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { confirmShiftImport, previewShiftImport } from '../core/shift-import';
import { createShift, listShiftsForTenant } from '../core/roster';
import { shiftImportWorkbook } from '../lib/shift-import-workbook';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); base = await seedBase(); });

it('previews and commits whole shifts, preserving omitted settings and rejecting stale confirmation', async () => {
  const admin = adminCtx(base);
  await createShift(admin, { code: 'DAY', name: 'Day shift', startTime: '09:00', endTime: '18:00', weeklyPattern: [1, 2, 3, 4, 5] });
  const book = XLSX.read(shiftImportWorkbook(), { type: 'buffer' });
  XLSX.utils.sheet_add_aoa(book.Sheets.Shifts, [
    ['DAY', 'Updated day shift'], ['NIGHT', 'Night shift', 'normal', '22:00', '06:00'], ['INVALID'],
  ], { origin: 'A2' });
  XLSX.utils.sheet_add_aoa(book.Sheets.Breaks, [
    ['NIGHT', 'before_shift', '21:15', '21:30'],
    ['NIGHT', 'in_shift', '02:00', '02:30'],
  ], { origin: 'A2' });
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const preview = await previewShiftImport(admin, bytes);
  expect(preview.operations.map(row => [row.code, Boolean(row.id)])).toEqual([['DAY', true], ['NIGHT', false]]);
  expect(preview.issues).toMatchObject([{ sheet: 'Shifts', row: 4 }]);
  expect((await listShiftsForTenant(admin)).map(row => row.name)).toEqual(['Day shift']);
  const summary = await confirmShiftImport(admin, bytes, preview.fingerprint);
  expect(summary).toMatchObject({ created: 1, updated: 1, skipped: 1, failed: 0 });
  const shifts = await listShiftsForTenant(admin);
  expect(shifts.find(row => row.code === 'DAY')).toMatchObject({ name: 'Updated day shift', weeklyPattern: [1, 2, 3, 4, 5] });
  expect(shifts.find(row => row.code === 'NIGHT')).toMatchObject({
    breakMinutes: 30, breakPeriods: [{ breakType: 'before_shift' }, { start: '02:00:00', end: '02:30:00' }],
  });
  await expect(confirmShiftImport(admin, bytes, preview.fingerprint)).rejects.toThrow('Preview the workbook again');
});
