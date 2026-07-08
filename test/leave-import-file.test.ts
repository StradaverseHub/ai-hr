/**
 * Leave import — spreadsheet (.xlsx/.xls) → CSV bridge (lib/spreadsheet.ts).
 *
 * Pure node tests (no DB harness): build a workbook in-memory with SheetJS, run it through
 * workbookToCsvText, then parseCsvRecords, and assert the row shape the engine (core/leave-import
 * analyze) consumes. Covers the classic importer hazards the plan flagged:
 *   (i)   reporter's human headers ("Employee ID", …) normalise to snake_case (employee_id, …)
 *   (ii)  a REAL Excel date cell arrives as YYYY-MM-DD (passes the engine's DATE_RE)
 *   (iii) negative `days` (-2) survive un-mangled (no csvSafeCell formula-guard corruption)
 *   (iv)  the FIRST of several worksheets is the one read
 *   (v)   the generated .xlsx template round-trips back to LEAVE_IMPORT_COLUMNS.required
 *   (vi)  an empty first sheet throws EMPTY_SHEET
 *
 * NOTE: `xlsx` is added to package.json but installed only at integration — until then this file
 * (and lib/spreadsheet.ts) report "Cannot find module 'xlsx'" under tsc, which is expected.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseCsvRecords } from '../lib/csv';
import { workbookToCsvText, buildXlsx } from '../lib/spreadsheet';
import { LEAVE_IMPORT_COLUMNS } from '../lib/leave-import-schema';

/** Serialise an array-of-arrays into a single-sheet .xlsx ArrayBuffer, as File.arrayBuffer() would give. */
function aoaToXlsxBuffer(aoa: unknown[][], sheetName = 'Sheet1'): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  // XLSX.write(type:'array') returns an ArrayBuffer; normalise via Uint8Array so this helper is
  // robust either way, then hand back a tight ArrayBuffer copy (as File.arrayBuffer() would give).
  const u8 = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe('leave import — spreadsheet → CSV', () => {
  it('(i) reporter human headers normalise to the snake_case contract', async () => {
    const buf = aoaToXlsxBuffer([
      ['Employee ID', 'Leave Type', 'Transaction Type', 'Days', 'Effective Date'],
      ['E1001', 'ANNUAL', 'adjustment', '5', '2026-01-01'],
    ]);
    const csv = await workbookToCsvText(buf);
    const { records } = parseCsvRecords(csv);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      employee_id: 'E1001',
      leave_type: 'ANNUAL',
      transaction_type: 'adjustment',
      days: '5',
      effective_date: '2026-01-01',
    });
  });

  it('(ii) a real Excel date cell arrives as YYYY-MM-DD', async () => {
    // A genuine JS Date in the cell mimics a user typing a date Excel stores as a date serial.
    const buf = aoaToXlsxBuffer([
      ['Employee ID', 'Leave Type', 'Transaction Type', 'Days', 'Effective Date'],
      ['E1001', 'ANNUAL', 'accrual', '14', new Date(2026, 0, 1)],
    ]);
    const csv = await workbookToCsvText(buf);
    const { records } = parseCsvRecords(csv);
    expect(records[0].effective_date).toBe('2026-01-01');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(records[0].effective_date)).toBe(true);
  });

  it('(iii) negative days survive un-mangled (no formula-guard prefix)', async () => {
    const buf = aoaToXlsxBuffer([
      ['Employee ID', 'Leave Type', 'Transaction Type', 'Days', 'Effective Date'],
      ['E1001', 'ANNUAL', 'debit', '-2', '2026-03-14'],
    ]);
    const csv = await workbookToCsvText(buf);
    const { records } = parseCsvRecords(csv);
    expect(records[0].days).toBe('-2');
    expect(Number(records[0].days)).toBe(-2);
  });

  it('(iv) reads the FIRST worksheet when several exist', async () => {
    const ws1 = XLSX.utils.aoa_to_sheet([
      ['Employee ID', 'Leave Type', 'Transaction Type', 'Days', 'Effective Date'],
      ['E2001', 'ANNUAL', 'adjustment', '3', '2026-02-01'],
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet([['ignored'], ['should-not-appear']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'First');
    XLSX.utils.book_append_sheet(wb, ws2, 'Second');
    const u8 = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    const csv = await workbookToCsvText(buf);
    const { records } = parseCsvRecords(csv);
    expect(records).toHaveLength(1);
    expect(records[0].employee_id).toBe('E2001');
    expect(csv).not.toContain('should-not-appear');
  });

  it('(v) generated .xlsx template round-trips to the required contract columns', async () => {
    const headers = ['Employee ID', 'Leave Type', 'Transaction Type', 'Days', 'Effective Date'];
    const bytes = await buildXlsx(headers, [['E1001', 'ANNUAL', 'adjustment', '5', '2026-01-01']]);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const csv = await workbookToCsvText(buf);
    const { headers: parsedHeaders, records } = parseCsvRecords(csv);
    for (const col of LEAVE_IMPORT_COLUMNS.required) expect(parsedHeaders).toContain(col);
    expect(records[0].employee_id).toBe('E1001');
  });

  it('(vi) an empty first sheet throws EMPTY_SHEET', async () => {
    const buf = aoaToXlsxBuffer([[]]);
    await expect(workbookToCsvText(buf)).rejects.toThrow('EMPTY_SHEET');
  });
});
