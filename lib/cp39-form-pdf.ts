/**
 * e0cd4583 — draw a CP39 monthly PCB statement, A4 portrait, with pdf-lib (pure JS, no WASM/native, so
 * no Next bundler friction). Mirrors lib/borang-a-pdf.ts and lib/borang-8a-pdf.ts, which are the house
 * pattern for a form we draw from scratch.
 *
 * ⚠️⚠️ THERE IS NO BORANG CP39 (Pin.2015) ARTWORK IN THIS REPOSITORY AND WE HAVE NEVER SEEN ONE.
 * `public/forms/` holds exactly one file, `cp22-pin-1-2021.pdf`. The ticket's reference is a FILLED
 * SAMPLE produced by another payroll system, and the two earlier "agency reference" attachments in this
 * repo turned out to be exactly that as well — vendor output, not the agency's page (HANDOFF, statutory
 * forms). So every box, rule and heading below is placed from the TICKET'S OWN PROSE list of fields.
 * That is why `my.cp39` keeps `fidelity: 'figures'` and why this page says so on its face. See the
 * header of lib/cp39-form.ts for the full argument.
 *
 * ── WHAT IS DELIBERATELY NOT DRAWN, AND WHY ───────────────────────────────────────────────────────
 *   • The LHDN masthead address block. We do not hold it. Printing a government office address from
 *     memory onto something that looks like a tax form is inventing a fact about a filing.
 *   • The "A BORANG CP39 / B PEMBAYARAN / C PERINGATAN" instructions panel. The request asks for it to
 *     be reproduced "as-is", and reproducing statutory instruction text we have never read would be
 *     fabricating the content of a government document. The page says the notes are not reproduced and
 *     where to read them instead, which is the honest version of the same box.
 *   • The signature. Manual by definition — the request says to leave it blank for physical signing, so
 *     it is drawn as a box to sign in.
 *
 * The payment instrument (cheque / bank draft / postal order number and branch) is manual in the same
 * sense — never payroll-derived — but it IS typeable on the review screen, because this page doubles as
 * the payment cover document and the operator normally has the instrument in front of them when they
 * print it. Typed, it prints; untyped, it prints the same ruled line it always did.
 *
 * ── PAGINATION IS THE PART THAT GOES WRONG SILENTLY ───────────────────────────────────────────────
 * Page 1 is the cover — employer, period, payment summary and preparer. The employee table starts on
 * page 2 and runs as many sheets as it needs, each closing with its own JUMLAH and the last also
 * carrying JUMLAH BESAR. The arithmetic lives in `paginateCp39`, where it is asserted at one, two and
 * three sheets without a PDF in sight.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { money, type Cp39Form, type Cp39FormPage } from './cp39-form';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;
const M = 28;
const RIGHT = W - M;

/** Heading type size. Exported so the geometry test measures what is actually drawn. */
export const CP39_HEADING_SIZE = 6;
/** Body type size for a table row. */
export const CP39_ROW_SIZE = 7.5;

/**
 * The employee table's geometry, measured against the HEADINGS rather than guessed — the r193 Borang 8A
 * lesson: a heading is not clipped, so one wider than its column prints straight into its neighbour.
 *
 * TEN COLUMNS ON A4 PORTRAIT IS THE WHOLE DIFFICULTY. Borang A has seven and still needed its clip
 * allowance widened after somebody rasterised the page and looked at it. Here the narrow headings are
 * split over TWO LINES ("No. K/P" / "Baru") so each line fits its own column, and
 * test/cp39-form.test.ts asserts exactly that with pdf-lib's own font metrics — the columns tile the
 * printable width with no overlap, and no heading line is wider than the column it sits in.
 *
 * `x` is the LEFT edge for a left-aligned column and the RIGHT edge for a right-aligned one; `width` is
 * the column's own space in both cases.
 */
export const CP39_TABLE_COLUMNS = [
  { key: 'bil', x: 28, width: 16, align: 'left', head: ['Bil'] },
  { key: 'tin', x: 44, width: 74, align: 'left', head: ['No. Cukai', 'Pendapatan'] },
  { key: 'name', x: 118, width: 118, align: 'left', head: ['Nama Penuh Pekerja'] },
  { key: 'oldIc', x: 236, width: 50, align: 'left', head: ['No. K/P', 'Lama'] },
  { key: 'newIc', x: 286, width: 58, align: 'left', head: ['No. K/P', 'Baru'] },
  { key: 'employeeNo', x: 344, width: 44, align: 'left', head: ['No.', 'Pekerja'] },
  { key: 'passport', x: 388, width: 48, align: 'left', head: ['No.', 'Pasport'] },
  { key: 'countryCode', x: 436, width: 29, align: 'left', head: ['Kod', 'Negara'] },
  { key: 'pcb', x: 513, width: 48, align: 'right', head: ['PCB', '(RM)'] },
  { key: 'cp38', x: 567, width: 54, align: 'right', head: ['CP38', '(RM)'] },
] as const;

const ROW_H = 13;

export async function renderCp39FormPdf(form: Cp39Form): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`CP39 — ${form.employerName} — ${form.deductionMonth} ${form.deductionYear}`);
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
   * "CP39 ? bukan borang rasmi". A NAME still degrades to '?', the same documented limitation
   * lib/ea-pdf.ts, lib/borang-8a-pdf.ts and lib/borang-a-pdf.ts carry, with a Unicode font embed as the
   * deferred follow-up.
   */
  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  const newPage = () => {
    const page = doc.addPage([W, H]);
    return page;
  };

  /** Wrap to the full printable width. An unwrapped English sentence runs off A4 and no check sees it. */
  const wrap = (s: string, size: number, maxW = RIGHT - M): string[] => {
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

  // ── Page 1: the cover — employer, period, payment summary, preparer ─────────────────────────────
  {
    const page = newPage();
    let y = H - M;
    const text = (s: string, x: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x, y, size, font: f, color });
    const textR = (s: string, xr: number, size: number, f = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });
    const line = (yy: number, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x: M, y: yy }, end: { x: RIGHT, y: yy }, thickness, color });
    const box = (x: number, yy: number, w: number, h: number) =>
      page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: rule, borderWidth: 0.7 });
    /** A blank rule to write on. Used everywhere the request says "leave this for manual completion". */
    const blank = (x: number, w: number, dy = -2) =>
      page.drawLine({ start: { x, y: y + dy }, end: { x: x + w, y: y + dy }, thickness: 0.5, color: hair });

    // ── Masthead ──────────────────────────────────────────────────────────────────────────────────
    // Deliberately NO LHDN address block: we do not hold it, and printing one from memory would invent
    // a fact about a filing.
    text('PENYATA POTONGAN CUKAI BULANAN (PCB) OLEH MAJIKAN', M, 11, bold);
    textR('CP 39', RIGHT, 16, bold);
    y -= 12;
    text('Seksyen 107, Akta Cukai Pendapatan 1967', M, 8, font, muted);
    textR('Cukai Pendapatan Malaysia', RIGHT, 8, font, muted);
    y -= 12;
    line(y, 1.1);
    y -= 18;

    // ── BUTIR-BUTIR MAJIKAN ───────────────────────────────────────────────────────────────────────
    text('BUTIR-BUTIR MAJIKAN', M, 8, bold, muted);
    y -= 14;
    const field = (label: string, value: string, x: number, labelW = 150) => {
      page.drawText(safe(label), { x, y, size: 7.5, font, color: muted });
      if (value) {
        page.drawText(safe(value), { x: x + labelW, y, size: 9, font: bold, color: ink });
      } else {
        page.drawLine({
          start: { x: x + labelW, y: y - 2 },
          end: { x: x + labelW + 200, y: y - 2 },
          thickness: 0.5,
          color: hair,
        });
      }
    };
    field('No. Majikan (E)', form.employerNo, M);
    y -= 14;
    field('No. Pendaftaran Perniagaan', form.registrationNo, M);
    y -= 14;
    field('Nama Syarikat / Perniagaan', form.employerName, M);
    y -= 14;
    page.drawText(safe('Alamat Syarikat / Perniagaan'), { x: M, y, size: 7.5, font, color: muted });
    if (form.employerAddress.length === 0) {
      page.drawLine({ start: { x: M + 150, y: y - 2 }, end: { x: M + 350, y: y - 2 }, thickness: 0.5, color: hair });
      y -= 14;
    } else {
      for (const l of form.employerAddress) {
        page.drawText(safe(l), { x: M + 150, y, size: 8.5, font, color: ink });
        y -= 11;
      }
      y -= 3;
    }
    y -= 6;
    line(y, 0.9);
    y -= 18;

    // ── POTONGAN BAGI BULAN … TAHUN … ─────────────────────────────────────────────────────────────
    // THE MONTH IS THE PAYROLL MONTH, UNSHIFTED. The EPF Borang A beside this one is payroll + 1; the
    // two rules are different on purpose and `cp39DeductionPeriodFor` is where that is stated once.
    text(`POTONGAN BAGI BULAN ${form.deductionMonth} TAHUN ${form.deductionYear}`, M, 11, bold);
    textR(`Tarikh: ${form.printedOn}`, RIGHT, 9, font, muted);
    y -= 20;

    // ── BUTIR-BUTIR PEMBAYARAN ────────────────────────────────────────────────────────────────────
    text('BUTIR-BUTIR PEMBAYARAN', M, 8, bold, muted);
    y -= 8;
    const summaryTop = y;
    box(M, y - 74, RIGHT - M, 74);
    y -= 14;
    text('Jenis Potongan', M + 8, 7, bold, muted);
    textR('Bilangan Pekerja', M + 330, 7, bold, muted);
    textR('Amaun (RM)', RIGHT - 10, 7, bold, muted);
    y -= 14;
    text('Jumlah Potongan PCB', M + 8, 9);
    textR(String(form.pcbEmployees), M + 330, 9);
    textR(money(form.totalPcb), RIGHT - 10, 9);
    y -= 14;
    text('Jumlah Potongan CP38', M + 8, 9);
    textR(String(form.cp38Employees), M + 330, 9);
    textR(money(form.totalCp38), RIGHT - 10, 9);
    y -= 6;
    page.drawLine({ start: { x: M + 8, y }, end: { x: RIGHT - 8, y }, thickness: 0.5, color: rule });
    y -= 14;
    text('AMAUN', M + 8, 10, bold);
    textR(money(form.totalAmount), RIGHT - 10, 10, bold);
    y = summaryTop - 74 - 18;

    // The payment instrument — TYPED ON THE REVIEW SCREEN when the operator has it, a ruled line to
    // write on when they do not. This page is a payment cover document, so the cheque, bank draft or
    // postal order number is usually known at the moment it is printed; the request lists these as
    // manual fields, which is a statement about where the value comes from, not a ban on typing it.
    // Same rule as the preparer block below: a value prints, an empty one prints a rule.
    text('No. Cek / Draf Bank / Wang Pos', M, 7.5, font, muted);
    if (form.paymentRef) text(form.paymentRef, M + 160, 9, bold);
    else blank(M + 160, 150);
    text('Cawangan', M + 330, 7.5, font, muted);
    if (form.paymentBranch) text(form.paymentBranch, M + 385, 9, bold);
    else blank(M + 385, RIGHT - (M + 385));
    y -= 22;
    line(y, 0.9);
    y -= 18;

    // ── PEGAWAI YANG MENYEDIAKAN MAKLUMAT ─────────────────────────────────────────────────────────
    text('PEGAWAI YANG MENYEDIAKAN MAKLUMAT', M, 8, bold, muted);
    y -= 8;
    const prepTop = y;
    box(M, y - 82, 330, 82);
    // The signature box sits BESIDE the preparer block, and it is drawn NOW rather than after the loop
    // below — the Borang A lesson: a caption drawn with whatever `y` a loop left behind lands underneath
    // its own box, and only rasterising the page can see it.
    text('Tandatangan', M + 344, 7.5, bold, muted);
    box(M + 344, prepTop - 82, RIGHT - (M + 344), 74);
    y -= 16;
    const prep: [string, string][] = [
      ['Nama Penuh', form.preparerName],
      ['No. Pengenalan', form.preparerIc],
      ['Jawatan', form.preparerPosition],
      ['No. Telefon', form.preparerPhone],
    ];
    for (const [l, v] of prep) {
      text(`${l}:`, M + 8, 8, font, muted);
      // A BLANK LINE RATHER THAN AN INVENTED ONE. The block defaults from the company's LHDN statutory
      // authority record; a company that has not filled it in prints a rule to write on.
      if (v) text(v, M + 110, 8, bold);
      else blank(M + 110, 200);
      y -= 16;
    }
    y = prepTop - 82 - 20;

    // ── Where the agency's own A / B / C notes would be ───────────────────────────────────────────
    // NOT REPRODUCED, and the page says so rather than leaving a silent gap. Inventing LHDN's printed
    // instruction text would be fabricating the content of a government document.
    line(y + 10, 0.7, hair);
    for (const l of wrap(
      'NOTA: Panduan bercetak LHDN (A Borang CP39 / B Pembayaran / C Peringatan) tidak disalin di sini - ' +
        'kami tidak memiliki salinan borang rasmi tersebut. Sila rujuk borang CP39 LHDN atau portal e-PCB.',
      7,
    )) {
      text(l, M, 7, font, muted);
      y -= 9;
    }

    // ── Provenance band ───────────────────────────────────────────────────────────────────────────
    y = M + 34;
    line(y + 12, 0.7, hair);
    const band = [
      'Susun atur kami sendiri - bukan borang rasmi LHDN. Untuk rekod dalaman dan dokumen iringan bayaran sahaja.',
      'Our own layout. We hold no copy of the Borang CP39 (Pin.2015) page, so these boxes are placed from the ' +
        'field list rather than from the agency form. LHDN does not accept a paper CP39 - file through e-PCB, ' +
        'e-Data PCB or e-CP39. Check every figure before you key or pay it.',
      `Bulan potongan ${form.deductionMonth} ${form.deductionYear} - sama dengan bulan gaji, tiada anjakan.`,
    ];
    for (const paragraph of band) {
      for (const l of wrap(paragraph, 6.8)) {
        text(l, M, 6.8, font, muted);
        y -= 9;
      }
    }
  }

  // ── Page 2 onward: the employee table ────────────────────────────────────────────────────────────
  for (const pageData of form.pages) {
    drawTableSheet(pageData);
  }

  function drawTableSheet(pageData: Cp39FormPage) {
    const page = doc.addPage([W, H]);
    let y = H - M;
    const last = pageData.sheet === pageData.of;

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

    // The employer and the period repeat on EVERY sheet. A loose page of a statutory schedule with no
    // employer number on it cannot be filed back with the rest of the bundle.
    text('CP39 - PENYATA POTONGAN CUKAI BULANAN (PCB)', M, 9, bold);
    textR(`Muka surat ${pageData.sheet}/${pageData.of}`, RIGHT, 8, font, muted);
    y -= 11;
    text(
      `No. Majikan ${form.employerNo || '-'}  ·  ${form.employerName || '-'}  ·  ` +
        `${form.deductionMonth} ${form.deductionYear}`,
      M,
      8,
      font,
      muted,
    );
    y -= 8;
    line(y, 1.1);
    y -= 12;

    // ── Column headings, up to two lines each ─────────────────────────────────────────────────────
    const headTop = y;
    for (const c of CP39_TABLE_COLUMNS) {
      c.head.forEach((h, i) => {
        const yy = headTop - i * 8;
        if (c.align === 'right') {
          page.drawText(safe(h), {
            x: c.x - bold.widthOfTextAtSize(safe(h), CP39_HEADING_SIZE),
            y: yy,
            size: CP39_HEADING_SIZE,
            font: bold,
            color: muted,
          });
        } else {
          page.drawText(safe(h), { x: c.x, y: yy, size: CP39_HEADING_SIZE, font: bold, color: muted });
        }
      });
    }
    y = headTop - 8 - 6;
    line(y, 0.9);
    y -= 12;

    // ── Rows ──────────────────────────────────────────────────────────────────────────────────────
    // Bil runs across the WHOLE statement, not per sheet: it is the numbering read down the schedule.
    let bil = form.pages.slice(0, pageData.sheet - 1).reduce((a, p) => a + p.rows.length, 0);
    const col = (key: string) => CP39_TABLE_COLUMNS.find((c) => c.key === key)!;
    for (const r of pageData.rows) {
      bil += 1;
      text(String(bil), col('bil').x, CP39_ROW_SIZE);
      textClip(r.tin, col('tin').x, col('tin').width - 4, CP39_ROW_SIZE);
      textClip(r.name, col('name').x, col('name').width - 4, CP39_ROW_SIZE);
      textClip(r.oldIc, col('oldIc').x, col('oldIc').width - 4, CP39_ROW_SIZE);
      textClip(r.newIc, col('newIc').x, col('newIc').width - 4, CP39_ROW_SIZE);
      textClip(r.employeeNo, col('employeeNo').x, col('employeeNo').width - 4, CP39_ROW_SIZE);
      textClip(r.passport, col('passport').x, col('passport').width - 4, CP39_ROW_SIZE);
      textClip(r.countryCode, col('countryCode').x, col('countryCode').width - 4, CP39_ROW_SIZE);
      textR(money(r.pcb), col('pcb').x, CP39_ROW_SIZE);
      textR(money(r.cp38), col('cp38').x, CP39_ROW_SIZE);
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.4, color: hair });
      y -= ROW_H - 4;
    }
    if (pageData.rows.length === 0) {
      text('Tiada pekerja bagi bulan ini / no employees for this month', M, 8.5, font, muted);
      y -= ROW_H;
    }

    // ── JUMLAH for this sheet, and JUMLAH BESAR on the last ───────────────────────────────────────
    y -= 2;
    line(y, 0.9);
    y -= 13;
    text(`JUMLAH (muka surat ${pageData.sheet})`, col('name').x, 8.5, bold);
    textR(money(pageData.pagePcb), col('pcb').x, 8.5, bold);
    textR(money(pageData.pageCp38), col('cp38').x, 8.5, bold);
    if (last) {
      y -= 14;
      // JUMLAH BESAR ON THE LAST SHEET ONLY: repeating it is how a multi-page statement gets filed with
      // a page total mistaken for the grand total.
      text('JUMLAH BESAR', col('name').x, 9.5, bold);
      textR(money(form.totalPcb), col('pcb').x, 9.5, bold);
      textR(money(form.totalCp38), col('cp38').x, 9.5, bold);
      y -= 6;
      line(y, 1.1);
      y -= 13;
      text(`AMAUN (PCB + CP38): RM ${money(form.totalAmount)}`, col('name').x, 9.5, bold);
    }
    y -= 8;
    line(y, 1.1);

    // ── The two columns we cannot fill, named on the sheet that has them ──────────────────────────
    // A blank column with no explanation reads as a bug. Saying it here, beside the empty boxes, is
    // what stops somebody "fixing" it by guessing an old IC or a country code onto a tax document.
    y = M + 26;
    line(y + 12, 0.7, hair);
    for (const l of wrap(
      'No. K/P Lama dan Kod Negara dibiarkan kosong: tiada medan kad pengenalan lama dalam rekod pekerja, ' +
        'dan negara pengeluaran pasport disimpan sebagai teks bebas, bukan kod dua huruf. ' +
        'Susun atur kami sendiri - bukan borang rasmi LHDN.',
      6.8,
    )) {
      text(l, M, 6.8, font, muted);
      y -= 9;
    }
  }

  return doc.save();
}
