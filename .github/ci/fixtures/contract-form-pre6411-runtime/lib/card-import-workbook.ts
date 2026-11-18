/** Card-specific schema over the shared bounded OOXML admission owner. */
import * as XLSX from 'xlsx';
import { SaxesParser } from 'saxes';
import { decodeSpreadsheetXml, readSpreadsheetArchive } from './spreadsheet-archive';
import { CARD_IMPORT_HEADERS, CARD_IMPORT_MAX_BYTES, CARD_IMPORT_MAX_ROWS, CARD_IMPORT_VERSION, CardImportError, type CardImportInput } from './card-import';

export function readCardImportWorkbook(bytes: Buffer): CardImportInput[] {
  const archive = readSpreadsheetArchive(bytes, { maxBytes: CARD_IMPORT_MAX_BYTES, maxExpandedBytes: 12 * 1024 * 1024, maxEntries: 100 });
  for (const [name, value] of archive.parts) {
    if (!/\.xml$/i.test(name)) continue;
    const addresses = new Set<string>(), parser = new SaxesParser({ xmlns: true });
    let firstElement = true, worksheet = false;
    parser.on('opentag', tag => {
      if (firstElement) { firstElement = false; worksheet = tag.local === 'worksheet'; }
      if (tag.local === 'sheetProtection' || tag.local === 'workbookProtection') throw new CardImportError('invalidWorkbook');
      if (!worksheet || tag.local !== 'c' || !['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'].includes(tag.uri)) return;
      const address = Object.values(tag.attributes).find(attribute => attribute.local === 'r')?.value;
      // A repeated XML cell is ambiguous even if a tolerant reader silently keeps the last value.
      if (!address || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address) || addresses.has(address)) throw new CardImportError('invalidWorkbook');
      addresses.add(address);
    });
    try { parser.write(decodeSpreadsheetXml(value)).close(); }
    catch { throw new CardImportError('invalidWorkbook'); }
  }
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(bytes, { type: 'buffer', cellFormula: true }); }
  catch { throw new CardImportError('invalidWorkbook'); }
  if (wb.SheetNames.length > 3 || new Set(wb.SheetNames).size !== wb.SheetNames.length || wb.SheetNames.some(name => !['Card Assignments', 'Instructions', 'Import Results'].includes(name))) throw new CardImportError('invalidWorkbook');
  const ws = wb.Sheets['Card Assignments'];
  if (!ws || ws.A1?.v !== CARD_IMPORT_VERSION || ws.A1?.f) throw new CardImportError('invalidWorkbook');
  for (let c = 0; c < CARD_IMPORT_HEADERS.length; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c })];
    if (cell?.v !== CARD_IMPORT_HEADERS[c] || cell?.f) throw new CardImportError('invalidWorkbook');
  }
  const candidateRows = new Set<number>();
  for (const name of wb.SheetNames) {
    for (const [address, cell] of Object.entries(wb.Sheets[name])) {
      if (address.startsWith('!')) continue;
      const pos = XLSX.utils.decode_cell(address);
      if (cell?.f || cell?.l || cell?.t === 'e') throw new CardImportError('invalidWorkbook');
      if (name === 'Card Assignments' && pos.r < 2 && pos.c > (pos.r === 0 ? 0 : 2) && String(cell?.v ?? '').trim()) throw new CardImportError('invalidWorkbook');
      if (name !== 'Card Assignments' || pos.r < 2 || cell?.v == null || String(cell.v).trim() === '') continue;
      if (pos.c > 2 || pos.r > CARD_IMPORT_MAX_ROWS + 1) throw new CardImportError('tooManyRows');
      candidateRows.add(pos.r);
      if (candidateRows.size > CARD_IMPORT_MAX_ROWS) throw new CardImportError('tooManyRows');
    }
  }
  const rows = [...candidateRows].sort((a, b) => a - b).map(r => {
    const cells = CARD_IMPORT_HEADERS.map((_, c) => ws[XLSX.utils.encode_cell({ r, c })]);
    if (cells.some(cell => String(cell?.v ?? '').length > 1000)) throw new CardImportError('invalidWorkbook');
    return { row: r + 1, employeeCode: String(cells[0]?.v ?? ''), cardId: String(cells[1]?.v ?? ''), operation: String(cells[2]?.v ?? ''), invalidCell: cells.some(cell => cell?.v != null && cell.v !== '' && cell.t !== 's') };
  });
  if (!rows.length) throw new CardImportError('emptyWorkbook');
  return rows;
}

const instructions = [
  ['Card Assignment import'],
  ['Use Card Assignments only. Keep the version in row 1 and the headers in row 2. Maximum 500 rows and 2 MB.'],
  ['Employee ID and Card ID must be literal text. Keep leading zeros. Numbers, formulas, links and macros are refused.'],
  ['assign: assign a card only when no different card exists. A blank Card ID leaves the current value unchanged.'],
  ['replace: replace an existing card after explicit confirmation in the preview. A blank Card ID leaves it unchanged.'],
  ['reset: leave Card ID blank to return to Employee ID / IC matching. Explicit confirmation is required.'],
  ['Duplicate Employee IDs or Card IDs in the file are blocked. Ambiguous Employee IDs must be resolved in Personnel first.'],
  ['Preview makes no changes. Only selected valid rows are saved. Changed or inaccessible records must be reviewed again.'],
];
export function buildCardImportWorkbook(existing: readonly { employeeCode: string; cardId: string | null }[] = [], guidance?: readonly string[]): Buffer {
  if (existing.length > CARD_IMPORT_MAX_ROWS) throw new CardImportError('catalogueLimit');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[CARD_IMPORT_VERSION], [...CARD_IMPORT_HEADERS], ...existing.map(row => [row.employeeCode, row.cardId ?? '', 'assign'])]);
  for (let r = 2; r < CARD_IMPORT_MAX_ROWS + 2; r++) for (let c = 0; c < 3; c++) {
    const key = XLSX.utils.encode_cell({ r, c });
    ws[key] = { t: 's', v: String(ws[key]?.v ?? ''), z: '@' };
  }
  ws['!ref'] = `A1:C${CARD_IMPORT_MAX_ROWS + 2}`;
  ws['!cols'] = [{ wch: 28 }, { wch: 28 }, { wch: 20 }];
  ws['!autofilter'] = { ref: `A2:C${CARD_IMPORT_MAX_ROWS + 2}` };
  XLSX.utils.book_append_sheet(wb, ws, 'Card Assignments');
  const help = XLSX.utils.aoa_to_sheet(guidance ? guidance.map(text => [text]) : instructions); help['!cols'] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, help, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}
