/**
 * r411 (item 4f45f9b0) — the re-plan from the reporter's October samples: three Borang A changes and the
 * new BBCD. DB-FREE. The kernel half (the BBCD amount equals the Borang A total for all, regular-only and
 * bonus-only selections; Select All draws the same bytes as no selection) lives in
 * test/borang-a-report.test.ts beside r372's cycle fixture, and the Borang A drawn-total reconciliation at
 * 1, 2 and 3 sheets in test/r407-borang-a-cycles.test.ts, which this round updated rather than duplicated.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { borangAFrom, borangATextExport, money, type BorangARow } from '../lib/borang-a';
import { renderBorangAPdf } from '../lib/borang-a-pdf';
import {
  BBCD_CATATAN,
  BBCD_DECLARATION,
  bbcdMonthName,
  borangBbcdFilename,
  borangBbcdFrom,
  missingBbcdSignatory,
} from '../lib/borang-bbcd';
import { renderBorangBbcdPdf } from '../lib/borang-bbcd-pdf';
import { MY_REPORTS } from '../localization/my/reports';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { reportDestination } from '../app/payroll/statutory-forms/criteria';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (l: string) => JSON.parse(read(`messages/${l}.json`));

/** A slice between two markers that REFUSES to be vacuous (CLAUDE.md §8): both found, and long. */
function slice(src: string, from: string, to: string, minLength: number): string {
  const a = src.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `marker not found after the first: ${to}`).toBeGreaterThanOrEqual(0);
  const out = src.slice(a, b);
  expect(out.length, `the slice ${from} … ${to} is too short to mean anything`).toBeGreaterThan(minLength);
  return out;
}

type Drawn = { x: number; y: number; size: number; bold: boolean; text: string };
/** Every string a pdf-lib PDF drew, per page (the reader test/borang-a.test.ts uses). */
function drawnPages(buf: Buffer): Drawn[][] {
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
  return pages;
}

const header = (over: Record<string, string> = {}) => ({
  employerRef: '019632261',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  employerAddress: 'Level 12, Menara Satu\nJalan Ampang\n50450 Kuala Lumpur, Wilayah Persekutuan',
  contributionMonth: '09 / 2026',
  contributionMonthCode: '0926',
  contributionPeriodKey: '2026-09',
  payrollPeriodKey: '2026-08',
  printedOn: '07/10/2026',
  repName: 'AHMAD BIN ABDULLAH',
  repIc: '800101015555',
  repPosition: 'HR Manager',
  repPhone: '03-1234 5678',
  repEmail: '',
  ...over,
});
const rowN = (i: number): BorangARow => ({
  employmentId: `e${i}`,
  memberNo: String(10000000 + i),
  ic: String(800101010000 + i),
  idKind: 'ic',
  icNumber: String(800101010000 + i),
  name: `PERSON ${i}`,
  staffNo: `S${i}`,
  wage: Math.round((3000 + i * 13.37) * 100) / 100,
  employer: Math.round((360 + i * 1.61) * 100) / 100,
  employee: Math.round((330 + i * 1.47) * 100) / 100,
  wageRecorded: true,
});
const formOf = (n: number, over?: Record<string, string>) =>
  borangAFrom({ header: header(over), rows: Array.from({ length: n }, (_, i) => rowN(i)) });
const flat = (sheet: Drawn[]) => sheet.map((d) => d.text).join('\n');

// ── Borang A ─────────────────────────────────────────────────────────────────────────────────────────

describe('Borang A, to the October sample', () => {
  it('the text twin: B/F from sheet 2, no C/F, and ONE JUMLAH figure equal to Amaun Caruman', () => {
    const form = borangAFrom({ header: header(), rows: Array.from({ length: 5 }, (_, i) => rowN(i)), perPage: 2 });
    const text = borangATextExport(form);
    expect(text).not.toMatch(/dibawa ke mukasurat/);
    const sheets = text.split(/^Mukasurat /m).slice(1);
    expect(sheets).toHaveLength(3);
    expect(sheets.map((s) => /dibawa dari mukasurat/.test(s))).toEqual([false, true, true]);
    const jumlah = text.split('\n').filter((l) => l.includes('JUMLAH (RM)'));
    expect(jumlah).toHaveLength(1);
    // The figures on the JUMLAH line: exactly one, the combined contribution, and no wage total.
    expect(jumlah[0].match(/[\d,]+\.\d\d/g)).toEqual([money(form.totalContribution)]);
    expect(text).not.toContain(money(form.totalWage));
  });

  /**
   * THE UNVERIFIED CLAIM IS GONE: "KWSP publishes no blank form" was printed in the foot note of every sheet,
   * in the text twin, in the review screen's note and in comments, and nobody here had checked it. Lines that
   * QUOTE it in order to say it was removed carry "r411"; nothing else may say it.
   */
  it('no longer claims KWSP publishes no blank form — on the page, in the text, on the screen, in comments', async () => {
    const CLAIM = /KWSP publishes no|KWSP does not publish|publishes no blank (Borang A|form)/i;
    const form = formOf(3);
    const drawn = drawnPages(Buffer.from(await renderBorangAPdf(form))).flat();
    expect(drawn.length).toBeGreaterThan(100);
    expect(drawn.filter((d) => CLAIM.test(d.text)).map((d) => d.text)).toEqual([]);
    // The foot note's sentence that carried it is still there, without it.
    expect(drawn.some((d) => d.text.startsWith('Our own layout, drawn to match Borang A. The CATATAN notes'))).toBe(true);
    expect(borangATextExport(form)).not.toMatch(CLAIM);
    for (const f of [
      'lib/borang-a.ts',
      'lib/borang-a-pdf.ts',
      'localization/my/borang-a.ts',
      'localization/my/reports.ts',
      'app/payroll/borang-a/preview/page.tsx',
      'test/borang-a.test.ts',
      'test/statutory-forms-page.test.ts',
    ]) {
      const src = read(f);
      expect(src.length, f).toBeGreaterThan(2000);
      const asserting = src.split('\n').filter((l) => CLAIM.test(l) && !/r411/.test(l));
      expect(asserting, f).toEqual([]);
    }
  });

  it('retires the screen key in all six locales, and the screen reads its replacement', () => {
    for (const l of LOCALES) {
      const ns = catalog(l).payroll.borangA as Record<string, string>;
      expect(ns.notArtwork, l).toMatch(/^\[retired r411 — /);
      expect(ns.notArtworkDrawn, l).toBeTruthy();
      expect(ns.notArtworkDrawn, l).not.toMatch(/publishes no|does not publish|tidak menerbitkan/i);
      if (l !== 'en') expect(ns.notArtworkDrawn, `${l} is still English`).not.toBe(catalog('en').payroll.borangA.notArtworkDrawn);
    }
    const preview = code('app/payroll/borang-a/preview/page.tsx');
    expect(preview).toContain("t('notArtworkDrawn')");
    expect(preview).not.toContain("t('notArtwork')");
    // No computed key could still reach the retired one.
    expect(preview).not.toMatch(/t\(`notArt/);
  });
});

// ── BBCD ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the BBCD is a projection of the Borang A, never a second calculation', () => {
  it('carries the Borang A total, its contribution month, the payroll month and the company', () => {
    for (const n of [1, 21, 47]) {
      const form = formOf(n);
      const b = borangBbcdFrom(form);
      expect(b.amount).toBe(form.totalContribution);
      // …and that is the rows' own money, to the sen.
      const sen = form.pages.flatMap((p) => p.rows).reduce((a, r) => a + Math.round(r.employer * 100) + Math.round(r.employee * 100), 0);
      expect(Math.round(b.amount * 100)).toBe(sen);
      expect(b.contributionMonthCode).toBe('0926');
      expect(b.contributionMonthName).toBe('September 2026');
      expect(b.payrollMonthName).toBe('August 2026');
      expect(b.employerAddress).toEqual(form.employerAddress);
    }
    // The contribution month follows the Borang A's, override included — it is not recomputed here.
    const moved = { ...formOf(2), contributionPeriodKey: '2026-11', contributionMonthCode: '1126' };
    expect(borangBbcdFrom(moved).contributionMonthName).toBe('November 2026');
    expect(bbcdMonthName('2026-12')).toBe('December 2026');
    expect(bbcdMonthName('junk')).toBe('junk');
    expect(borangBbcdFilename(borangBbcdFrom(formOf(1)))).toBe('borang-bbcd-019632261-202609.pdf');
  });

  it('has no read of its own: both surfaces call loadBorangA, and nothing under borang-bbcd reads the pack', () => {
    const shared = code('app/payroll/borang-bbcd/shared.ts');
    expect(shared).toContain("import { loadBorangA, type BorangALoad } from '../borang-a/shared';");
    expect(shared).toContain('const loaded = await loadBorangA(p);');
    expect(shared).toContain('const bbcd = borangBbcdFrom(loaded.form);');
    for (const f of ['app/payroll/borang-bbcd/shared.ts', 'app/payroll/borang-bbcd/pdf/route.ts', 'app/payroll/borang-bbcd/preview/page.tsx', 'lib/borang-bbcd.ts', 'lib/borang-bbcd-pdf.ts']) {
      const src = code(f);
      expect(src.length, f).toBeGreaterThan(500);
      expect(src, f).not.toMatch(/reportPreview\(|localization\/my|from '@\/db|totalEmployer \+|\.reduce\(/);
    }
    expect(code('app/payroll/borang-bbcd/pdf/route.ts')).toContain('const loaded = await loadBorangBbcd({');
    expect(code('app/payroll/borang-bbcd/preview/page.tsx')).toContain('const loaded = await loadBorangBbcd({');
  });
});

describe('the drawn BBCD, laid out like the sample', () => {
  it('fills every box the sample fills, from the Borang A', async () => {
    const form = formOf(23);
    const pages = drawnPages(Buffer.from(await renderBorangBbcdPdf(borangBbcdFrom(form))));
    expect(pages).toHaveLength(1);
    const [sheet] = pages;
    const text = flat(sheet);
    for (const s of [
      'KUMPULAN WANG SIMPANAN PEKERJA',
      '(BORANG BAYARAN CARUMAN BULANAN - PITA/DISKET (BBCD))',
      'SISTEM PENGHANTARAN DATA PITA/DISKET',
      'JADUAL CARUMAN BULAN September 2026',
      'No. Rujukan Majikan',
      'Bulan Caruman',
      'Amaun Caruman',
      '019632261',
      '0926',
      money(form.totalContribution),
      'ENGENIOUS SOLUTIONS SDN BHD',
      'Level 12, Menara Satu',
      'Jalan Ampang',
      '50450 Kuala Lumpur, Wilayah Persekutuan',
      'Cop Agen Kutipan',
      'AHMAD BIN ABDULLAH',
      '800101015555',
      'HR Manager',
      '03-1234 5678',
      'HURUF BESAR',
      'MAJIKAN/WAKIL MAJIKAN',
      'CATATAN:',
      'Wang Tunai',
    ]) {
      expect(text, s).toContain(s);
    }
    // "untuk potongan gaji bulan August 2026" — the PAYROLL month, in the payment instruction (wrapped).
    expect(text.replace(/\n/g, ' ')).toContain('(untuk potongan gaji bulan August 2026) hendaklah');
    // The declaration and CATATAN 1-3, word for word (wrapped across lines).
    const joined = sheet.map((d) => d.text).join(' ');
    expect(joined).toContain(BBCD_DECLARATION);
    for (const note of BBCD_CATATAN) expect(joined, note).toContain(note);
    // Amaun Caruman appears exactly ONCE: the box. No second total, no per-employee figure.
    expect(sheet.filter((d) => /^[\d,]+\.\d\d$/.test(d.text)).map((d) => d.text)).toEqual([money(form.totalContribution)]);
  });

  it('prints no logo and fills none of the blanks: ticks, cheque number, signature, Cop Agen Kutipan', async () => {
    const buf = Buffer.from(await renderBorangBbcdPdf(borangBbcdFrom(formOf(3))));
    expect(buf.toString('latin1')).not.toMatch(/\/Subtype\s*\/Image/);
    const [sheet] = drawnPages(buf);
    // The ticks are bracket pairs with nothing between them.
    expect(sheet.filter((d) => d.text === '[').length).toBe(2);
    expect(sheet.some((d) => /^[xX✓√]$/.test(d.text))).toBe(false);
    // Nothing is written on the TANDATANGAN line: the only text on its baseline is the label and the colon.
    const sig = sheet.find((d) => d.text === 'TANDATANGAN')!;
    expect(sheet.filter((d) => Math.abs(d.y - sig.y) < 2).map((d) => d.text).sort()).toEqual([':', 'TANDATANGAN']);
    // Never 0.00 for money that is not there.
    expect(sheet.some((d) => d.text === '0.00')).toBe(false);
  });

  it('prints the signatory lines EMPTY, and names them before download, when no EPF signatory is set', async () => {
    const empty = { repName: '', repIc: '', repPosition: '', repPhone: '', repEmail: '' };
    const b = borangBbcdFrom(formOf(2, empty));
    expect(missingBbcdSignatory(b)).toEqual(['name', 'ic', 'position', 'phone']);
    // A BBCD has no e-mail line, so an absent e-mail is not a gap here.
    expect(missingBbcdSignatory(borangBbcdFrom(formOf(2, { repEmail: '' })))).toEqual([]);
    expect(missingBbcdSignatory(borangBbcdFrom(formOf(2, { repPhone: '  ' })))).toEqual(['phone']);
    const [sheet] = drawnPages(Buffer.from(await renderBorangBbcdPdf(b)));
    for (const label of ['NAMA PENUH', 'NO KP', 'JAWATAN', 'NO TELEFON']) {
      const l = sheet.find((d) => d.text === label)!;
      expect(l, label).toBeDefined();
      expect(sheet.filter((d) => Math.abs(d.y - l.y) < 2).map((d) => d.text).sort(), label).toEqual([':', label].sort());
    }

    // THE SCREEN: a readiness NOTE, before the download, that never hides it.
    const page = code('app/payroll/borang-bbcd/preview/page.tsx');
    const note = slice(page, 'const signatoryNote =', 'const blanks =', 400);
    expect(note).toContain('signatoryMissing.length > 0 ?');
    expect(note).toContain("t('signatoryMissingTitle')");
    const viewer = slice(page, '<StatutoryPdfViewer', '/>\n    </div>', 500);
    // The download is unconditional on the signatory…
    expect(viewer).toContain("downloads={[{ href: `/payroll/borang-bbcd/pdf?${documentQuery}`, label: t('downloadPdf') }]}");
    // …and the note comes first in the panel beside the form.
    const panel = slice(page, 'sidePanel={', '/>\n    </div>', 40);
    expect(panel.indexOf('{signatoryNote}')).toBeGreaterThanOrEqual(0);
    expect(panel.indexOf('{signatoryNote}')).toBeLessThan(panel.indexOf('{tiles}'));
    // The loader never refuses on it.
    expect(code('app/payroll/borang-bbcd/shared.ts')).not.toMatch(/signatoryMissing[^;]*return \{ ok: false/);
  });
});

describe('the BBCD shelf entry, its path and its refusals', () => {
  const def = MY_REPORTS.find((r) => r.id === 'my.borang-bbcd');
  const borangA = MY_REPORTS.find((r) => r.id === 'my.borang-a');

  it('opens like Borang A: Company, Year, Month, Payroll Cycle, Continue → its own preview', () => {
    expect(def).toBeDefined();
    expect(def!.periodKind).toBe('month');
    expect(def!.runSelection).toEqual({ action: '/payroll/borang-bbcd/preview' });
    // ONE READ: the same generator as Borang A, so the generic screen cannot show a different figure.
    expect(def!.generate).toBe(borangA!.generate);
    expect(def!.submission?.body).toBe('epf');
    expect(def!.fidelity).toBe('agency-layout');
    const d = reportDestination(def!.id, def!.periodKind, def!.runSelection);
    expect(d.criteria.map((c) => c.kind)).toEqual(['company', 'year', 'month', 'cycles']);
    expect(d.action).toBe('/payroll/borang-bbcd/preview');
    for (const l of LOCALES) expect(catalog(l).payroll.statutoryForms[def!.descriptionKey!], l).toBeTruthy();
  });

  it('is a registered screen with a loading state', () => {
    expect(REGISTERED_ROUTES.has('/payroll/borang-bbcd/preview')).toBe(true);
    expect(read('app/payroll/borang-bbcd/preview/loading.tsx').trim()).toBe(
      "export { default } from '@/components/route-loading';",
    );
  });

  it('refuses what Borang A refuses, before anything is drawn', () => {
    const page = code('app/payroll/borang-bbcd/preview/page.tsx');
    const GATE = 'if (!selection.ok) redirect(';
    const gate = slice(page, GATE, 'const monthFmt', 600);
    for (const r of ['cycles_invalid', 'cycles_no_runs', 'cycles_no_data']) expect(gate, r).toContain(`'${r}'`);
    for (const r of ['no-batch', 'selection-empty', 'bad-selection', 'no-contributions']) {
      expect(gate, r).toContain(`loaded.reason === '${r}'`);
    }
    expect(gate).toContain('listFilableRunsForPeriod(');
    expect(gate).toContain('BORANG_BBCD_REPORT_ID');
    const before = page.slice(0, page.indexOf(GATE));
    expect(before).not.toContain('<StatutoryPdfViewer');
    expect(before).not.toContain('borangADocumentQuery(');
    // The PDF route answers every refusal, and frames the same bytes it downloads.
    const route = code('app/payroll/borang-bbcd/pdf/route.ts');
    for (const r of ['not-found', 'no-batch', 'selection-empty', 'bad-selection', 'no-contributions']) {
      expect(route, r).toContain(`loaded.reason === '${r}'`);
    }
    expect(route).toContain("q.get('disposition') === 'inline' ? 'inline' : 'attachment'");
    expect(route.match(/renderBorangBbcdPdf\(/g)).toHaveLength(1);
    // The frame and the download carry the same `run` values, built by Borang A's own list.
    expect(page).toContain('const documentQuery = borangADocumentQuery({ companyId, periodKey, runSeqs, query });');
    expect(page).toContain('pdfUrl={`/payroll/borang-bbcd/pdf?${documentQuery}&disposition=inline`}');
  });

  it('has every key the screen uses in all six locales', () => {
    const page = code('app/payroll/borang-bbcd/preview/page.tsx');
    const used = new Set<string>([
      ...[...page.matchAll(/\bt\('([A-Za-z_]+)'/g)].map((m) => m[1]),
      ...[...page.matchAll(/'((?:sigField|headerField)_[A-Za-z]+)'/g)].map((m) => m[1]),
    ]);
    expect(used.size).toBeGreaterThan(20);
    for (const l of LOCALES) {
      const ns = catalog(l).payroll.borangBbcd as Record<string, string>;
      for (const k of used) expect(ns[k], `${l} payroll.borangBbcd.${k}`).toBeTruthy();
      if (l !== 'en') expect(ns.signatoryMissingHint, `${l} is still English`).not.toBe(catalog('en').payroll.borangBbcd.signatoryMissingHint);
    }
  });
});

describe('r411 · NAMA PENUH is marked HURUF BESAR on the form', () => {
  it('prints the signatory name in capitals, and the other lines as stored', () => {
    const b = borangBbcdFrom(borangAFrom({ header: header({ repName: 'Chong Pei Yuh', repPosition: 'HR Manager' }), rows: [rowN(1)] }));
    expect(b.signatory.name).toBe('CHONG PEI YUH');
    expect(b.signatory.position).toBe('HR Manager');
  });
});

describe('r411 · the review table under the viewer totals the same way as the printed form', () => {
  it('has no carried-forward rows and one JUMLAH of the two contributions', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app/payroll/borang-a/preview/page.tsx'), 'utf8');
    const start = src.indexOf('<tfoot');
    const end = src.indexOf('</tfoot>', start);
    expect(start, 'the review table footer was found').toBeGreaterThanOrEqual(0);
    expect(end, 'the review table footer closes').toBeGreaterThan(start);
    const foot = src.slice(start, end);
    expect(foot.length, 'the footer slice is substantial').toBeGreaterThan(200);
    expect(foot).toContain('money(form.totalContribution)');
    expect(foot).not.toContain("t('pageCarry'");
    expect(foot).not.toContain('form.totalWage');
  });
});
