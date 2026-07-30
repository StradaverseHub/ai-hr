/**
 * Employee import — Excel (.xlsx) template and reader. Item d8471481.
 *
 * The whole ticket is one class of corruption: a spreadsheet turns an IDENTIFIER into a NUMBER.
 * `0123456789` typed into a General cell is stored as 123456789 and the leading zero is gone from
 * the file; a 16-digit account can be re-saved as `1.23457E+15`. Neither is recoverable at read time,
 * so the fix has two halves and this file asserts both:
 *
 *   READ  — never emit exponential notation, and read a real Excel date cell as YYYY-MM-DD
 *           (lib/spreadsheet: numberToPlainString + cellDates).
 *   WRITE — the template pre-formats the identity columns as TEXT (`z: '@'`), which is what stops
 *           Excel destroying the value in the first place.
 *
 * Pure node tests (no DB harness). §5 is the helper-key guard: `t(importFileMessageKey(e))` is a
 * COMPUTED key, and test/i18n-coverage.test.ts check C only resolves literal ones — so every value
 * the helper can return is resolved here, in all six locales, by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseCsvRecords } from '../lib/csv';
import { workbookToCsvText, buildXlsx, numberToPlainString } from '../lib/spreadsheet';
import { IMPORT_COLUMNS } from '../lib/import-schema';
import { employeeTemplate } from '../lib/import-template';
import {
  employeeColumnLabel,
  employeeTextColumnIndexes,
  buildReferenceRows,
  buildInstructionRows,
  EMPLOYEE_ENUM_VALUES,
  EMPLOYEE_TEXT_COLUMN_KEYS,
  EMPLOYEE_XLSX_COLUMNS,
  EMPLOYEE_XLSX_HEADERS,
  EMPLOYEE_XLSX_SHEETS,
} from '../lib/import-template-xlsx';
import {
  IMPORT_FILE_ACCEPT,
  IMPORT_FILE_MESSAGE_KEYS,
  ImportFileError,
  importFileFormat,
  importFileMessageKey,
  readImportFile,
} from '../lib/import-file';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** Array-of-arrays → .xlsx ArrayBuffer, the shape File.arrayBuffer() hands back. */
function aoaToXlsxBuffer(aoa: unknown[][], sheetName = 'Sheet1'): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const u8 = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function xlsxFile(bytes: Uint8Array | ArrayBuffer, name = 'employees.xlsx'): File {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new File([u8 as BlobPart], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function csvFile(text: string, name = 'employees.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

/** The exact bytes the "Download Excel template" button writes. */
function buildEmployeeTemplateXlsx(): Promise<Uint8Array> {
  return buildXlsx([...EMPLOYEE_XLSX_HEADERS], employeeTemplate.sampleRows, {
    sheetName: EMPLOYEE_XLSX_SHEETS.data,
    textColumns: employeeTextColumnIndexes(),
    extraSheets: [
      {
        name: EMPLOYEE_XLSX_SHEETS.reference,
        rows: buildReferenceRows('Accepted values', [
          { label: 'Company', values: ['ABC Sdn Bhd', 'XYZ Sdn Bhd'] },
          { label: 'Department', values: ['Finance', 'Operations'] },
          { label: 'Position', values: [] },
        ]),
      },
      {
        name: EMPLOYEE_XLSX_SHEETS.instructions,
        rows: buildInstructionRows('How to fill in this template', ['line one', 'line two']),
      },
    ],
  });
}

// ── §1 no scientific notation, ever ────────────────────────────────────────────────────────────────
describe('§1 identity numbers never arrive in exponential notation', () => {
  it('numberToPlainString expands every integer positionally', () => {
    expect(numberToPlainString(900101011234)).toBe('900101011234');
    expect(numberToPlainString(0)).toBe('0');
    expect(numberToPlainString(5)).toBe('5');
    // Past 1e21 String() switches to exponential — this is the case the helper exists for.
    expect(String(1e21)).toContain('e');
    expect(numberToPlainString(1e21)).not.toContain('e');
    expect(numberToPlainString(1e21)).toMatch(/^10{21}$/);
    // Real decimals are left readable (a leave `days` of 1.5 goes through the same path).
    expect(numberToPlainString(1.5)).toBe('1.5');
    expect(numberToPlainString(-2)).toBe('-2');
  });

  it('a huge numeric bank account cell reads back as plain digits', async () => {
    const buf = aoaToXlsxBuffer([
      ['full_name', 'bank_account_no'],
      ['Nadia Yusof', 1e21],
    ]);
    const { records } = parseCsvRecords(await workbookToCsvText(buf));
    expect(records[0].bank_account_no).not.toContain('e');
    expect(records[0].bank_account_no).toMatch(/^\d+$/);
  });

  it('a 12-digit IC stored as a NUMBER still validates as 12 digits', async () => {
    const buf = aoaToXlsxBuffer([
      ['full_name', 'ic_number'],
      ['Nadia Yusof', 910505051234],
    ]);
    const { records } = parseCsvRecords(await workbookToCsvText(buf));
    // This is exactly what core/import's pack.statutory.validateIC receives.
    expect(records[0].ic_number).toBe('910505051234');
    expect(/^\d{12}$/.test(records[0].ic_number)).toBe(true);
  });
});

// ── §2 real Excel date cells, and text cells that keep their leading zeros ─────────────────────────
describe('§2 dates and leading zeros survive the read', () => {
  it('a real Excel date cell becomes the engine`s YYYY-MM-DD', async () => {
    const buf = aoaToXlsxBuffer([
      ['full_name', 'hired_on'],
      ['Nadia Yusof', new Date(2026, 5, 1)],
    ]);
    const { records } = parseCsvRecords(await workbookToCsvText(buf));
    expect(records[0].hired_on).toBe('2026-06-01');
    // The engine's DATE_RE (core/import.ts) is the real consumer.
    expect(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(records[0].hired_on)).toBe(true);
  });

  it('a TEXT-formatted cell keeps its leading zeros verbatim', async () => {
    // What a text-typed column produces: SheetJS hands back a string, untouched.
    const ws = XLSX.utils.aoa_to_sheet([
      ['full_name', 'bank_account_no', 'phone'],
      ['Nadia Yusof', '0123456789', '0198887777'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const u8 = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const { records } = parseCsvRecords(await workbookToCsvText(u8));
    expect(records[0].bank_account_no).toBe('0123456789');
    expect(records[0].phone).toBe('0198887777');
  });
});

// ── §3 the template writes text-typed identity columns ────────────────────────────────────────────
describe('§3 the downloaded Excel template', () => {
  it('has the three sheets, data sheet FIRST (workbookToCsvText reads sheet 1)', async () => {
    const wb = XLSX.read(await buildEmployeeTemplateXlsx(), { type: 'array' });
    expect(wb.SheetNames[0]).toBe(EMPLOYEE_XLSX_SHEETS.data);
    expect(wb.SheetNames).toContain(EMPLOYEE_XLSX_SHEETS.reference);
    expect(wb.SheetNames).toContain(EMPLOYEE_XLSX_SHEETS.instructions);
  });

  it('formats every identity column as TEXT, well below the header AND on empty rows', async () => {
    const wb = XLSX.read(await buildEmployeeTemplateXlsx(), { type: 'array', cellNF: true });
    const ws = wb.Sheets[EMPLOYEE_XLSX_SHEETS.data];
    for (const c of employeeTextColumnIndexes()) {
      // Row 1 = the first sample row; row 400 is far below anything we wrote, i.e. a row HR will
      // type into. Both must already be text, or Excel eats the leading zero on entry.
      for (const r of [1, 2, 400]) {
        const cell = ws[XLSX.utils.encode_cell({ c, r })] as { z?: string; t?: string } | undefined;
        expect(cell, `column ${c} row ${r} must exist so it can carry a format`).toBeTruthy();
        expect(cell!.z).toBe('@');
        expect(cell!.t).toBe('s');
      }
    }
  });

  it('leaves the MONEY columns numeric — forcing them to text would stop Excel summing them', async () => {
    const wb = XLSX.read(await buildEmployeeTemplateXlsx(), { type: 'array', cellNF: true });
    const ws = wb.Sheets[EMPLOYEE_XLSX_SHEETS.data];
    for (const key of ['basic_salary', 'monthly_allowance', 'rate_amount', 'tax_category']) {
      expect(EMPLOYEE_TEXT_COLUMN_KEYS).not.toContain(key);
      const c = EMPLOYEE_XLSX_COLUMNS.indexOf(key);
      // NB: with cellNF an UNFORMATTED cell reads back as 'General', not undefined — verified in
      // Node. The assertion that matters is that it is not TEXT.
      const cell = ws[XLSX.utils.encode_cell({ c, r: 1 })] as { z?: string } | undefined;
      expect(cell?.z).not.toBe('@');
    }
  });

  it('round-trips: template → workbookToCsvText → parseCsvRecords gives the exact contract keys', async () => {
    const bytes = await buildEmployeeTemplateXlsx();
    const out = await readImportFile(xlsxFile(bytes, 'employee-import-template.xlsx'));
    expect(out.format).toBe('xlsx');
    const { headers, records } = parseCsvRecords(out.text);
    // The human labels must normalise back to the snake_case contract, or the column silently vanishes.
    expect(headers).toEqual([...EMPLOYEE_XLSX_COLUMNS]);
    for (const col of IMPORT_COLUMNS.required) expect(headers).toContain(col);
    // The 500 blank pre-formatted rows must NOT become 500 empty records.
    expect(records.length).toBe(employeeTemplate.sampleRows.length);
    expect(records[0].full_name).toBe(employeeTemplate.sampleRows[0][0]);
  });
});

// ── §4 the label ↔ key round trip, and the drift locks ────────────────────────────────────────────
describe('§4 labels and contract cannot drift', () => {
  it('every human label lowercases-and-underscores back to its own column key', () => {
    // parseCsvRecords does exactly `h.trim().toLowerCase().replace(/\s+/g, '_')` on each header.
    for (const key of EMPLOYEE_XLSX_COLUMNS) {
      const label = employeeColumnLabel(key);
      expect(label.trim().toLowerCase().replace(/\s+/g, '_'), `label "${label}"`).toBe(key);
    }
    // And the acronyms actually read as acronyms rather than "Ic Number".
    expect(employeeColumnLabel('ic_number')).toBe('IC Number');
    expect(employeeColumnLabel('epf_number')).toBe('EPF Number');
    expect(employeeColumnLabel('socso_number')).toBe('SOCSO Number');
    expect(employeeColumnLabel('eis_eligible')).toBe('EIS Eligible');
  });

  it('the xlsx columns ARE the enforced contract, in order', () => {
    expect([...EMPLOYEE_XLSX_COLUMNS]).toEqual([
      ...IMPORT_COLUMNS.required,
      ...IMPORT_COLUMNS.optional,
    ]);
    expect(EMPLOYEE_XLSX_HEADERS.length).toBe(EMPLOYEE_XLSX_COLUMNS.length);
    // Every text column is a real column.
    for (const k of EMPLOYEE_TEXT_COLUMN_KEYS) expect(EMPLOYEE_XLSX_COLUMNS).toContain(k);
  });

  it('the Reference sheet enumerations match what core/import actually accepts', () => {
    // The enums are hardcoded in BOTH files because they are code-level, not configuration. This
    // reads the validator's source so a change there fails here instead of shipping a template that
    // advertises a value the importer rejects.
    const src = readFileSync(new URL('../core/import.ts', import.meta.url), 'utf8');
    for (const v of EMPLOYEE_ENUM_VALUES.employment_type) expect(src).toContain(`'${v}'`);
    for (const v of EMPLOYEE_ENUM_VALUES.pay_mode) expect(src).toContain(`'${v}'`);
    for (const v of EMPLOYEE_ENUM_VALUES.epf_citizenship) expect(src).toContain(`'${v}'`);
    expect(src).toContain("['monthly', 'daily', 'hourly', 'custom_period']");
    expect(src).toContain('tax_category must be 1, 2 or 3');
  });

  it('the reference sheet renders an em dash rather than nothing for an empty catalog', () => {
    const rows = buildReferenceRows('H', [{ label: 'Position', values: [] }]);
    expect(rows.flat()).toContain('—');
  });
});

// ── §5 the reader: what it accepts, and every error it can raise ──────────────────────────────────
describe('§5 readImportFile after the .xlsx widening', () => {
  it('the accept attribute advertises exactly what the reader takes', () => {
    for (const ext of ['.csv', '.xlsx', '.xls']) expect(IMPORT_FILE_ACCEPT).toContain(ext);
    expect(importFileFormat('employees.XLSX')).toBe('xlsx');
    expect(importFileFormat('employees.xls')).toBe('xls');
    expect(importFileFormat('employees.csv')).toBe('csv');
    expect(importFileFormat('employees.txt')).toBe(null);
    expect(importFileFormat('employees.csv.pdf')).toBe(null);
  });

  it('still strips the UTF-8 BOM Excel writes, so full_name is not read as missing', async () => {
    // THE regression this guards: with the BOM intact the first header is "﻿full_name", and
    // full_name is REQUIRED — so a perfectly good file reports a missing required column.
    const out = await readImportFile(csvFile('﻿full_name,email\nNadia,n@demo.test\n'));
    const { headers } = parseCsvRecords(out.text);
    expect(headers[0]).toBe('full_name');
    expect(out.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('rejects a non-import file, and reports an empty first worksheet distinctly', async () => {
    await expect(readImportFile(new File(['x'], 'notes.txt'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
    const empty = aoaToXlsxBuffer([[], ['', '']]);
    await expect(readImportFile(xlsxFile(empty))).rejects.toMatchObject({ code: 'EMPTY_SHEET' });
  });

  it('reads the FIRST worksheet — the data sheet, not Reference or Instructions', async () => {
    const bytes = await buildEmployeeTemplateXlsx();
    const { headers } = parseCsvRecords((await readImportFile(xlsxFile(bytes))).text);
    expect(headers).toContain('full_name');
    expect(headers).not.toContain('accepted_values');
  });

  it('every key importFileMessageKey can return resolves in all six locales', () => {
    // The helper-key hole: test/i18n-coverage.test.ts check C only matches LITERAL t('…') keys, so
    // t(importFileMessageKey(e)) is invisible to it. This is the replacement guard.
    const keys = new Set<string>(Object.values(IMPORT_FILE_MESSAGE_KEYS));
    for (const code of ['UNSUPPORTED_FILE_TYPE', 'FILE_TOO_LARGE', 'EMPTY_FILE', 'EMPTY_SHEET', 'FILE_READ_FAILED'] as const) {
      keys.add(importFileMessageKey(new ImportFileError(code)));
    }
    keys.add(importFileMessageKey(new TypeError('some browser noise')));
    expect(keys.has('emptySheet')).toBe(true);
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(new URL(`../messages/${loc}.json`, import.meta.url), 'utf8'));
      for (const k of keys) {
        const v = msgs.people?.import?.[k];
        expect(typeof v, `${loc}.people.import.${k}`).toBe('string');
        expect(String(v).trim(), `${loc}.people.import.${k}`).not.toBe('');
      }
    }
  });

  it('every literal key the import screen adds exists in all six locales', () => {
    const added = [
      'downloadTemplateXlsx',
      'downloadErrors',
      'colCompany',
      'colRow',
      'referenceHeading',
      'instructionsHeading',
      'instructionRequired',
      'instructionDates',
      'instructionIdentityText',
      'instructionCompany',
      'instructionReference',
      'instructionSamples',
    ];
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(new URL(`../messages/${loc}.json`, import.meta.url), 'utf8'));
      for (const k of added) {
        expect(String(msgs.people?.import?.[k] ?? '').trim(), `${loc}.people.import.${k}`).not.toBe('');
      }
      // The two interpolated ones must keep their placeholders in every language.
      expect(msgs.people.import.instructionRequired).toContain('{columns}');
      expect(msgs.people.import.resolveHint).toContain('{company}');
    }
  });
});
