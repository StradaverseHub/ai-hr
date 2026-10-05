import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFPage, type PDFPageDrawTextOptions } from 'pdf-lib';
import { renderPcb2iiPdf } from '../lib/pcb2ii-pdf';
import { measurePayslipTextBounds } from '../lib/payslip-pdf-fonts';
import { emptyPcb2iiMonths, type Pcb2iiForm } from '../lib/pcb2ii-form';

function fixture(): Pcb2iiForm {
  const months = emptyPcb2iiMonths();
  months[0] = { ...months[0], mtd: 0, cp38: 25, mtdReceiptRef: 'A1', cp38ReceiptRef: 'CP38-00001', mtdPaidOn: '2026-02-15', cp38PaidOn: '2026-02-16' };
  months[11] = { ...months[11], mtd: 125.35, cp38: null, mtdReceiptRef: 'PCB-0012', mtdPaidOn: '2027-01-15' };
  return { year: 2026, printedOnIso: '2027-02-28', branch: '', employeeName: 'Synthetic employee', newIcOrPassport: 'SYN-01', employeeTaxNo: 'IG-SYN', staffNo: 'EMP-SYN', employerNo: 'E-SYN', months, priorYearRows: [], officerName: 'Synthetic officer', officerDesignation: 'Executive', officerPhone: '03-12345678', employerNameAddress: 'Sample Employer Sdn Bhd\n12 Sample Road, Kuala Lumpur' };
}
const geometry = {
  en: { columns: [131.72,197.72,263.75,329.77,401.65,467.68,533.68], monthY: 325.61, pitch: 13.32, addressY: 693.72 },
  ms: { columns: [130.28,194.84,259.43,324.01,388.57,453.16,517.72], monthY: 336.89, pitch: 13.08, addressY: 708.36 },
};
// Independent outline union: does not consume the production measurement helper.
function inkBounds(font: NonNullable<PDFPageDrawTextOptions['font']>, text: string, size: number) {
  type Glyph = {advanceWidth: number; bbox: {minX: number;maxX: number;minY: number;maxY: number};path?: {commands: unknown[]}};
  const parsed = (font as unknown as {embedder: {font: {unitsPerEm: number;layout(text: string): {glyphs: Glyph[]}}}}).embedder.font;
  let cursor = 0, left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity, outlines = 0;
  for (const glyph of parsed.layout(text).glyphs) {
    const b = glyph.bbox;
    if (glyph.path?.commands.length !== 0) {
      expect([b.minX,b.maxX,b.minY,b.maxY].every(Number.isFinite)).toBe(true);
      left=Math.min(left,cursor+b.minX);right=Math.max(right,cursor+b.maxX);
      bottom=Math.min(bottom,b.minY);top=Math.max(top,b.maxY);outlines++;
    }
    cursor+=glyph.advanceWidth;
  }
  expect(outlines,'centering evidence must contain actual outlines').toBeGreaterThan(0);
  const scale=size/parsed.unitsPerEm;
  return {left:left*scale,right:right*scale,ascent:top*scale,descent:-bottom*scale};
}
function capture() {
  const draws: { text: string; options: PDFPageDrawTextOptions }[] = [];
  const original = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function(this: PDFPage, text, options = {}) {
    draws.push({ text, options });
    return original.call(this, text, options);
  });
  return draws;
}
afterEach(() => vi.restoreAllMocks());

describe('r388 · PCB2II original box layout', () => {
  it.each(['en', 'ms'] as const)('centres short and longer receipt references and payment dates inside %s original cells', async lang => {
    const draws = capture();
    const form = fixture();
    const doc = await PDFDocument.load(await renderPcb2iiPdf(form, lang));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const g = geometry[lang];
    for (const [text, col, row] of [
      ['A1',2,0], ['CP38-00001',3,0], ['15/02/2026',4,0], ['16/02/2026',5,0],
      ['PCB-0012',2,11], ['15/01/2027',4,11],
    ] as const) {
      const draw = draws.find(d => d.text === text)!;
      expect(draw, text).toBeDefined();
      const { x, y, size, font } = draw.options;
      const bounds = inkBounds(font!, text, size!);
      expect(x! + (bounds.left + bounds.right) / 2, text + ' horizontal centre').toBeCloseTo((g.columns[col] + g.columns[col + 1]) / 2, 5);
      const cellTop = g.monthY + row * g.pitch - (g.pitch - 3);
      expect(792 - y! + (bounds.descent - bounds.ascent) / 2, text + ' vertical centre').toBeCloseTo(cellTop + g.pitch / 2, 5);
    }
    expect(draws.filter(d => ['0.00','25.00','125.35'].includes(d.text)).map(d => d.text)).toEqual(['0.00','25.00','125.35','125.35','25.00']);
    expect(form.months[11].cp38).toBeNull();
  });

  it.each(['en', 'ms'] as const)('keeps the complete employer name separate and wraps address words at readable size in %s', async lang => {
    const draws = capture();
    const form = fixture();
    form.employerNameAddress = 'Sample Employer Sdn Bhd\n12 Sample Road, Business Park, 50000 Kuala Lumpur';
    await renderPcb2iiPdf(form, lang);
    const g = geometry[lang];
    const address = draws.filter(d => 792 - d.options.y! >= g.addressY - g.pitch && 792 - d.options.y! <= g.addressY + 3 * g.pitch);
    expect(address[0].text).toBe('Sample Employer Sdn Bhd');
    expect(address.map(d => d.text).join(' ')).toBe(form.employerNameAddress.replace('\n', ' '));
    expect(address).toHaveLength(3);
    expect(address.every(d => d.options.size === 8.5)).toBe(true);
  });

  it.each(['en', 'ms'] as const)('keeps every grapheme of an unbroken Unicode address inside %s employer bounds', async lang => {
    const draws = capture();
    const form = fixture();
    form.employerNameAddress = '示例公司\n' + '完整地址'.repeat(9);
    await renderPcb2iiPdf(form, lang);
    const g = geometry[lang];
    const address = draws.filter(d => 792 - d.options.y! >= g.addressY - g.pitch && 792 - d.options.y! <= g.addressY + 3 * g.pitch);
    expect(address.map(d => d.text).join('')).toBe(form.employerNameAddress.replace('\n', ''));
    expect(address.length).toBeLessThanOrEqual(3);
    const x = lang === 'en' ? 263.69 : 194.78;
    const width = lang === 'en' ? 204.05 : 193.85;
    for (const {text, options} of address) {
      expect(options.size).toBeGreaterThanOrEqual(6);
      const bounds = measurePayslipTextBounds(options.font!, text, options.size!);
      expect(options.x! + bounds.left).toBeGreaterThanOrEqual(x + 2);
      expect(options.x! + bounds.right).toBeLessThanOrEqual(x + width - 2 + 0.000001);
    }
  });

  it.each(['en', 'ms'] as const)('refuses a complete employer block that cannot fit the three original lines in %s', async lang => {
    const form = fixture();
    form.employerNameAddress = 'Employer\n' + 'Complete address details '.repeat(80);
    await expect(renderPcb2iiPdf(form, lang)).rejects.toMatchObject({ code: 'fit', field: 'employerNameAddress' });
  });
});
