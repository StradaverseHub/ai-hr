/**
 * 9c8dad7a / cc9f9420 — draw a Borang A, A4 portrait, with pdf-lib (pure JS, no WASM/native, so no Next
 * bundler friction). Mirrors lib/ea-pdf.ts, which is the house pattern for a form we draw from scratch.
 *
 * ⚠️ THIS IS NOT KWSP ARTWORK, AND THE PAGE SAYS SO. The reporter's specimens are FILLED outputs from
 * other payroll vendors' engines (DevExpress v23.2.5 in August, another HRMS in October), not agency pages,
 * and we hold no KWSP blank to print onto — so there is nothing to overlay and every rule, box and heading
 * below is drawn. (r411: this used to add that KWSP publishes no blank Borang A. Nobody here checked that,
 * so it is no longer claimed — on the page, in the text twin or here.)
 * The catalog entry stays `agency-layout` and may never become `official`: there is nothing official to
 * be faithful to, and claiming otherwise on a statutory document is the one thing this repo has refused
 * twice. test/statutory-forms-page.test.ts pins it.
 *
 * ── WHAT cc9f9420 ADDED, AND WHY THE PAGE GOT TIGHTER ─────────────────────────────────────────────
 * The reporter asked for the page FURNITURE a counter clerk recognises, none of which existed: the
 * KWSP 6 masthead and its Kaedah 11(1) citation, the No. Rujukan Borang A box, the CARA BAYARAN band, the
 * reserved N K column, the signature / Cop Rasmi Majikan / Cop Agen Kutipan boxes, the eight-point CATATAN
 * block and the PERINGATAN warning. All of that eats vertical space the employee rows used to have —
 * which is why `BORANG_A_ROWS_PER_PAGE` is now MEASURED against `borangASheetRowCapacity()` below rather
 * than chosen, and asserted against it in test/borang-a.test.ts.
 *
 * ── r407 (item 4f45f9b0): REDRAWN BOX FOR BOX FROM THE KWSP 6 SPECIMEN ─────────────────────────────
 * The reporter asked for the "layout, structure, fields, table arrangement, borders, alignment and overall
 * presentation" to follow the sample. Every position below is a PROPORTION of the specimen's own page
 * (rasterised from attachment 8e028654 "EPF Borang A.pdf", the August KWSP 6 on items 9c8dad7a/cc9f9420),
 * re-based onto our margins, and the layout is the specimen's:
 *   • ONE OUTER FRAME around the masthead block, with the employer labels ("Nama Majikan", "Alamat") in
 *     its LEFT MARGIN, the four-box header strip, the payment band and the employer band in the middle,
 *     and the Borang A / Mukasurat / Cop Agen Kutipan column on the right;
 *   • TWO payment ticks (Wang Tunai; Cek / Kiriman Wang / Wang Pos / Draf Bank) with the instrument's
 *     number line under the second, as the specimen prints them;
 *   • a RULED member table — every column and row has its lines — with the two-level CARUMAN heading;
 *   • the brought-forward row (r411: from sheet 2 onwards ONLY, and NO carried-forward row on any sheet —
 *     see the r411 block below);
 *   • the foot in the specimen's three columns: the representative's block with the place to sign beside
 *     "Tandatangan Wakil Majikan", the Cop Rasmi Majikan box, and CATATAN; PERINGATAN under all three.
 * The "Bulan Upah" line beside Tarikh DiCetak is GONE (the specimen has none); the payroll month stays in
 * the provenance line at the foot, so note 6's "+1" is still checkable on the page.
 *
 * ── THE N K COLUMN IS PRINTED AND PERMANENTLY EMPTY ───────────────────────────────────────────────
 * Catatan 5 on the form: "Ruang ketiga (N K) hanya diisi oleh KWSP sahaja." It is drawn so the sheet has
 * the agency's column count and column order, and NOTHING is ever written into it. `BorangARow` carries
 * no field for it, the row loop below never addresses `COL.nk`, and the test extracts the drawn text
 * positions out of the rendered PDF and asserts nothing lands in that band. Do not "finish" this column.
 *
 * ── r411 (item 4f45f9b0, the October sample): THE CARRY ROWS AND JUMLAH, AS THE SAMPLE PRINTS THEM ──
 * The reporter's October KWSP 6 (pages 1 and 35 of 35) settles three things the August specimen could
 * not, because it was one page long:
 *   • "Jumlah yang dibawa dari mukasurat terdahulu (jika ada)" opens sheet 2 ONWARDS. Sheet 1 has no
 *     brought-forward row at all — r407 drew an empty one there.
 *   • There is NO carried-forward row on any sheet: page 1 ends at member row 20 and page 35 opens with
 *     the brought-forward row. r407 drew "…dibawa ke mukasurat seterusnya" on every sheet.
 *   • JUMLAH (RM) on the last sheet is ONE figure — employer + employee, the same money as the header's
 *     Amaun Caruman — written across both CARUMAN cells, with the label in the UPAH cell. There is no wage
 *     total on the form. r407 printed three figures (Upah, Majikan, Pekerja).
 * The brought-forward row prints the CONTRIBUTION COLUMNS ONLY (the sample leaves Upah blank) and its
 * arithmetic lives in `paginateBorangA`, asserted at one, two and three pages without a PDF in sight.
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
/** Side, top and bottom margin. The specimen runs to ~13pt; 28pt keeps every rule inside a printer's reach. */
const M = 28;
const RIGHT = W - M;
const CW = RIGHT - M;

/**
 * ── THE MASTHEAD BLOCK, ONE OUTER FRAME ─────────────────────────────────────────────────────────────
 * Horizontal proportions of the specimen's frame (869px wide at 110 dpi): the left margin column holding
 * "Nama Majikan" / "Alamat" is 12.1% of it, the middle (strip, payment band, employer band) runs to 83.4%,
 * and the Borang A column takes the rest.
 */
const LX = M + 66;
const RX = RIGHT - 90;
const FRAME_TOP = H - M;
const STRIP_TOP = FRAME_TOP - 38;
const CAP_H = 22;
const VAL_H = 20;
const PAY_TOP = STRIP_TOP - CAP_H - VAL_H;
const PAY_H = 50;
const EMP_TOP = PAY_TOP - PAY_H;
const EMP_H = 56;
/** The frame's bottom edge — also where the employer band ends. */
const FRAME_BOT = EMP_TOP - EMP_H;
/** The four strip cells, as fractions of LX..RX — the specimen's 190 / 122 / 163 / 145 px. */
const STRIP_FRACTIONS = [0.306, 0.197, 0.263, 0.234] as const;

/**
 * ── THE MEMBER TABLE, RULED ─────────────────────────────────────────────────────────────────────────
 * Column edges, left to right, measured against the HEADINGS (the r193 lesson: a heading is not clipped,
 * so one wider than its column prints into its neighbour) and asserted from the font metrics in
 * test/borang-a.test.ts. The specimen's own order: BIL · NO. AHLI · N K · NO. KAD PENGENALAN · NAMA ·
 * UPAH · CARUMAN (MAJIKAN, PEKERJA). The three money columns are a little wider than the specimen's so a
 * six-figure JUMLAH fits at reading size; NAMA gives up the difference and shrinks a long name to fit.
 */
const COL = {
  bil: M,
  member: M + 22,
  nk: M + 96,
  ic: M + 114,
  name: M + 198,
  wage: RIGHT - 164,
  employer: RIGHT - 110,
  employee: RIGHT - 55,
  end: RIGHT,
};
const TABLE_TOP = FRAME_BOT - 8;
const HEAD_ROW = 14;
/** Bottom of the two-level heading — the top edge of the brought-forward row. */
const HEAD_BOT = TABLE_TOP - 2 * HEAD_ROW;
const ROW_H = 14;
/** Text baseline inside a row band whose TOP edge is `top`. */
const base = (top: number) => top - 10;

/**
 * ── THE FOOT, ANCHORED TO THE BOTTOM EDGE ─────────────────────────────────────────────────────────────
 * Provenance band, then PERINGATAN, then the three-column band (representative · Cop Rasmi Majikan ·
 * CATATAN). Measured upwards from the bottom margin because that is what they are anchored to.
 */
const PROV_TOP = M + 50;
const WARN_TOP = PROV_TOP + 30;
const FOOT_BOT = WARN_TOP + 12;
const REP_ROW = 14;
/** Baseline of the LAST representative row (Tarikh); the five above it step up by REP_ROW. */
const REP_LAST = FOOT_BOT + 4;
const REP_ROWS = 6;
/** The place to sign: beside the "Tandatangan Wakil Majikan" label, above the Nama row. */
const SIGN_BOT = REP_LAST + (REP_ROWS - 1) * REP_ROW + 10;
const SIGN_H = 28;
const FOOT_TOP = SIGN_BOT + SIGN_H + 4;
/** Nothing drawn by the table may go below this. */
const TABLE_FLOOR = FOOT_TOP + 6;
/**
 * Foot columns, the specimen's proportions: values end at 34% of the frame, Cop Rasmi Majikan 35.7%–60.4%,
 * CATATAN from 61.6%. The label column matches the masthead's left margin so the two line up.
 *
 * ⚠️ The value column is where a signatory's legal name prints. It SHRINKS to fit (`atFit`) and is never
 * cut: a truncated name reads as the name, which on a signed return is worse than an overprint.
 */
const SIG_VALUE_X = LX;
const SIG_RIGHT = M + 188;
const SIG_VALUE_W = SIG_RIGHT - SIG_VALUE_X;
const COP_X = SIG_RIGHT + 8;
const COP_R = M + 324;
const CATATAN_X = COP_R + 8;

/**
 * The drawn sheet's own vertical budget, PUBLISHED so the row count can be checked against it.
 *
 * `BORANG_A_ROWS_PER_PAGE` lives in lib/borang-a.ts (which is pure and must not import pdf-lib), so the
 * two cannot be one constant. This is the next best thing: the renderer states its capacity, and the test
 * asserts the pure module's number never exceeds it. Overprinting the CATATAN block is invisible to tsc,
 * to the suite, to `next build` and to a 200 — a PDF that overlaps itself is still a valid PDF.
 *
 * r407 — `firstRowTop` is the top EDGE of the row band (the brought-forward row's top). `columns` and
 * `frameBottom` are published so the tests read the renderer's geometry instead of restating it.
 *
 * r411 — the carry-in row is drawn from sheet 2 only, but its height is STILL RESERVED on every sheet:
 * `paginateBorangA` takes one rows-per-page for the whole form, and a sheet 1 that held one row more would
 * renumber every sheet after it. The totals block is the JUMLAH row alone now (no carried-forward row).
 */
export const BORANG_A_SHEET_GEOMETRY = {
  pageHeight: H,
  rowHeight: ROW_H,
  firstRowTop: HEAD_BOT,
  carryInHeight: ROW_H,
  /** The JUMLAH row. r411: there is no carried-forward row any more. */
  totalsBlockHeight: ROW_H,
  tableFloor: TABLE_FLOOR,
  tableTop: TABLE_TOP,
  frameBottom: FRAME_BOT,
  columns: COL,
  sigValueX: SIG_VALUE_X,
  sigRight: SIG_RIGHT,
  catatanX: CATATAN_X,
  paymentRight: RX,
} as const;

/** How many employee rows fit on a sheet: under the heading and the brought-forward row, above the foot. */
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
  const rule = rgb(0.25, 0.25, 0.28);
  const hair = rgb(0.6, 0.6, 0.65);

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

    const at = (s: string, x: number, yy: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x, y: yy, size, font: f, color });
    const atR = (s: string, xr: number, yy: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y: yy, size, font: f, color });
    const atC = (s: string, cx: number, yy: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: yy, size, font: f, color });
    /**
     * A value that MUST NOT BE CUT: it SHRINKS to fit its column, and is always drawn WHOLE.
     *
     * ⚠️ THIS REPLACED A CLIP, AND THE DIFFERENCE IS THE ENTIRE POINT. A clip drops characters off the end
     * until the rest fits — 'NURUL HUDA BINTI ISMAIL' printed as 'NURUL HUDA BINTI ISM' — and there is no
     * ellipsis and no marker, so a truncated legal name reads as the name. A clip is also exactly how you
     * HIDE an overprint from a collision check. The size is floored to 0.1pt so the drawn string is
     * strictly inside `maxW`, and clamped at 1pt so an absurd input can never shrink to nothing.
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
    /** Right-aligned, shrink-to-fit — a money cell. */
    const atFitR = (s: string, xr: number, yy: number, maxW: number, size: number, f = font, color = ink) => {
      const v = safe(s);
      const sz = fitSize(v, maxW, size, f);
      page.drawText(v, { x: xr - f.widthOfTextAtSize(v, sz), y: yy, size: sz, font: f, color });
    };
    /** The table's name cell — shrink to fit, never cut. Named so the guard can find it. */
    const textFit = (name: string, y: number) => atFit(name, COL.name + 3, y, COL.wage - COL.name - 6, 8.5);
    const hline = (x1: number, x2: number, yy: number, thickness = 0.6, color = rule) =>
      page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });
    const vline = (x: number, y1: number, y2: number, thickness = 0.6, color = rule) =>
      page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness, color });
    const box = (x: number, yy: number, w: number, h: number, color = rule, borderWidth = 0.7) =>
      page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: color, borderWidth });

    // ── The outer frame ─────────────────────────────────────────────────────────────────────────────
    box(M, FRAME_BOT, CW, FRAME_TOP - FRAME_BOT, rule, 0.9);

    // ── Masthead: the agency's name and Kaedah 11(1), centred over the middle column; KWSP 6 top right ─
    const midX = (LX + RX) / 2;
    atC('KUMPULAN WANG SIMPANAN PEKERJA', midX, FRAME_TOP - 17, 13, bold);
    atC(BORANG_A_CITATION, midX, FRAME_TOP - 30, 7.5);
    atC('KWSP 6', (RX + RIGHT) / 2, FRAME_TOP - 15, 9.5);

    // ── The four-box strip ──────────────────────────────────────────────────────────────────────────
    // No. Rujukan Borang A is KWSP's own reference for the filing and is DRAWN EMPTY — payroll cannot know
    // it, and a plausible-looking placeholder is worse than a blank. The specimen's Bulan Caruman box holds
    // MMYY and nothing else ("0826"), so that is what prints.
    const slots: { cap: string[]; val: string; align: 'l' | 'c' | 'r' }[] = [
      { cap: ['No. Rujukan Majikan'], val: form.employerRef, align: 'l' },
      { cap: ['Bulan', 'Caruman'], val: form.contributionMonthCode, align: 'c' },
      { cap: ['Amaun Caruman', '(RM)'], val: money(form.totalContribution), align: 'r' },
      { cap: ['No. Rujukan', 'Borang A'], val: '', align: 'l' },
    ];
    let cx = LX;
    for (const [i, slot] of slots.entries()) {
      const w = (RX - LX) * STRIP_FRACTIONS[i];
      box(cx, STRIP_TOP - CAP_H, w, CAP_H);
      box(cx, PAY_TOP, w, VAL_H);
      const capBase = slot.cap.length === 1 ? STRIP_TOP - 14 : STRIP_TOP - 9.5;
      for (const [k, l] of slot.cap.entries()) atC(l, cx + w / 2, capBase - k * 8.5, 7, bold);
      if (slot.val) {
        const vy = PAY_TOP + 6.5;
        if (slot.align === 'l') atFit(slot.val, cx + 4, vy, w - 8, 9, bold);
        else if (slot.align === 'r') atFitR(slot.val, cx + w - 4, vy, w - 8, 9, bold);
        else atC(slot.val, cx + w / 2, vy, 9, bold);
      }
      cx += w;
    }

    // ── CARA BAYARAN: the instruction, TWO ticks, and the instrument's number line ─────────────────
    // Every box here is EMPTY and stays empty: payroll does not know how a filing was paid.
    box(LX, EMP_TOP, RX - LX, PAY_H);
    let py = PAY_TOP - 9;
    for (const l of wrap(BORANG_A_PAYMENT_INSTRUCTION, 7, RX - LX - 12)) {
      at(l, LX + 6, py, 7);
      py -= 8.5;
    }
    const tickY = EMP_TOP + 16;
    const tick2X = LX + 6 + 84;
    for (const [i, opt] of BORANG_A_PAYMENT_METHODS.entries()) {
      const tx = i === 0 ? LX + 6 : tick2X;
      box(tx, tickY - 1, 8, 8);
      at(opt, tx + 12, tickY + 0.5, 7.5);
    }
    // The specimen prints the instrument's number on the line UNDER the second tick, starting where its
    // caption starts.
    const refY = EMP_TOP + 5;
    at(BORANG_A_PAYMENT_REF_LABEL, tick2X + 12, refY, 7.5);
    const refEnd = tick2X + 12 + font.widthOfTextAtSize(safe(BORANG_A_PAYMENT_REF_LABEL), 7.5) + 4;
    hline(refEnd, RX - 8, refY - 1.5, 0.5, hair);

    // ── The employer band, its labels in the frame's LEFT MARGIN ────────────────────────────────────
    // "Nama Majikan" and "Alamat" sit right-aligned in the margin column, against the band, exactly where
    // the specimen puts them. Tarikh DiCetak and Bil Pekerja on the right of the same band.
    vline(LX, FRAME_BOT, EMP_TOP);
    const nameY = EMP_TOP - 11;
    atR('Nama Majikan', LX - 5, nameY, 7.5);
    atR('Alamat', LX - 5, nameY - 11, 7.5);
    const infoX = LX + 250;
    atFit(form.employerName, LX + 6, nameY, infoX - LX - 14, 9, bold);
    /**
     * EVERY address line, not the first three. `addressLines` builds up to four — addressLine1..3 and a
     * `postcode city, state` tail — and the tail is the line a counter clerk reads. The leading is computed
     * from the room actually left inside the band, so nothing is dropped at any count.
     */
    const addrTop = nameY - 11;
    const addrLead = Math.min(8.5, (addrTop - (FRAME_BOT + 4)) / Math.max(1, form.employerAddress.length - 1));
    for (const [i, l] of form.employerAddress.entries()) {
      atFit(l, LX + 6, addrTop - i * addrLead, infoX - LX - 14, Math.min(7.5, addrLead - 0.6));
    }
    for (const [i, [l, v]] of (
      [
        ['Tarikh DiCetak', form.printedOn],
        ['Bil Pekerja', String(form.employees)],
      ] as [string, string][]
    ).entries()) {
      const yy = nameY - i * 11;
      at(`${l} :`, infoX, yy, 7.5);
      atFit(v, infoX + 60, yy, RX - 6 - (infoX + 60), 8, bold);
    }

    // ── The Borang A column: KWSP 6 above, "Borang / A", the sheet number, Cop Agen Kutipan ─────────
    // Cop Agen Kutipan is DRAWN EMPTY on every sheet — it is the collecting agent's, not ours.
    vline(RX, FRAME_BOT, STRIP_TOP);
    hline(LX, RX, STRIP_TOP);
    const rcx = (RX + RIGHT) / 2;
    atC('Borang', rcx, STRIP_TOP - 22, 18, bold);
    atC('A', rcx, STRIP_TOP - 42, 18, bold);
    atC(`Mukasurat: ${pageData.sheet}/${pageData.of}`, rcx, STRIP_TOP - 70, 8);
    atC('Cop Agen Kutipan', rcx, FRAME_BOT + 8, 7.5);

    // ── The ruled member table: the two-level heading ───────────────────────────────────────────────
    const r1 = TABLE_TOP - 10;
    const r2 = TABLE_TOP - 24;
    const mid = TABLE_TOP - 17;
    const ctr = (a: number, b: number) => (a + b) / 2;
    atC('BIL', ctr(COL.bil, COL.member), mid, 7, bold);
    atC('NO. AHLI', ctr(COL.member, COL.nk), mid, 7, bold);
    // The reserved column. Its HEADING is the only thing that ever prints here.
    atC('N K', ctr(COL.nk, COL.ic), mid, 6.5, bold);
    atC('NO. KAD', ctr(COL.ic, COL.name), r1, 7, bold);
    atC('PENGENALAN', ctr(COL.ic, COL.name), r2, 7, bold);
    atC('NAMA PEKERJA / AHLI', ctr(COL.name, COL.wage), r1, 7, bold);
    atC('(Seperti yang terdapat di dalam Kad Pengenalan)', ctr(COL.name, COL.wage), r2, 6);
    atC('UPAH', ctr(COL.wage, COL.employer), r1, 7, bold);
    atC('(RM)', ctr(COL.wage, COL.employer), r2, 7, bold);
    atC('CARUMAN (RM)', ctr(COL.employer, COL.end), r1, 7, bold);
    atC('MAJIKAN', ctr(COL.employer, COL.employee), r2, 7, bold);
    atC('PEKERJA', ctr(COL.employee, COL.end), r2, 7, bold);
    hline(M, RIGHT, TABLE_TOP, 0.9);
    hline(COL.employer, RIGHT, TABLE_TOP - HEAD_ROW);
    hline(M, RIGHT, HEAD_BOT, 0.9);
    for (const x of [COL.bil, COL.member, COL.nk, COL.ic, COL.name, COL.wage, COL.employer, COL.end]) {
      vline(x, HEAD_BOT, TABLE_TOP);
    }
    vline(COL.employee, HEAD_BOT, TABLE_TOP - HEAD_ROW);

    /**
     * THE BROUGHT-FORWARD ROW: one merged cell from the margin through UPAH (the sample prints no wage on
     * it) holding the label, then the two contribution cells. Only ever drawn WITH values — r411 draws it
     * from sheet 2 onwards, where there is always something carried in.
     */
    const carryRow = (top: number, label: string, values: [number, number]) => {
      const y = base(top);
      atR(label, COL.employer - 4, y, 7.5, bold);
      atFitR(money(values[0]), COL.employee - 3, y, COL.employee - COL.employer - 6, 8.5, bold);
      atFitR(money(values[1]), COL.end - 3, y, COL.end - COL.employee - 6, 8.5, bold);
      hline(M, RIGHT, top - ROW_H);
      for (const x of [M, COL.employer, COL.employee, COL.end]) vline(x, top - ROW_H, top);
    };

    // ── Brought forward — SHEET 2 ONWARDS ONLY (r411, the October sample). ─────────────────────────
    // Sheet 1 has nothing to bring forward and the sample draws no row there; r407 drew an empty one.
    let top = HEAD_BOT;
    if (pageData.sheet > 1) {
      carryRow(top, 'Jumlah yang dibawa dari mukasurat terdahulu (jika ada)', [
        pageData.carryInEmployer,
        pageData.carryInEmployee,
      ]);
      top -= ROW_H;
    }

    // ── Rows ────────────────────────────────────────────────────────────────────────────────────────
    // Bil runs across the WHOLE form, not per sheet: it is the numbering a KWSP counter reads down.
    //
    // ⚠️ NOTHING IN THIS LOOP MAY WRITE INTO `COL.nk`. The N K column is KWSP's (catatan 5) and is printed
    // empty on purpose. `BorangARow` carries no field for it either, and the test reads the drawn text
    // positions back out of the rendered PDF to prove nothing lands in that band.
    let bil = form.pages.slice(0, pageData.sheet - 1).reduce((a, p) => a + p.rows.length, 0);
    const rowsTop = top;
    for (const r of pageData.rows) {
      bil += 1;
      const y = base(top);
      atC(String(bil), ctr(COL.bil, COL.member), y, 8.5);
      atFit(r.memberNo, COL.member + 3, y, COL.nk - COL.member - 6, 8.5);
      atFit(r.ic, COL.ic + 3, y, COL.name - COL.ic - 6, 8.5);
      // SHRINK, NEVER CUT — see `atFit`. A slightly smaller name is the person's name; a cut one is not.
      textFit(r.name, y);
      // A row whose EPF wage basis was never recorded cannot reach this renderer — the download gate
      // refuses it — but if it ever did, it must not print a zero that reads as a real wage.
      atFitR(r.wageRecorded ? money(r.wage) : '(tiada)', COL.employer - 3, y, COL.employer - COL.wage - 6, 8.5);
      atFitR(money(r.employer), COL.employee - 3, y, COL.employee - COL.employer - 6, 8.5);
      atFitR(money(r.employee), COL.end - 3, y, COL.end - COL.employee - 6, 8.5);
      top -= ROW_H;
      hline(M, RIGHT, top, 0.4, hair);
    }
    if (pageData.rows.length === 0) {
      at('Tiada pekerja bagi bulan ini / no employees for this month', COL.name + 3, base(top), 8.5, font, muted);
      top -= ROW_H;
      hline(M, RIGHT, top, 0.4, hair);
    }
    // The ruled grid: every column line through the member rows.
    for (const x of [COL.bil, COL.member, COL.nk, COL.ic, COL.name, COL.wage, COL.employer, COL.employee, COL.end]) {
      vline(x, top, rowsTop);
    }
    hline(M, RIGHT, top, 0.9);

    // ── NO carried-forward row, on any sheet (r411, the October sample). ────────────────────────────

    // ── JUMLAH (RM), on the last sheet only ─────────────────────────────────────────────────────────
    // Repeating it is how a multi-page form gets filed with the grand total mistaken for a page total.
    //
    // r411 — ONE FIGURE, as the October sample prints it: employer + employee (`totalContribution`, the
    // very number in the header's Amaun Caruman box), centred across the two CARUMAN cells, with the label
    // in the UPAH cell. NO WAGE TOTAL: the sample prints none, and the form's total is the contribution.
    if (last) {
      const y = base(top);
      // In the UPAH cell, as the sample prints it; it SHRINKS to fit that cell rather than spill into NAMA.
      atFitR('JUMLAH (RM)', COL.employer - 3, y, COL.employer - COL.wage - 6, 8.5, bold);
      const jumlah = safe(money(form.totalContribution));
      const jumlahSize = fitSize(jumlah, COL.end - COL.employer - 8, 9, bold);
      page.drawText(jumlah, {
        x: (COL.employer + COL.end) / 2 - bold.widthOfTextAtSize(jumlah, jumlahSize) / 2,
        y,
        size: jumlahSize,
        font: bold,
        color: ink,
      });
      hline(COL.wage, RIGHT, top - ROW_H, 1.1);
      for (const x of [COL.wage, COL.employer, COL.end]) vline(x, top - ROW_H, top);
      top -= ROW_H;
    }

    /**
     * THE FOOT FOLLOWS THE TABLE, as on the specimen — the representative's block, Cop Rasmi Majikan,
     * CATATAN and PERINGATAN sit a little under the last row rather than at the foot of an empty page. Its
     * space is still RESERVED at the bottom (TABLE_FLOOR), so `lift` is never negative: a full sheet puts
     * it exactly where the capacity arithmetic says, a short one moves it up. Only the provenance band stays
     * anchored to the bottom edge.
     */
    const lift = Math.max(0, top - 14 - FOOT_TOP);
    const [signBot, repLast, footBot, footTop, warnTop] = [SIGN_BOT, REP_LAST, FOOT_BOT, FOOT_TOP, WARN_TOP].map(
      (v) => v + lift,
    );

    // ── The representative's block, LAST SHEET ONLY ─────────────────────────────────────────────────
    // A filing is signed once, at the end of the deck — which is also why the space it occupies is
    // RESERVED on every sheet (see TABLE_FLOOR): `paginateBorangA` takes one rows-per-page for the whole
    // form, so a sheet that could hold more would renumber every sheet after it.
    if (last) {
      // THE PLACE TO SIGN, where the specimen puts it: beside "Tandatangan Wakil Majikan", above Nama.
      at('Tandatangan', M, signBot + SIGN_H - 9, 7.5);
      at('Wakil Majikan', M, signBot + SIGN_H - 18, 7.5);
      box(SIG_VALUE_X, signBot, SIG_VALUE_W, SIGN_H);
      const rep: [string, string][] = [
        ['Nama', form.repName],
        ['No. Kad Pengenalan', form.repIc],
        ['Jawatan', form.repPosition],
        // The agency's own label is "No. Tel / Bimbit", not "No. Tel".
        ['No. Tel / Bimbit', form.repPhone],
        ['E-mel', form.repEmail],
        // TARIKH IS NEVER THE PRINT DATE. It is the date the representative signed, which has not
        // happened when this file is written. It prints as a rule to write on, always.
        ['Tarikh', ''],
      ];
      for (const [i, [l, v]] of rep.entries()) {
        const yy = repLast + (REP_ROWS - 1 - i) * REP_ROW;
        at(l, M, yy, 7);
        // A BLANK RULE RATHER THAN AN INVENTED VALUE. ⚠️ `atFit`, never a clip: this is the signatory's
        // legal identity on a KWSP filing; it shrinks to fit and is always whole.
        if (v) atFit(v, SIG_VALUE_X + 3, yy, SIG_VALUE_W - 6, 8, bold);
        hline(SIG_VALUE_X, SIG_RIGHT, yy - 4, 0.5, hair);
      }
      // The employer's own stamp, beside the representative's block. Drawn empty.
      box(COP_X, footBot, COP_R - COP_X, footTop - footBot);
      atC('Cop Rasmi Majikan', (COP_X + COP_R) / 2, footBot + 6, 7.5);
    }

    // ── CATATAN, on EVERY sheet ─────────────────────────────────────────────────────────────────────
    // Form furniture, not a signature: each printed sheet carries the notes. The wording is ONE array in
    // lib/borang-a.ts so a supplied KWSP 6 page can be dropped in without touching this renderer.
    const catW = RIGHT - CATATAN_X;
    at('CATATAN', CATATAN_X, footTop - 8, 7.5, bold);
    let cy = footTop - 19;
    for (const [i, note] of BORANG_A_CATATAN.entries()) {
      at(`${i + 1}.`, CATATAN_X, cy, 6.6);
      for (const l of wrap(note, 6.6, catW - 11)) {
        at(l, CATATAN_X + 10, cy, 6.6);
        cy -= 8;
      }
    }

    // ── PERINGATAN ──────────────────────────────────────────────────────────────────────────────────
    // Malay is the specimen's sentence; the English line under it is OURS and says so, because an
    // unattributed translation of a statutory warning borrows the agency's authority.
    let wy = warnTop;
    for (const [i, s] of [BORANG_A_PERINGATAN_MS, BORANG_A_PERINGATAN_EN].entries()) {
      for (const l of wrap(s, 6.8, CW, i === 0 ? bold : font)) {
        at(l, M, wy, 6.8, i === 0 ? bold : font, i === 0 ? ink : muted);
        wy -= 9;
      }
    }

    // ── Provenance band ─────────────────────────────────────────────────────────────────────────────
    // WRAPPED, not one long line: the English sentence is wider than A4. The payroll month lives HERE
    // (the specimen has no "Bulan Upah" box), so note 6's "+1" stays checkable on the page.
    let by = PROV_TOP;
    hline(M, RIGHT, by + 9, 0.6, hair);
    const band = [
      'Susun atur kami sendiri, dilukis mengikut Borang A — bukan borang rasmi KWSP.',
      'Our own layout, drawn to match Borang A. The CATATAN notes and the PERINGATAN sentence are TRANSCRIBED from a filled ' +
        'Borang A produced by another payroll system, not taken from a KWSP page, and the English line under ' +
        'PERINGATAN is our own translation. Upah is the wage EPF was charged on and the contributions are ' +
        'taken from the payroll run, never recalculated.',
      `Bulan caruman ${form.contributionMonth} · bulan upah ${form.payrollPeriodKey}`,
    ];
    for (const paragraph of band) {
      for (const l of wrap(paragraph, 6.2, CW)) {
        at(l, M, by, 6.2, font, muted);
        by -= 7.8;
      }
    }

  }

  return doc.save();
}
