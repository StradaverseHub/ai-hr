/**
 * r409 (item 79f3f64d, step 1) — LHDN: CP39 JOINS THE CYCLES WORKFLOW, FORM E / CP8D GETS A YEAR-ONLY PREVIEW,
 * THE TWO CP39 PRINTING FIXES, AND THE CP22A LABEL.
 *
 * DB-FREE. The kernel half (Select All renders the same bytes as no selection; a cycle subset filters the
 * printed statement) lives in test/cp39-form-report.test.ts beside the read it drives. This file pins:
 *
 *   1. THE DRAWN PAGE. One "E" before the employer number on the cover AND on every sheet; a digits-only
 *      identity card number; the tax number exactly as stored; 26 rows a sheet; and JUMLAH / JUMLAH BESAR
 *      read back OFF THE PAGE reconciling to the rows drawn on it at one, two and three sheets.
 *   2. NON-VACUITY, BY REVERTING EACH FIX IN A COPY. The model and the renderer are copied, the fix is
 *      undone in the copy, the copy is rendered, and the assertion that guards the fix must FAIL on it. A
 *      guard that passes on the code it exists to forbid is not a guard.
 *   3. THE CONTRACTS BETWEEN FILES — where r407 found both of Borang A's defects, and where CP39 had them
 *      too: a repeated `run` dropped by the screen's query conversion, and downloads built without `run`.
 *   4. THE LABELS: the retired CP22A pair, the new keys in six locales, CP22B recorded as not applicable,
 *      CP39A still planned.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, type PDFRawStream } from 'pdf-lib';
import {
  CP39_FORM_ROWS_PER_PAGE,
  cp39EmployerNoForForm,
  cp39FormFrom,
  cp39IcForForm,
  formatMyIc,
  missingCp39FormHeader,
  money,
  type Cp39Form,
  type Cp39FormRow,
} from '../lib/cp39-form';
import { CP39_TABLE_COLUMNS, cp39ColumnSpan, renderCp39FormPdf } from '../lib/cp39-form-pdf';
import { cp39DocumentPairs, cp39DocumentQuery, cp39HasDeductions, cp39Query } from '../app/payroll/cp39/query';
import {
  CYCLES_REFUSALS,
  criteriaReturnHref,
  cyclesRefusalHref,
  defaultCriteria,
  parseDestination,
  reportDestination,
} from '../app/payroll/statutory-forms/criteria';
import { parseRunSelection } from '../lib/payroll-run-selection';
import {
  MY_NOT_APPLICABLE_FORMS,
  MY_PLANNED_FORMS,
  MY_REPORTS,
  MY_STATUTORY_LINKS,
} from '../localization/my/reports';
import { REGISTERED_ROUTES } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with block comments and whole-line `//` comments removed. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * A slice of source between two markers, REFUSING to be vacuous: both markers must be found (`>= 0`, never
 * truthy — -1 is truthy) and the slice must be substantial. A renamed marker otherwise turns every assertion
 * on the slice into an assertion about the empty string (CLAUDE.md §8, r373).
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

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

const header = (p: Record<string, string> = {}) => ({
  employerNo: 'E0094573909',
  registrationNo: '199801012345',
  employerName: 'ISEDECOR BINA SDN BHD',
  employerAddress: 'Level 12, Menara Satu\n50450 Kuala Lumpur, Wilayah Persekutuan',
  deductionPeriodKey: '2026-01',
  deductionMonth: 'JANUARI',
  deductionMonthNo: '01',
  deductionYear: '2026',
  printedOn: '18/08/2026',
  preparerName: 'CHONG PEI YUH',
  preparerIc: '910416145530',
  preparerPosition: 'ASSISTANT MANAGER',
  preparerPhone: '0123081733',
  ...p,
});

/** Distinct, non-round figures per row so a mis-summed or mis-placed cell cannot agree by accident. */
const rowN = (i: number, p: Partial<Cp39FormRow> = {}): Record<string, unknown> => ({
  employmentId: `e${i}`,
  personId: `p${i}`,
  tin: `SG${String(20000000000 + i)}`,
  name: `PERSON ${String(i).padStart(3, '0')}`,
  oldIc: '',
  newIc: String(800101010000 + i),
  employeeNo: `S${i}`,
  passport: '',
  countryCode: '',
  pcb: Math.round((100 + i * 3.37) * 100) / 100,
  cp38: i % 4 === 0 ? Math.round((40 + i * 1.11) * 100) / 100 : 0,
  ...p,
});

// ── Reading the drawn page back ──────────────────────────────────────────────────────────────────────

type Run = { text: string; x: number; y: number; size: number; bold: boolean };

/** Every text run, PER PAGE IN PAGE ORDER, with its origin. pdf-lib writes `/F size Tf … 1 0 0 1 x y Tm <hex> Tj`. */
async function pagesOf(bytes: Uint8Array): Promise<Run[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const c = page.node.Contents();
    const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
    const runs: Run[] = [];
    for (const ref of refs) {
      const obj = (doc.context.lookup(ref) ?? ref) as unknown as PDFRawStream;
      const raw = obj.contents;
      if (!raw) continue;
      let stream: string;
      try {
        stream = zlib.inflateSync(Buffer.from(raw)).toString('latin1');
      } catch {
        stream = Buffer.from(raw).toString('latin1');
      }
      let size = 0;
      let bold = false;
      const re = /\/(Helvetica[A-Za-z0-9-]*)\s+([\d.]+)\s+Tf|1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g;
      for (const m of stream.matchAll(re)) {
        if (m[1]) {
          size = Number(m[2]);
          bold = m[1].includes('Bold');
        } else {
          runs.push({ text: Buffer.from(m[5], 'hex').toString('latin1'), x: Number(m[3]), y: Number(m[4]), size, bold });
        }
      }
    }
    return runs;
  });
}

const num = (s: string) => Number(s.replace(/,/g, ''));
const sen = (n: number) => Math.round(n * 100);

/** How many times the employer number is preceded by an "E" on one page, in reading order. */
function eTokensBeforeEmployerNo(runs: Run[], digits: string): { eTokens: number; numberRuns: Run[] } {
  // "E" as its own drawn run (the form's printed letter) or as the head of a run ("E0094…", "E 0094…").
  const numberRuns = runs.filter((r) => r.text.replace(/[^0-9]/g, '').includes(digits) && /\d/.test(r.text));
  const standalone = runs.filter((r) => r.text.trim() === 'E');
  const prefixed = numberRuns.filter((r) => /^\s*[Ee]\s*\d/.test(r.text));
  return { eTokens: standalone.length + prefixed.length, numberRuns };
}

// ── 1 & 2. The drawn page, and the non-vacuity of each fix ─────────────────────────────────────────

/**
 * A COPY of the model and the renderer, with one fix undone, importable like the real ones.
 *
 * Written under `node_modules/.cache/` so `pdf-lib` and the model's own relative import resolve exactly as
 * they do for the originals, and so nothing lands in a tracked directory. Removed when the file finishes.
 */
const COPY_DIR = path.join(ROOT, 'node_modules', '.cache', `r409-nonvacuity-${process.pid}`);
afterAll(() => fs.rmSync(COPY_DIR, { recursive: true, force: true }));

async function revertedRender(
  name: string,
  edits: { model?: [string, string][]; pdf?: [string, string][] },
): Promise<{ cp39FormFrom: typeof cp39FormFrom; renderCp39FormPdf: typeof renderCp39FormPdf }> {
  fs.mkdirSync(path.join(COPY_DIR, name), { recursive: true });
  let model = read('lib/cp39-form.ts').replace("from './unfinished-name'", `from '${path.join(ROOT, 'lib/unfinished-name')}'`);
  let pdf = read('lib/cp39-form-pdf.ts');
  for (const [from, to] of edits.model ?? []) {
    expect(model.includes(from), `the fix to revert is not in lib/cp39-form.ts: ${from}`).toBe(true);
    model = model.replace(from, to);
  }
  for (const [from, to] of edits.pdf ?? []) {
    expect(pdf.includes(from), `the fix to revert is not in lib/cp39-form-pdf.ts: ${from}`).toBe(true);
    pdf = pdf.replace(from, to);
  }
  fs.writeFileSync(path.join(COPY_DIR, name, 'cp39-form.ts'), model);
  fs.writeFileSync(path.join(COPY_DIR, name, 'cp39-form-pdf.ts'), pdf);
  const m = await import(path.join(COPY_DIR, name, 'cp39-form.ts'));
  const p = await import(path.join(COPY_DIR, name, 'cp39-form-pdf.ts'));
  return { cp39FormFrom: m.cp39FormFrom, renderCp39FormPdf: p.renderCp39FormPdf };
}

/** The fixed rule, as one predicate, so the real code and every reverted copy are judged the same way. */
async function singleEOnEveryPage(bytes: Uint8Array, digits: string): Promise<string[]> {
  const pages = await pagesOf(bytes);
  const problems: string[] = [];
  for (const [i, runs] of pages.entries()) {
    const { eTokens, numberRuns } = eTokensBeforeEmployerNo(runs, digits);
    if (numberRuns.length === 0) problems.push(`page ${i + 1}: the employer number is not drawn`);
    if (eTokens !== 1) problems.push(`page ${i + 1}: ${eTokens} "E" tokens before the employer number`);
  }
  return problems;
}

describe('the employer number prints ONE "E", on the cover and on every sheet', () => {
  // Shapes seen on production (6 of 9 companies carry the prefix) and the ones a person types.
  it.each([
    ['E0094573909', '0094573909'],
    ['E 908915-10', '908915-10'],
    ['e 9089151 10', '9089151 10'],
    ['  E  0094573909 ', '0094573909'],
    ['E-0094573909', '0094573909'],
    ['e - 908915-10', '908915-10'],
    ['0094573909', '0094573909'],
  ])('%j prints as %j', (stored, printed) => {
    expect(cp39EmployerNoForForm(stored)).toBe(printed);
    expect(cp39FormFrom({ header: header({ employerNo: stored }), rows: [] }).employerNo).toBe(printed);
  });

  it('is judged AS PRINTED by the header gate: a stored "E" alone is a missing employer number', () => {
    expect(missingCp39FormHeader(header({ employerNo: 'E' }))).toEqual(['employerNo']);
    expect(missingCp39FormHeader(header({ employerNo: ' e ' }))).toEqual(['employerNo']);
    expect(missingCp39FormHeader(header({ employerNo: 'E0094573909' }))).toEqual([]);
  });

  it.each([['E0094573909'], ['E 0094573909'], ['0094573909']])(
    'stored %j: exactly one E on the cover and on each of three sheets',
    async (stored) => {
      const rows = Array.from({ length: CP39_FORM_ROWS_PER_PAGE * 2 + 3 }, (_, i) => rowN(i + 1));
      const form = cp39FormFrom({ header: header({ employerNo: stored }), rows });
      expect(form.pages).toHaveLength(3);
      const bytes = await renderCp39FormPdf(form);
      expect(await pagesOf(bytes)).toHaveLength(4); // the cover + three sheets
      expect(await singleEOnEveryPage(bytes, '0094573909')).toEqual([]);
    },
  );

  it('NON-VACUOUS: with the strip reverted in a copy, an E-prefixed number prints the E twice', async () => {
    const copy = await revertedRender('employer-e', {
      model: [['employerNo: cp39EmployerNoForForm(h.employerNo),', 'employerNo: str(h.employerNo),']],
    });
    const rows = Array.from({ length: CP39_FORM_ROWS_PER_PAGE + 2 }, (_, i) => rowN(i + 1));
    const bytes = await copy.renderCp39FormPdf(copy.cp39FormFrom({ header: header({ employerNo: 'E0094573909' }), rows }));
    const problems = await singleEOnEveryPage(bytes, '0094573909');
    // Every page fails — the cover and both sheets — which is the claim "pinned on every sheet" rests on.
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.includes('2 "E" tokens'))).toBe(true);
  });
});

describe('the identity card number prints as digits only; the screen still dashes it', () => {
  it.each([
    ['941128035179', '941128035179'],
    ['941128-03-5179', '941128035179'],
    ['941128 03 5179', '941128035179'],
    ['A1234567', 'A1234567'], // a passport, printed as stored
    ['94112803517', '94112803517'], // eleven digits is not a MyKad: as stored, never rearranged
    ['', ''],
  ])('%j → %j on the form', (stored, printed) => {
    expect(cp39IcForForm(stored)).toBe(printed);
  });

  it('formatMyIc is unchanged, for the screen', () => {
    expect(formatMyIc('941128035179')).toBe('941128-03-5179');
    expect(code('app/payroll/cp39/preview/page.tsx')).toContain('formatMyIc(r.newIc)');
  });

  const icForm = (cff: typeof cp39FormFrom) =>
    cff({
      header: header(),
      rows: [rowN(1, { newIc: '941128-03-5179' }), rowN(2, { newIc: '860208105128' })],
    });

  it('draws twelve digits for a stored dashed number AND for a stored plain one, and no dash anywhere', async () => {
    const drawn = (await pagesOf(await renderCp39FormPdf(icForm(cp39FormFrom)))).flat().map((r) => r.text);
    expect(drawn).toContain('941128035179');
    expect(drawn).toContain('860208105128');
    expect(drawn.filter((t) => /\d{6}-\d{2}-\d{4}/.test(t))).toEqual([]);
  });

  it('NON-VACUOUS: with the model half reverted, a stored dashed number prints dashed', async () => {
    const copy = await revertedRender('ic-model', {
      model: [['newIc: cp39IcForForm(r.newIc ?? r.ic),', 'newIc: str(r.newIc ?? r.ic),']],
    });
    const drawn = (await pagesOf(await copy.renderCp39FormPdf(icForm(copy.cp39FormFrom)))).flat().map((r) => r.text);
    expect(drawn).toContain('941128-03-5179');
    expect(drawn).not.toContain('941128035179');
  });

  it('NON-VACUOUS: with the renderer half reverted, a stored plain number is dashed on the way to the page', async () => {
    const copy = await revertedRender('ic-pdf', {
      pdf: [
        ["import { cp39ScheduleScopeNote, money,", "import { cp39ScheduleScopeNote, formatMyIc, money,"],
        ["left('newIc', r.newIc);", "left('newIc', formatMyIc(r.newIc));"],
      ],
    });
    const drawn = (await pagesOf(await copy.renderCp39FormPdf(icForm(copy.cp39FormFrom)))).flat().map((r) => r.text);
    expect(drawn).toContain('860208-10-5128');
    expect(drawn).not.toContain('860208105128');
  });
});

describe('the tax number is printed exactly as stored', () => {
  it.each([['SG23607354000'], ['OG 1234567-08'], ['sg10000000002']])('%j', async (tin) => {
    const form = cp39FormFrom({ header: header(), rows: [rowN(1, { tin })] });
    expect(form.pages[0].rows[0].tin).toBe(tin);
    const drawn = (await pagesOf(await renderCp39FormPdf(form))).flat().map((r) => r.text);
    expect(drawn).toContain(tin);
  });
});

describe('26 rows a sheet, and the totals reconcile to the rows drawn', () => {
  it('rules the sheet for 26', () => {
    expect(CP39_FORM_ROWS_PER_PAGE).toBe(26);
  });

  const inSpan = (runs: Run[], key: string, y: number) => {
    const s = cp39ColumnSpan(CP39_TABLE_COLUMNS.find((c) => c.key === key)!);
    return runs.filter((r) => r.x >= s.left - 0.5 && r.x <= s.right + 0.5 && Math.abs(r.y - y) < 0.01 && /^[\d,]+\.\d\d$/.test(r.text));
  };

  it.each([1, 2, 3])('at %s sheet(s): every row drawn once, JUMLAH = that sheet, JUMLAH BESAR = every row', async (sheets) => {
    const count = CP39_FORM_ROWS_PER_PAGE * (sheets - 1) + 7;
    const rows = Array.from({ length: count }, (_, i) => rowN(i + 1));
    const form: Cp39Form = cp39FormFrom({ header: header(), rows });
    expect(form.pages).toHaveLength(sheets);
    const pages = await pagesOf(await renderCp39FormPdf(form));
    expect(pages).toHaveLength(sheets + 1);
    const sheetsDrawn = pages.slice(1);

    let allPcb = 0;
    let allCp38 = 0;
    for (const [n, runs] of sheetsDrawn.entries()) {
      const isLast = n === sheetsDrawn.length - 1;
      // The rows, found by the employee names this fixture gives them.
      const names = runs.filter((r) => /^PERSON \d{3}$/.test(r.text));
      expect(names.length, `sheet ${n + 1} rows`).toBe(isLast ? count - CP39_FORM_ROWS_PER_PAGE * (sheets - 1) : 26);
      let pcb = 0;
      let cp38 = 0;
      for (const nm of names) {
        const p = inSpan(runs, 'pcb', nm.y);
        const c = inSpan(runs, 'cp38', nm.y);
        expect([p.length, c.length], `row ${nm.text}`).toEqual([1, 1]);
        pcb += num(p[0].text);
        cp38 += num(c[0].text);
      }
      allPcb += pcb;
      allCp38 += cp38;
      const jumlah = runs.filter((r) => r.text === 'JUMLAH');
      expect(jumlah, `sheet ${n + 1} JUMLAH`).toHaveLength(1);
      const money2 = runs.filter((r) => Math.abs(r.y - jumlah[0].y) < 0.01 && /^[\d,]+\.\d\d$/.test(r.text)).sort((a, b) => a.x - b.x);
      expect(money2.map((r) => r.text), `sheet ${n + 1} JUMLAH boxes`).toHaveLength(2);
      expect(sen(num(money2[0].text))).toBe(sen(pcb));
      expect(sen(num(money2[1].text))).toBe(sen(cp38));
      const besar = runs.filter((r) => r.text === 'JUMLAH BESAR');
      if (isLast) {
        expect(besar).toHaveLength(1);
        const v = runs.filter((r) => Math.abs(r.y - besar[0].y) < 0.01 && /^[\d,]+\.\d\d$/.test(r.text));
        expect(v).toHaveLength(1);
        expect(sen(num(v[0].text))).toBe(sen(allPcb + allCp38));
      } else {
        // ON THE LAST SHEET ONLY — never a page total mistaken for the grand total, never a 0.00 box.
        expect(besar, `sheet ${n + 1} must not carry JUMLAH BESAR`).toEqual([]);
      }
    }
    expect(sen(allPcb)).toBe(sen(form.totalPcb));
    expect(sen(allCp38)).toBe(sen(form.totalCp38));
    expect(sen(form.totalAmount)).toBe(sen(form.totalPcb + form.totalCp38));
    // …and the cover's AMAUN is the same money.
    expect(pages[0].some((r) => r.text === money(form.totalAmount))).toBe(true);
  });
});

// ── 3. The contracts between files ──────────────────────────────────────────────────────────────────

const PREVIEW = read('app/payroll/cp39/preview/page.tsx');
const PREVIEW_CODE = code('app/payroll/cp39/preview/page.tsx');

describe('the cycle selection reaches every CP39 surface', () => {
  it('keeps EVERY value of a repeated run parameter', () => {
    const q = cp39Query({ companyId: 'c', periodKey: '2026-07', run: ['1', '3'] });
    expect(q.getAll('run')).toEqual(['1', '3']);
    expect(parseRunSelection(q)).toEqual({ ok: true, runSeqs: [1, 3] });
    expect(cp39Query({ run: '2' }).getAll('run')).toEqual(['2']);
  });

  it('carries the selection in the one list, and NOTHING for all cycles (Select All = no selection)', () => {
    const picked = cp39DocumentPairs({ companyId: 'c', periodKey: '2026-07', runSeqs: [1, 3] });
    expect(picked.filter((p) => p.name === 'run').map((p) => p.value)).toEqual(['1', '3']);
    expect(cp39DocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: undefined })).toBe(
      'companyId=c&periodKey=2026-07',
    );
  });

  it('repeats the applied preparer and payment inputs on the viewer links, and leaves out blank ones', () => {
    const q = new URLSearchParams('prepName=CHONG&prepIc=&date=2026-08-18&payRef=CHQ 1&payBranch=');
    expect(cp39DocumentQuery({ companyId: 'c', periodKey: '2026-07', runSeqs: [2], query: q })).toBe(
      'companyId=c&periodKey=2026-07&run=2&prepName=CHONG&date=2026-08-18&payRef=CHQ+1',
    );
  });

  it('builds the schedule form, the frame and every download from that list', () => {
    const form = slice(PREVIEW, '<form method="get" action="/payroll/cp39/preview">', '</form>', 3000);
    expect(form).toContain('hiddenPairs.map(');
    for (const route of ['/payroll/cp39/pdf', '/payroll/cp39/text', '/payroll/reports/cp39-file']) {
      expect(form, `${route} is not a download of this form`).toContain(`formAction="${route}"`);
    }
    expect(PREVIEW_CODE).toContain('const hiddenPairs = cp39DocumentPairs({ companyId, periodKey, runSeqs });');
    expect(PREVIEW_CODE).toContain('const documentQuery = cp39DocumentQuery({ companyId, periodKey, runSeqs, query });');
    expect(PREVIEW_CODE).toContain('const query = cp39Query(sp);');
    const viewer = slice(PREVIEW_CODE, '<StatutoryPdfViewer', 'sidePanel=', 300);
    expect(viewer).toContain('pdfUrl={`/payroll/cp39/pdf?${documentQuery}&disposition=inline`}');
    for (const route of ['/payroll/cp39/pdf', '/payroll/cp39/text', '/payroll/reports/cp39-file']) {
      expect(viewer).toContain(`href: \`${route}?\${documentQuery}\``);
    }
  });

  it('serves the preview as the download\'s own bytes; only the disposition differs', () => {
    const route = code('app/payroll/cp39/pdf/route.ts');
    expect(route).toContain("q.get('disposition') === 'inline' ? 'inline' : 'attachment'");
    expect(route.match(/renderCp39FormPdf\(/g)).toHaveLength(1);
  });

  it('the loader parses the selection once and hands it to the read', () => {
    const shared = code('app/payroll/cp39/shared.ts');
    expect(shared).toContain('const selection = parseRunSelection(p.query);');
    expect(shared).toContain('runSeqs: selection.runSeqs,');
    expect(shared).toContain("if (result.meta.selectionEmpty) return { ok: false, reason: 'selection-empty' };");
    expect(shared).toContain("if (!cp39HasDeductions(result.rows)) return { ok: false, reason: 'no-deductions' };");
  });

  it('the e-Data PCB file route honours the same run parameters, and refuses an invalid one', () => {
    const route = code('app/payroll/reports/cp39-file/route.ts');
    expect(route).toContain('const selection = parseRunSelection(url.searchParams);');
    expect(route).toContain('if (!selection.ok) return new Response(selection.reason, { status: 422 });');
    expect(route).toContain('cp39FileForBatch(s, { companyId, periodKey, runSeqs: selection.runSeqs })');
  });

  it('the printed CP39 read honours runSeqs, and no other report sharing its loader does', () => {
    const reports = code('localization/my/reports.ts');
    expect(reports).toContain('const b = await loadBatchRows(ctx, params, { honourRunSeqs: true });');
    expect(reports.match(/honourRunSeqs: true/g)).toHaveLength(1);
    expect(reports).toContain('const selection = opts.honourRunSeqs ? runSelectionSet(params.runSeqs) : undefined;');
  });
});

describe('the Continue gate', () => {
  it('refuses before anything is drawn: invalid, no runs, ticked cycles absent, nothing deducted', () => {
    const GATE_START = 'if (!selection.ok) redirect(';
    const gate = slice(PREVIEW_CODE, GATE_START, 'const pcbPayments', 600);
    for (const reason of ['cycles_invalid', 'cycles_no_runs', 'cycles_no_data', 'cycles_no_deductions']) {
      expect(gate, reason).toContain(`'${reason}'`);
    }
    expect(gate).toContain('listFilableRunsForPeriod(');
    expect(gate).toContain("loaded.reason === 'no-deductions'");
    const before = PREVIEW_CODE.slice(0, PREVIEW_CODE.indexOf(GATE_START));
    expect(before.length).toBeGreaterThan(500);
    expect(before).not.toContain('cp39DocumentQuery(');
    expect(before).not.toContain('<StatutoryPdfViewer');
    for (const r of ['pdf', 'text']) {
      const src = code(`app/payroll/cp39/${r}/route.ts`);
      for (const reason of ['selection-empty', 'bad-selection', 'no-deductions']) {
        expect(src, `${r} route does not answer ${reason}`).toContain(`loaded.reason === '${reason}'`);
      }
    }
  });

  it('calls a selection nobody was deducted on "nothing to file", and a sen of either something', () => {
    expect(cp39HasDeductions([])).toBe(false);
    expect(cp39HasDeductions([{ pcb: 0, cp38: 0 }, { pcb: '0', cp38: null }])).toBe(false);
    expect(cp39HasDeductions([{ pcb: 0, cp38: 0 }, { pcb: 0.01, cp38: 0 }])).toBe(true);
    expect(cp39HasDeductions([{ pcb: 0, cp38: 200 }])).toBe(true);
  });

  it('sends the operator back with the criteria and an allowlisted refusal, with or without a month', () => {
    const u = new URL(
      cyclesRefusalHref('my.cp39', { companyId: 'c1', year: '2026', month: '07', runSeqs: [2] }, 'cycles_no_deductions'),
      'http://x',
    );
    expect(u.pathname).toBe('/payroll/statutory-forms/open');
    expect(u.searchParams.get('month')).toBe('07');
    expect(u.searchParams.getAll('run')).toEqual(['2']);
    expect(u.searchParams.get('refusal')).toBe('cycles_no_deductions');
    // An annual form's way back has no Month box to fill.
    expect(criteriaReturnHref('my.cp8d', { companyId: 'c1', year: '2026' })).toBe(
      '/payroll/statutory-forms/open?form=my.cp8d&companyId=c1&year=2026',
    );
    expect(CYCLES_REFUSALS).toContain('year_no_payroll');
    const open = code('app/payroll/statutory-forms/open/page.tsx');
    for (const r of ['cycles_no_deductions', 'year_no_payroll']) expect(open).toContain(`${r}: 'refusal_${r}'`);
  });
});

describe('the criteria each form asks for', () => {
  const cp39 = MY_REPORTS.find((r) => r.id === 'my.cp39')!;
  const cp8d = MY_REPORTS.find((r) => r.id === 'my.cp8d')!;

  it('CP39: Company, Year, Month and Payroll Cycle, continuing to its preview', () => {
    const d = reportDestination(cp39.id, cp39.periodKind, cp39.runSelection, cp39.preview);
    expect(d.action).toBe('/payroll/cp39/preview');
    expect(d.criteria.map((c) => c.kind)).toEqual(['company', 'year', 'month', 'cycles']);
    expect(REGISTERED_ROUTES.has('/payroll/cp39/preview')).toBe(true);
  });

  it('Form E / CP8D: Company and Year only — no month, no cycle — continuing to its preview', () => {
    const d = reportDestination(cp8d.id, cp8d.periodKind, cp8d.runSelection, cp8d.preview);
    expect(d.action).toBe('/payroll/cp8d/preview');
    expect(d.criteria.map((c) => c.kind)).toEqual(['company', 'year']);
    expect(REGISTERED_ROUTES.has('/payroll/cp8d/preview')).toBe(true);
    // An annual form is never given cycles. ⚠️ r412 (item e74af58c) — UPDATED, NOT DELETED: a MONTHLY form
    // with its own preview and no cycles (Borang 8B) now continues to that preview with company, year and
    // month; a monthly form that declares cycles still continues to its cycles action, never the preview.
    expect(reportDestination('x', 'month', null, { action: '/y' }).action).toBe('/y');
    expect(reportDestination('x', 'month', null, { action: '/y' }).criteria.map((c) => c.kind)).toEqual(['company', 'year', 'month']);
    expect(reportDestination('x', 'month', { action: '/c' }, { action: '/y' }).action).toBe('/c');
    expect(reportDestination('x', 'year', { action: '/y' }, null).criteria.map((c) => c.kind)).toEqual(['company', 'year']);
  });

  it('the Borang E alias opens the same preview, and both still default to the year being filed', () => {
    const borangE = MY_STATUTORY_LINKS.find((l) => l.id === 'my.borang-e')!;
    const asLink = parseDestination(borangE.href);
    expect(asLink.action).toBe(cp8d.preview!.action);
    expect(borangE.populationReportId).toBe('my.cp8d');
    // Filing season: in March the return being worked on is last year's — for the card AND the alias.
    expect(defaultCriteria('2027-03-05', asLink.criteria, cp8d).year).toBe('2026');
    const asReport = reportDestination(cp8d.id, cp8d.periodKind, null, cp8d.preview);
    expect(defaultCriteria('2027-03-05', asReport.criteria, cp8d).year).toBe('2026');
    // The step resolves a REPORT's own target, not one read back off a preview path that names no report.
    expect(code('app/payroll/statutory-forms/open/page.tsx')).toContain(
      'catalog.reports.find((r) => r.id === report.id)',
    );
  });
});

describe('the Form E / CP8D preview', () => {
  const PAGE = code('app/payroll/cp8d/preview/page.tsx');

  it('frames the PDF the entry has always exported, inline, and downloads the same route', () => {
    const viewer = slice(PAGE, '<StatutoryPdfViewer', 'sidePanel=', 300);
    expect(viewer).toContain('pdfUrl={`${exportBase}&format=pdf&disposition=inline`}');
    for (const f of ['pdf', 'xlsx', 'csv']) expect(viewer).toContain(`href: \`\${exportBase}&format=${f}\``);
    expect(PAGE).toContain('/export?companyId=');
    // No new renderer: the page draws nothing itself.
    expect(PAGE).not.toMatch(/pdf-lib|renderCp8d|PDFDocument/);
    const exportRoute = code('app/payroll/statutory-forms/[formId]/export/route.ts');
    expect(exportRoute).toContain("format === 'pdf' && url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'");
  });

  it('refuses a year with no processed payroll on the criteria step, before any viewer is drawn', () => {
    const gate = slice(PAGE, 'if (!result.meta.hasBatch)', '<StatutoryPdfViewer', 300);
    expect(gate).toContain("'year_no_payroll'");
    expect(PAGE.indexOf('if (!result.meta.hasBatch)')).toBeLessThan(PAGE.indexOf('<StatutoryPdfViewer'));
  });

  it('says what the PDF is, and that the Part A counts are not on it', () => {
    const en = JSON.parse(read('messages/en.json')).payroll.cp8dPreview as Record<string, string>;
    expect(en.notArtwork).toMatch(/our own column layout/);
    expect(en.notArtwork).toMatch(/not LHDN/);
    expect(en.partAHint).toMatch(/not printed on the PDF/);
  });
});

// ── 4. The labels ───────────────────────────────────────────────────────────────────────────────────

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (l: string) => JSON.parse(read(`messages/${l}.json`)) as { payroll: Record<string, Record<string, string>> };

describe('CP22A is labelled as what it is, and CP22B is recorded as not applicable', () => {
  // ⚠️ r413 (item 79f3f64d, step 2) — CP22A WAS BUILT, SO IT IS NO LONGER A PLANNED ROW. It left
  // MY_PLANNED_FORMS for MY_STATUTORY_LINKS (`my.cp22a`, its own `link_cp22a` keys), and r409's planned pair
  // `planned_lhdn_cp22a_cessation(_hint)` is retired in turn. What this case protects is unchanged: CP22A
  // is labelled as the private-sector cessation notice, and no code names a retired key.
  const cp22a = MY_STATUTORY_LINKS.find((p) => p.id === 'my.cp22a')!;

  it('the CP22A uses its own built-form keys, and nothing in the app names a retired pair', () => {
    expect(MY_PLANNED_FORMS.some((p) => p.id === 'lhdn.cp22a')).toBe(false);
    expect(cp22a.labelKey).toBe('link_cp22a');
    expect(cp22a.hintKey).toBe('link_cp22a_hint');
    for (const dir of ['app', 'components', 'core', 'lib', 'localization']) {
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(e.name) && /'planned_lhdn_cp22a(_cessation)?(_hint)?'/.test(read(p))) hits.push(p);
        }
      };
      walk(dir);
      expect(hits, `${dir} still names the retired keys`).toEqual([]);
    }
  });

  it.each(LOCALES)('%s: the old pair is RETIRED (kept, marked), the new pair is real, and neither says clearance', (l) => {
    const sf = catalog(l).payroll.statutoryForms;
    expect(sf.planned_lhdn_cp22a).toMatch(/^\[retired r409/);
    expect(sf.planned_lhdn_cp22a_hint).toMatch(/^\[retired r409/);
    // r413 — the r409 planned pair is retired in its turn; the built form's pair is the real label now.
    expect(sf.planned_lhdn_cp22a_cessation).toMatch(/^\[retired r413/);
    expect(sf.planned_lhdn_cp22a_cessation_hint).toMatch(/^\[retired r413/);
    expect(sf.link_cp22a).toMatch(/^CP22A/);
    expect(sf.link_cp22a_hint.length).toBeGreaterThan(40);
    expect(`${sf.link_cp22a} ${sf.link_cp22a_hint} ${sf.desc_cp22a}`).not.toMatch(/clearance/i);
    if (l !== 'en') {
      const en = catalog('en').payroll.statutoryForms;
      expect(sf.link_cp22a_hint, `${l} is still English`).not.toBe(en.link_cp22a_hint);
    }
    for (const k of ['refusal_cycles_no_deductions', 'refusal_year_no_payroll']) expect(sf[k], `${l} ${k}`).toBeTruthy();
    for (const k of ['cyclesAll', 'viewerBack', 'previewBlocked']) expect(catalog(l).payroll.cp39Form[k], `${l} ${k}`).toBeTruthy();
    for (const k of ['title', 'viewerBack', 'tileYear', 'tileEmployees', 'notArtworkTitle', 'notArtwork', 'partATitle', 'partAHint', 'figuresLink']) {
      expect(catalog(l).payroll.cp8dPreview[k], `${l} cp8dPreview.${k}`).toBeTruthy();
    }
  });

  it('records CP22B as a government-agency form that does not apply — and nowhere on a shelf', () => {
    const cp22b = MY_NOT_APPLICABLE_FORMS.find((f) => f.id === 'lhdn.cp22b');
    expect(cp22b?.reason).toBe('government-agency');
    expect(cp22b?.body).toBe('lhdn');
    const shelved = [...MY_PLANNED_FORMS.map((p) => p.id), ...MY_STATUTORY_LINKS.map((l) => l.id), ...MY_REPORTS.map((r) => r.id)];
    expect(shelved.filter((id) => /cp22b/i.test(id))).toEqual([]);
  });

  it('keeps CP39A planned', () => {
    expect(MY_PLANNED_FORMS.some((p) => p.id === 'lhdn.cp39a')).toBe(true);
  });
});
