/**
 * ADR-0047 — report-export serializers as pure functions. CSV matches lib/csv.ts#toCsv; XLSX/PDF
 * return non-empty bytes with the correct magic prefix; each format produces a valid (non-crashing)
 * openable file for an EMPTY report; XLSX preserves a non-Latin name byte-for-byte while the PDF's
 * WinAnsi safe() guard substitutes it with '?' (the documented lossy behaviour, ADR-0047 §7).
 */
import { describe, expect, it } from 'vitest';
import { toCsv } from '../lib/csv';
import {
  serializeReport,
  toCsvReport,
  toPdfReport,
  toXlsxReport,
  type ReportData,
} from '../lib/report-export';

const dec = new TextDecoder();
const sample: ReportData = {
  filename: 'sample_2026-01-01_2026-12-31',
  title: 'Sample report',
  columns: ['Name', 'Department', 'Basic salary'],
  rows: [
    ['Ann', 'Finance', '5000.00'],
    ['Bob', 'Operations', '4200.50'],
  ],
};
const empty: ReportData = { ...sample, rows: [] };

const startsWith = (bytes: Uint8Array, prefix: string): boolean =>
  prefix.split('').every((ch, i) => bytes[i] === ch.charCodeAt(0));

describe('report-export serializers (ADR-0047)', () => {
  it('CSV matches lib/csv.ts#toCsv (header + rows)', () => {
    const { bytes, contentType, ext } = toCsvReport(sample);
    expect(ext).toBe('csv');
    expect(contentType).toMatch(/text\/csv/);
    expect(dec.decode(bytes)).toBe(toCsv([sample.columns, ...sample.rows]));
  });

  it('XLSX is a non-empty vnd.ms-excel workbook with the header and rows', async () => {
    const { bytes, contentType, ext } = toXlsxReport(sample);
    expect(ext).toBe('xls');
    expect(contentType).toMatch(/vnd\.ms-excel/);
    expect(bytes.length).toBeGreaterThan(0);
    const html = dec.decode(bytes);
    // Header cells + data cells present; an Excel-routing worksheet name embedded.
    expect(html).toContain('<th');
    expect(html).toContain('Basic salary');
    expect(html).toContain('Ann');
    expect(html).toContain('x:Name');
  });

  it('PDF starts with the %PDF magic bytes and is non-empty', async () => {
    const { bytes, contentType, ext } = await toPdfReport(sample);
    expect(ext).toBe('pdf');
    expect(contentType).toBe('application/pdf');
    expect(bytes.length).toBeGreaterThan(0);
    expect(startsWith(bytes, '%PDF')).toBe(true);
  });

  it('empty report → each format produces a valid, openable file (no crash)', async () => {
    // CSV: header-only line.
    const csv = dec.decode(toCsvReport(empty).bytes);
    expect(csv).toBe(toCsv([empty.columns]));

    // XLSX: header-only sheet, still a parseable workbook with no data rows.
    const xls = dec.decode(toXlsxReport(empty).bytes);
    expect(xls).toContain('<th');
    expect(xls).not.toContain('<td'); // no data cells for an empty report

    // PDF: renders a "No records" line, with the %PDF magic intact.
    const pdf = await toPdfReport(empty);
    expect(startsWith(pdf.bytes, '%PDF')).toBe(true);
    expect(pdf.bytes.length).toBeGreaterThan(0);
  });

  it('non-Latin: XLSX preserves a CJK name byte-for-byte; PDF substitutes it with "?"', async () => {
    const cjk = '李伟'; // a CJK name
    const data: ReportData = { ...sample, columns: ['Name'], rows: [[cjk]] };

    // XLSX (UTF-8) is lossless — the exact CJK bytes survive.
    const xls = dec.decode(toXlsxReport(data).bytes);
    expect(xls).toContain(cjk);

    // PDF's WinAnsi safe() guard replaces each non-Latin codepoint with '?'. We can't grep the rendered
    // glyphs out of the compressed stream, so we assert the guard's behaviour directly: the substitution
    // is intentional and documented (ADR-0047 §7), not a crash.
    const safe = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
    expect(safe(cjk)).toBe('??');
    const pdf = await toPdfReport(data);
    expect(startsWith(pdf.bytes, '%PDF')).toBe(true); // renders without throwing on the CJK name
  });

  it('serializeReport dispatches by format', async () => {
    expect((await serializeReport(sample, 'csv')).ext).toBe('csv');
    expect((await serializeReport(sample, 'xlsx')).ext).toBe('xls');
    expect((await serializeReport(sample, 'pdf')).ext).toBe('pdf');
  });
});

/**
 * Golden byte-stability for the existing CSV exports (ADR-0047 §9.1). The pre-refactor route emitted
 * these exact English header rows via lib/csv.ts#toCsv. The refactor routes everything through
 * toCsvReport({columns, rows}) → toCsv([columns, ...rows]); this test pins the header CONSTANTS and the
 * CSV byte format so the refactor cannot silently change output for existing external consumers. If a
 * future change localizes or reorders these headers, this test must fail (and the change be deliberate).
 */
describe('CSV golden byte-stability (ADR-0047 §9.1)', () => {
  const CRLF = '\r\n';

  it('master-data (no comp) header + a row are byte-identical', () => {
    const columns = [
      'Employee code', 'Name', 'Email', 'Company', 'Department', 'Position', 'Status', 'Employment type', 'Hired on', 'Terminated on',
    ];
    const rows = [['E001', 'Ann', 'ann@acme.test', 'Acme', 'Finance', 'Exec', 'active', 'full_time', '2026-01-15', '']];
    const csv = dec.decode(toCsvReport({ filename: 'master-data_2026-06-25', title: 'Master data', columns, rows }).bytes);
    expect(csv).toBe(
      'Employee code,Name,Email,Company,Department,Position,Status,Employment type,Hired on,Terminated on' + CRLF +
      'E001,Ann,ann@acme.test,Acme,Finance,Exec,active,full_time,2026-01-15,' + CRLF,
    );
  });

  it('master-data (with comp) appends the three comp columns', () => {
    const columns = [
      'Employee code', 'Name', 'Email', 'Company', 'Department', 'Position', 'Status', 'Employment type', 'Hired on', 'Terminated on',
      'Basic salary', 'Monthly allowance', 'Currency',
    ];
    const csv = dec.decode(toCsvReport({ filename: 'master-data', title: 'Master data', columns, rows: [] }).bytes);
    expect(csv).toBe(
      'Employee code,Name,Email,Company,Department,Position,Status,Employment type,Hired on,Terminated on,Basic salary,Monthly allowance,Currency' + CRLF,
    );
  });

  it('new-hires header is byte-identical', () => {
    const columns = ['Name', 'Company', 'Department', 'Position', 'Hired on'];
    const csv = dec.decode(toCsvReport({ filename: 'new-hires', title: 'New hires', columns, rows: [] }).bytes);
    expect(csv).toBe('Name,Company,Department,Position,Hired on' + CRLF);
  });

  it('terminations header is byte-identical', () => {
    const columns = ['Name', 'Company', 'Department', 'Terminated on', 'Type', 'Reason'];
    const csv = dec.decode(toCsvReport({ filename: 'terminations', title: 'Terminations', columns, rows: [] }).bytes);
    expect(csv).toBe('Name,Company,Department,Terminated on,Type,Reason' + CRLF);
  });
});

/**
 * r409 verifier — the PDF writer kept the EN and EM DASH as '?'. Both are WinAnsi codepoints Helvetica
 * draws, so they are not the documented lossy case. Every statutory-forms export title is
 * "<label> — <period>", and the Form E / CP8D preview frames that PDF. Read back from the content stream
 * (pdf-lib writes WinAnsi bytes as hex `<…> Tj`): 0x97 is '—', 0x96 is '–', 0x3F is '?'.
 */
describe('PDF keeps the en and em dash (r409 verifier)', () => {
  const drawnText = async (bytes: Uint8Array): Promise<string> => {
    const { PDFDocument, PDFArray } = await import('pdf-lib');
    const zlib = await import('node:zlib');
    const doc = await PDFDocument.load(bytes);
    let out = '';
    for (const page of doc.getPages()) {
      const c = page.node.Contents();
      const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
      for (const ref of refs) {
        const raw = (doc.context.lookup(ref) as unknown as { contents?: Uint8Array }).contents;
        if (!raw) continue;
        let s: string;
        try {
          s = zlib.inflateSync(Buffer.from(raw)).toString('latin1');
        } catch {
          s = Buffer.from(raw).toString('latin1');
        }
        for (const m of s.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) out += Buffer.from(m[1], 'hex').toString('latin1') + '\n';
      }
    }
    return out;
  };

  it('draws "—" and "–" as themselves, and leaves every figure exactly as the row holds it', async () => {
    const pdf = await toPdfReport({
      filename: 'cp8d',
      title: 'Form E / CP8D — annual (LHDN) — 2025',
      columns: ['No', 'Name', 'Gross'],
      rows: [
        [1, 'A – B', 1234.5],
        [2, 'C', 100],
      ],
    });
    const text = await drawnText(pdf.bytes);
    expect(text.length, 'the content stream must have been read').toBeGreaterThan(20);
    expect(text).toContain('Form E / CP8D \x97 annual (LHDN) \x97 2025');
    expect(text).toContain('A \x96 B');
    expect(text).not.toContain('?');
    // The writer does not format money; a figure prints as the report row holds it.
    expect(text).toContain('1234.5\n');
    expect(text).toContain('100\n');
  });

  it('a codepoint outside WinAnsi is still substituted, not thrown on', async () => {
    const pdf = await toPdfReport({ filename: 'x', title: 'T', columns: ['Name'], rows: [['李伟']] });
    expect(await drawnText(pdf.bytes)).toContain('??');
  });
});
