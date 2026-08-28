/**
 * 9c8dad7a / 3aae0789 — BORANG A (KWSP monthly contribution form).
 *
 * ⚠️ WHAT THIS FILE CANNOT SEE, NAMED HERE BECAUSE ITS ABSENCE NEARLY FILED A WRONG FORM (r227). Every
 * assertion below is DB-FREE — it pins the rules against hand-built rows — so nothing here exercises a
 * payroll run, and until r227 nothing anywhere exercised a SECOND run of the same month against this
 * form. `createAdditionalRun` appeared zero times in this file, test/borang-8a.test.ts,
 * test/kwsp-borang-a-file.test.ts, test/socso-eis-file.test.ts and test/cp39-form.test.ts. A bonus run's
 * zero-value payslip carries a full month's wage in `bases.epf`, and the read SUMS the bases across the
 * month's runs — so an extra run puts the month's wage in the Upah column TWICE, and a fully green suite
 * said nothing. That case now lives in test/borang-a-report.test.ts ("an additional run and the Upah
 * column"), which is where it can run a kernel; it cannot live here, and that is the point of the note.
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: the +1 dating rule, the carried-forward totals, the wage
 * PROVENANCE, and the places the form could quietly stop being the form. Every one of them fails SILENTLY
 * in production — a Borang A stamped with the wrong month, or whose page totals double-count, or whose
 * Upah column has quietly become gross pay, downloads exactly like a correct one and is discovered at a
 * KWSP counter.
 *
 * THE SPECIMEN IS NOT AN ARITHMETIC FIXTURE, but unlike the SOCSO one it IS internally consistent, and
 * that consistency is used deliberately in one place below: 744 is 12% and 682 is 11% of 6,200, and
 * 744 + 682 = the 1,426.00 in its Amaun Caruman box. That is the evidence Upah is the EPF-liable wage
 * rather than gross pay, and it is why the totals are asserted against it.
 *
 * THE FILE FORMAT IS NOT TESTED HERE. It has its own module and its own file
 * (test/kwsp-borang-a-file.test.ts), because it is a different contract with a different failure mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import {
  BORANG_A_CATATAN,
  BORANG_A_CITATION,
  BORANG_A_HEADER_KEYS,
  BORANG_A_PAYMENT_INSTRUCTION,
  BORANG_A_PAYMENT_METHODS,
  BORANG_A_PAYMENT_REF_LABEL,
  BORANG_A_PERINGATAN_EN,
  BORANG_A_PERINGATAN_MS,
  BORANG_A_ROWS_PER_PAGE,
  borangAFilename,
  borangAFrom,
  borangATextExport,
  contributionMonthCode,
  contributionMonthLabel,
  contributionPeriodOverridden,
  epfContributionPeriodFor,
  formDate,
  isEpfPeriodKey,
  missingBorangAHeader,
  missingBorangARep,
  money,
  paginateBorangA,
  withContributionPeriod,
  type BorangARow,
} from '../lib/borang-a';
// The OTHER form's rule, imported rather than restated — see the joint assertion below.
import { contributionPeriodFor as socsoContributionPeriodFor } from '../lib/borang-8a';
import { MY_PLANNED_FORMS, MY_REPORTS } from '../localization/my/reports';
import { BORANG_A_COLUMNS } from '../localization/my/borang-a';
import { BORANG_A_SHEET_GEOMETRY, borangASheetRowCapacity, renderBorangAPdf } from '../lib/borang-a-pdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { REGISTERED_ROUTES } from '../lib/permissions';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Source with its PROSE removed, for the assertions that say "this file must not mention X".
 *
 * These files document exactly what they refuse to do — the read explains that it never falls back to
 * gross pay, and `shared.ts` explains that `app/` never names `localization/my`. Scanning the raw text
 * would make an honest comment fail the test the comment exists to reinforce. Same stripper
 * test/borang-8a.test.ts uses: block comments go, and only WHOLE-LINE `//` comments go, so a URL inside a
 * string survives.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const LIB = read('lib/borang-a.ts');
const READ_SRC = read('localization/my/borang-a.ts');
const PDF_SRC = read('lib/borang-a-pdf.ts');
const PREVIEW = read('app/payroll/borang-a/preview/page.tsx');
const READ_CODE = code('localization/my/borang-a.ts');
const LIB_CODE = code('lib/borang-a.ts');
const SHARED_CODE = code('app/payroll/borang-a/shared.ts');
const PREVIEW_CODE = code('app/payroll/borang-a/preview/page.tsx');
const PDF_ROUTE_CODE = code('app/payroll/borang-a/pdf/route.ts');
const TEXT_ROUTE_CODE = code('app/payroll/borang-a/text/route.ts');
const FILE_ROUTE_CODE = code('app/payroll/borang-a/file/route.ts');

const row = (p: Partial<BorangARow> & { employmentId: string }): BorangARow => ({
  memberNo: '17955667',
  ic: '860208105128',
  name: 'ANG PEI YEE',
  staffNo: 'EMP001',
  wage: 6200,
  employer: 744,
  employee: 682,
  wageRecorded: true,
  ...p,
});

const header = (p: Record<string, string> = {}) => ({
  employerRef: '019632261',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  employerAddress: 'Level 12, Menara Satu\n50450 Kuala Lumpur, Wilayah Persekutuan',
  contributionMonth: '08 / 2026',
  contributionMonthCode: '0826',
  contributionPeriodKey: '2026-08',
  payrollPeriodKey: '2026-07',
  printedOn: '12/08/2026',
  repName: 'CHONG PEI YUH',
  repIc: '910416145530',
  repPosition: 'ASSISTANT MANAGER',
  repPhone: '0123081733',
  repEmail: 'rep@example.com',
  ...p,
});

describe('the +1 rule', () => {
  /**
   * The case a MISSING `+1` breaks least visibly is any ordinary month; the case a PRESENT one breaks
   * most visibly is December, because it also rolls the YEAR — a December 2026 payroll files an 01/2027
   * Borang A, and a form stamped 12/2026 is filed against the wrong year, not just the wrong month.
   */
  it.each([
    ['2026-01', '2026-02'],
    ['2026-07', '2026-08'],
    ['2026-11', '2026-12'],
    ['2026-12', '2027-01'],
    ['2027-01', '2027-02'],
  ])('a %s payroll produces a %s contribution month', (payroll, expected) => {
    expect(epfContributionPeriodFor(payroll)).toBe(expected);
  });

  it('refuses a period that is not YYYY-MM rather than reading it as a batch key', () => {
    // "2026-13" would otherwise sail through and produce a plausible-looking EMPTY form.
    for (const bad of ['2026-13', '2026-00', '202607', '2026-7', '', 'abcd-ef']) {
      expect(() => epfContributionPeriodFor(bad), bad).toThrow();
      expect(isEpfPeriodKey(bad), bad).toBe(false);
    }
    expect(isEpfPeriodKey('2026-07')).toBe(true);
  });

  it('labels the month the way the specimen does, in both of its two forms', () => {
    expect(contributionMonthLabel('2026-08')).toBe('08 / 2026');
    // The specimen's own Bulan Caruman box reads `0826` — MMYY, no separator.
    expect(contributionMonthCode('2026-08')).toBe('0826');
    expect(contributionMonthCode('2027-01')).toBe('0127');
  });

  /**
   * THE JOINT ASSERTION, and BOTH SIDES ARE NOW IMPORTED. r193 could only write a local copy of the KWSP
   * rule because Borang A did not exist; both halves now come from the modules that use them in
   * production, which is the only version of this test that proves anything. It fails if the two rules
   * ever agree — precisely what a copy-paste between the two modules would cause.
   */
  it.each(['2026-01', '2026-07', '2026-11', '2026-12'])(
    'the EPF and SOCSO contribution months for %s differ by exactly one month, and never agree',
    (payroll) => {
      const socso = socsoContributionPeriodFor(payroll);
      const epf = epfContributionPeriodFor(payroll);
      expect(socso, `SOCSO and EPF must not stamp the same month for ${payroll}`).not.toBe(epf);
      const months = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7));
      expect(months(epf) - months(socso)).toBe(1);
    },
  );

  it('has exactly one month-arithmetic site, and the read reaches the rule only through it', () => {
    // SOURCE SHAPE, across BOTH halves — a defect in the contract between two files passes a unit test of
    // either half. The read must derive its period ONLY through the exported rule.
    expect(READ_CODE).toContain('epfContributionPeriodFor(params.periodKey)');
    expect((READ_CODE.match(/epfContributionPeriodFor\(/g) ?? []).length).toBe(1);
    // …and the read does no month arithmetic of its own, in either direction.
    for (const forbidden of ['+ 1', '- 1', 'setMonth', 'getMonth']) {
      expect(READ_CODE, `the read must not do month arithmetic (${forbidden})`).not.toContain(forbidden);
    }
    // In lib/, the arithmetic exists exactly once, inside the named rule.
    expect((LIB_CODE.match(/m === 12 \? /g) ?? []).length).toBe(1);
  });
});

describe('the contribution month is editable, and an override warns rather than blocks', () => {
  it('reports an override without refusing it', () => {
    expect(contributionPeriodOverridden('2026-07', '2026-08')).toBe(false);
    expect(contributionPeriodOverridden('2026-07', '2026-09')).toBe(true);
    expect(contributionPeriodOverridden('2026-12', '2027-01')).toBe(false);
    // Junk on either side is not an "override" — it is a non-answer, and reporting it as an override
    // would put a warning on a screen for a query string nobody typed.
    expect(contributionPeriodOverridden('2026-07', 'nonsense')).toBe(false);
  });

  it('re-stamps all three month fields together, so they cannot disagree on the page', () => {
    const form = borangAFrom({ header: header(), rows: [row({ employmentId: 'a' })] });
    const moved = withContributionPeriod(form, '2026-09');
    expect([moved.contributionPeriodKey, moved.contributionMonth, moved.contributionMonthCode]).toEqual([
      '2026-09',
      '09 / 2026',
      '0926',
    ]);
    // The payroll month is NOT touched — it is what the figures came from and moving it would make the
    // form claim the wrong run.
    expect(moved.payrollPeriodKey).toBe('2026-07');
    // Junk is ignored rather than thrown: this runs on a render path.
    expect(withContributionPeriod(form, '2026-13')).toBe(form);
    expect(withContributionPeriod(form, '')).toBe(form);
  });
});

describe('pagination carries totals forward without double-counting them', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ employmentId: `e${i}`, employer: 100 + i, employee: 50 + i, wage: 1000 + i }));

  it.each([1, 2, 3])('at %s page(s): the page totals sum to the form total, and the chain links', (pages) => {
    const perPage = 4;
    const form = borangAFrom({ header: header(), rows: rows(perPage * pages), perPage });
    expect(form.pages).toHaveLength(pages);

    // (1) NO DOUBLE COUNTING: the per-page sums add up to the whole, at every page count.
    const summedEmployer = form.pages.reduce((a, p) => a + p.pageEmployer, 0);
    const summedEmployee = form.pages.reduce((a, p) => a + p.pageEmployee, 0);
    expect(Math.round(summedEmployer * 100) / 100).toBe(form.totalEmployer);
    expect(Math.round(summedEmployee * 100) / 100).toBe(form.totalEmployee);

    // (2) THE CARRY CHAIN LINKS: each sheet carries in what the one before carried out, and sheet 1
    // carries in nothing.
    expect([form.pages[0].carryInEmployer, form.pages[0].carryInEmployee]).toEqual([0, 0]);
    for (let i = 1; i < form.pages.length; i += 1) {
      expect(form.pages[i].carryInEmployer).toBe(form.pages[i - 1].carryOutEmployer);
      expect(form.pages[i].carryInEmployee).toBe(form.pages[i - 1].carryOutEmployee);
    }

    // (3) THE LAST CARRY-OUT IS THE JUMLAH. This is what a KWSP counter reads off the bottom of the deck.
    const last = form.pages[form.pages.length - 1];
    expect(last.carryOutEmployer).toBe(form.totalEmployer);
    expect(last.carryOutEmployee).toBe(form.totalEmployee);

    // (4) Amaun Caruman is the two shares added, which is the specimen's own arithmetic.
    expect(form.totalContribution).toBe(Math.round((form.totalEmployer + form.totalEmployee) * 100) / 100);
  });

  it('yields ONE empty sheet for an empty form, because "Mukasurat 1/0" is not a thing', () => {
    const form = borangAFrom({ header: header(), rows: [] });
    expect(form.pages).toHaveLength(1);
    expect(form.pages[0]).toMatchObject({ sheet: 1, of: 1, rows: [], carryInEmployer: 0, carryOutEmployer: 0 });
    expect(form.employees).toBe(0);
  });

  it('refuses a page size below one rather than looping forever', () => {
    expect(() => paginateBorangA([], 0)).toThrow();
  });

  it('reconciles to the reporter’s own specimen, which is internally consistent', () => {
    // 744 = 12% and 682 = 11% of 6,200, and 744 + 682 = the specimen's Amaun Caruman of 1,426.00. That
    // arithmetic is the evidence Upah is the EPF-LIABLE WAGE and not gross pay.
    const form = borangAFrom({ header: header(), rows: [row({ employmentId: 'a' })] });
    expect(form.totalWage).toBe(6200);
    expect(form.totalEmployer).toBe(744);
    expect(form.totalEmployee).toBe(682);
    expect(form.totalContribution).toBe(1426);
    expect(form.employees).toBe(1);
  });
});

describe('the header contract between the read and the renderer', () => {
  it('is one list, so a key added on one side cannot go unread on the other', () => {
    const form = borangAFrom({ header: header(), rows: [] });
    for (const k of BORANG_A_HEADER_KEYS) {
      expect(form, `BorangAForm is missing ${k}`).toHaveProperty(k);
      // The read must actually put every one of them on meta.formHeader.
      expect(READ_SRC, `the read never sets ${k}`).toContain(k);
    }
  });

  it('splits the address back into lines, because meta values are scalars', () => {
    const form = borangAFrom({ header: header(), rows: [] });
    expect(form.employerAddress).toEqual(['Level 12, Menara Satu', '50450 Kuala Lumpur, Wilayah Persekutuan']);
    // Blank lines are dropped rather than printed as gaps in the middle of an address.
    expect(borangAFrom({ header: header({ employerAddress: 'A\n\n  \nB' }), rows: [] }).employerAddress).toEqual(['A', 'B']);
  });

  /**
   * REPORTS, NEVER THROWS. This is called on a RENDER path, and Borang 8A learned in r193 that refusing
   * to render the page whose whole job is to explain a gap is worse than the gap.
   */
  it('reports the employer-level gaps instead of throwing, and excludes what is not required', () => {
    expect(missingBorangAHeader(header())).toEqual([]);
    expect(missingBorangAHeader({})).toContain('employerRef');
    expect(missingBorangAHeader(null)).toContain('employerName');
    // The address prints as however many lines exist, and the representative block is advisory — neither
    // may appear in the BLOCKING list.
    expect(missingBorangAHeader({})).not.toContain('employerAddress');
    for (const k of ['repName', 'repIc', 'repPosition', 'repPhone', 'repEmail']) {
      expect(missingBorangAHeader({}), `${k} must not block`).not.toContain(k);
    }
    // …and building a form with a blank header does not throw either.
    expect(() => borangAFrom({ header: {}, rows: [row({ employmentId: 'a' })] })).not.toThrow();
  });

  it('reports the representative gaps separately, as an advisory', () => {
    expect(missingBorangARep(header())).toEqual([]);
    // MEASURED on production 2026-08-13: one company_statutory_authority row across nine companies, with a
    // signatory but no phone and no e-mail. Blocking on it would make the feature unusable on day one.
    expect(missingBorangARep(header({ repPhone: '', repEmail: '' }))).toEqual(['repPhone', 'repEmail']);
    expect(missingBorangARep({})).toHaveLength(5);
  });
});

/**
 * THE WAGE PROVENANCE — the property this form is most likely to lose quietly, because gross pay is
 * always available and always looks plausible.
 */
describe('Upah is the EPF-liable wage and never gross pay', () => {
  it('reads `wageRecorded` BY VALUE, because the key is always present', () => {
    // The read stamps 'yes' or '' on every row, so `'wageRecorded' in row` is true for everybody. Reading
    // by presence would mark a pre-r187 run as recorded — the same trap that shipped a pay setting nobody
    // could turn off.
    const form = borangAFrom({
      header: header(),
      rows: [
        { employmentId: 'a', wage: 100, employer: 12, employee: 11, wageRecorded: 'yes' },
        { employmentId: 'b', wage: 0, employer: 12, employee: 11, wageRecorded: '' },
        { employmentId: 'c', wage: 0, employer: 12, employee: 11 },
      ],
    });
    expect(form.pages[0].rows.map((r) => r.wageRecorded)).toEqual([true, false, false]);
  });

  it('never borrows gross pay, in the read or on the page', () => {
    // The read SELECTS grossPay — deliberately, for the reconciliation strip that shows how far Upah is
    // from it — but it must never assign it to the wage.
    expect(READ_CODE).toContain('gross: payslip.grossPay');
    expect(READ_CODE).not.toMatch(/wage:\s*[^,\n]*gross/i);
    expect(READ_CODE).toContain('b.epf');
    expect(READ_CODE).toContain('b.epfAdditional');
    // …and the screen prints a refusal rather than a zero for a row with no recorded basis.
    expect(PREVIEW_CODE).toContain('r.wageRecorded ?');
    expect(PREVIEW_CODE).toContain("t('wageNotRecorded')");
  });

  it('the read blocks on a missing wage basis exactly as it blocks on a missing member number', () => {
    expect(READ_CODE).toContain('EPF member no.');
    expect(READ_CODE).toContain('EPF wage basis');
  });
});

describe('the plain-text export', () => {
  it('carries the totals forward and prints JUMLAH exactly once, on the last page', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ employmentId: `e${i}` }));
    const text = borangATextExport(borangAFrom({ header: header(), rows, perPage: 2 }));
    expect((text.match(/Jumlah yang dibawa dari mukasurat terdahulu/g) ?? []).length).toBe(2);
    expect((text.match(/Jumlah yang dibawa ke mukasurat seterusnya/g) ?? []).length).toBe(2);
    expect((text.match(/^JUMLAH \(RM\)/gm) ?? []).length).toBe(0);
    expect((text.match(/JUMLAH \(RM\)/g) ?? []).length).toBe(1);
    expect(text).toContain('Mukasurat 3/3');
  });

  it('says on its face that it is not KWSP artwork', () => {
    const text = borangATextExport(borangAFrom({ header: header(), rows: [row({ employmentId: 'a' })] }));
    expect(text).toContain('NOT KWSP ARTWORK');
    // UPDATED DELIBERATELY in cc9f9420, not incidentally: the label column widened from 19 to 20 because
    // "No. Rujukan Borang A" — the reporter's point 1 — is exactly 20 characters and had to fit beside it.
    expect(text).toContain('No. Rujukan Majikan  : 019632261');
    expect(text).toContain('No. Rujukan Borang A : (kosong - untuk diisi oleh tuan)');
    expect(text).toContain('Bulan Caruman        : 08 / 2026  (0826)');
    expect(text).toContain('Bulan Upah           : 2026-07');
  });

  it('marks an unrecorded wage rather than printing 0.00 for it', () => {
    const text = borangATextExport(
      borangAFrom({ header: header(), rows: [{ employmentId: 'a', employer: 12, employee: 11 }] }),
    );
    expect(text).toContain('NOT RECORDED');
  });

  it('numbers rows across the whole form, not per page', () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ employmentId: `e${i}`, name: `PERSON ${i}` }));
    const text = borangATextExport(borangAFrom({ header: header(), rows, perPage: BORANG_A_ROWS_PER_PAGE }));
    expect(text).toMatch(/^1 {4}17955667/m);
    expect(text).toMatch(/^3 {4}17955667/m);
  });
});

describe('small pure helpers', () => {
  it('formats the print date the way the specimen does', () => {
    expect(formDate('2026-08-12')).toBe('12/08/2026');
    expect(formDate(null)).toBe('');
    expect(formDate('not a date')).toBe('');
  });

  it('formats money with two decimals and thousands separators', () => {
    expect(money(1426)).toBe('1,426.00');
    expect(money(0)).toBe('0.00');
  });

  it('names the download after the employer reference and the contribution month', () => {
    const form = borangAFrom({ header: header(), rows: [] });
    expect(borangAFilename(form, 'pdf')).toBe('borang-a-019632261-202608.pdf');
    expect(borangAFilename(borangAFrom({ header: header({ employerRef: '' }), rows: [] }), 'txt')).toMatch(/^borang-a-EMP-/);
  });
});

describe('the catalog entry', () => {
  const def = MY_REPORTS.find((r) => r.id === 'my.borang-a');

  it('is registered on the EPF shelf at the position the planned form held', () => {
    expect(def, 'my.borang-a must be registered').toBeTruthy();
    expect(def!.submission?.body).toBe('epf');
    expect(def!.submission?.agency).toBe('EPF (KWSP)');
    expect(def!.shelfOrder).toBe(2);
    expect(def!.cadence).toBe('monthly');
    expect(def!.periodKind).toBe('month');
  });

  it('LEFT the planned list rather than being duplicated into both', () => {
    expect(MY_PLANNED_FORMS.map((p) => p.id)).not.toContain('epf.borang-a');
    // The one remaining EPF planned form keeps its own slot, so the shelf did not renumber.
    expect(MY_PLANNED_FORMS.find((p) => p.id === 'epf.borang-bbcb')?.shelfOrder).toBe(3);
  });

  it('claims `agency-layout` and never `official`', () => {
    // KWSP publishes no blank Borang A, so there is no artwork on disk this could have been drawn onto —
    // which is exactly why it may not make the claim `my.cp22` makes.
    expect(def!.fidelity).toBe('agency-layout');
    // `my.cp22` — the ONE `official` entry — is a StatutoryFormLink, not a ReportDef, so nothing in
    // MY_REPORTS may claim it. test/statutory-forms-page.test.ts pins the union across both lists.
    expect(MY_REPORTS.filter((r) => r.fidelity === 'official').map((r) => r.id)).toEqual([]);
  });

  it('is not the EPF contributions LISTING under another name', () => {
    const listing = MY_REPORTS.find((r) => r.id === 'my.epf')!;
    expect(listing.label).not.toContain('Borang A');
    expect(listing.shelfOrder).toBe(1);
    // Two entries, two generators. A relabelled listing is exactly the failure the fidelity vocabulary
    // and the whole statutory-forms item exist to prevent.
    expect(def!.generate).not.toBe(listing.generate);
  });

  it('declares the columns the specimen prints, in its order', () => {
    expect(BORANG_A_COLUMNS.map((c) => c.key)).toEqual(['memberNo', 'ic', 'name', 'wage', 'employer', 'employee']);
    expect(BORANG_A_COLUMNS.filter((c) => c.numeric).map((c) => c.key)).toEqual(['wage', 'employer', 'employee']);
  });

  it('resolves its description key against en.json', () => {
    const ns = en.payroll.statutoryForms as Record<string, string>;
    expect(def!.descriptionKey).toBe('desc_borang_a');
    expect(ns.desc_borang_a).toBeTruthy();
    expect(ns.borangAReview).toBeTruthy();
    expect(ns.borangAReviewTitle).toBeTruthy();
    // The planned-form keys went with the planned form. Leaving them would leave a name on the shelf's
    // vocabulary for a form that is no longer unbuilt.
    expect(ns.planned_epf_borang_a).toBeUndefined();
    expect(ns.planned_epf_borang_a_hint).toBeUndefined();
  });
});

describe('the four surfaces cannot disagree', () => {
  it('registers the review PAGE in the access matrix and the three ROUTES nowhere', () => {
    // Rule: only page.tsx files are enumerated. A guarded page with no column fails
    // test/function-access.test.ts; a route handler with one would be a column nobody can use.
    expect(REGISTERED_ROUTES.has('/payroll/borang-a/preview')).toBe(true);
    expect(REGISTERED_ROUTES.has('/payroll/borang-a/pdf')).toBe(false);
    expect(REGISTERED_ROUTES.has('/payroll/borang-a/text')).toBe(false);
    expect(REGISTERED_ROUTES.has('/payroll/borang-a/file')).toBe(false);
  });

  it('routes every surface through the one loader, and none of them through the pack', () => {
    for (const [name, src] of [
      ['preview', PREVIEW_CODE],
      ['pdf', PDF_ROUTE_CODE],
      ['text', TEXT_ROUTE_CODE],
      ['file', FILE_ROUTE_CODE],
    ] as const) {
      expect(src, `${name} must go through the shared loader`).toMatch(/loadBorangA(File)?\(/);
      // ADR-0080 D1: app/ reaches the pack only through core/reporting.
      expect(src, `${name} must not import the pack`).not.toContain('localization/my');
    }
    expect(SHARED_CODE).toContain('reportPreview');
    expect(SHARED_CODE).not.toContain('localization/my');
  });

  it('gates the downloads in the LOADER, not only on the screen', () => {
    // A URL is not a screen. `includeIncomplete` is the review screen's alone.
    expect(SHARED_CODE).toContain("reason: 'not-ready'");
    expect(SHARED_CODE).toContain('p.includeIncomplete');
    expect(PREVIEW_CODE).toContain('includeIncomplete: true');
    for (const src of [PDF_ROUTE_CODE, TEXT_ROUTE_CODE, FILE_ROUTE_CODE]) {
      expect(src, 'a download route must never ask for incomplete rows').not.toContain('includeIncomplete');
    }
    // Scope, not `isAdmin` — an hr_admin grant on ANY company would otherwise export another company's
    // employee names, identity card numbers and contributions.
    expect(SHARED_CODE).toContain('scopedAdmin');
    expect(SHARED_CODE).not.toContain('isAdmin');
  });

  it('serves the field-by-field check from the SAME route as the upload file, not a second one', () => {
    // cc74dcb2: the report must describe the bytes the operator is about to upload. A second route would
    // build the file a second time and could describe a different one, which is worse than no report.
    expect(FILE_ROUTE_CODE).toContain("q.get('report')");
    expect(FILE_ROUTE_CODE).toContain('borangAFileReport');
    expect(REGISTERED_ROUTES.has('/payroll/borang-a/file-report')).toBe(false);
    // `name`/`value` on a submit button travel only when that button submits the form, so the plain
    // download button stays exactly the request it was.
    expect(PREVIEW_CODE).toContain('name="report"');
    expect(PREVIEW_CODE).toContain("t('downloadReport')");
    expect(PREVIEW_CODE.match(/formAction="\/payroll\/borang-a\/file"/g)).toHaveLength(2);
  });

  it('hides the download buttons rather than disabling them', () => {
    // A disabled button is still a button and still gets clicked at.
    expect(PREVIEW_CODE).not.toContain('disabled');
    expect(PREVIEW_CODE).toContain("t('downloadsBlocked')");
    // The upload file has its OWN button and its own gate, because its readiness list is stricter.
    expect(PREVIEW_CODE).toContain('fileReadiness.ok');
    expect(PREVIEW_CODE).toContain('/payroll/borang-a/file');
  });

  it('never nests the two forms, which browsers silently drop', () => {
    // The filter form and the schedule form are siblings; the schedule form carries its own hidden
    // companyId and periodKey precisely so it can be one.
    expect(PREVIEW).toContain('<input type="hidden" name="companyId"');
    expect(PREVIEW).toContain('<input type="hidden" name="periodKey"');
    expect((PREVIEW.match(/<form /g) ?? []).length).toBe(2);
  });
});

describe('the module stands alone from Borang 8A', () => {
  it('shares no code with the PERKESO form, in either direction', () => {
    // The two have OPPOSITE contribution-month rules. A shared helper that grew a parameter is exactly
    // how one acquires the other's, and it would pass every unit test of either half.
    // COMMENT-STRIPPED on both sides: these files document exactly which module they are independent of,
    // and scanning the prose would make the honest note fail the test the note exists to reinforce.
    expect(LIB_CODE).not.toContain('borang-8a');
    expect(code('lib/borang-a-pdf.ts')).not.toContain('borang-8a');
    expect(READ_CODE).not.toContain('borang-8a');
    expect(code('lib/borang-8a.ts')).not.toContain('borang-a');
    expect(code('localization/my/borang-8a.ts')).not.toContain('borang-a');
    expect(code('lib/kwsp-borang-a-file.ts')).not.toContain('borang-8a');
  });
});

describe('the drawn page', () => {
  it('renders a real PDF, at one page and at three', async () => {
    for (const [count, perPage, pages] of [
      [1, BORANG_A_ROWS_PER_PAGE, 1],
      [7, 3, 3],
    ] as const) {
      const rows = Array.from({ length: count }, (_, i) => row({ employmentId: `e${i}`, name: `PERSON ${i}` }));
      const form = borangAFrom({ header: header(), rows, perPage });
      expect(form.pages).toHaveLength(pages);
      const bytes = await renderBorangAPdf(form);
      expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  it('renders a form with no employees rather than throwing', async () => {
    const bytes = await renderBorangAPdf(borangAFrom({ header: header(), rows: [] }));
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('folds typography Helvetica cannot encode instead of printing "?"', () => {
    // The band at the foot carries a curly apostrophe and an em dash, both outside Latin-1. r193 shipped
    // "the agency?s own page" on the Borang 8A footer before this fold existed.
    expect(PDF_SRC).toContain("replace(/[‘’ʼ]/g, \"'\")");
    expect(PDF_SRC).toContain('replace(/[–—−]/g,');
  });

  it('prints the whole-form JUMLAH on the last sheet only', () => {
    // Repeating it is how a multi-page form gets filed with the grand total mistaken for a page total.
    expect(code('lib/borang-a-pdf.ts')).toContain('JUMLAH (RM)');
    expect(code('lib/borang-a-pdf.ts')).toContain('if (!last) {');
  });
});

/**
 * EVERY KEY THE REVIEW SCREEN RENDERS RESOLVES. A message that does not exist throws MISSING_MESSAGE at
 * RENDER time and paints the raw key on the page, while tsc, the suite and `next build` all stay green.
 */
describe('the review screen’s messages', () => {
  const ns = (en.payroll as Record<string, unknown>).borangA as Record<string, string>;

  it('exists as a namespace', () => {
    expect(ns, 'payroll.borangA must exist in en.json').toBeTruthy();
    expect(PREVIEW).toContain("getTranslations('payroll.borangA')");
  });

  it('resolves every literal t(...) key the screen uses', () => {
    const keys = [...PREVIEW.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(30);
    for (const k of new Set(keys)) expect(ns[k], `payroll.borangA.${k} is missing`).toBeTruthy();
  });

  it('resolves the keys the screen looks up through its two label maps', () => {
    // Dynamic lookups are invisible to the scan above and to i18n-coverage's namespace check.
    for (const k of ['headerField_employerRef', 'headerField_employerName']) expect(ns[k], k).toBeTruthy();
    for (const k of ['repField_name', 'repField_ic', 'repField_position', 'repField_phone', 'repField_email']) {
      expect(ns[k], k).toBeTruthy();
    }
  });

  it('names the three downloads so the UPLOADABLE one is unmistakable, in every locale', () => {
    // cc74dcb2's reporter uploaded the readable text export to i-Akaun, because "Download as text" and
    // "Download upload file" are two buttons that both produce a .txt. Every language now says which
    // portal each one is for, and the readable one says in as many words that it is not that file.
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const dict = JSON.parse(read(`messages/${loc}.json`)) as { payroll: { borangA: Record<string, string> } };
      const b = dict.payroll.borangA;
      for (const k of ['downloadText', 'downloadTextTitle', 'downloadFile', 'downloadFileTitle', 'downloadReport', 'downloadReportTitle']) {
        expect(b[k], `${loc}.${k}`).toBeTruthy();
      }
      expect(b.downloadText, loc).not.toBe(b.downloadFile);
      expect(b.downloadFile, `${loc} must name the portal the file is for`).toContain('i-Akaun');
      expect(b.downloadTextTitle, `${loc} must disclaim the portal on the readable copy`).toContain('i-Akaun');
    }
  });

  it('keeps braces out of every key rendered without arguments', () => {
    // A message carrying {placeholders} rendered through a plain t('…') throws FORMATTING_ERROR at render
    // time — a 200 that shows the raw key path.
    const INTERPOLATED = new Set(['noBatch', 'tileSheets', 'tileRef', 'periodOverridden', 'missingTitle', 'pageCarry']);
    const braced = Object.entries(ns).filter(([k, v]) => !INTERPOLATED.has(k) && /[{}]/.test(v));
    expect(braced.map(([k]) => k), 'these are rendered with no arguments').toEqual([]);
    for (const k of INTERPOLATED) expect(ns[k], k).toMatch(/\{/);
  });
});

/**
 * cc9f9420 — THE KWSP 6 PAGE FURNITURE.
 *
 * ⚠️ THESE TESTS READ THE FINISHED PDF, not the source that produced it. Two of the three layout defects
 * in this file's history were invisible to tsc, to the suite, to `next build` and to a 200 — a PDF that
 * prints one string through another is still a valid PDF, and `renderBorangAPdf` returning bytes proves
 * nothing about what is on the page. `drawnPages` below inflates the content stream and reads back every
 * string the renderer actually drew, with the point it drew it at, so a collision is an assertion failure
 * instead of a thing somebody notices at a KWSP counter.
 *
 * BOTH of cc9f9420's own layout defects were found this way and are now pinned: "JUMLAH (RM)" printed
 * straight through the total Upah figure on a two-sheet form, and the representative's Jawatan printed
 * through the Cop Rasmi Majikan box.
 */
type Drawn = { x: number; y: number; size: number; bold: boolean; text: string };

/**
 * Every string the renderer DREW, per sheet, with its baseline origin.
 *
 * pdf-lib Flate-compresses each page's content stream and emits text as
 * `/<font>-<id> <size> Tf … 1 0 0 1 <x> <y> Tm <hex> Tj`. Hex is WinAnsi, which is Latin-1, so a raw
 * latin1 decode is exact — and a character the renderer could not encode arrives here as the '?' it will
 * print, which is the point of the fold assertion below.
 */
async function drawnPages(form: ReturnType<typeof borangAFrom>): Promise<Drawn[][]> {
  const buf = Buffer.from(await renderBorangAPdf(form));
  const pages: Drawn[][] = [];
  const OP =
    /\/(Helvetica(?:-Bold)?)-\d+ ([\d.]+) Tf[\s\S]{0,60}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g;
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
    const drawn: Drawn[] = [];
    for (const t of body.matchAll(OP)) {
      drawn.push({
        bold: t[1] === 'Helvetica-Bold',
        size: Number(t[2]),
        x: Number(t[3]),
        y: Number(t[4]),
        text: Buffer.from(t[5], 'hex').toString('latin1'),
      });
    }
    pages.push(drawn);
  }
  // One content stream per sheet, in order. If pdf-lib ever stops emitting them that way the assertions
  // below would silently test the wrong sheet, so it is checked rather than assumed.
  expect(pages, 'one content stream per sheet').toHaveLength(form.pages.length);
  return pages;
}

/**
 * Every RECTANGLE the renderer drew, per sheet — the boxes, which carry no text and are therefore
 * invisible to `drawnPages`. A box that is not drawn is exactly as hard to notice as a value that is
 * clipped, and the missing signature block was both.
 *
 * pdf-lib emits a border-only rectangle as a translate followed by a four-segment closed path:
 * `1 0 0 1 x y cm … 0 0 m / 0 h l / w h l / w 0 l / h / S`.
 */
type Box = { x: number; y: number; w: number; h: number };
async function drawnBoxes(form: ReturnType<typeof borangAFrom>): Promise<Box[][]> {
  const buf = Buffer.from(await renderBorangAPdf(form));
  const RE =
    /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\s+1 0 0 1 0 0 cm\s+1 0 0 1 0 0 cm\s+0 0 m\s+0 (-?[\d.]+) l\s+(-?[\d.]+) -?[\d.]+ l\s+-?[\d.]+ 0 l\s+h\s+S/g;
  const pages: Box[][] = [];
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
      [...body.matchAll(RE)].map((r) => ({ x: Number(r[1]), y: Number(r[2]), h: Number(r[3]), w: Number(r[4]) })),
    );
  }
  expect(pages, 'one content stream per sheet').toHaveLength(form.pages.length);
  return pages;
}

/** Joining with a single space reconstructs every WRAPPED paragraph, because `wrap` splits on /\s+/. */
const flatten = (page: Drawn[]) => page.map((d) => d.text).join(' ');

describe('the KWSP 6 page furniture', () => {
  const longName = 'MUHAMMAD SYAFIQ BIN ABDUL RAHMAN MOHAMED ZULKIFLI';
  const built = (n: number, perPage?: number) =>
    borangAFrom({
      header: header(),
      rows: Array.from({ length: n }, (_, i) => row({ employmentId: `e${i}`, name: longName })),
      perPage,
    });

  it('draws every one of the nine blocks the request named, on the page rather than in a comment', async () => {
    const [sheet] = await drawnPages(built(1));
    const flat = flatten(sheet);
    for (const s of [
      // 1 — masthead and the regulation citation, plus the empty No. Rujukan Borang A slot
      'KWSP 6',
      BORANG_A_CITATION,
      'No. Rujukan Borang A',
      // 2 — payment method
      BORANG_A_PAYMENT_INSTRUCTION,
      ...BORANG_A_PAYMENT_METHODS,
      BORANG_A_PAYMENT_REF_LABEL,
      // 3 — collection agent's stamp
      'Cop Agen Kutipan',
      // 4 — form label and page number together, top right
      'Borang A',
      'Mukasurat: 1/1',
      // 5 — the column order, N K included
      'BIL',
      'NO. AHLI',
      'N K',
      'NO. KAD PENGENALAN',
      'NAMA PEKERJA / AHLI',
      'UPAH (RM)',
      'CARUMAN (RM)',
      'MAJIKAN',
      'PEKERJA',
      // 7 — the signature block, completed
      'Tandatangan Wakil Majikan',
      'No. Tel / Bimbit',
      'Tarikh',
      'Cop Rasmi Majikan',
      // 8 and 9
      'CATATAN',
      BORANG_A_PERINGATAN_MS,
      BORANG_A_PERINGATAN_EN,
    ]) {
      expect(flat, `the drawn page is missing "${s}"`).toContain(s);
    }
    for (const [i, note] of BORANG_A_CATATAN.entries()) expect(flat, note).toContain(`${i + 1}. ${note}`);
  });

  it('carries "(jika ada)" on BOTH carry-forward lines and nowhere near the JUMLAH', async () => {
    // Point 6. The subtotals themselves were already built and proven; only the suffix was missing.
    const sheets = await drawnPages(built(3, 2));
    expect(flatten(sheets[0])).toContain('Jumlah yang dibawa ke mukasurat seterusnya (jika ada)');
    expect(flatten(sheets[1])).toContain('Jumlah yang dibawa dari mukasurat terdahulu (jika ada)');
    // The whole-form total is not a "if any" line and must not acquire the suffix.
    expect(flatten(sheets[1])).toContain('JUMLAH (RM)');
    expect(flatten(sheets[1])).not.toContain('JUMLAH (RM) (jika ada)');
  });

  /**
   * THE N K COLUMN IS PRINTED AND PERMANENTLY EMPTY — catatan 5, "Ruang ketiga (N K) hanya diisi oleh
   * KWSP sahaja". Asserted at the two places it could be broken: the drawn page, and the row type.
   */
  it('never writes anything but the heading into the N K column', async () => {
    const NK_X = 34 + 100;
    const IC_X = 34 + 120;
    const { tableFloor, firstRowTop } = BORANG_A_SHEET_GEOMETRY;
    for (const sheet of await drawnPages(built(BORANG_A_ROWS_PER_PAGE * 2 + 1))) {
      const inColumn = sheet.filter(
        (d) => d.x >= NK_X && d.x < IC_X && d.y >= tableFloor && d.y <= firstRowTop + 40,
      );
      expect(inColumn.map((d) => d.text), 'only the N K heading may print in the N K column').toEqual(['N K']);
    }
  });

  it('gave BorangARow no field for the reserved column, so there is nothing to populate', () => {
    const r = borangAFrom({ header: header(), rows: [row({ employmentId: 'a' })] }).pages[0].rows[0];
    expect(Object.keys(r).sort()).toEqual([
      'employee',
      'employer',
      'employmentId',
      'ic',
      'memberNo',
      'name',
      'staffNo',
      'wage',
      'wageRecorded',
    ]);
  });

  /**
   * THE GENERAL OVERPRINT GUARD. Two strings on the same baseline whose boxes overlap print through each
   * other, and the page still renders, still validates and still returns 200. This is the check that
   * catches the next one.
   */
  it('draws no two strings through each other, on any sheet', async () => {
    const doc = await PDFDocument.create();
    const fonts = {
      false: await doc.embedFont(StandardFonts.Helvetica),
      true: await doc.embedFont(StandardFonts.HelveticaBold),
    } as const;
    const width = (d: Drawn) => fonts[String(d.bold) as 'true' | 'false'].widthOfTextAtSize(d.text, d.size);
    for (const [n, sheet] of (await drawnPages(built(BORANG_A_ROWS_PER_PAGE * 2 + 1))).entries()) {
      const byBaseline = new Map<string, Drawn[]>();
      for (const d of sheet) {
        const k = d.y.toFixed(1);
        byBaseline.set(k, [...(byBaseline.get(k) ?? []), d]);
      }
      for (const line of byBaseline.values()) {
        const sorted = [...line].sort((a, b) => a.x - b.x);
        for (let i = 1; i < sorted.length; i += 1) {
          const prev = sorted[i - 1];
          const end = prev.x + width(prev);
          expect(
            sorted[i].x,
            `sheet ${n + 1}: "${prev.text}" (ends at ${end.toFixed(2)}) prints through "${sorted[i].text}"`,
          ).toBeGreaterThanOrEqual(end - 0.5);
        }
      }
    }
  });

  it('keeps every table row above the foot furniture at the shipped page size', async () => {
    // A middle sheet is the worst case: it carries in AND carries out. Overprinting the CATATAN block is
    // exactly what a rows-per-page chosen by eye rather than measured produces.
    const form = built(BORANG_A_ROWS_PER_PAGE * 2 + 1);
    expect(form.pages).toHaveLength(3);
    for (const [n, sheet] of (await drawnPages(form)).entries()) {
      // Matched on the FIXTURE's own values, not on "looks like a number": the representative's identity
      // card number is drawn in the foot band on purpose and a `\d+` pattern swept it up.
      const table = sheet.filter((d) =>
        /^(17955667|860208105128|MUHAMMAD|6,200\.00|Jumlah yang dibawa|JUMLAH \(RM\))/.test(d.text),
      );
      expect(table.length, `sheet ${n + 1} drew no table text`).toBeGreaterThan(5);
      for (const d of table) {
        expect(d.y, `sheet ${n + 1}: "${d.text}" is drawn into the foot band`).toBeGreaterThanOrEqual(
          BORANG_A_SHEET_GEOMETRY.tableFloor,
        );
      }
    }
  });

  it('never ships more rows per sheet than the drawn page can hold', () => {
    const capacity = borangASheetRowCapacity();
    expect(BORANG_A_ROWS_PER_PAGE).toBeLessThanOrEqual(capacity);
    // …and not wastefully fewer either: one row of headroom is the deliberate margin, a sheet's worth is
    // a mistake. Measured 2026-08-18: capacity 21, shipped 20.
    expect(capacity - BORANG_A_ROWS_PER_PAGE).toBeLessThanOrEqual(3);
  });

  it('clears every column heading of its neighbour, measured on the drawn page', async () => {
    // The r193 lesson: a heading is not clipped, so one wider than its column prints into the next. The
    // positions come from the FINISHED PDF and the widths from the same font, so this cannot drift from
    // the renderer the way a restated copy of COL would.
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const plain = await doc.embedFont(StandardFonts.Helvetica);
    const [sheet] = await drawnPages(built(1));
    const bil = sheet.find((d) => d.text === 'BIL')!;
    const sub = sheet.find((d) => d.text.startsWith('(Seperti'))!;
    for (const baseline of [bil.y, sub.y]) {
      const line = sheet.filter((d) => d.y === baseline).sort((a, b) => a.x - b.x);
      expect(line.length).toBeGreaterThan(2);
      for (let i = 1; i < line.length; i += 1) {
        const prev = line[i - 1];
        const gap = line[i].x - prev.x - (prev.bold ? bold : plain).widthOfTextAtSize(prev.text, prev.size);
        expect(gap, `"${prev.text}" clears "${line[i].text}" by ${gap.toFixed(2)}pt`).toBeGreaterThan(4);
      }
    }
  });

  it('keeps every new caption inside Latin-1, so none of it prints as "?"', async () => {
    // Helvetica is WinAnsi. A curly apostrophe or an en dash pasted into this copy prints as '?' — r193
    // shipped "the agency?s own page" on the sibling form's footer before the fold existed.
    for (const s of [
      ...BORANG_A_CATATAN,
      BORANG_A_PERINGATAN_MS,
      BORANG_A_PERINGATAN_EN,
      BORANG_A_CITATION,
      BORANG_A_PAYMENT_INSTRUCTION,
      BORANG_A_PAYMENT_REF_LABEL,
      ...BORANG_A_PAYMENT_METHODS,
    ]) {
      expect(s, `"${s}" leaves Latin-1`).toMatch(/^[\x20-\x7E]+$/);
    }
    // …and nothing the renderer drew degraded, including the folded typography in the provenance band.
    for (const sheet of await drawnPages(built(1))) {
      expect(flatten(sheet), 'the drawn page prints a "?"').not.toContain('?');
    }
  });

  it('has exactly eight notes, and both outputs read them from the one array', () => {
    expect(BORANG_A_CATATAN).toHaveLength(8);
    // The renderer may not restate a sentence: the whole point of the array is that a supplied KWSP 6
    // page can be dropped in without touching lib/borang-a-pdf.ts.
    const pdfCode = code('lib/borang-a-pdf.ts');
    expect(pdfCode).toContain('BORANG_A_CATATAN');
    for (const note of BORANG_A_CATATAN) expect(pdfCode, `the renderer restates "${note}"`).not.toContain(note);
    const text = borangATextExport(borangAFrom({ header: header(), rows: [row({ employmentId: 'a' })] }));
    for (const [i, note] of BORANG_A_CATATAN.entries()) expect(text).toContain(`${i + 1}. ${note}`);
  });

  it('mirrors every new block in the plain-text twin', () => {
    const text = borangATextExport(borangAFrom({ header: header(), rows: [row({ employmentId: 'a' })] }));
    expect(text).toContain('CARA BAYARAN');
    for (const m of BORANG_A_PAYMENT_METHODS) expect(text).toContain(`[ ] ${m}`);
    expect(text).toContain(BORANG_A_PAYMENT_REF_LABEL);
    expect(text).toContain('No. Tel / Bimbit  :');
    expect(text).toContain('Tarikh            : ____________________');
    expect(text).toContain('Cop Rasmi Majikan');
    expect(text).toContain('Cop Agen Kutipan');
    expect(text).toContain(BORANG_A_PERINGATAN_MS);
    // The text twin's N K column is blank on every row, for the same reason the drawn one is: the field
    // is KWSP's. Columns 20-23 are the N K slot (BIL 5 + NO. AHLI 14).
    const header0 = text.split('\n').find((l) => l.startsWith('BIL  '))!;
    expect(header0.slice(19, 23)).toBe('N K ');
    const rowLine = text.split('\n').find((l) => /^1 {4}17955667/.test(l))!;
    expect(rowLine.slice(19, 23), 'the N K column must be blank on a data row').toBe('    ');
  });

  it('numbers rows across the whole form even when the caller picks its own page size', () => {
    // The text twin used to multiply out BORANG_A_ROWS_PER_PAGE, so a caller-supplied `perPage` renumbered
    // every sheet but the first — and the drawn page, which counts the sheets, disagreed with it silently.
    const rows = Array.from({ length: 5 }, (_, i) => row({ employmentId: `e${i}` }));
    const text = borangATextExport(borangAFrom({ header: header(), rows, perPage: 2 }));
    for (const n of [1, 2, 3, 4, 5]) expect(text, `row ${n}`).toMatch(new RegExp(`^${n} {4}17955667`, 'm'));
  });

  it.each([1, 2, 3])('holds the no-double-counting property at %s sheet(s) of the SHIPPED page size', (pages) => {
    const rows = Array.from({ length: BORANG_A_ROWS_PER_PAGE * pages }, (_, i) =>
      row({ employmentId: `e${i}`, employer: 100 + i, employee: 50 + i, wage: 1000 + i }),
    );
    const form = borangAFrom({ header: header(), rows });
    expect(form.pages).toHaveLength(pages);
    const summed = form.pages.reduce((a, p) => a + p.pageEmployer, 0);
    expect(Math.round(summed * 100) / 100).toBe(form.totalEmployer);
    for (let i = 1; i < form.pages.length; i += 1) {
      expect(form.pages[i].carryInEmployer).toBe(form.pages[i - 1].carryOutEmployer);
    }
    expect(form.pages[form.pages.length - 1].carryOutEmployer).toBe(form.totalEmployer);
  });

  it('still says on its own face that it is not the agency’s page', async () => {
    // FIDELITY STAYS `agency-layout`. Adding the agency's furniture does not make this KWSP's artwork, and
    // the CATATAN wording is transcribed from another vendor's output — the page has to say so.
    const flat = flatten((await drawnPages(built(1)))[0]);
    expect(flat).toContain('bukan borang rasmi KWSP');
    expect(flat).toContain('TRANSCRIBED from a filled Borang A produced by another payroll system');
    expect(flat).toContain('the English line under PERINGATAN is our own translation');
  });
});

/**
 * cc9f9420 verify — NOTHING SOMEBODY SIGNS FOR IS SILENTLY CUT.
 *
 * ⚠️ WHY A GREEN SUITE PROVED NOTHING ABOUT THIS. The first cut of the foot band drew every
 * representative value through a 98pt clip — about twenty characters at 8pt bold — and the fixture at
 * the top of this file happens to sit just under that budget on all five fields, so 318 passing tests
 * said nothing at all. 'NURUL HUDA BINTI ISMAIL' printed as 'NURUL HUDA BINTI ISM' with no ellipsis and
 * no marker, so the page read as if that were the signatory's name; the employer's own name lost its
 * last fifteen characters the same way, and the address lost its `postcode city, state` tail to a
 * `.slice(0, 3)`. The overprint guard above cannot see any of it either: CLIPPING IS EXACTLY HOW YOU
 * MAKE AN OVERPRINT INVISIBLE TO A COLLISION CHECK.
 *
 * So every test below renders PRODUCTION-SHAPED values — the kind the one company in nine that fills
 * this block in actually has — and compares the string the renderer DREW with the value that went in.
 */
describe('nothing somebody signs for is silently cut', () => {
  const LONG = {
    employerName: 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR SDN BHD',
    employerAddress:
      'Level 12, Menara Satu\nJalan Ampang\nBukit Bintang\n50450 Kuala Lumpur, Wilayah Persekutuan',
    repName: 'NURUL HUDA BINTI ISMAIL',
    repIc: '910416145530',
    repPosition: 'ASSISTANT MANAGER, PEOPLE OPS',
    repPhone: '0123081733',
    repEmail: 'payroll@strada.example.com',
  };
  const longForm = (p: Record<string, string> = {}) =>
    borangAFrom({ header: header({ ...LONG, ...p }), rows: [row({ employmentId: 'a' })] });
  const longSheet = async (p: Record<string, string> = {}) => (await drawnPages(longForm(p)))[0];
  const embed = async () => {
    const doc = await PDFDocument.create();
    return {
      false: await doc.embedFont(StandardFonts.Helvetica),
      true: await doc.embedFont(StandardFonts.HelveticaBold),
    } as const;
  };
  const endOf = (d: Drawn, f: Awaited<ReturnType<typeof embed>>) =>
    d.x + f[String(d.bold) as 'true' | 'false'].widthOfTextAtSize(d.text, d.size);

  it('prints every authorised-representative value WHOLE, at whatever size that takes', async () => {
    const drawn = (await longSheet()).map((d) => d.text);
    for (const v of [LONG.repName, LONG.repIc, LONG.repPosition, LONG.repPhone, LONG.repEmail]) {
      expect(drawn, `the drawn page does not carry "${v}" in full`).toContain(v);
    }
  });

  it('prints the employer name in full and EVERY address line, postcode and state included', async () => {
    // `addressLines` builds up to FOUR — addressLine1..3 and a "postcode city, state" tail — and the
    // renderer took the first three, which dropped exactly the tail. It is the line a counter clerk
    // reads, and the plain-text twin was still printing it, so the two outputs disagreed in silence.
    const sheet = await longSheet();
    const drawn = sheet.map((d) => d.text);
    expect(drawn, 'the employer name is cut').toContain(LONG.employerName);
    for (const l of LONG.employerAddress.split('\n')) expect(drawn, `the address line "${l}" is missing`).toContain(l);
    // …and all of it stayed inside the employer box rather than being fitted by running off the bottom.
    const tail = sheet.find((d) => d.text.startsWith('50450'))!;
    const name = sheet.find((d) => d.text === LONG.employerName)!;
    expect(tail.y).toBeLessThan(name.y);
    expect(tail.y).toBeGreaterThan(638.89 + 3);
  });

  it('shrinks a pathological value rather than shortening it, and keeps it inside its column', async () => {
    // Nobody is called this. The point is that the renderer's answer to a value it cannot fit is a
    // SMALLER one and never a SHORTER one, at any length — so no length of name can ever read as
    // somebody else's name on a signed return.
    const monster = 'DATUK SERI PANGLIMA MUHAMMAD SYAFIQ BIN ABDUL RAHMAN MOHAMED ZULKIFLI BIN ABDULLAH SHAH';
    const fonts = await embed();
    const sheet = await longSheet({ repName: monster });
    const v = sheet.find((d) => d.text === monster);
    expect(v, 'the representative name was cut instead of shrunk').toBeDefined();
    expect(v!.size, 'a value that fits should not have been shrunk at all').toBeLessThan(8);
    // The value column runs from SIG_VALUE_X (M + 72 = 106) to an 8pt gutter short of CATATAN_X
    // (M + 294 = 328). Past 320 it prints into the notes; that is the overprint the clip was hiding.
    expect(v!.x).toBe(106);
    expect(endOf(v!, fonts), 'the name ran out of its column').toBeLessThanOrEqual(320.001);
  });

  it('keeps every foot-band value out of the CATATAN column, on the drawn page', async () => {
    const fonts = await embed();
    const sheet = await longSheet();
    const catatan = sheet.find((d) => d.text === 'CATATAN')!;
    // The band between the CATATAN heading and the PERINGATAN line — the two-column part of the foot.
    // Below the warning the page goes back to full width on purpose.
    const warning = sheet.find((d) => d.text.startsWith('PERINGATAN'))!;
    const band = sheet.filter((x) => x.y <= catatan.y && x.y > warning.y && x.x < catatan.x);
    expect(band.length, 'nothing was drawn in the left half of the foot band').toBeGreaterThan(6);
    for (const d of band) {
      expect(endOf(d, fonts), `"${d.text}" prints into the CATATAN column`).toBeLessThanOrEqual(catatan.x);
    }
  });

  it('draws a place to SIGN as well as a place to stamp, both big enough to use', async () => {
    // `main` drew a box captioned "Tandatangan & Tarikh". The first cut of this band replaced it with a
    // Cop Rasmi Majikan box and NOTHING ELSE, so the only "Tandatangan" left on the sheet was the band
    // heading — while the plain-text twin went on advertising a signature line. A Borang A is a signed
    // return; a form with nowhere to sign is not one.
    const sheet = await longSheet();
    const boxes = (await drawnBoxes(longForm()))[0];
    const heading = sheet.find((d) => d.text === 'Tandatangan Wakil Majikan')!;
    const found: Record<string, Box> = {};
    for (const cap of ['Tandatangan', 'Cop Rasmi Majikan']) {
      const t = sheet.find((d) => d.text === cap);
      expect(t, `there is no "${cap}" block on the drawn page — only the band heading`).toBeDefined();
      expect(t!.y, `"${cap}" is the band heading, not a block of its own`).toBeLessThan(heading.y - 100);
      const b = boxes.find((r) => t!.x >= r.x && t!.x <= r.x + r.w && t!.y >= r.y && t!.y <= r.y + r.h);
      expect(b, `"${cap}" is a caption with no box around it`).toBeDefined();
      expect(b!.h, `the "${cap}" box is too shallow to use`).toBeGreaterThanOrEqual(40);
      found[cap] = b!;
    }
    expect(found['Tandatangan'].x, 'the two boxes are the same box').not.toBe(found['Cop Rasmi Majikan'].x);
    // The boxes sit UNDER the rows and ABOVE the warning — which is the whole reason the value column
    // could go back to being wide enough for a name.
    const lastRow = Math.min(...sheet.filter((d) => d.x === 34 && d.y < heading.y && d.y > 120).map((d) => d.y));
    const warning = sheet.find((d) => d.text.startsWith('PERINGATAN'))!;
    for (const b of Object.values(found)) {
      expect(b.y + b.h, 'a signing box overlaps the representative rows').toBeLessThan(lastRow);
      expect(b.y, 'a signing box overlaps the PERINGATAN line').toBeGreaterThan(warning.y + 5);
    }
  });

  it('gives every payment method its own tick box, all of them on the page', async () => {
    // A fixed 150pt stride was fine for two ticks and puts the fifth 634pt from the margin — off the
    // right edge of an A4 sheet. A box drawn off the page is not a box anybody notices is missing.
    const fonts = await embed();
    const sheet = await longSheet();
    const ticks = BORANG_A_PAYMENT_METHODS.map((m) => {
      const d = sheet.find((x) => x.text === m);
      expect(d, `"${m}" has no caption on the drawn page`).toBeDefined();
      return d!;
    });
    expect(new Set(ticks.map((t) => t.y)).size, 'the ticks are not on one baseline').toBe(1);
    // The CARA BAYARAN box ends at HDR_LEFT_R = RIGHT - 126 = 435.28.
    expect(endOf(ticks[ticks.length - 1], fonts), 'the last tick is outside the band').toBeLessThan(435.28);
    // …and one box per caption, at the caption's own baseline.
    const boxes = (await drawnBoxes(longForm()))[0];
    for (const t of ticks) {
      expect(
        boxes.some((b) => Math.abs(b.w - 8) < 0.01 && Math.abs(b.h - 8) < 0.01 && b.x < t.x && t.x - b.x < 20),
        `"${t.text}" has a caption but no tick box`,
      ).toBe(true);
    }
  });

  it('gives each named method a tick of its own, and no tick two methods', () => {
    // The approved plan names five. An approval on this board carries no payload, so there is no reading
    // of it under which the reporter asked for two — and a tick that means "Cek OR Kiriman Wang OR Wang
    // Pos" makes an operator paying by Wang Pos state a payment method they did not use.
    for (const m of ['Wang Tunai', 'Cek', 'Kiriman Wang', 'Wang Pos', 'Draf Bank']) {
      expect(BORANG_A_PAYMENT_METHODS, `"${m}" has no tick of its own`).toContain(m);
    }
    for (const m of BORANG_A_PAYMENT_METHODS) expect(m, `"${m}" is more than one method`).not.toMatch(/[/,]/);
  });

  it('has a payment reference label that reads as Malay rather than as a mis-transcription', () => {
    // It shipped as '/Draf Bank*No /EFT /TT. :' and printed verbatim: a leading slash, an inline '*No'
    // and a stray full stop before the colon. The Latin-1 test proves a string survives the font; it
    // cannot tell you the string is gibberish.
    expect(BORANG_A_PAYMENT_REF_LABEL).toMatch(/^No\. /);
    expect(BORANG_A_PAYMENT_REF_LABEL, 'the reference label is mis-transcribed').not.toMatch(/[*]|\. :$/);
  });

  it('clips nothing at all — every value on the sheet shrinks to fit instead', () => {
    // UPDATED, NOT DELETED. This case used to LICENSE exactly one clip — the employee NAME cell — on the
    // argument that shrinking one row would leave a ragged column of type sizes. The review answered it:
    // the budget had quietly gone 133.28pt to 127.28pt, so names that printed whole before were being cut
    // mid-word, and a truncated legal name on a filed statutory form is a factual error while a ragged
    // column is a cosmetic one. The name now goes through fit-to-width like every other signed value, so
    // the guard asserts the stronger property the form actually needs: NOTHING here is clipped.
    //
    // The clipping helpers are GONE, not merely unused: dead code carrying a docblock that explains why
    // it is dead is an invitation to use it again. (My first version of this guard matched the helper's
    // own definition and failed on it — which is the same 'a guard that cannot mean what it says' problem
    // this file has now hit twice.)
    const pdfCode = code('lib/borang-a-pdf.ts');
    expect(pdfCode, 'a clipping helper is back on this statutory form').not.toMatch(/atClip|textClip/);
    expect(pdfCode, 'the table name must shrink to fit').toContain('textFit(r.name');
  });
});
