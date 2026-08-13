/**
 * 9c8dad7a — draw a Borang A, A4 portrait, with pdf-lib (pure JS, no WASM/native, so no Next bundler
 * friction). Mirrors lib/ea-pdf.ts and lib/borang-8a-pdf.ts, which are the house pattern for a form we
 * draw from scratch.
 *
 * ⚠️ THIS IS NOT KWSP ARTWORK, AND THE PAGE SAYS SO. The reporter's specimen is a FILLED output from
 * another payroll vendor's engine (DevExpress v23.2.5), not an agency page, and KWSP publishes no blank
 * Borang A to print onto — so there is nothing to overlay and every rule, box and heading below is drawn.
 * The layout matches the specimen: the No. Rujukan Majikan / Bulan Caruman / Amaun Caruman header strip,
 * Nama dan Alamat Majikan, Tarikh DiCetak and Bil Pekerja, the numbered employee rows (Bil · No. Ahli ·
 * No. Kad Pengenalan · Nama Pekerja · Upah · Caruman Majikan · Caruman Pekerja), the carried-forward
 * totals, JUMLAH (RM) on the last page, and the authorised-representative block at the foot.
 *
 * ── PAGINATION IS THE PART THAT GOES WRONG SILENTLY ───────────────────────────────────────────────
 * The employer header repeats on every sheet. Sheet 2 onward opens with "Jumlah yang dibawa dari
 * mukasurat terdahulu" and every sheet but the last closes with "Jumlah yang dibawa ke mukasurat
 * seterusnya"; the last closes with JUMLAH (RM). Those carry rows print the CONTRIBUTION COLUMNS ONLY —
 * the specimen leaves Upah blank on both — and the arithmetic that makes them add up lives in
 * `paginateBorangA`, where it is asserted at one, two and three pages without a PDF in sight.
 *
 * DRAWN EMPTY, ON PURPOSE: No. Rujukan Borang A, the payment-method ticks, the representative's own
 * Tarikh, the signature, and the whole Cop Agen Kutipan block. Those are manual and never
 * payroll-derived; the specimen leaves every one of them blank too. Pre-filling a payment method or
 * stamping a signature box would be inventing a fact about a filing.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { money, type BorangAForm } from './borang-a';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;
const M = 34;
const RIGHT = W - M;

/**
 * Column geometry, measured against the HEADINGS rather than guessed — the r193 Borang 8A lesson: a
 * heading is not clipped, so one wider than its column prints straight into its neighbour. Every gap
 * below is wider than the 7pt bold heading that sits in it. The three money columns are RIGHT-aligned,
 * headings included, so a heading can only ever grow leftwards into its own column's whitespace.
 */
const COL = {
  bil: M,
  member: M + 26,
  ic: M + 100,
  name: M + 182,
  wageR: W - M - 156,
  employerR: W - M - 80,
  employeeR: W - M,
};
const ROW_H = 14;
/** The representative band is anchored to the FOOT of the last sheet, not floated under the last row. */
const REP_BAND_TOP = M + 126;

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
   * lib/ea-pdf.ts and lib/borang-8a-pdf.ts carry, with a Unicode font embed as the deferred follow-up.
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
    const last = pageData.sheet === pageData.of;
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
    text('KUMPULAN WANG SIMPANAN PEKERJA', M, 10, bold);
    textR('BORANG A', RIGHT, 16, bold);
    y -= 13;
    text('EMPLOYEES PROVIDENT FUND (KWSP)', M, 8, font, muted);
    textR('Penyata Caruman Bulanan', RIGHT, 8.5, font, muted);
    y -= 12;
    line(y, 1.1);
    y -= 16;

    // ── Employer block ──────────────────────────────────────────────────────────────────────────
    const label = (l: string, v: string, x: number) => {
      page.drawText(safe(l), { x, y, size: 7.5, font, color: muted });
      page.drawText(safe(v), { x, y: y - 11, size: 10, font: bold, color: ink });
    };
    label('No. Rujukan Majikan', form.employerRef || '—', M);
    // MMYY, exactly as the specimen's own box shows it (0826), with the readable form beside it.
    label('Bulan Caruman', `${form.contributionMonthCode}   (${form.contributionMonth})`, M + 150);
    label('Bil Pekerja', String(form.employees), M + 330);
    label('Amaun Caruman (RM)', money(form.totalContribution), RIGHT - 110);
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
    // Note 6 on the agency's own form. Printed here because it is the single fact most likely to be
    // "corrected" by somebody comparing this page with a Borang 8A, whose rule is the opposite.
    text(
      `Bulan caruman bersamaan Bulan Upah + 1  ·  Bulan Upah ${form.payrollPeriodKey}  ·  Tarikh DiCetak ${form.printedOn}`,
      M,
      8,
      font,
      muted,
    );
    y -= 12;
    textR(`Mukasurat ${pageData.sheet}/${pageData.of}`, RIGHT, 8.5, font, muted);
    y -= 6;
    line(y, 1.1);
    y -= 14;

    // ── Column headings ─────────────────────────────────────────────────────────────────────────
    text('Bil', COL.bil, 7, bold, muted);
    text('No. Ahli', COL.member, 7, bold, muted);
    text('No. Kad Pengenalan', COL.ic, 7, bold, muted);
    text('Nama Pekerja', COL.name, 7, bold, muted);
    textR('Upah (RM)', COL.wageR, 7, bold, muted);
    textR('Caruman Majikan', COL.employerR, 7, bold, muted);
    textR('Caruman Pekerja', COL.employeeR, 7, bold, muted);
    y -= 6;
    line(y, 0.9);
    y -= 12;

    // ── Carry-in ────────────────────────────────────────────────────────────────────────────────
    // Contribution columns ONLY. The specimen leaves Upah blank on this row, and the running totals come
    // from `paginateBorangA` rather than being re-added here — one arithmetic, asserted without a PDF.
    if (pageData.sheet > 1) {
      text('Jumlah yang dibawa dari mukasurat terdahulu', COL.member, 8, bold);
      textR(money(pageData.carryInEmployer), COL.employerR, 8, bold);
      textR(money(pageData.carryInEmployee), COL.employeeR, 8, bold);
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
      y -= ROW_H - 4;
    }

    // ── Rows ────────────────────────────────────────────────────────────────────────────────────
    // Bil runs across the WHOLE form, not per sheet: it is the numbering a KWSP counter reads down.
    let bil = form.pages.slice(0, pageData.sheet - 1).reduce((a, p) => a + p.rows.length, 0);
    for (const r of pageData.rows) {
      bil += 1;
      text(String(bil), COL.bil, 8.5);
      text(r.memberNo, COL.member, 8.5);
      text(r.ic, COL.ic, 8.5);
      textClip(r.name, COL.name, COL.wageR - COL.name - 40, 8.5);
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
      text('Jumlah yang dibawa ke mukasurat seterusnya', COL.member, 8.5, bold);
      textR(money(pageData.carryOutEmployer), COL.employerR, 8.5, bold);
      textR(money(pageData.carryOutEmployee), COL.employeeR, 8.5, bold);
    } else {
      // JUMLAH ON THE LAST SHEET ONLY: repeating it is how a multi-page form gets filed with the grand
      // total mistaken for a page total.
      text('JUMLAH (RM)', COL.member, 9.5, bold);
      textR(money(form.totalWage), COL.wageR, 9.5, bold);
      textR(money(form.totalEmployer), COL.employerR, 9.5, bold);
      textR(money(form.totalEmployee), COL.employeeR, 9.5, bold);
    }
    y -= 8;
    line(y, 1.1);

    // ── The representative block, last sheet only, anchored to the foot ──────────────────────────
    if (last) {
      y = REP_BAND_TOP;
      text('Wakil Yang Diberi Kuasa / Authorised Representative', M, 7.5, bold, muted);
      y -= 13;
      const rep: [string, string][] = [
        ['Nama', form.repName],
        ['No. Kad Pengenalan', form.repIc],
        ['Jawatan', form.repPosition],
        ['No. Tel', form.repPhone],
        ['E-mel', form.repEmail],
      ];
      for (const [l, v] of rep) {
        text(`${l}:`, M, 8, font, muted);
        // A BLANK LINE RATHER THAN AN INVENTED ONE. Production carries this block for one company in
        // nine; the rest print a rule to write on, which is what the specimen's own blank boxes are.
        if (v) {
          text(v, M + 110, 8, bold);
        } else {
          page.drawLine({ start: { x: M + 110, y: y - 2 }, end: { x: M + 300, y: y - 2 }, thickness: 0.5, color: hair });
        }
        y -= 12;
      }
      // Drawn empty on purpose — the operator's and the collecting agent's, never payroll-derived.
      text('Tandatangan & Tarikh', M + 330, 7.5, font, muted);
      box(M + 330, REP_BAND_TOP - 58, 197, 52);
    }

    // ── Provenance band ─────────────────────────────────────────────────────────────────────────
    // WRAPPED, not one long line: the English sentence is wider than A4 and an unwrapped one runs off
    // the right edge, which no static check can see.
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
      'Susun atur kami sendiri, dilukis mengikut Borang A — bukan borang rasmi KWSP.',
      'Our own layout, drawn to match Borang A. KWSP publishes no blank form to print onto, so this is not ' +
        'the agency’s own page. Upah is the wage EPF was charged on and the contributions are taken from the ' +
        'payroll run, never recalculated.',
      `Bulan caruman ${form.contributionMonth} · bulan upah ${form.payrollPeriodKey}`,
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
