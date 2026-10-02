import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderPcb2iiPdf } from '../lib/pcb2ii-pdf';
import { embedPayslipFaces, measurePayslipTextBounds } from '../lib/payslip-pdf-fonts';
import { emptyPcb2iiMonths, Pcb2iiPreparationError, type Pcb2iiForm } from '../lib/pcb2ii-form';

const out = join(process.cwd(), 'scratchpad/codex-r379-pcb2ii');
function fixture(): Pcb2iiForm {
  const months = emptyPcb2iiMonths();
  months[0] = { ...months[0], mtd: 0, cp38: 0, mtdReceiptRef: 'PCB-0001', cp38ReceiptRef: 'CP38-0001', mtdPaidOn: '2026-02-15', cp38PaidOn: '2026-02-16' };
  months[11] = { ...months[11], mtd: 412.35, cp38: 150, mtdReceiptRef: 'PCB-0012', cp38ReceiptRef: 'CP38-0012', mtdPaidOn: '2027-01-15', cp38PaidOn: '2027-01-16' };
  return { year: 2026, printedOnIso: '2028-02-29', branch: '', employeeName: 'Synthetic employee', newIcOrPassport: 'SYNTHETIC-01', employeeTaxNo: 'IG-SYNTHETIC', staffNo: 'EMP-SYN', employerNo: 'E-SYNTHETIC', months, priorYearRows: [], officerName: 'Synthetic officer', officerDesignation: 'Executive', officerPhone: '03-00000000', employerNameAddress: 'Synthetic Employer Sdn Bhd\n1 Sample Road, Kuala Lumpur' };
}
function extract(bytes: Uint8Array, name: string) {
  mkdirSync(out, { recursive: true });
  const path = join(out, name + '.pdf');
  writeFileSync(path, bytes);
  return { path, text: execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' }) };
}

describe('r379 · exact official pages and complete Unicode fields', () => {
  it('preserves each actual official Letter template, complete month structure and recorded values', async () => {
    for (const lang of ['en', 'ms'] as const) {
      const bytes = await renderPcb2iiPdf(fixture(), lang);
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
      const { text } = extract(bytes, 'render-normal-' + lang);
      for (const value of ['Synthetic employee', 'Synthetic officer', 'IG-SYNTHETIC', '29/02/2028', 'PCB-0001', 'CP38-0012', '412.35', '150.00', '0.00']) expect(text, value).toContain(value);
      expect(text).toContain(lang === 'en' ? 'January' : 'Januari');
      expect(text).toContain(lang === 'en' ? 'December' : 'Disember');
      expect(text).toContain(lang === 'en' ? 'Total' : 'Jumlah');
      expect(text).toContain(lang === 'en' ? 'preceeding year' : 'tahun terdahulu');
      // These are the original blank pages, with no recreated labels/grid or page scaling.
      const original = execFileSync('pdftotext', [join(process.cwd(), 'assets/pcb2ii', `pcb2ii-${lang}.pdf`), '-'], { encoding: 'utf8' });
      for (const caption of original.split('\n').map(line => line.trim()).filter(Boolean)) {
        expect(text.replace(/\s+/g, ' ')).toContain(caption.replace(/\s+/g, ' '));
      }
    }
  });
  it('embeds real Unicode glyphs and extracts complete mixed-script names and unbroken addresses', async () => {
    const form = fixture();
    form.employeeName = '陈 தி ไทย Đặng';
    form.officerName = 'Nguyễn 陈';
    form.officerDesignation = 'ผู้จัดการ';
    form.employerNameAddress = '示例公司\n完整地址完整地址完整地址完整地址完整地址完整地址';
    for (const lang of ['en', 'ms'] as const) {
      const { path, text } = extract(await renderPcb2iiPdf(form, lang), 'render-unicode-' + lang);
      expect(text).toContain('陈');
      expect(text).toContain('Đặng');
      expect(text).toContain('Nguyễn');
      expect(text.replace(/\s/g, '')).toContain(form.employerNameAddress.replace(/\s/g, ''));
      expect(text).not.toContain('?');
      const fonts = execFileSync('pdffonts', [path], { encoding: 'utf8' });
      expect(fonts).toContain('NotoSans');
      for (const line of fonts.split('\n').filter(line => line.startsWith('NotoSans'))) expect(line).toMatch(/yes\s+(?:yes|no)\s+yes/);
      for (const script of ['Tamil', 'Thai']) {
        const pattern = new RegExp(`\\p{Script=${script}}`, 'u');
        const codepoints = (value: string) => [...value].filter(ch => pattern.test(ch)).map(ch => ch.codePointAt(0)!).sort((a, b) => a - b);
        expect(codepoints(text), script).toEqual(codepoints(form.employeeName + form.officerName + form.officerDesignation + form.employerNameAddress));
      }
    }
  });
  it('measures actual shaped glyph ink rather than whole-font maxima', async () => {
    const doc = await PDFDocument.create();
    const faces = await embedPayslipFaces(doc, ['latin', 'cjk', 'tamil', 'thai']);
    for (const [script, text] of [['latin', 'Nguyễn'], ['cjk', '陈'], ['tamil', 'தி'], ['thai', 'ไทย']] as const) {
      const face = faces.find(f => f.script === script)!;
      const measured = measurePayslipTextBounds(face.regular, text, 8.5);
      expect(measured.ascent + measured.descent, script).toBeLessThan(12.08);
      expect(measured.ascent, script).toBeGreaterThan(0);
      expect(measured.left, script).toBeLessThanOrEqual(0);
      expect(Number.isFinite(measured.right), script).toBe(true);
    }
    const cjk = faces.find(f => f.script === 'cjk')!;
    expect(measurePayslipTextBounds(cjk.regular, '🦄', 8.5).ascent).toBe(Infinity);
  });
  it('refuses complete unfit names, identifiers, receipts and addresses with the exact field code', async () => {
    for (const lang of ['en', 'ms'] as const) {
      for (const [field, mutate] of [
        ['employeeName', (f: Pcb2iiForm) => { f.employeeName = 'Full employee name '.repeat(100); }],
        ['officerName', (f: Pcb2iiForm) => { f.officerName = 'Full officer name '.repeat(100); }],
        ['identifier', (f: Pcb2iiForm) => { f.employeeTaxNo = 'IG'.repeat(100); }],
        ['receiptRef', (f: Pcb2iiForm) => { f.months[0].mtdReceiptRef = '完整交易编号'.repeat(100); }],
        ['employerNameAddress', (f: Pcb2iiForm) => { f.employerNameAddress = '完整地址'.repeat(100); }],
      ] as const) {
        const form = fixture(); mutate(form);
        await expect(renderPcb2iiPdf(form, lang), field).rejects.toMatchObject({ code: 'fit', field });
      }
    }
  });
  it('prints a complete receipt at the reviewed 6 pt floor', async () => {
    const form = fixture(); form.months[0].mtdReceiptRef = 'LHDN202612000001';
    const { path, text } = extract(await renderPcb2iiPdf(form, 'ms'), 'render-floor-ms');
    expect(text).toContain('LHDN202612000001');
    const sizes = JSON.parse(execFileSync('python3', ['-c', "import fitz,json,sys; page=fitz.open(sys.argv[1])[0]; print(json.dumps([s['size'] for b in page.get_text('dict')['blocks'] for l in b.get('lines',[]) for s in l['spans'] if 'LHDN202612000001' in s['text']]))", path], { encoding: 'utf8' }));
    expect(sizes).toEqual([6]);
    form.months[0].mtdReceiptRef = 'LHDN2026120000012';
    await expect(renderPcb2iiPdf(form, 'ms')).rejects.toMatchObject({ code: 'fit', field: 'receiptRef' });
  });
  it('refuses an unsupported glyph rather than printing a replacement character', async () => {
    const form = fixture(); form.employeeName = 'Complete 🦄 name';
    await expect(renderPcb2iiPdf(form, 'en')).rejects.toBeInstanceOf(Pcb2iiPreparationError);
    await expect(renderPcb2iiPdf(form, 'en')).rejects.toMatchObject({ code: 'fit', field: 'employeeName' });
  });
});
