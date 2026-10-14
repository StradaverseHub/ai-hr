import * as XLSX from 'xlsx';
import { LABEL_IMPORT_DEFINITIONS, type LabelImportRow, type LabelImportPreviewRow } from './system-label-definition';

export const LABEL_WORKBOOK_MAX_BYTES = 750_000;
export const LABEL_WORKBOOK_MAX_ROWS = 500;
const safe = (s: string) => /^[\s]*[=+@-]/.test(s) ? "'" + s : s;

export function systemLabelTemplate(references: { companies: string[][]; grades: string[][]; employees: string[][] }): Buffer {
  const wb = XLSX.utils.book_new();
  const instructions = [
    ['System Labels — Organisation Labels'],
    ['Keep worksheet names and headers. Enter literal values; formulas are refused. Maximum 500 data rows, 750 KB.'],
    ['Company uses the exact company name from Reference (or its ID when names are ambiguous). Company is required for company-linked labels.'],
    ['Scope: own, shared, or global. Shared Companies: exact company names separated by semicolons. Global requires a group administrator.'],
    ['Company and scope identify the existing record; Update Existing never changes them. Blank Company does not mean Global.'],
    ['Division through Category, Grades and Grade Groups are tenant-wide; they have no Company or Scope column.'],
    ['Code is the existing identifier. Department Code maps to Name; Position Code maps to Title.'],
    ['Cost Centre and Business Unit Description are required names. Other descriptions and labels are optional.'],
    ['Head Employee Code must belong to the origin company. Blank clears the head in Update Existing.'],
    ['Grade Codes contains existing active grade codes separated by semicolons. Create grades before importing their groups.'],
    ['Add New skips exact duplicates and refuses conflicting records. Update Existing changes only editable fields after confirmation.'],
    ['Archived or inactive records must be restored in the editor before importing. No deletion or archiving is performed.'],
    ['Sort Order and Rank are whole numbers. Blank means zero. Blank Label for profile options means Code.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  for (const d of LABEL_IMPORT_DEFINITIONS) {
    const ws = XLSX.utils.aoa_to_sheet([d.columns]);
    ws['!cols'] = d.columns.map(() => ({ wch: 24 }));
    for(let row=1;row<=LABEL_WORKBOOK_MAX_ROWS;row++)for(let col=0;col<d.columns.length;col++) {
      if(d.columns[col]==='Rank'||d.columns[col]==='Sort Order')continue;
      ws[XLSX.utils.encode_cell({r:row,c:col})]={t:'s',v:'',z:'@'};
    }
    ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:LABEL_WORKBOOK_MAX_ROWS,c:d.columns.length-1}});
    XLSX.utils.book_append_sheet(wb, ws, d.kind);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Company Name', 'Company ID'], ...references.companies.map(r => r.map(safe)), [],
    ['Grades: Code', 'Label'], ...references.grades.map(r => r.map(safe)), [],
    ['Head Employee Code', 'Company ID', 'Name'], ...references.employees.map(r => r.map(safe)),
  ]), 'Reference');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** Bound ZIP expansion before the spreadsheet parser allocates worksheet strings. No ZIP64/encryption. */
function checkZip(bytes: Buffer) {
  if (bytes.length > LABEL_WORKBOOK_MAX_BYTES || bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50)
    throw new Error('Upload an .xlsx file no larger than 750 KB.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Invalid Excel archive.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16), expanded = 0;
  if (count > 160 || count === 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw new Error('Unsupported Excel archive.');
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50 || (bytes.readUInt16LE(offset + 8) & 1))
      throw new Error('Invalid or encrypted Excel archive.');
    expanded += bytes.readUInt32LE(offset + 24);
    if (expanded > 8_000_000) throw new Error('Excel workbook expands beyond the supported size.');
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (offset !== end) throw new Error('Unsupported Excel archive directory.');
}

export function readSystemLabelWorkbook(bytes: Buffer): LabelImportRow[] {
  checkZip(bytes);
  const wb = XLSX.read(bytes, { type: 'buffer', cellFormula: true, sheetRows: LABEL_WORKBOOK_MAX_ROWS + 2 });
  if (wb.SheetNames.length > LABEL_IMPORT_DEFINITIONS.length + 2) throw new Error('Too many worksheets.');
  const rows: LabelImportRow[] = [], seen = new Set<string>();
  for (const sheet of wb.SheetNames) {
    if (sheet === 'Instructions' || sheet === 'Reference') continue;
    const definition = LABEL_IMPORT_DEFINITIONS.find(d => d.kind === sheet);
    if (!definition || seen.has(sheet)) throw new Error(`Unknown or duplicate label worksheet: ${sheet}`);
    seen.add(sheet);
    const ws = wb.Sheets[sheet];
    const range = XLSX.utils.decode_range(ws['!fullref'] ?? ws['!ref'] ?? 'A1');
    if (range.e.r > LABEL_WORKBOOK_MAX_ROWS || range.e.c >= definition.columns.length)
      throw new Error(`Worksheet ${sheet} exceeds the row or column limit.`);
    for (const [key, cell] of Object.entries(ws)) if (!key.startsWith('!') && cell?.f)
      throw new Error(`Formula in ${sheet}!${key}. Enter a literal value.`);
    const values = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: true });
    if (JSON.stringify(values[0]) !== JSON.stringify(definition.columns)) throw new Error(`Headers do not match the template in ${sheet}.`);
    for (let i = 1; i < values.length; i++) {
      if (!values[i].some(v => String(v).trim())) continue;
      if (rows.length >= LABEL_WORKBOOK_MAX_ROWS) throw new Error('Maximum 500 data rows per import.');
      const fields = Object.fromEntries(definition.columns.map((c, n) => [c, String(values[i][n] ?? '').trim()]));
      if (Object.values(fields).some(v => v.length > 1000)) throw new Error(`A value is too long in ${sheet}, row ${i + 1}.`);
      rows.push({ sheet, row: i + 1, values: fields });
    }
  }
  return rows;
}

export function systemLabelErrorWorkbook(rows: LabelImportPreviewRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Worksheet', 'Row', 'Result', 'Message', 'Values'],
    ...rows.filter(r => r.outcome === 'error').map(r => [r.sheet, r.row, r.outcome, safe(r.message), safe(JSON.stringify(r.values))]),
  ]), 'Errors');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}
