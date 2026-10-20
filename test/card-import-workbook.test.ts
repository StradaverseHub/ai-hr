import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { buildCardImportWorkbook, readCardImportWorkbook } from '../lib/card-import-workbook';
import { validateCardImportRows } from '../lib/card-import';

function workbook(change: (ws: XLSX.WorkSheet, wb: XLSX.WorkBook) => void) {
  const wb = XLSX.read(buildCardImportWorkbook([{ employeeCode: '0007', cardId: '0010' }]), { type: 'buffer' });
  change(wb.Sheets['Card Assignments'], wb);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}
describe('Card Assignment workbook contract', () => {
  it('round-trips literal leading zeros and formats the entire entry area as text', () => {
    const bytes = buildCardImportWorkbook([{ employeeCode: '0007', cardId: '0010' }]);
    expect(readCardImportWorkbook(bytes)).toEqual([{ row: 3, employeeCode: '0007', cardId: '0010', operation: 'assign', invalidCell: false }]);
    const ws = XLSX.read(bytes, { type: 'buffer', cellNF: true }).Sheets['Card Assignments'];
    expect(ws.A502?.z).toBe('@'); expect(ws.B502?.z).toBe('@');
  });
  it('a blank template imports no illustrative employee', () => {
    expect(() => readCardImportWorkbook(buildCardImportWorkbook())).toThrow('emptyWorkbook');
  });
  it('localizes human instructions while retaining the literal template schema and identifiers', () => {
    const bytes = buildCardImportWorkbook([{ employeeCode: '0007', cardId: '0010' }], ['வழிமுறைகள்', 'assign: உரையாக உள்ளிடவும்']);
    const wb = XLSX.read(bytes, { type: 'buffer' });
    expect(wb.Sheets.Instructions.A1.v).toBe('வழிமுறைகள்');
    expect(wb.Sheets['Card Assignments'].A2.v).toBe('Employee ID');
    expect(readCardImportWorkbook(bytes)[0]).toMatchObject({ employeeCode: '0007', cardId: '0010', operation: 'assign' });
  });
  it('numeric identifiers are refused rather than guessing their lost zeros', () => {
    const inputs = readCardImportWorkbook(workbook(ws => { ws.A3 = { t: 'n', v: 7 }; }));
    expect(validateCardImportRows(inputs)[0].issues).toContain('literalText');
  });
  it.each(['A3', 'B3', 'C3'])('refuses formulas in %s, even with cached literal results', address => {
    expect(() => readCardImportWorkbook(workbook(ws => { ws[address] = { t: 's', v: '0007', f: '"0007"' }; }))).toThrow('invalidWorkbook');
  });
  it('refuses changed versions, headers, extra data and non-template sheets', () => {
    for (const edit of [
      (ws: XLSX.WorkSheet) => { ws.A1.v = 'v999'; },
      (ws: XLSX.WorkSheet) => { ws.B2.v = 'Employee ID'; },
      (ws: XLSX.WorkSheet) => { ws.D3 = { t: 's', v: 'unexpected' }; ws['!ref'] = 'A1:D502'; },
      (_: XLSX.WorkSheet, wb: XLSX.WorkBook) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignored employee']]), 'Other'),
    ]) expect(() => readCardImportWorkbook(workbook(edit))).toThrow();
  });
  it('refuses hidden external relationships', async () => {
    const zip = await JSZip.loadAsync(buildCardImportWorkbook([{ employeeCode: '0007', cardId: '0010' }]));
    const path = 'xl/_rels/workbook.xml.rels';
    const rels = await zip.file(path)!.async('string');
    zip.file(path, rels.replace('</Relationships>', '<Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://example.com/private" TargetMode="External"/></Relationships>'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => readCardImportWorkbook(bytes)).toThrow();
  });
  it('refuses repeated worksheet cell addresses rather than choosing a hidden first or last value', async () => {
    const zip = await JSZip.loadAsync(buildCardImportWorkbook([{ employeeCode: '0007', cardId: '0010' }]));
    const path = 'xl/worksheets/sheet1.xml', xml = await zip.file(path)!.async('string');
    const cell = xml.match(/<c\b[^>]*\br="A3"[^>]*>[\s\S]*?<\/c>/)?.[0];
    expect(cell).toBeTruthy();
    zip.file(path, xml.replace('</sheetData>', `<row r="3">${cell}</row></sheetData>`));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => readCardImportWorkbook(bytes)).toThrow('invalidWorkbook');
  });
  it('refuses oversized archive inflation before the workbook parser receives it', async () => {
    const zip = await JSZip.loadAsync(buildCardImportWorkbook([{ employeeCode: '0007', cardId: '0010' }]));
    zip.file('xl/oversized.xml', '<padding>' + 'x'.repeat(12 * 1024 * 1024) + '</padding>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(() => readCardImportWorkbook(bytes)).toThrow();
  });
  it('refuses non-workbook bytes and rows beyond the declared entry area', () => {
    expect(() => readCardImportWorkbook(Buffer.from('Employee ID,Card ID,Operation\n0007,0010,assign'))).toThrow();
    expect(() => readCardImportWorkbook(workbook(ws => {
      ws.A503 = { t: 's', v: 'outside' }; ws['!ref'] = 'A1:C503';
    }))).toThrow('tooManyRows');
  });
  it('detects case-insensitive duplicates before selecting valid rows', () => {
    const rows = validateCardImportRows([
      { row: 3, employeeCode: 'E1', cardId: 'card1', operation: 'assign' },
      { row: 4, employeeCode: 'e1', cardId: 'CARD1', operation: 'assign' },
    ]);
    expect(rows.every(r => r.issues.includes('duplicateEmployee') && r.issues.includes('duplicateCard'))).toBe(true);
  });
  it('blank Card ID is unchanged; clearing is an explicit operation', () => {
    const [row] = validateCardImportRows([{ row: 3, employeeCode: 'E1', cardId: '', operation: 'assign' }]);
    expect(row.issues).toEqual([]);
    expect(validateCardImportRows([{ row: 3, employeeCode: 'E1', cardId: 'new', operation: 'reset' }])[0].issues).toContain('resetHasCard');
  });
});
