/**
 * ad7bc503 — DRAW THE PCB / MTD CALCULATION DETAIL, A4 PORTRAIT, WITH pdf-lib.
 *
 * Mirrors lib/tp1-pdf.ts, which is the house pattern for a document we draw from scratch: pdf-lib (pure
 * JS, no WASM and no native binding, so no Next bundler friction), WinAnsi folding, wrap-to-column, and a
 * `need()` that opens a new page and repeats the column headings.
 *
 * ⚠️ IT DECIDES NOTHING. Every string below arrives resolved — every caption translated, every figure
 * formatted, every absence already worded. This file chooses positions and nothing else. That is the same
 * split the screen has (`core/pcb-explain.ts` builds the rows, the view paints them) and it exists for the
 * same reason: the mapping from a stored box to a line of the agency's form is the thing that can be
 * wrong, and a mapping inside a renderer can only be checked by reading a PDF.
 *
 * ⚠️ WHICH IS ALSO WHY THERE IS NO `money()` HERE AND NO 0.00 ANYWHERE. The reporter's reference prints
 * 0.00 down every unclaimed line; this document prints WORDS where nothing was recorded, because a
 * printed zero asserts the money does not exist and we cannot stand behind that (CLAUDE.md §8, and the
 * approved plan promises it in writing). A renderer that turned an empty cell into "0.00", or into a
 * blank ruled box, would undo that decision in the one artefact that leaves the building — so it never
 * sees a number it could default, only a string it must draw.
 *
 * ⚠️ AND IT IS NOT THE OFFICIAL FORM. Every rule and heading is ours, drawn to be readable beside the
 * agency's own calculation slip; nothing is overlaid on agency artwork. The provenance band at the foot
 * says so in plain words, in the reader's language and in English, and it is supplied rather than
 * hardcoded here — the same posture lib/tp1-pdf.ts and lib/borang-a-pdf.ts take.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const W = 595.28;
const H = 841.89;
const M = 34;
const RIGHT = W - M;
const FLOOR = M + 60;
/** Up to three right-aligned figure columns, measured from the right margin inwards. */
const COL_W = 96;
const LINE_W = 26;

/** One drawn row. `cells` is right-aligned into the section's own columns, in the same order. */
export type PcbSlipPdfRow = {
  /** The form's own line marker. Language-neutral; blank for a line the form gives none. */
  line: string;
  label: string;
  cells: string[];
  /** A lettered sub-line: indented, smaller, and its marker is not the primary ink. */
  sub?: boolean;
  /** A total or a heading-weight line. */
  strong?: boolean;
};

export type PcbSlipPdfSection = {
  heading: string;
  /** Right-aligned column headings, drawn once per page the section occupies. Empty ⇒ no heading strip. */
  columns: string[];
  rows: PcbSlipPdfRow[];
  note?: string;
};

export type PcbSlipPdfData = {
  title: string;
  /** One line under the title — who and which payroll month this document is about. */
  subtitle: string;
  sections: PcbSlipPdfSection[];
  /** The band at the foot: what this document is and what it is not. Supplied, never composed here. */
  provenance: string[];
};

export async function renderPcbDetailPdf(data: PcbSlipPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(data.title);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.6, 0.6, 0.65);

  // Helvetica is WinAnsi and pdf-lib folds an unmappable codepoint to '?'. The agency's own wording and a
  // company name both routinely carry an em dash or a curly quote, so they are folded to their ASCII
  // equivalents FIRST and only genuinely unrepresentable characters become '?'. Same limitation, and the
  // same treatment, as lib/tp1-pdf.ts and lib/borang-a-pdf.ts.
  const safe = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...')
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const textR = (s: string, xr: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });

  // pdf-lib's text neither wraps nor truncates: an unwrapped agency description runs straight across the
  // figure columns and over the numbers. Every label is wrapped to its own width and every line drawn.
  const wrapTo = (s: string, maxW: number, size: number, f: PDFFont): string[] => {
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
    return out.length ? out : [''];
  };

  let columns: string[] = [];
  /** The figure-column headings, repeated at the top of every page the section continues onto. */
  const columnHeadings = () => {
    if (columns.length === 0) return;
    for (const [i, c] of columns.entries()) {
      textR(c, RIGHT - COL_W * (columns.length - 1 - i), 6.5, bold, muted);
    }
    y -= 5;
    page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.9, color: rule });
    y -= 11;
  };
  const need = (h: number, repeat = true) => {
    if (y - h >= FLOOR) return;
    page = doc.addPage([W, H]);
    y = H - M;
    if (repeat) columnHeadings();
  };

  // ── Masthead ──────────────────────────────────────────────────────────────────────────────────────
  const centred = (s: string, size: number, f = font, color = ink) => {
    const v = safe(s);
    page.drawText(v, { x: (W - f.widthOfTextAtSize(v, size)) / 2, y, size, font: f, color });
    y -= size + 4;
  };
  centred(data.title, 11, bold);
  centred(data.subtitle, 8, font, muted);
  y -= 8;

  for (const sec of data.sections) {
    columns = sec.columns;
    // A section heading with no room beneath it for its own first row is a heading stranded at a page
    // foot; 60 points is the strip plus a first wrapped label.
    need(60, false);
    page.drawRectangle({ x: M, y: y - 4, width: RIGHT - M, height: 15, color: rgb(0.85, 0.9, 0.95) });
    text(sec.heading, M + 4, 9, bold);
    y -= 22;
    columnHeadings();

    const labelW = RIGHT - M - LINE_W - COL_W * columns.length - 8;
    for (const row of sec.rows) {
      const size = row.sub ? 7.5 : 8;
      const lines = wrapTo(row.label, row.sub ? labelW - 14 : labelW, size, font);
      need(lines.length * (size + 2) + 4);
      for (const [i, l] of lines.entries()) {
        if (i === 0 && row.line) text(row.line, M, size, bold, row.sub ? muted : ink);
        text(l, M + LINE_W + (row.sub ? 14 : 0), size, row.strong ? bold : font);
        // The figures sit on the FIRST label line, so a three-line agency description never pushes them
        // away from the line marker they belong to.
        if (i === 0) {
          for (const [c, cell] of row.cells.entries()) {
            if (cell === '') continue;
            textR(cell, RIGHT - COL_W * (row.cells.length - 1 - c), size, row.strong ? bold : font);
          }
        }
        y -= size + 2;
      }
    }
    if (sec.note) {
      const lines = wrapTo(sec.note, RIGHT - M - 4, 7, font);
      need(lines.length * 9 + 6, false);
      y -= 3;
      for (const l of lines) {
        text(l, M + 4, 7, font, muted);
        y -= 9;
      }
    }
    y -= 10;
  }

  // ── Provenance ────────────────────────────────────────────────────────────────────────────────────
  need(14 * data.provenance.length + 14, false);
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.7, color: rule });
  y -= 11;
  for (const p of data.provenance) {
    for (const l of wrapTo(p, RIGHT - M, 6.5, font)) {
      text(l, M, 6.5, font, muted);
      y -= 8;
    }
  }

  return doc.save();
}
