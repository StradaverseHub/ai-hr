/**
 * Board d3ba1e9f — screen and Error Log parity for the Personnel imports of part 1: the problem table on screen and
 * the downloaded workbook are drawn from the same adapter lines, so every cell on screen equals the workbook row, in
 * English and in another shipping locale; the download button builds the .xlsx in the browser. Fictional data only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import * as XLSX from 'xlsx';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import { ImportProblems } from '../app/admin/personnel/import/import-error-log';
import { importProblemSheetRows, problemCellSafe } from '../lib/import-problem-workbook';
import { employeePreviewProblemLines } from '../lib/employee-import-problems';
import { sectionPreviewProblemLines } from '../lib/section-import-problems';
import type { ImportProblemTranslate } from '../lib/import-problem-common';
import type { ImportPreview } from '../lib/import-schema';
import type { SectionImportPreview } from '../lib/import-sections';

afterEach(cleanup);
const CATALOGUES = { en, zh } as Record<string, typeof en>;
const tr = (locale: string): ImportProblemTranslate => {
  const root = createTranslator({ locale, messages: CATALOGUES[locale] }), shared = createTranslator({ locale, messages: CATALOGUES[locale], namespace: 'importProblems' });
  return { problems: (k, v) => root(k as never, v as never), shared: (k) => shared(k as never) };
};
const preview: ImportPreview = {
  companyId: 'c', total: 2, validCount: 0, missingColumns: ['hired_on'], fileErrors: [],
  rows: [
    { rowNum: 1, excelRow: 3, employeeCode: 'E1', fullName: 'Fictional Aina', email: '', ok: false, warnings: [], company: 'Acme', errors: ['Missing email', 'Invalid IC "900101015555" (expected 12 digits)'],
      issues: [{ column: 'email', code: 'required', message: 'Missing email' }, { column: 'ic_number', message: 'Invalid IC "900101015555" (expected 12 digits)' }] },
    { rowNum: 2, excelRow: 6, employeeCode: 'E2', fullName: 'Fictional Bala', email: 'b@fixture.test', ok: false, warnings: [], company: 'Acme', errors: ['=cmd|"/c calc"!A1'] },
  ],
  dependents: { total: 0, validCount: 0, missingColumns: [], rows: [] },
};
const sectionPreview = { section: 'family', total: 1, updateCount: 0, skipCount: 0, createCount: 0, missingColumns: [], fileErrors: ['Column "email" belongs to the Profile section, not this one.'],
  rows: [{ rowNum: 1, excelRow: 2, employeeCode: 'F1', employeeName: 'Fictional Chen', verdict: 'update', ok: false, warnings: [], changes: [], errors: ['Missing relationship'], issues: [{ column: 'relationship', code: 'required', message: 'Missing relationship' }] }] } as unknown as SectionImportPreview;

const cellsOnScreen = () => within(screen.getByRole('table')).getAllByRole('row').map((row) => within(row).queryAllByRole(row.querySelector('th') ? 'columnheader' : 'cell').map((c) => c.textContent ?? ''));

describe.each(['en', 'zh'])('%s · the screen says exactly what the Error Log says', (locale) => {
  it.each([
    ['Everything', () => employeePreviewProblemLines(preview, tr(locale))],
    ['Family section', () => sectionPreviewProblemLines(sectionPreview, tr(locale))],
  ])('%s', (_name, build) => {
    const lines = build();
    expect(lines.length).toBeGreaterThan(1);
    render(<NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}><ImportProblems lines={lines} fileName="fixture.xlsx" title="t" /></NextIntlClientProvider>);
    expect(cellsOnScreen()).toEqual(importProblemSheetRows({ lines, t: tr(locale).shared }));
    expect(document.body.textContent).not.toContain('900101015555');
  });
});

describe('the Error Log button', () => {
  it('builds the workbook in the browser from the same lines', async () => {
    const lines = employeePreviewProblemLines(preview, tr('en'));
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => { blob = b; return 'blob:fixture'; });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<NextIntlClientProvider locale="en" messages={en}><ImportProblems lines={lines} fileName="staff list.xlsx" title="t" /></NextIntlClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: en.importProblems.downloadLog }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob!); });
    const wb = XLSX.read(new Uint8Array(bytes), { type: 'array' });
    // The same strings, each guarded against formula injection in the file.
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Errors, { header: 1, raw: false, defval: '' })).toEqual(importProblemSheetRows({ lines, t: tr('en').shared }).map((row) => row.map(problemCellSafe)));
    // The formula guard: a cell from the file never becomes a formula.
    expect(JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Errors, { header: 1 }))).toContain("'=cmd");
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('staff list-error-log.xlsx');
    click.mockRestore();
  });
});
