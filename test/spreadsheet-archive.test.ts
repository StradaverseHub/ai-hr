import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { deflateRawSync } from 'node:zlib';
import { decodeSpreadsheetXml, readSpreadsheetArchive, SpreadsheetArchiveError } from '@/lib/spreadsheet-archive';

const limits = { maxBytes: 5_000_000, maxExpandedBytes: 8_000_000, maxEntries: 160 };
async function workbook(target = 'worksheets/sheet1.xml', mode = '') {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}" ${mode}/></Relationships>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function ordinaryXlsx(compression = true): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Code', 'Label'], ['00007', 'Fictional label']]), 'Labels');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression }) as Buffer;
}
describe('shared spreadsheet archive admission', () => {
  it.each([false, true])('accepts actual SheetJS ordinary XLSX with unused macro BIN default, compression=%s', async compression => {
    const bytes = ordinaryXlsx(compression), zip = await JSZip.loadAsync(bytes);
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('application/vnd.ms-excel.sheet.binary.macroEnabled.main');
    expect(Object.keys(zip.files).some(name => /\.bin$/i.test(name))).toBe(false);
    expect(readSpreadsheetArchive(bytes, limits).parts.has('xl/workbook.xml')).toBe(true);
  });
  it('refuses a real macro-enabled workbook override in an otherwise ordinary XLSX', async () => {
    const zip = await JSZip.loadAsync(ordinaryXlsx()), entry = zip.file('[Content_Types].xml')!;
    const normal = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
    const types = await entry.async('string');
    expect(types).toContain(normal);
    zip.file('[Content_Types].xml', types.replace(normal, 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('refuses an existing part inheriting the forbidden BIN default', async () => {
    const zip = await JSZip.loadAsync(ordinaryXlsx());
    zip.file('xl/payload.bin', Buffer.from('fictional payload'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('uses an exact safe override instead of an unused forbidden extension default', async () => {
    const zip = await JSZip.loadAsync(ordinaryXlsx()), entry = zip.file('[Content_Types].xml')!;
    zip.file('xl/payload.bin', Buffer.from('fictional inert payload'));
    zip.file('[Content_Types].xml', (await entry.async('string')).replace('</Types>', '<Override PartName="/xl/payload.bin" ContentType="application/octet-stream"/></Types>'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(readSpreadsheetArchive(bytes, limits).parts.has('xl/payload.bin')).toBe(true);
  });
  it.each(['application/vnd.ms-office.vbaProject', 'application/vnd.openxmlformats-officedocument.oleObject'])('refuses an effective forbidden override on a neutrally named part: %s', async type => {
    const zip = await JSZip.loadAsync(ordinaryXlsx()), entry = zip.file('[Content_Types].xml')!;
    zip.file('xl/payload.bin', Buffer.from('fictional payload'));
    zip.file('[Content_Types].xml', (await entry.async('string')).replace('</Types>', `<Override PartName="/xl/payload.bin" ContentType="${type}"/></Types>`));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('refuses conflicting extension defaults and case aliases in part overrides', async () => {
    for (const declaration of ['<Default Extension="BIN" ContentType="application/octet-stream"/>', '<Override PartName="/xl/WORKBOOK.xml" ContentType="application/octet-stream"/>']) {
      const zip = await JSZip.loadAsync(ordinaryXlsx()), entry = zip.file('[Content_Types].xml')!;
      zip.file('[Content_Types].xml', (await entry.async('string')).replace('</Types>', declaration + '</Types>'));
      const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
    }
  });
  it.each(['vbaProject', 'oleObject', 'package'])('retains forbidden relationship admission despite harmless part names: %s', async relation => {
    const zip = await JSZip.loadAsync(await workbook()), entry = zip.file('xl/_rels/workbook.xml.rels')!;
    zip.file('xl/_rels/workbook.xml.rels', (await entry.async('string')).replace('/worksheet"', '/' + relation + '"'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('retains embedded-part refusal even with no suspicious content-type declaration', async () => {
    const zip = await JSZip.loadAsync(await workbook());
    zip.file('xl/embeddings/payload.bin', Buffer.from('fictional payload'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
  });

  it('resolves the actual worksheet part without imposing formula or protection policy', async () => {
    const archive = readSpreadsheetArchive(await workbook(), limits);
    expect(archive.relationships.get('xl/workbook.xml')).toEqual([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', target: 'worksheets/sheet1.xml', part: 'xl/worksheets/sheet1.xml' }]);
    expect(archive.parts.has('xl/worksheets/sheet1.xml')).toBe(true);
  });
  it.each([
    ['https://example.invalid/sample.xml', 'TargetMode="External"'],
    ['../../outside.xml', ''], ['worksheets/missing.xml', ''],
    ['worksheets%2fsheet1.xml', ''], ['worksheets/sheet1.xml#fragment', ''],
  ])('refuses unsafe or unresolved relationship %s', async (target, mode) => {
    const bytes = await workbook(target, mode);
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('bounds the actual expanded package before consumers receive it', async () => {
    const bytes = await workbook();
    expect(() => readSpreadsheetArchive(bytes, { ...limits, maxExpandedBytes: 20 })).toThrow(SpreadsheetArchiveError);
    expect(() => readSpreadsheetArchive(bytes, { ...limits, maxBytes: 20 })).toThrow(SpreadsheetArchiveError);
  });
  it('retains standard stored and streaming archives', async () => {
    const source = await JSZip.loadAsync(await workbook());
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      const bytes = await source.generateAsync({ type: 'nodebuffer', compression, streamFiles: true });
      expect(readSpreadsheetArchive(bytes, limits).parts.has('xl/workbook.xml')).toBe(true);
    }
  });
  it('refuses corrupted contents, macros, and XML doctypes before a workbook parser', async () => {
    const source = await JSZip.loadAsync(await workbook());
    source.file('xl/vbaProject.bin', Buffer.from('macro'));
    const macro = await source.generateAsync({ type: 'nodebuffer' });
    expect(() => readSpreadsheetArchive(macro, limits)).toThrow(SpreadsheetArchiveError);
    source.remove('xl/vbaProject.bin');
    source.file('xl/workbook.xml', '<!DOCTYPE workbook><workbook/>');
    const doctype = await source.generateAsync({ type: 'nodebuffer' });
    expect(() => readSpreadsheetArchive(doctype, limits)).toThrow(SpreadsheetArchiveError);
    const corrupt = Buffer.from(await workbook());
    const dataStart = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28);
    corrupt[dataStart] ^= 0xff;
    expect(() => readSpreadsheetArchive(corrupt, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('decodes UTF-16 and refuses invalid byte sequences', () => {
    expect(decodeSpreadsheetXml(Buffer.from('\ufeff<worksheet/>', 'utf16le'))).toBe('<worksheet/>');
    expect(() => decodeSpreadsheetXml(Buffer.from([0xc3, 0x28]))).toThrow(SpreadsheetArchiveError);
  });
  it.each([Buffer.from('hidden'), deflateRawSync(Buffer.from('second stream'))])('refuses unconsumed bytes inside a declared DEFLATE payload', async trailing => {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook/>', { createFolders: false });
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const end = bytes.length - 22, start = bytes.readUInt32LE(end + 16);
    const changed = Buffer.concat([bytes.subarray(0, start), trailing, bytes.subarray(start)]);
    changed.writeUInt32LE(bytes.readUInt32LE(18) + trailing.length, 18);
    changed.writeUInt32LE(bytes.readUInt32LE(start + 20) + trailing.length, start + trailing.length + 20);
    changed.writeUInt32LE(start + trailing.length, end + trailing.length + 16);
    expect(() => readSpreadsheetArchive(changed, limits)).toThrow(SpreadsheetArchiveError);
  });
  it('refuses case-colliding package names and incorrectly cased relationship targets', async () => {
    const zip = await JSZip.loadAsync(await workbook());
    zip.file('XL/workbook.xml', '<workbook/>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => readSpreadsheetArchive(bytes, limits)).toThrow(SpreadsheetArchiveError);
    const wrongCase = await workbook('worksheets/SHEET1.xml');
    expect(() => readSpreadsheetArchive(wrongCase, limits)).toThrow(SpreadsheetArchiveError);
  });
});
