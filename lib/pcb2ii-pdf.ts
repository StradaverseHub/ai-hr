/**
 * 72b100cd — PCB 2(II) Pin. 2012, rendered in the official arrangement.
 *
 * READ THIS BESIDE THE SPECIMENS attached to the ticket (PCB2II_Pin2012_2, English and BM versions). Every
 * caption comes from `pcb2iiLabels`, transcribed from those two files; every figure comes from
 * `Pcb2iiForm`, which is built by the read and never by this file. This module lays out and prints. It
 * does not total (that is `pcb2iiTotals`), does not date (that is `pcb2iiDate`), and does not translate —
 * a renderer that computes is a second source of truth for a tax figure.
 *
 * ⚠️ `fidelity: 'agency-layout'`, NEVER 'official'. This is our typesetting of LHDN's form, not a
 * pixel-facsimile of their PDF, and the registry entry says so — the same honest label Borang A, Borang 8A
 * and the EA carry. CP22 is the only 'official' row in the catalogue and a test pins that.
 *
 * ⚠️ AN EMPTY BOX IS PRINTED EMPTY. `pcb2iiAmount(null)` is '', not '0.00'. On this form a blank cell
 * asserts nothing and a zero asserts that no tax was deducted — different statements to LHDN, and the one
 * place this renderer could quietly manufacture a claim. Every amount goes through that helper for
 * exactly that reason; none is formatted inline.
 *
 * ⚠️ SECTION 3 PRINTS ITS THREE EMPTY RULED ROWS, as the published form ships them. It is not omitted and
 * it is not filled in: this repo cannot attribute a share of a month's PCB to one prior-year arrears line
 * without inventing an apportionment. See lib/pcb2ii-form.ts.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { pcb2iiAmount, pcb2iiDate, pcb2iiTotals, type Pcb2iiForm } from './pcb2ii-form';
import { pcb2iiLabels, type Pcb2iiLang } from './pcb2ii-labels';

/** A4 portrait, the size the specimen is published at. */
const W = 595.28;
const H = 841.89;
const M = 54;
const RIGHT = W - M;

/**
 * THE SEVEN COLUMNS OF SECTION 2, in the specimen's order and summing to the printable width.
 *
 * Three header groups — Amount, Receipt No., Receipt Date — each split into MTD/PCB and CP38, plus the
 * month column. Widths are declared once and the x positions DERIVED from them (the f728826a lesson from
 * r322: an offset typed beside a width is an assumption that drifts). Receipt references are the widest
 * boxes because an LHDN reference is the longest thing printed on this sheet.
 */
/**
 * ⚠️ THE RECEIPT COLUMNS ARE THE WIDEST ON PURPOSE. An LHDN receipt/transaction reference is the longest
 * value printed on this sheet and it is the identifier LHDN matches the payment by — clipping it to
 * "LHDN-202601-009..." would print an unusable reference on a tax form, which is worse than printing
 * none. Month and the two date columns give up the points: a month name and `dd/mm/yyyy` are both short
 * and fixed. `clip()` remains the last resort for a reference longer than any real one.
 */
const COLS = [54, 58, 58, 88, 88, 69, 68] as const;
const XS: number[] = COLS.reduce<number[]>((acc, w, i) => {
  acc.push(i === 0 ? M : acc[i - 1] + COLS[i - 1]);
  return acc;
}, []);
const TABLE_RIGHT = XS[6] + COLS[6];

export async function renderPcb2iiPdf(form: Pcb2iiForm, lang: Pcb2iiLang): Promise<Uint8Array> {
  const L = pcb2iiLabels(lang);
  const doc = await PDFDocument.create();
  doc.setTitle(`PCB 2(II) - ${form.employeeName} - ${form.year}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.09, 0.11);
  const rule = rgb(0.35, 0.35, 0.4);

  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  const page = doc.addPage([W, H]);
  /** Points from the TOP edge → pdf-lib's y. The specimen is described from the top; so is this. */
  const at = (t: number) => H - t;

  const put = (s: string, x: number, t: number, size = 8.5, f: PDFFont = font) =>
    page.drawText(safe(s), { x, y: at(t), size, font: f, color: ink });
  const putR = (s: string, xr: number, t: number, size = 8.5, f: PDFFont = font) =>
    page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y: at(t), size, font: f, color: ink });
  const putC = (s: string, cx: number, t: number, size = 8.5, f: PDFFont = font) =>
    page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: at(t), size, font: f, color: ink });
  const hRule = (x0: number, x1: number, t: number, thickness = 0.7) =>
    page.drawLine({ start: { x: x0, y: at(t) }, end: { x: x1, y: at(t) }, thickness, color: rule });
  const vRule = (x: number, t0: number, t1: number, thickness = 0.7) =>
    page.drawLine({ start: { x, y: at(t0) }, end: { x, y: at(t1) }, thickness, color: rule });
  /** The ruled line a specimen writes a value on. */
  const valueRule = (x0: number, x1: number, t: number) => hRule(x0, x1, t, 0.7);

  // ── Heading ──────────────────────────────────────────────────────────────────────────────────────
  put(L.title, M, 62, 9.5, bold);
  putR(L.formCode, RIGHT, 62, 9.5);

  put(`${L.dateLabel}`, RIGHT - 120, 84);
  put(pcb2iiDate(form.printedOnIso), RIGHT - 70, 84);
  valueRule(RIGHT - 72, RIGHT, 86);

  put(L.toLabel, M, 84);
  put(L.toLine1, M, 98);
  put(L.toLine2, M, 112);
  put(L.branch, M, 126);
  put(form.branch, M + 96, 126);
  valueRule(M + 94, M + 290, 128);

  put(L.salutation, M, 150);

  // ── The employee particulars block ───────────────────────────────────────────────────────────────
  const VX = M + 276; // where the ruled value lines begin
  const rows: [string, string][] = [
    [L.yearLabel, String(form.year)],
    [L.employeeName, form.employeeName],
    [L.icOrPassport, form.newIcOrPassport],
    [L.employeeTaxNo, form.employeeTaxNo],
    [L.staffNo, form.staffNo],
    [L.employerNo, form.employerNo],
  ];
  let t = 176;
  rows.forEach(([label, value], i) => {
    put(label, M, t);
    put(value, VX + 4, t);
    // The YEAR box on the specimen is short; every other value line runs to the right margin.
    valueRule(VX, i === 0 ? VX + 104 : RIGHT - 30, t + 2);
    t += 15;
  });

  put(L.referred, M, t + 12);

  // ── Section 2 — twelve months, two streams ───────────────────────────────────────────────────────
  let y = t + 40;
  const s2 = wrap(L.section2, 8.5, RIGHT - M);
  s2.forEach((line) => {
    put(line, M, y);
    y += 12;
  });

  const HEAD1 = y + 6;   // top of the grouped header
  const HEAD2 = HEAD1 + 22; // the MTD/CP38 split line
  const BODY = HEAD2 + 16;  // first data row's top edge
  const ROW = 15.5;

  // Grouped header captions. `colMonth` is "Year" on the English specimen and "Bulan" on the BM one —
  // transcribed as published rather than corrected, because this prints what the form says.
  putC(L.colMonth, XS[0] + COLS[0] / 2, HEAD1 + 14);
  // Centred over BOTH Amount sub-columns, derived from their widths rather than typed.
  putC(L.colAmount, XS[1] + (COLS[1] + COLS[2]) / 2, HEAD1 + 14);
  wrapCentred(L.colReceiptNo, XS[3], COLS[3] + COLS[4], HEAD1 + 8);
  wrapCentred(L.colReceiptDate, XS[5], COLS[5] + COLS[6], HEAD1 + 8);

  // The MTD/CP38 split, under each of the three grouped headings.
  for (const [a, b] of [[1, 2], [3, 4], [5, 6]] as const) {
    putC(L.streamMtd, XS[a] + COLS[a] / 2, HEAD2 + 12);
    putC(L.streamCp38, XS[b] + COLS[b] / 2, HEAD2 + 12);
  }

  const totals = pcb2iiTotals(form.months);
  const lastRowTop = BODY + 12 * ROW;

  // The twelve month rows, then the Total row.
  form.months.forEach((m, i) => {
    const top = BODY + i * ROW;
    put(L.months[i], XS[0] + 3, top + 11);
    putR(pcb2iiAmount(m.mtd), XS[1] + COLS[1] - 3, top + 11);
    putR(pcb2iiAmount(m.cp38), XS[2] + COLS[2] - 3, top + 11);
    put(clip(m.mtdReceiptRef ?? '', COLS[3] - 6, 7), XS[3] + 3, top + 11, 7);
    put(clip(m.cp38ReceiptRef ?? '', COLS[4] - 6, 7), XS[4] + 3, top + 11, 7);
    put(pcb2iiDate(m.mtdPaidOn), XS[5] + 3, top + 11, 7.5);
    put(pcb2iiDate(m.cp38PaidOn), XS[6] + 3, top + 11, 7.5);
    hRule(M, TABLE_RIGHT, top);
  });

  // Total — boxed under the two Amount columns only, exactly as the specimen rules it.
  put(L.total, XS[0] + 3, lastRowTop + 11, 8.5, bold);
  putR(pcb2iiAmount(totals.mtd), XS[1] + COLS[1] - 3, lastRowTop + 11, 8.5, bold);
  putR(pcb2iiAmount(totals.cp38), XS[2] + COLS[2] - 3, lastRowTop + 11, 8.5, bold);
  hRule(M, TABLE_RIGHT, lastRowTop);
  hRule(M, XS[3], lastRowTop + ROW, 1);
  hRule(XS[3], TABLE_RIGHT, lastRowTop);

  // The grid: the outer frame, the two header rules, and every vertical.
  hRule(M, TABLE_RIGHT, HEAD1);
  hRule(XS[1], TABLE_RIGHT, HEAD2);
  vRule(M, HEAD1, lastRowTop + ROW);
  /**
   * ⚠️ THE GROUP BOUNDARIES RUN FULL HEIGHT; THE SUB-COLUMN SPLITS START BELOW THE GROUPED HEADING.
   *
   * XS[1], XS[3] and XS[5] open the three groups (Amount · Receipt No. · Receipt Date), so they rule from
   * the top of the header. XS[2], XS[4] and XS[6] only split a group into MTD/CP38, so they must begin at
   * HEAD2 — running them to HEAD1 draws a line straight through the group's own caption, which is exactly
   * what the first render did: "Receipt Date/Tr|ansaction Date" with a rule through the middle of it.
   */
  for (const i of [1, 3, 5]) vRule(XS[i], HEAD1, i === 1 ? lastRowTop + ROW : lastRowTop);
  for (const i of [2, 4, 6]) vRule(XS[i], HEAD2, i === 2 ? lastRowTop + ROW : lastRowTop);
  vRule(TABLE_RIGHT, HEAD2, lastRowTop);

  // ── Section 3 — the preceding year, printed blank ────────────────────────────────────────────────
  let y3 = lastRowTop + ROW + 26;
  wrap(L.section3, 8.5, RIGHT - M).forEach((line) => {
    put(line, M, y3);
    y3 += 12;
  });

  const C3 = [92, 80, 80, 84, 84, 63] as const;
  const X3: number[] = C3.reduce<number[]>((acc, w, i) => {
    acc.push(i === 0 ? M : acc[i - 1] + C3[i - 1]);
    return acc;
  }, []);
  const R3 = X3[5] + C3[5];
  const H3 = y3 + 6;
  const B3 = H3 + 30;
  const heads3 = [L.colIncomeType, L.colMonth3, L.colYear3, L.colMtdAmount, L.colReceiptNo3, L.colReceiptDate3];
  heads3.forEach((h, i) => wrapCentred(h, X3[i], C3[i], H3 + 8, 7.5));
  hRule(M, R3, H3);
  hRule(M, R3, B3);
  // THREE EMPTY ROWS. Ruled and unfilled — see the header on why this is a refusal, not a gap.
  for (let i = 0; i <= 3; i += 1) hRule(M, R3, B3 + i * ROW);
  for (let i = 0; i < 6; i += 1) vRule(X3[i], H3, B3 + 3 * ROW);
  vRule(R3, H3, B3 + 3 * ROW);

  // ── The employer's sign-off ──────────────────────────────────────────────────────────────────────
  let yf = B3 + 3 * ROW + 28;
  put(L.thanks, M, yf);
  yf += 26;
  const sign: [string, string][] = [
    [L.officerName, form.officerName],
    [L.designation, form.officerDesignation],
    [L.phone, form.officerPhone],
    [L.employerNameAddress, form.employerNameAddress],
  ];
  for (const [label, value] of sign.slice(0, 3)) {
    put(label, M, yf);
    put(clip(value, RIGHT - 30 - (VX + 4)), VX + 4, yf);
    valueRule(VX, RIGHT - 30, yf + 2);
    yf += 16;
  }
  /**
   * THE EMPLOYER'S NAME AND ADDRESS WRAPS ACROSS THE FORM'S OWN CONTINUATION RULES rather than being
   * clipped to the first one. The specimen prints four ruled lines here for exactly this reason — an
   * address is the one value on the sheet that does not fit on a line — and truncating a legal entity's
   * address with an ellipsis on a tax form is a worse answer than using the space the form provides.
   * Four rules are always drawn, filled or not, because that is how the form is published.
   */
  const ADDR_LINES = 4;
  put(L.employerNameAddress, M, yf);
  const addr = wrap(form.employerNameAddress, 8.5, RIGHT - 30 - (VX + 4));
  for (let i = 0; i < ADDR_LINES; i += 1) {
    if (addr[i]) put(addr[i], VX + 4, yf);
    valueRule(VX, RIGHT - 30, yf + 2);
    yf += 16;
  }

  return doc.save();

  /** Wrap to a width. An unwrapped official sentence runs off the sheet and no font-metric check sees it. */
  function wrap(s: string, size: number, maxW: number, f: PDFFont = font): string[] {
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
    return out;
  }

  /** A grouped heading, wrapped and centred inside its own span. */
  function wrapCentred(s: string, x0: number, width: number, top: number, size = 7.5) {
    const lines = wrap(s, size, width - 6);
    lines.forEach((line, i) => putC(line, x0 + width / 2, top + i * 9, size));
  }

  /** Trim a value to its box rather than letting it run into the next column. */
  function clip(s: string, maxW: number, size = 7.5, f: PDFFont = font): string {
    let out = safe(s);
    if (f.widthOfTextAtSize(out, size) <= maxW) return out;
    while (out.length > 1 && f.widthOfTextAtSize(`${out}...`, size) > maxW) out = out.slice(0, -1);
    return `${out}...`;
  }
}
