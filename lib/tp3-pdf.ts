/**
 * df35d60d — draw a completed LHDN TP3 (1/2026), A4 portrait, with pdf-lib. Follows lib/tp1-pdf.ts and
 * lib/pcb2ii-pdf.ts, which are the house pattern for a form we draw from scratch.
 *
 * ⚠️ THIS IS OUR OWN LAYOUT, DRAWN TO MATCH THE AGENCY'S FORM, AND THE PAGE SAYS SO. Nothing is overlaid
 * on agency artwork and this document must never be described as the official form. The provenance band
 * at the foot of the last page states it in plain words, in Malay and English — the same refusal every
 * other statutory document in this repo carries, and for the same reason: what we hold is a rendering,
 * and a statutory form that claims an authority it does not have is worse than an obviously unofficial
 * one.
 *
 * WHAT IS FAITHFUL, DELIBERATELY: the agency's own wording, its section headings A–E, its numbering
 * (A1–A4, B1–B3, C1–C5 with C2's five numerals and C4's two, D1–D17 with their lettered sub-lines), its
 * legal reference, its NOTE block, and its COLUMN LAYOUT — Section C has ONE money column and no annual
 * limit column; Section D has ANNUAL LIMIT (RM) then ACCUMULATED DEDUCTION (RM). Those are what the form
 * asks for and what a reader checks it against.
 *
 * ── THE STRUCTURE IS THE CALLER'S, NOT THIS FILE'S ──────────────────────────────────────────────────
 * Every line, sub-line and limit arrives in `Tp3PdfData`, built from the COUNTRY PACK catalogue — whose
 * Section D IS the TP1's item list, the same array object. This renderer states no ringgit figure of its
 * own. An item whose limit is null prints "—" in the Annual Limit column, because ADR-0008 applies to
 * what we PRINT as much as to what we check.
 *
 * ── FOUR THINGS THAT FAIL SILENTLY IF DROPPED, EACH GUARDED BELOW ──────────────────────────────────
 * 1. SECTION A IS RULED FOR A FIXED NUMBER OF EMPLOYERS. The paper form has exactly two name/TIN pairs
 *    and a footnote sending the next employment to an attachment. `employerSlots` is that number and
 *    EVERY slot is drawn whether or not it is filled — an unfilled A3/A4 prints the blank rule the paper
 *    form has, because a form that silently stops after one employer is a form a reader cannot check.
 *    test/df35d60d-tp3-form.test.ts counts the drawn slots.
 * 2. PAGINATION. Five Section C lines with seven boxes plus seventeen Section D items with up to six
 *    sub-lines will not fit one A4. `need()` opens a new page when the cursor passes the floor and the
 *    column headings repeat at the top of each — a table whose rows continue under no headings is
 *    unreadable and no static check can see it.
 * 3. LATIN-1 FOLDING. Helvetica is WinAnsi. An em dash or a curly quote in a previous employer's name
 *    would print as '?' — folded here, the same documented limitation lib/tp1-pdf.ts carries. The
 *    DEDUCTION MONTH prints as the NUMBER the form's own box takes, never a month name: a localised
 *    month name in Tamil, Thai or Chinese would fold to a row of '?' (lib/payslip-pdf-strings.ts records
 *    that finding and pins its own month names to English for exactly this reason).
 * 4. AN UNDECLARED BOX MUST NOT PRINT AS ZERO. `0.00` asserts that the money does not exist, which on a
 *    previous employer's figures is a statement nobody made. Only boxes with a stored figure print one;
 *    the rest print the empty ruled box the paper form has.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const W = 595.28;
const H = 841.89;
const M = 34;
const RIGHT = W - M;
/** Money columns, right-aligned, measured against their own headings. */
const COL = { limitR: W - M - 120, accR: W - M };
const DESC_W = COL.limitR - M - 70;
const FLOOR = M + 80;

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One lettered / numbered sub-line as it prints. */
export type Tp3PdfSubItem = {
  code: string;
  description: string;
  /** The "(Limited RM…)" the form prints against this line, or null when it prints none. */
  limit: number | null;
  /** Null ⇒ nothing was recorded against this box: an EMPTY rule, never a printed zero. */
  amount: number | null;
  frequency?: string | null;
};

/** One numbered line — C1–C5 or D1–D17 — as it prints. */
export type Tp3PdfItem = {
  /** The number the FORM prints against this line ("C1", "D16"), resolved by the caller. */
  label: string;
  description: string;
  limit: number | null;
  amount: number | null;
  frequency?: string | null;
  subItems: Tp3PdfSubItem[];
  /** D16 — each house-price band carries its own limit AND its own accumulated box. */
  perSubLimit?: boolean;
};

export type Tp3PdfData = {
  /** The agency's own revision string, from the pack (e.g. "PCB FORM /TP3 (1/2026)"). */
  formCode: string;
  deductionMonth: number | null;
  deductionYear: number;
  /**
   * Section A. EXACTLY `employerSlots` pairs are drawn. A shorter array leaves the remaining slots as
   * the blank rules the paper form has; a LONGER one is a caller bug and is refused rather than
   * truncated — silently dropping an employer off a statutory form is the failure this guards.
   */
  employerSlots: number;
  employers: { name: string | null; tin: string | null }[];
  /** The footnote the form prints under A4, in the reader's own language. */
  employerFootnote: string;
  employee: { name: string; idNumber: string | null; tin: string | null };
  sectionC: Tp3PdfItem[];
  sectionD: Tp3PdfItem[];
  /** Every heading and column caption, already translated. This file hardcodes no prose but the masthead. */
  labels: {
    sectionA: string;
    sectionB: string;
    sectionC: string;
    sectionCHelp: string;
    sectionD: string;
    sectionDHelp: string;
    sectionE: string;
    deductionMonth: string;
    deductionYear: string;
    employerName: (i: number) => string;
    employerTin: (i: number) => string;
    employeeName: string;
    employeeIdNumber: string;
    employeeTin: string;
    colAnnualLimit: string;
    colAccumulated: string;
    date: string;
    signature: string;
    note: string;
    noteLines: string[];
  };
  /** Section E — the acknowledgement text and when it was confirmed (null ⇒ an empty Date box). */
  declaration: { text: string; declaredOn: string | null };
  /** The provenance band, in the reader's own language plus English. Supplied, never hardcoded here. */
  provenance: string[];
};

/** A caller that hands over more employers than the form is ruled for has a bug, not a long form. */
export class Tp3PdfOverflowError extends Error {
  constructor(given: number, slots: number) {
    super(`Form TP3 is ruled for ${slots} previous employers; ${given} were supplied.`);
    this.name = 'Tp3PdfOverflowError';
  }
}

export async function renderTp3Pdf(data: Tp3PdfData): Promise<Uint8Array> {
  if (data.employers.length > data.employerSlots) {
    throw new Tp3PdfOverflowError(data.employers.length, data.employerSlots);
  }

  const doc = await PDFDocument.create();
  doc.setTitle(`TP3 ${data.deductionYear} — ${data.employee.name}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.6, 0.6, 0.65);
  const hair = rgb(0.82, 0.82, 0.86);

  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  const wrapTo = (s: string, maxW: number, size: number, f: PDFFont): string[] => {
    const out: string[] = [];
    let cur = '';
    for (const w of safe(s).split(/\s+/)) {
      const trial = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && cur) {
        out.push(cur);
        cur = w;
      } else cur = trial;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const textR = (s: string, xr: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });
  const line = (thickness = 0.7, color = rule) =>
    page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness, color });

  /** Which column headings to repeat after a page break, if any. Set by each section as it opens. */
  let repeat: (() => void) | null = null;
  /** Open a new page when `h` points would cross the floor, and repeat the section's headings there. */
  const need = (h: number) => {
    if (y - h >= FLOOR) return;
    page = doc.addPage([W, H]);
    y = H - M;
    repeat?.();
  };

  /** Section banner — the tinted strip the agency's own form uses to open each section. */
  const banner = (label: string, help?: string) => {
    need(26);
    page.drawRectangle({ x: M, y: y - 4, width: RIGHT - M, height: 15, color: rgb(0.85, 0.9, 0.95) });
    text(label, M + 4, 9, bold);
    if (help) text(help, M + 4 + bold.widthOfTextAtSize(safe(label), 9) + 6, 6.5, font, muted);
    y -= 22;
  };

  /** A money cell: a figure when one was recorded, an empty ruled box when nothing was. */
  const cell = (value: number | null, xr: number, size = 8) => {
    if (value == null) {
      page.drawLine({ start: { x: xr - 66, y: y - 2 }, end: { x: xr, y: y - 2 }, thickness: 0.4, color: hair });
      return;
    }
    textR(money(value), xr, size);
  };

  // ── Masthead: the agency's own headings and legal reference, verbatim ──────────────────────────────
  textR(data.formCode, RIGHT, 10, bold);
  y -= 16;
  const centred = (s: string, size: number, f = font, color = ink) => {
    const v = safe(s);
    page.drawText(v, { x: (W - f.widthOfTextAtSize(v, size)) / 2, y, size, font: f, color });
    y -= size + 3;
  };
  centred('INLAND REVENUE BOARD OF MALAYSIA', 9, bold);
  centred('INDIVIDUAL TAX DEDUCTION AND REBATE CLAIM FORM FOR MONTHLY TAX DEDUCTION PURPOSES (PCB)', 7.5, bold);
  centred('INCOME TAX (DEDUCTIONS FROM REMUNERATION) REGULATIONS 1994', 7.5, bold);
  centred('This form is prescribed under Section 152 of the Income Tax Act (ITA) 1967', 7, font, muted);
  y -= 8;
  // THE MONTH IS THE NUMBER THE FORM'S OWN BOX TAKES, never a month name. See the header, point 3.
  text(`${data.labels.deductionMonth}  ${data.deductionMonth ?? '—'}`, M + 60, 8.5, bold);
  text(`${data.labels.deductionYear}  ${data.deductionYear}`, M + 300, 8.5, bold);
  y -= 16;

  // ── Sections A and B ──────────────────────────────────────────────────────────────────────────────
  const kv = (code: string, label: string, value: string | null) => {
    need(14);
    text(code, M + 4, 8, bold);
    for (const l of wrapTo(label, 195, 8, font).slice(0, 1)) text(l, M + 28, 8);
    text(':', M + 230, 8);
    // A BLANK RULE RATHER THAN AN INVENTED VALUE — the rule lib/tp1-pdf.ts and lib/borang-a-pdf.ts follow.
    if (value && value.trim() !== '') text(value, M + 240, 8, bold);
    else page.drawLine({ start: { x: M + 240, y: y - 2 }, end: { x: RIGHT - 40, y: y - 2 }, thickness: 0.5, color: hair });
    y -= 13;
  };

  banner(data.labels.sectionA);
  // EVERY SLOT THE FORM IS RULED FOR, filled or not. See the header, point 1.
  for (let i = 0; i < data.employerSlots; i++) {
    const e = data.employers[i];
    kv(`A${i * 2 + 1}`, data.labels.employerName(i + 1), e?.name ?? null);
    kv(`A${i * 2 + 2}`, data.labels.employerTin(i + 1), e?.tin ?? null);
  }
  need(12);
  text(data.employerFootnote, M + 4, 6.5, font, muted);
  y -= 14;

  banner(data.labels.sectionB);
  kv('B1', data.labels.employeeName, data.employee.name);
  kv('B2', data.labels.employeeIdNumber, data.employee.idNumber);
  kv('B3', data.labels.employeeTin, data.employee.tin);
  y -= 4;

  /**
   * One numbered line and its sub-lines.
   *
   * `withLimit` is what separates the two sections: Section C has NO annual-limit column on the paper
   * form, so nothing is drawn there and the one money column is the accumulated figure. Section D has
   * both. Passing the section's own shape in rather than branching on a code keeps this renderer from
   * knowing which form section it is drawing.
   */
  const drawItem = (item: Tp3PdfItem, withLimit: boolean) => {
    const descLines = wrapTo(item.description, DESC_W, 8, font);
    need(14 + descLines.length * 10 + item.subItems.length * 22);
    text(item.label, M, 8.5, bold);
    for (const [i, l] of descLines.entries()) {
      text(l, M + 32, 8);
      // The line's own money row sits on the FIRST description line, so a three-line description does
      // not push its figures away from the number they belong to.
      if (i === 0 && !item.perSubLimit) {
        if (withLimit) textR(item.limit == null ? '—' : money(item.limit), COL.limitR, 8);
        cell(item.amount, COL.accR);
      }
      y -= 10;
    }
    if (item.frequency) {
      for (const l of wrapTo(item.frequency, DESC_W, 7, font)) {
        need(10);
        text(l, M + 32, 7, font, muted);
        y -= 9;
      }
    }
    for (const sub of item.subItems) {
      const subLines = wrapTo(sub.description, DESC_W - 20, 7.5, font);
      need(subLines.length * 9 + 12);
      for (const [i, l] of subLines.entries()) {
        text(i === 0 ? `${sub.code})  ${l}` : `      ${l}`, M + 46, 7.5);
        if (i === 0) {
          // A "(Limited RM…)" sub-line prints its own limit; a plain one leaves the column to the group.
          if (withLimit && sub.limit != null) textR(money(sub.limit), COL.limitR, 7.5);
          if (item.perSubLimit) cell(sub.amount, COL.accR, 7.5);
          else if (sub.amount != null) textR(money(sub.amount), COL.accR, 7.5);
        }
        y -= 9;
      }
      if (sub.frequency) {
        for (const l of wrapTo(sub.frequency, DESC_W - 20, 7, font)) {
          need(10);
          text(l, M + 46, 7, font, muted);
          y -= 9;
        }
      }
    }
    y -= 3;
    page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
    y -= 8;
  };

  // ── Section C — ONE money column, no annual limit. The form has no limit column here. ─────────────
  banner(data.labels.sectionC, data.labels.sectionCHelp);
  const headingsC = () => {
    textR(data.labels.colAccumulated, COL.accR, 6.5, bold, muted);
    y -= 5;
    line(0.9);
    y -= 11;
  };
  repeat = headingsC;
  headingsC();
  for (const item of data.sectionC) drawItem(item, false);

  // ── Section D — the shared relief schedule, printed as D1–D17 ─────────────────────────────────────
  y -= 8;
  banner(data.labels.sectionD, data.labels.sectionDHelp);
  const headingsD = () => {
    textR(data.labels.colAnnualLimit, COL.limitR, 6.5, bold, muted);
    textR(data.labels.colAccumulated, COL.accR, 6.5, bold, muted);
    y -= 5;
    line(0.9);
    y -= 11;
  };
  repeat = headingsD;
  headingsD();
  for (const item of data.sectionD) drawItem(item, true);
  repeat = null;

  // ── Section E ─────────────────────────────────────────────────────────────────────────────────────
  banner(data.labels.sectionE);
  for (const l of wrapTo(data.declaration.text, RIGHT - M, 7.5, font)) {
    need(12);
    text(l, M, 7.5);
    y -= 10;
  }
  y -= 6;
  need(44);
  text(`${data.labels.date}  ${data.declaration.declaredOn ?? ''}`, M, 8);
  if (data.declaration.declaredOn == null) {
    page.drawLine({ start: { x: M + 40, y: y - 2 }, end: { x: M + 180, y: y - 2 }, thickness: 0.5, color: hair });
  }
  y -= 34;
  // The signature rule is DRAWN EMPTY, always. An electronic acknowledgement is recorded as a date and a
  // named actor in the system; stamping a signature onto a legal declaration would be inventing one.
  page.drawLine({ start: { x: M + 300, y }, end: { x: M + 460, y }, thickness: 0.7, color: rule });
  y -= 10;
  text(data.labels.signature, M + 356, 7.5, font, muted);
  y -= 16;

  // ── The agency's own NOTE block, verbatim from the form's last page ────────────────────────────────
  need(20 + data.labels.noteLines.length * 12);
  text(data.labels.note, M, 8, bold);
  y -= 12;
  for (const n of data.labels.noteLines) {
    for (const l of wrapTo(n, RIGHT - M, 7.5, font)) {
      need(12);
      text(l, M, 7.5, font, muted);
      y -= 10;
    }
    y -= 3;
  }

  // ── Provenance band, last page, anchored to the foot ───────────────────────────────────────────────
  y = M + 34;
  page.drawLine({ start: { x: M, y: y + 12 }, end: { x: RIGHT, y: y + 12 }, thickness: 0.7, color: hair });
  for (const paragraph of data.provenance) {
    for (const l of wrapTo(paragraph, RIGHT - M, 6.8, font)) {
      page.drawText(l, { x: M, y, size: 6.8, font, color: muted });
      y -= 9;
    }
  }

  return doc.save();
}
