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
 *   node --import tsx scripts/measure-ea-official-pdf.ts --file out.pdf --all   # …on OUR output instead
 *   node --import tsx scripts/measure-ea-official-pdf.ts --ours en --all        # …RENDERING ours first
 *   node --import tsx scripts/measure-ea-official-pdf.ts --ours en --blank --out p.pdf --all
 *
 * `--file` is what makes it a comparison rather than a reading: point it at a form this system just
 * rendered and the same numbers come out in the same coordinate system, so the agency's page and ours
 * can be diffed line for line. §8 — when two PDF renderers disagree, the disagreement is the instrument.
 *
 * r372 — `--ours <locale>` RENDERS that form first, off `lib/ea-pdf.ts` and the real catalogue, so the
 * comparison is one command and cannot be run against a stale file somebody left in a scratchpad. With
 * `--out <path>` it also writes the PDF, for looking at. `--blank` renders the empty C.P.8A instead of
 * the demonstration statement below. The PARSER is `lib/pdf-page-geometry.ts`, the same module the grid
 * guard uses, so the script and the test cannot disagree about what is on a page.
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
import { writeFileSync } from 'node:fs';
import { type PdfRun, readPdfPageGeometry, roundPt } from '../lib/pdf-page-geometry';
import { EA_FORM, blankEaPdfData, renderEaPdf, type EaPdfData } from '../lib/ea-pdf';
import { eaPdfLabelsFromCatalogue } from '../lib/ea-pdf-labels-file';

const arg = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const FILE = arg('--file');
const OURS = arg('--ours');
const OUT = arg('--out');
const OFFICIAL = FILE
  ? path.resolve(process.cwd(), FILE)
  : path.resolve(__dirname, '..', 'docs/forms/ea-cp8a-pin-2023-official-en.pdf');

type Run = PdfRun;

/**
 * A DEMONSTRATION STATEMENT, so `--ours` measures a FILLED form rather than an empty one.
 *
 * ⚠️ IT IS NOT A FIXTURE AND NOTHING MAY ASSERT AGAINST ITS FIGURES. Every amount here exists to put a
 * digit on a rule so the rule's position can be read; they are not a payroll, they are not derived from
 * one, and `--blank` is the other half of the picture. The employer block is deliberately longer than
 * the agency's two writing rules, because the continuation sheet is the case a short one cannot show.
 */
function demonstrationStatement(): EaPdfData {
  const zero = blankEaPdfData();
  return {
    ...zero,
    year: '2026',
    employer: {
      name: 'Perbadanan Pembangunan Infrastruktur dan Teknologi Maklumat Semenanjung Malaysia Berhad',
      eNumber: 'E 1234567890',
      address: ['Aras 27, Menara Tabung Haji, Jalan Tun Razak', '50400 Kuala Lumpur, Wilayah Persekutuan'],
      phone: '03-2161 8888',
      lhdnState: 'WP Kuala Lumpur',
      officerName: 'Nurul Ain binti Abdullah',
      officerPosition: 'Pengurus Sumber Manusia',
    },
    employee: {
      ...zero.employee,
      name: 'Muhammad Ariff bin Zainal Abidin',
      ic: '900101-14-5566',
      taxNo: 'IG 1234567890',
      epfNo: '12345678',
      socsoNo: 'A1234567',
      children: 2,
      hiredOn: '2019-04-01',
      terminatedOn: null,
      employeeNo: 'EMP-00042',
      jobTitle: 'Senior Systems Engineer',
      passport: null,
    },
    partB: { ...zero.partB, grossSalary: 96000, bonus: 8000, allowances: 4800, gross: 108800, exemptAllowances: 2400 },
    partC: { pension: 0, annuity: 0, total: 0 },
    partD: { ...zero.partD, mtd: 7320.5, cp38: 0, zakat: 0, childRelief: 8000 },
    partE: { epf: 11880, socso: 297, eis: 118.8, skbbk: 43.45, fundName: 'KWSP' },
    formDate: '2027-02-28',
    statutoryVersion: 'measure-only',
    overrides: [],
  };
}

const round = roundPt;

async function run() {
  const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--rects') ? 'rects' : 'sectionA';
  let bytes: Uint8Array | Buffer;
  let label: string;
  if (OURS) {
    const empty = process.argv.includes('--blank');
    const labels = eaPdfLabelsFromCatalogue(OURS);
    bytes = empty
      ? await renderEaPdf(blankEaPdfData(), labels, { locale: OURS, blank: true })
      : await renderEaPdf(demonstrationStatement(), labels, { locale: OURS });
    if (OUT) {
      writeFileSync(path.resolve(process.cwd(), OUT), bytes);
      console.log(`wrote ${OUT}`);
    }
    label = `OURS (lib/ea-pdf.ts, locale ${OURS}${empty ? ', blank' : ''})`;
  } else {
    bytes = readFileSync(OFFICIAL);
    label = path.basename(OFFICIAL);
  }
  const { width, height, pages, runs, rects } = await readPdfPageGeometry(bytes);
  console.log(`${label} — page 1 of ${pages}, ${width} × ${height} pt`);

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
  // The producer splits this caption across runs, so match its FIRST words rather than the sentence.
  report('BANNER (the white-on-black strip above Section A)', find(/^THIS FORM|^BORANG/i));
  report("SECTION A's heading", find(/PARTICULARS OF EMPLOYEE|BUTIRAN PEKERJA/i));
  report("SECTION A's item 1 (the first field row)", find(/^1\.?\s*(Name|Nama)|^(Name|Nama) of Employee/i));
  /**
   * ⚠️ MATCHED ON THE ITEM NUMBER AND SCOPED TO SECTION A, because neither alternative works.
   *
   * The agency's producer breaks captions mid-word — "Job Designat" + "ion", "New I.C." + "No" — so no
   * caption match finds row 2 at all; and "Designation" IS one whole run 650 pt further down, in the
   * officer box, so an unscoped caption match reported the FOOT as Section A's second row. A confidently
   * wrong coordinate is worse than a blank line. The numbered items ARE standalone runs ("2.", "3." …),
   * so they are what the rows are found by.
   */
  const a0 = find(/PARTICULARS OF EMPLOYEE|BUTIRAN PEKERJA/i)[0];
  report(
    "SECTION A's numbered items (the row pitch under the heading)",
    runs.filter((r) => a0 && r.tt > a0.tt && r.tt < a0.tt + 95 && /^\d\.$/.test(r.text)),
  );
  report("SECTION B's heading (Section A's floor)", find(/EMPLOYMENT INCOME|PENDAPATAN PENGGAJIAN/i));

  const a = find(/PARTICULARS OF EMPLOYEE|BUTIRAN PEKERJA/i)[0];
  const one = find(/^1\.?\s*(Name|Nama)|^(Name|Nama) of Employee/i)[0];
  if (a && one) {
    console.log(`\nHEADING → FIRST FIELD, on the agency's page: ${round(one.tt - a.tt)} pt (baseline to baseline).`);
    // ⚠️ READ OFF EA_FORM, NEVER RESTATED. This line used to end "lib/ea-pdf.ts holds 99.5 → 114, i.e.
    // 14.5 pt", which was true the day it was written and wrong the moment the renderer changed — the
    // exact failure mode CLAUDE.md §8 keeps warning about. It now derives what OURS is from the same
    // constants the renderer draws with.
    const SQUARE_ASCENT = 8.2; // sectionHeading hangs its black square this far above the caption's baseline
    const ourHeading = round(EA_FORM.bannerT[1] + EA_FORM.sectionGapUnderBanner + SQUARE_ASCENT);
    console.log(
      `OURS (derived in lib/ea-pdf.ts): heading ${ourHeading} → first field ` +
        `${round(ourHeading + EA_FORM.sectionAFieldPitch)}, i.e. ${EA_FORM.sectionAFieldPitch} pt, with ` +
        `${EA_FORM.sectionGapUnderBanner} pt under a banner ending at ${EA_FORM.bannerT[1]}.`,
    );
    console.log('The cell edges (--rects) are the form where a baseline is only the typesetter inside it.');
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
