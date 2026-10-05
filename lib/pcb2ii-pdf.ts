/**
 * PCB 2(II) Pin. 2012: values over the actual, separately verified EN/BM blank forms.
 * The templates own every caption, group boundary, twelve months and THREE EMPTY ROWS in section 3.
 * See assets/pcb2ii/README.md for provenance. Their native Letter page is preserved, without scaling.
 * This reader does not calculate deductions: amounts and existing totals use the shared form helpers.
 * Every dynamic field is measured in its actual Unicode font and official bounds. A missing glyph or
 * unfit complete field refuses preparation; there is no replacement, truncation or continuation page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import {
  pcb2iiAmount,
  pcb2iiDate,
  pcb2iiTotals,
  Pcb2iiPreparationError,
  validPcb2iiSelectedDate,
  type Pcb2iiForm,
} from './pcb2ii-form';
import type { Pcb2iiLang } from './pcb2ii-labels';
import { embedPayslipFaces, payslipFaceScripts, measurePayslipTextBounds } from './payslip-pdf-fonts';

/** Coordinates measured from the two original public blank forms, in points from their top edge. */
const GEOMETRY = {
  en: {
    dateX: 467.62, dateY: 68.64, dateWidth: 66.14,
    branchX: 131.66, branchY: 108.60, branchWidth: 132.14,
    valueX: 263.69, valueWidth: 204.05, yearWidth: 66.14, valueY: 153.02,
    rowPitch: 13.32, monthY: 325.61, totalY: 485.47,
    columns: [131.72, 197.72, 263.75, 329.77, 401.65, 467.68, 533.68],
    officerX: 263.69, officerY: 653.74, officerWidth: 204.05, addressY: 693.72,
  },
  ms: {
    dateX: 453.10, dateY: 70.56, dateWidth: 64.68,
    branchX: 130.22, branchY: 109.80, branchWidth: 129.26,
    valueX: 259.37, valueWidth: 193.85, yearWidth: 64.70, valueY: 158.54,
    rowPitch: 13.08, monthY: 336.89, totalY: 493.87,
    columns: [130.28, 194.84, 259.43, 324.01, 388.57, 453.16, 517.72],
    officerX: 194.78, officerY: 669.10, officerWidth: 193.85, addressY: 708.36,
  },
} as const;

/** Prefer 8.5 pt values; only complete text may reduce, with the reviewed 6 pt floor. */
const SIZES = [8.5, 8, 7.5, 7, 6.5, 6] as const;
const PAD = 2;
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
type Run = { text: string; font: PDFFont };

export async function renderPcb2iiPdf(form: Pcb2iiForm, lang: Pcb2iiLang): Promise<Uint8Array> {
  const doc = await PDFDocument.load(readFileSync(join(process.cwd(), 'assets', 'pcb2ii', `pcb2ii-${lang}.pdf`)));
  const [page] = doc.getPages();
  if (doc.getPageCount() !== 1 || page.getWidth() !== 612 || page.getHeight() !== 792) {
    throw new Error('Invalid PCB 2(II) template');
  }
  if (!validPcb2iiSelectedDate(form.printedOnIso)) throw new Pcb2iiPreparationError('selectedDate');
  if (form.months.length !== 12 || form.months.some((m, index) => m.month !== index + 1)) {
    throw new Pcb2iiPreparationError('fit', 'amount');
  }
  // No allocation is invented for the preceding year; this model's assembler deliberately returns [].
  if (form.priorYearRows.length !== 0) throw new Pcb2iiPreparationError('fit', 'amount');
  const values = [form.employeeName, form.newIcOrPassport, form.employeeTaxNo, form.staffNo,
    form.employerNo, form.officerName, form.officerDesignation, form.officerPhone,
    form.employerNameAddress, form.branch, ...form.months.flatMap(m => [m.mtdReceiptRef ?? '', m.cp38ReceiptRef ?? ''])];
  const scripts = [...new Set(['latin' as const, ...payslipFaceScripts(values)])];
  const faces = await embedPayslipFaces(doc, scripts);
  const g = GEOMETRY[lang];
  doc.setTitle(`PCB 2(II) - ${form.employeeName} - ${form.year}`);
  doc.setProducer('AI HR');

  function runs(text: string, field: string): Run[] {
    if (/[\p{Cc}\p{Cf}]/u.test(text)) throw new Pcb2iiPreparationError('fit', field);
    // Prefer one face for the complete field: Indic/Thai shaping stays within one font run.
    const complete = faces.find(face => [...text].every(ch => face.chars.has(ch.codePointAt(0)!)));
    if (complete) return [{ text, font: complete.regular }];
    const result: Run[] = [];
    for (const { segment } of graphemes.segment(text)) {
      const face = faces.find(f => [...segment].every(ch => f.chars.has(ch.codePointAt(0)!)));
      if (!face) throw new Pcb2iiPreparationError('fit', field);
      const previous = result.at(-1);
      if (previous?.font === face.regular) previous.text += segment;
      else result.push({ text: segment, font: face.regular });
    }
    return result;
  }
  function metrics(text: string, field: string, size: number) {
    let cursor = 0, ascent = 0, descent = 0, left = 0, right = 0;
    for (const run of runs(text, field)) {
      const bounds = measurePayslipTextBounds(run.font, run.text, size);
      ascent = Math.max(ascent, bounds.ascent);
      descent = Math.max(descent, bounds.descent);
      left = Math.min(left, cursor + bounds.left);
      right = Math.max(right, cursor + bounds.right);
      cursor += run.font.widthOfTextAtSize(run.text, size);
    }
    return { measured: cursor, ascent, descent, left, right };
  }
  function fits(text: string, field: string, size: number, maxWidth: number) {
    const m = metrics(text, field, size);
    const occupied = Math.max(m.measured, m.right) - m.left;
    return Number.isFinite(occupied) && Number.isFinite(m.ascent + m.descent)
      && occupied <= maxWidth - 2 * PAD && m.ascent + m.descent <= g.rowPitch - 1;
  }
  function put(text: string, x: number, top: number, maxWidth: number, field: string,
    alignment: 'left' | 'right' | 'center' = 'left', fixedSize?: number) {
    if (!text) return;
    const size = (fixedSize === undefined ? SIZES : [fixedSize]).find(size => fits(text, field, size, maxWidth));
    if (size === undefined) throw new Pcb2iiPreparationError('fit', field);
    const m = metrics(text, field, size);
    const cellTop = top - (g.rowPitch - 3);
    const baseline = cellTop + (g.rowPitch - m.ascent - m.descent) / 2 + m.ascent;
    let cursor = alignment === 'right' ? x + maxWidth - PAD - Math.max(m.measured, m.right)
      : alignment === 'center' ? x + (maxWidth - (m.right - m.left)) / 2 - m.left : x + PAD - m.left;
    for (const run of runs(text, field)) {
      page.drawText(run.text, { x: cursor, y: page.getHeight() - baseline, size, font: run.font, color: rgb(0, 0, 0) });
      cursor += run.font.widthOfTextAtSize(run.text, size);
    }
  }
  put(pcb2iiDate(form.printedOnIso), g.dateX, g.dateY, g.dateWidth, 'date');
  put(form.branch, g.branchX, g.branchY, g.branchWidth, 'branch');
  const employee = [String(form.year), form.employeeName, form.newIcOrPassport,
    form.employeeTaxNo, form.staffNo, form.employerNo];
  employee.forEach((value, i) => put(value, g.valueX, g.valueY + i * g.rowPitch,
    i === 0 ? g.yearWidth : g.valueWidth, i === 1 ? 'employeeName' : 'identifier'));
  form.months.forEach((month, i) => {
    const y = g.monthY + i * g.rowPitch;
    const cells = [pcb2iiAmount(month.mtd), pcb2iiAmount(month.cp38), month.mtdReceiptRef ?? '',
      month.cp38ReceiptRef ?? '', pcb2iiDate(month.mtdPaidOn), pcb2iiDate(month.cp38PaidOn)];
    cells.forEach((value, col) => put(value, g.columns[col], y, g.columns[col + 1] - g.columns[col],
      col < 2 ? 'amount' : col < 4 ? 'receiptRef' : 'date', col < 2 ? 'right' : 'center'));
  });
  const totals = pcb2iiTotals(form.months);
  put(pcb2iiAmount(totals.mtd), g.columns[0], g.totalY, g.columns[1] - g.columns[0], 'amount', 'right');
  put(pcb2iiAmount(totals.cp38), g.columns[1], g.totalY, g.columns[2] - g.columns[1], 'amount', 'right');
  [form.officerName, form.officerDesignation, form.officerPhone].forEach((value, i) =>
    put(value, g.officerX, g.officerY + i * g.rowPitch, g.officerWidth,
      ['officerName', 'officerDesignation', 'phone'][i]));

  // The official employer area has three lines. Like EA, keep name and address separate,
  // wrap words first, and split only an unbroken word on complete grapheme boundaries.
  // Prefer readable full-size text; reduce only when all complete content cannot fit those lines.
  let employerBlock: {size: number; lines: string[]} | null = null;
  sizeAttempt: for (const size of SIZES) {
    const lines: string[] = [];
    for (const paragraph of form.employerNameAddress.split(/\r?\n/)) {
      if (/[\p{Cc}\p{Cf}]/u.test(paragraph)) throw new Pcb2iiPreparationError('fit', 'employerNameAddress');
      let line = '';
      for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (fits(candidate, 'employerNameAddress', size, g.officerWidth)) { line = candidate; continue; }
        if (line) { lines.push(line); line = ''; }
        for (const {segment} of graphemes.segment(word)) {
          if (!fits(line + segment, 'employerNameAddress', size, g.officerWidth)) {
            if (!line) continue sizeAttempt;
            lines.push(line); line = '';
          }
          line += segment;
        }
      }
      lines.push(line);
    }
    if (lines.length <= 3 && lines.every(line => !line || fits(line, 'employerNameAddress', size, g.officerWidth))) {
      employerBlock = {size, lines}; break;
    }
  }
  if (!employerBlock) throw new Pcb2iiPreparationError('fit', 'employerNameAddress');
  const fittedEmployer = employerBlock;
  fittedEmployer.lines.forEach((line, i) => put(line, g.officerX, g.addressY + i * g.rowPitch,
    g.officerWidth, 'employerNameAddress', 'left', fittedEmployer.size));
  return doc.save();
}
