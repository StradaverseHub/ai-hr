import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readShiftImportWorkbook, shiftImportErrorWorkbook, shiftImportWorkbook } from '../lib/shift-import-workbook';

it('reads the downloadable shift workbook with repeated break codes and reports the original row numbers', () => {
  const book = XLSX.read(shiftImportWorkbook(), { type: 'buffer' });
  XLSX.utils.sheet_add_aoa(book.Sheets.Shifts, [['NIGHT', 'Night', 'normal', '22:00', '06:00']], { origin: 'A4' });
  XLSX.utils.sheet_add_aoa(book.Sheets.Breaks, [
    ['NIGHT', 'before_shift', '21:15', '21:30'],
    ['NIGHT', 'after_shift', '06:15', '06:30', 15, 'no'],
  ], { origin: 'A2' });
  const parsed = readShiftImportWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  expect(parsed.shifts).toMatchObject([{ row: 4, values: { 'Shift Code': 'NIGHT', 'Time In': '22:00' } }]);
  expect(parsed.breaks).toMatchObject([
    { row: 2, values: { 'Shift Code': 'NIGHT', 'Break Type': 'before_shift' } },
    { row: 3, values: { 'Shift Code': 'NIGHT', 'Flexible Minutes': '15' } },
  ]);
  book.Sheets.Shifts.B4 = { t: 's', v: 'Night', f: 'A4' };
  expect(() => readShiftImportWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))).toThrow('row 4');
  const errors = XLSX.read(shiftImportErrorWorkbook([{ sheet: 'Breaks', row: 3, field: 'Paid', message: 'Choose yes or no.' }]), { type: 'buffer' });
  expect(errors.Sheets.Errors.B2.v).toBe(3);
});
