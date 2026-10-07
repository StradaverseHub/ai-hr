/**
 * 8ca344bf · 16f2aac1 · r408 (e74af58c) — draw a Borang 8A, A4 portrait, with pdf-lib (pure JS, no
 * WASM/native, so no Next bundler friction).
 *
 * ── r408: REDRAWN BOX BY BOX TO PERKESO'S OWN PAGE 1 ─────────────────────────────────────────────────
 * Until r408 this header said PERKESO publishes no blank Borang 8A, and the page was drawn to match two
 * FILLED vendor outputs (DevExpress v23.2.5). That claim was false: PERKESO publishes the blank 8A on its
 * website (a two-page A4 PDF, producer "doPDF Ver 7.3", created 1 July 2013), and the reporter linked it.
 * Every coordinate in `BORANG_8A_SHEET` below was MEASURED off that file's page 1 — its stroked paths and
 * its text runs (`mutool trace`, `pdftotext -bbox`) — in PDF points, origin bottom-left, which is pdf-lib's
 * own space, so no number here is eyeballed. Arial on the agency's page and Helvetica here share metrics.
 *
 * WHAT IS DELIBERATELY NOT REPRODUCED, and why the page is still DRAWN rather than printed onto:
 *   • page 2, "PANDUAN MENGISI BORANG 8A" — its guidance dates from 2013 and still quotes the RM3,000 wage
 *     line; printing it would put an outdated rule on every filing;
 *   • the OCR form ids at the top right of each page ("2346249101", "3659249109") and the four OCR corner
 *     registration marks — they identify PERKESO's own scanned stationery, which this is not;
 *   • the PERKESO logo — a page of ours carrying the agency's mark would read as the agency's page.
 * Fidelity therefore stays `agency-layout` (the layout is the agency's; the paper is ours) and never
 * `official`, and the provenance line at the foot says so in both languages.
 *
 * ── AN ABSENT BOX ASSERTS NOTHING ─────────────────────────────────────────────────────────────────────
 * Every box whose value the records do not hold is drawn EMPTY: the MyCoID when it is blank, Kaedah
 * Pembayaran and No. Cek / Kiriman Wang, Tandatangan / Nama / No. Tel & Cop Majikan, and the whole Kegunaan
 * Ejen Pemungut block (Cop, No. Slip Bayaran). Money is printed only where it exists: a ruled row with no
 * employee on it gets no RM/SEN digits at all — never "0.00", which would assert a contribution of nothing.
 *
 * ── THE ONE DEPARTURE FROM THE AGENCY'S BOXES, NAMED ───────────────────────────────────────────────────
 * The agency's column (1) holds ONE date (the guide: a joiner's start date, or a leaver's stop date). Ours
 * keeps two fixed slots in that cell — MULA above, BERHENTI below — because somebody who joins and leaves in
 * the same month has two, and a stop date read as a start date would misstate the filing.
 *
 * A digit run that holds more characters than the agency ruled boxes for (a typed status, an over-long
 * code) is drawn WHOLE across the run at a smaller size rather than cut: a truncated code is a different
 * code. See `comb`.
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { BORANG_8A_ROWS_PER_PAGE, splitRmSen, type Borang8AForm, type Borang8APage } from './borang-8a';

/** A4 portrait, in points — the agency file's own page box (595 × 842). */
const W = 595.28;
const H = 841.89;

/** A run of equal ruled boxes: left edge of the first, pitch, count, and the row they sit on. */
type BoxRun = { x: number; pitch: number; n: number; y: number; h: number };

/**
 * THE AGENCY'S PAGE 1, MEASURED. Every figure is a coordinate read off PERKESO's blank Borang 8A (2013),
 * rounded to 0.1pt. Exported so the tests measure the drawn page against the agency's geometry.
 */
export const BORANG_8A_SHEET = {
  /** The two outer frames: the header block, and the schedule (heading band + 20 rows + page total). */
  header: { x1: 27.5, x2: 566.6, top: 768.2, bottom: 586.0 },
  table: { x1: 27.5, x2: 567.1, top: 583.4, bottom: 131.5 },
  /** Header rules, top to bottom: under the labels, under the value boxes, under the deadline sentence,
   *  under the Nama / Lembaran / Bil. Pekerja labels. */
  headerRules: [757.7, 739.4, 728.2, 717.7],
  /** Kod Majikan | MyCoID | Amaun Caruman, between the top rule and the value boxes' rule. */
  headerSplits: [194.3, 439.6],
  /** Name-and-address cell | the Lembaran / Kegunaan Ejen Pemungut block. */
  addressSplit: 397.1,
  lembaranSplit: 497.5,
  /** The two short rules under the Lembaran / Bil. Pekerja boxes and under "Kegunaan Ejen Pemungut". */
  agentRules: [698.9, 687.2],
  kod: { x: 35.9, pitch: 11.52, n: 12, y: 741.4, h: 14.1 } as BoxRun,
  mycoid: { x: 202.2, pitch: 11.505, n: 20, y: 741.5, h: 14.1 } as BoxRun,
  amaunRm: { x: 455.9, pitch: 11.52, n: 6, y: 741.5, h: 14.1 } as BoxRun,
  amaunSen: { x: 530.8, pitch: 11.5, n: 2, y: 741.5, h: 14.1 } as BoxRun,
  amaunDot: { x: 525.6, y: 742.8 },
  bulan: { x: 318.3, pitch: 11.8, n: 2, y: 776.6, h: 13.8 } as BoxRun,
  tahun: { x: 351.7, pitch: 11.8, n: 4, y: 776.6, h: 13.8 } as BoxRun,
  lembaran: { x: 408.4, pitch: 11.5, n: 3, y: 700.9, h: 14.1 } as BoxRun,
  lembaranOf: { x: 454.4, pitch: 11.53, n: 3, y: 700.9, h: 14.1 } as BoxRun,
  lembaranSlash: { x: 446.4, y: 702.2 },
  bilPekerja: { x: 509.4, pitch: 11.53, n: 4, y: 701.0, h: 14.1 } as BoxRun,
  slipBayaran: { x: 406.1, pitch: 11.53, n: 12, y: 589.9, h: 14.1 } as BoxRun,
  /** The schedule's column edges, left to right: (1) | (2) | (3) | (4) | (5). */
  columns: { date: 27.5, status: 81.9, ic: 95.4, name: 194.0, amount: 495.0, end: 567.1 },
  /** The heading band's foot, and the rule that splits CARUMAN (5) from its RM / SEN sub-heads. */
  headBottom: 544.3,
  amountSplit: 556.1,
  /** The twenty employee rows: from the heading band's foot down to the "Jumlah muka surat ini" row. The
   *  agency's rules fall on a 19.37pt pitch to within 0.6pt; ours are uniform on the same span. */
  rows: { top: 544.3, bottom: 156.9, count: 20 },
  /** Per-row digit boxes, positioned from the row's FOOT (agency: box 2.7pt above it, 14.1pt tall). */
  rowRm: { x: 497.7, pitch: 12.2, n: 3, dy: 2.7, h: 14.1 },
  rowSen: { x: 540.3, pitch: 12.2, n: 2, dy: 2.7, h: 14.1 },
  rowDot: { x: 535.0, dy: 3.8 },
  /** Jumlah muka surat ini — its own row, its own boxes. */
  pageTotalRm: { x: 454.1, pitch: 12.95, n: 6, y: 136.6, h: 17.0 } as BoxRun,
  pageTotalSen: { x: 538.3, pitch: 12.95, n: 2, y: 136.6, h: 17.0 } as BoxRun,
  pageTotalDot: { x: 532.8, y: 139.2 },
  /** The foot: payment method tick boxes (8.4pt squares), the cheque-number run, the signature rules. */
  ticks: [
    { label: 'Tunai', box: { x: 339.1, y: 94.0 }, text: { x: 350.4, y: 95.3 } },
    { label: 'Kiriman  Wang', box: { x: 438.9, y: 95.2 }, text: { x: 450.2, y: 96.5 } },
    { label: 'Cek ........................', box: { x: 339.1, y: 77.9 }, text: { x: 350.4, y: 79.2 } },
    { label: 'Lain-lain .........................', box: { x: 438.9, y: 79.1 }, text: { x: 450.2, y: 80.4 } },
  ],
  tick: 8.4,
  noCek: { x: 338.4, pitch: 12.96, n: 10, y: 45.1, h: 17.8 } as BoxRun,
  signRules: [
    { y: 93.2, x1: 102.9, x2: 234.3 },
    { y: 74.7, x1: 102.3, x2: 235.4 },
  ],
} as const;

/** The employee lines one sheet is ruled for — the agency's own twenty, and the pagination's. */
export const BORANG_8A_RULED_ROWS = BORANG_8A_SHEET.rows.count;
if (BORANG_8A_RULED_ROWS !== BORANG_8A_ROWS_PER_PAGE) {
  // A module-load failure rather than a quiet mismatch: a sheet paginated for N rows drawn on a page ruled
  // for M either leaves people off the page or prints rows the form has no line for.
  throw new Error('Borang 8A: rows per page must equal the agency form’s ruled rows');
}

/** The pitch of one employee row. */
export const BORANG_8A_ROW_PITCH =
  (BORANG_8A_SHEET.rows.top - BORANG_8A_SHEET.rows.bottom) / BORANG_8A_SHEET.rows.count;

/** The point size of the column headings — the agency's own 6pt (the RM / SEN sub-heads are 7pt). */
export const BORANG_8A_HEAD_SIZE = 6;

/**
 * The column headings, in the agency's own wording and lines, each with the baseline the agency sets it on.
 * EXPORTED SO THEY CAN BE MEASURED: test/borang-8a.test.ts embeds Helvetica-Bold and asserts every line
 * fits inside its own column.
 */
const C = BORANG_8A_SHEET.columns;
export const BORANG_8A_HEADINGS: { key: string; col: { x: number; w: number }; lines: { text: string; y: number }[] }[] = [
  {
    key: 'date',
    col: { x: C.date, w: C.status - C.date },
    lines: [
      { text: 'TARIKH', y: 575.3 },
      { text: 'MULA/BERHENTI', y: 568.1 },
      { text: 'KERJA', y: 560.9 },
      { text: '(hhbbtttt)', y: 554.2 },
      { text: '(1)', y: 547.9 },
    ],
  },
  // STATUS itself is set VERTICALLY by the agency (rotated 90°, reading upwards, baseline x 90.5); only its
  // number sits on the shared baseline. See `renderBorang8APdf`.
  { key: 'status', col: { x: C.status, w: C.ic - C.status }, lines: [{ text: '(2)', y: 547.9 }] },
  {
    key: 'ic',
    col: { x: C.ic, w: C.name - C.ic },
    lines: [
      { text: 'NO. KAD PENGENALAN', y: 565.7 },
      { text: '(3)', y: 547.9 },
    ],
  },
  {
    key: 'name',
    col: { x: C.name, w: C.amount - C.name },
    lines: [
      { text: 'NAMA PEKERJA (MENGIKUT KAD PENGENALAN)', y: 565.0 },
      { text: '(4)', y: 547.9 },
    ],
  },
  {
    key: 'amount',
    col: { x: C.amount, w: C.end - C.amount },
    lines: [
      { text: 'CARUMAN', y: 568.8 },
      { text: '(5)', y: 561.6 },
    ],
  },
];
/** The vertical STATUS heading: its baseline x, and the y it starts from (it reads upwards). */
export const BORANG_8A_STATUS_HEAD = { text: 'STATUS', x: 90.5, y: 556.3 } as const;

/** The employer's name: the address cell, at most two lines, 10pt bold. Exported so the fit is measured. */
export const BORANG_8A_NAME_CELL = {
  x: 36.7,
  w: BORANG_8A_SHEET.addressSplit - 36.7 - 6,
  size: 10,
} as const;

/**
 * Helvetica is WinAnsi (Latin-1). TYPOGRAPHY IS FOLDED (an em dash and a curly apostrophe are outside it
 * and printed "?" once — found by rasterising); a NAME outside Latin-1 still degrades to '?', the documented
 * limitation lib/ea-pdf.ts carries, with a Unicode font embed as the deferred follow-up.
 */
const fold = (s: string) =>
  (s ?? '')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...');
const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

/** Break a run onto as many lines as `maxW` allows, measured in the font it will be DRAWN in. */
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
 * The employer's legal name, broken to AT MOST TWO lines that each fit `BORANG_8A_NAME_CELL`. Wrapped
 * rather than truncated (half a company name is worse than two lines of a whole one); a name that still
 * will not fit is clipped as a last resort so nothing crosses into the Lembaran block.
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

/** The size at which `s` fits `maxW`, never above `size` — a shrink, never a cut. */
export function fitSize(s: string, maxW: number, size: number, f: PDFFont): number {
  const w = f.widthOfTextAtSize(safe(s), size);
  return w <= maxW ? size : Math.max(0.5, (size * maxW) / w);
}

export async function renderBorang8APdf(form: Borang8AForm): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Borang 8A — ${form.employerName} — ${form.contributionMonth}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const S = BORANG_8A_SHEET;

  const ink = rgb(0, 0, 0);
  const muted = rgb(0.35, 0.35, 0.38);
  const LW = 1;

  /**
   * The month and year for the title's two runs of boxes. From `contributionPeriodKey` when well-formed;
   * `contributionMonth` ("MM / YYYY") is the fallback. NO ARITHMETIC — `contributionPeriodFor` decides.
   */
  const period = /^\d{4}-\d{2}$/.test(form.contributionPeriodKey) ? form.contributionPeriodKey : '';
  const parts = form.contributionMonth.split('/').map((s) => s.trim());
  const bulan = period ? period.slice(5, 7) : (parts[0] ?? '');
  const tahun = period ? period.slice(0, 4) : (parts[1] ?? '');
  const total = splitRmSen(form.total);

  for (const pageData of form.pages) {
    const page = doc.addPage([W, H]);
    const T = (s: string, x: number, y: number, size: number, f = bold, color = ink) =>
      page.drawText(safe(s), { x, y, size, font: f, color });
    const TC = (s: string, cx: number, y: number, size: number, f = bold, color = ink) =>
      page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y, size, font: f, color });
    const hline = (y: number, x1: number, x2: number) =>
      page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: LW, color: ink });
    const vline = (x: number, y1: number, y2: number) =>
      page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: LW, color: ink });
    const rect = (x1: number, y1: number, x2: number, y2: number) =>
      page.drawRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, borderColor: ink, borderWidth: LW });

    // ── Masthead (no logo, no OCR form id, no corner marks — see the header) ─────────────────────────
    TC('PERTUBUHAN KESELAMATAN SOSIAL', (182.9 + 425.8) / 2, 805.4, 13);
    // The reporter quoted this line without spaces round the hyphen (16f2aac1); the agency sets it with
    // them, which is typesetting rather than wording. Centred where the agency centres it.
    TC('PERATURAN-PERATURAN (AM) KESELAMATAN SOSIAL PEKERJA 1971 (PER. 44A)', (154.1 + 524.0) / 2, 791.5, 9);
    T('CARUMAN GAJI BULAN', 195.6, 778.6, 10);
    boxes(page, S.bulan, LW);
    boxes(page, S.tahun, LW);
    comb(page, bulan, S.bulan, 10, bold, 'right');
    comb(page, tahun, S.tahun, 10, bold, 'right');
    T('bulan', 319.7, 769.9, 8);
    T('tahun', 366.2, 769.9, 8);
    T('BORANG 8A', 486.0, 775.7, 12);

    // ── Header block ────────────────────────────────────────────────────────────────────────────────
    const hd = S.header;
    rect(hd.x1, hd.bottom, hd.x2, hd.top);
    for (const y of S.headerRules) hline(y, hd.x1, hd.x2);
    for (const x of S.headerSplits) vline(x, S.headerRules[1], hd.top);
    T('No. Kod Majikan', 37.2, 759.8, 9);
    T('No. MyCoID / No. Pendaftaran Perniagaan', 230.2, 760.1, 9);
    T('Amaun Caruman (RM)', 456.7, 759.6, 9);
    boxes(page, S.kod, LW);
    comb(page, form.employerCode, S.kod, 9, bold, 'left');
    // An absent MyCoID is twenty EMPTY boxes — the agency's own answer to a fact that is not there.
    boxes(page, S.mycoid, LW);
    comb(page, form.mycoid, S.mycoid, 9, bold, 'left');
    // Amaun Caruman is the WHOLE form's total, on every sheet (the agency guide's item 4).
    boxes(page, S.amaunRm, LW);
    boxes(page, S.amaunSen, LW);
    page.drawText('.', { x: S.amaunDot.x, y: S.amaunDot.y, size: 16.75, font, color: ink });
    comb(page, total.rm.replace(/,/g, ''), S.amaunRm, 9, bold, 'right');
    comb(page, total.sen, S.amaunSen, 9, bold, 'right');

    // The deadline sentence, verbatim, and the date `paymentDueDateFor` decides (the 15th of the following
    // month, r408). The agency leaves the rest of the line empty; the date goes there.
    {
      const sentence = 'Amaun caruman di atas hendaklah dibayar kepada PERKESO/EJEN PEMUNGUT tidak lewat daripada';
      T(sentence, 36.7, 731.0, 9);
      T(form.paymentDueDate, 36.7 + bold.widthOfTextAtSize(sentence, 9) + 5, 731.0, 9);
    }

    T('Nama dan Alamat Majikan', 36.7, 720.5, 9);
    vline(S.addressSplit, hd.bottom, S.headerRules[2]);
    vline(S.lembaranSplit, S.agentRules[0], S.headerRules[2]);
    for (const y of S.agentRules) hline(y, S.addressSplit, hd.x2);
    {
      const { x: nx, w: nw, size } = BORANG_8A_NAME_CELL;
      let ay = 706;
      for (const l of borang8ANameLines(form.employerName, bold)) {
        T(l, nx, ay, size);
        ay -= 12;
      }
      for (const l of form.employerAddress) {
        let v = safe(l);
        while (v.length > 1 && font.widthOfTextAtSize(v, 9) > nw) v = v.slice(0, -1);
        page.drawText(v, { x: nx, y: ay, size: 9, font, color: ink });
        ay -= 11;
      }
    }

    // Lembaran n / N and Bil. Pekerja (the whole form's count, every sheet — the guide's item 5).
    T('Lembaran', 427.2, 719.5, 9);
    T('Bil. Pekerja', 507.8, 719.3, 9);
    boxes(page, S.lembaran, LW);
    boxes(page, S.lembaranOf, LW);
    page.drawText('/', { x: S.lembaranSlash.x, y: S.lembaranSlash.y, size: 16.75, font, color: ink });
    comb(page, String(pageData.sheet), S.lembaran, 9, bold, 'right');
    comb(page, String(pageData.of), S.lembaranOf, 9, bold, 'right');
    boxes(page, S.bilPekerja, LW);
    comb(page, String(form.employees), S.bilPekerja, 9, bold, 'right');

    // Kegunaan Ejen Pemungut — the collection agent's, drawn EMPTY.
    T('Kegunaan Ejen Pemungut', 415.0, 690.5, 9);
    T('Cop', 402.0, 675.8, 9);
    T('No. Slip Bayaran', 407.5, 606.0, 9);
    boxes(page, S.slipBayaran, LW);

    // ── The schedule ────────────────────────────────────────────────────────────────────────────────
    const tb = S.table;
    rect(tb.x1, tb.bottom, tb.x2, tb.top);
    hline(S.headBottom, tb.x1, tb.x2);
    for (const x of [C.status, C.ic, C.name, C.amount]) vline(x, S.rows.bottom, tb.top);
    hline(S.amountSplit, C.amount, C.end);
    for (const h of BORANG_8A_HEADINGS) {
      for (const l of h.lines) TC(l.text, h.col.x + h.col.w / 2, l.y, BORANG_8A_HEAD_SIZE);
    }
    page.drawText(BORANG_8A_STATUS_HEAD.text, {
      x: BORANG_8A_STATUS_HEAD.x,
      y: BORANG_8A_STATUS_HEAD.y,
      size: BORANG_8A_HEAD_SIZE,
      font: bold,
      color: ink,
      rotate: degrees(90),
    });
    T('RM', 512.2, 548.6, 7);
    T('SEN', 544.6, 548.6, 7);

    for (let i = 0; i < S.rows.count; i += 1) {
      const foot = S.rows.top - (i + 1) * BORANG_8A_ROW_PITCH;
      if (i < S.rows.count - 1) hline(foot, tb.x1, tb.x2);
      // Every ruled row carries the agency's RM / SEN boxes and its point, filled or not.
      const rm: BoxRun = { x: S.rowRm.x, pitch: S.rowRm.pitch, n: S.rowRm.n, y: foot + S.rowRm.dy, h: S.rowRm.h };
      const sn: BoxRun = { x: S.rowSen.x, pitch: S.rowSen.pitch, n: S.rowSen.n, y: foot + S.rowSen.dy, h: S.rowSen.h };
      boxes(page, rm, LW);
      boxes(page, sn, LW);
      page.drawText('.', { x: S.rowDot.x, y: foot + S.rowDot.dy, size: 16.75, font, color: ink });

      const r = pageData.rows[i];
      if (!r) continue; // an unused line asserts nothing: no digits, no 0.00
      const mid = foot + BORANG_8A_ROW_PITCH / 2;
      // Column (1): MULA above, BERHENTI below — two fixed slots, so a stop date is never read as a start.
      const dateW = C.status - C.date - 6;
      if (r.startDate) page.drawText(safe(r.startDate), { x: C.date + 3, y: mid + 1.6, size: fitSize(r.startDate, dateW, 7, font), font, color: ink });
      if (r.stopDate) page.drawText(safe(r.stopDate), { x: C.date + 3, y: mid - 6.4, size: fitSize(r.stopDate, dateW, 7, font), font, color: ink });
      if (r.status) {
        const sz = fitSize(r.status, C.ic - C.status - 3, 8, bold);
        TC(r.status, (C.status + C.ic) / 2, mid - sz * 0.35, sz);
      }
      page.drawText(safe(r.ic), { x: C.ic + 4, y: mid - 3, size: fitSize(r.ic, C.name - C.ic - 8, 8.5, font), font, color: ink });
      page.drawText(safe(r.name), { x: C.name + 4, y: mid - 3, size: fitSize(r.name, C.amount - C.name - 8, 8.5, font), font, color: ink });
      const { rm: rmText, sen } = splitRmSen(r.contribution);
      comb(page, rmText.replace(/,/g, ''), rm, 9, font, 'right');
      comb(page, sen, sn, 9, font, 'right');
    }
    if (pageData.rows.length === 0) {
      const foot = S.rows.top - BORANG_8A_ROW_PITCH;
      T('Tiada pekerja bagi bulan ini / no employees for this month', C.name + 4, foot + 6, 8, font, muted);
    }

    // Jumlah muka surat ini — THIS sheet's rows, summed from the rows on it (`paginateBorang8A`).
    {
      const pt = splitRmSen(pageData.pageTotal);
      T('Jumlah muka surat ini', 359.3, 141.8, 8);
      boxes(page, S.pageTotalRm, LW);
      boxes(page, S.pageTotalSen, LW);
      page.drawText('.', { x: S.pageTotalDot.x, y: S.pageTotalDot.y, size: 16.75, font, color: ink });
      comb(page, pt.rm.replace(/,/g, ''), S.pageTotalRm, 9, bold, 'right');
      comb(page, pt.sen, S.pageTotalSen, 9, bold, 'right');
    }

    // ── The foot, drawn EMPTY: the operator's to complete, never payroll-derived ────────────────────
    T('Kaedah Pembayaran (Sila tandakan (x))', 336.2, 110.2, 10);
    for (const tk of S.ticks) {
      page.drawRectangle({ x: tk.box.x, y: tk.box.y, width: S.tick, height: S.tick, borderColor: ink, borderWidth: LW });
      T(tk.label, tk.text.x, tk.text.y, 9);
    }
    T('No. Cek / Kiriman Wang', 339.4, 65.0, 9);
    boxes(page, S.noCek, LW);
    T('Tandatangan', 31.2, 96.5, 10);
    T('Nama', 31.9, 76.3, 10);
    T('No. Tel &', 31.7, 62.6, 10);
    T('Cop Majikan', 31.7, 50.6, 10);
    for (const r of S.signRules) hline(r.y, r.x1, r.x2);

    // ── Provenance, below the agency's own content ──────────────────────────────────────────────────
    let by = 33;
    const band = [
      'Susun atur kami sendiri, dilukis kotak demi kotak mengikut Borang 8A PERKESO (muka surat 1) - bukan borang rasmi PERKESO.',
      `Our own drawing of PERKESO's Borang 8A page 1, not the agency's file. Figures are taken from the payroll run, never recalculated. Caruman gaji bulan ${form.contributionMonth} · payroll ${form.payrollPeriodKey}`,
    ];
    for (const paragraph of band) {
      for (const l of wrapTo(paragraph, S.table.x2 - S.table.x1, 6, font)) {
        T(l, S.table.x1, by, 6, font, muted);
        by -= 7.5;
      }
    }
  }

  return doc.save();
}

/** Rule a run of equal boxes. */
function boxes(page: PDFPage, r: BoxRun, lw: number) {
  for (let i = 0; i < r.n; i += 1) {
    page.drawRectangle({ x: r.x + i * r.pitch, y: r.y, width: r.pitch, height: r.h, borderColor: rgb(0, 0, 0), borderWidth: lw });
  }
}

/**
 * One character per box, the agency's way of carrying a code or a figure. `right` fills from the last box
 * (amounts, counts), `left` from the first (codes). A value LONGER than the run is drawn WHOLE, centred
 * across the run at whatever size fits it — never cut, because a truncated code is a different code.
 * An empty value draws nothing at all.
 */
export function comb(page: PDFPage, value: string, r: BoxRun, size: number, f: PDFFont, align: 'left' | 'right') {
  const v = safe(value ?? '').trim();
  if (!v) return;
  const baseline = r.y + (r.h - size * 0.72) / 2;
  if (v.length > r.n) {
    const runW = r.pitch * r.n - 2;
    const sz = fitSize(v, runW, size, f);
    const w = f.widthOfTextAtSize(v, sz);
    page.drawText(v, { x: r.x + (r.pitch * r.n - w) / 2, y: r.y + (r.h - sz * 0.72) / 2, size: sz, font: f, color: rgb(0, 0, 0) });
    return;
  }
  const start = align === 'right' ? r.n - v.length : 0;
  for (const [i, ch] of [...v].entries()) {
    const cx = r.x + (start + i + 0.5) * r.pitch;
    page.drawText(ch, { x: cx - f.widthOfTextAtSize(ch, size) / 2, y: baseline, size, font: f, color: rgb(0, 0, 0) });
  }
}

/** Filename for the download: employer code + contribution month, both safe for a Content-Disposition. */
export function borang8AFilename(form: Borang8AForm, ext: 'pdf' | 'txt'): string {
  const code = (form.employerCode || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  const period = form.contributionPeriodKey.replace('-', '');
  return `borang-8a-${code}-${period}.${ext}`;
}

/** Re-exported so a caller drawing a single sheet does not have to reach into lib/borang-8a. */
export type { Borang8APage };
