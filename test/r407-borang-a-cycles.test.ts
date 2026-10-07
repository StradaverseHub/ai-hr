/**
 * r407 (item 4f45f9b0) — BORANG A: CHOOSE THE PAYROLL CYCLES, CONTINUE, LOOK, DOWNLOAD — and the redraw.
 *
 * DB-FREE. The kernel half (Select All renders the same bytes as no selection; a bonus-only form prints the
 * bonus as Upah) lives in test/borang-a-report.test.ts beside r372's own cycle fixture, where a payroll run
 * can be driven. This file pins the CONTRACTS between files, which is where both of this round's defects
 * lived:
 *
 *   1. the review screen's query conversion kept string params only, so `run=1&run=2` (an ARRAY) was
 *      dropped and the screen reviewed the whole month under a link that named two cycles;
 *   2. the schedule form's hidden inputs (preview/page.tsx:319-323 on r405) carried no `run`, so a
 *      filtered review downloaded a whole-month PDF, text copy and i-Akaun file.
 *
 * …and the drawn page's arithmetic: the page totals, carried forward and back, reconcile to the rows
 * actually drawn at one, two and three sheets, and a carry box with nothing to carry is EMPTY, never 0.00.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  borangADocumentPairs,
  borangADocumentQuery,
  borangAHasContributions,
  borangAQuery,
} from '../app/payroll/borang-a/query';
import {
  CYCLES_ENDPOINT,
  criteriaReturnHref,
  cyclesRefusalFrom,
  cyclesRefusalHref,
  reportDestination,
  runQueryPairs,
} from '../app/payroll/statutory-forms/criteria';
import { parseRunSelection } from '../lib/payroll-run-selection';
import { MY_REPORTS } from '../localization/my/reports';
import { BORANG_A_ROWS_PER_PAGE, borangAFrom, money, type BorangARow } from '../lib/borang-a';
import { BORANG_A_SHEET_GEOMETRY, renderBorangAPdf } from '../lib/borang-a-pdf';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with block comments and whole-line `//` comments removed. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PREVIEW = read('app/payroll/borang-a/preview/page.tsx');
const PREVIEW_CODE = code('app/payroll/borang-a/preview/page.tsx');
const OPEN_CODE = code('app/payroll/statutory-forms/open/page.tsx');
const PDF_ROUTE_CODE = code('app/payroll/borang-a/pdf/route.ts');

/**
 * A slice of source between two markers, REFUSING to be vacuous: both markers must be found (`>= 0`, never
 * truthy — -1 is truthy) and the slice must be substantial. A renamed marker otherwise turns every
 * assertion on the slice into an assertion about the empty string (CLAUDE.md §8, r373).
 */
function slice(src: string, from: string, to: string, minLength: number): string {
  const a = src.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `marker not found after the first: ${to}`).toBeGreaterThanOrEqual(0);
  const out = src.slice(a, b);
  expect(out.length, `the slice ${from} … ${to} is too short to mean anything`).toBeGreaterThan(minLength);
  return out;
}

describe('the cycle selection reaches every Borang A surface', () => {
  it('keeps EVERY value of a repeated run parameter (defect 1)', () => {
    const q = borangAQuery({ companyId: 'c', periodKey: '2026-07', run: ['1', '3'] });
    expect(q.getAll('run')).toEqual(['1', '3']);
    expect(parseRunSelection(q)).toEqual({ ok: true, runSeqs: [1, 3] });
    // A single run arrives as a string and survives too.
    expect(borangAQuery({ run: '2' }).getAll('run')).toEqual(['2']);
  });

  it('carries the selection in the one list every surface is built from, and NOTHING for all cycles', () => {
    const picked = borangADocumentPairs({ companyId: 'c', periodKey: '2026-07', runSeqs: [1, 3] });
    expect(picked.filter((p) => p.name === 'run').map((p) => p.value)).toEqual(['1', '3']);
    // SELECT ALL ⇒ `undefined` ⇒ not one `run` on the URL: the request the screen made before cycles
    // existed, and so the same bytes by construction.
    const all = borangADocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: undefined });
    expect(all).toBe('companyId=c&periodKey=2026-07');
    expect(runQueryPairs(undefined)).toEqual([]);
  });

  it('repeats the applied per-generation inputs on the viewer links, and leaves out blank ones', () => {
    const q = new URLSearchParams('epfPeriod=2026-09&code=ABC&batch=&control=');
    const s = borangADocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: [2], query: q });
    expect(s).toBe('companyId=c&periodKey=2026-07&run=2&epfPeriod=2026-09&code=ABC');
  });

  it('builds the schedule form\'s hidden inputs from that list, so Apply and all three downloads carry run= (defect 2)', () => {
    const form = slice(PREVIEW, '<form method="get" action="/payroll/borang-a/preview">', '</form>', 4000);
    expect(form).toContain('hiddenPairs.map(');
    for (const route of ['/payroll/borang-a/pdf', '/payroll/borang-a/text', '/payroll/borang-a/file']) {
      expect(form, `${route} is not a download of this form`).toContain(`formAction="${route}"`);
    }
    // …and `hiddenPairs` is the selection-carrying list, not a hand-written one.
    expect(PREVIEW_CODE).toContain('const hiddenPairs = borangADocumentPairs({ companyId, periodKey, runSeqs });');
    // The r405 shape — hand-written companyId / periodKey hidden inputs and no `run` — is gone.
    expect(form).not.toContain('<input type="hidden" name="companyId"');
  });

  it('frames and links the viewer with the same selection-carrying query', () => {
    const viewer = slice(PREVIEW_CODE, '<StatutoryPdfViewer', 'sidePanel=', 400);
    expect(viewer).toContain('pdfUrl={`/payroll/borang-a/pdf?${documentQuery}&disposition=inline`}');
    for (const route of ['pdf', 'text', 'file']) {
      expect(viewer).toContain(`href: \`/payroll/borang-a/${route}?\${documentQuery}\``);
    }
    expect(PREVIEW_CODE).toContain('const documentQuery = borangADocumentQuery({ companyId, periodKey, runSeqs, query });');
    // The query the loader reads is the array-safe one.
    expect(PREVIEW_CODE).toContain('const query = borangAQuery(sp);');
  });

  it('serves the preview as the download\'s own bytes, only the disposition differs', () => {
    expect(PDF_ROUTE_CODE).toContain("q.get('disposition') === 'inline' ? 'inline' : 'attachment'");
    expect(PDF_ROUTE_CODE.match(/renderBorangAPdf\(/g)).toHaveLength(1);
  });
});

describe('the Continue gate', () => {
  it('refuses before anything is drawn: invalid, no runs, nothing selected, nothing to file', () => {
    const GATE_START = "if (!selection.ok) redirect(";
    const gate = slice(PREVIEW_CODE, GATE_START, 'const monthFmt', 600);
    for (const reason of ['cycles_invalid', 'cycles_no_runs', 'cycles_no_data']) {
      expect(gate, reason).toContain(`'${reason}'`);
    }
    expect(gate).toContain('listFilableRunsForPeriod(');
    expect(gate).toContain("loaded.reason === 'selection-empty'");
    expect(gate).toContain("loaded.reason === 'no-contributions'");
    // …decided in the LOADER, so the download routes refuse the same selection (a direct link included).
    const shared = code('app/payroll/borang-a/shared.ts');
    expect(shared).toContain("if (!borangAHasContributions(result.rows)) return { ok: false, reason: 'no-contributions' };");
    for (const r of ['pdf', 'text']) {
      expect(code(`app/payroll/borang-a/${r}/route.ts`)).toContain("loaded.reason === 'no-contributions'");
    }
    expect(shared).toContain("loaded.reason === 'no-contributions'");
    // Nothing that draws or links a document precedes the gate.
    expect(PREVIEW_CODE.indexOf(GATE_START)).toBeGreaterThan(0);
    const before = PREVIEW_CODE.slice(0, PREVIEW_CODE.indexOf(GATE_START));
    expect(before).not.toContain('borangADocumentQuery(');
    expect(before).not.toContain('<StatutoryPdfViewer');
  });

  it('calls a selection with no EPF money on it "nothing to file", and anything else something', () => {
    expect(borangAHasContributions([])).toBe(false);
    // The render check's own case: a bonus run that paid nobody any EPF — a form of 0.00 boxes.
    expect(borangAHasContributions([{ employer: 0, employee: 0 }, { employer: '0', employee: null }])).toBe(false);
    expect(borangAHasContributions([{ employer: 0, employee: 0 }, { employer: 0.01, employee: 0 }])).toBe(true);
    expect(borangAHasContributions([{ employer: 744, employee: 682 }])).toBe(true);
  });

  it('sends the operator back to the criteria step with their criteria and the reason', () => {
    const href = cyclesRefusalHref(
      'my.borang-a',
      { companyId: 'c1', year: '2026', month: '07', runSeqs: [2] },
      'cycles_no_data',
    );
    const u = new URL(href, 'http://x');
    expect(u.pathname).toBe('/payroll/statutory-forms/open');
    expect(u.searchParams.get('form')).toBe('my.borang-a');
    expect(u.searchParams.get('companyId')).toBe('c1');
    expect(u.searchParams.get('year')).toBe('2026');
    expect(u.searchParams.get('month')).toBe('07');
    expect(u.searchParams.getAll('run')).toEqual(['2']);
    expect(cyclesRefusalFrom(u.searchParams.get('refusal') ?? undefined)).toBe('cycles_no_data');
    // NOT `?error=`, which the global toast trigger shows raw and strips (components/ui/toast-trigger.tsx).
    expect(u.searchParams.has('error')).toBe(false);
    // "Change selection" is the same address without a refusal.
    expect(criteriaReturnHref('my.borang-a', { companyId: 'c1', year: '2026', month: '07' })).toBe(
      '/payroll/statutory-forms/open?form=my.borang-a&companyId=c1&year=2026&month=07',
    );
  });

  it('shows only allowlisted refusals, and each has words in English', () => {
    expect(cyclesRefusalFrom('<script>')).toBeNull();
    expect(cyclesRefusalFrom(undefined)).toBeNull();
    const sf = en.payroll.statutoryForms as Record<string, string>;
    for (const r of ['cycles_no_runs', 'cycles_no_data', 'cycles_invalid']) {
      expect(sf[`refusal_${r}`], r).toBeTruthy();
      expect(OPEN_CODE, `the step does not map ${r}`).toContain(`${r}: 'refusal_${r}'`);
    }
  });
});

describe('the cycles criterion is generic, for the next monthly forms', () => {
  it('is declared only by monthly reports, and the step draws the shared picker for it', () => {
    for (const r of MY_REPORTS) {
      if (r.runSelection) expect(r.periodKind, r.id).toBe('month');
    }
    // An annual form can never be given the box, even if it declared one.
    const annual = reportDestination('x', 'year', { action: '/somewhere' });
    expect(annual.criteria.map((c) => c.kind)).toEqual(['company', 'year']);
    expect(annual.action).toBe('/payroll/statutory-forms/x');
    expect(OPEN_CODE).toContain("field('cycles')");
    expect(OPEN_CODE).toContain('endpoint={CYCLES_ENDPOINT}');
    // The endpoint is the eligible-runs route r372 built, which reads `listFilableRunsForPeriod`.
    expect(CYCLES_ENDPOINT).toBe('/payroll/payment-submission/runs');
    expect(code('app/payroll/payment-submission/runs/route.ts')).toContain(
      "import { listFilableRunsForPeriod } from '@/packs/payroll/service';",
    );
  });

  it('has ONE run picker, used by both the download pop-up and the criteria step', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/payment-submission/run-picker.tsx'))).toBe(false);
    expect(code('app/payroll/payment-submission/download-dialog.tsx')).toContain(
      "import { RunPicker } from '@/components/run-picker';",
    );
    expect(code('app/payroll/statutory-forms/open/cycles-criterion.tsx')).toContain(
      "import { RunPicker, type RunPickerStrings } from '@/components/run-picker';",
    );
  });
});

// ── The drawn page ───────────────────────────────────────────────────────────────────────────────────

type Drawn = { x: number; y: number; size: number; bold: boolean; text: string };
/** Every string the renderer drew, per sheet (same reader as test/borang-a.test.ts). */
async function drawnPages(form: ReturnType<typeof borangAFrom>): Promise<Drawn[][]> {
  const buf = Buffer.from(await renderBorangAPdf(form));
  const OP =
    /\/(Helvetica(?:-Bold)?)-\d+ ([\d.]+) Tf[\s\S]{0,60}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g;
  const pages: Drawn[][] = [];
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = buf.indexOf('endstream', start, 'latin1');
    let body: string;
    try {
      body = zlib.inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    if (!body.includes(' Tj')) continue;
    pages.push(
      [...body.matchAll(OP)].map((t) => ({
        bold: t[1] === 'Helvetica-Bold',
        size: Number(t[2]),
        x: Number(t[3]),
        y: Number(t[4]),
        text: Buffer.from(t[5], 'hex').toString('latin1'),
      })),
    );
  }
  expect(pages).toHaveLength(form.pages.length);
  return pages;
}

const header = {
  employerRef: '019632261',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  employerAddress: 'Level 12, Menara Satu\n50450 Kuala Lumpur, Wilayah Persekutuan',
  contributionMonth: '08 / 2026',
  contributionMonthCode: '0826',
  contributionPeriodKey: '2026-08',
  payrollPeriodKey: '2026-07',
  printedOn: '12/08/2026',
  repName: '',
  repIc: '',
  repPosition: '',
  repPhone: '',
  repEmail: '',
};
/** Distinct, non-round figures per row so a mis-summed or mis-placed cell cannot agree by accident. */
const rowN = (i: number): BorangARow => ({
  employmentId: `e${i}`,
  memberNo: String(10000000 + i),
  ic: String(800101010000 + i),
  name: `PERSON ${i}`,
  staffNo: `S${i}`,
  wage: Math.round((3000 + i * 13.37) * 100) / 100,
  employer: Math.round((360 + i * 1.61) * 100) / 100,
  employee: Math.round((330 + i * 1.47) * 100) / 100,
  wageRecorded: true,
});
const num = (s: string) => Number(s.replace(/,/g, ''));
const sen = (n: number) => Math.round(n * 100);

describe('the drawn page totals reconcile to the rows drawn on it', () => {
  const { columns: COL } = BORANG_A_SHEET_GEOMETRY;
  /** The money text right-aligned into a column whose right edge is `right` (3pt of padding). */
  const inColumn = (sheet: Drawn[], left: number, right: number, y: number) =>
    sheet.filter((d) => d.x > left && d.x < right && Math.abs(d.y - y) < 0.01 && /^[\d,]+\.\d\d$/.test(d.text));

  it.each([1, 2, 3])('at %s sheet(s): carried in + this sheet = carried out, and JUMLAH = every row', async (sheets) => {
    const rows = Array.from({ length: BORANG_A_ROWS_PER_PAGE * (sheets - 1) + 7 }, (_, i) => rowN(i));
    const form = borangAFrom({ header, rows });
    expect(form.pages).toHaveLength(sheets);
    const drawn = await drawnPages(form);

    let carried = { er: 0, ee: 0 };
    let allEr = 0;
    let allEe = 0;
    let allWage = 0;
    for (const [n, sheet] of drawn.entries()) {
      const isLast = n === drawn.length - 1;
      const bfLabel = sheet.find((d) => d.text.startsWith('Jumlah yang dibawa dari'))!;
      const cfLabel = sheet.find((d) => d.text.startsWith('Jumlah yang dibawa ke'))!;
      // THE CARRY ROWS ARE ON EVERY SHEET.
      expect(bfLabel, `sheet ${n + 1} has no brought-forward row`).toBeDefined();
      expect(cfLabel, `sheet ${n + 1} has no carried-forward row`).toBeDefined();
      const bfEr = inColumn(sheet, COL.employer, COL.employee, bfLabel.y);
      const bfEe = inColumn(sheet, COL.employee, COL.end, bfLabel.y);
      const cfEr = inColumn(sheet, COL.employer, COL.employee, cfLabel.y);
      const cfEe = inColumn(sheet, COL.employee, COL.end, cfLabel.y);
      // BLANK, NEVER 0.00: nothing is carried INTO sheet one, nothing OUT of the last sheet.
      if (n === 0) expect([...bfEr, ...bfEe].map((d) => d.text), 'sheet 1 brought forward').toEqual([]);
      else {
        expect(sen(num(bfEr[0].text))).toBe(sen(carried.er));
        expect(sen(num(bfEe[0].text))).toBe(sen(carried.ee));
      }
      // The rows on this sheet, read back off the drawn page by their member numbers' baselines.
      const rowYs = sheet.filter((d) => /^1000\d{4}$/.test(d.text)).map((d) => d.y);
      expect(rowYs.length).toBe(form.pages[n].rows.length);
      let er = 0;
      let ee = 0;
      for (const y of rowYs) {
        const w = inColumn(sheet, COL.wage, COL.employer, y);
        const a = inColumn(sheet, COL.employer, COL.employee, y);
        const b = inColumn(sheet, COL.employee, COL.end, y);
        expect([w.length, a.length, b.length]).toEqual([1, 1, 1]);
        allWage += num(w[0].text);
        er += num(a[0].text);
        ee += num(b[0].text);
      }
      allEr += er;
      allEe += ee;
      carried = { er: carried.er + er, ee: carried.ee + ee };
      if (isLast) {
        expect([...cfEr, ...cfEe].map((d) => d.text), 'last sheet carried forward').toEqual([]);
        const jumlah = sheet.find((d) => d.text === 'JUMLAH (RM)')!;
        expect(jumlah).toBeDefined();
        expect(sen(num(inColumn(sheet, COL.wage, COL.employer, jumlah.y)[0].text))).toBe(sen(allWage));
        expect(sen(num(inColumn(sheet, COL.employer, COL.employee, jumlah.y)[0].text))).toBe(sen(allEr));
        expect(sen(num(inColumn(sheet, COL.employee, COL.end, jumlah.y)[0].text))).toBe(sen(allEe));
        // …and the header strip's Amaun Caruman is the same money.
        expect(sheet.some((d) => d.text === money(form.totalContribution))).toBe(true);
      } else {
        expect(sen(num(cfEr[0].text))).toBe(sen(carried.er));
        expect(sen(num(cfEe[0].text))).toBe(sen(carried.ee));
      }
    }
    expect(sen(allEr)).toBe(sen(form.totalEmployer));
    expect(sen(allEe)).toBe(sen(form.totalEmployee));
  });

  it('prints no "0.00" anywhere on a one-row form — every empty box is empty', async () => {
    const [sheet] = await drawnPages(borangAFrom({ header, rows: [rowN(1)] }));
    expect(sheet.filter((d) => d.text === '0.00').map((d) => `${d.text}@${d.x},${d.y}`)).toEqual([]);
  });

  it('drops the "Bulan Upah" box the specimen does not have, and keeps the payroll month in the foot line', async () => {
    const [sheet] = await drawnPages(borangAFrom({ header, rows: [rowN(1)] }));
    expect(sheet.some((d) => d.text.startsWith('Bulan Upah'))).toBe(false);
    expect(sheet.some((d) => d.text === 'Bulan caruman 08 / 2026 · bulan upah 2026-07'.replace('·', '\xb7'))).toBe(true);
    // The Bulan Caruman box carries the specimen's MMYY and nothing else.
    expect(sheet.some((d) => d.text === '0826')).toBe(true);
  });

  it('labels the employer in the frame\'s left margin, as the specimen does', async () => {
    const [sheet] = await drawnPages(borangAFrom({ header, rows: [rowN(1)] }));
    const name = sheet.find((d) => d.text === 'ENGENIOUS SOLUTIONS SDN BHD')!;
    for (const label of ['Nama Majikan', 'Alamat']) {
      const l = sheet.find((d) => d.text === label);
      expect(l, label).toBeDefined();
      expect(l!.x, `${label} is not in the left margin`).toBeLessThan(name.x);
    }
  });
});
