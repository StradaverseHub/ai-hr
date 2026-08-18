/**
 * 9c8dad7a / cc9f9420 — draw a Borang A, A4 portrait, with pdf-lib (pure JS, no WASM/native, so no Next
 * bundler friction). Mirrors lib/ea-pdf.ts, which is the house pattern for a form we draw from scratch.
 *
 * ⚠️ THIS IS NOT KWSP ARTWORK, AND THE PAGE SAYS SO. The reporter's specimen is a FILLED output from
 * another payroll vendor's engine (DevExpress v23.2.5), not an agency page, and KWSP publishes no blank
 * Borang A to print onto — so there is nothing to overlay and every rule, box and heading below is drawn.
 * The catalog entry stays `agency-layout` and may never become `official`: there is nothing official to
 * be faithful to, and claiming otherwise on a statutory document is the one thing this repo has refused
 * twice. test/statutory-forms-page.test.ts pins it.
 *
 * ── WHAT cc9f9420 ADDED, AND WHY THE PAGE GOT TIGHTER ─────────────────────────────────────────────
 * The reporter asked for the page FURNITURE a counter clerk recognises, none of which existed: the
 * KWSP 6 masthead and its Kaedah 11(1) citation, the No. Rujukan Borang A box, the CARA BAYARAN band and
 * its five ticks, the reserved N K column, the Tandatangan / Cop Rasmi Majikan / Cop Agen Kutipan boxes,
 * the eight-point CATATAN block and the PERINGATAN warning. All of that eats vertical space the employee rows used to have —
 * which is why `BORANG_A_ROWS_PER_PAGE` is now MEASURED against `borangASheetRowCapacity()` below rather
 * than chosen, and asserted against it in test/borang-a.test.ts.
 *
 * ── THE N K COLUMN IS PRINTED AND PERMANENTLY EMPTY ───────────────────────────────────────────────
 * Catatan 5 on the form: "Ruang ketiga (N K) hanya diisi oleh KWSP sahaja." It is drawn so the sheet has
 * the agency's column count and column order, and NOTHING is ever written into it. `BorangARow` carries
 * no field for it, the row loop below never addresses `COL.nk`, and the test extracts the drawn text
 * positions out of the rendered PDF and asserts nothing lands in that band. Do not "finish" this column.
 *
 * ── PAGINATION IS THE PART THAT GOES WRONG SILENTLY ───────────────────────────────────────────────
 * The employer header repeats on every sheet. Sheet 2 onward opens with "Jumlah yang dibawa dari
 * mukasurat terdahulu (jika ada)" and every sheet but the last closes with "Jumlah yang dibawa ke
 * mukasurat seterusnya (jika ada)"; the last closes with JUMLAH (RM). Those carry rows print the
 * CONTRIBUTION COLUMNS ONLY — the specimen leaves Upah blank on both — and the arithmetic that makes them
 * add up lives in `paginateBorangA`, where it is asserted at one, two and three pages without a PDF in
 * sight.
 *
 * DRAWN EMPTY, ON PURPOSE: No. Rujukan Borang A, the payment-method ticks and their reference line, the
 * representative's own Tarikh, the signature, Cop Rasmi Majikan and Cop Agen Kutipan. Those are manual
 * and never payroll-derived; the specimen leaves every one of them blank too. Pre-filling a payment
 * method or stamping a signature box would be inventing a fact about a filing.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  BORANG_A_CATATAN,
  BORANG_A_CITATION,
  BORANG_A_PAYMENT_INSTRUCTION,
  BORANG_A_PAYMENT_METHODS,
  BORANG_A_PAYMENT_REF_LABEL,
  BORANG_A_PERINGATAN_EN,
  BORANG_A_PERINGATAN_MS,
  money,
  type BorangAForm,
} from './borang-a';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;
const M = 34;
const RIGHT = W - M;

/**
 * The masthead block's RIGHT-HAND COLUMN — "Borang A", "Mukasurat n/N" and the Cop Agen Kutipan box,
 * stacked in their own bordered column exactly where the specimen puts them. The reporter's point 4 is
 * about this placement: the page number belongs beside the form label, not adrift under the address.
 */
const HDR_RIGHT_X = RIGHT - 118;
/** Everything else in the masthead block lives to the left of that column, with an 8pt gutter. */
const HDR_LEFT_R = HDR_RIGHT_X - 8;

/**
 * Column geometry, measured against the HEADINGS rather than guessed — the r193 lesson: a heading is not
 * clipped, so one wider than its column prints straight into its neighbour. Every gap below is wider than
 * the 7pt bold heading that sits in it. The three money columns are RIGHT-aligned, headings included, so
 * a heading can only ever grow leftwards into its own column's whitespace.
 *
 * `nk` IS NEW AND EVERYTHING FROM `ic` RIGHTWARDS SHIFTED BY 20pt to make room for it. The N K heading is
 * "N K" at 7pt bold = 12.05pt wide in a 20pt column, so it clears "NO. KAD PENGENALAN" by 7.95pt, and
 * NAME sits at M+208 rather than M+202 because at M+202 the 79.94pt "NO. KAD PENGENALAN" heading cleared
 * it by 2.06pt — the r193 failure exactly, and invisible to every check but a measurement. Every
 * clearance here is asserted from the FONT METRICS in test/borang-a.test.ts rather than eyeballed.
 *
 * The three money columns are 68/68/68pt wide rather than the 76/76/80 they were: the N K column took
 * 20pt off NAMA, and taking it back off three columns whose widest figure is ~53pt at 9.5pt bold is what
 * keeps a long legal name from being clipped mid-word. Measured, not trimmed by eye.
 */
const COL = {
  bil: M,
  member: M + 26,
  nk: M + 100,
  ic: M + 120,
  name: M + 208,
  wageR: W - M - 136,
  employerR: W - M - 68,
  employeeR: W - M,
};
const ROW_H = 14;

/**
 * ── THE FOOT FURNITURE, ALL ANCHORED TO THE FOOT OF THE SHEET ─────────────────────────────────────
 * Measured downwards from the bottom edge, because that is what they are anchored to. The table above
 * them must never cross `TABLE_FLOOR`, and `borangASheetRowCapacity()` is the arithmetic that says how
 * many rows fit above it.
 */
/** First baseline of the provenance band. */
const PROV_TOP = M + 36;
/** First baseline of the PERINGATAN pair. */
const WARN_TOP = M + 66;
/** Top baseline of the signature / Cop Rasmi Majikan / CATATAN band. */
const FOOT_BAND_TOP = M + 202;
/** Nothing drawn by the table may go below this. 14pt of air above the foot band. */
const TABLE_FLOOR = FOOT_BAND_TOP + 14;
/** First employee-row baseline, under the two-line column headings and their rule. */
const FIRST_ROW_TOP = 594.89;
/** What the carry-out / JUMLAH block costs below the last row: rule, baseline, closing rule. */
const TOTALS_BLOCK_H = 23;

/**
 * The foot band, TWO columns wide and NON-OVERLAPPING — the representative's rows with their two signing
 * boxes underneath on the left, CATATAN on the right. Named rather than inlined because the first draft's
 * inlined numbers overlapped and nothing but a raster said so.
 *   labels  M .. SIG_VALUE_X            (34 .. 106; the widest, "No. Kad Pengenalan", ends at 97.55)
 *   values  SIG_VALUE_X .. SIG_RIGHT    (106 .. 320)
 *   boxes   M .. SIG_RIGHT, below the rows: TANDATANGAN then COP RASMI MAJIKAN
 *   catatan CATATAN_X .. RIGHT          (328 .. 561.28)
 *
 * ⚠️ THE VALUE COLUMN WAS 98pt WIDE AND THAT WAS A DEFECT, not a measurement. The employer's stamp box
 * used to sit BETWEEN the values and CATATAN, in the same horizontal band, which left the values about
 * twenty characters at 8pt bold: 'NURUL HUDA BINTI ISMAIL' printed as 'NURUL HUDA BINTI ISM', with no
 * ellipsis and no marker, so the page read as if that were the signatory's name. On a signed statutory
 * filing that is worse than the overprint it was introduced to cure — an overprint LOOKS wrong, a
 * truncation looks right. So the stamp box moved DOWN, under the rows and beside the signature box, and
 * the values got the whole left half of the sheet back. Nothing in this band is clipped: see `atFit`.
 */
const CATATAN_X = M + 294;
const SIG_VALUE_X = M + 72;
/** Right edge of the representative's value column: an 8pt gutter short of CATATAN. */
const SIG_RIGHT = CATATAN_X - 8;
const SIG_VALUE_W = SIG_RIGHT - SIG_VALUE_X;
/** The representative's rows: first baseline, and the step down to the next. */
const REP_ROW_TOP = FOOT_BAND_TOP - 13;
const REP_ROW_H = 12;
/**
 * The two signing boxes, side by side UNDER the rows: TANDATANGAN at the margin, COP RASMI MAJIKAN
 * right-aligned to the value column. Their top clears the last row's baseline by 7pt and their bottom
 * clears the PERINGATAN line by 12pt; both gaps are asserted on the drawn page rather than eyeballed.
 */
const SIGN_BOX_W = 136;
const SIGN_BOX_H = 44;
const SIGN_BOX_TOP = FOOT_BAND_TOP - 80;
const COP_BOX_X = SIG_RIGHT - SIGN_BOX_W;

/**
 * The drawn sheet's own vertical budget, PUBLISHED so the row count can be checked against it.
 *
 * `BORANG_A_ROWS_PER_PAGE` lives in lib/borang-a.ts (which is pure and must not import pdf-lib), so the
 * two cannot be one constant. This is the next best thing: the renderer states its capacity, and the test
 * asserts the pure module's number never exceeds it. Overprinting the CATATAN block is invisible to tsc,
 * to the suite, to `next build` and to a 200 — a PDF that overlaps itself is still a valid PDF.
 */
export const BORANG_A_SHEET_GEOMETRY = {
  pageHeight: H,
  rowHeight: ROW_H,
  firstRowTop: FIRST_ROW_TOP,
  /** Sheets 2+ open with the carry-in row, so the WORST-CASE sheet pays for it. */
  carryInHeight: ROW_H,
  totalsBlockHeight: TOTALS_BLOCK_H,
  tableFloor: TABLE_FLOOR,
} as const;

/** How many employee rows fit on the worst-case sheet — one that carries in AND carries out. */
export function borangASheetRowCapacity(g = BORANG_A_SHEET_GEOMETRY): number {
  const usable = g.firstRowTop - g.carryInHeight - g.totalsBlockHeight - g.tableFloor;
  return Math.floor(usable / g.rowHeight);
}

export async function renderBorangAPdf(form: BorangAForm): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Borang A — ${form.employerName} — ${form.contributionMonth}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.6, 0.6, 0.65);
  const hair = rgb(0.82, 0.82, 0.86);

  /**
   * Helvetica is WinAnsi (Latin-1). Typography is FOLDED rather than dropped: an em dash and a curly
   * apostrophe are U+2014 / U+2019, outside Latin-1, and would otherwise print our own footer as
   * "Borang A ? bukan borang rasmi". A NAME still degrades to '?', the same documented limitation
   * lib/ea-pdf.ts carries, with a Unicode font embed as the deferred follow-up. Every string in the
   * CATATAN array is asserted to survive `safe()` unchanged.
   */
  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  /** Greedy wrap. An unwrapped line runs off A4 and no static check can see it. */
  const wrap = (s: string, size: number, maxW: number, f = font) => {
    const out: string[] = [];
    let cur = '';
    for (const w of safe(s).split(/\s+/)) {
      const trial = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && cur) {
        out.push(cur);
        cur = w;
      } else {
        cur = trial;
      }
    }
    if (cur) out.push(cur);
    return out;
  };

  for (const pageData of form.pages) {
    const page = doc.addPage([W, H]);
    const last = pageData.sheet === pageData.of;
    let y = H - M;

    /** Absolute-y helpers, for the boxed blocks that do not flow. */
    const at = (s: string, x: number, yy: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x, y: yy, size, font: f, color });
    const atR = (s: string, xr: number, yy: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y: yy, size, font: f, color });
    const atC = (s: string, cx: number, yy: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: yy, size, font: f, color });
    /**
     * A value that MUST NOT BE CUT: it SHRINKS to fit its column, and is always drawn WHOLE.
     *
     * ⚠️ THIS REPLACED A CLIP, AND THE DIFFERENCE IS THE ENTIRE POINT. Every header and foot-band value
     * on this page used to go through `atClip`, which drops characters off the end until the rest fits —
     * so 'NURUL HUDA BINTI ISMAIL' printed as 'NURUL HUDA BINTI ISM' and 'PERBADANAN PEMBANGUNAN
     * PERTANIAN NEGERI SELANGOR SDN BHD' as 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI S'. There is no
     * ellipsis and no marker, so a truncated legal name reads as the name, which on a filing somebody
     * signs is the worst failure this renderer has: an overprint looks wrong and gets queried, a clean
     * truncation does not. A clip is also exactly how you HIDE an overprint from a collision check, so
     * the overprint guard in the tests cannot see one.
     *
     * The size is floored to 0.1pt so the drawn string is strictly inside `maxW`, and clamped at 1pt so
     * an absurd input can never shrink to nothing — invisible is silent loss too. It shrinks below a
     * comfortable reading size rather than dropping a character: a small name is the person's name, and
     * a cut one is somebody else's.
     */
    const fitSize = (v: string, maxW: number, size: number, f = font) => {
      const w = f.widthOfTextAtSize(v, size);
      if (w <= maxW || w <= 0) return size;
      return Math.max(1, Math.floor((size * maxW * 10) / w) / 10);
    };
    const atFit = (s: string, x: number, yy: number, maxW: number, size: number, f = font, color = ink) => {
      const v = safe(s);
      page.drawText(v, { x, y: yy, size: fitSize(v, maxW, size, f), font: f, color });
    };

    /**
     * Clip to a width. THE TABLE'S NAME COLUMN ONLY, where the column is fixed and shrinking one row's
     * name would leave a ragged column of different type sizes down the page. Nothing else on the sheet
     * may use this — every value a person signs for goes through `atFit`.
     */
    const atClip = (s: string, x: number, yy: number, maxW: number, size: number, f = font, color = ink) => {
      let v = safe(s);
      while (v.length > 1 && f.widthOfTextAtSize(v, size) > maxW) v = v.slice(0, -1);
      page.drawText(v, { x, y: yy, size, font: f, color });
    };

    /** Flowing helpers, for the table, which walks `y` down the page. */
    const text = (s: string, x: number, size: number, f = font, color = ink) => at(s, x, y, size, f, color);
    const textR = (s: string, xr: number, size: number, f = font, color = ink) => atR(s, xr, y, size, f, color);
    const textClip = (s: string, x: number, maxW: number, size: number, f = font, color = ink) =>
      atClip(s, x, y, maxW, size, f, color);
    const line = (yy: number, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x: M, y: yy }, end: { x: RIGHT, y: yy }, thickness, color });
    const box = (x: number, yy: number, w: number, h: number, color = rule) =>
      page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: color, borderWidth: 0.7 });

    // ── Masthead ────────────────────────────────────────────────────────────────────────────────
    // "KWSP 6" and the Kaedah 11(1) citation, which is the reporter's point 1 and the single fastest way
    // for a counter clerk to tell this sheet from the half-dozen other KWSP forms it resembles.
    atC('KUMPULAN WANG SIMPANAN PEKERJA', (M + RIGHT) / 2, y, 12, bold);
    atR('KWSP 6', RIGHT, y, 9.5, bold);
    y -= 13;
    atC(BORANG_A_CITATION, (M + RIGHT) / 2, y, 7.5, font, muted);
    y -= 8;

    // ── The masthead block: header strip, CARA BAYARAN, employer, and the Borang A column ────────
    const HDR_TOP = y;
    const cellW = (HDR_LEFT_R - M) / 4;
    const capRow = HDR_TOP - 20;
    const valRow = capRow - 18;
    const payTop = valRow;
    const payBot = payTop - 52;
    const empTop = payBot;
    const HDR_BOT = empTop - 58;

    // Four boxed slots, not three: "No. Rujukan Borang A" is KWSP's own reference for the filing and is
    // DRAWN EMPTY — payroll cannot know it, and a plausible-looking placeholder is worse than a blank.
    const slots: [string, string][] = [
      ['No. Rujukan Majikan', form.employerRef],
      ['Bulan Caruman', `${form.contributionMonthCode}  (${form.contributionMonth})`],
      ['Amaun Caruman (RM)', money(form.totalContribution)],
      ['No. Rujukan Borang A', ''],
    ];
    for (const [i, [cap, val]] of slots.entries()) {
      const x = M + i * cellW;
      box(x, capRow, cellW, 20);
      box(x, valRow, cellW, 18);
      atC(cap, x + cellW / 2, capRow + 7, 7, bold);
      if (val) atFit(val, x + 4, valRow + 6, cellW - 8, 8.5, bold);
    }

    // CARA BAYARAN — the reporter's point 2. Every box below is EMPTY and stays empty: payroll does not
    // know how a filing was paid. The specimen groups the five methods into two ticks with Draf Bank on
    // the reference line; that grouping is the agency's, not ours.
    box(M, payBot, HDR_LEFT_R - M, payTop - payBot);
    let py = payTop - 10;
    for (const l of wrap(BORANG_A_PAYMENT_INSTRUCTION, 7, HDR_LEFT_R - M - 12)) {
      at(l, M + 6, py, 7);
      py -= 9;
    }
    py -= 4;
    // ONE TICK PER METHOD, stepped by each caption's MEASURED width rather than a fixed stride: at the
    // 150pt stride two ticks could afford, the fifth box would be drawn at x=640 on a 595.28pt sheet —
    // off the right edge, and a box drawn off the page is not a box anybody notices is missing.
    let tx = M + 6;
    for (const opt of BORANG_A_PAYMENT_METHODS) {
      box(tx, py - 1, 8, 8);
      at(opt, tx + 12, py + 0.5, 7.5);
      tx += 12 + font.widthOfTextAtSize(safe(opt), 7.5) + 16;
    }
    py -= 15;
    at(BORANG_A_PAYMENT_REF_LABEL, M + 6, py, 7.5);
    page.drawLine({
      start: { x: M + 6 + font.widthOfTextAtSize(safe(BORANG_A_PAYMENT_REF_LABEL), 7.5) + 6, y: py - 2 },
      end: { x: HDR_LEFT_R - 8, y: py - 2 },
      thickness: 0.5,
      color: hair,
    });

    // Employer identity, with Tarikh DiCetak / Bil Pekerja / Bulan Upah stacked on the right of the same
    // band — where the specimen puts them, and where they no longer cost the table a whole strip slot.
    box(M, HDR_BOT, HDR_LEFT_R - M, empTop - HDR_BOT);
    at('Nama Majikan / Alamat', M + 6, empTop - 9, 6.5, font, muted);
    atFit(form.employerName, M + 6, empTop - 20, 240, 9, bold);
    /**
     * EVERY address line, not the first three. `addressLines` builds up to four — addressLine1..3 and a
     * `postcode city, state` tail — and taking three dropped exactly the tail, which is the line a
     * counter clerk reads and the one the plain-text twin was still printing. The leading is computed
     * from the room actually left inside the box rather than fixed at 9pt, so a fourth line clears the
     * rule instead of straddling it, and a caller that hands over more lines than `addressLines` can
     * build compresses instead of overflowing. Nothing is dropped at any count.
     */
    const addrTop = empTop - 29;
    const addrLead = Math.min(8, (addrTop - (HDR_BOT + 4)) / Math.max(1, form.employerAddress.length - 1));
    for (const [i, l] of form.employerAddress.entries()) {
      atFit(l, M + 6, addrTop - i * addrLead, 240, Math.min(7, addrLead - 0.6), font, muted);
    }
    const infoX = M + 254;
    const infoVX = M + 320;
    for (const [i, [l, v]] of (
      [
        ['Tarikh DiCetak', form.printedOn],
        ['Bil Pekerja', String(form.employees)],
        // Note 6 on the form's own CATATAN is "Bulan caruman bersamaan Bulan Upah + 1". Printing the wage
        // month beside the contribution month is what makes that note checkable at the counter, and it is
        // the single fact most likely to be "corrected" by somebody comparing this with a PERKESO form,
        // whose rule is the opposite.
        ['Bulan Upah', form.payrollPeriodKey],
      ] as [string, string][]
    ).entries()) {
      const yy = empTop - 9 - i * 11;
      at(`${l} :`, infoX, yy, 7, font, muted);
      atFit(v, infoVX, yy, HDR_LEFT_R - 8 - infoVX, 7.5, bold);
    }

    // The Borang A column: form label, page number and the collection agent's stamp box, stacked exactly
    // as the specimen stacks them. Cop Agen Kutipan is DRAWN EMPTY on every sheet — it is the collecting
    // agent's, not ours.
    box(HDR_RIGHT_X, HDR_BOT, RIGHT - HDR_RIGHT_X, HDR_TOP - HDR_BOT);
    const rcx = (HDR_RIGHT_X + RIGHT) / 2;
    atC('Borang A', rcx, HDR_TOP - 34, 17, bold);
    atC(`Mukasurat: ${pageData.sheet}/${pageData.of}`, rcx, HDR_TOP - 62, 8, font, muted);
    atC('Cop Agen Kutipan', rcx, HDR_BOT + 8, 7, font, muted);

    y = HDR_BOT - 4;

    // ── Column headings, two lines, in the specimen's own order ─────────────────────────────────
    // BIL · NO. AHLI · N K · NO. KAD PENGENALAN · NAMA PEKERJA / AHLI · UPAH (RM) · CARUMAN (RM).
    const h1 = y - 11;
    const h2 = y - 21;
    at('BIL', COL.bil, h1, 7, bold, muted);
    at('NO. AHLI', COL.member, h1, 7, bold, muted);
    // The reserved column. Its HEADING is the only thing that ever prints here.
    at('N K', COL.nk, h1, 7, bold, muted);
    at('NO. KAD PENGENALAN', COL.ic, h1, 7, bold, muted);
    at('NAMA PEKERJA / AHLI', COL.name, h1, 7, bold, muted);
    at('(Seperti yang terdapat di dalam Kad Pengenalan)', COL.name, h2, 6, font, muted);
    atR('UPAH (RM)', COL.wageR, h1, 7, bold, muted);
    atC('CARUMAN (RM)', (COL.wageR + COL.employeeR) / 2, h1, 7, bold, muted);
    atR('MAJIKAN', COL.employerR, h2, 7, bold, muted);
    atR('PEKERJA', COL.employeeR, h2, 7, bold, muted);
    y = h2 - 7;
    line(y, 0.9);
    y = FIRST_ROW_TOP;

    // ── Carry-in ────────────────────────────────────────────────────────────────────────────────
    // Contribution columns ONLY. The specimen leaves Upah blank on this row, and the running totals come
    // from `paginateBorangA` rather than being re-added here — one arithmetic, asserted without a PDF.
    // "(jika ada)" is the reporter's point 6 and the specimen's own wording.
    if (pageData.sheet > 1) {
      textR('Jumlah yang dibawa dari mukasurat terdahulu (jika ada)', COL.wageR - 6, 8, bold);
      textR(money(pageData.carryInEmployer), COL.employerR, 8, bold);
      textR(money(pageData.carryInEmployee), COL.employeeR, 8, bold);
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
      y -= ROW_H - 4;
    }

    // ── Rows ────────────────────────────────────────────────────────────────────────────────────
    // Bil runs across the WHOLE form, not per sheet: it is the numbering a KWSP counter reads down.
    //
    // ⚠️ NOTHING IN THIS LOOP MAY ADDRESS `COL.nk`. The N K column is KWSP's (catatan 5) and is printed
    // empty on purpose. `BorangARow` carries no field for it either, and the test reads the drawn text
    // positions back out of the rendered PDF to prove nothing lands in that band.
    let bil = form.pages.slice(0, pageData.sheet - 1).reduce((a, p) => a + p.rows.length, 0);
    for (const r of pageData.rows) {
      bil += 1;
      text(String(bil), COL.bil, 8.5);
      text(r.memberNo, COL.member, 8.5);
      text(r.ic, COL.ic, 8.5);
      // The clip allowance is 56, not the 40 the first draft used: at 40 a 40-character legal name ran
      // right up against the Upah figure with no visible gap ("…MOHAMED ZUL 6,200.00"). Found by
      // rasterising the page and looking at it, which is the only thing that can see it. The allowance
      // survived the N K shift because the NAME column moved with the columns to its left, not into them.
      textClip(r.name, COL.name, COL.wageR - COL.name - 56, 8.5);
      // A row whose EPF wage basis was never recorded cannot reach this renderer — the download gate
      // refuses it — but if it ever did, it must not print a zero that reads as a real wage.
      textR(r.wageRecorded ? money(r.wage) : '(tiada)', COL.wageR, 8.5);
      textR(money(r.employer), COL.employerR, 8.5);
      textR(money(r.employee), COL.employeeR, 8.5);
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
      y -= ROW_H - 4;
    }
    if (pageData.rows.length === 0) {
      text('Tiada pekerja bagi bulan ini / no employees for this month', M, 8.5, font, muted);
      y -= ROW_H;
    }

    // ── Carry-out, or the whole-form JUMLAH on the last sheet ────────────────────────────────────
    y -= 2;
    line(y, 0.9);
    y -= 13;
    if (!last) {
      textR('Jumlah yang dibawa ke mukasurat seterusnya (jika ada)', COL.wageR - 6, 8.5, bold);
      textR(money(pageData.carryOutEmployer), COL.employerR, 8.5, bold);
      textR(money(pageData.carryOutEmployee), COL.employeeR, 8.5, bold);
    } else {
      // JUMLAH ON THE LAST SHEET ONLY: repeating it is how a multi-page form gets filed with the grand
      // total mistaken for a page total.
      // NOT `COL.wageR - 6` like the carry rows above: those leave Upah BLANK, this one prints a figure
      // there. At -6 the label ran straight through "204,600.00" on a two-sheet form — a defect no static
      // check, no type and no 200 can see, and one that only appeared on a raster of sheet 2.
      textR('JUMLAH (RM)', COL.wageR - 80, 9.5, bold);
      textR(money(form.totalWage), COL.wageR, 9.5, bold);
      textR(money(form.totalEmployer), COL.employerR, 9.5, bold);
      textR(money(form.totalEmployee), COL.employeeR, 9.5, bold);
    }
    y -= 8;
    line(y, 1.1);

    // ── The signature band, LAST SHEET ONLY, anchored to the foot ────────────────────────────────
    // A filing is signed once, at the end of the deck — which is also why the space it occupies is
    // RESERVED on every sheet (see TABLE_FLOOR): `paginateBorangA` takes one rows-per-page for the whole
    // form, so a sheet that could hold more would renumber every sheet after it.
    if (last) {
      at('Tandatangan Wakil Majikan', M, FOOT_BAND_TOP, 7.5, bold, muted);
      const rep: [string, string][] = [
        ['Nama', form.repName],
        ['No. Kad Pengenalan', form.repIc],
        ['Jawatan', form.repPosition],
        // The reporter's point 7: this label is "No. Tel / Bimbit" on the agency's form, not "No. Tel".
        ['No. Tel / Bimbit', form.repPhone],
        ['E-mel', form.repEmail],
        // TARIKH IS NEVER THE PRINT DATE. It is the date the representative signed, which has not
        // happened when this file is written. It prints as a rule to write on, always.
        ['Tarikh', ''],
      ];
      for (const [i, [l, v]] of rep.entries()) {
        const yy = REP_ROW_TOP - i * REP_ROW_H;
        at(`${l}`, M, yy, 7, font, muted);
        // A BLANK RULE RATHER THAN AN INVENTED VALUE. Production carries this block for one company in
        // nine; the rest print a rule to write on, which is what the specimen's own blank lines are.
        //
        // ⚠️ `atFit`, NEVER `atClip`. This is the signatory's legal identity on a KWSP filing; it shrinks
        // to fit and is always whole. See the note on `atFit` for what the clip that was here did.
        if (v) {
          atFit(v, SIG_VALUE_X, yy, SIG_VALUE_W, 8, bold);
        } else {
          page.drawLine({
            start: { x: SIG_VALUE_X, y: yy - 2 },
            end: { x: SIG_RIGHT, y: yy - 2 },
            thickness: 0.5,
            color: hair,
          });
        }
      }
      // THE PLACE TO SIGN, and the employer's own stamp box, side by side UNDER the rows. Both drawn
      // empty. The signature box is not decoration: a Borang A is a signed return, and the branch that
      // added the stamp box deleted the box `main` captioned "Tandatangan & Tarikh" without replacing it,
      // which left a form whose plain-text twin advertised a signature line the drawn page did not have.
      //
      // They sit BELOW the rows rather than beside them because beside them is what forced the 98pt value
      // column that truncated the representative's name. Vertical room is what this band is short of, and
      // 44pt of box is enough to sign and stamp in; 98pt of box was not worth the name.
      const signBoxY = SIGN_BOX_TOP - SIGN_BOX_H;
      box(M, signBoxY, SIGN_BOX_W, SIGN_BOX_H);
      atC('Tandatangan', M + SIGN_BOX_W / 2, signBoxY + 6, 7, font, muted);
      box(COP_BOX_X, signBoxY, SIGN_BOX_W, SIGN_BOX_H);
      atC('Cop Rasmi Majikan', COP_BOX_X + SIGN_BOX_W / 2, signBoxY + 6, 7, font, muted);
    }

    // ── CATATAN, on EVERY sheet ─────────────────────────────────────────────────────────────────
    // Form furniture, not a signature: each printed sheet of a Borang A carries the notes, and reserving
    // the space on every sheet without drawing them would leave a hole. The wording is ONE array in
    // lib/borang-a.ts so a supplied KWSP 6 page can be dropped in without touching this renderer.
    const catX = CATATAN_X;
    const catW = RIGHT - catX;
    at('CATATAN', catX, FOOT_BAND_TOP, 7.5, bold, muted);
    let cy = FOOT_BAND_TOP - 12;
    for (const [i, note] of BORANG_A_CATATAN.entries()) {
      const lines = wrap(note, 6.8, catW - 12);
      at(`${i + 1}.`, catX, cy, 6.8, font, muted);
      for (const l of lines) {
        at(l, catX + 11, cy, 6.8, font, muted);
        cy -= 9;
      }
    }

    // ── PERINGATAN ──────────────────────────────────────────────────────────────────────────────
    // The reporter's point 9. Malay is the specimen's sentence; the English line under it is OURS and
    // says so, because an unattributed translation of a statutory warning borrows the agency's authority.
    let wy = WARN_TOP;
    for (const [i, s] of [BORANG_A_PERINGATAN_MS, BORANG_A_PERINGATAN_EN].entries()) {
      for (const l of wrap(s, 7, RIGHT - M, i === 0 ? bold : font)) {
        at(l, M, wy, 7, i === 0 ? bold : font, i === 0 ? ink : muted);
        wy -= 9;
      }
    }

    // ── Provenance band ─────────────────────────────────────────────────────────────────────────
    // WRAPPED, not one long line: the English sentence is wider than A4 and an unwrapped one runs off
    // the right edge, which no static check can see.
    let by = PROV_TOP;
    line(by + 10, 0.7, hair);
    const band = [
      'Susun atur kami sendiri, dilukis mengikut Borang A — bukan borang rasmi KWSP.',
      'Our own layout, drawn to match Borang A. KWSP publishes no blank form to print onto, so this is not ' +
        'the agency’s own page. The CATATAN notes and the PERINGATAN sentence are TRANSCRIBED from a filled ' +
        'Borang A produced by another payroll system, not taken from a KWSP page, and the English line under ' +
        'PERINGATAN is our own translation. Upah is the wage EPF was charged on and the contributions are ' +
        'taken from the payroll run, never recalculated.',
      `Bulan caruman ${form.contributionMonth} · bulan upah ${form.payrollPeriodKey}`,
    ];
    for (const paragraph of band) {
      for (const l of wrap(paragraph, 6.4, RIGHT - M)) {
        at(l, M, by, 6.4, font, muted);
        by -= 8.5;
      }
    }
  }

  return doc.save();
}
