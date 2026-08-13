/**
 * 9c8dad7a / 3aae0789 — BORANG A (KWSP monthly contribution form).
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
import {
  BORANG_A_HEADER_KEYS,
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
import { renderBorangAPdf } from '../lib/borang-a-pdf';
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
    expect(text).toContain('No. Rujukan Majikan : 019632261');
    expect(text).toContain('Bulan Caruman       : 08 / 2026  (0826)');
    expect(text).toContain('Bulan Upah          : 2026-07');
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
      [1, 22, 1],
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

  it('keeps braces out of every key rendered without arguments', () => {
    // A message carrying {placeholders} rendered through a plain t('…') throws FORMATTING_ERROR at render
    // time — a 200 that shows the raw key path.
    const INTERPOLATED = new Set(['noBatch', 'tileSheets', 'tileRef', 'periodOverridden', 'missingTitle', 'pageCarry']);
    const braced = Object.entries(ns).filter(([k, v]) => !INTERPOLATED.has(k) && /[{}]/.test(v));
    expect(braced.map(([k]) => k), 'these are rendered with no arguments').toEqual([]);
    for (const k of INTERPOLATED) expect(ns[k], k).toMatch(/\{/);
  });
});
