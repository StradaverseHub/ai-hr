/**
 * 8ca344bf — draw a Borang 8A, A4 portrait, with pdf-lib (pure JS, no WASM/native, so no Next bundler
 * friction). Mirrors lib/ea-pdf.ts, which is the house pattern for a form we draw from scratch.
 *
 * ⚠️ THIS IS NOT PERKESO ARTWORK, AND THE PAGE SAYS SO. The reporter's specimen is a FILLED output from
 * another payroll vendor's engine (DevExpress), not an agency page, and PERKESO publishes no blank Borang
 * 8A to print onto — so there is nothing to overlay and every rule, box and heading below is drawn. The
 * layout matches the specimen line for line: the numbered columns (1) date · (2) status · (3) IC ·
 * (4) name · (5) Caruman split into RM and SEN cells, the CARUMAN GAJI BULAN / Kod Majikan / Amaun Caruman
 * header, the "tidak lewat daripada" deadline line, and the Lembaran n/N with a per-sheet total. A footer
 * band states the provenance in both languages, because a page that looks like a government form and is
 * not one is the single failure the whole statutory-forms fidelity vocabulary exists to prevent.
 *
 * DRAWN EMPTY, ON PURPOSE: Kaedah Pembayaran, No. Cek / Kiriman Wang, Tandatangan, No. Tel & Cop Majikan
 * and the whole Kegunaan Ejen Pemungut block. Those are manual and are never payroll-derived; the
 * specimen leaves every one of them blank too. Pre-filling a payment method or stamping a signature box
 * would be inventing a fact about a filing.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { money, splitRmSen, type Borang8AForm, type Borang8APage } from './borang-8a';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;
const M = 34;

/** Column x-offsets, left edge, measured to match the specimen's proportions on A4. */
const COL = {
  start: M,
  stop: M + 62,
  status: M + 124,
  ic: M + 190,
  name: M + 288,
  rm: W - M - 96,
  sen: W - M - 30,
};
const RIGHT = W - M;
const ROW_H = 16;

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

  // Helvetica is WinAnsi (Latin-1); a Tamil or Chinese legal name would degrade to '?'. Same documented,
  // tracked limitation lib/ea-pdf.ts carries (a Unicode embed is the deferred follow-up), and the same
  // deliberate substitution rather than a silent drop.
  const safe = (s: string) => (s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  for (const pageData of form.pages) {
    const page = doc.addPage([W, H]);
    let y = H - M;

    const text = (s: string, x: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x, y, size, font: f, color });
    const textR = (s: string, xr: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });
    /** Clip to a width so a long legal name can never run into the next column. */
    const textClip = (s: string, x: number, maxW: number, size: number, f = font, color = ink) => {
      let v = safe(s);
      while (v.length > 1 && f.widthOfTextAtSize(v, size) > maxW) v = v.slice(0, -1);
      page.drawText(v, { x, y, size, font: f, color });
    };
    const line = (yy: number, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x: M, y: yy }, end: { x: RIGHT, y: yy }, thickness, color });
    const box = (x: number, yy: number, w: number, h: number) =>
      page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: rule, borderWidth: 0.7 });

    // ── Masthead ────────────────────────────────────────────────────────────────────────────────
    text('PERTUBUHAN KESELAMATAN SOSIAL', M, 10, bold);
    textR('BORANG 8A', RIGHT, 16, bold);
    y -= 13;
    text('SOCIAL SECURITY ORGANISATION (PERKESO)', M, 8, font, muted);
    textR('Penyata Caruman Bulanan', RIGHT, 8.5, font, muted);
    y -= 12;
    line(y, 1.1);
    y -= 16;

    // ── Employer block ──────────────────────────────────────────────────────────────────────────
    const label = (l: string, v: string, x: number) => {
      page.drawText(safe(l), { x, y, size: 7.5, font, color: muted });
      page.drawText(safe(v), { x, y: y - 11, size: 10, font: bold, color: ink });
    };
    label('No. Kod Majikan', form.employerCode, M);
    label('MyCoID / No. Pendaftaran', form.mycoid || '—', M + 170);
    label('Caruman Gaji Bulan', form.contributionMonth, M + 340);
    label('Amaun Caruman (RM)', money(form.total), RIGHT - 110);
    y -= 30;

    text('Nama dan Alamat Majikan', M, 7.5, font, muted);
    y -= 11;
    text(form.employerName, M, 10, bold);
    y -= 11;
    for (const l of form.employerAddress) {
      text(l, M, 8.5, font, muted);
      y -= 10;
    }
    y -= 2;
    // The deadline the specimen prints on the form itself — the LAST DAY of the contribution month, which
    // is not the ASSIST 15th-of-next-month and not KWSP's rule either.
    text(`Bayaran hendaklah dibuat tidak lewat daripada ${form.paymentDueDate}`, M, 9, bold);
    y -= 14;
    textR(`Lembaran ${pageData.sheet}/${pageData.of}   ·   Bil. Pekerja ${form.employees}`, RIGHT, 8.5, font, muted);
    y -= 6;
    line(y, 1.1);
    y -= 14;

    // ── Column headings ─────────────────────────────────────────────────────────────────────────
    text('(1) Tarikh Mula', COL.start, 7, bold, muted);
    text('(1) Tarikh Berhenti', COL.stop, 7, bold, muted);
    text('(2) Status', COL.status, 7, bold, muted);
    text('(3) No. K/P', COL.ic, 7, bold, muted);
    text('(4) Nama Pekerja', COL.name, 7, bold, muted);
    text('(5) Caruman  RM', COL.rm, 7, bold, muted);
    text('SEN', COL.sen, 7, bold, muted);
    y -= 9;
    text('Kerja (hhbbtttt)', COL.start, 6.5, font, muted);
    text('Kerja (hhbbtttt)', COL.stop, 6.5, font, muted);
    y -= 6;
    line(y, 0.9);
    y -= 13;

    // ── Rows ────────────────────────────────────────────────────────────────────────────────────
    for (const r of pageData.rows) {
      const { rm, sen } = splitRmSen(r.contribution);
      text(r.startDate, COL.start, 8.5);
      text(r.stopDate, COL.stop, 8.5);
      textClip(r.status, COL.status, COL.ic - COL.status - 6, 8.5);
      text(r.ic, COL.ic, 8.5);
      textClip(r.name, COL.name, COL.rm - COL.name - 8, 8.5);
      textR(rm, COL.sen - 8, 8.5);
      text(sen, COL.sen, 8.5);
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
      y -= ROW_H - 4;
    }
    if (pageData.rows.length === 0) {
      text('Tiada pekerja bagi bulan ini / no employees for this month', M, 8.5, font, muted);
      y -= ROW_H;
    }

    // ── Page total ──────────────────────────────────────────────────────────────────────────────
    y -= 4;
    line(y, 0.9);
    y -= 14;
    {
      const { rm, sen } = splitRmSen(pageData.pageTotal);
      text('Jumlah muka surat ini', COL.name, 9, bold);
      textR(rm, COL.sen - 8, 9, bold);
      text(sen, COL.sen, 9, bold);
    }
    y -= 8;
    line(y, 1.1);
    y -= 16;

    // The whole-form total, on the LAST sheet only: repeating it on every sheet is how a multi-page
    // schedule gets filed with the grand total mistaken for a page total.
    if (pageData.sheet === pageData.of) {
      const { rm, sen } = splitRmSen(form.total);
      text('AMAUN CARUMAN (jumlah keseluruhan)', COL.status, 9.5, bold);
      textR(rm, COL.sen - 8, 9.5, bold);
      text(sen, COL.sen, 9.5, bold);
      y -= 18;
    }

    // ── Manual blocks, drawn EMPTY ──────────────────────────────────────────────────────────────
    const blockTop = Math.max(y, M + 132);
    y = blockTop;
    text('Kaedah Pembayaran', M, 7.5, font, muted);
    y -= 12;
    for (const [i, opt] of ['Tunai', 'Cek', 'Kiriman Wang', 'Lain-lain'].entries()) {
      const x = M + i * 92;
      box(x, y - 1, 9, 9);
      page.drawText(safe(opt), { x: x + 13, y: y + 1, size: 7.5, font, color: muted });
    }
    y -= 20;
    text('No. Cek / Kiriman Wang', M, 7.5, font, muted);
    box(M + 110, y - 4, 180, 16);
    y -= 30;
    text('Tandatangan & Cop Majikan', M, 7.5, font, muted);
    box(M, y - 44, 250, 44);
    text('No. Tel Majikan', M + 268, 7.5, font, muted);
    box(M + 268, y - 20, 160, 20);
    text('Kegunaan Ejen Pemungut', RIGHT - 130, 7.5, font, muted);
    box(RIGHT - 130, y - 44, 130, 44);
    y -= 56;

    // ── Provenance band ─────────────────────────────────────────────────────────────────────────
    y = M + 22;
    line(y + 12, 0.7, hair);
    text(
      'Susun atur kami sendiri, dilukis mengikut Borang 8A — bukan borang rasmi PERKESO.',
      M,
      6.8,
      font,
      muted,
    );
    y -= 9;
    text(
      'Our own layout, drawn to match Borang 8A. PERKESO publishes no blank form to print onto, so this is ' +
        'not the agency’s own page. Figures are taken from the payroll run, never recalculated.',
      M,
      6.8,
      font,
      muted,
    );
    y -= 9;
    text(`Caruman gaji bulan ${form.contributionMonth} · payroll ${form.payrollPeriodKey}`, M, 6.8, font, muted);
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
