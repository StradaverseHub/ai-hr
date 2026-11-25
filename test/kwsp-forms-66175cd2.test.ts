/**
 * Board 66175cd2 (plan r1) — EPF (KWSP) statutory forms: the contracts between files, DB-free.
 *
 * Commit 1 — the Open Form step lists only payroll months with processed EPF payroll, for Borang A and BBCD
 * only; every other form keeps the generic Year and Month selects. The query itself is pinned against a real
 * database in test/kwsp-periods-66175cd2.test.ts and the browser behaviour in
 * test/kwsp-period-criterion-66175cd2.dom.test.tsx.
 *
 * Commit 2 — a clear Back at the top left of both forms (viewer behaviour in
 * test/kwsp-viewer-back-66175cd2.dom.test.tsx), and "EPF contributions (KWSP)" off the shelf, its Open Form
 * step and Filing history's forms to produce — while staying registered for everything else that reads it.
 *
 * Commit 3 — Borang A and BBCD redrawn to the reporter's references: the KWSP logo top left from the
 * owner-supplied official file ONLY (a synthetic, fictional PNG stands in for it here — no logo image is in
 * the repository), bold masthead and headings, Borang A's KWSP 6 / BORANG / A block, and no small print of
 * ours at the foot. Read off the rendered PDFs.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { MY_REPORTS } from '../localization/my/reports';
import { STATUTORY_FORM_TYPES } from '../core/payroll-audit/types';
import { PERIODS_ENDPOINT } from '../app/payroll/statutory-forms/criteria';
import { BORANG_A_PERINGATAN_EN, BORANG_A_PERINGATAN_MS, borangAFrom, type BorangARow } from '../lib/borang-a';
import { BORANG_A_SHEET_GEOMETRY, borangAProvenance, renderBorangAPdf } from '../lib/borang-a-pdf';
import { borangBbcdFrom } from '../lib/borang-bbcd';
import { BBCD_GEOMETRY, renderBorangBbcdPdf } from '../lib/borang-bbcd-pdf';
import { KWSP_LOGO_MIN_PX, KWSP_LOGO_PATH, kwspLogoRefusal, pngSize } from '../lib/kwsp-logo';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with block comments, JSX comments and whole-line `//` comments removed. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (l: string) => JSON.parse(read(`messages/${l}.json`));

/** A slice between two markers that REFUSES to be vacuous: both found, and long. */
function slice(src: string, from: string, to: string, minLength: number): string {
  const a = src.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `marker not found after the first: ${to}`).toBeGreaterThanOrEqual(0);
  const out = src.slice(a, b);
  expect(out.length, `the slice ${from} … ${to} is too short to mean anything`).toBeGreaterThan(minLength);
  return out;
}

describe('commit 1 — the period lists', () => {
  it('is declared by Borang A and BBCD only, sharing one read', () => {
    const declaring = MY_REPORTS.filter((r) => typeof r.availablePeriods === 'function').map((r) => r.id).sort();
    expect(declaring).toEqual(['my.borang-a', 'my.borang-bbcd']);
    const [a, bbcd] = ['my.borang-a', 'my.borang-bbcd'].map((id) => MY_REPORTS.find((r) => r.id === id)!);
    expect(a.availablePeriods).toBe(bbcd.availablePeriods);
    // Both are monthly and filed per payroll cycle, so the step has a month and a cycle box to fill.
    for (const r of [a, bbcd]) {
      expect(r.periodKind).toBe('month');
      expect(r.runSelection).toBeTruthy();
    }
  });

  it('reads with one set-based statement over processed or closed runs that carry EPF', () => {
    const src = code('localization/my/epf-periods.ts');
    expect(src).toContain('.selectDistinct({ period: payrollBatch.payPeriod })');
    expect(src).toContain("inArray(payrollBatch.status, ['processed', 'closed'])");
    expect(src).toContain('eq(payrollBatch.companyId, p.companyId)');
    expect(src).toContain('eq(payrollBatch.tenantId, ctx.tenantId)');
    expect(src).toContain("->>'epfEmployee'");
    expect(src).toContain("->>'epfEmployer'");
    expect(src).toContain('.orderBy(desc(payrollBatch.payPeriod))');
    // No loop issues a statement: one query, mapped.
    expect(src).not.toMatch(/for \(|\.forEach\(|Promise\.all\(/);
    expect(src.match(/await tx/g)).toHaveLength(1);
  });

  it('serves the list from a scoped route that reaches the pack only through core/reporting', () => {
    expect(PERIODS_ENDPOINT).toBe('/payroll/statutory-forms/open/periods');
    const route = code('app/payroll/statutory-forms/open/periods/route.ts');
    expect(route).toContain("import { scopedAdmin } from '@/lib/scope';");
    expect(route).toContain("import { reportAvailablePeriods } from '@/core/reporting';");
    expect(route).toContain('reportAvailablePeriods(s, { companyIds: scopeIds, companyId, reportId })');
    expect(route).not.toMatch(/localization\/my|packs\//);
    expect(route).not.toContain('isAdmin');
    expect(route).toContain("'Cache-Control': 'private, no-store'");
    // The seam fails closed on scope before it resolves anything.
    const seam = slice(code('core/reporting.ts'), 'export async function reportAvailablePeriods(', 'export async function reportPreview(', 200);
    expect(seam).toContain('if (p.companyIds.length === 0 || !p.companyIds.includes(p.companyId)) return [];');
    expect(seam.indexOf('return [];')).toBeLessThan(seam.indexOf('resolveDef('));
  });

  it('draws the period list only for a form that declares one, and the generic selects otherwise', () => {
    const open = code('app/payroll/statutory-forms/open/page.tsx');
    expect(open).toContain("const periodsFromPayroll = Boolean(report?.periodsFromPayroll && field('company') && field('year') && field('month'));");
    expect(open).toContain('reportAvailablePeriods(s, { companyIds: scopeIds, companyId: defaultCompany, reportId: report!.id })');
    expect(open).toContain('choosePeriod(initialPeriods, { year: sp.year, month: sp.month })');
    expect(open).toContain("{field('year') && !periodsFromPayroll && (");
    expect(open).toContain("{field('month') && !periodsFromPayroll && (");
    // Every other form keeps the generic year list and the twelve months.
    expect(open).toContain('const years = yearOptions(today, defaultYear);');
    expect(open).toContain('{MONTHS.map((m) => (');
    // With nothing listed, Continue arrives held and the cycle box is hidden.
    expect(open).toContain('disabled={noPeriods}');
    expect(open).toContain('group-data-[periods-empty=true]/criteria:hidden');
    // Still a plain GET form that produces nothing.
    expect(open).toContain('<form method="get" action={parsed.action}');
    expect(open).not.toContain('reportPreview(');
  });

  it('lets neither island re-enable a Continue the other holds', () => {
    const cycles = code('app/payroll/statutory-forms/open/cycles-criterion.tsx');
    const periods = code('app/payroll/statutory-forms/open/period-criterion.tsx');
    expect(cycles).toContain('holdContinue(ref.current?.closest(\'form\'), HOLD_CYCLES, available > 0 && picked === 0);');
    expect(cycles).not.toContain('button.disabled =');
    expect(periods).toContain('holdContinue(form, HOLD_PERIODS, empty || loading);');
    expect(periods).not.toContain('button.disabled =');
  });

  it('has the three new sentences in all six locales, translated', () => {
    for (const l of LOCALES) {
      const ns = catalog(l).payroll.statutoryForms as Record<string, string>;
      for (const k of ['criteria_fromPayroll', 'periods_hint', 'periods_none']) {
        expect(ns[k], `${l} ${k}`).toBeTruthy();
        if (l !== 'en') expect(ns[k], `${l} ${k} is still English`).not.toBe(catalog('en').payroll.statutoryForms[k]);
      }
    }
  });
});

describe('commit 2 — Back, at the top left of Borang A and BBCD', () => {
  it.each(['app/payroll/borang-a/preview/page.tsx', 'app/payroll/borang-bbcd/preview/page.tsx'])(
    '%s: the viewer and the not-ready screen both go back to the step with the same selection',
    (file) => {
      const page = code(file);
      expect(page).toContain('const criteria = { companyId, year, month, runSeqs };');
      expect(page).toContain('const backToCriteria = criteriaReturnHref(');
      const viewer = slice(page, '<StatutoryPdfViewer', 'openInNewTabLabel=', 100);
      expect(viewer).toContain("back={{ href: backToCriteria, label: tf('viewer_back') }}");
      expect(viewer).toContain('backPlacement="leading"');
      expect(page).toContain("<PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: tf('viewer_back') }} />");
      expect(page).not.toContain("t('viewerBack')");
    },
  );

  it('leaves every other form on the trailing link it had', () => {
    for (const f of [
      'app/payroll/borang-8a/preview/page.tsx',
      'app/payroll/borang-8b/preview/page.tsx',
      'app/payroll/cp39/preview/page.tsx',
      'app/payroll/cp8d/preview/page.tsx',
      'app/payroll/sip-contribution/preview/page.tsx',
    ]) {
      expect(code(f), f).not.toContain('backPlacement');
    }
    expect(code('components/statutory-pdf-viewer.tsx')).toContain("backPlacement = 'trailing',");
  });
});

describe('commit 2 — "EPF contributions (KWSP)" off the screens, not out of the registry', () => {
  const epf = MY_REPORTS.find((r) => r.id === 'my.epf')!;

  it('is the one form off the shelf, and keeps its definition, deadline and audit identity', () => {
    expect(MY_REPORTS.filter((r) => r.shelf === false).map((r) => r.id)).toEqual(['my.epf']);
    expect(epf).toBeTruthy();
    // The submission drives the suspended-tenant statutory override (core/reporting.ts statutoryCtx).
    expect(epf.submission).toEqual({ body: 'epf', agency: 'EPF (KWSP)', channel: 'i-Akaun (Employer)', dueDayOfNextMonth: 15 });
    expect(typeof epf.generate).toBe('function');
    expect(STATUTORY_FORM_TYPES.epf).toContain('my.epf');
    expect(code('core/reporting.ts')).toContain('if (!def.submission) return ctx;');
    expect(code('core/reporting.ts')).toContain('onShelf: r.shelf !== false,');
  });

  it('the shelf, the Open Form step, the figures screen and Filing history all honour it', () => {
    const shelf = code('app/payroll/statutory-forms/page.tsx');
    expect(shelf).toContain('const shelfReports = catalog.reports.filter((r) => r.onShelf);');
    expect(shelf).toContain('const submissions = shelfReports.filter((r) => r.submission != null);');
    expect(shelf).toContain('const catalogSize = shelfReports.length + catalog.links.length + catalog.planned.length;');

    const open = code('app/payroll/statutory-forms/open/page.tsx');
    const guard = slice(open, 'if (report && !report.onShelf) {', 'if (!report && !link) {', 60);
    expect(guard).toContain("redirect(`/payroll/statutory-forms${report.submission ? `?body=${encodeURIComponent(report.submission.body)}` : ''}`);");

    const figures = code('app/payroll/statutory-forms/[formId]/page.tsx');
    expect(figures).toContain('if (!def.onShelf) {');
    expect(figures.indexOf('if (!def.onShelf) {')).toBeLessThan(figures.indexOf('reportPreview(s, {'));

    const history = code('app/payroll/statutory-forms/filing-history/page.tsx');
    expect(history).toContain('const reports = allReports.filter((r) => r.onShelf);');
    expect(history).toContain('const retired = allReports.find((r) => r.id === sp.reportId && !r.onShelf);');
    // Generations already recorded are still listed: the recent list is not filtered by the shelf.
    expect(history).toContain('const recent = companyId ? await recentReports(s, companyId) : [];');
    expect(history.indexOf('if (retired) {')).toBeLessThan(history.indexOf('reportPreview(s, { companyId, reportId, periodKey })'));
  });

  it('keeps the Recent generations and Worksheet links on the shelf page', () => {
    const shelf = code('app/payroll/statutory-forms/page.tsx');
    expect(shelf).toContain('href="/payroll/statutory-forms/filing-history"');
    expect(shelf).toContain('href="/payroll/multi-cycle-worksheet"');
  });
});

// ── Commit 3 — the redraw ─────────────────────────────────────────────────────────────────────────────

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
/** A FICTIONAL stand-in for the owner's file: a plain grey ring, w × h, RGBA. Not a logo of anybody's. */
function syntheticPng(w: number, h: number): Uint8Array {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w / 2);
      const dy = (y - h / 2) / (h / 2);
      const r = Math.sqrt(dx * dx + dy * dy);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = raw[o + 1] = raw[o + 2] = 120;
      raw[o + 3] = r < 0.95 && r > 0.6 ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

type Drawn = { x: number; y: number; size: number; bold: boolean; text: string };
/** Per page: every string drawn, and every image placement (position and drawn size, in points). */
function readPdf(buf: Buffer): { texts: Drawn[]; images: { w: number; h: number; x: number; y: number }[] }[] {
  const OP = /\/(Helvetica(?:-Bold)?)-\d+ ([\d.]+) Tf[\s\S]{0,60}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g;
  // pdf-lib's drawImage: translate(x, y), rotate(0), scale(w, h), skew(0), then the XObject.
  const IMG = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\s*1 0 0 1 0 0 cm\s*([\d.]+) 0 0 ([\d.]+) 0 0 cm\s*1 0 0 1 0 0 cm\s*\/[\w-]+ Do/g;
  const pages: ReturnType<typeof readPdf> = [];
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
    pages.push({
      texts: [...body.matchAll(OP)].map((t) => ({
        bold: t[1] === 'Helvetica-Bold',
        size: Number(t[2]),
        x: Number(t[3]),
        y: Number(t[4]),
        text: Buffer.from(t[5], 'hex').toString('latin1'),
      })),
      images: [...body.matchAll(IMG)].map((t) => ({ x: Number(t[1]), y: Number(t[2]), w: Number(t[3]), h: Number(t[4]) })),
    });
  }
  return pages;
}

const formHeader = {
  employerRef: '012345678',
  employerName: 'CONTOH TEKNOLOGI SDN BHD',
  employerAddress: 'NO 8, JALAN CONTOH 3/1\nTAMAN CONTOH\n47300 PETALING JAYA, SELANGOR',
  contributionMonth: '11 / 2026',
  contributionMonthCode: '1126',
  contributionPeriodKey: '2026-11',
  payrollPeriodKey: '2026-10',
  printedOn: '25/11/2026',
  repName: 'CONTOH WAKIL',
  repIc: '800101015555',
  repPosition: 'PENGURUS',
  repPhone: '03-1234 5678',
  repEmail: '',
};
const fictionalRow = (i: number): BorangARow => ({
  employmentId: `e${i}`,
  memberNo: String(10000000 + i),
  ic: String(900100105500 + i),
  idKind: 'ic',
  icNumber: String(900100105500 + i),
  name: `CONTOH PEKERJA ${i}`,
  staffNo: `S${i}`,
  wage: 3000 + i * 10,
  employer: 390 + i,
  employee: 330 + i,
  wageRecorded: true,
});
const formOf = (n: number) => borangAFrom({ header: formHeader, rows: Array.from({ length: n }, (_, i) => fictionalRow(i)) });
const WIDE_LOGO = syntheticPng(600, 400);

describe('commit 3 — the KWSP logo comes only from the owner-supplied official file', () => {
  it('reads one documented path, accepts a PNG at least 300 px on its shorter side, refuses anything else', () => {
    expect(KWSP_LOGO_PATH).toBe(path.join('assets', 'kwsp', 'kwsp-logo.png'));
    expect(KWSP_LOGO_MIN_PX).toBe(300);
    expect(pngSize(syntheticPng(640, 480))).toEqual({ width: 640, height: 480 });
    expect(kwspLogoRefusal(syntheticPng(600, 600))).toBeNull();
    expect(kwspLogoRefusal(syntheticPng(96, 93))).toMatch(/too small to print clearly/);
    expect(kwspLogoRefusal(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('not a PNG file');
    // The README beside it says exactly what to supply.
    const readme = read('assets/kwsp/README.md');
    for (const s of ['assets/kwsp/kwsp-logo.png', 'PNG', '300 px', '600 px']) expect(readme).toContain(s);
  });

  it('is read by both PDF routes and handed to the renderers, which stay pure', () => {
    for (const [route, call] of [
      ['app/payroll/borang-a/pdf/route.ts', 'renderBorangAPdf(loaded.form, { logo: readKwspLogo() })'],
      ['app/payroll/borang-bbcd/pdf/route.ts', 'renderBorangBbcdPdf(loaded.bbcd, { logo: readKwspLogo() })'],
    ] as const) {
      const src = code(route);
      expect(src).toContain("import { readKwspLogo } from '@/lib/kwsp-logo';");
      expect(src).toContain(call);
    }
    for (const lib of ['lib/borang-a-pdf.ts', 'lib/borang-bbcd-pdf.ts']) {
      const src = code(lib);
      expect(src, lib).not.toMatch(/node:fs|readFileSync|kwsp-logo/);
      expect(src, lib).toContain('scaleToFit(LOGO_BOX.w, LOGO_BOX.h)');
    }
    // Borang 8A, 8B, SIP and CP39 do not read it.
    for (const other of ['lib/borang-8a-pdf.ts', 'lib/borang-8b-pdf.ts', 'lib/sip-contribution-pdf.ts', 'lib/cp39-form-pdf.ts']) {
      if (fs.existsSync(path.join(ROOT, other))) expect(code(other), other).not.toContain('kwsp-logo');
    }
  });

  it('Borang A: draws it top left on EVERY sheet, in its box, in proportion; without it the sheet is otherwise identical', async () => {
    const form = formOf(45);
    expect(form.pages.length).toBe(3);
    const withLogo = readPdf(Buffer.from(await renderBorangAPdf(form, { logo: WIDE_LOGO })));
    const without = readPdf(Buffer.from(await renderBorangAPdf(form)));
    const box = BORANG_A_SHEET_GEOMETRY.logoBox;
    expect(withLogo).toHaveLength(3);
    for (const [n, sheet] of withLogo.entries()) {
      expect(sheet.images, `sheet ${n + 1}`).toHaveLength(1);
      const img = sheet.images[0];
      // In proportion: 600 × 400 stays 3:2 — never stretched to the box.
      expect(img.w / img.h).toBeCloseTo(1.5, 3);
      // Inside its box, top left of the frame, left of the employer labels.
      expect(img.x).toBeGreaterThanOrEqual(box.x - 0.01);
      expect(img.y).toBeGreaterThanOrEqual(box.y - 0.01);
      expect(img.x + img.w).toBeLessThanOrEqual(box.x + box.w + 0.01);
      expect(img.y + img.h).toBeLessThanOrEqual(box.y + box.h + 0.01);
      const nama = sheet.texts.find((d) => d.text === 'Nama Majikan')!;
      expect(img.y, 'the logo runs into the employer labels').toBeGreaterThan(nama.y + 10);
      // The masthead lays out the same way with or without it.
      expect(sheet.texts).toEqual(without[n].texts);
      expect(without[n].images).toEqual([]);
    }
    const bytes = Buffer.from(await renderBorangAPdf(form, { logo: WIDE_LOGO })).toString('latin1');
    expect(bytes.match(/\/Subtype\s*\/Image/g), 'embedded once, drawn on every sheet').toHaveLength(1);
  });

  it('BBCD: draws it top left inside the frame, in proportion, clear of the centred masthead', async () => {
    const bbcd = borangBbcdFrom(formOf(3));
    const [page] = readPdf(Buffer.from(await renderBorangBbcdPdf(bbcd, { logo: WIDE_LOGO })));
    const [plain] = readPdf(Buffer.from(await renderBorangBbcdPdf(bbcd)));
    expect(page.images).toHaveLength(1);
    const img = page.images[0];
    const box = BBCD_GEOMETRY.logoBox;
    expect(img.w / img.h).toBeCloseTo(1.5, 3);
    expect(img.x).toBeGreaterThanOrEqual(box.x - 0.01);
    expect(img.x + img.w).toBeLessThanOrEqual(box.x + box.w + 0.01);
    expect(img.y).toBeGreaterThanOrEqual(box.y - 0.01);
    expect(img.y + img.h).toBeLessThanOrEqual(box.y + box.h + 0.01);
    const masthead = page.texts.find((d) => d.text === 'KUMPULAN WANG SIMPANAN PEKERJA')!;
    expect(img.x + img.w, 'the logo runs into the masthead').toBeLessThan(masthead.x);
    expect(page.texts).toEqual(plain.texts);
    expect(plain.images).toEqual([]);
  });

  it('refuses a truncated or damaged file BEFORE pdf-lib sees it (pdf-lib spins on a truncated PNG)', () => {
    const good = syntheticPng(600, 600);
    expect(kwspLogoRefusal(good.slice(0, 60))).toBe('the PNG file is truncated');
    expect(kwspLogoRefusal(good.slice(0, good.length - 12))).toBe('the PNG file is truncated');
    const flipped = new Uint8Array(good);
    flipped[50] ^= 0xff;
    expect(kwspLogoRefusal(flipped)).toMatch(/damaged/);
  });
});

describe('commit 3 — bold masthead and headings, the KWSP 6 / BORANG / A block, A4', () => {
  it('Borang A', async () => {
    const pdf = Buffer.from(await renderBorangAPdf(formOf(1)));
    const [{ texts }] = readPdf(pdf);
    const at = (t: string) => texts.find((d) => d.text === t)!;
    for (const t of ['KUMPULAN WANG SIMPANAN PEKERJA', 'PERATURAN-PERATURAN DAN KAEDAH-KAEDAH KWSP 1991 KAEDAH 11(1)', 'KWSP 6', 'BORANG', 'A']) {
      expect(at(t), t).toBeDefined();
      expect(at(t).bold, `${t} is not bold`).toBe(true);
    }
    expect(at('KUMPULAN WANG SIMPANAN PEKERJA').size).toBeGreaterThanOrEqual(14);
    // KWSP 6 over BORANG over a large A, Mukasurat under it — one column, top right.
    const [k, b, a, m] = ['KWSP 6', 'BORANG', 'A', 'Mukasurat: 1/1'].map(at);
    expect(k.y).toBeGreaterThan(b.y);
    expect(b.y).toBeGreaterThan(a.y);
    expect(a.y).toBeGreaterThan(m.y);
    expect(a.size).toBeGreaterThan(2 * b.size);
    for (const d of [k, b, a, m]) expect(d.x, d.text).toBeGreaterThan(BORANG_A_SHEET_GEOMETRY.paymentRight);
    const doc = await PDFDocument.load(pdf);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
  });

  it('BBCD', async () => {
    const pdf = Buffer.from(await renderBorangBbcdPdf(borangBbcdFrom(formOf(1))));
    const [{ texts }] = readPdf(pdf);
    const masthead = texts.find((d) => d.text === 'KUMPULAN WANG SIMPANAN PEKERJA')!;
    expect(masthead.bold).toBe(true);
    expect(masthead.size).toBeGreaterThanOrEqual(14);
    for (const t of ['(BORANG BAYARAN CARUMAN BULANAN - PITA/DISKET (BBCD))', 'SISTEM PENGHANTARAN DATA PITA/DISKET', 'JADUAL CARUMAN BULAN November 2026']) {
      expect(texts.find((d) => d.text === t)?.bold, t).toBe(true);
    }
    const { width, height } = (await PDFDocument.load(pdf)).getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
  });
});

describe('commit 3 — no small print of ours at the foot of Borang A and BBCD', () => {
  const OURS = /Susun atur kami|Our own layout|bukan borang rasmi|our own translation|Our translation|bulan upah/i;

  it('Borang A: PERINGATAN in Malay is the last line on every sheet, with nothing of ours under it', async () => {
    const form = formOf(45);
    for (const [n, sheet] of readPdf(Buffer.from(await renderBorangAPdf(form))).entries()) {
      expect(sheet.texts.filter((d) => OURS.test(d.text)).map((d) => d.text), `sheet ${n + 1}`).toEqual([]);
      const joined = sheet.texts.map((d) => d.text).join(' ');
      expect(joined).toContain(BORANG_A_PERINGATAN_MS);
      expect(joined).not.toContain(BORANG_A_PERINGATAN_EN);
      const warning = sheet.texts.find((d) => d.text.startsWith('PERINGATAN'))!;
      const below = sheet.texts.filter((d) => d.y < warning.y && !BORANG_A_PERINGATAN_MS.includes(d.text));
      expect(below.map((d) => d.text), `sheet ${n + 1}: something is drawn under PERINGATAN`).toEqual([]);
    }
    // The provenance moved into the PDF's metadata, payroll month included.
    const doc = await PDFDocument.load(await renderBorangAPdf(form));
    expect(doc.getSubject()).toBe(borangAProvenance(form));
    expect(doc.getSubject()).toContain('bulan upah 2026-10');
  });

  it('BBCD: nothing under the frame, and the provenance in the metadata', async () => {
    const bbcd = borangBbcdFrom(formOf(3));
    const pdf = Buffer.from(await renderBorangBbcdPdf(bbcd));
    const [{ texts }] = readPdf(pdf);
    expect(texts.filter((d) => OURS.test(d.text)).map((d) => d.text)).toEqual([]);
    expect(texts.filter((d) => d.y < BBCD_GEOMETRY.frameBottom).map((d) => d.text)).toEqual([]);
    const subject = (await PDFDocument.load(pdf)).getSubject()!;
    expect(subject).toContain('not a KWSP-printed form');
    expect(subject).toContain('bulan upah 2026-10');
  });

  it('the screen strings no longer say "no logo" or "a page of ours", in any language', () => {
    for (const l of LOCALES) {
      const a = catalog(l).payroll.borangA as Record<string, string>;
      const b = catalog(l).payroll.borangBbcd as Record<string, string>;
      for (const v of [a.notArtworkTitle, a.notArtworkDrawn, b.notArtworkTitle, b.notArtwork]) {
        expect(v, l).toBeTruthy();
        expect(v, l).not.toMatch(/no logo|tanpa logo|不印标志|சின்னம் இல்லாமல்|ไม่มีโลโก้|không có logo|page of ours|halaman kami/i);
      }
      if (l !== 'en') expect(b.notArtwork, `${l} is still English`).not.toBe(catalog('en').payroll.borangBbcd.notArtwork);
    }
    // The renderers' deliberate header comments describe the new behaviour.
    for (const lib of ['lib/borang-a-pdf.ts', 'lib/borang-bbcd-pdf.ts']) {
      const src = read(lib);
      expect(src).not.toContain('NOT KWSP ARTWORK, AND THE PAGE SAYS SO');
      expect(src).not.toContain('NO LOGO: the sample');
      expect(src).toContain('owner-supplied official file');
    }
  });
});
