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

/**
 * Column x-offsets (left edge), measured to match the specimen's proportions on A4.
 *
 * ⚠️ THESE ARE MEASURED AGAINST THE HEADINGS, NOT GUESSED. The first version put `stop` at M+62 and
 * `status` at M+124, and rendering it showed "(1) Tarikh Berhenti(2) Status" printed as one run — the
 * heading was wider than its column and there is no clipping on a heading. Every gap below is wider than
 * the bold 7pt heading that sits in it; the headings were also shortened so they can be.
 */
const COL = {
  start: M,
  stop: M + 66,
  status: M + 132,
  ic: M + 194,
  name: M + 266,
  rm: W - M - 96,
  sen: W - M - 30,
};
const RIGHT = W - M;
const ROW_H = 16;
/**
 * The manual blocks are anchored to the FOOT of the page, not floated under the last row. A sheet with
 * two employees and a sheet with twenty then put the signature box in the same place, which is what makes
 * a stack of them signable without hunting — and it is what the specimen does.
 */
const MANUAL_BAND_TOP = M + 185;

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
    // Shortened from the specimen's full wording so each fits inside its own column. A heading is not
    // clipped, so one that overflows prints straight into its neighbour — which is exactly what
    // "(1) Tarikh Berhenti(2) Status" was before the layout was measured.
    text('(1) Mula Kerja', COL.start, 7, bold, muted);
    text('(1) Berhenti Kerja', COL.stop, 7, bold, muted);
    text('(2) Status', COL.status, 7, bold, muted);
    text('(3) No. K/P', COL.ic, 7, bold, muted);
    text('(4) Nama Pekerja', COL.name, 7, bold, muted);
    text('(5) Caruman  RM', COL.rm, 7, bold, muted);
    text('SEN', COL.sen, 7, bold, muted);
    y -= 9;
    text('(hhbbtttt)', COL.start, 6.5, font, muted);
    text('(hhbbtttt)', COL.stop, 6.5, font, muted);
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

    // ── Manual blocks, drawn EMPTY, anchored to the foot of the page ────────────────────────────
    // Every box below is left blank on purpose: Kaedah Pembayaran, No. Cek / Kiriman Wang, Tandatangan,
    // No. Tel & Cop Majikan and Kegunaan Ejen Pemungut are the operator's and the collecting agent's,
    // never payroll-derived. The specimen leaves every one of them blank too. Pre-filling a payment
    // method or stamping a signature box would be inventing a fact about a filing.
    //
    // The three boxes on the last row do NOT overlap, and that is measured rather than assumed: the first
    // draft put the telephone box at M+268 w=160 (ending at 462) and the agent box at RIGHT-130 (431),
    // so they printed through each other. Found by rasterising the page and looking at it.
    y = MANUAL_BAND_TOP;
    text('Kaedah Pembayaran', M, 7.5, font, muted);
    y -= 13;
    for (const [i, opt] of ['Tunai', 'Cek', 'Kiriman Wang', 'Lain-lain'].entries()) {
      const x = M + i * 100;
      box(x, y - 1, 9, 9);
      page.drawText(safe(opt), { x: x + 13, y: y + 1, size: 7.5, font, color: muted });
    }
    y -= 24;
    text('No. Cek / Kiriman Wang', M, 7.5, font, muted);
    box(M + 112, y - 4, 200, 16);
    y -= 34;
    text('Tandatangan & Cop Majikan', M, 7.5, font, muted);
    text('No. Tel Majikan', M + 252, 7.5, font, muted);
    text('Kegunaan Ejen Pemungut', M + 387, 7.5, font, muted);
    y -= 4;
    box(M, y - 46, 240, 46); // 34 → 274
    box(M + 252, y - 46, 120, 46); // 286 → 406
    box(M + 387, y - 46, 140, 46); // 421 → 561

    // ── Provenance band ─────────────────────────────────────────────────────────────────────────
    // WRAPPED, not one long line. The English sentence is wider than A4 and the first draft ran it off
    // the right edge — "never recalcula" was the last thing on the page.
    y = M + 40;
    line(y + 12, 0.7, hair);
    const wrap = (s: string, size: number) => {
      const maxW = RIGHT - M;
      const out: string[] = [];
      let cur = '';
      for (const w of safe(s).split(/\s+/)) {
        const trial = cur ? `${cur} ${w}` : w;
        if (font.widthOfTextAtSize(trial, size) > maxW && cur) {
          out.push(cur);
          cur = w;
        } else {
          cur = trial;
        }
      }
      if (cur) out.push(cur);
      return out;
    };
    const band = [
      'Susun atur kami sendiri, dilukis mengikut Borang 8A — bukan borang rasmi PERKESO.',
      'Our own layout, drawn to match Borang 8A. PERKESO publishes no blank form to print onto, so this is ' +
        'not the agency’s own page. Figures are taken from the payroll run, never recalculated.',
      `Caruman gaji bulan ${form.contributionMonth} · payroll ${form.payrollPeriodKey}`,
    ];
    for (const paragraph of band) {
      for (const l of wrap(paragraph, 6.8)) {
        text(l, M, 6.8, font, muted);
        y -= 9;
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
