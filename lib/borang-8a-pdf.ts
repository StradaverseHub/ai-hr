/**
 * 8ca344bf · 16f2aac1 — draw a Borang 8A, A4 portrait, with pdf-lib (pure JS, no WASM/native, so no Next
 * bundler friction). Mirrors lib/ea-pdf.ts, which is the house pattern for a form we draw from scratch.
 *
 * ⚠️ THIS IS NOT PERKESO ARTWORK, AND THE PAGE SAYS SO. Both specimens we have been given are FILLED
 * OUTPUT from another payroll vendor's engine (producer "Developer Express Inc. DXperience (tm) v23.2.5"),
 * not agency pages, and PERKESO publishes no blank Borang 8A to print onto — so there is nothing to
 * overlay and every rule, box and heading below is drawn. What the specimens ARE is first-class evidence
 * of the agency's required WORDING, legal reference, field names and column order, and that is what they
 * have been read for. A footer band states the provenance in both languages, because a page that looks
 * like a government form and is not one is the single failure the whole statutory-forms fidelity
 * vocabulary exists to prevent. The catalog entry stays `agency-layout`; it must never become `official`.
 *
 * 16f2aac1 — THE REPORTER'S NINE CORRECTIONS, all of them wording and layout, none of them a figure:
 *   1. the PER. 44A legal reference line above the title            → masthead
 *   2. one title line: CARUMAN GAJI BULAN <bulan> <tahun> BORANG 8A → masthead, month/year in their boxes
 *   3. Kod Majikan · MyCoID · Amaun Caruman on one row              → header table band 1/2
 *   4. Nama dan Alamat Majikan · Lembaran · Bil. Pekerja on one row → header table band 4/5
 *   5. the exact "Amaun caruman di atas hendaklah dibayar…" sentence → header table band 3
 *   6. Kegunaan Ejen Pemungut (Cop, No. Slip Bayaran) to the top right → header table band 5, right stack
 *   7. the two date columns merged into one                         → COL.date
 *   8. NO. KAD PENGENALAN and NAMA PEKERJA (MENGIKUT KAD PENGENALAN) → HEADINGS
 *   9. Kaedah Pembayaran (Sila tandakan (x)) + three signature boxes → the manual band
 *
 * DRAWN EMPTY, ON PURPOSE: Kaedah Pembayaran, No. Cek / Kiriman Wang, Tandatangan, Nama, No. Tel & Cop
 * Majikan and the whole Kegunaan Ejen Pemungut block (Cop, No. Slip Bayaran). Those are the operator's and
 * the collecting agent's and are never payroll-derived; the specimen leaves every one of them blank too
 * (its "Nama" carries a name only because it is a COMPLETED form). Pre-filling a payment method or
 * stamping a signature box would be inventing a fact about a filing.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { money, splitRmSen, type Borang8AForm, type Borang8APage } from './borang-8a';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;
const M = 34;
const RIGHT = W - M;
const TABLE_W = RIGHT - M;

/**
 * The schedule's columns, as {left edge, width} rather than bare offsets, because every heading below is
 * MEASURED AGAINST ITS OWN WIDTH at draw time and wrapped to fit it.
 *
 * ⚠️ READ THIS BEFORE WIDENING A HEADING. The first version of this form put `stop` at M+62 and `status`
 * at M+124 and rendered "(1) Tarikh Berhenti(2) Status" as a single run: the heading was wider than its
 * column, and pdf-lib does not clip a heading. The answer THEN was to shorten the wording. That was the
 * wrong answer — 16f2aac1 is the reporter telling us the full agency wording is what the form needs — so
 * the answer NOW is `wrapTo`, which breaks any heading onto as many lines as its own column requires and
 * therefore cannot overflow whatever wording is put in it. Do not go back to trimming the words.
 *
 * `date` is ONE column (correction 7): the agency form heads it "TARIKH MULA/BERHENTI KERJA". `status` is
 * kept wider than the specimen draws it — the specimen sets S/T/A/T/U/S vertically down a ~14pt column,
 * which is artwork rather than wording, and a column that narrow would clip the typed statuses this
 * screen exists to let an operator enter. Same words, room to read them.
 */
const COL = {
  date: { x: M, w: 78 },
  status: { x: M + 78, w: 52 },
  ic: { x: M + 130, w: 78 },
  name: { x: M + 208, w: 239 },
  rm: { x: M + 447, w: 52 },
  sen: { x: M + 499, w: RIGHT - (M + 499) },
} as const;

const ROW_H = 15;

/**
 * The header table's own vertical rules. MODULE-LEVEL so what goes in each cell can be measured rather
 * than eyeballed: `d1` is what closes the employer's name-and-address cell, and therefore what bounds the
 * legal name (see `BORANG_8A_NAME_CELL`). `c1`/`c2` split the Kod Majikan · MyCoID · Amaun row;
 * `d1`/`d2` split Lembaran · Bil. Pekerja beside the employer block.
 */
const HDR = { c1: M + 170, c2: M + 390, d1: M + 330, d2: M + 430 } as const;

/**
 * Where the employer's registered name is drawn, and the width it must be held inside.
 *
 * ⚠️ THE LEGAL NAME IS THE ONE PAYROLL-DERIVED STRING THAT WAS NOT BOUNDED. It was drawn with a bare `T`
 * while the address lines directly under it in the same cell were clipped — and correction 4 is what gave
 * it a neighbour to collide with: Lembaran and Bil. Pekerja moved UP onto this row, so a name wider than
 * the cell now crosses the `d1` rule and prints into their value boxes. `co.legalName` is unbounded, and
 * at 10pt bold this cell holds about fifty characters: "PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SEMBILAN
 * SDN BHD" measures 357pt against 320pt of cell and landed 'BHD' next to the sheet number. Seen only by
 * rasterising the page with a real registered name on it. Same width as the address lines under it.
 */
export const BORANG_8A_NAME_CELL = { x: M + 4, w: HDR.d1 - M - 10, size: 10 } as const;

/** The point size every column heading is drawn at. Exported so the fit can be measured, not eyeballed. */
export const BORANG_8A_HEAD_SIZE = 6.5;
/** Horizontal padding inside a heading cell — the heading gets `col.w - PAD` to live in. */
export const BORANG_8A_HEAD_PAD = 6;

/**
 * The four wrapped headings, in the agency form's full wording (corrections 7 and 8).
 *
 * EXPORTED SO THEY CAN BE MEASURED. test/borang-8a.test.ts embeds the real Helvetica-Bold and asserts
 * that every wrapped line fits its own column at `BORANG_8A_HEAD_SIZE` — which is the mechanical version
 * of the rasterise-and-look step that found "(1) Tarikh Berhenti(2) Status" printing as one run. A word
 * longer than its column cannot be wrapped by anything, so that is the case the assertion really catches.
 */
export const BORANG_8A_HEADINGS: { key: string; col: { x: number; w: number }; parts: string[] }[] = [
  { key: 'date', col: COL.date, parts: ['TARIKH MULA/BERHENTI KERJA', '(hhbbtttt)', '(1)'] },
  { key: 'status', col: COL.status, parts: ['STATUS', '(2)'] },
  { key: 'ic', col: COL.ic, parts: ['NO. KAD PENGENALAN', '(3)'] },
  { key: 'name', col: COL.name, parts: ['NAMA PEKERJA (MENGIKUT KAD PENGENALAN)', '(4)'] },
];

/**
 * The amount heading — the ONE heading that spans two columns, and therefore the one the wrap test above
 * structurally cannot see. It is not in `BORANG_8A_HEADINGS` because it does not belong to a column:
 * "CARUMAN (5)" sits over RM and SEN together and only the sub-heads RM and SEN get a column each.
 *
 * ⚠️ THE RM/SEN DIVIDER MUST STOP AT `splitDy`. Ruling it the full height of the heading band — which is
 * what the first draft did, by putting COL.sen.x in the same EDGES loop as every other column edge — put
 * a vertical rule straight through the word CARUMAN, between its 'A' and its 'N': at 6.5pt bold the word
 * is 33.4pt wide, centred at 521.14, so it spans 504.4..537.9 and the divider stands at 533. That is the
 * same defect as the three rules struck through the empty-sheet sentence further down, and it printed on
 * every single sheet. A spanned heading needs a spanned cell: the divider starts at the split rule.
 *
 * The `dy` values are baselines measured UP from the foot of the heading band, on the same 8pt grid the
 * column headings use, opened out to leave the split rule clear air above the RM/SEN caps (top ≈ dy+4.7)
 * and below the '(5)' parentheses (bottom ≈ dy-1.4). EXPORTED SO ALL OF THAT CAN BE MEASURED.
 */
export const BORANG_8A_AMOUNT_HEAD = {
  /** The cell CARUMAN and (5) are centred in: both money columns, as one. */
  span: { x: COL.rm.x, w: RIGHT - COL.rm.x },
  /** Where the RM/SEN rule stands — and where it must NOT be drawn above. */
  divider: COL.sen.x,
  /** The rule that closes the spanned cell; the divider runs from here DOWN to the foot of the band. */
  splitDy: 12,
  spanning: [
    { text: 'CARUMAN', dy: 23 },
    { text: '(5)', dy: 15 },
  ],
  under: [
    { text: 'RM', col: COL.rm, dy: 4 },
    { text: 'SEN', col: COL.sen, dy: 4 },
  ],
} as const;

/**
 * Helvetica is WinAnsi (Latin-1). Two different things fall outside it and they need different answers.
 *
 * TYPOGRAPHY IS FOLDED, NOT DROPPED. An em dash and a curly apostrophe are U+2014 / U+2019 — outside
 * Latin-1 — so the first version printed our own footer as "Borang 8A ? bukan borang rasmi" and
 * "the agency?s own page". Found by rasterising the PDF and looking at it; nothing else can see it.
 * They fold to their ASCII equivalents, which is a faithful rendering rather than a lost character.
 *
 * A NAME still degrades to '?', and that stays a documented, tracked limitation rather than a silent
 * drop — the same one lib/ea-pdf.ts carries, with a Unicode font embed as the deferred follow-up.
 */
const fold = (s: string) =>
  (s ?? '')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...');
const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

/**
 * Break a run onto as many lines as `maxW` allows, measured in the font it will be DRAWN in.
 *
 * THIS IS THE WHOLE ANSWER TO THE OVERFLOW that made the column headings get shortened in the first
 * place. pdf-lib does not clip text, so a heading wider than its column prints straight into its
 * neighbour; the fix is to measure and wrap rather than to trim the agency's words. A word wider than the
 * column on its own is emitted alone rather than dropped — it will still be too wide, but a visibly
 * too-wide word is a bug you can see, and the test measures for exactly that case.
 */
export function wrapTo(
  s: string,
  maxW: number,
  size: number,
  f: { widthOfTextAtSize(t: string, size: number): number },
): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of safe(s).split(/\s+/).filter(Boolean)) {
    const trial = cur ? `${cur} ${w}` : w;
    if (cur && f.widthOfTextAtSize(trial, size) > maxW) {
      out.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/**
 * The employer's legal name, broken to AT MOST TWO lines that each fit `BORANG_8A_NAME_CELL`.
 *
 * WRAPPED RATHER THAN TRUNCATED, because the name is the identity of the filing: half a company name on a
 * statutory form is worse than two lines of a whole one, and the cell has the room (the address under it
 * starts one line lower and the cell foot is 96pt below its top). A name that still will not fit — one
 * unbreakable word, or a third line's worth — is clipped as a last resort, which is what the address
 * lines beside it already do, so nothing can ever cross the `d1` rule.
 *
 * EXPORTED SO THE FIT CAN BE MEASURED, the same way the column headings are.
 */
export function borang8ANameLines(
  name: string,
  f: { widthOfTextAtSize(t: string, size: number): number },
): string[] {
  const { w, size } = BORANG_8A_NAME_CELL;
  const wrapped = wrapTo(name, w, size, f);
  const lines = wrapped.length <= 2 ? wrapped : [wrapped[0], wrapped.slice(1).join(' ')];
  return lines.map((l) => {
    let v = l;
    while (v.length > 1 && f.widthOfTextAtSize(v, size) > w) v = v.slice(0, -1);
    return v;
  });
}

/**
 * The manual blocks are anchored to the FOOT of the page, not floated under the last row. A sheet with two
 * employees and a sheet with twenty then put the signature box in the same place, which is what makes a
 * stack of them signable without hunting — and it is what the specimen does.
 *
 * MEASURED AGAINST A FULL SHEET, not against the one-employee specimen. Twenty rows at ROW_H, plus the
 * per-sheet total and the grand total, bottom out at ~203pt; this band starts at 176 and ends at ~94, and
 * the provenance rule sits at 86. Move any of those three and re-rasterise a 20-row sheet, because a
 * collision here prints one box through another and no test can see it.
 */
const MANUAL_BAND_TOP = M + 142;

export async function renderBorang8APdf(form: Borang8AForm): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Borang 8A — ${form.employerName} — ${form.contributionMonth}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.6, 0.6, 0.65);
  const hair = rgb(0.82, 0.82, 0.86);

  /**
   * The month and year that go in the title's two boxes (correction 2). Taken from `contributionPeriodKey`
   * when it is well-formed, because that is the machine-readable half of the same fact; `contributionMonth`
   * ("MM / YYYY") is the fallback so a header assembled by hand still prints. NO ARITHMETIC — the
   * contribution month of a Borang 8A is the payroll month, and the one place that is decided is
   * `contributionPeriodFor`.
   */
  const period = /^\d{4}-\d{2}$/.test(form.contributionPeriodKey) ? form.contributionPeriodKey : '';
  const parts = form.contributionMonth.split('/').map((s) => s.trim());
  const bulan = period ? period.slice(5, 7) : (parts[0] ?? '');
  const tahun = period ? period.slice(0, 4) : (parts[1] ?? '');

  for (const pageData of form.pages) {
    const page = doc.addPage([W, H]);

    const T = (s: string, x: number, y: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x, y, size, font: f, color });
    const TR = (s: string, xr: number, y: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });
    const TC = (s: string, cx: number, y: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y, size, font: f, color });
    /** Clip to a width so a long legal name can never run into the next column. */
    const TClip = (s: string, x: number, y: number, maxW: number, size: number, f = font, color = ink) => {
      let v = safe(s);
      while (v.length > 1 && f.widthOfTextAtSize(v, size) > maxW) v = v.slice(0, -1);
      page.drawText(v, { x, y, size, font: f, color });
    };
    const hline = (y: number, x1 = M, x2 = RIGHT, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
    const vline = (x: number, yTop: number, yBot: number, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x, y: yTop }, end: { x, y: yBot }, thickness, color });
    const box = (x: number, y: number, w: number, h: number) =>
      page.drawRectangle({ x, y, width: w, height: h, borderColor: rule, borderWidth: 0.7 });

    // ── Masthead (corrections 1 and 2) ───────────────────────────────────────────────────────────
    let y = H - M - 2;
    TC('PERTUBUHAN KESELAMATAN SOSIAL', W / 2, y, 11, bold);
    y -= 12;
    // Correction 1. The reporter quoted this line verbatim; the specimen prints it with spaces around the
    // dash ("PERATURAN - PERATURAN"), which is typesetting rather than wording, so the quoted form stands.
    TC('PERATURAN-PERATURAN (AM) KESELAMATAN SOSIAL PEKERJA 1971 (PER. 44A)', W / 2, y, 8.5, bold);
    y -= 18;

    // Correction 2: ONE title line. The month and the year sit in their own boxes under `bulan` / `tahun`
    // captions exactly as the agency form does, so the two-digit month cannot be read as a day.
    {
      const cap = 'CARUMAN GAJI BULAN';
      const capW = bold.widthOfTextAtSize(cap, 11);
      const bw1 = 38;
      const bw2 = 46;
      const gap = 8;
      const groupW = capW + gap + bw1 + gap + bw2;
      const brandW = bold.widthOfTextAtSize('BORANG 8A', 15);
      const gx = M + Math.max(0, (TABLE_W - brandW - 14 - groupW) / 2);
      const bx1 = gx + capW + gap;
      const bx2 = bx1 + bw1 + gap;
      T(cap, gx, y, 11, bold);
      box(bx1, y - 3.5, bw1, 14);
      box(bx2, y - 3.5, bw2, 14);
      TC(bulan, bx1 + bw1 / 2, y, 10, bold);
      TC(tahun, bx2 + bw2 / 2, y, 10, bold);
      TC('bulan', bx1 + bw1 / 2, y - 13, 6.5, bold, muted);
      TC('tahun', bx2 + bw2 / 2, y - 13, 6.5, bold, muted);
      TR('BORANG 8A', RIGHT, y - 1, 15, bold);
    }
    y -= 24;

    // ── Header table (corrections 3, 4, 5, 6) ────────────────────────────────────────────────────
    // A real ruled grid, not labels floating on whitespace: the reporter's corrections are about which
    // box a field sits in, and a box you cannot see is not a box.
    const y0 = y;
    const y1 = y0 - 13; // under the Kod Majikan / MyCoID / Amaun labels
    const y2 = y1 - 16; // under their values
    const y3 = y2 - 15; // under the payment-deadline sentence
    const y4 = y3 - 13; // under the Nama / Lembaran / Bil. Pekerja labels
    const y4v = y4 - 16; // under the Lembaran / Bil. Pekerja values
    const y4a = y4v - 13; // under the "Kegunaan Ejen Pemungut" heading
    const y5 = y4 - 96; // foot of the whole header table
    const { c1, c2, d1, d2 } = HDR;

    for (const yy of [y0, y1, y2, y3, y4]) hline(yy);
    hline(y5);
    hline(y4v, d1, RIGHT);
    hline(y4a, d1, RIGHT);
    for (const x of [c1, c2]) vline(x, y0, y2);
    for (const x of [d1, d2]) vline(x, y3, y4v);
    vline(d1, y3, y5);
    vline(M, y0, y5);
    vline(RIGHT, y0, y5);

    // Correction 3 — one horizontal row, and the contribution month is NOT among them any more: it moved
    // up into the title, which is what the reporter asked for.
    T('No. Kod Majikan', M + 4, y0 - 9.5, 8, bold);
    T('No. MyCoID / No. Pendaftaran Perniagaan', c1 + 4, y0 - 9.5, 8, bold);
    T('Amaun Caruman (RM)', c2 + 4, y0 - 9.5, 8, bold);
    T(form.employerCode, M + 4, y1 - 11.5, 10, bold);
    // BLANK, not a dash, when there is no MyCoID. The em dash folds to a bare '-' in WinAnsi, and a lone
    // hyphen sitting in a box on a statutory form reads as a VALUE somebody entered. The specimen leaves
    // this box empty, `missingBorang8AHeader` deliberately does not require it, and an empty box is the
    // honest rendering of an absent fact. (The plain-text twin keeps its '—' — there it is a column
    // alignment marker in a fixed-width layout, not something a clerk reads off a form.)
    T(form.mycoid, c1 + 4, y1 - 11.5, 10, bold);
    TR(money(form.total), RIGHT - 4, y1 - 11.5, 10, bold);

    // Correction 5 — the sentence, verbatim. The DATE RULE is unchanged and is decided in
    // `paymentDueDateFor`: the LAST DAY of the contribution month, which is not the ASSIST 15th-of-next-
    // month and not KWSP's rule either. Only the words around it moved.
    {
      const sentence = 'Amaun caruman di atas hendaklah dibayar kepada PERKESO/EJEN PEMUNGUT tidak lewat daripada';
      T(sentence, M + 4, y2 - 10.5, 8);
      T(form.paymentDueDate, M + 8 + font.widthOfTextAtSize(safe(sentence), 8), y2 - 10.5, 8, bold);
    }

    // Correction 4 — Lembaran and Bil. Pekerja come UP onto the Nama dan Alamat Majikan row.
    T('Nama dan Alamat Majikan', M + 4, y3 - 9.5, 8, bold);
    TC('Lembaran', (d1 + d2) / 2, y3 - 9.5, 8, bold);
    TC('Bil. Pekerja', (d2 + RIGHT) / 2, y3 - 9.5, 8, bold);
    TC(`${pageData.sheet}/${pageData.of}`, (d1 + d2) / 2, y4 - 11.5, 9, bold);
    TC(String(form.employees), (d2 + RIGHT) / 2, y4 - 11.5, 9, bold);

    // The name is BOUNDED like the address under it — see BORANG_8A_NAME_CELL. It is the same cell, so it
    // gets the same width, and the address simply starts under however many lines the name took.
    {
      const { x: nx, w: nw, size: nsize } = BORANG_8A_NAME_CELL;
      let ay = y4 - 14;
      for (const l of borang8ANameLines(form.employerName, bold)) {
        TClip(l, nx, ay, nw, nsize, bold);
        ay -= 11;
      }
      for (const l of form.employerAddress) {
        TClip(l, nx, ay, nw, 8.5, font, muted);
        ay -= 10;
      }
    }

    // Correction 6 — the collecting agent's block, at the TOP RIGHT and no longer at the foot. Both
    // fields inside it are the agent's to complete and are left blank.
    TC('Kegunaan Ejen Pemungut', (d1 + RIGHT) / 2, y4v - 9.5, 8, bold);
    T('Cop', d1 + 8, y4a - 11, 7.5, font, muted);
    T('No. Slip Bayaran', d1 + 8, y5 + 22, 7.5, font, muted);
    box(d1 + 8, y5 + 5, RIGHT - d1 - 16, 14);

    // ── Column headings (corrections 7 and 8) ────────────────────────────────────────────────────
    // The full agency wording, WRAPPED TO EACH COLUMN'S OWN WIDTH rather than shortened to fit it. See the
    // note on COL: shortening is what this round is undoing, and `wrapTo` is what makes that safe.
    const ey = y5 - 12;
    const laid = BORANG_8A_HEADINGS.map((h) => ({
      col: h.col,
      lines: h.parts.flatMap((p) => wrapTo(p, h.col.w - BORANG_8A_HEAD_PAD, BORANG_8A_HEAD_SIZE, bold)),
    }));
    // The amount block needs one row per spanning line plus the RM | SEN row under the split rule.
    const amountRows = BORANG_8A_AMOUNT_HEAD.spanning.length + 1;
    const headLines = Math.max(...laid.map((h) => h.lines.length), amountRows);
    const headH = headLines * 8 + 5;
    const headBot = ey - headH;

    for (const h of laid) {
      // Bottom-aligned: the (1)…(4) numbers then sit on one baseline across the whole heading row, which
      // is how the agency form reads even though the columns need different numbers of lines.
      const startY = headBot + 5 + (h.lines.length - 1) * 8;
      for (const [i, l] of h.lines.entries()) TC(l, h.col.x + h.col.w / 2, startY - i * 8, BORANG_8A_HEAD_SIZE, bold);
    }
    {
      // CARUMAN (5) is a SPANNED heading: centred over both money columns, with the split rule under it
      // and the RM/SEN divider running only from that rule down. See BORANG_8A_AMOUNT_HEAD — drawing the
      // divider the full height of the band put it through the middle of the word.
      const A = BORANG_8A_AMOUNT_HEAD;
      const cx = A.span.x + A.span.w / 2;
      for (const s of A.spanning) TC(s.text, cx, headBot + s.dy, BORANG_8A_HEAD_SIZE, bold);
      for (const u of A.under) TC(u.text, u.col.x + u.col.w / 2, headBot + u.dy, BORANG_8A_HEAD_SIZE, bold);
      hline(headBot + A.splitDy, A.span.x, RIGHT);
    }
    hline(ey);
    hline(headBot);
    const EDGES = [M, COL.status.x, COL.ic.x, COL.name.x, COL.rm.x, COL.sen.x, RIGHT];
    for (const x of EDGES) {
      // The RM/SEN divider starts at the split rule and runs DOWN. Every other edge rules the whole band.
      // Ruling this one from `ey` like the rest is what printed a line through the middle of CARUMAN.
      const top = x === BORANG_8A_AMOUNT_HEAD.divider ? headBot + BORANG_8A_AMOUNT_HEAD.splitDy : ey;
      vline(x, top, headBot);
    }

    // ── Rows ────────────────────────────────────────────────────────────────────────────────────
    let ry = headBot;
    for (const r of pageData.rows) {
      const { rm, sen } = splitRmSen(r.contribution);
      const base = ry - 10;
      // Correction 7 — ONE date cell. Two fixed slots inside it, MULA above BERHENTI, so a row carrying
      // only a leaving date cannot be misread as a joining one. Most rows carry neither: the column is
      // blank for anyone who neither joined nor left in the contribution month.
      TClip(r.startDate, COL.date.x + 4, ry - 6, COL.date.w - 8, 7.5);
      TClip(r.stopDate, COL.date.x + 4, ry - 13, COL.date.w - 8, 7.5);
      TClip(r.status, COL.status.x + 4, base, COL.status.w - 8, 8);
      TClip(r.ic, COL.ic.x + 4, base, COL.ic.w - 8, 8);
      TClip(r.name, COL.name.x + 4, base, COL.name.w - 8, 8.5);
      TR(rm, COL.rm.x + COL.rm.w - 5, base, 8.5);
      TC(sen, COL.sen.x + COL.sen.w / 2, base, 8.5);
      ry -= ROW_H;
      hline(ry, M, RIGHT, 0.4, hair);
    }
    const isEmpty = pageData.rows.length === 0;
    if (isEmpty) {
      ry -= ROW_H;
      T('Tiada pekerja bagi bulan ini / no employees for this month', COL.date.x + 4, ry + 5, 8, font, muted);
    }
    // NO INTERNAL DIVIDERS ON AN EMPTY SHEET. The "tiada pekerja" line is wider than any one column, so
    // drawing the usual six edges through it struck the sentence out with three vertical rules — seen only
    // by rasterising an empty month and looking at it. An empty band gets its outer edges and nothing else.
    for (const x of isEmpty ? [M, RIGHT] : EDGES) vline(x, headBot, ry);

    // ── Page total ──────────────────────────────────────────────────────────────────────────────
    {
      const { rm, sen } = splitRmSen(pageData.pageTotal);
      const top = ry;
      ry -= 16;
      hline(ry);
      TR('Jumlah muka surat ini', COL.rm.x - 6, ry + 5, 8.5, bold);
      TR(rm, COL.rm.x + COL.rm.w - 5, ry + 5, 8.5, bold);
      TC(sen, COL.sen.x + COL.sen.w / 2, ry + 5, 8.5, bold);
      for (const x of [M, COL.rm.x, COL.sen.x, RIGHT]) vline(x, top, ry);
    }

    // The whole-form total, on the LAST sheet only: repeating it on every sheet is how a multi-page
    // schedule gets filed with the grand total mistaken for a page total. The specimen is a ONE-employee,
    // one-sheet form and so cannot show this line either way; it stays because a stack of sheets whose
    // only total is per-sheet cannot be reconciled at a counter.
    if (pageData.sheet === pageData.of) {
      const { rm, sen } = splitRmSen(form.total);
      const top = ry;
      ry -= 18;
      hline(ry);
      TR('AMAUN CARUMAN (jumlah keseluruhan)', COL.rm.x - 6, ry + 5, 9, bold);
      TR(rm, COL.rm.x + COL.rm.w - 5, ry + 5, 9, bold);
      TC(sen, COL.sen.x + COL.sen.w / 2, ry + 5, 9, bold);
      // Ruled into the same grid as the rows above it. Floating this line free of the table made it read
      // as a note under the form rather than as the form's own total — seen only by rasterising the page.
      for (const x of [M, COL.rm.x, COL.sen.x, RIGHT]) vline(x, top, ry);
    }

    // ── Manual blocks, drawn EMPTY, anchored to the foot of the page (correction 9) ──────────────
    // Every box below is left blank on purpose: Kaedah Pembayaran, No. Cek / Kiriman Wang, Tandatangan,
    // Nama and No. Tel & Cop Majikan are the operator's, never payroll-derived. Pre-filling a payment
    // method or stamping a signature box would be inventing a fact about a filing.
    //
    // THE TWO COLUMNS DO NOT OVERLAP, AND THAT IS MEASURED RATHER THAN ASSUMED. An earlier draft of this
    // band put three boxes on one row at M+268 w=160 (ending 462) and RIGHT-130 (431) and they printed
    // through each other — found by rasterising the page and looking at it, which is the only thing that
    // can see it. The left stack ends at M+250 (284) and the right one starts at M+290 (324).
    {
      let ly = MANUAL_BAND_TOP;
      const lx = M + 70;
      const lw = 180;
      // Correction 9 — the single signature box becomes three separate fields.
      T('Tandatangan', M, ly, 8, font, muted);
      hline(ly - 3, lx, lx + lw, 0.7, rule);
      ly -= 26;
      T('Nama', M, ly, 8, font, muted);
      hline(ly - 3, lx, lx + lw, 0.7, rule);
      ly -= 26;
      T('No. Tel &', M, ly, 8, font, muted);
      T('Cop Majikan', M, ly - 9, 8, font, muted);
      box(lx, ly - 30, lw, 38);

      let py = MANUAL_BAND_TOP;
      const px = M + 290;
      T('Kaedah Pembayaran (Sila tandakan (x))', px, py, 8, font, muted);
      py -= 17;
      // The reporter's own order, read across the two columns: Tunai, Kiriman Wang, Cek, Lain-lain.
      const OPTS: [string, number, number][] = [
        ['Tunai', 0, 0],
        ['Kiriman Wang', 118, 0],
        ['Cek', 0, 16],
        ['Lain-lain', 118, 16],
      ];
      for (const [opt, dx, dy] of OPTS) {
        box(px + dx, py - dy - 1, 9, 9);
        T(opt, px + dx + 13, py - dy + 0.5, 7.5, font, muted);
      }
      py -= 38;
      T('No. Cek / Kiriman Wang', px, py, 8, font, muted);
      box(px, py - 20, 200, 16);
    }

    // ── Provenance band ─────────────────────────────────────────────────────────────────────────
    // WRAPPED, not one long line. The English sentence is wider than A4 and the first draft ran it off
    // the right edge — "never recalcula" was the last thing on the page.
    let by = M + 40;
    hline(by + 12, M, RIGHT, 0.7, hair);
    const band = [
      'Susun atur kami sendiri, dilukis mengikut Borang 8A — bukan borang rasmi PERKESO.',
      'Our own layout, drawn to match Borang 8A. PERKESO publishes no blank form to print onto, so this is ' +
        'not the agency’s own page. Figures are taken from the payroll run, never recalculated.',
      `Caruman gaji bulan ${form.contributionMonth} · payroll ${form.payrollPeriodKey}`,
    ];
    for (const paragraph of band) {
      for (const l of wrapTo(paragraph, TABLE_W, 6.8, font)) {
        T(l, M, by, 6.8, font, muted);
        by -= 9;
      }
    }
  }

  return doc.save();
}

/** Filename for the download: employer code + contribution month, both safe for a Content-Disposition. */
export function borang8AFilename(form: Borang8AForm, ext: 'pdf' | 'txt'): string {
  const code = (form.employerCode || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  const period = form.contributionPeriodKey.replace('-', '');
  return `borang-8a-${code}-${period}.${ext}`;
}

/** Re-exported so a caller drawing a single sheet does not have to reach into lib/borang-8a. */
export type { Borang8APage };
