/**
 * r408 (item e74af58c, step 1) — BORANG 8A: CHOOSE THE PAYROLL CYCLES, CONTINUE, LOOK, DOWNLOAD — and the
 * redraw to PERKESO's own page 1.
 *
 * DB-FREE. The kernel half (Select All renders the same bytes as no selection; a bonus-only selection is
 * refused by name; B / H / M off real employment rows, a death included) lives in
 * test/borang-8a-report.test.ts beside r372's own cycle fixture. This file pins the CONTRACTS between files —
 * where r407 found both of Borang A's defects — the status rule, and the drawn page's arithmetic read back
 * off the PDF itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  borang8ADocumentPairs,
  borang8ADocumentQuery,
  borang8AHasContributions,
  borang8AQuery,
} from '../app/payroll/borang-8a/query';
import { reportDestination } from '../app/payroll/statutory-forms/criteria';
import { parseRunSelection } from '../lib/payroll-run-selection';
import { MY_REPORTS } from '../localization/my/reports';
import { borang8AStatusFor } from '../localization/my/borang-8a';
import { BORANG_8A_ROWS_PER_PAGE, borang8AFrom, type Borang8ARow } from '../lib/borang-8a';
import { BORANG_8A_RULED_ROWS, BORANG_8A_SHEET, renderBorang8APdf } from '../lib/borang-8a-pdf';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with block comments and whole-line `//` comments removed. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PREVIEW = read('app/payroll/borang-8a/preview/page.tsx');
const PREVIEW_CODE = code('app/payroll/borang-8a/preview/page.tsx');
const SHARED_CODE = code('app/payroll/borang-8a/shared.ts');
const PDF_ROUTE_CODE = code('app/payroll/borang-8a/pdf/route.ts');

/**
 * A slice of source between two markers, REFUSING to be vacuous: both markers must be found (`>= 0`, never
 * truthy) and the slice must be substantial (CLAUDE.md §8, r373).
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

describe('the 8A entry declares the cycles criterion', () => {
  it('asks for Company, Year, Month and Payroll Cycle, and Continue opens the 8A preview', () => {
    const def = MY_REPORTS.find((r) => r.id === 'my.borang-8a')!;
    expect(def.runSelection).toEqual({ action: '/payroll/borang-8a/preview' });
    const d = reportDestination(def.id, def.periodKind, def.runSelection);
    expect(d.action).toBe('/payroll/borang-8a/preview');
    expect(d.criteria.map((c) => c.kind)).toEqual(['company', 'year', 'month', 'cycles']);
    expect(d.criteria.find((c) => c.kind === 'cycles')!.field).toBe('run');
  });
});

describe('the cycle selection and the typed statuses reach every Borang 8A surface', () => {
  it('keeps EVERY value of a repeated run parameter', () => {
    const q = borang8AQuery({ companyId: 'c', periodKey: '2026-07', run: ['1', '3'] });
    expect(q.getAll('run')).toEqual(['1', '3']);
    expect(parseRunSelection(q)).toEqual({ ok: true, runSeqs: [1, 3] });
    expect(borang8AQuery({ run: '2' }).getAll('run')).toEqual(['2']);
  });

  it('carries the selection in the one list every surface is built from, and NOTHING for all cycles', () => {
    const picked = borang8ADocumentPairs({ companyId: 'c', periodKey: '2026-07', runSeqs: [1, 3] });
    expect(picked.filter((p) => p.name === 'run').map((p) => p.value)).toEqual(['1', '3']);
    // SELECT ALL ⇒ `undefined` ⇒ not one `run` on the URL: the same request as before cycles existed.
    expect(borang8ADocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: undefined })).toBe(
      'companyId=c&periodKey=2026-07',
    );
  });

  it('repeats a typed status BY VALUE — an untouched box is carried nowhere', () => {
    const q = new URLSearchParams('st_a=T&st_b=&st_c=%20%20&companyId=x&run=2');
    expect(borang8ADocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: [2], query: q })).toBe(
      'companyId=c&periodKey=2026-07&run=2&st_a=T',
    );
  });

  it('frames and links the viewer with the same selection-carrying query, and the schedule form too', () => {
    const viewer = slice(PREVIEW_CODE, '<StatutoryPdfViewer', 'sidePanel=', 400);
    expect(viewer).toContain('pdfUrl={`/payroll/borang-8a/pdf?${documentQuery}&disposition=inline`}');
    for (const route of ['pdf', 'text', 'file']) {
      expect(viewer).toContain(`href: \`/payroll/borang-8a/${route}?\${documentQuery}\``);
    }
    expect(PREVIEW_CODE).toContain(
      'const documentQuery = borang8ADocumentQuery({ companyId, periodKey, runSeqs, query });',
    );
    expect(PREVIEW_CODE).toContain('const query = borang8AQuery(sp);');
    const form = slice(PREVIEW, '<form method="get" action="/payroll/borang-8a/preview">', '</form>', 4000);
    expect(form).toContain('hiddenPairs.map(');
    for (const route of ['/payroll/borang-8a/pdf', '/payroll/borang-8a/text', '/payroll/borang-8a/file']) {
      expect(form, route).toContain(`formAction="${route}"`);
    }
    expect(PREVIEW_CODE).toContain('const hiddenPairs = borang8ADocumentPairs({ companyId, periodKey, runSeqs });');
    // The pre-r408 shape — hand-written companyId / periodKey hidden inputs and no `run` — is gone.
    expect(form).not.toContain('<input type="hidden" name="companyId"');
  });

  it("serves the preview as the download's own bytes, only the disposition differs", () => {
    expect(PDF_ROUTE_CODE).toContain("q.get('disposition') === 'inline' ? 'inline' : 'attachment'");
    expect(PDF_ROUTE_CODE.match(/renderBorang8APdf\(/g)).toHaveLength(1);
  });
});

describe('the Continue gate', () => {
  it('refuses before anything is drawn: invalid, no runs, nothing selected, nothing to file', () => {
    const GATE_START = 'if (!selection.ok) redirect(';
    const gate = slice(PREVIEW_CODE, GATE_START, 'const monthFmt', 600);
    for (const reason of ['cycles_invalid', 'cycles_no_runs', 'cycles_no_data']) expect(gate, reason).toContain(`'${reason}'`);
    expect(gate).toContain('listFilableRunsForPeriod(');
    expect(gate).toContain("loaded.reason === 'selection-empty'");
    expect(gate).toContain("loaded.reason === 'no-contributions'");
    const before = PREVIEW_CODE.slice(0, PREVIEW_CODE.indexOf(GATE_START));
    expect(before).not.toContain('borang8ADocumentQuery(');
    expect(before).not.toContain('<StatutoryPdfViewer');
    // …decided in the LOADER, so the form's downloads refuse the same selection (the ASSIST file does not).
    for (const r of ['pdf', 'text']) {
      expect(code(`app/payroll/borang-8a/${r}/route.ts`)).toContain("loaded.reason === 'no-contributions'");
    }
    expect(SHARED_CODE).toContain("if (loaded.reason === 'no-contributions') return { ok: false, status: 422, message: NO_CONTRIBUTIONS };");
  });

  /**
   * THE ORDER IS THE BONUS-ONLY RULE. "Nothing to file" is asked only when nobody is named, so a bonus-only
   * selection — every row named with the SOCSO-not-in-this-selection reason — keeps the named refusal it
   * has had since r373, and every download stays held by the `not-ready` gate after it.
   */
  it('asks "anything to file?" only when nobody is named, and before the readiness gate', () => {
    const NO_DATA = "if (p.refuseEmpty !== false && missing.length === 0 && !borang8AHasContributions(result.rows)) return { ok: false, reason: 'no-contributions' };";
    // The ASSIST upload file keeps building a no-SOCSO month (the form's refusal, not the filing's — as r407).
    expect(code('app/payroll/borang-8a/shared.ts')).toContain('const loaded = await loadBorang8A({ ...p, refuseEmpty: false });');
    const READY = 'if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete)';
    expect(SHARED_CODE.indexOf(NO_DATA)).toBeGreaterThan(0);
    expect(SHARED_CODE.indexOf(READY)).toBeGreaterThan(SHARED_CODE.indexOf(NO_DATA));
    expect(SHARED_CODE.indexOf("if (result.meta.selectionEmpty) return { ok: false, reason: 'selection-empty' };")).toBeLessThan(
      SHARED_CODE.indexOf(NO_DATA),
    );
  });

  it('calls a selection with no SOCSO on it "nothing to file", and anything else something', () => {
    expect(borang8AHasContributions([])).toBe(false);
    expect(borang8AHasContributions([{ contribution: 0 }, { contribution: '0' }, { contribution: null }])).toBe(false);
    expect(borang8AHasContributions([{ contribution: 0 }, { contribution: 0.01 }])).toBe(true);
    expect(borang8AHasContributions([{ contribution: 69.25 }])).toBe(true);
  });

  it('has words for the refusal on the step, in English', () => {
    const sf = en.payroll.statutoryForms as Record<string, string>;
    expect(sf.refusal_cycles_no_data).toMatch(/nothing was produced/);
  });
});

describe('column (2) STATUS — B / H / M from the records', () => {
  const P = '2026-07';
  it.each([
    [{ startIso: '2024-03-01', stopIso: null, terminationType: null }, ''],
    [{ startIso: '2026-07-14', stopIso: null, terminationType: null }, 'B'],
    [{ startIso: '2026-07-01', stopIso: null, terminationType: null }, 'B'],
    [{ startIso: '2026-06-30', stopIso: null, terminationType: null }, ''],
    [{ startIso: '2024-03-01', stopIso: '2026-07-31', terminationType: 'voluntary' }, 'H'],
    [{ startIso: '2024-03-01', stopIso: '2026-07-31', terminationType: null }, 'H'],
    [{ startIso: '2024-03-01', stopIso: '2026-07-09', terminationType: 'death' }, 'M'],
    // A death in another month is not this month's: nothing.
    [{ startIso: '2024-03-01', stopIso: '2026-08-02', terminationType: 'death' }, ''],
    // Joined and left in the same month: the later event wins, and column (1) still shows both dates.
    [{ startIso: '2026-07-02', stopIso: '2026-07-25', terminationType: 'contract_end' }, 'H'],
    [{ startIso: '2026-07-02', stopIso: '2026-07-25', terminationType: 'death' }, 'M'],
    // r408 verify D1 — left on the 5th, rejoined on the 20th: at the end of the month they are employed, B.
    [{ startIso: '2026-07-20', stopIso: '2026-07-05', terminationType: 'voluntary' }, 'B'],
    // Same day in and out: the leaving code.
    [{ startIso: '2026-07-10', stopIso: '2026-07-10', terminationType: 'voluntary' }, 'H'],
  ] as const)('%o in %s → %s', (p, expected) => {
    expect(borang8AStatusFor(p, P)).toBe(expected);
  });

  it('carries the agency’s own code list, and S / T stay typed', () => {
    const ns = en.payroll.borang8a as Record<string, string>;
    expect(ns.statusHintDerived).toMatch(/\bB\b[\s\S]*\bH\b[\s\S]*\bM\b/);
    expect(ns.statusHintDerived).toMatch(/\bS\b[\s\S]*\bT\b/);
    expect(ns.statusHint).toMatch(/^\[retired r408 — /);
  });
});

// ── The drawn page ───────────────────────────────────────────────────────────────────────────────────

type Drawn = { x: number; y: number; size: number; text: string };
/** Every upright string the renderer drew, per sheet (pdf-lib's Flate streams, WinAnsi hex strings). */
async function drawnPages(form: ReturnType<typeof borang8AFrom>): Promise<Drawn[][]> {
  const buf = Buffer.from(await renderBorang8APdf(form));
  const OP = /\/(Helvetica(?:-Bold)?)-\d+ ([\d.]+) Tf[\s\S]{0,60}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g;
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

const HEADER = {
  employerCode: 'B3201005082P',
  mycoid: '',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  employerAddress: 'Level 12, Menara Satu\n50450 Kuala Lumpur, Wilayah Persekutuan',
  contributionMonth: '07 / 2026',
  contributionPeriodKey: '2026-07',
  payrollPeriodKey: '2026-07',
  paymentDueDate: '15/08/2026',
};
/** Distinct, non-round figures per row so a mis-summed or mis-placed cell cannot agree by accident. */
const rowN = (i: number): Borang8ARow => ({
  employmentId: `e${i}`,
  startDate: '',
  stopDate: '',
  status: '',
  ic: String(800101010000 + i),
  name: `PERSON ${i}`,
  contribution: Math.round((40 + i * 1.37) * 100) / 100,
  socsoEmployer: 0,
  socsoEmployee: 0,
  eisEmployer: 0,
  eisEmployee: 0,
  wage: null,
  skbbk: 0,
});

/** The digits drawn into a run of boxes on the band [y0, y1], read left to right. */
function digitsIn(sheet: Drawn[], run: { x: number; pitch: number; n: number }, y0: number, y1: number): string {
  return sheet
    .filter((d) => d.x >= run.x && d.x < run.x + run.pitch * run.n && d.y > y0 && d.y < y1 && /^[\d-]$/.test(d.text))
    .sort((a, b) => a.x - b.x)
    .map((d) => d.text)
    .join('');
}
const cents = (rm: string, sen: string) => Number(rm || 'NaN') * 100 + Number(sen || 'NaN');

describe('the drawn page is the agency’s sheet, and its totals reconcile to the rows drawn on it', () => {
  const S = BORANG_8A_SHEET;

  it('rules exactly the agency’s 20 rows per sheet, and paginates at 20', async () => {
    expect(BORANG_8A_RULED_ROWS).toBe(20);
    expect(BORANG_8A_ROWS_PER_PAGE).toBe(20);
    expect(borang8AFrom({ header: HEADER, rows: Array.from({ length: 20 }, (_, i) => rowN(i)) }).pages).toHaveLength(1);
    expect(borang8AFrom({ header: HEADER, rows: Array.from({ length: 21 }, (_, i) => rowN(i)) }).pages).toHaveLength(2);
    // The ruled rows span the agency's own band, heading foot to "Jumlah muka surat ini".
    expect(S.rows.top).toBe(S.headBottom);
    expect(S.rows.bottom).toBeGreaterThan(S.pageTotalRm.y + S.pageTotalRm.h - 0.1);
  });

  it.each([1, 2, 3])('at %s sheet(s): every row, every page total and the form total reconcile', async (sheets) => {
    const rows = Array.from({ length: BORANG_8A_ROWS_PER_PAGE * (sheets - 1) + 7 }, (_, i) => rowN(i));
    const form = borang8AFrom({ header: HEADER, rows });
    expect(form.pages).toHaveLength(sheets);
    const drawn = await drawnPages(form);
    const pitch = (S.rows.top - S.rows.bottom) / S.rows.count;
    let all = 0;
    for (const [n, sheet] of drawn.entries()) {
      let pageSum = 0;
      let drawnRows = 0;
      for (let i = 0; i < S.rows.count; i += 1) {
        const foot = S.rows.top - (i + 1) * pitch;
        const rm = digitsIn(sheet, S.rowRm, foot, foot + pitch);
        const sen = digitsIn(sheet, S.rowSen, foot, foot + pitch);
        const r = form.pages[n].rows[i];
        if (!r) {
          // AN UNUSED LINE ASSERTS NOTHING: no digits at all, never 0.00.
          expect(rm + sen, `sheet ${n + 1} row ${i + 1} is unused and must be empty`).toBe('');
          continue;
        }
        expect(cents(rm, sen), `sheet ${n + 1} row ${i + 1}`).toBe(Math.round(r.contribution * 100));
        pageSum += cents(rm, sen);
        drawnRows += 1;
      }
      expect(drawnRows).toBe(form.pages[n].rows.length);
      const ptRm = digitsIn(sheet, S.pageTotalRm, S.pageTotalRm.y, S.pageTotalRm.y + S.pageTotalRm.h);
      const ptSen = digitsIn(sheet, S.pageTotalSen, S.pageTotalSen.y, S.pageTotalSen.y + S.pageTotalSen.h);
      expect(cents(ptRm, ptSen), `sheet ${n + 1}: Jumlah muka surat ini = the rows drawn on it`).toBe(pageSum);
      all += pageSum;
      // Amaun Caruman in the header is the WHOLE form's total, on every sheet.
      const amRm = digitsIn(sheet, S.amaunRm, S.amaunRm.y, S.amaunRm.y + S.amaunRm.h);
      const amSen = digitsIn(sheet, S.amaunSen, S.amaunSen.y, S.amaunSen.y + S.amaunSen.h);
      expect(cents(amRm, amSen)).toBe(Math.round(form.total * 100));
      // Lembaran n / N and Bil. Pekerja.
      expect(digitsIn(sheet, S.lembaran, S.lembaran.y, S.lembaran.y + S.lembaran.h)).toBe(String(n + 1));
      expect(digitsIn(sheet, S.lembaranOf, S.lembaranOf.y, S.lembaranOf.y + S.lembaranOf.h)).toBe(String(sheets));
      expect(digitsIn(sheet, S.bilPekerja, S.bilPekerja.y, S.bilPekerja.y + S.bilPekerja.h)).toBe(String(rows.length));
    }
    expect(all).toBe(Math.round(form.total * 100));
  });

  it('prints no "0.00", no MyCoID when there is none, and nothing in the operator’s or agent’s boxes', async () => {
    const [sheet] = await drawnPages(borang8AFrom({ header: HEADER, rows: [rowN(1)] }));
    expect(sheet.filter((d) => d.text === '0.00')).toEqual([]);
    expect(digitsIn(sheet, S.mycoid, S.mycoid.y, S.mycoid.y + S.mycoid.h)).toBe('');
    expect(digitsIn(sheet, S.slipBayaran, S.slipBayaran.y, S.slipBayaran.y + S.slipBayaran.h)).toBe('');
    expect(digitsIn(sheet, S.noCek, S.noCek.y, S.noCek.y + S.noCek.h)).toBe('');
    // The employer code goes one character per box, from the first.
    const kod = sheet
      .filter((d) => d.x >= S.kod.x && d.x < S.kod.x + S.kod.pitch * S.kod.n && d.y > S.kod.y && d.y < S.kod.y + S.kod.h)
      .sort((a, b) => a.x - b.x)
      .map((d) => d.text)
      .join('');
    expect(kod).toBe('B3201005082P');
    // The deadline is the form's own, beside the agency's sentence.
    expect(sheet.some((d) => d.text === '15/08/2026')).toBe(true);
    // The month and year go one digit per box.
    expect(digitsIn(sheet, S.bulan, S.bulan.y, S.bulan.y + S.bulan.h)).toBe('07');
    expect(digitsIn(sheet, S.tahun, S.tahun.y, S.tahun.y + S.tahun.h)).toBe('2026');
  });

  it('draws a value longer than its boxes WHOLE rather than cutting it', async () => {
    const long = { ...HEADER, employerCode: 'B3201005082PXYZ' };
    const [sheet] = await drawnPages(borang8AFrom({ header: long, rows: [rowN(1)] }));
    expect(sheet.some((d) => d.text === 'B3201005082PXYZ')).toBe(true);
    // A typed status wider than the narrow (2) column is shrunk, not truncated.
    const typed = borang8AFrom({ header: HEADER, rows: [{ ...rowN(1), status: 'BERHENTI' }] });
    const [s2] = await drawnPages(typed);
    const st = s2.find((d) => d.text === 'BERHENTI')!;
    expect(st).toBeDefined();
    expect(st.size).toBeLessThan(8);
  });

  it('reproduces neither page 2’s guidance, nor the OCR ids, nor the logo, nor the false footer', () => {
    const src = code('lib/borang-8a-pdf.ts');
    for (const absent of ['PANDUAN MENGISI', 'RM3000', 'RM3,000', '2346249101', '3659249109', 'embedPng', 'embedJpg', 'publishes no blank']) {
      expect(src, absent).not.toContain(absent);
    }
  });
});
