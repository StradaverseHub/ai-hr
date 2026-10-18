import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PAY_COMPONENT_WORKBOOK_LAYOUT as layout } from './pay-component-workbook-layout';
import { PAY_ITEM_COLUMNS, PAY_ITEM_SYSTEM_KEYS, PAY_ITEM_MAX_BYTES, PAY_ITEM_MAX_ROWS, normalizePayItemHeader,
  type PayItemField, type PayItemPreviewRow, type PayItemUploadRow, type PayItemVocabulary } from './pay-component-import';

export class PayItemWorkbookError extends Error {
  constructor(public readonly code: 'tooLarge' | 'invalidWorkbook' | 'tooManyRows' | 'missingSheet' | 'missingHeader' | 'duplicateHeader' | 'emptyWorkbook', public readonly field?: string) {
    super(`pay-item-workbook:${code}`); this.name = 'PayItemWorkbookError';
  }
}

/** Bound central-directory expansion BEFORE SheetJS/JSZip inflate anything. No encryption/ZIP64. */
export function checkPayItemArchive(bytes: Buffer) {
  if (bytes.length > PAY_ITEM_MAX_BYTES) throw new PayItemWorkbookError('tooLarge');
  const bad = () => { throw new PayItemWorkbookError('invalidWorkbook'); };
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return bad();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return bad();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 256 || start > end || bytes.readUInt32LE(end + 12) !== end - start || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) return bad();
  let offset = start, expanded = 0; const names = new Set<string>();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 8) & 1) return bad();
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (names.has(name) || /vbaProject|externalLinks|embeddings|\.\.\//i.test(name)) return bad();
    names.add(name);
    expanded += bytes.readUInt32LE(offset + 24);
    if (expanded > 40 * 1024 * 1024 || bytes.readUInt32LE(offset + 42) >= start) return bad();
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) return bad();
}

export function readPayItemWorkbook(bytes: Buffer): PayItemUploadRow[] {
  checkPayItemArchive(bytes);
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(bytes, { type: 'buffer', sheets: ['Pay Items'], cellFormula: true }); }
  catch { throw new PayItemWorkbookError('invalidWorkbook'); }
  const ws = wb.Sheets['Pay Items'];
  if (!ws) throw new PayItemWorkbookError('missingSheet');
  const range = XLSX.utils.decode_range(ws['!fullref'] ?? ws['!ref'] ?? 'A1');
  const columns = new Map<PayItemField, number>();
  for (let c = 0; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c })];
    if (cell?.f) throw new PayItemWorkbookError('invalidWorkbook');
    const key = normalizePayItemHeader(String(cell?.v ?? ''));
    const definition = PAY_ITEM_COLUMNS.find(([, header]) => normalizePayItemHeader(header) === key);
    if (!definition) continue;
    if (columns.has(definition[0])) throw new PayItemWorkbookError('duplicateHeader', definition[1]);
    columns.set(definition[0], c);
  }
  for (const [field, header] of PAY_ITEM_COLUMNS) if (!columns.has(field)) throw new PayItemWorkbookError('missingHeader', header);
  const rows: PayItemUploadRow[] = [];
  // Count actual imported data rows, not formatting or blank gaps. Never iterate a million-row !ref.
  const importedColumns = new Set(columns.values()), candidateRows = new Set<number>();
  for (const [address, cell] of Object.entries(ws)) {
    if (address.startsWith('!')) continue;
    const position = XLSX.utils.decode_cell(address);
    if (position.r < 2 || !importedColumns.has(position.c) || !cell?.f && String(cell?.v ?? '').trim() === '') continue;
    candidateRows.add(position.r);
    if (candidateRows.size > PAY_ITEM_MAX_ROWS) throw new PayItemWorkbookError('tooManyRows');
  }
  for (const r of [...candidateRows].sort((a, b) => a - b)) {
    const values = {} as Record<PayItemField, string>, formulaFields: PayItemField[] = [];
    for (const [field] of PAY_ITEM_COLUMNS) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: columns.get(field)! })];
      if (cell?.f) formulaFields.push(field);
      const value = cell?.v;
      values[field] = value == null ? '' : String(value).trim();
      if (values[field].length > 1000) throw new PayItemWorkbookError('invalidWorkbook');
    }
    if (!formulaFields.length && Object.values(values).every(v => !v)) continue;
    rows.push({ row: r + 1, values, formulaFields });
    if (rows.length > PAY_ITEM_MAX_ROWS) throw new PayItemWorkbookError('tooManyRows');
  }
  if (!rows.length) throw new PayItemWorkbookError('emptyWorkbook');
  return rows;
}

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlValue = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrs = (node: string) => Object.fromEntries([...node.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], xmlValue(m[2])]));

/** Preserve every original workbook part; append literal inline result cells to the named data sheet.
 * No recalculation, SheetJS reserialization or overwrite of the uploaded file. */
export async function payItemErrorWorkbook(bytes: Buffer, rows: PayItemPreviewRow[], message: (code: string) => string): Promise<Buffer> {
  checkPayItemArchive(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbook || !rels) throw new PayItemWorkbookError('invalidWorkbook');
  const sheet = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\/>/g)].map(m => attrs(m[0])).find(a => a.name === 'Pay Items');
  const rel = [...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/>/g)].map(m => attrs(m[0])).find(a => a.Id === sheet?.['r:id']);
  const target = rel?.Target?.replace(/^\//, '');
  if (!target || target.includes('..') || rel?.TargetMode === 'External') throw new PayItemWorkbookError('invalidWorkbook');
  const part = target.startsWith('xl/') ? target : `xl/${target}`;
  const entry = zip.file(part); if (!entry) throw new PayItemWorkbookError('invalidWorkbook');
  let xml = await entry.async('string');
  const ws = XLSX.read(bytes, { type: 'buffer', sheets: ['Pay Items'] }).Sheets['Pay Items'];
  const range = XLSX.utils.decode_range(ws['!fullref'] ?? ws['!ref'] ?? 'A1');
  const column = XLSX.utils.encode_col(Math.max(19, range.e.c) + 1);
  const results = new Map(rows.map(r => [r.row, [...r.errors.map(e => `${PAY_ITEM_COLUMNS.find(([field]) => field === e.field)?.[1] ?? e.field}: ${message(e.code)}`), ...r.warnings.map(message)].join('; ') || message('valid')]));
  results.set(2, 'Import Result');
  xml = xml.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/g, (all, attributes: string, body: string) => {
    const row = Number(attrs(`<row ${attributes}/>`).r), result = results.get(row);
    if (result === undefined) return all;
    return `<row${attributes}>${body}<c r="${column}${row}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(result)}</t></is></c></row>`;
  });
  const end = `${column}${Math.max(range.e.r + 1, 2)}`;
  xml = xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${end}"/>`);
  zip.file(part, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Eight reference scenarios, expressed with today's accepted codes; no rates/formulas are invented. */
export function payItemExampleRows(vocabulary: PayItemVocabulary): string[][] {
  const label = (field: PayItemField, value: string) => vocabulary[field]?.find(c => c.value === value)?.label ?? value;
  const base = { kind: 'allowance', pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' };
  const scenarios: Record<string, string>[] = [
    { ...base, code: 'A0020', label: 'DIRECTOR FEE', description: 'Director fee', orpUnpaidLeave: 'N', orpOvertime: 'N', prorates: 'N', includedInSocsoEis: 'N', eaFormLine: 'EA_B1B' },
    { ...base, code: 'A0027', label: 'HANDPHONE ALLOWANCE', description: 'Phone allowance', displayCategory: 'allowance', eaFormLine: 'EA_B1A' },
    { ...base, code: 'A0030', label: 'HANDPHONE ALLOWANCE (no EPF)', description: 'Current illustrative taxable classification; review before use', displayCategory: 'allowance', includedInEpf: 'N', eaFormLine: 'EA_B1C' },
    { ...base, code: 'A0040', label: 'MEAL ALLOWANCE', description: 'Current illustrative taxable classification; review before use', displayCategory: 'allowance', eaFormLine: 'EA_B1A' },
    { ...base, code: 'B0010', label: 'ANNUAL BONUS', description: 'Annual performance bonus', displayCategory: 'bonus', orpUnpaidLeave: 'N', orpOvertime: 'N', prorates: 'N', epfBonus2012: 'Y', pcbRemunerationType: 'additional', includedInSocsoEis: 'N', eaFormLine: 'EA_B1B' },
    { ...base, code: 'OT150', label: 'OVERTIME 1.5X', description: 'Complete hourly rate on screen before assigning', displayCategory: 'overtime', orpUnpaidLeave: 'N', orpOvertime: 'N', prorates: 'N', includedInEpf: 'N', inputKind: 'per_hour', eaFormLine: 'EA_B1A' },
    { ...base, code: 'BIK_CAR', label: 'COMPANY CAR BIK', description: 'Benefit-in-kind: company car', kind: 'non_payable', displayCategory: 'bik', orpUnpaidLeave: 'N', orpOvertime: 'N', prorates: 'N', includedInEpf: 'N', includedInSocsoEis: 'N', eaFormLine: 'EA_B3' },
    { code: 'D0100', label: 'STAFF LOAN', description: 'Staff loan monthly instalment', kind: 'deduction', displayCategory: 'deduction', orpUnpaidLeave: 'N', orpOvertime: 'N', prorates: 'N', includedInEpf: 'N', includedInPcb: 'N', includedInSocsoEis: 'N' },
  ];
  return scenarios.map(row => PAY_ITEM_COLUMNS.map(([field]) => row[field] ? label(field, row[field]) : ''));
}

export async function buildPayItemWorkbook(vocabulary: PayItemVocabulary): Promise<Buffer> {
  const wb = XLSX.utils.book_new();
  const instructions = [
    ['Pay Items — Import Template'], ['Enter new codes in Pay Items from row 3; Example is reference only. XLSX only, 5 MB, 1000 data rows.'],
    ['Blank defaults match Create New Pay Code: unpaid-leave ORP N; overtime ORP Y for Earning, otherwise N; fixed input; prorates Y; EPF/SOCSO/PCB Y; EPF Bonus/HRDF N; exact rounding; automatic payroll category.'],
    ['Blank EA defaults to B1(a) for Earning, otherwise Not mapped. An explicit Not mapped is retained. These differ from the older supplied workbook.'],
    ['PCB Y requires a current Remuneration Type and Exemption Type. PCB N requires both blank. Choose from Lists.'],
    ['The older phone/telco and meal exemption labels are not current choices. Corrected examples explicitly illustrate PCB_TAXABLE; Payroll must verify the appropriate classification before migration. No exemption cap or statutory treatment is inferred.'],
    ['Calculated input types are imported pending: complete the real rate, operands or Formula builder before assignment/payroll. No workbook formulas are imported or evaluated.'],
    ['Per-day/per-hour plus Prorates Y is refused by the existing validator (double proration). Warnings do not override financial refusals.'],
    ['All rows must be error-free; confirmation revalidates and creates the entire file in one transaction. Existing active/inactive codes are never updated.'],
    ['Row Check is an Excel aid only, not server validation. Downloaded templates contain 500 formatted entry rows; uploads allow 1000 data rows.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  const band = ['GENERAL INFORMATION', '', '', '', '', '', 'ORP CALCULATION', '', 'CALCULATION', '', '', 'STATUTORY CONFIGURATION', '', '', '', '', '', '', 'EA FORM REPORTING', 'VALIDATION'];
  const headers = [...PAY_ITEM_COLUMNS.map(([, header]) => header), 'Row Check (not imported)'];
  for (const [name, data] of [['Pay Items', []], ['Example', payItemExampleRows(vocabulary)]] as const) {
    const ws = XLSX.utils.aoa_to_sheet([band, headers, ...data]);
    ws['!merges'] = ['A1:F1', 'G1:H1', 'I1:K1', 'L1:R1'].map(XLSX.utils.decode_range);
    for (let r = 2; r < 502; r++) for (let c = 0; c < 20; c++) {
      const address = XLSX.utils.encode_cell({ r, c });
      if (!ws[address]) ws[address] = { t: 's', v: '' };
      if (c === 19) ws[address] = { t: 's', f: layout.rowCheck.replace('"Formula"', `"${(vocabulary.inputKind?.find(choice => choice.value === 'formula')?.label ?? 'Formula').replace(/"/g, '""')}"`).replace(/(?<![A-Z0-9_$])([A-S])3\b/g, `$1${r + 1}`) };
    }
    ws['!ref'] = 'A1:T502';
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const defaultNotes: Partial<Record<PayItemField, string>> = { code: 'Required; A-Z, 0-9, underscore or hyphen; max20', label: 'Required; max60', description: 'Optional; max200', kind: 'Required', archived: 'Active', inputKind: 'Fixed Value', orpUnpaidLeave: 'N (current screen default)', orpOvertime: 'Y for Earning, otherwise N', prorates: 'Y', includedInEpf: 'Y', includedInSocsoEis: 'Y', includedInPcb: 'Y', epfBonus2012: 'N', includedInHrdfBase: 'N', roundingMethod: 'Exact (no rounding)', displayCategory: 'Automatic', eaFormLine: 'B1(a) for Earning; otherwise Not mapped' };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Col', 'Template Header', 'Screen Field (Create New Pay Code)', 'Section', 'Mandatory', 'Allowed Values', 'Default if Blank', 'Rule / Notes', 'System Key'],
    ...PAY_ITEM_COLUMNS.map(([field, header], index) => [XLSX.utils.encode_col(index), header, header.replace(/ \*/, ''), index < 6 ? 'General Information' : index < 8 ? 'ORP Calculation' : index < 11 ? 'Calculation' : index < 18 ? 'Statutory Configuration' : 'EA Form Reporting',
      ['code', 'label', 'kind'].includes(field) ? 'Yes' : ['pcbRemunerationType', 'pcbExemptionCode'].includes(field) ? 'If PCB = Y' : 'No',
      vocabulary[field]?.map(c => c.label).join('; ') ?? 'Text', defaultNotes[field] ?? 'Blank',
      ['pcbRemunerationType', 'pcbExemptionCode'].includes(field) ? 'Required when PCB = Y; blank when PCB = N. Match current remuneration/exemption pair.' : field === 'inputKind' ? 'Calculated types remain pending until their real configuration is saved on screen.' : defaultNotes[field] ?? '', PAY_ITEM_SYSTEM_KEYS[index]]),
  ]), 'Field Guide');
  const listFields = ['kind', 'displayCategory', 'archived', 'roundingMethod', 'inputKind', 'pcbRemunerationType', 'pcbExemptionCode', 'eaFormLine', 'includedInEpf'] as const;
  const lists = listFields.map(field => [field, vocabulary[field] ?? []] as const);
  const listRows: string[][] = [lists.map(([field], index) => index === 8 ? 'Y/N' : PAY_ITEM_COLUMNS.find(([key]) => key === field)?.[1] ?? field)];
  for (let r = 0; r < Math.max(...lists.map(([, values]) => values.length)); r++) listRows.push(lists.map(([, values]) => values[r]?.label ?? ''));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(listRows), 'Lists');
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
  zip.file('xl/styles.xml', layout.styles);
  for (const index of [2, 3]) {
    const part = `xl/worksheets/sheet${index}.xml`, file = zip.file(part); if (!file) throw new Error('Generated pay worksheet missing.');
    let xml = await file.async('string');
    const view = '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="2" ySplit="2" topLeftCell="C3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="C3" sqref="C3"/></sheetView></sheetViews>';
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, view);
    if (!xml.includes('<sheetViews>')) xml = xml.replace(/(<dimension[^>]*\/>)/, '$1' + view);
    xml = xml.replace(/<c\b([^>]*)>/g, (_all, attributes: string) => {
      const address = /\br="([A-Z]+)(\d+)"/.exec(attributes);
      const row = address?.[2] === '1' ? '1' : address?.[2] === '2' ? '2' : '3';
      const styles: Readonly<Record<string, string>> = layout.cellStyles[row];
      const style = styles[address?.[1] ?? ''] ?? (row === '1' ? '12' : row === '2' ? '19' : '22');
      return `<c${attributes.replace(/\s+s="[^"]*"/g, '')} s="${style}">`;
    });
    const validations = Object.entries(vocabulary).map(([field, values]) => {
      const dataColumn = PAY_ITEM_COLUMNS.findIndex(([key]) => key === field);
      if (dataColumn < 0 || !values?.length) return '';
      const ownIndex = listFields.findIndex(key => key === field);
      const listIndex = ownIndex < 0 ? 8 : ownIndex;
      const col = XLSX.utils.encode_col(dataColumn), reference = `Lists!$${XLSX.utils.encode_col(listIndex)}$2:$${XLSX.utils.encode_col(listIndex)}$${values.length + 1}`;
      return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="stop" sqref="${col}3:${col}502"><formula1>INDIRECT(&quot;${reference}&quot;)</formula1></dataValidation>`;
    }).filter(Boolean);
    validations.unshift('<dataValidation type="textLength" operator="lessThanOrEqual" allowBlank="0" showErrorMessage="1" errorStyle="stop" sqref="A3:A502"><formula1>20</formula1></dataValidation>');
    if (!xml.includes('<cols>')) xml = xml.replace('<sheetData>', layout.cols + '<sheetData>');
    const extras = layout.conditionalFormatting + `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`;
    xml = xml.replace(/(<mergeCells[\s\S]*?<\/mergeCells>)/, '$1' + extras);
    zip.file(part, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
