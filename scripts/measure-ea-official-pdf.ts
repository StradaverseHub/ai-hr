/**
 * MEASURE LHDN'S OWN C.P.8A, SO THE GEOMETRY IN `lib/ea-pdf.ts` IS READ OFF THE AGENCY'S FILE.
 *
 * r353 (item fda53352) — AND THIS TIME IT IS COMMITTED. r346 measured the money column off
 * `docs/forms/ea-cp8a-pin-2023-official-en.pdf` and r349 measured the black blocks off it, and neither
 * measuring script survived the round (docs/HANDOFF-HISTORY.md records r349's as never committed). So
 * every later round had to take the numbers in `EA_FORM` on trust, or re-invent the tool. A coordinate
 * nobody can re-derive is a coordinate nobody can challenge.
 *
 *   node --import tsx scripts/measure-ea-official-pdf.ts            # the Section A report
 *   node --import tsx scripts/measure-ea-official-pdf.ts --all      # every text run, top-down
 *   node --import tsx scripts/measure-ea-official-pdf.ts --rects    # every filled/stroked rectangle
 *
 * WHAT IT PRINTS, AND IN WHICH COORDINATE SYSTEM. PDF space has y growing UPWARD from the bottom left;
 * `lib/ea-pdf.ts` works TOP-DOWN in `tt` units through its `at()` helper. Everything here is reported as
 * `tt = pageHeight − y`, i.e. directly comparable with `EA_FORM` and with a `put(..., tt, ...)` call, so
 * a number read off this output can be typed straight into the renderer.
 *
 * ⚠️ THE AGENCY'S FILE IS A WORD TABLE, AND ITS GEOMETRY LIVES IN CELL RECTANGLES, NOT IN RULES. A text
 * run's y is its BASELINE; a cell's y is its edge. Where the two disagree the cell is the form and the
 * baseline is one typesetter's choice inside it — which is exactly why r346 measured the money column off
 * cell edges (89 cells begin at x=482.3) rather than off the drawn characters.
 *
 * ⚠️ IT IS A MEASURING TOOL, NOT A CONFORMANCE TEST. It asserts nothing and writes nothing. The numbers it
 * finds become constants in `EA_FORM` with a test beside them; this script is how the next round checks
 * those constants against the agency's file instead of against a previous round's confidence.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const OFFICIAL = path.resolve(__dirname, '..', 'docs/forms/ea-cp8a-pin-2023-official-en.pdf');

type Run = { text: string; x: number; tt: number; size: number };
type Rect = { x0: number; x1: number; tt0: number; tt1: number; op: string };

/** The page's content stream as one latin1 string, with every Form XObject it draws inlined after it. */
function streamOf(page: ReturnType<PDFDocument['getPages']>[number]): string {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray ? contents.asArray().map((ref) => page.node.context.lookup(ref)) : [contents];
  let raw = '';
  for (const stream of streams) {
    if (stream instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }
  return raw;
}

/**
 * Text runs, with their baseline converted to top-down `tt`.
 *
 * Both text-positioning forms the agency's producer emits are read: `Tm` (a full matrix) and `Td`/`TD`
 * (a move relative to the line matrix). Ignoring `Td` loses most of a Word-generated page — the producer
 * sets `Tm` once per block and then walks down it — which would silently report a section as having one
 * line in it. The size is taken from `Tf` and scaled by the matrix's vertical component.
 */
function runsOf(raw: string, height: number): Run[] {
  const out: Run[] = [];
  let tm = { a: 1, d: 1, e: 0, f: 0 };
  let line = { e: 0, f: 0 };
  let size = 0;
  const show = (s: string) => {
    const text = s.replace(/\\([nrtbf()\\])/g, '$1').trim();
    if (text) out.push({ text, x: round(tm.e), tt: round(height - tm.f), size: round(size * tm.d) });
  };
  const token =
    /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm|(-?[\d.]+) (-?[\d.]+) T([dD])|\/\w+ (-?[\d.]+) Tf|\(((?:\\.|[^\\)])*)\) Tj|\[((?:\\.|[^\]])*)\] TJ|BT|ET/g;
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
      size = Number(m[10]);
    } else if (m[11] !== undefined) {
      show(m[11]);
    } else if (m[12] !== undefined) {
      // A TJ array: the strings are the text, the numbers are kerning we do not need.
      show([...m[12].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((s) => s[1]).join(''));
    }
  }
  return out;
}

/** Rectangles (`x y w h re`) with the operator that consumed them, converted to top-down `tt`. */
function rectsOf(raw: string, height: number): Rect[] {
  const out: Rect[] = [];
  for (const m of raw.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s*([fFSBbn*\s]{0,6})/g)) {
    const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    out.push({
      x0: round(Math.min(x, x + w)),
      x1: round(Math.max(x, x + w)),
      tt0: round(height - Math.max(y, y + h)),
      tt1: round(height - Math.min(y, y + h)),
      op: (m[5] ?? '').trim() || '(deferred)',
    });
  }
  return out;
}

const round = (n: number) => Math.round(n * 10) / 10;

async function run() {
  const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--rects') ? 'rects' : 'sectionA';
  const doc = await PDFDocument.load(readFileSync(OFFICIAL));
  const page = doc.getPages()[0];
  const height = page.getHeight();
  console.log(`${path.basename(OFFICIAL)} — page 1 of ${doc.getPages().length}, ${round(page.getWidth())} × ${round(height)} pt`);
  const raw = streamOf(page);
  const runs = runsOf(raw, height).sort((a, b) => a.tt - b.tt || a.x - b.x);
  const rects = rectsOf(raw, height).sort((a, b) => a.tt0 - b.tt0 || a.x0 - b.x0);

  if (mode === 'all') {
    for (const r of runs) console.log(`tt ${String(r.tt).padStart(7)}  x ${String(r.x).padStart(6)}  ${String(r.size).padStart(4)}pt  ${r.text}`);
    return;
  }
  if (mode === 'rects') {
    for (const r of rects) {
      console.log(`tt ${String(r.tt0).padStart(7)}..${String(r.tt1).padEnd(7)} x ${String(r.x0).padStart(6)}..${String(r.x1).padEnd(6)} h ${String(round(r.tt1 - r.tt0)).padStart(6)} ${r.op}`);
    }
    return;
  }

  // ── The Section A report: the two coordinates lib/ea-pdf.ts holds as bare literals ────────────────
  //
  // `sectionHeading(t.sectionAEmployeeParticulars, 99.5)` and the first field row at 114. What is wanted
  // is the agency's own GAP between its Section A heading and the first row under it — the number those
  // two literals encode between them — plus the banner above, because the heading's black square hangs
  // above its baseline and must clear it.
  const find = (re: RegExp) => runs.filter((r) => re.test(r.text));
  const report = (label: string, hits: Run[]) => {
    console.log(`\n${label}`);
    if (hits.length === 0) return console.log('  (not found — the producer may split this caption across runs)');
    for (const h of hits) console.log(`  tt ${String(h.tt).padStart(7)}  x ${String(h.x).padStart(6)}  ${String(h.size).padStart(4)}pt  ${h.text}`);
  };
  report('BANNER (the white-on-black strip above Section A)', find(/MUST BE PREPARED|PERLU DISEDIAKAN/i));
  report("SECTION A's heading", find(/PARTICULARS OF EMPLOYEE|BUTIRAN PEKERJA/i));
  report("SECTION A's item 1 (the first field row)", find(/^1\.?\s*(Name|Nama)|^(Name|Nama) of Employee/i));
  report("SECTION A's items 2-3 (the row pitch under it)", find(/Designation|Employee No|Jawatan|No\. Pekerja/i));
  report("SECTION B's heading (Section A's floor)", find(/EMPLOYMENT INCOME|PENDAPATAN PENGGAJIAN/i));

  const a = find(/PARTICULARS OF EMPLOYEE|BUTIRAN PEKERJA/i)[0];
  const one = find(/^1\.?\s*(Name|Nama)|^(Name|Nama) of Employee/i)[0];
  if (a && one) {
    console.log(`\nHEADING → FIRST FIELD, on the agency's page: ${round(one.tt - a.tt)} pt (baseline to baseline).`);
    console.log('lib/ea-pdf.ts holds 99.5 → 114, i.e. 14.5 pt. Compare, then decide; the cell edges');
    console.log('(--rects) are the form where a baseline is only the typesetter inside it.');
  }
  // The rows that bound Section A vertically, so a change to its pitch can be checked for room.
  const rows = runs.filter((r) => a && r.tt > a.tt - 1 && r.tt < a.tt + 130);
  const pitches = new Map<number, number>();
  const tts = [...new Set(rows.map((r) => r.tt))].sort((x, y) => x - y);
  for (let i = 1; i < tts.length; i += 1) {
    const d = round(tts[i] - tts[i - 1]);
    if (d > 1) pitches.set(d, (pitches.get(d) ?? 0) + 1);
  }
  console.log('\nROW PITCHES inside Section A (gap → how many times it occurs):');
  for (const [d, n] of [...pitches].sort((p, q) => q[1] - p[1]).slice(0, 8)) console.log(`  ${String(d).padStart(6)} pt  × ${n}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
