/**
 * r411 (item 4f45f9b0) — draw a BBCD (Borang Bayaran Caruman Bulanan - Pita/Disket), ONE A4 page, with
 * pdf-lib. The house pattern of `lib/borang-a-pdf.ts`, which this mirrors helper for helper.
 *
 * ⚠️ NOT KWSP ARTWORK, AND THE PAGE SAYS SO. The reporter's sample is a filled BBCD printed by another
 * payroll system (US Letter, with that system's KWSP logo). We hold no KWSP blank, so every rule and
 * heading below is drawn on our own A4 page, laid out like the sample: the masthead and its four lines,
 * the three-box strip (No. Rujukan Majikan · Bulan Caruman · Amaun Caruman), the payment instruction and
 * its two ticks, Nama and Alamat on dotted lines with their labels in the left margin, Cop Agen Kutipan on
 * the right, then the declaration, the signatory lines and CATATAN 1-3. NO LOGO: the sample's is the
 * agency's mark reproduced by another vendor, and printing it would borrow the agency's authority.
 *
 * Every value comes off `BorangBbcdForm`, which is a projection of the Borang A this same request built
 * (lib/borang-bbcd.ts) — so the Amaun Caruman box is the Borang A total, not a figure computed here.
 *
 * DRAWN EMPTY, ON PURPOSE: both payment ticks and the cheque number line, the signature, Cop Agen
 * Kutipan. An absent signatory value leaves its dotted line empty — never a placeholder.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { money } from './borang-a';
import {
  BBCD_CATATAN,
  BBCD_CITATION,
  BBCD_DECLARATION,
  BBCD_MASTHEAD,
  BBCD_PAYMENT_INSTRUCTION,
  BBCD_PAYMENT_METHODS,
  BBCD_SCHEDULE_PREFIX,
  BBCD_SYSTEM,
  BBCD_TITLE,
  type BorangBbcdForm,
} from './borang-bbcd';

/** A4 portrait, in points. */
const W = 595.28;
const H = 841.89;
const M = 28;
const RIGHT = W - M;
/** Distance from the TOP edge → pdf-lib's y. The layout below is read top-down, as the sample is. */
const Y = (t: number) => H - t;

/** The inner box holding the strip, the payment band and the employer lines — the sample's 80..483 of 612. */
const BOX_L = M + 58;
const BOX_R = RIGHT - 92;
const STRIP_TOP = 132;
const CAP_H = 15;
const VAL_H = 15;
/** The strip's three cells, as fractions of the box — the sample's 155 / 110 / 138. */
const STRIP_FRACTIONS = [0.385, 0.273, 0.342] as const;
const BOX_BOT = 344;
/** The rule across the frame under the upper block. */
const DIVIDER = 372;
const FRAME_BOT = 770;
const LABEL_X = M + 8;
const VALUE_X = BOX_L + 8;
const VALUE_R = BOX_R - 10;

/** The signatory block: labels, colons and dotted lines, the sample's own five rows. */
const SIG_LABEL_X = M + 8;
const SIG_COLON_X = M + 92;
const SIG_LINE_L = M + 104;
const SIG_LINE_R = M + 316;
const CATATAN_X = M + 340;

/** Published for the tests, so they read the renderer's geometry rather than restating it. */
export const BBCD_GEOMETRY = {
  pageWidth: W,
  pageHeight: H,
  boxLeft: BOX_L,
  boxRight: BOX_R,
  stripFractions: STRIP_FRACTIONS,
  sigLineLeft: SIG_LINE_L,
  sigLineRight: SIG_LINE_R,
  catatanX: CATATAN_X,
  frameBottom: Y(FRAME_BOT),
} as const;

export async function renderBorangBbcdPdf(form: BorangBbcdForm): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`BBCD — ${form.employerName} — ${form.contributionMonthName}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([W, H]);

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.25, 0.25, 0.28);
  const hair = rgb(0.45, 0.45, 0.5);

  /** Helvetica is WinAnsi: typography is folded, anything else degrades to '?' (lib/borang-a-pdf.ts). */
  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  const wrap = (s: string, size: number, maxW: number, f = font) => {
    const out: string[] = [];
    let cur = '';
    for (const w of safe(s).split(/\s+/)) {
      const trial = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && cur) {
        out.push(cur);
        cur = w;
      } else cur = trial;
    }
    if (cur) out.push(cur);
    return out;
  };
  const at = (s: string, x: number, t: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y: Y(t), size, font: f, color });
  const atC = (s: string, cx: number, t: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: Y(t), size, font: f, color });
  /** SHRINK, NEVER CUT — a name, an address line, a reference is always drawn whole (lib/borang-a-pdf.ts). */
  const fitSize = (v: string, maxW: number, size: number, f = font) => {
    const w = f.widthOfTextAtSize(v, size);
    if (w <= maxW || w <= 0) return size;
    return Math.max(1, Math.floor((size * maxW * 10) / w) / 10);
  };
  const atFit = (s: string, x: number, t: number, maxW: number, size: number, f = font) => {
    const v = safe(s);
    page.drawText(v, { x, y: Y(t), size: fitSize(v, maxW, size, f), font: f, color: ink });
  };
  const atFitC = (s: string, cx: number, t: number, maxW: number, size: number, f = font) => {
    const v = safe(s);
    const sz = fitSize(v, maxW, size, f);
    page.drawText(v, { x: cx - f.widthOfTextAtSize(v, sz) / 2, y: Y(t), size: sz, font: f, color: ink });
  };
  const hline = (x1: number, x2: number, t: number, thickness = 0.7, color = rule) =>
    page.drawLine({ start: { x: x1, y: Y(t) }, end: { x: x2, y: Y(t) }, thickness, color });
  const dotted = (x1: number, x2: number, t: number) =>
    page.drawLine({ start: { x: x1, y: Y(t) }, end: { x: x2, y: Y(t) }, thickness: 0.6, color: hair, dashArray: [1.5, 1.8] });
  const box = (x: number, top: number, w: number, h: number, borderWidth = 0.7) =>
    page.drawRectangle({ x, y: Y(top + h), width: w, height: h, borderColor: rule, borderWidth });

  // ── The outer frame, and the rule under the upper block ─────────────────────────────────────────────
  box(M, M, RIGHT - M, FRAME_BOT - M, 0.9);
  hline(M, RIGHT, DIVIDER, 0.9);

  // ── Masthead, centred: the agency's name, the regulation, the form's name, the system, the schedule ─
  // NO LOGO (see the header).
  const cx = (M + RIGHT) / 2;
  atC(BBCD_MASTHEAD, cx, 52, 11, bold);
  atC(BBCD_CITATION, cx, 64, 7.5);
  atC(BBCD_TITLE, cx, 75, 7.5, bold);
  atC(BBCD_SYSTEM, cx, 96, 7.5, bold);
  // "JADUAL CARUMAN BULAN September 2026" — the Borang A CONTRIBUTION month, in the sample's words.
  atC(`${BBCD_SCHEDULE_PREFIX} ${form.contributionMonthName}`, cx, 118, 8, bold);

  // ── The three-box strip ─────────────────────────────────────────────────────────────────────────────
  const slots: { cap: string; val: string }[] = [
    { cap: 'No. Rujukan Majikan', val: form.employerRef },
    // The sample's box holds MMYY and nothing else ("0926").
    { cap: 'Bulan Caruman', val: form.contributionMonthCode },
    // THE BORANG A TOTAL. Not re-derived: `form.amount` is `totalContribution` of the same Borang A.
    { cap: 'Amaun Caruman', val: money(form.amount) },
  ];
  let sx = BOX_L;
  for (const [i, slot] of slots.entries()) {
    const w = (BOX_R - BOX_L) * STRIP_FRACTIONS[i];
    box(sx, STRIP_TOP, w, CAP_H);
    box(sx, STRIP_TOP + CAP_H, w, VAL_H);
    atC(slot.cap, sx + w / 2, STRIP_TOP + 10.5, 7.5, bold);
    // An absent box asserts nothing: an empty value draws nothing at all.
    if (slot.val) atFitC(slot.val, sx + w / 2, STRIP_TOP + CAP_H + 10.5, w - 8, 8.5);
    sx += w;
  }

  // ── The box under the strip: the payment instruction, the ticks, Nama and Alamat ────────────────────
  const BAND_TOP = STRIP_TOP + CAP_H + VAL_H;
  box(BOX_L, BAND_TOP, BOX_R - BOX_L, BOX_BOT - BAND_TOP);
  // "(untuk potongan gaji bulan August 2026 ) hendaklah …" — the PAYROLL month the contributions were
  // deducted from, between the sample's own two halves of the sentence.
  const instruction = `${BBCD_PAYMENT_INSTRUCTION[0]} ${form.payrollMonthName}${BBCD_PAYMENT_INSTRUCTION[1]}`;
  let it = BAND_TOP + 17;
  for (const l of wrap(instruction, 7.5, BOX_R - BOX_L - 16)) {
    at(l, VALUE_X, it, 7.5);
    it += 10;
  }
  // TWO TICKS, DRAWN EMPTY, and the instrument's number line. Payroll does not know how this was paid.
  const tickT = BAND_TOP + 50;
  const tick2X = VALUE_X + 92;
  for (const [i, opt] of BBCD_PAYMENT_METHODS.entries()) {
    const tx = i === 0 ? VALUE_X : tick2X;
    at('[', tx, tickT, 7.5);
    at(']', tx + 14, tickT, 7.5);
    at(opt, tx + 22, tickT, 7.5);
  }
  const refStart = tick2X + 22 + font.widthOfTextAtSize(safe(BBCD_PAYMENT_METHODS[1]), 7.5) + 6;
  hline(refStart, VALUE_R, tickT + 1.5, 0.6);

  // Nama, then every address line Borang A prints, each on its own dotted line. Labels in the left margin.
  const nameT = BAND_TOP + 80;
  const lineGap = 21;
  at('Nama', LABEL_X, nameT, 7.5);
  atFit(form.employerName, VALUE_X, nameT, VALUE_R - VALUE_X, 8.5);
  dotted(VALUE_X, VALUE_R, nameT + 4);
  at('Alamat', LABEL_X, nameT + lineGap, 7.5);
  // At least the sample's four address rules, more if the company has more lines (never dropped).
  const addrRows = Math.max(4, form.employerAddress.length);
  const addrGap = Math.min(lineGap, (BOX_BOT - 8 - (nameT + lineGap)) / Math.max(1, addrRows - 1));
  for (let i = 0; i < addrRows; i++) {
    const t = nameT + lineGap + i * addrGap;
    const l = form.employerAddress[i];
    if (l) atFit(l, VALUE_X, t, VALUE_R - VALUE_X, 8);
    dotted(VALUE_X, VALUE_R, t + 4);
  }
  // Cop Agen Kutipan — the collecting agent's, DRAWN EMPTY, labelled where the sample labels it.
  at('Cop Agen Kutipan', BOX_R + 6, BOX_BOT - 18, 7.5, bold);

  // ── The declaration ─────────────────────────────────────────────────────────────────────────────────
  let dt = DIVIDER + 40;
  for (const l of wrap(BBCD_DECLARATION, 7.5, 360)) {
    at(l, M + 30, dt, 7.5);
    dt += 10;
  }

  // ── The signatory lines — the company's EPF signatory, as set under Organization ────────────────────
  // A value that is not set leaves its line EMPTY: the readiness note on the screen says so beforehand.
  const sigTop = 600;
  const rows: { label: string; value: string | null; t: number; caption?: string }[] = [
    // The signature itself is never ours.
    { label: 'TANDATANGAN', value: null, t: sigTop },
    { label: 'NAMA PENUH', value: form.signatory.name, t: sigTop + 22, caption: 'HURUF BESAR' },
    { label: 'NO KP', value: form.signatory.ic, t: sigTop + 56 },
    { label: 'JAWATAN', value: form.signatory.position, t: sigTop + 78, caption: 'MAJIKAN/WAKIL MAJIKAN' },
    { label: 'NO TELEFON', value: form.signatory.phone, t: sigTop + 116 },
  ];
  for (const r of rows) {
    at(r.label, SIG_LABEL_X, r.t, 7.5);
    at(':', SIG_COLON_X, r.t, 7.5);
    if (r.value) atFit(r.value, SIG_LINE_L + 2, r.t - 1, SIG_LINE_R - SIG_LINE_L - 4, 8.5);
    dotted(SIG_LINE_L, SIG_LINE_R, r.t + 3);
    if (r.caption) atC(r.caption, (SIG_LINE_L + SIG_LINE_R) / 2, r.t + 13, 6.5, bold);
  }

  // ── CATATAN 1-3 ─────────────────────────────────────────────────────────────────────────────────────
  at('CATATAN:', CATATAN_X, sigTop + 4, 7.5, bold);
  let ct = sigTop + 20;
  for (const [i, note] of BBCD_CATATAN.entries()) {
    at(`${i + 1}.`, CATATAN_X, ct, 7, bold);
    for (const l of wrap(note, 7, RIGHT - 10 - (CATATAN_X + 14), bold)) {
      at(l, CATATAN_X + 14, ct, 7, bold);
      ct += 9;
    }
    ct += 5;
  }

  // ── Provenance, under the frame ─────────────────────────────────────────────────────────────────────
  let pt = FRAME_BOT + 14;
  const band = [
    'Susun atur kami sendiri, dilukis mengikut BBCD — bukan borang rasmi KWSP.',
    'Our own layout, drawn to match a filled BBCD produced by another payroll system; the declaration and ' +
      'CATATAN are transcribed from it, not taken from a KWSP page. Amaun Caruman is the Borang A total ' +
      'for the same payroll month and payroll cycles, taken from the payroll run, never recalculated.',
    `Bulan caruman ${form.contributionMonthCode.slice(0, 2)} / ${form.contributionPeriodKey.slice(0, 4)} · bulan upah ${form.payrollPeriodKey}`,
  ];
  for (const paragraph of band) {
    for (const l of wrap(paragraph, 6.2, RIGHT - M)) {
      at(l, M, pt, 6.2, font, muted);
      pt += 7.8;
    }
  }

  return doc.save();
}
