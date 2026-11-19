import { Readable } from 'node:stream';
import JSZip from 'jszip';

export type TransactionCell = string | number | null | { date: string };
const SHEET_CAPACITY = 1_048_575;
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';

function text(value: string) {
  return value.replace(/_x[\da-f]{4}_/gi, (match) => '_x005F_' + match.slice(1))
    .replace(/[\u0000-\u0008\u000B-\u001F\uFFFE\uFFFF]/g, (char) =>
      '_x' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '_')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function columnName(index: number): string {
  return (index >= 26 ? columnName(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + index % 26);
}

function cellXml(cell: TransactionCell, ref: string) {
  if (cell === null) return '';
  if (typeof cell === 'string') {
    return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${text(cell)}</t></is></c>`;
  }
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) throw new Error('The transaction contains an invalid number.');
    return `<c r="${ref}"><v>${cell}</v></c>`;
  }
  const serial = (Date.parse(cell.date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86_400_000;
  if (!Number.isFinite(serial)) throw new Error('The transaction contains an invalid date.');
  return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
}

function rowXml(index: number, cells: readonly TransactionCell[]) {
  return `<row r="${index}">${cells.map((cell, column) => cellXml(cell, columnName(column) + index)).join('')}</row>`;
}

async function* sheet(headers: string[], rows: AsyncIterator<readonly TransactionCell[]>, count: number) {
  yield Buffer.from(XML + `<worksheet xmlns="${NS}">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetData>' + rowXml(1, headers));
  for (let index = 0; index < count; index++) {
    const next = await rows.next();
    if (next.done) throw new Error('The transaction export ended before its expected row count.');
    yield Buffer.from(rowXml(index + 2, next.value));
  }
  yield Buffer.from('</sheetData></worksheet>');
}

const styleFile = XML + `<styleSheet xmlns="${NS}">`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** One Excel workbook with bounded streams, repeating column headings whenever Excel's row limit is reached. */
export function transactionXlsxStream(headers: string[], rows: AsyncIterable<readonly TransactionCell[]>, total: number): Readable {
  const zip = new JSZip();
  const count = Math.max(1, Math.ceil(total / SHEET_CAPACITY));
  const indices = Array.from({ length: count }, (_, index) => index + 1);
  const iterator = rows[Symbol.asyncIterator]();
  zip.file('[Content_Types].xml', XML + `<Types xmlns="${TYPES}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + indices.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  zip.file('_rels/.rels', XML + `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', XML + `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>`
    + indices.map((i) => `<sheet name="Transactions ${i}" sheetId="${i}" r:id="rId${i}"/>`).join('') + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', XML + `<Relationships xmlns="${RELS}">`
    + indices.map((i) => `<Relationship Id="rId${i}" Type="${REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')
    + `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', styleFile);
  for (const i of indices) {
    const rowCount = Math.min(SHEET_CAPACITY, total - (i - 1) * SHEET_CAPACITY);
    zip.file(`xl/worksheets/sheet${i}.xml`, Readable.from(sheet(headers, iterator, rowCount), {
      objectMode: false, highWaterMark: 64 * 1024,
    }));
  }
  const output = new Readable({ highWaterMark: 64 * 1024 }).wrap(
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }),
  );
  output.on('close', () => { void iterator.return?.(); });
  return output;
}
