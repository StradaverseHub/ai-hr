import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PAY_COMPONENT_WORKBOOK_LAYOUT as layout } from './pay-component-workbook-layout';
import type { payComponent } from '../db/schema';
import { PAY_COMPONENT_DEFAULTS as defaults } from './pay-component-contract';
import { PAY_ITEM_COLUMNS, PAY_ITEM_SYSTEM_KEYS, PAY_ITEM_MAX_BYTES, PAY_ITEM_MAX_ROWS, normalizePayItemHeader,
  type PayItemField, type PayItemPreviewRow, type PayItemUploadRow, type PayItemVocabulary } from './pay-component-import';

export class PayItemWorkbookError extends Error {
  constructor(public readonly code: 'tooLarge' | 'invalidWorkbook' | 'tooManyRows' | 'missingSheet' | 'missingHeader' | 'duplicateHeader' | 'emptyWorkbook', public readonly field?: string) {
    super(`pay-item-workbook:${code}`); this.name = 'PayItemWorkbookError';
  }
}

const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function archiveCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Admit only consistent ordinary ZIP records, and bound ACTUAL expansion before either workbook
 * parser runs. Metadata alone is untrusted: SheetJS reads local sizes and inflates before checking them.
 * No ZIP64, encryption, alternate Unicode path names, hidden records or unsupported compression. */
export function checkPayItemArchive(bytes: Buffer) {
  if (bytes.length > PAY_ITEM_MAX_BYTES) throw new PayItemWorkbookError('tooLarge');
  const bad = (): never => { throw new PayItemWorkbookError('invalidWorkbook'); };
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return bad();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return bad();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 256 || bytes.readUInt16LE(end + 8) !== count || start > end || bytes.readUInt32LE(end + 12) !== end - start) return bad();
  function checkExtras(offset: number, length: number) {
    const limit = offset + length;
    while (offset < limit) {
      if (offset + 4 > limit) return bad();
      const tag = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
      if (tag === 0x0001 || tag === 0x7075 || offset + 4 + size > limit) return bad();
      offset += 4 + size;
    }
  }
  let offset = start, expanded = 0; const names = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return bad();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (!nameLength || next > end || flags & ~0x080e || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34) || compressed === 0xffffffff || size === 0xffffffff || local + 30 > start) return bad();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = nameBytes.toString('utf8');
    if (names.has(name) || /vbaProject|externalLinks|embeddings/i.test(name) || /[\\\x00]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..')) return bad();
    names.add(name); checkExtras(offset + 46 + nameLength, extra);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== bytes.readUInt16LE(offset + 6) || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return bad();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameLength + localExtra;
    const dataEnd = dataStart + compressed;
    if (localNameLength !== nameLength || dataStart > start || dataEnd > start || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) return bad();
    checkExtras(local + 30 + localNameLength, localExtra);
    const localCrc = bytes.readUInt32LE(local + 14), localCompressed = bytes.readUInt32LE(local + 18), localSize = bytes.readUInt32LE(local + 22);
    let recordEnd = dataEnd;
    if (flags & 8) {
      // Streaming ZIP entries may leave local sizes zero, but their descriptor must agree exactly.
      if (localCrc !== 0 && localCrc !== crc || localCompressed !== 0 && localCompressed !== compressed || localSize !== 0 && localSize !== size) return bad();
      const signed = dataEnd + 4 <= start && bytes.readUInt32LE(dataEnd) === 0x08074b50, descriptor = dataEnd + (signed ? 4 : 0);
      recordEnd = descriptor + 12;
      if (recordEnd > start || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== size) return bad();
    } else if (localCrc !== crc || localCompressed !== compressed || localSize !== size) return bad();
    if (size > MAX_EXPANDED_BYTES - expanded) return bad();
    const payload = bytes.subarray(dataStart, dataEnd);
    let actual: Buffer;
    try { actual = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(1, size) }); }
    catch { return bad(); }
    if (actual.length !== size || archiveCrc32(actual) !== crc) return bad();
    expanded += actual.length; ranges.push({ start: local, end: recordEnd }); offset = next;
  }
  if (offset !== end) return bad();
  ranges.sort((a, b) => a.start - b.start);
  let localEnd = 0;
  for (const range of ranges) { if (range.start !== localEnd) return bad(); localEnd = range.end; }
  if (localEnd !== start) return bad();
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

/** Presentation order is independent of the canonical reader's order: old row-2 headers remain valid. */
const mainFields: readonly PayItemField[] = ['code', 'label', 'description', 'kind', 'inputKind', 'eaFormLine', 'archived'];
export const PAY_ITEM_TEMPLATE_COLUMNS = [
  ...mainFields.map(field => PAY_ITEM_COLUMNS.find(([key]) => key === field)!),
  ...PAY_ITEM_COLUMNS.filter(([field]) => !mainFields.includes(field)),
];
type Catalogue = typeof payComponent.$inferSelect;
export type PayItemCatalogueRow = Pick<Catalogue,
  'code' | 'label' | 'description' | 'kind' | 'displayCategory' | 'archivedAt' | 'pendingInputKind' | 'rule' |
  'orpUnpaidLeave' | 'orpOvertime' | 'roundingMethod' | 'prorates' | 'includedInEpf' | 'epfBonus2012' |
  'includedInPcb' | 'pcbRemunerationType' | 'pcbExemptionCode' | 'includedInSocsoEis' | 'includedInHrdfBase' | 'eaFormLine'>;

/** Catalogue facts only, never illustrative financial settings or inferred tax treatment. */
export function payItemSampleRows(catalogue: readonly PayItemCatalogueRow[], vocabulary: PayItemVocabulary): string[][] {
  const preferred = ['A0020', 'A0027', 'BASIC'];
  const rank = (code: string) => { const index = preferred.indexOf(code); return index < 0 ? preferred.length : index; };
  const chosen = [...catalogue].sort((a, b) => rank(a.code) - rank(b.code) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).slice(0, 3);
  return chosen.map(row => PAY_ITEM_TEMPLATE_COLUMNS.map(([field]) => {
    const value = field === 'archived' ? row.archivedAt == null ? 'active' : 'inactive'
      : field === 'inputKind' ? row.pendingInputKind ?? row.rule?.kind ?? 'fixed' : row[field];
    const raw = typeof value === 'boolean' ? value ? 'Y' : 'N' : String(value ?? '');
    return vocabulary[field]?.find(choice => choice.value === raw)?.label ?? raw;
  }));
}

export async function buildPayItemWorkbook(vocabulary: PayItemVocabulary, catalogue: readonly PayItemCatalogueRow[] = []): Promise<Buffer> {
  const wb = XLSX.utils.book_new(), samples = payItemSampleRows(catalogue, vocabulary);
  const label = (field: PayItemField, value: string) => vocabulary[field]?.find(choice => choice.value === value)?.label ?? value;
  const blankDefaults: Partial<Record<PayItemField, string>> = {
    code: 'Required; max 20; A–Z, 0–9, underscore or hyphen', label: 'Required; max 60', description: 'Blank; max 200', kind: 'Required',
    archived: label('archived', defaults.archived ? 'inactive' : 'active'), inputKind: label('inputKind', defaults.inputKind),
    displayCategory: label('displayCategory', ''), roundingMethod: label('roundingMethod', defaults.roundingMethod),
    orpOvertime: 'Y for Earning; otherwise N', eaFormLine: 'B1(a) for Earning; otherwise Not mapped',
  };
  for (const field of ['orpUnpaidLeave', 'prorates', 'includedInEpf', 'epfBonus2012', 'includedInPcb', 'includedInSocsoEis', 'includedInHrdfBase'] as const)
    blankDefaults[field] = defaults[field] ? 'Y' : 'N';
  const meanings: Partial<Record<PayItemField, string>> = {
    code: 'Unique new code; existing active or inactive codes are refused.', label: 'Short display label used on payslips and lists.',
    description: 'Optional descriptive text; does not determine financial settings.', kind: 'Use the current catalogue category choices.',
    displayCategory: 'Payslip grouping; does not change statutory treatment.', archived: 'Inactive records remain in the catalogue.',
    orpUnpaidLeave: 'Included in the ordinary-rate base for unpaid leave and absence deductions.',
    orpOvertime: 'Included in the All fixed allowances total used by the overtime formula.',
    roundingMethod: 'Rounding for this pay item; statutory contribution rounding is separate.',
    inputKind: 'Calculated types are imported pending configuration on screen.', prorates: 'Prorates for partial-period employment.',
    includedInEpf: 'Feeds the EPF wage base.', epfBonus2012: 'Y requires EPF = Y; identifies bonus treatment for EPF.',
    includedInPcb: 'Feeds taxable remuneration for PCB/MTD; requires current remuneration and exemption details.',
    pcbRemunerationType: 'Required when PCB = Y; blank when PCB = N. Use a current matching remuneration/exemption pair.',
    pcbExemptionCode: 'Required when PCB = Y; blank when PCB = N. No exemption is inferred from the label.',
    includedInSocsoEis: 'One combined flag for the SOCSO and EIS wage bases.', includedInHrdfBase: 'Feeds the HRDF levy base.',
    eaFormLine: 'EA reporting classification; does not change the calculation.',
  };
  const instructions: string[][] = [
    ['Pay Items — Import Template'],
    ['Create new pay codes only. Existing codes are not imported; remove them before confirming.'],
    ['Enter new codes on Pay Items from row 3. Only Pay Items is imported. XLSX only; 5 MB; 1000 data rows.'],
    ['Instructions and Sample are reference only. Sample is read-only. You can unprotect it without a password.'],
    [`Sample contains ${samples.length} actual catalogue record(s) available to this administrator. No example records are invented.`],
    ['Dropdowns help entry without blocking typed values. Check workbook validates accepted choices, required fields and current catalogue codes.'],
    ['PCB defaults to Y. Remuneration Type and Exemption Type are required when PCB = Y; leave both blank when PCB = N. No tax treatment is inferred from a code or label.'],
    ['Calculated input types remain pending: complete and save the real rate, operands or Formula builder on screen before assignment/payroll. Workbook formulas are never imported or evaluated.'],
    ['Per-day/per-hour with Prorates Y is refused (double proration). Warnings do not override financial refusals.'],
    ['Check workbook previews errors before confirmation. All rows must be error-free; confirmation revalidates and creates the entire file in one transaction. Existing active/inactive codes are never overwritten.'],
    ['Blank defaults match Create New Pay Code. Explicit values override defaults. Review the conditional settings after the main seven columns.'],
    ['Pay Items has 500 formatted blank entry rows; uploads allow 1000 populated data rows. Sample rows are not automatically copied to Pay Items.'],
    [], ['FIELD GUIDE — current choices and blank defaults'],
    ['Column', 'Field', 'Required', 'Default if blank', 'Rule / notes', 'System key'],
    ...PAY_ITEM_TEMPLATE_COLUMNS.map(([field, header], index) => [XLSX.utils.encode_col(index), header,
      ['code', 'label', 'kind'].includes(field) ? 'Yes' : ['pcbRemunerationType', 'pcbExemptionCode'].includes(field) ? 'If PCB = Y' : 'No',
      blankDefaults[field] ?? 'Blank',
      meanings[field] ?? '',
      PAY_ITEM_SYSTEM_KEYS[PAY_ITEM_COLUMNS.findIndex(([key]) => key === field)]]),
    [], ['ALLOWED VALUES — used by dropdowns; server validation remains authoritative'],
  ];
  // Each current vocabulary owns its own exact range on Instructions. No fourth/hidden lists sheet.
  const choiceRanges = new Map<PayItemField, string>();
  for (const [field, values] of Object.entries(vocabulary) as [PayItemField, NonNullable<PayItemVocabulary[PayItemField]>][]) {
    if (!values.length) continue;
    instructions.push([PAY_ITEM_COLUMNS.find(([key]) => key === field)![1], 'Accepted label', 'System value']);
    const start = instructions.length + 1;
    for (const choice of values) instructions.push(['', choice.label, choice.value]);
    choiceRanges.set(field, `Instructions!$B$${start}:$B$${instructions.length}`);
    instructions.push([]);
  }
  const guide = XLSX.utils.aoa_to_sheet(instructions);
  guide['!cols'] = [{ wch: 28 }, { wch: 42 }, { wch: 30 }, { wch: 42 }, { wch: 70 }, { wch: 25 }];
  guide['!rows'] = instructions.map(row => ({ hpt: row.length === 1 && row[0].length > 100 ? 55 : 30 }));
  guide['!merges'] = instructions.flatMap((row, r) => row.length === 1 && row[0] ? [{ s: { r, c: 0 }, e: { r, c: 5 } }] : []);
  XLSX.utils.book_append_sheet(wb, guide, 'Instructions');
  const headers = PAY_ITEM_TEMPLATE_COLUMNS.map(([, header]) => header);
  for (const [name, rows] of [['Pay Items', []], ['Sample', samples]] as const) {
    const ws = XLSX.utils.aoa_to_sheet([
      [name === 'Sample' ? 'SAMPLE ONLY – NOT UPLOADED' : 'ENTER NEW PAY CODES ONLY — conditional settings follow the main seven fields'], headers, ...rows,
    ]);
    ws['!merges'] = [XLSX.utils.decode_range('A1:S1')];
    ws['!cols'] = PAY_ITEM_TEMPLATE_COLUMNS.map(([field]) => ({ wch: field === 'description' ? 40 : field === 'label' ? 28 : 24 }));
    ws['!rows'] = [{ hpt: 30 }, { hpt: 48 }, ...rows.map(() => ({ hpt: 84 }))];
    const last = name === 'Pay Items' ? 502 : Math.max(3, samples.length + 2);
    for (let r = 2; r < last; r++) for (let c = 0; c < PAY_ITEM_TEMPLATE_COLUMNS.length; c++) {
      const address = XLSX.utils.encode_cell({ r, c });
      if (!ws[address]) ws[address] = { t: 's', v: '' };
    }
    ws['!ref'] = `A1:S${last}`;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
  let wrappedStyle = 0, sampleStyle = 0;
  // Explicit locking/wrapping avoids inheriting old entry-sheet style decisions on Sample.
  const styles = layout.styles.replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (_all, count: string, body: string) => {
    const formats = body.match(/<xf\b[^>]*>[\s\S]*?<\/xf>/g);
    if (!formats?.[22]) throw new Error('Pay workbook text style missing.');
    wrappedStyle = Number(count);
    const wrapped = formats[22].replace(/applyAlignment="[^"]*"/, 'applyAlignment="1"')
      .replace(/applyProtection="[^"]*"/, 'applyProtection="1"').replace(/wrapText="[^"]*"/, 'wrapText="1"')
      .replace(/vertical="[^"]*"/, 'vertical="top"');
    sampleStyle = wrappedStyle + 1;
    const reference = wrapped.replace(/fillId="0"/, 'fillId="12"').replace('<xf ', '<xf applyFill="1" ');
    return `<cellXfs count="${wrappedStyle + 2}">${body}${wrapped}${reference}</cellXfs>`;
  });
  zip.file('xl/styles.xml', styles);
  for (const index of [1, 2, 3]) {
    const part = `xl/worksheets/sheet${index}.xml`, file = zip.file(part); if (!file) throw new Error('Generated pay worksheet missing.');
    let xml = await file.async('string');
    const view = '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="2" ySplit="2" topLeftCell="C3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="C3" sqref="C3"/></sheetView></sheetViews>';
    if (index !== 1) {
      xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, view);
      if (!xml.includes('<sheetViews>')) xml = xml.replace(/(<dimension[^>]*\/>)/, '$1' + view);
    }
    xml = xml.replace(/<c\b([^>]*)>/g, (_all, attributes: string) => {
      const address = /\br="([A-Z]+)(\d+)"/.exec(attributes);
      const row = Number(address?.[2] ?? 0);
      // Reuse the submitted band/header colours, with literal, wrapped and locked reference cells.
      const style = row === 1 ? '12' : index !== 1 && row === 2 ? '19' : String(index === 3 ? sampleStyle : wrappedStyle);
      return `<c${attributes.replace(/\s+s="[^"]*"/g, '')} s="${style}">`;
    });
    if (index === 2) {
      const validations = PAY_ITEM_TEMPLATE_COLUMNS.flatMap(([field], column) => {
        const reference = choiceRanges.get(field); if (!reference) return [];
        const col = XLSX.utils.encode_col(column);
        return [`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${col}3:${col}502"><formula1>INDIRECT(&quot;${reference}&quot;)</formula1></dataValidation>`];
      });
      xml = xml.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, mergeCells => mergeCells + `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`);
    }
    if (index === 3) xml = xml.replace(/<mergeCells/, '<sheetProtection sheet="1" objects="1" scenarios="1"/><mergeCells');
    zip.file(part, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
