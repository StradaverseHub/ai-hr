import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { decodeSpreadsheetXml, readSpreadsheetArchive, SpreadsheetArchiveError } from '@/lib/spreadsheet-archive';

const limits = { maxBytes: 5_000_000, maxExpandedBytes: 8_000_000, maxEntries: 160 };
async function workbook(target = 'worksheets/sheet1.xml', mode = '') {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}" ${mode}/></Relationships>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
describe('shared spreadsheet archive admission', () => {
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
});
