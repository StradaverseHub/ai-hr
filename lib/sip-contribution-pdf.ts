/**
 * r412 (item e74af58c, step 2) — draw the EIS (SIP) monthly contribution schedule, A4 portrait, with
 * pdf-lib. The model and every rule are in lib/sip-contribution.ts; this file only draws.
 *
 * ── THE LAYOUT IS THE REPORTER'S SAMPLE'S, AND NOTHING MORE ───────────────────────────────────────────
 * The sample (board item e74af58c, "SIP Contribution Sample") is a one-sheet report printed from another
 * payroll system on US Letter. Read for its LAYOUT only — its names and identity card numbers are a real
 * company's and are not in this repository. What it has, and what is drawn here in the same order:
 *   • a two-line masthead, "PERTUBUHAN KESELAMATAN SOSIAL" over "JADUAL CARUMAN BAGI SISTEM INSURANS
 *     PEKERJAAN (SIP)" (its logo is NOT reproduced: a page of ours carrying PERKESO's mark would read as
 *     PERKESO's page);
 *   • a two-row employer block, NAMA MAJIKAN* and KOD MAJIKAN*;
 *   • one table, BIL · KOD MAJIKAN* · NO. KAD PENGENALAN* · NAMA PEKERJA* (Mengikut Kad Pengenalan) ·
 *     BULAN CARUM* · JUMLAH CARUMAN*, BIL right-aligned, the employer code repeated on every row;
 *   • a "Total :" cell under the last two columns.
 * What it does NOT have, and is therefore NOT drawn: a declaration, a signature, a stamp, a date. The
 * approved plan says so in as many words. The only additions are the two the build notes require of a
 * schedule that can run to several sheets: "Jumlah muka surat ini" on every sheet and "Lembaran n/N".
 * The column proportions follow the sample's on A4 (its 612pt Letter width maps to within a point).
 *
 * ── AN EMPTY LINE ASSERTS NOTHING ─────────────────────────────────────────────────────────────────────
 * Only lines that carry a person are ruled; there are no empty ruled lines with "0.00" in them, and the
 * loader refuses to draw a schedule with nobody on it at all.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { money } from './borang-8a';
import { fitSize, wrapTo } from './borang-8a-pdf';
import { SIP_ROWS_PER_PAGE, type SipForm } from './sip-contribution';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;

/**
 * THE GEOMETRY, in PDF points (origin bottom-left). Column edges follow the sample's proportions; the row
 * pitch is ours, sized so `SIP_ROWS_PER_PAGE` lines fit between the heading band and the totals.
 * Exported so the tests measure the drawn page against it.
 */
export const SIP_SHEET = {
  margin: 28,
  masthead: { x: 28, y1: 806, y2: 792, size: 10 },
  lembaran: { xRight: 567, y: 806, size: 9 },
  /** NAMA MAJIKAN / KOD MAJIKAN: two rows, a label cell and a value cell. */
  employer: { x1: 70, split: 218, x2: 509, top: 762, rowH: 16 },
  /** The schedule's column edges, left to right. */
  columns: { bil: 28, kod: 52, ic: 150, name: 228, bulan: 413, jumlah: 483, end: 567 },
  head: { top: 712, h: 31 },
  rowH: 16,
  headSize: 7.5,
  cellSize: 8,
} as const;

/** The sheet's lines: exactly the pagination's, or the drawing would run off the page. */
export const SIP_RULED_ROWS = SIP_ROWS_PER_PAGE;
/** The y of the foot of the last possible line — the totals sit below it. */
export const SIP_ROWS_BOTTOM = SIP_SHEET.head.top - SIP_SHEET.head.h - SIP_RULED_ROWS * SIP_SHEET.rowH;
if (SIP_ROWS_BOTTOM - 2 * SIP_SHEET.rowH < 60) {
  // A module-load failure rather than a page whose totals print over the provenance line.
  throw new Error('SIP schedule: rows per page do not fit the sheet');
}

/** The heading band, in the sample's own words and lines. Exported so every line is measured to fit. */
const C = SIP_SHEET.columns;
export const SIP_HEADINGS: { key: string; x1: number; x2: number; lines: string[] }[] = [
  { key: 'bil', x1: C.bil, x2: C.kod, lines: ['BIL'] },
  { key: 'kod', x1: C.kod, x2: C.ic, lines: ['KOD MAJIKAN*'] },
  { key: 'ic', x1: C.ic, x2: C.name, lines: ['NO. KAD', 'PENGENALAN*'] },
  { key: 'name', x1: C.name, x2: C.bulan, lines: ['NAMA PEKERJA*', '(Mengikut Kad Pengenalan)'] },
  { key: 'bulan', x1: C.bulan, x2: C.jumlah, lines: ['BULAN CARUM*'] },
  { key: 'jumlah', x1: C.jumlah, x2: C.end, lines: ['JUMLAH', 'CARUMAN*'] },
];

/** WinAnsi-safe text: typography folded, anything else outside Latin-1 as '?' (the 8A's documented rule). */
const safe = (s: string) =>
  (s ?? '')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

export async function renderSipContributionPdf(form: SipForm): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Jadual Caruman SIP — ${form.employerName} — ${form.contributionMonth}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const S = SIP_SHEET;
  const ink = rgb(0, 0, 0);
  const muted = rgb(0.35, 0.35, 0.38);
  const LW = 0.75;

  const last = form.pages.length - 1;
  for (const [pi, pageData] of form.pages.entries()) {
    const page = doc.addPage([W, H]);
    const T = (s: string, x: number, y: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x, y, size, font: f, color });
    /** Text inside a cell [x1, x2], shrunk to fit (never cut), aligned left / right / centre. */
    const cell = (s: string, x1: number, x2: number, y: number, size: number, f: PDFFont, align: 'l' | 'r' | 'c') => {
      const v = safe(s);
      if (!v) return;
      const sz = fitSize(v, x2 - x1 - 6, size, f);
      const w = f.widthOfTextAtSize(v, sz);
      const x = align === 'l' ? x1 + 3 : align === 'r' ? x2 - 3 - w : (x1 + x2 - w) / 2;
      page.drawText(v, { x, y, size: sz, font: f, color: ink });
    };
    const rect = (x1: number, y1: number, x2: number, y2: number) =>
      page.drawRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, borderColor: ink, borderWidth: LW });
    const vline = (x: number, y1: number, y2: number) =>
      page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: LW, color: ink });

    // ── Masthead (no logo — see the header) and Lembaran n/N ─────────────────────────────────────────
    T('PERTUBUHAN KESELAMATAN SOSIAL', S.masthead.x, S.masthead.y1, S.masthead.size, bold);
    T('JADUAL CARUMAN BAGI SISTEM INSURANS PEKERJAAN (SIP)', S.masthead.x, S.masthead.y2, S.masthead.size, bold);
    {
      const l = `Lembaran ${pageData.sheet}/${pageData.of}`;
      T(l, S.lembaran.xRight - bold.widthOfTextAtSize(l, S.lembaran.size), S.lembaran.y, S.lembaran.size, bold);
    }

    // ── Employer block: NAMA MAJIKAN / KOD MAJIKAN ───────────────────────────────────────────────────
    const E = S.employer;
    for (const [i, [label, value]] of ([
      ['NAMA MAJIKAN*', form.employerName],
      ['KOD MAJIKAN*', form.employerCode],
    ] as const).entries()) {
      const top = E.top - i * E.rowH;
      rect(E.x1, top - E.rowH, E.x2, top);
      vline(E.split, top - E.rowH, top);
      cell(label, E.x1, E.split, top - E.rowH + 4.5, S.cellSize, font, 'l');
      cell(value, E.split, E.x2, top - E.rowH + 4.5, S.cellSize, font, 'l');
    }

    // ── Heading band ─────────────────────────────────────────────────────────────────────────────────
    const headBottom = S.head.top - S.head.h;
    rect(C.bil, headBottom, C.end, S.head.top);
    for (const h of SIP_HEADINGS) {
      if (h.x1 !== C.bil) vline(h.x1, headBottom, S.head.top);
      const lh = S.headSize + 2;
      const blockTop = (S.head.top + headBottom) / 2 + (h.lines.length * lh) / 2;
      h.lines.forEach((l, i) => cell(l, h.x1, h.x2, blockTop - (i + 1) * lh + 2, S.headSize, font, 'c'));
    }

    // ── The lines that carry a person, and only those ────────────────────────────────────────────────
    let y = headBottom;
    for (const [i, r] of pageData.rows.entries()) {
      const top = y;
      y -= S.rowH;
      rect(C.bil, y, C.end, top);
      for (const x of [C.kod, C.ic, C.name, C.bulan, C.jumlah]) vline(x, y, top);
      const base = y + 4.5;
      cell(String(pageData.firstBil + i), C.bil, C.kod, base, S.cellSize, font, 'r');
      cell(r.employerCode, C.kod, C.ic, base, S.cellSize, font, 'l');
      cell(r.ic, C.ic, C.name, base, S.cellSize, font, 'l');
      cell(r.name, C.name, C.bulan, base, S.cellSize, font, 'l');
      cell(r.contributionMonth, C.bulan, C.jumlah, base, S.cellSize, font, 'r');
      cell(money(r.contribution), C.jumlah, C.end, base, S.cellSize, font, 'r');
    }

    // ── Jumlah muka surat ini (every sheet) and Total (the last sheet), under the last two columns ──
    const totalRow = (label: string, amount: number) => {
      const top = y;
      y -= S.rowH;
      rect(C.name, y, C.end, top);
      vline(C.jumlah, y, top);
      cell(label, C.name, C.jumlah, y + 4.5, S.cellSize, bold, 'r');
      cell(money(amount), C.jumlah, C.end, y + 4.5, S.cellSize, bold, 'r');
    };
    totalRow(`Jumlah muka surat ini (Lembaran ${pageData.sheet}/${pageData.of}) :`, pageData.pageTotal);
    if (pi === last) totalRow('Total :', form.total);

    // ── Provenance, below the content ────────────────────────────────────────────────────────────────
    let by = 40;
    for (const paragraph of [
      'Susun atur kami sendiri bagi jadual caruman SIP - bukan borang rasmi PERKESO.',
      `Our own layout of an EIS (SIP) contribution schedule, not a PERKESO form. Figures are the EIS employer and employee shares taken from the payroll run, never recalculated. Bulan carum ${form.contributionMonth} · payroll ${form.payrollPeriodKey}`,
    ]) {
      for (const l of wrapTo(paragraph, C.end - C.bil, 6, font)) {
        T(l, C.bil, by, 6, font, muted);
        by -= 7.5;
      }
    }
  }

  return doc.save();
}

/** Filename: employer code + contribution month, both safe for a Content-Disposition. */
export function sipContributionFilename(form: SipForm): string {
  const code = (form.employerCode || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  const period = form.contributionPeriodKey.replace('-', '');
  return `sip-caruman-${code}-${period}.pdf`;
}

