/**
 * r412 (item e74af58c, step 2) — draw a Borang 8B, A4 portrait, with pdf-lib: PERKESO's "CARUMAN GAJI
 * TERKURANG BAYAR BULAN" (PER. 44D), the under-paid-contribution twin of the Borang 8A.
 *
 * ── THE 8A'S GEOMETRY, AND WHERE PERKESO'S 8B DIFFERS FROM IT ───────────────────────────────────────
 * PERKESO publishes the blank 8B beside the 8A (same 2013 doPDF artwork, two pages, A4). Measured off its
 * page 1 (`mutool trace`, `pdftotext -bbox`), path for path against the 8A's: 895 painted paths each, and
 * every one of the schedule's — the frames, the twenty rows, the column rules, the RM/SEN boxes, the
 * "Jumlah muka surat ini" boxes, the foot — is the 8A's to within 0.3pt. So `BORANG_8B_SHEET` IS
 * `BORANG_8A_SHEET` (lib/borang-8a-pdf.ts) with the header boxes that moved, each measured:
 *   • the title: "CARUMAN GAJI TERKURANG BAYAR BULAN", 9pt at x 122.9 (the 8A's is 10pt at 195.6), and
 *     the bulan / tahun boxes after it at 329.1 / 361.7 (the 8A's at 318.3 / 351.7);
 *   • the masthead's first line at 14pt (the 8A's 13pt), the rule "(PER. 44D)" (the 8A's 44A);
 *   • the Kod Majikan | MyCoID | Amaun splits at 191.4 / 442.8, the MyCoID run from 205.3, the Amaun boxes
 *     from 456.2, the Lembaran block from 405.3 and its split at 494.8, Bil. Pekerja from 508.7;
 *   • the deadline sentence: "…dibayar kepada PERKESO/EJEN PEMUNGUT yang dilantik" — NO date.
 * Not reproduced, for the 8A's reasons: page 2 (2013 guidance quoting an RM3,000 line), the OCR form ids
 * ("7459249910", "2076249910"), the corner marks and the logo. Fidelity `agency-layout`, never `official`.
 *
 * ── THE EMPLOYEE LINES ARE BLANK, AND NO DIGIT IS EVER DRAWN IN ONE ───────────────────────────────────
 * lib/borang-8b.ts says why: the system holds no underpayment record. The twenty lines are ruled with the
 * agency's RM / SEN boxes and point, and nothing is written in them — no date, status, IC, name or amount,
 * and never "0.00". Nor in "Jumlah muka surat ini", Amaun Caruman, Bil. Pekerja or Lembaran. The header
 * carries what IS known: the employer, the month, and the PERKESO signatory's name and telephone.
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib';
import {
  BORANG_8A_HEADINGS,
  BORANG_8A_HEAD_SIZE,
  BORANG_8A_NAME_CELL,
  BORANG_8A_ROW_PITCH,
  BORANG_8A_SHEET,
  BORANG_8A_STATUS_HEAD,
  borang8ANameLines,
  boxes,
  comb,
  fitSize,
  wrapTo,
  type BoxRun,
} from './borang-8a-pdf';
import type { Borang8BForm } from './borang-8b';

const W = 595.28;
const H = 841.89;

/** The 8A's measured sheet, with the 8B's own header boxes (see the header for each figure's source). */
export const BORANG_8B_SHEET = {
  ...BORANG_8A_SHEET,
  headerSplits: [191.4, 442.8],
  lembaranSplit: 494.8,
  mycoid: { x: 205.3, pitch: 11.51, n: 20, y: 741.5, h: 14.1 } as BoxRun,
  amaunRm: { x: 456.2, pitch: 11.5, n: 6, y: 741.5, h: 14.1 } as BoxRun,
  amaunSen: { x: 531.0, pitch: 11.55, n: 2, y: 741.5, h: 14.1 } as BoxRun,
  amaunDot: { x: 525.8, y: 742.8 },
  bulan: { x: 329.1, pitch: 11.5, n: 2, y: 776.2, h: 14.1 } as BoxRun,
  tahun: { x: 361.7, pitch: 11.525, n: 4, y: 776.2, h: 14.1 } as BoxRun,
  lembaran: { x: 405.3, pitch: 11.5, n: 3, y: 701.2, h: 14.1 } as BoxRun,
  lembaranOf: { x: 451.4, pitch: 11.5, n: 3, y: 701.2, h: 14.1 } as BoxRun,
  lembaranSlash: { x: 443.3, y: 702.5 },
  bilPekerja: { x: 508.7, pitch: 11.525, n: 4, y: 701.2, h: 14.1 } as BoxRun,
} as const;

/** The title and the deadline sentence, verbatim from PERKESO's blank 8B. Exported so tests pin them. */
export const BORANG_8B_TITLE = 'CARUMAN GAJI TERKURANG BAYAR BULAN';
export const BORANG_8B_RULE = 'PERATURAN-PERATURAN (AM) KESELAMATAN SOSIAL PEKERJA 1971 (PER. 44D)';
export const BORANG_8B_SENTENCE = 'Amaun caruman di atas hendaklah dibayar kepada PERKESO/EJEN PEMUNGUT yang dilantik';

const fold = (s: string) =>
  (s ?? '')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...');
const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

export async function renderBorang8BPdf(form: Borang8BForm): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Borang 8B — ${form.employerName} — ${form.contributionMonth}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const S = BORANG_8B_SHEET;
  const C = S.columns;
  const ink = rgb(0, 0, 0);
  const muted = rgb(0.35, 0.35, 0.38);
  const LW = 1;

  const period = /^\d{4}-\d{2}$/.test(form.contributionPeriodKey) ? form.contributionPeriodKey : '';
  const parts = form.contributionMonth.split('/').map((s) => s.trim());
  const bulan = period ? period.slice(5, 7) : (parts[0] ?? '');
  const tahun = period ? period.slice(0, 4) : (parts[1] ?? '');

  // ONE sheet. How many the employer needs is theirs to know (the lines are theirs to fill), so the
  // Lembaran boxes stay empty rather than asserting "1/1".
  const page = doc.addPage([W, H]);
  const T = (s: string, x: number, y: number, size: number, f: PDFFont = bold, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const TC = (s: string, cx: number, y: number, size: number, f: PDFFont = bold) =>
    page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y, size, font: f, color: ink });
  const hline = (y: number, x1: number, x2: number) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: LW, color: ink });
  const vline = (x: number, y1: number, y2: number) =>
    page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: LW, color: ink });
  const rect = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, borderColor: ink, borderWidth: LW });

  // ── Masthead ──────────────────────────────────────────────────────────────────────────────────────
  TC('PERTUBUHAN KESELAMATAN SOSIAL', (184.3 + 445.7) / 2, 803.0, 14);
  TC(BORANG_8B_RULE, (154.6 + 520.4) / 2, 791.5, 9);
  T(BORANG_8B_TITLE, 122.9, 779.3, 9);
  boxes(page, S.bulan, LW);
  boxes(page, S.tahun, LW);
  comb(page, bulan, S.bulan, 10, bold, 'right');
  comb(page, tahun, S.tahun, 10, bold, 'right');
  T('bulan', 330.5, 769.4, 8);
  T('tahun', 375.8, 769.4, 8);
  T('BORANG 8B', 486.0, 775.7, 12);

  // ── Header block ──────────────────────────────────────────────────────────────────────────────────
  const hd = S.header;
  rect(hd.x1, hd.bottom, hd.x2, hd.top);
  for (const y of S.headerRules) hline(y, hd.x1, hd.x2);
  for (const x of S.headerSplits) vline(x, S.headerRules[1], hd.top);
  T('No. Kod Majikan', 37.2, 759.6, 9);
  T('No. MyCoID / No. Pendaftaran Perniagaan', 230.4, 759.8, 9);
  T('Amaun Caruman (RM)', 457.2, 759.6, 9);
  boxes(page, S.kod, LW);
  comb(page, form.employerCode, S.kod, 9, bold, 'left');
  boxes(page, S.mycoid, LW);
  comb(page, form.mycoid, S.mycoid, 9, bold, 'left');
  // Amaun Caruman: the boxes, EMPTY. The amount owed is not in the records (lib/borang-8b.ts).
  boxes(page, S.amaunRm, LW);
  boxes(page, S.amaunSen, LW);
  page.drawText('.', { x: S.amaunDot.x, y: S.amaunDot.y, size: 16.75, font, color: ink });

  // The agency's sentence, verbatim, and NO date after it: the 8B names no deadline.
  T(BORANG_8B_SENTENCE, 36.7, 730.8, 9);

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

  // Lembaran and Bil. Pekerja: the boxes, EMPTY (see above).
  T('Lembaran', 418.1, 718.6, 9);
  T('Bil. Pekerja', 507.8, 719.0, 9);
  boxes(page, S.lembaran, LW);
  boxes(page, S.lembaranOf, LW);
  page.drawText('/', { x: S.lembaranSlash.x, y: S.lembaranSlash.y, size: 16.75, font, color: ink });
  boxes(page, S.bilPekerja, LW);

  // Kegunaan Ejen Pemungut — the collection agent's, EMPTY.
  T('Kegunaan Ejen Pemungut', 415.0, 690.5, 9);
  T('Cop', 402.0, 675.8, 9);
  T('No. Slip Bayaran', 407.5, 606.0, 9);
  boxes(page, S.slipBayaran, LW);

  // ── The schedule: twenty ruled lines, every one EMPTY ─────────────────────────────────────────────
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
    boxes(page, { x: S.rowRm.x, pitch: S.rowRm.pitch, n: S.rowRm.n, y: foot + S.rowRm.dy, h: S.rowRm.h }, LW);
    boxes(page, { x: S.rowSen.x, pitch: S.rowSen.pitch, n: S.rowSen.n, y: foot + S.rowSen.dy, h: S.rowSen.h }, LW);
    page.drawText('.', { x: S.rowDot.x, y: foot + S.rowDot.dy, size: 16.75, font, color: ink });
  }

  // Jumlah muka surat ini — the boxes, EMPTY.
  T('Jumlah muka surat ini', 359.3, 141.8, 8);
  boxes(page, S.pageTotalRm, LW);
  boxes(page, S.pageTotalSen, LW);
  page.drawText('.', { x: S.pageTotalDot.x, y: S.pageTotalDot.y, size: 16.75, font, color: ink });

  // ── The foot ──────────────────────────────────────────────────────────────────────────────────────
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
  // The PERKESO signatory's name and telephone, when the company's record holds them. Shrunk to fit,
  // never cut (a truncated name is a different name). Tandatangan and Cop stay the employer's.
  {
    const nameRule = S.signRules[1];
    const w = nameRule.x2 - nameRule.x1 - 4;
    if (form.signatoryName.trim()) {
      const v = safe(form.signatoryName.trim());
      page.drawText(v, { x: nameRule.x1 + 2, y: nameRule.y + 2.2, size: fitSize(v, w, 9, font), font, color: ink });
    }
    if (form.signatoryPhone.trim()) {
      const v = safe(form.signatoryPhone.trim());
      page.drawText(v, { x: nameRule.x1 + 2, y: 62.6, size: fitSize(v, w, 9, font), font, color: ink });
    }
  }

  // ── Provenance, below the agency's own content ────────────────────────────────────────────────────
  let by = 33;
  for (const paragraph of [
    'Susun atur kami sendiri, dilukis kotak demi kotak mengikut Borang 8B PERKESO (muka surat 1) - bukan borang rasmi PERKESO.',
    `Our own drawing of PERKESO's Borang 8B page 1, not the agency's file. The employee lines and amounts are left blank: the payroll holds no underpayment record. Caruman gaji terkurang bayar bulan ${form.contributionMonth}`,
  ]) {
    for (const l of wrapTo(paragraph, S.table.x2 - S.table.x1, 6, font)) {
      T(l, S.table.x1, by, 6, font, muted);
      by -= 7.5;
    }
  }

  return doc.save();
}

/** Filename: employer code + the underpaid month. */
export function borang8BFilename(form: Borang8BForm): string {
  const code = (form.employerCode || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  const period = form.contributionPeriodKey.replace('-', '');
  return `borang-8b-${code}-${period}.pdf`;
}
