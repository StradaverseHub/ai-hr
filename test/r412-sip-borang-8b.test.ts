/**
 * r412 (item e74af58c, step 2) — THE EIS (SIP) CONTRIBUTION SCHEDULE AND BORANG 8B. DB-FREE.
 *
 * The kernel half (the schedule's total equals the 8A read's EIS legs for the same selection, Select All
 * renders the same bytes as no selection, bonus-only refused with names, the 8B header off real rows) lives
 * in test/r412-sip-borang-8b-report.test.ts. This file pins the rules, the contracts between files, and the
 * drawn pages' arithmetic read back off the PDFs themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  SIP_ROWS_PER_PAGE,
  missingSipHeader,
  paginateSip,
  sipAmountOf,
  sipContributionMonth,
  sipFrom,
  sipRowsFrom,
  type SipRow,
} from '../lib/sip-contribution';
import { SIP_HEADINGS, SIP_RULED_ROWS, SIP_SHEET, renderSipContributionPdf } from '../lib/sip-contribution-pdf';
import { borang8BFrom, borang8BMonth, missingBorang8BHeader } from '../lib/borang-8b';
import {
  BORANG_8B_RULE,
  BORANG_8B_SENTENCE,
  BORANG_8B_SHEET,
  BORANG_8B_TITLE,
  renderBorang8BPdf,
} from '../lib/borang-8b-pdf';
import { BORANG_8A_ROW_PITCH, BORANG_8A_SHEET } from '../lib/borang-8a-pdf';
import { sipDocumentPairs, sipDocumentQuery, sipHasContributions, sipQuery } from '../app/payroll/sip-contribution/query';
import { reportDestination } from '../app/payroll/statutory-forms/criteria';
import { parseRunSelection } from '../lib/payroll-run-selection';
import { MY_PLANNED_FORMS, MY_REPORTS } from '../localization/my/reports';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with block comments and whole-line `//` comments removed. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** A slice of source between two markers, refusing to be vacuous: both found (`>= 0`) and long. */
function slice(src: string, from: string, to: string, minLength: number): string {
  const a = src.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `marker not found after the first: ${to}`).toBeGreaterThanOrEqual(0);
  const out = src.slice(a, b);
  expect(out.length, `the slice ${from} … ${to} is too short to mean anything`).toBeGreaterThan(minLength);
  return out;
}

// ── Reading a drawn page back ──────────────────────────────────────────────────────────────────────────
type Drawn = { x: number; y: number; size: number; text: string };
/** Every upright string the renderer drew, per page (pdf-lib's Flate streams, WinAnsi hex strings). */
async function drawn(bytes: Uint8Array, expectPages: number): Promise<Drawn[][]> {
  const buf = Buffer.from(bytes);
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
  expect(pages).toHaveLength(expectPages);
  // Non-vacuity: a page read back as no text at all would pass every "nothing drawn here" assertion.
  for (const p of pages) expect(p.length).toBeGreaterThan(20);
  return pages;
}
const sen = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);

// ── The EIS (SIP) schedule: rules ──────────────────────────────────────────────────────────────────────
const SIP_HEADER = {
  employerCode: 'A3101002670X',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  contributionMonth: '072026',
  contributionPeriodKey: '2026-07',
  payrollPeriodKey: '2026-07',
};
/** Distinct, non-round figures per line so a mis-summed or mis-placed cell cannot agree by accident. */
const sipRowN = (i: number): SipRow => ({
  employmentId: `e${i}`,
  employerCode: SIP_HEADER.employerCode,
  ic: String(800101010000 + i),
  name: `PERSON ${i}`,
  contributionMonth: '072026',
  contribution: Math.round((12.2 + i * 0.37) * 100) / 100,
});

describe('the EIS (SIP) schedule takes its figure from the 8A read, and calculates nothing', () => {
  it('adds the two EIS legs the 8A read kept apart — and nothing else (not SOCSO, not the 8A column)', () => {
    expect(sipAmountOf({ eisEmployer: 7.9, eisEmployee: 7.9, socsoEmployer: 69.05, socsoEmployee: 19.75, contribution: 88.8 })).toBe(15.8);
    expect(sipAmountOf({ eisEmployer: '6.10', eisEmployee: '6.10' })).toBe(12.2);
    expect(sipAmountOf({})).toBe(0);
  });

  it('repeats the employer code and the MMYYYY month on every line, keeps the read’s order', () => {
    const { rows, omitted } = sipRowsFrom(
      [
        { employmentId: 'a', ic: '1', name: 'AAA', eisEmployer: 6.1, eisEmployee: 6.1 },
        { employmentId: 'b', ic: '2', name: 'BBB', eisEmployer: 9.9, eisEmployee: 9.9 },
      ],
      { employerCode: 'A3101002670X', contributionMonth: '072026' },
    );
    expect(omitted).toEqual([]);
    expect(rows.map((r) => [r.name, r.employerCode, r.contributionMonth, r.contribution])).toEqual([
      ['AAA', 'A3101002670X', '072026', 12.2],
      ['BBB', 'A3101002670X', '072026', 19.8],
    ]);
  });

  it('leaves a person with NO EIS charged off the schedule — named, never a 0.00 line', () => {
    const { rows, omitted } = sipRowsFrom(
      [
        { employmentId: 'a', name: 'AAA', eisEmployer: 6.1, eisEmployee: 6.1 },
        { employmentId: 'z', name: 'ZZZ EXEMPT', eisEmployer: 0, eisEmployee: 0 },
      ],
      { employerCode: 'X', contributionMonth: '072026' },
    );
    expect(rows.map((r) => r.name)).toEqual(['AAA']);
    expect(omitted).toEqual([{ employmentId: 'z', name: 'ZZZ EXEMPT' }]);
  });

  it('stamps the payroll month itself as MMYYYY, through the 8A no-offset rule, across a year end', () => {
    expect(sipContributionMonth('2026-07')).toBe('072026');
    expect(sipContributionMonth('2026-12')).toBe('122026');
    expect(sipContributionMonth('2027-01')).toBe('012027');
    expect(() => sipContributionMonth('2026-13')).toThrow();
  });

  it('names the header gaps the schedule cannot be produced without', () => {
    expect(missingSipHeader(SIP_HEADER)).toEqual([]);
    expect(missingSipHeader({ ...SIP_HEADER, employerCode: ' ' })).toEqual(['employerCode']);
    expect(missingSipHeader({ ...SIP_HEADER, employerName: '' })).toEqual(['employerName']);
  });

  it('calls a selection with no EIS on it "nothing to file", and anything else something', () => {
    expect(sipHasContributions([])).toBe(false);
    expect(sipHasContributions([{ contribution: 0 }, { contribution: null }])).toBe(false);
    expect(sipHasContributions([{ contribution: 0 }, { contribution: 0.01 }])).toBe(true);
  });
});

describe('the EIS (SIP) schedule paginates, and every sheet reconciles to the lines drawn on it', () => {
  it('rules the sheet for exactly the pagination’s lines', () => {
    expect(SIP_RULED_ROWS).toBe(SIP_ROWS_PER_PAGE);
    expect(paginateSip(Array.from({ length: SIP_ROWS_PER_PAGE }, (_, i) => sipRowN(i)))).toHaveLength(1);
    expect(paginateSip(Array.from({ length: SIP_ROWS_PER_PAGE + 1 }, (_, i) => sipRowN(i)))).toHaveLength(2);
  });

  it.each([1, 2, 3])('at %s sheet(s): every line, every page total, the Total and n/N reconcile', async (sheets) => {
    const rows = Array.from({ length: SIP_ROWS_PER_PAGE * (sheets - 1) + 7 }, (_, i) => sipRowN(i));
    const form = sipFrom({ header: SIP_HEADER, rows });
    expect(form.pages).toHaveLength(sheets);
    // The model: the sheets' totals add to the form total, to the sen.
    expect(form.pages.reduce((a, p) => a + Math.round(p.pageTotal * 100), 0)).toBe(Math.round(form.total * 100));
    expect(Math.round(form.total * 100)).toBe(rows.reduce((a, r) => a + Math.round(r.contribution * 100), 0));

    const pages = await drawn(await renderSipContributionPdf(form), sheets);
    const C = SIP_SHEET.columns;
    let all = 0;
    let bil = 0;
    for (const [n, sheet] of pages.entries()) {
      // The JUMLAH CARUMAN cells of the lines on this sheet, top to bottom, read back as money.
      const amounts = sheet
        .filter((d) => d.x >= C.jumlah && d.x < C.end && /^-?[\d,]+\.\d\d$/.test(d.text))
        .sort((a, b) => b.y - a.y);
      const lines = form.pages[n].rows.length;
      // Lines, then "Jumlah muka surat ini", then — on the last sheet only — "Total".
      expect(amounts).toHaveLength(lines + 1 + (n === sheets - 1 ? 1 : 0));
      const lineSum = amounts.slice(0, lines).reduce((a, d) => a + sen(d.text), 0);
      for (const [i, d] of amounts.slice(0, lines).entries()) {
        expect(sen(d.text), `sheet ${n + 1} line ${i + 1}`).toBe(Math.round(form.pages[n].rows[i].contribution * 100));
      }
      expect(sen(amounts[lines].text), `sheet ${n + 1}: Jumlah muka surat ini = the lines drawn on it`).toBe(lineSum);
      expect(sheet.some((d) => d.text.startsWith(`Jumlah muka surat ini (Lembaran ${n + 1}/${sheets})`))).toBe(true);
      expect(sheet.some((d) => d.text === `Lembaran ${n + 1}/${sheets}`)).toBe(true);
      all += lineSum;
      // BIL runs ACROSS sheets: 1…N, never restarting.
      const bils = sheet
        .filter((d) => d.x >= C.bil && d.x < C.kod && /^\d+$/.test(d.text))
        .sort((a, b) => b.y - a.y)
        .map((d) => Number(d.text));
      expect(bils).toEqual(Array.from({ length: lines }, (_, i) => bil + i + 1));
      bil += lines;
      // The employer code on EVERY line.
      expect(sheet.filter((d) => d.x >= C.kod && d.x < C.ic && d.text === SIP_HEADER.employerCode)).toHaveLength(lines);
      if (n === sheets - 1) expect(sen(amounts[lines + 1].text), 'Total').toBe(Math.round(form.total * 100));
      else expect(sheet.some((d) => d.text === 'Total :')).toBe(false);
    }
    expect(all).toBe(Math.round(form.total * 100));
  });

  it('draws the sample’s headings and nothing the sample does not have — no declaration, no signature', async () => {
    const [sheet] = await drawn(await renderSipContributionPdf(sipFrom({ header: SIP_HEADER, rows: [sipRowN(1)] })), 1);
    const text = sheet.map((d) => d.text).join(' | ');
    for (const h of SIP_HEADINGS) for (const l of h.lines) expect(text, l).toContain(l);
    for (const l of ['PERTUBUHAN KESELAMATAN SOSIAL', 'JADUAL CARUMAN BAGI SISTEM INSURANS PEKERJAAN (SIP)', 'NAMA MAJIKAN*', 'KOD MAJIKAN*']) {
      expect(text).toContain(l);
    }
    expect(text).toContain(SIP_HEADER.employerName);
    for (const banned of [/tandatangan/i, /akuan/i, /signature/i, /declar/i, /cop majikan/i, /official/i]) {
      expect(text, String(banned)).not.toMatch(banned);
    }
    // The provenance says what it is, and is not.
    expect(text).toMatch(/not a PERKESO form/);
  });

  it('fits every heading line inside its own column', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const f = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (const h of SIP_HEADINGS) {
      for (const l of h.lines) {
        expect(f.widthOfTextAtSize(l, SIP_SHEET.headSize), `${h.key}: ${l}`).toBeLessThan(h.x2 - h.x1 - 4);
      }
    }
  });
});

// ── Borang 8B ──────────────────────────────────────────────────────────────────────────────────────────
const B_HEADER = {
  employerCode: 'B3201005082P',
  mycoid: '202301012345',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  employerAddress: 'Level 12, Menara Satu\n50450 Kuala Lumpur, Wilayah Persekutuan',
  contributionMonth: '03 / 2026',
  contributionPeriodKey: '2026-03',
  signatoryName: 'TAN MEI LING',
  signatoryPhone: '03-2770 1234',
};

describe('Borang 8B: the header filled, every employee line blank', () => {
  it('stamps the UNDERPAID month as chosen, and refuses a malformed one', () => {
    expect(borang8BMonth('2026-03')).toEqual({ contributionMonth: '03 / 2026', contributionPeriodKey: '2026-03' });
    expect(borang8BMonth('2026-12')).toEqual({ contributionMonth: '12 / 2026', contributionPeriodKey: '2026-12' });
    expect(() => borang8BMonth('2026-00')).toThrow();
  });

  it('blocks on the employer code and legal name only (MyCoID, address and signatory print empty)', () => {
    expect(missingBorang8BHeader(B_HEADER)).toEqual([]);
    expect(missingBorang8BHeader({ ...B_HEADER, mycoid: '', employerAddress: '', signatoryName: '', signatoryPhone: '' })).toEqual([]);
    expect(missingBorang8BHeader({ ...B_HEADER, employerCode: '' })).toEqual(['employerCode']);
    expect(missingBorang8BHeader({ ...B_HEADER, employerName: '' })).toEqual(['employerName']);
  });

  it('draws NO digit in any of the twenty employee lines, nor in any total, count or sheet box', async () => {
    const [sheet] = await drawn(await renderBorang8BPdf(borang8BFrom(B_HEADER)), 1);
    const S = BORANG_8B_SHEET;
    // The employee band: from the heading band's foot down to the page-total row, full table width.
    const inLines = sheet.filter(
      (d) => d.y < S.rows.top - 1 && d.y > S.rows.bottom && d.x >= S.table.x1 && d.x < S.table.x2,
    );
    expect(inLines.filter((d) => /\d/.test(d.text)), 'a digit in an employee line').toEqual([]);
    expect(inLines.filter((d) => /[A-Za-z]/.test(d.text)), 'any text in an employee line').toEqual([]);
    const inRun = (r: { x: number; pitch: number; n: number; y: number; h: number }) =>
      sheet.filter((d) => d.x >= r.x - 1 && d.x < r.x + r.pitch * r.n && d.y > r.y - 1 && d.y < r.y + r.h && /\d/.test(d.text));
    for (const [name, run] of Object.entries({
      amaunRm: S.amaunRm,
      amaunSen: S.amaunSen,
      pageTotalRm: S.pageTotalRm,
      pageTotalSen: S.pageTotalSen,
      lembaran: S.lembaran,
      lembaranOf: S.lembaranOf,
      bilPekerja: S.bilPekerja,
      slipBayaran: S.slipBayaran,
      noCek: S.noCek,
    })) {
      expect(inRun(run), name).toEqual([]);
    }
    expect(sheet.filter((d) => /0\.00/.test(d.text))).toEqual([]);
  });

  it('fills the employer, the month and the PERKESO signatory — and no deadline', async () => {
    const [sheet] = await drawn(await renderBorang8BPdf(borang8BFrom(B_HEADER)), 1);
    const S = BORANG_8B_SHEET;
    const run = (r: { x: number; pitch: number; n: number; y: number; h: number }) =>
      sheet
        .filter((d) => d.x >= r.x && d.x < r.x + r.pitch * r.n && d.y > r.y && d.y < r.y + r.h)
        .sort((a, b) => a.x - b.x)
        .map((d) => d.text)
        .join('');
    expect(run(S.kod)).toBe('B3201005082P');
    expect(run(S.mycoid)).toBe('202301012345');
    expect(run(S.bulan)).toBe('03');
    expect(run(S.tahun)).toBe('2026');
    const text = sheet.map((d) => d.text);
    for (const l of [BORANG_8B_TITLE, BORANG_8B_RULE, BORANG_8B_SENTENCE, 'BORANG 8B', 'ENGENIOUS SOLUTIONS SDN BHD', 'TAN MEI LING', '03-2770 1234']) {
      expect(text, l).toContain(l);
    }
    // The 8B's sentence ends "yang dilantik": no date anywhere on the page.
    expect(text.filter((t) => /\d{2}\/\d{2}\/\d{4}/.test(t))).toEqual([]);
    expect(text.join(' ')).not.toMatch(/tidak lewat daripada/);
    // The signatory sits on the Nama rule and beside No. Tel — the foot's left block, nowhere else.
    const nm = sheet.find((d) => d.text === 'TAN MEI LING')!;
    expect(nm.x).toBeGreaterThan(BORANG_8A_SHEET.signRules[1].x1);
    expect(Math.abs(nm.y - BORANG_8A_SHEET.signRules[1].y)).toBeLessThan(4);
  });

  it('leaves the Nama and No. Tel empty when the company has no PERKESO signatory', async () => {
    const [sheet] = await drawn(
      await renderBorang8BPdf(borang8BFrom({ ...B_HEADER, signatoryName: '', signatoryPhone: '' })),
      1,
    );
    const foot = sheet.filter((d) => d.x > 100 && d.x < 240 && d.y > 55 && d.y < 100);
    expect(foot).toEqual([]);
  });

  it('is the 8A’s measured sheet below the header — the schedule geometry is shared, not re-typed', () => {
    for (const k of ['table', 'rows', 'columns', 'rowRm', 'rowSen', 'pageTotalRm', 'pageTotalSen', 'ticks', 'noCek', 'signRules', 'kod', 'slipBayaran'] as const) {
      expect(BORANG_8B_SHEET[k], k).toBe(BORANG_8A_SHEET[k]);
    }
    expect(BORANG_8A_ROW_PITCH).toBeGreaterThan(19);
    // …and the header boxes PERKESO moved on the 8B are its own (measured; see lib/borang-8b-pdf.ts).
    expect(BORANG_8B_SHEET.bulan.x).not.toBe(BORANG_8A_SHEET.bulan.x);
    expect(BORANG_8B_SHEET.lembaranSplit).not.toBe(BORANG_8A_SHEET.lembaranSplit);
  });
});

// ── The catalog, the criteria step and the surfaces ─────────────────────────────────────────────────────
describe('both forms left the planned list and joined the catalog', () => {
  const sip = MY_REPORTS.find((r) => r.id === 'my.sip-contribution')!;
  const b8b = MY_REPORTS.find((r) => r.id === 'my.borang-8b')!;

  it('registers the SIP schedule with the cycles criterion, Continue opening its preview', () => {
    expect(sip.runSelection).toEqual({ action: '/payroll/sip-contribution/preview' });
    const d = reportDestination(sip.id, sip.periodKind, sip.runSelection, sip.preview);
    expect(d.action).toBe('/payroll/sip-contribution/preview');
    expect(d.criteria.map((c) => c.kind)).toEqual(['company', 'year', 'month', 'cycles']);
    // `figures`, not `agency-layout`: the shared agency-layout caption claims the agency's own form, and
    // the sample is a vendor's report. Never `official`.
    expect(sip.fidelity).toBe('figures');
    const ns = en.payroll.statutoryForms as Record<string, string>;
    expect(ns.fidelity_agency_layout_hint).toMatch(/agency’s own form/);
    expect(sip.shelfOrder).toBe(4);
  });

  it('registers Borang 8B with a MONTH criterion only — no cycles — Continue opening its preview', () => {
    expect(b8b.runSelection).toBeUndefined();
    expect(b8b.preview).toEqual({ action: '/payroll/borang-8b/preview' });
    const d = reportDestination(b8b.id, b8b.periodKind, b8b.runSelection, b8b.preview);
    expect(d.action).toBe('/payroll/borang-8b/preview');
    expect(d.criteria.map((c) => c.kind)).toEqual(['company', 'year', 'month']);
    expect(b8b.fidelity).toBe('agency-layout');
    expect(b8b.shelfOrder).toBe(3);
    // PERKESO's 8B names no deadline, and neither does the catalog.
    expect(b8b.submission?.dueDayOfNextMonth).toBeNull();
  });

  it('keeps SIP 2 / SIP 2A planned, and nothing named 8B or the old "SIP Forms" is still planned', () => {
    const ids = MY_PLANNED_FORMS.map((p) => p.id);
    expect(ids).toContain('perkeso.sip-2');
    expect(ids).not.toContain('perkeso.borang-8b');
    expect(ids).not.toContain('perkeso.sip');
    const ns = en.payroll.statutoryForms as Record<string, string>;
    expect(ns.planned_perkeso_sip_2).toBe('SIP 2 / SIP 2A');
    for (const k of ['planned_perkeso_borang_8b', 'planned_perkeso_borang_8b_hint', 'planned_perkeso_sip', 'planned_perkeso_sip_hint']) {
      expect(ns[k], k).toMatch(/^\[retired r412 — /);
    }
  });

  it('registers both previews in the function-access matrix', () => {
    const perms = read('lib/permissions.ts');
    expect(perms).toContain("'/payroll/sip-contribution/preview',");
    expect(perms).toContain("'/payroll/borang-8b/preview',");
    for (const p of ['app/payroll/sip-contribution/preview/loading.tsx', 'app/payroll/borang-8b/preview/loading.tsx']) {
      expect(fs.existsSync(path.join(ROOT, p)), p).toBe(true);
    }
  });
});

describe('the SIP selection reaches every surface, and the gate runs before anything is drawn', () => {
  const PREVIEW = code('app/payroll/sip-contribution/preview/page.tsx');
  const SHARED = code('app/payroll/sip-contribution/shared.ts');

  it('keeps EVERY value of a repeated run parameter, and NOTHING for all cycles', () => {
    const q = sipQuery({ companyId: 'c', periodKey: '2026-07', run: ['1', '3'] });
    expect(parseRunSelection(q)).toEqual({ ok: true, runSeqs: [1, 3] });
    expect(sipDocumentPairs({ companyId: 'c', periodKey: '2026-07', runSeqs: [1, 3] }).filter((p) => p.name === 'run').map((p) => p.value)).toEqual(['1', '3']);
    expect(sipDocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: undefined })).toBe('companyId=c&periodKey=2026-07');
  });

  it('frames and links the viewer with the selection-carrying query', () => {
    const viewer = slice(PREVIEW, '<StatutoryPdfViewer', 'sidePanel=', 300);
    expect(viewer).toContain('pdfUrl={`/payroll/sip-contribution/pdf?${documentQuery}&disposition=inline`}');
    expect(viewer).toContain('href: `/payroll/sip-contribution/pdf?${documentQuery}`');
    expect(PREVIEW).toContain('const documentQuery = sipDocumentQuery({ companyId, periodKey, runSeqs });');
    expect(PREVIEW).toContain('const query = sipQuery(sp);');
  });

  it('refuses before anything is drawn: invalid, no runs, nothing selected, nothing to file', () => {
    const GATE_START = 'if (!selection.ok) redirect(';
    const gate = slice(PREVIEW, GATE_START, 'const monthFmt', 600);
    for (const reason of ['cycles_invalid', 'cycles_no_runs', 'cycles_no_data']) expect(gate, reason).toContain(`'${reason}'`);
    expect(gate).toContain('listFilableRunsForPeriod(');
    expect(gate).toContain("loaded.reason === 'no-contributions'");
    const before = PREVIEW.slice(0, PREVIEW.indexOf(GATE_START));
    expect(before.length).toBeGreaterThan(500);
    expect(before).not.toContain('sipDocumentQuery(');
    expect(before).not.toContain('<StatutoryPdfViewer');
  });

  it('asks "anything to file?" only when nobody is named — so bonus-only keeps its named refusal', () => {
    const NO_DATA = "if (missing.length === 0 && !sipHasContributions(result.rows)) return { ok: false, reason: 'no-contributions' };";
    const READY = 'if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete)';
    expect(SHARED.indexOf(NO_DATA)).toBeGreaterThan(0);
    expect(SHARED.indexOf(READY)).toBeGreaterThan(SHARED.indexOf(NO_DATA));
    // The readiness list is the 8A read's, passed through untouched.
    expect(code('localization/my/sip-contribution.ts')).toContain('readiness: base.readiness,');
    expect(code('localization/my/sip-contribution.ts')).toContain('const base = await borang8AReport(ctx, params);');
  });

  it("serves the preview as the download's own bytes, only the disposition differs", () => {
    for (const r of ['app/payroll/sip-contribution/pdf/route.ts', 'app/payroll/borang-8b/pdf/route.ts']) {
      const c = code(r);
      expect(c, r).toContain("q.get('disposition') === 'inline' ? 'inline' : 'attachment'");
      expect(c.match(/render\w+Pdf\(/g), r).toHaveLength(1);
    }
  });

  it('the 8B preview has no cycles box and no "nothing to file" gate, and scopes like its siblings', () => {
    const B = code('app/payroll/borang-8b/preview/page.tsx');
    const BS = code('app/payroll/borang-8b/shared.ts');
    expect(B.length).toBeGreaterThan(2000);
    expect(B).not.toContain('parseRunSelection');
    expect(B).not.toContain('cyclesRefusalHref');
    expect(BS).toContain('const { s, scopeIds } = await scopedAdmin();');
    expect(BS).toContain("if (!scopeIds.includes(p.companyId)) return { ok: false, reason: 'not-found' };");
    expect(BS).not.toContain('isAdmin');
  });
});
