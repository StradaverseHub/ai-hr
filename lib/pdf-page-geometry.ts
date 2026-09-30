/**
 * READ A PDF PAGE'S TEXT RUNS AND RECTANGLES BACK OUT OF ITS CONTENT STREAM — ONE PARSER, ONE ANSWER.
 *
 * r372 (item 795c470c) — this was the body of `scripts/measure-ea-official-pdf.ts`, which could measure
 * LHDN's own C.P.8A but could not be imported by a test. So the agency's grid was measured by a script
 * and asserted by hand-typed literals in `lib/ea-pdf.ts`, and nothing held the two together. It is a
 * MODULE now, and `test/ea-agency-grid.test.ts` parses THIS repository's rendered EA with the same code
 * that reads the agency's file, so the comparison is between two documents rather than between a
 * document and somebody's transcription of it.
 *
 * COORDINATES ARE TOP-DOWN (`tt` = pageHeight − y), because that is how a form is described and how
 * `lib/ea-pdf.ts` draws. A text run's `tt` is its BASELINE; a rectangle's is its edge.
 *
 * ⚠️ IT IS A MEASURING TOOL, NOT A RENDERER. It does not lay out glyphs, apply word spacing, or resolve
 * a run's WIDTH — only where each show-text operator was positioned. Two runs at the same `tt` that the
 * producer split mid-word are two runs here, and joining them is the caller's business.
 *
 * ⚠️ AND IT DOES NOT SEE WHAT IT CANNOT DECODE. See `decoderFor`: a composite font with no `/ToUnicode`
 * yields a run at the right position whose text is `REPLACEMENT` characters. That is deliberate — an
 * undecodable run must still be VISIBLE as a run, because a parser that drops it reports a page as
 * having a blank where it has a caption, and an empty report reads exactly like an empty page.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

export type PdfRun = {
  /** The show-text operand, decoded as far as the font's own `/ToUnicode` allows. */
  text: string;
  /** Points from the LEFT paper edge, at the run's start. */
  x: number;
  /** Points from the TOP paper edge, at the run's BASELINE. */
  tt: number;
  /** The `Tf` size scaled by the text matrix's vertical component. */
  size: number;
};

export type PdfRect = {
  x0: number;
  x1: number;
  tt0: number;
  tt1: number;
  /** The operator that consumed the `re`: `f` / `f*` / `S` … or `(deferred)` for a clip or a later path op. */
  op: string;
};

export type PdfPageGeometry = {
  width: number;
  height: number;
  pages: number;
  runs: PdfRun[];
  rects: PdfRect[];
};

/** One glyph that could not be decoded. Not '?', which a real caption can legitimately contain. */
export const UNDECODABLE_GLYPH = '�';

export const roundPt = (n: number) => Math.round(n * 10) / 10;

/** The page's own content, with every Form XObject it draws appended after it. */
function streamOf(page: ReturnType<PDFDocument['getPages']>[number]): string {
  const ctx = page.node.context;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => ctx.lookup(ref)) : [contents];
  let raw = '';
  for (const stream of streams) {
    if (stream instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }
  /**
   * ⚠️ THE COMMENT THAT STOOD HERE CLAIMED THIS AND THE CODE DID NOT DO IT (retired in r372). It read
   * "The page's content stream as one latin1 string, with every Form XObject it draws inlined after it",
   * and the loop above was the whole function. A page that draws its body inside a Form XObject would
   * have been reported as nearly empty, with a docstring saying that could not happen. The agency's
   * C.P.8A happens to have no Form XObject at all, so the claim was never tested by the one file the
   * script was written for. It is now true instead of documented.
   */
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const key of xobjects?.keys() ?? []) {
    const value = xobjects?.get(key);
    const stream = value instanceof PDFRef ? ctx.lookup(value) : value;
    if (!(stream instanceof PDFRawStream)) continue;
    if (String(stream.dict.get(PDFName.of('Subtype'))) !== '/Form') continue;
    raw += `\n${Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')}`;
  }
  return raw;
}

/**
 * A font's `/ToUnicode` CMap as a code → string map, or `null` for a font that has none.
 *
 * ⚠️ WHY THIS EXISTS AT ALL — IT IS THE PARSER GAP r372 FOUND, AND IT WAS SILENT. The old parser read
 * `(literal) Tj`, `[…] TJ` (literals only) and `<hex> Tj`. LHDN's own C.P.8A writes some of its captions
 * with a SUBSET font in an Identity CMap, as HEX INSIDE a TJ array — `[<0028><0050>…] TJ` is
 * "Employer's ". Those runs matched the TJ branch, contributed no `(…)` group, and were dropped without
 * a word: `--all` reported the agency's "Employer's No. E" row as starting at "No.", and the same hole
 * swallowed "Telephone" in the officer box and "(state the employee's share of contribution only)" in
 * Section E. A measuring tool that drops a caption reports a column that is not there.
 */
function decoderFor(fontDict: PDFDict | undefined, ctx: PDFDocument['context']): Map<number, string> | null {
  const ref = fontDict?.get(PDFName.of('ToUnicode'));
  const stream = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
  if (!(stream instanceof PDFRawStream)) return null;
  const cmap = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  const map = new Map<number, string>();
  /** A `/ToUnicode` destination is UTF-16**BE**, and may be several code units (a ligature maps to two).
   *  ⚠️ `Buffer.toString('utf16le')` reads it backwards: [00 50] becomes U+5000, and the agency's dot
   *  leader U+2026 came out as U+2620 (retired in r372, along with the character-swap that hid it). */
  const utf16 = (hex: string) => {
    const b = Buffer.from(hex, 'hex');
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), utf16(m[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const [lo, hi, dst] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
      for (let c = lo; c <= hi && c - lo < 65536; c += 1) map.set(c, String.fromCodePoint(dst + (c - lo)));
    }
  }
  return map.size > 0 ? map : null;
}

/** Every font resource on the page, by its content-stream name (`/F6` → `F6`). */
function decodersOf(page: ReturnType<PDFDocument['getPages']>[number]): Map<string, Map<number, string> | null> {
  const ctx = page.node.context;
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const out = new Map<string, Map<number, string> | null>();
  for (const key of fonts?.keys() ?? []) {
    const value = fonts?.get(key);
    const dict = value instanceof PDFRef ? ctx.lookup(value) : value;
    out.set(String(key).replace(/^\//, ''), decoderFor(dict instanceof PDFDict ? dict : undefined, ctx));
  }
  return out;
}

/**
 * Text runs, with their baseline converted to top-down `tt`.
 *
 * Both text-positioning forms are read: `Tm` (a full matrix) and `Td`/`TD` (a move relative to the line
 * matrix). Ignoring `Td` loses most of a Word-generated page — the producer sets `Tm` once per block and
 * then walks down it — which would silently report a section as having one line in it.
 *
 * ⚠️ AND ALL FOUR STRING FORMS, WHICH IS WHAT MAKES A COMPARISON POSSIBLE AT ALL. The agency's file
 * writes `[(literal) -12 (runs)] TJ` and, for its subset font, `[<hex>] TJ`; pdf-lib writes `<hex> Tj`
 * with one WinAnsi byte per character and no `/ToUnicode` at all. A parser that reads only one of them
 * reports the other document as having no text — an empty report that reads exactly like a page with
 * nothing on it, which is the wrong answer to be given silently.
 */
function runsOf(raw: string, height: number, decoders: Map<string, Map<number, string> | null>): PdfRun[] {
  const out: PdfRun[] = [];
  let tm = { a: 1, d: 1, e: 0, f: 0 };
  let line = { e: 0, f: 0 };
  let size = 0;
  let fontName = '';
  const show = (s: string) => {
    const text = s.replace(/\\([nrtbf()\\])/g, '$1').trim();
    if (text) out.push({ text, x: roundPt(tm.e), tt: roundPt(height - tm.f), size: roundPt(size * tm.d) });
  };
  /** A hex operand: through the font's own CMap when it has one, else one latin1 byte per character. */
  const hex = (h: string): string => {
    const cmap = decoders.get(fontName) ?? null;
    if (!cmap) return Buffer.from(h, 'hex').toString('latin1');
    let text = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      text += cmap.get(code) ?? UNDECODABLE_GLYPH;
    }
    return text;
  };
  /** A TJ array: the literal and hex strings are the text, the bare numbers are kerning we do not need. */
  const tj = (body: string): string => {
    let text = '';
    for (const m of body.matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]*)>/g)) {
      text += m[1] !== undefined ? m[1] : hex(m[2] ?? '');
    }
    return text;
  };
  const token =
    /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm|(-?[\d.]+) (-?[\d.]+) T([dD])|\/([^\s/]+) (-?[\d.]+) Tf|\(((?:\\.|[^\\)])*)\) Tj|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f]*)> Tj|BT|ET/g;
  for (const m of raw.matchAll(token)) {
    if (m[0] === 'BT') {
      tm = { a: 1, d: 1, e: 0, f: 0 };
      line = { e: 0, f: 0 };
    } else if (m[1] !== undefined) {
      tm = { a: Number(m[1]), d: Number(m[4]), e: Number(m[5]), f: Number(m[6]) };
      line = { e: tm.e, f: tm.f };
    } else if (m[7] !== undefined) {
      line = { e: line.e + Number(m[7]), f: line.f + Number(m[8]) };
      tm = { ...tm, e: line.e, f: line.f };
    } else if (m[10] !== undefined) {
      fontName = m[10];
      size = Number(m[11]);
    } else if (m[12] !== undefined) {
      show(m[12]);
    } else if (m[13] !== undefined) {
      show(tj(m[13]));
    } else if (m[14] !== undefined) {
      show(hex(m[14]));
    }
  }
  return out;
}

/** Rectangles (`x y w h re`) with the operator that consumed them, converted to top-down `tt`. */
function rectsOf(raw: string, height: number): PdfRect[] {
  const out: PdfRect[] = [];
  for (const m of raw.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s*([fFSBbn*\s]{0,6})/g)) {
    const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    out.push({
      x0: roundPt(Math.min(x, x + w)),
      x1: roundPt(Math.max(x, x + w)),
      tt0: roundPt(height - Math.max(y, y + h)),
      tt1: roundPt(height - Math.min(y, y + h)),
      op: (m[5] ?? '').trim() || '(deferred)',
    });
  }
  return out;
}

/**
 * ONE PAGE'S GEOMETRY, sorted down the page and then across it, so two documents' reports line up.
 *
 * `pageIndex` is zero-based; `pages` is the document's own count, so a caller that must refuse a second
 * page (the C.P.8A is one page, deliberately) can check it from the same read.
 */
export async function readPdfPageGeometry(bytes: Uint8Array | Buffer, pageIndex = 0): Promise<PdfPageGeometry> {
  const doc = await PDFDocument.load(bytes);
  const all = doc.getPages();
  const page = all[pageIndex];
  if (!page) throw new Error(`pdf-page-geometry: page ${pageIndex} does not exist (the document has ${all.length})`);
  const height = page.getHeight();
  const raw = streamOf(page);
  return {
    width: roundPt(page.getWidth()),
    height: roundPt(height),
    pages: all.length,
    runs: runsOf(raw, height, decodersOf(page)).sort((a, b) => a.tt - b.tt || a.x - b.x),
    rects: rectsOf(raw, height).sort((a, b) => a.tt0 - b.tt0 || a.x0 - b.x0),
  };
}

/**
 * Runs joined into ONE STRING PER BASELINE — what a READER sees, rather than what the producer emitted.
 * The agency's producer breaks captions mid-word ("Job Designat" + "ion"), so a test that matches on a
 * caption must join first or it finds nothing; a test that measures a COLUMN must NOT join, because the
 * column is where each run starts. Both are wanted, so both exist. The joined run keeps the LEFTMOST
 * run's x, which is the line's own left edge.
 */
export function joinRuns(runs: PdfRun[], tolerance = 0.6): PdfRun[] {
  const out: PdfRun[] = [];
  for (const r of [...runs].sort((a, b) => a.tt - b.tt || a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.tt - r.tt) <= tolerance) {
      last.text += r.text;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}
