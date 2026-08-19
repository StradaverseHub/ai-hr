/**
 * 7ad37961 — draw a completed LHDN TP1 (1/2026), A4 portrait, with pdf-lib (pure JS, no WASM/native, so
 * no Next bundler friction). Mirrors lib/borang-a-pdf.ts and lib/borang-8a-pdf.ts, which are the house
 * pattern for a form we draw from scratch.
 *
 * ⚠️ THIS IS OUR OWN LAYOUT, DRAWN TO MATCH THE AGENCY'S FORM, AND THE PAGE SAYS SO. Every rule, box and
 * heading below is drawn; nothing is overlaid on agency artwork, and this document must never be
 * described as the official form. That claim has been refused twice in this repo on other statutory
 * documents and the reasoning is the same here: what we hold is a rendering, and a statutory form that
 * claims an authority it does not have is worse than an obviously unofficial one. The provenance band at
 * the foot of the last page states it in plain words, in Malay and English.
 *
 * WHAT IS FAITHFUL, DELIBERATELY: the agency's own wording, its numbering (C1–C17, D1, Sections A–F),
 * its legal references, and its COLUMN ORDER — ANNUAL LIMIT (RM) · DEDUCTION [ CURRENT (RM) ·
 * ACCUMULATED (RM) ]. Those are what the form asks for and what a reader checks it against.
 *
 * ── THE STRUCTURE IS THE CALLER'S, NOT THIS FILE'S ──────────────────────────────────────────────────
 * Every item, sub-line and limit arrives in `Tp1PdfData.items`, built from the COUNTRY PACK catalogue.
 * This renderer states no ringgit figure of its own. An item whose limit is null prints "—" in the
 * Annual Limit column, because ADR-0008 applies to what we PRINT as much as to what we check: printing a
 * plausible cap we cannot cite would put an invented statutory number on a tax document.
 *
 * ── FOUR THINGS THAT FAIL SILENTLY IF DROPPED, EACH GUARDED BELOW ──────────────────────────────────
 * 1. PAGINATION. Seventeen items with up to six sub-lines each will not fit one A4. `flow()` opens a new
 *    page when the cursor passes the floor, and the column headings repeat at the top of each — a table
 *    whose rows continue under no headings is unreadable and no static check can see it.
 * 2. LATIN-1 FOLDING. Helvetica is WinAnsi. An em dash or a curly quote in a company name would print as
 *    '?' — folded here, the same documented limitation lib/borang-a-pdf.ts carries.
 * 3. CLIPPING. pdf-lib's text neither wraps nor truncates; a long item description would run straight
 *    over the money columns. `wrapTo` breaks descriptions to the column width, and every line is drawn.
 * 4. AN UNDECLARED ROW MUST NOT PRINT AS ZERO. A zero in the Current column asserts "nothing was
 *    claimed", which is a statement about a legal declaration. Only items with a stored figure print
 *    one; the rest print an empty box, which is what the paper form's own blank boxes are.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const W = 595.28;
const H = 841.89;
const M = 34;
const RIGHT = W - M;
/** Money columns, right-aligned, measured against their own headings. */
const COL = { limitR: W - M - 200, currentR: W - M - 100, accR: W - M };
const DESC_W = COL.limitR - M - 70;
const FLOOR = M + 80;

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One lettered sub-line as it prints. */
export type Tp1PdfSubItem = {
  code: string;
  description: string;
  limit: number | null;
  /** Null ⇒ nothing was declared against this line: an EMPTY box, never a printed zero. */
  current: number | null;
  accumulated: number | null;
  frequency?: string | null;
};

/** One numbered item (C1–C17) or rebate line (D1) as it prints. */
export type Tp1PdfItem = {
  code: string;
  description: string;
  limit: number | null;
  current: number | null;
  accumulated: number | null;
  frequency?: string | null;
  subItems: Tp1PdfSubItem[];
  /** C16 — each band carries its own limit and its own Current/Accumulated row. */
  perSubLimit?: boolean;
};

export type Tp1PdfData = {
  /** The agency's own revision string, from the pack (e.g. "PCB FORM /TP1 (1/2026)"). */
  formCode: string;
  deductionMonth: number | null;
  deductionYear: number;
  employer: { name: string; tin: string | null } | null;
  employee: { name: string; idNumber: string | null; tin: string | null };
  items: Tp1PdfItem[];
  rebates: Tp1PdfItem[];
  total: number;
  /** Section E — the acknowledgement text and when it was confirmed (null ⇒ an empty Date box). */
  declaration: { text: string; declaredOn: string | null };
  /** Section F — null on an undecided declaration, which prints the empty boxes the paper form has. */
  consent: {
    status: string;
    approvedMonth: number | null;
    approvedYear: number | null;
    date: string | null;
    name: string | null;
    position: string | null;
  } | null;
  /** The provenance band, in the reader's own language plus English. Supplied, never hardcoded here. */
  provenance: string[];
};

export async function renderTp1Pdf(data: Tp1PdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`TP1 ${data.deductionYear} — ${data.employee.name}`);
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
  /** Section banner — the tinted strip the agency's own form uses to open each section. */
  const banner = (label: string) => {
    need(24);
    page.drawRectangle({ x: M, y: y - 4, width: RIGHT - M, height: 15, color: rgb(0.85, 0.9, 0.95) });
    text(label, M + 4, 9, bold);
    y -= 22;
  };
  /** The money-column headings, drawn at the top of the page and repeated after every page break. */
  const columnHeadings = () => {
    textR('ANNUAL LIMIT (RM)', COL.limitR, 6.5, bold, muted);
    textR('CURRENT (RM)', COL.currentR, 6.5, bold, muted);
    textR('ACCUMULATED (RM)', COL.accR, 6.5, bold, muted);
    y -= 5;
    line(0.9);
    y -= 11;
  };
  /** Open a new page when `h` points would cross the floor, and repeat the column headings there. */
  const need = (h: number, repeatHeadings = false) => {
    if (y - h >= FLOOR) return;
    page = doc.addPage([W, H]);
    y = H - M;
    if (repeatHeadings) columnHeadings();
  };
  /** A money cell: a figure when one was declared, an empty ruled box when nothing was. */
  const cell = (value: number | null, xr: number) => {
    if (value == null) {
      page.drawLine({ start: { x: xr - 66, y: y - 2 }, end: { x: xr, y: y - 2 }, thickness: 0.4, color: hair });
      return;
    }
    textR(money(value), xr, 8);
  };

  // ── Masthead: the agency's own headings and legal references, verbatim ─────────────────────────────
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
  text(`DEDUCTION MONTH:  ${data.deductionMonth ?? '—'}`, M + 60, 8.5, bold);
  text(`DEDUCTION YEAR:  ${data.deductionYear}`, M + 300, 8.5, bold);
  y -= 16;

  // ── Sections A and B ──────────────────────────────────────────────────────────────────────────────
  const kv = (code: string, label: string, value: string | null) => {
    need(14);
    text(code, M + 4, 8, bold);
    text(label, M + 28, 8);
    text(':', M + 230, 8);
    // A BLANK RULE RATHER THAN AN INVENTED VALUE — the same rule lib/borang-a-pdf.ts follows.
    if (value && value.trim() !== '') text(value, M + 240, 8, bold);
    else page.drawLine({ start: { x: M + 240, y: y - 2 }, end: { x: RIGHT - 40, y: y - 2 }, thickness: 0.5, color: hair });
    y -= 13;
  };
  banner('SECTION A: EMPLOYER INFORMATION');
  kv('A1', 'Name', data.employer?.name ?? null);
  kv('A2', 'Tax Identification Number (TIN)', data.employer?.tin ?? null);
  y -= 4;
  banner('SECTION B: EMPLOYEE INFORMATION');
  kv('B1', 'Name', data.employee.name);
  kv('B2', 'Identity Card/Passport Number', data.employee.idNumber);
  kv('B3', 'Tax Identification Number (TIN)', data.employee.tin);
  y -= 4;

  // ── Section C ─────────────────────────────────────────────────────────────────────────────────────
  banner('SECTION C: DEDUCTION INFORMATION');
  columnHeadings();

  const drawItem = (item: Tp1PdfItem) => {
    const descLines = wrapTo(item.description, DESC_W, 8, font);
    need(14 + descLines.length * 10 + item.subItems.length * 22, true);
    text(item.code.toUpperCase(), M, 8.5, bold);
    for (const [i, l] of descLines.entries()) {
      text(l, M + 32, 8);
      // The item's own money row sits on the FIRST description line, so a three-line description does
      // not push its figures away from the code they belong to.
      if (i === 0 && !item.perSubLimit) {
        textR(item.limit == null ? '—' : money(item.limit), COL.limitR, 8);
        cell(item.current, COL.currentR);
        cell(item.accumulated, COL.accR);
      }
      y -= 10;
    }
    if (item.frequency) {
      text(item.frequency, M + 32, 7, font, muted);
      y -= 10;
    }
    for (const sub of item.subItems) {
      const subLines = wrapTo(sub.description, DESC_W - 20, 7.5, font);
      need(subLines.length * 9 + 12, true);
      for (const [i, l] of subLines.entries()) {
        text(i === 0 ? `${sub.code})  ${l}` : `    ${l}`, M + 46, 7.5);
        if (i === 0) {
          // A "(Limited RM…)" sub-line prints its own limit; a plain one leaves the column to the group.
          if (sub.limit != null) textR(money(sub.limit), COL.limitR, 7.5);
          if (item.perSubLimit) {
            cell(sub.current, COL.currentR);
            cell(sub.accumulated, COL.accR);
          } else if (sub.current != null) {
            textR(money(sub.current), COL.currentR, 7.5);
          }
        }
        y -= 9;
      }
      if (sub.frequency) {
        text(sub.frequency, M + 46, 7, font, muted);
        y -= 9;
      }
    }
    y -= 3;
    page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
    y -= 8;
  };

  for (const item of data.items) drawItem(item);

  need(24, true);
  line(0.9);
  y -= 13;
  text('TOTAL DEDUCTION (RM)', M, 9, bold);
  textR(money(data.total), COL.currentR, 9, bold);
  y -= 6;
  line(1.1);
  y -= 16;

  // ── Section D ─────────────────────────────────────────────────────────────────────────────────────
  banner('SECTION D: REBATE');
  for (const item of data.rebates) drawItem(item);

  // ── Section E ─────────────────────────────────────────────────────────────────────────────────────
  banner('SECTION E: EMPLOYEE DECLARATION');
  for (const l of wrapTo(data.declaration.text, RIGHT - M, 7.5, font)) {
    need(12);
    text(l, M, 7.5);
    y -= 10;
  }
  y -= 4;
  need(20);
  text(`Date:  ${data.declaration.declaredOn ?? ''}`, M, 8);
  text('Signature:', M + 300, 8);
  // The signature box is DRAWN EMPTY, always. An electronic acknowledgement is recorded as a date and a
  // named actor in the system; stamping a signature onto a legal declaration would be inventing one.
  page.drawRectangle({ x: M + 360, y: y - 30, width: 160, height: 34, borderColor: rule, borderWidth: 0.7 });
  y -= 42;

  // ── Section F ─────────────────────────────────────────────────────────────────────────────────────
  banner('SECTION F: EMPLOYER CONSENT');
  need(60);
  text(
    `The employee's claim application above is approved for the deduction of  MONTH: ${
      data.consent?.approvedMonth ?? '____'
    }    YEAR: ${data.consent?.approvedYear ?? '______'}`,
    M,
    8,
  );
  y -= 16;
  kv('', 'Date', data.consent?.date ?? null);
  kv('', 'Name', data.consent?.name ?? null);
  kv('', 'Position', data.consent?.position ?? null);

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
