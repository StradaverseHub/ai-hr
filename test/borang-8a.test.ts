/**
 * 8ca344bf — BORANG 8A (PERKESO monthly contribution schedule).
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: the two dating rules, the page totals, and the four places the
 * form could quietly stop being the form. Everything here fails SILENTLY in production if it regresses —
 * a Borang 8A stamped with the wrong month, or with a page total that does not add up, downloads exactly
 * like a correct one and is discovered at a PERKESO counter.
 *
 * THE SPECIMEN IS NOT AN ARITHMETIC FIXTURE, and nothing below treats it as one. The reporter's attachment
 * (a completed Borang 8A produced by another vendor's DevExpress engine, not PERKESO artwork) shows
 * 202.35 against a wage that does not reconcile to it under the current PERKESO table on either a
 * SOCSO-only or a SOCSO+EIS reading. It was used for the LAYOUT and for the two dating rules — which are
 * exactly what is pinned here — and for nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Borang8AMycoidNotice } from '../app/payroll/borang-8a/mycoid-notice';
import {
  BORANG_8A_HEADER_KEYS,
  BORANG_8A_STATUS_PARAM_PREFIX,
  applyStatusOverrides,
  borang8AFrom,
  borang8ATextExport,
  contributionMonthLabel,
  contributionPeriodFor,
  fallsInMonth,
  formDate,
  missingBorang8AHeader,
  money,
  paginateBorang8A,
  paymentDueDateFor,
  splitRmSen,
  statusOverridesFrom,
  type Borang8ARow,
} from '../lib/borang-8a';
// 9c8dad7a — the OTHER form's rule, imported rather than restated. See the note above
// `kwspContributionPeriodFor` below: the joint assertion is worthless if this file owns both halves.
import { epfContributionPeriodFor } from '../lib/borang-a';
import { MY_REPORTS } from '../localization/my/reports';
import { BORANG_8A_COLUMNS } from '../localization/my/borang-8a';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  BORANG_8A_AMOUNT_HEAD,
  BORANG_8A_HEADINGS,
  BORANG_8A_HEAD_PAD,
  BORANG_8A_HEAD_SIZE,
  BORANG_8A_NAME_CELL,
  borang8AFilename,
  borang8ANameLines,
  renderBorang8APdf,
  wrapTo,
} from '../lib/borang-8a-pdf';
import { REGISTERED_ROUTES } from '../lib/permissions';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Source with its PROSE removed, for the assertions that say "this file must not mention X".
 *
 * These files document exactly what they refuse to do — `shared.ts` explains that `app/` never names
 * `localization/my`, and the review screen explains that a DISABLED button is still a button. Scanning
 * the raw text would make an honest comment fail the test the comment exists to reinforce, and the only
 * fix would be to delete the explanation. Same stripper test/statutory-forms-page.test.ts uses: block
 * comments go (JSDoc and braced JSX comments alike) and only WHOLE-LINE `//` comments go, so a URL inside
 * a string survives.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const LIB = read('lib/borang-8a.ts');
const READ_SRC = read('localization/my/borang-8a.ts');
const PDF_SRC = read('lib/borang-8a-pdf.ts');
const SHARED = read('app/payroll/borang-8a/shared.ts');
const PREVIEW = read('app/payroll/borang-8a/preview/page.tsx');
const PDF_ROUTE = read('app/payroll/borang-8a/pdf/route.ts');
const TEXT_ROUTE = read('app/payroll/borang-8a/text/route.ts');
// Comment-stripped, for the "must NOT contain" assertions only. See `code` above.
const SHARED_CODE = code('app/payroll/borang-8a/shared.ts');
const PREVIEW_CODE = code('app/payroll/borang-8a/preview/page.tsx');
const PDF_ROUTE_CODE = code('app/payroll/borang-8a/pdf/route.ts');
const TEXT_ROUTE_CODE = code('app/payroll/borang-8a/text/route.ts');

const row = (p: Partial<Borang8ARow> & { employmentId: string; contribution: number }): Borang8ARow => ({
  startDate: '',
  stopDate: '',
  status: '',
  ic: '860208105128',
  name: 'ANG PEI YEE',
  // 18c1d92b — the upload file's fields. Defaulted here so every existing case keeps describing the
  // PRINTED form (which does not carry them) without restating five zeros it does not care about.
  socsoEmployer: 0,
  socsoEmployee: 0,
  eisEmployer: 0,
  eisEmployee: 0,
  wage: null,
  ...p,
});

/**
 * THE KWSP RULE — NOW THE REAL ONE, IMPORTED, WHICH IS WHAT THIS SEAT WAS HELD FOR.
 *
 * r193 could only write a LOCAL copy of the +1 rule here, because the EPF Borang A did not exist yet, and
 * said in as many words: "WHEN BORANG A IS BUILT, DELETE THIS AND IMPORT ITS OWN EXPORTED RULE. A test
 * that states both sides itself can only ever prove the two sides of ITSELF differ." r194 built it
 * (9c8dad7a), so the placeholder is gone and the joint assertion below now compares two rules that two
 * different modules actually use in production.
 *
 * The fact both sides encode, unchanged: the reporter's own two attachments both come off the JULY 2026
 * payroll. The SOCSO one is stamped 07/2026; the EPF one is stamped 08/2026.
 */
const kwspContributionPeriodFor = epfContributionPeriodFor;

describe('the no-offset rule', () => {
  /**
   * The case a copied `+1` breaks most visibly is December, because it also rolls the YEAR — a Borang 8A
   * for December 2026 stamped 01/2027 is filed against the wrong year, not just the wrong month.
   */
  it.each([
    ['2026-01', '2026-01'],
    ['2026-07', '2026-07'],
    ['2026-11', '2026-11'],
    ['2026-12', '2026-12'],
    ['2027-01', '2027-01'],
  ])('a %s payroll produces a %s contribution month, with no shift', (payroll, expected) => {
    expect(contributionPeriodFor(payroll)).toBe(expected);
  });

  it('refuses a period that is not YYYY-MM rather than reading it as a batch key', () => {
    // "2026-13" would otherwise sail through and produce a plausible-looking EMPTY form.
    for (const bad of ['2026-13', '2026-00', '202607', '2026-7', '', 'abcd-ef']) {
      expect(() => contributionPeriodFor(bad), bad).toThrow();
    }
  });

  it('labels the month the way the specimen does', () => {
    expect(contributionMonthLabel('2026-07')).toBe('07 / 2026');
    expect(contributionMonthLabel('2026-12')).toBe('12 / 2026');
  });

  /**
   * THE JOINT ASSERTION. It fails if the two rules ever agree — which is precisely what a copy-paste from
   * the KWSP module into this one would cause.
   */
  it.each(['2026-01', '2026-07', '2026-11', '2026-12'])(
    'the EPF and SOCSO contribution months for %s differ by exactly one month, and never agree',
    (payroll) => {
      const socso = contributionPeriodFor(payroll);
      const epf = kwspContributionPeriodFor(payroll);
      expect(socso, `SOCSO and EPF must not stamp the same month for ${payroll}`).not.toBe(epf);
      const months = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7));
      expect(months(epf) - months(socso)).toBe(1);
    },
  );

  /**
   * SOURCE SHAPE, across BOTH halves — because a defect in the contract between two files passes a unit
   * test of either half. The read must derive its period ONLY through `contributionPeriodFor`, and neither
   * file may contain a month shift for any reason.
   */
  it('has no month arithmetic in either half, and the read derives its period through the rule', () => {
    expect(READ_SRC).toContain('contributionPeriodFor(params.periodKey)');
    const SHIFT = /\b(month|mm|m)\s*[+-]\s*1\b|setMonth\(|addMonths|getMonth\(\)\s*[+-]/i;
    expect(SHIFT.test(LIB), 'lib/borang-8a.ts must contain no month shift').toBe(false);
    expect(SHIFT.test(READ_SRC), 'localization/my/borang-8a.ts must contain no month shift').toBe(false);
    // …and the form carries BOTH keys, so a divergence would be visible on the document itself rather
    // than only in a test.
    expect(READ_SRC).toContain('contributionPeriodKey: periodKey');
    expect(READ_SRC).toContain('payrollPeriodKey: params.periodKey');
  });
});

describe('the payment deadline', () => {
  /** The specimen: a 07/2026 form says "tidak lewat daripada 31/07/2026". */
  it.each([
    ['2026-07', '31/07/2026'],
    ['2026-02', '28/02/2026'],
    ['2024-02', '29/02/2024'], // a leap February — the one month a hardcoded 28 gets wrong
    ['2026-04', '30/04/2026'],
    ['2026-12', '31/12/2026'],
  ])('%s is due on %s — the LAST DAY of the contribution month', (period, due) => {
    expect(paymentDueDateFor(period)).toBe(due);
  });

  /**
   * NOT THE 15TH OF THE FOLLOWING MONTH. That is the ASSIST deadline the combined SOCSO+EIS return carries
   * (`dueDayOfNextMonth: 15`), and printing it on this form would move the deadline two weeks later.
   */
  it('is never the 15th-of-next-month rule the ASSIST listing beside it uses', () => {
    for (const p of ['2026-01', '2026-07', '2026-12']) {
      const due = paymentDueDateFor(p);
      expect(due.slice(0, 2), p).not.toBe('15');
      // The month printed in the deadline is the CONTRIBUTION month, not the one after it.
      expect(due.slice(3, 5)).toBe(p.slice(5, 7));
      expect(due.slice(6)).toBe(p.slice(0, 4));
    }
    // The catalog entry must NOT declare a dueDayOfNextMonth, or the shelf would print the wrong date.
    expect(MY_REPORTS.find((r) => r.id === 'my.borang-8a')!.submission!.dueDayOfNextMonth).toBeNull();
  });
});

describe('column (1) — the start and stop dates', () => {
  it('formats as ddmmyyyy with no separators, the specimen’s own (hhbbtttt)', () => {
    expect(formDate('2026-07-14')).toBe('14072026');
    expect(formDate('2026-01-01')).toBe('01012026');
  });

  it('is blank rather than wrong for an absent or malformed date', () => {
    for (const bad of [null, undefined, '', '2026-07', 'not-a-date']) expect(formDate(bad)).toBe('');
  });

  /** Filled ONLY inside the contribution month — a joining date printed every month reads as a new joiner. */
  it('is filled only when the event falls inside the contribution month', () => {
    expect(fallsInMonth('2026-07-14', '2026-07')).toBe(true);
    expect(fallsInMonth('2026-06-30', '2026-07')).toBe(false);
    expect(fallsInMonth('2026-08-01', '2026-07')).toBe(false);
    expect(fallsInMonth(null, '2026-07')).toBe(false);
  });
});

describe('column (5) — the RM / SEN split', () => {
  it.each([
    [202.35, '202', '35'],
    [0, '0', '00'],
    [1234.5, '1,234', '50'],
    [9.05, '9', '05'],
    [1000000, '1,000,000', '00'],
  ])('%s prints as RM %s and SEN %s', (amount, rm, sen) => {
    expect(splitRmSen(amount as number)).toEqual({ rm, sen });
  });

  // Rounding happens ONCE, at the cent — 0.1 + 0.2 must not print as 0.30000000000000004's neighbours.
  it('rounds at the cent rather than accumulating float error', () => {
    expect(splitRmSen(0.1 + 0.2)).toEqual({ rm: '0', sen: '30' });
    expect(money(0.1 + 0.2)).toBe('0.30');
  });
});

describe('pagination, and the total a PERKESO clerk reconciles', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ employmentId: `e${i}`, contribution: 10 + i, name: `EMP ${i}` }));

  /** The build note's own case: the page totals must sum to Amaun Caruman at 1, 2 AND 3 pages. */
  it.each([
    [5, 1],
    [20, 1],
    [21, 2],
    [40, 2],
    [41, 3],
  ])('%i employees make %i sheet(s), whose totals sum to the form total', (count, sheets) => {
    const rows = make(count as number);
    const form = borang8AFrom({ header: HEADER, rows });
    expect(form.pages.length).toBe(sheets);
    expect(form.employees).toBe(count);
    const summed = form.pages.reduce((a, p) => a + p.pageTotal, 0);
    expect(Math.round(summed * 100)).toBe(Math.round(form.total * 100));
    // Every sheet knows its own place in the run, for the "Lembaran n/N" line.
    expect(form.pages.map((p) => `${p.sheet}/${p.of}`)).toEqual(
      Array.from({ length: sheets as number }, (_, i) => `${i + 1}/${sheets}`),
    );
  });

  /** A page total is summed from the rows ON THAT PAGE, never apportioned from the whole. */
  it('totals each sheet from its own rows', () => {
    const pages = paginateBorang8A(make(3), 2);
    expect(pages.map((p) => p.pageTotal)).toEqual([21, 12]); // (10+11), (12)
  });

  /** "Lembaran 1/0" is not a thing, and a form with no sheet cannot be filed or filed away. */
  it('produces one empty sheet rather than none for an empty schedule', () => {
    const pages = paginateBorang8A([]);
    expect(pages.length).toBe(1);
    expect(pages[0]).toMatchObject({ sheet: 1, of: 1, rows: [], pageTotal: 0 });
  });
});

const HEADER: Record<string, string> = {
  employerCode: 'B3201005082P',
  mycoid: '',
  employerName: 'ENGENIOUS SOLUTIONS SDN BHD',
  employerAddress: 'Line one\nLine two\n50000 Kuala Lumpur, Wilayah Persekutuan',
  contributionMonth: '07 / 2026',
  contributionPeriodKey: '2026-07',
  payrollPeriodKey: '2026-07',
  paymentDueDate: '31/07/2026',
};

describe('the header contract between the read and the renderer', () => {
  /**
   * PINNED ACROSS BOTH HALVES, because that is where this class of defect lives: the read puts the header
   * on `meta.formHeader` and the renderer reads it back, and a unit test of either half passes throughout
   * while the key names drift apart.
   */
  it('names the same keys on both sides', () => {
    for (const k of BORANG_8A_HEADER_KEYS) {
      expect(READ_SRC, `the read must fill ${k}`).toContain(`${k}:`);
    }
    // MyCoID is REUSED from ssm_registration_no rather than given a column of its own — one number, one home.
    expect(READ_SRC).toContain('companyStatutoryMy.ssmRegistrationNo');
    expect(READ_SRC).toContain('companyStatutoryMy.socsoEmployerCode');
    expect(code('localization/my/borang-8a.ts')).not.toContain('mycoidNo');
  });

  /**
   * ⚠️ THIS REVERSES HALF OF WHAT THIS TEST FIRST ASSERTED, AND THE REVERSAL IS THE FINDING.
   *
   * `borang8AFrom` originally THREW on an incomplete header, which is the right instinct in the wrong
   * place. Rendering the review screen against a company that had never filled in its SOCSO employer code
   * produced a 500 — on the one screen whose entire job is to tell an operator what is missing. Found by
   * rendering it on a dev server; tsc, the suite and the route's own status were all green.
   *
   * The half that is still true — a Borang 8A missing its employer code must NOT be produced — is kept,
   * and moved to where it belongs: the gaps are REPORTED by `missingBorang8AHeader` and the LOADER refuses
   * the download. Reporting on a render path, refusing on a produce path.
   */
  it('reports an incomplete header instead of throwing on a render path', () => {
    for (const k of ['employerCode', 'employerName', 'contributionMonth', 'paymentDueDate']) {
      const broken = { ...HEADER, [k]: '' };
      expect(missingBorang8AHeader(broken), k).toEqual([k]);
      expect(() => borang8AFrom({ header: broken, rows: [] }), k).not.toThrow();
    }
    expect(missingBorang8AHeader(undefined).length).toBeGreaterThan(0);
    expect(() => borang8AFrom({ header: undefined, rows: [] })).not.toThrow();
    // …and a complete header reports nothing, or the gate would block every download forever.
    expect(missingBorang8AHeader(HEADER)).toEqual([]);
  });

  /** MyCoID is blank in the reporter's own specimen, so an empty value is a legitimate answer for it. */
  it('accepts a blank MyCoID, because the specimen leaves it blank', () => {
    expect(missingBorang8AHeader({ ...HEADER, mycoid: '' })).toEqual([]);
    expect(missingBorang8AHeader({ ...HEADER, employerAddress: '' })).toEqual([]);
  });

  it('splits the employer address back into lines', () => {
    const form = borang8AFrom({ header: HEADER, rows: [] });
    expect(form.employerAddress).toEqual(['Line one', 'Line two', '50000 Kuala Lumpur, Wilayah Persekutuan']);
  });
});

describe('the typed STATUS column', () => {
  /**
   * ⚠️ READ BY VALUE, NEVER BY PRESENCE — the trap that once shipped a pay-affecting setting nobody could
   * turn off. Every row on the review screen submits its status box whether or not anything was typed into
   * it, so `params.has(key)` is TRUE for all 33 people and would stamp a status on every line of the form.
   */
  it('ignores the boxes that were submitted empty, which is every untouched row', () => {
    const q = new URLSearchParams();
    q.set(`${BORANG_8A_STATUS_PARAM_PREFIX}a`, '');
    q.set(`${BORANG_8A_STATUS_PARAM_PREFIX}b`, '   ');
    q.set(`${BORANG_8A_STATUS_PARAM_PREFIX}c`, 'BARU');
    q.set('companyId', 'not-a-status');
    const overrides = statusOverridesFrom(q);
    expect([...overrides]).toEqual([['c', 'BARU']]);
  });

  it('caps a status at the width of the printed cell', () => {
    const q = new URLSearchParams([[`${BORANG_8A_STATUS_PARAM_PREFIX}a`, 'X'.repeat(50)]]);
    expect(statusOverridesFrom(q).get('a')).toBe('X'.repeat(12));
  });

  it('overlays only the rows it names, and invents no code list', () => {
    const rows = [row({ employmentId: 'a', contribution: 1 }), row({ employmentId: 'b', contribution: 2 })];
    const out = applyStatusOverrides(rows, new Map([['b', 'BERHENTI']]));
    expect(out.map((r) => r.status)).toEqual(['', 'BERHENTI']);
    // The read itself never derives a status — PERKESO's code list is not in the specimen and is not invented.
    expect(READ_SRC).toContain("status: ''");
  });

  it('is what the review screen submits, under the prefix the loader reads', () => {
    expect(PREVIEW).toContain('`${BORANG_8A_STATUS_PARAM_PREFIX}${r.employmentId}`');
    expect(SHARED).toContain('statusOverridesFrom(p.query)');
  });
});

describe('the plain-text twin', () => {
  const form = borang8AFrom({
    header: HEADER,
    rows: [row({ employmentId: 'a', contribution: 202.35, startDate: '14072026', status: 'BARU' })],
  });
  const text = borang8ATextExport(form);

  it('carries the header, the row and the two totals', () => {
    expect(text).toContain('B3201005082P');
    expect(text).toContain('ENGENIOUS SOLUTIONS SDN BHD');
    expect(text).toContain('07 / 2026');
    expect(text).toContain('31/07/2026');
    expect(text).toContain('ANG PEI YEE');
    expect(text).toContain('202.35');
    expect(text).toContain('Jumlah muka surat ini');
    expect(text).toContain('Lembaran 1/1');
  });

  /** It says what it is. A page that looks like a government form and is not one is the whole risk. */
  it('says on its face that it is not PERKESO artwork', () => {
    expect(text).toMatch(/NOT PERKESO ARTWORK/i);
    expect(PDF_SRC).toContain('bukan borang rasmi PERKESO');
  });

  it('names the blocks that are left blank on purpose', () => {
    for (const b of ['Kaedah Pembayaran', 'Tandatangan', 'Kegunaan Ejen Pemungut']) expect(text).toContain(b);
    // …and the drawn page leaves the same ones empty rather than pre-filling them.
    for (const b of ['Kaedah Pembayaran', 'Tandatangan', 'Kegunaan Ejen Pemungut']) expect(PDF_SRC).toContain(b);
    // 16f2aac1 added three more manual fields; every one is the operator's or the agent's, never ours.
    for (const b of ['Nama', 'No. Slip Bayaran', 'Cop']) expect(text).toContain(b);
  });

  /**
   * 16f2aac1 — THE REPORTER'S NINE CORRECTIONS, pinned as the STRINGS THEY ASKED FOR rather than loosened.
   *
   * Every one is wording or position; not one is a figure, which is why the two dating rules above are
   * untouched and still pass. These assertions exist because the form's whole value is that it reads like
   * the agency's page: a heading that quietly reverts to a shortened form is invisible in every other
   * check, since the PDF still renders, still totals, and still answers 200.
   */
  it('prints the nine corrections, in the reporter’s own words', () => {
    // 1 — the legal reference, above the title.
    expect(PDF_SRC).toContain('PERATURAN-PERATURAN (AM) KESELAMATAN SOSIAL PEKERJA 1971 (PER. 44A)');
    expect(text).toContain('PERATURAN-PERATURAN (AM) KESELAMATAN SOSIAL PEKERJA 1971 (PER. 44A)');
    // 2 — one title line, the month and year in their own boxes under bulan / tahun.
    expect(PDF_SRC).toContain("'CARUMAN GAJI BULAN'");
    expect(PDF_SRC).toContain("TR('BORANG 8A'");
    for (const cap of ["'bulan'", "'tahun'"]) expect(PDF_SRC).toContain(cap);
    expect(text).toContain('CARUMAN GAJI BULAN 07 / 2026');
    // 3 — the four-field row, relabelled, with the contribution month no longer in it.
    for (const l of ['No. Kod Majikan', 'No. MyCoID / No. Pendaftaran Perniagaan', 'Amaun Caruman (RM)']) {
      expect(PDF_SRC).toContain(l);
      expect(text).toContain(l);
    }
    // 4 — Lembaran and Bil. Pekerja up beside the employer's name and address.
    for (const l of ['Nama dan Alamat Majikan', 'Lembaran', 'Bil. Pekerja']) expect(PDF_SRC).toContain(l);
    // 5 — the deadline sentence, verbatim. The DATE is unchanged and is asserted elsewhere.
    const sentence = 'Amaun caruman di atas hendaklah dibayar kepada PERKESO/EJEN PEMUNGUT tidak lewat daripada';
    expect(PDF_SRC).toContain(sentence);
    expect(text).toContain(sentence);
    // 6 — the collecting agent's box, with both of its fields.
    for (const l of ['Kegunaan Ejen Pemungut', 'Cop', 'No. Slip Bayaran']) expect(PDF_SRC).toContain(l);
    // 7 and 8 — the merged date column and the two full column names.
    expect(BORANG_8A_HEADINGS.map((h) => h.parts[0])).toEqual([
      'TARIKH MULA/BERHENTI KERJA',
      'STATUS',
      'NO. KAD PENGENALAN',
      'NAMA PEKERJA (MENGIKUT KAD PENGENALAN)',
    ]);
    // 9 — the payment block, in the reporter's order, with the signature box split into three.
    expect(PDF_SRC).toContain('Kaedah Pembayaran (Sila tandakan (x))');
    expect(text).toContain('Kaedah Pembayaran (Sila tandakan (x))');
    const opts = [...PDF_SRC.matchAll(/\['(Tunai|Kiriman Wang|Cek|Lain-lain)', \d+, \d+\]/g)].map((m) => m[1]);
    expect(opts).toEqual(['Tunai', 'Kiriman Wang', 'Cek', 'Lain-lain']);
    for (const f of ['Tandatangan', 'Nama', 'No. Tel &', 'No. Cek / Kiriman Wang']) expect(PDF_SRC).toContain(f);
  });

  /**
   * THE SHORTENED HEADINGS MUST NOT COME BACK. They were shortened once, deliberately, because the full
   * wording overflowed its column and printed "(1) Tarikh Berhenti(2) Status" as a single run — and 16f2aac1
   * is the reporter telling us the shortening was the wrong trade. `wrapTo` is what makes the full wording
   * safe now, so a future "it doesn't fit, trim it" would silently undo this whole round.
   */
  it('never falls back to the shortened column headings', () => {
    for (const old of ["'(3) No. K/P'", "'(4) Nama Pekerja'", "'(1) Mula Kerja'", "'(1) Berhenti Kerja'"]) {
      expect(code('lib/borang-8a-pdf.ts'), old).not.toContain(old);
    }
    expect(BORANG_8A_COLUMNS.find((c) => c.key === 'ic')!.label).toBe('(3) No. Kad Pengenalan');
    expect(BORANG_8A_COLUMNS.find((c) => c.key === 'name')!.label).toBe('(4) Nama Pekerja (Mengikut Kad Pengenalan)');
  });

  /**
   * THE OVERFLOW BUG, PINNED MECHANICALLY RATHER THAN BY EYE.
   *
   * pdf-lib does not clip text: a heading wider than its column prints straight into its neighbour, which
   * is what "(1) Tarikh Berhenti(2) Status" was. It was found by rasterising the page and looking at it,
   * and nothing else could see it. This embeds the REAL Helvetica-Bold and measures every wrapped line
   * against the column it will be drawn in — so widening a heading, narrowing a column, or bumping the
   * point size fails here instead of on a filed form. A single word longer than its own column cannot be
   * wrapped by anything, and that is the case this really catches.
   */
  it('wraps every column heading inside its own column, at the real font metrics', async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const h of BORANG_8A_HEADINGS) {
      const maxW = h.col.w - BORANG_8A_HEAD_PAD;
      expect(maxW, `${h.key}: column must leave room for a heading`).toBeGreaterThan(0);
      for (const part of h.parts) {
        for (const l of wrapTo(part, maxW, BORANG_8A_HEAD_SIZE, bold)) {
          expect(bold.widthOfTextAtSize(l, BORANG_8A_HEAD_SIZE), `${h.key}: "${l}"`).toBeLessThanOrEqual(maxW);
        }
      }
    }
  });

  /**
   * THE ONE HEADING THE WRAP TEST ABOVE STRUCTURALLY CANNOT SEE.
   *
   * "CARUMAN (5)" is not in BORANG_8A_HEADINGS because it does not belong to a column — it SPANS the RM and
   * SEN columns — and the test above only ever measures a line against its own column's width, never
   * against where a vertical rule actually falls. So the first draft of this round ruled COL.sen.x through
   * the full height of the heading band in the same loop as every other column edge, and printed the
   * divider straight through the word, between its 'A' and its 'N': 33.4pt of CARUMAN centred at 521.14
   * spans 504.4..537.9, and the divider stands at 533. It printed on EVERY sheet and was found by
   * rasterising the page — exactly the defect class this round claims to have eliminated.
   *
   * A spanned heading needs a spanned cell. This measures that, at the real font metrics.
   */
  it('never rules the RM/SEN divider through the heading that spans them', async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const A = BORANG_8A_AMOUNT_HEAD;
    // Helvetica's cap height is 0.717em; 0.75 is the conservative rounding for a clearance check.
    const capH = BORANG_8A_HEAD_SIZE * 0.75;

    for (const s of A.spanning) {
      const w = bold.widthOfTextAtSize(s.text, BORANG_8A_HEAD_SIZE);
      const lo = A.span.x + A.span.w / 2 - w / 2;
      expect(lo, `${s.text}: starts inside the spanned cell`).toBeGreaterThanOrEqual(A.span.x);
      expect(lo + w, `${s.text}: ends inside the spanned cell`).toBeLessThanOrEqual(A.span.x + A.span.w);
      // It MAY straddle the divider — that is what "spanned" means. What it may never do is straddle a
      // divider that is RULED across its baseline, so anything crossing must sit above the split rule.
      if (lo < A.divider && lo + w > A.divider) {
        expect(s.dy, `${s.text}: straddles the divider, so it must sit above the split rule`).toBeGreaterThan(
          A.splitDy,
        );
      }
    }
    // 'CARUMAN' is the case that fires: if a future edit stops it straddling, the branch above goes untaken
    // and quietly stops testing anything. Pin that it is still the real case.
    const caruman = A.spanning.find((s) => s.text === 'CARUMAN')!;
    const cw = bold.widthOfTextAtSize(caruman.text, BORANG_8A_HEAD_SIZE);
    expect(A.span.x + A.span.w / 2 - cw / 2).toBeLessThan(A.divider);
    expect(A.span.x + A.span.w / 2 + cw / 2).toBeGreaterThan(A.divider);

    // The sub-heads under the split rule get a column each, and must stay inside it and clear of the rule.
    for (const u of A.under) {
      const w = bold.widthOfTextAtSize(u.text, BORANG_8A_HEAD_SIZE);
      const lo = u.col.x + u.col.w / 2 - w / 2;
      expect(lo, `${u.text}: starts inside its own column`).toBeGreaterThanOrEqual(u.col.x);
      expect(lo + w, `${u.text}: ends inside its own column`).toBeLessThanOrEqual(u.col.x + u.col.w);
      expect(u.dy + capH, `${u.text}: sits clear below the split rule`).toBeLessThan(A.splitDy);
    }
    // The spanning lines clear the split rule from above, and each other.
    const bottom = Math.min(...A.spanning.map((s) => s.dy));
    expect(bottom, 'the lowest spanning line clears the split rule').toBeGreaterThan(A.splitDy + 1);
    // …and the whole block fits the shortest heading band the layout can produce (one row per line, 8pt
    // apiece, plus 5pt of padding), so a column that needs fewer lines cannot crop CARUMAN off the top.
    const shortestBand = (A.spanning.length + 1) * 8 + 5;
    expect(Math.max(...A.spanning.map((s) => s.dy)) + capH).toBeLessThanOrEqual(shortestBand);

    // The geometry above is only true of the drawn page if the draw reads it. Both rules do.
    expect(PDF_SRC).toContain('hline(headBot + A.splitDy, A.span.x, RIGHT)');
    expect(PDF_SRC).toContain('x === BORANG_8A_AMOUNT_HEAD.divider ? headBot + BORANG_8A_AMOUNT_HEAD.splitDy : ey');
  });

  /**
   * THE EMPLOYER'S LEGAL NAME IS BOUNDED, like every other payroll-derived string on the page.
   *
   * It was the one that was not: drawn with a bare `T` while the address lines directly beneath it in the
   * same cell were clipped — and correction 4 is what gave it something to collide with, by moving
   * Lembaran and Bil. Pekerja UP onto its row. `co.legalName` is unbounded, and the cell is 320pt wide, so
   * "PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SEMBILAN SDN BHD" (357.3pt at 10pt bold) crossed the `d1`
   * rule and put 'BHD' beside the sheet number. Seen only by rasterising the page with a real registered
   * name on it; the reporter's own specimen is 27 characters and fits with room to spare.
   */
  it('holds the employer’s legal name inside its own cell, however long the name is', async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const { w, size } = BORANG_8A_NAME_CELL;
    const names = [
      'ENGENIOUS SOLUTIONS SDN BHD',
      'MALAYSIAN TECHNOLOGY DEVELOPMENT CORPORATION SDN BHD',
      'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SEMBILAN SDN BHD',
      // The pathological pair: one unbreakable word, and a name too long for even two lines.
      'X'.repeat(120),
      `${'PERBADANAN PEMBANGUNAN '.repeat(6)}SDN BHD`,
      '',
    ];
    for (const n of names) {
      const lines = borang8ANameLines(n, bold);
      expect(lines.length, `"${n.slice(0, 24)}…": at most two lines, so the address still fits`).toBeLessThanOrEqual(2);
      for (const l of lines) {
        expect(bold.widthOfTextAtSize(l, size), `"${l}"`).toBeLessThanOrEqual(w);
      }
    }
    // A name that DOES fit is never broken or truncated: the reporter's own specimen prints whole.
    expect(borang8ANameLines('ENGENIOUS SOLUTIONS SDN BHD', bold)).toEqual(['ENGENIOUS SOLUTIONS SDN BHD']);
    // …and the draw goes through the clip rather than round it, which is what the defect was.
    expect(PDF_SRC).toContain('TClip(l, nx, ay, nw, nsize, bold)');
    expect(PDF_SRC).not.toContain('T(form.employerName');
  });

  it('paginates like the drawn form, sheet totals and all', () => {
    const many = borang8AFrom({
      header: HEADER,
      rows: Array.from({ length: 25 }, (_, i) => row({ employmentId: `e${i}`, contribution: 1 })),
    });
    const t = borang8ATextExport(many);
    expect(t).toContain('Lembaran 1/2');
    expect(t).toContain('Lembaran 2/2');
    expect(t.match(/Jumlah muka surat ini/g)!.length).toBe(2);
  });
});

describe('the drawn page actually renders', () => {
  /**
   * pdf-lib is only exercised at REQUEST time, so a bad coordinate, a missing glyph or an unembedded font
   * is a 500 on the download and on nothing else — tsc and every other test here stay green. Rendering it
   * in-process is the cheapest possible proof that the route does not crash.
   */
  it('produces a real PDF for one sheet and for two', async () => {
    for (const [count, sheets] of [
      [1, 1],
      [25, 2],
    ] as const) {
      const form = borang8AFrom({
        header: HEADER,
        rows: Array.from({ length: count }, (_, i) =>
          row({ employmentId: `e${i}`, contribution: 202.35, name: `EMPLOYEE NUMBER ${i}`, status: 'BARU' }),
        ),
      });
      expect(form.pages.length).toBe(sheets);
      const bytes = await renderBorang8APdf(form);
      expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  /** A non-Latin-1 legal name degrades to '?' rather than throwing — the documented ea-pdf limitation. */
  it('does not crash on a name Helvetica cannot encode', async () => {
    const form = borang8AFrom({ header: HEADER, rows: [row({ employmentId: 'a', contribution: 1, name: '陳大文' })] });
    await expect(renderBorang8APdf(form)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('names the file after the employer code and the CONTRIBUTION month', () => {
    const form = borang8AFrom({ header: HEADER, rows: [] });
    expect(borang8AFilename(form, 'pdf')).toBe('borang-8a-B3201005082P-202607.pdf');
    expect(borang8AFilename(form, 'txt')).toBe('borang-8a-B3201005082P-202607.txt');
  });
});

describe('the catalog entry', () => {
  it('is a generatable report on the PERKESO shelf, at the position the planned entry held', () => {
    const def = MY_REPORTS.find((r) => r.id === 'my.borang-8a')!;
    expect(def.shelfOrder).toBe(2);
    expect(def.periodKind).toBe('month');
    expect(def.cadence).toBe('monthly');
    expect(typeof def.generate).toBe('function');
    expect(def.descriptionKey).toBe('desc_borang_8a');
    expect((en.payroll.statutoryForms as Record<string, string>).desc_borang_8a).toBeTruthy();
  });

  /** The schedule's own columns, in the specimen's numbering — so the screen and the drawn page agree. */
  it('declares the specimen’s own five numbered columns', () => {
    expect(BORANG_8A_COLUMNS.map((c) => c.key)).toEqual([
      'startDate',
      'stopDate',
      'status',
      'ic',
      'name',
      'contribution',
    ]);
    for (const c of BORANG_8A_COLUMNS) expect(c.label, c.key).toMatch(/^\(\d\)/);
  });

  /**
   * THE AMOUNT IS TAKEN, NOT RECALCULATED, and it is SOCSO alone. Folding EIS in would inflate every line
   * against the payroll it is meant to reconcile to; EIS is its own PERKESO filing.
   */
  it('takes SOCSO employee + employer off the run, and folds in neither EIS nor SKBBK', () => {
    expect(READ_SRC).toContain('num(st.socsoEmployee) + num(st.socsoEmployer)');
    expect(READ_SRC).toContain('contribution: a.socso');
    expect(code('localization/my/borang-8a.ts')).not.toContain('contribution: a.socso + a.eis');
    // Both excluded figures are SHOWN beside the form total rather than silently dropped, so a divergence
    // is visible before filing — which is what the build note asked for.
    expect(READ_SRC).toContain('EIS — filed separately');
    expect(READ_SRC).toContain('SKBBK — not on this form');
  });
});

describe('the three surfaces cannot disagree, and the readiness gate is not a UI courtesy', () => {
  /** ONE loader: same scope check, same period validation, same gate, same status merge. */
  it('routes every surface through the shared loader', () => {
    for (const [name, src] of [
      ['preview', PREVIEW],
      ['pdf route', PDF_ROUTE],
      ['text route', TEXT_ROUTE],
    ] as const) {
      expect(src, `${name} must use the shared loader`).toContain('loadBorang8A');
    }
    // Neither route reimplements the readiness decision.
    for (const src of [PDF_ROUTE, TEXT_ROUTE]) expect(src).toContain("loaded.reason === 'not-found'");
  });

  /**
   * A URL IS NOT A SCREEN. Hiding the download button while the route still answered 200 would let a
   * bookmarked link file a Borang 8A with somebody's IC box empty. The gate lives in the loader, and only
   * the review screen — which exists to NAME who is missing — opts out of it.
   */
  it('refuses to produce the document while anyone is missing an IC, or the company its employer code', () => {
    expect(SHARED).toContain('const headerMissing = missingBorang8AHeader(result.meta.formHeader)');
    expect(SHARED).toContain('if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete)');
    expect(PREVIEW).toContain('includeIncomplete: true');
    expect(PDF_ROUTE_CODE).not.toContain('includeIncomplete');
    expect(TEXT_ROUTE_CODE).not.toContain('includeIncomplete');
    // …and the screen renders NO download buttons at all in that state — not disabled ones, which are
    // still buttons and still get clicked at.
    expect(PREVIEW).toContain('const ready = missing.length === 0 && headerMissing.length === 0');
    // The employer-level gap gets its OWN banner: it is fixed once, under Organization, and merging it
    // into the per-employee list would send an operator to the wrong screen.
    expect(PREVIEW).toContain("t('headerMissingTitle')");
    expect(PREVIEW).toContain("t('headerMissingHint')");
    expect(PREVIEW).toContain("t('downloadsBlocked')");
    expect(PREVIEW_CODE).not.toContain('disabled');
  });

  /** Fails closed TWICE, and answers one bare 404 for every way of being refused. */
  it('fails closed on admin AND on company scope, and cannot be used to enumerate either', () => {
    expect(SHARED).toContain('scopedAdmin()');
    expect(SHARED).toContain('scopeIds.includes(p.companyId)');
    expect(SHARED_CODE).not.toContain('isAdmin(');
    for (const src of [PDF_ROUTE_CODE, TEXT_ROUTE_CODE]) {
      expect(src).toContain("new Response('Not found', { status: 404 })");
      expect(src).not.toContain('status: 403');
    }
  });

  /**
   * ADR-0080 D1 — `app/` reaches the pack ONLY through the registry-backed core seam. The country-pack
   * drift ratchet enforces this globally; asserting it here as well puts the reason next to the code.
   */
  it('reaches the pack through core/reporting, never by importing localization/my', () => {
    for (const [name, src] of [
      ['shared', SHARED_CODE],
      ['preview', PREVIEW_CODE],
      ['pdf route', PDF_ROUTE_CODE],
      ['text route', TEXT_ROUTE_CODE],
    ] as const) {
      expect(src, `${name} must not import the pack`).not.toContain('localization/my');
    }
    expect(SHARED).toContain("from '@/core/reporting'");
    expect(SHARED).toContain("reportId: BORANG_8A_REPORT_ID");
  });

  /**
   * The ONE guarded page this feature adds is registered in the function-access matrix; the two downloads
   * are route handlers and correctly are not. Getting this backwards fails the suite in BOTH directions —
   * a guarded page.tsx with no column, and a registered route with no page on disk.
   */
  it('registers the review screen and only the review screen', () => {
    expect(REGISTERED_ROUTES.has('/payroll/borang-8a/preview')).toBe(true);
    expect(REGISTERED_ROUTES.has('/payroll/borang-8a/pdf')).toBe(false);
    expect(REGISTERED_ROUTES.has('/payroll/borang-8a/text')).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/borang-8a/preview/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/borang-8a/pdf/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/borang-8a/text/route.ts'))).toBe(true);
    // NOT under app/payroll/statutory-forms/, whose [formId] segment a static sibling would shadow.
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/statutory-forms/borang-8a'))).toBe(false);
  });

  /**
   * A read-only render appends NO domain event — the same deliberate skip the EA, payslip and CP22 routes
   * make. "Record generation" on the [formId] screen stays the one deliberate act that writes an artefact.
   */
  it('records nothing, because rendering a form is a read', () => {
    for (const src of [PDF_ROUTE_CODE, TEXT_ROUTE_CODE, SHARED_CODE]) {
      expect(src).not.toContain('appendEvent');
      expect(src).not.toContain('recordReport');
      expect(src).not.toContain('recordFileReport');
    }
  });
});

describe('the review screen’s own words', () => {
  it('resolves every key it renders', () => {
    const ns = en.payroll.borang8a as Record<string, string>;
    for (const m of PREVIEW.matchAll(/\bt\('([a-zA-Z0-9_]+)'/g)) {
      expect(ns[m[1]], `payroll.borang8a.${m[1]}`).toBeTruthy();
    }
    // The shelf's own new keys, resolved through lookup maps that check C cannot see.
    const sf = en.payroll.statutoryForms as Record<string, string>;
    for (const k of ['fidelity_agency_layout', 'fidelity_agency_layout_hint', 'borang8aReview', 'borang8aReviewTitle']) {
      expect(sf[k], k).toBeTruthy();
    }
  });

  /**
   * A message carrying `{placeholders}` rendered through a plain `t('…')` with no arguments throws
   * FORMATTING_ERROR at RENDER time and paints the raw key path on screen — while the route still answers
   * 200 and every static guard stays green. So: every key this screen renders WITHOUT arguments must be
   * brace-free, and every key it renders WITH them must carry braces (or the argument is being thrown at
   * a message that has nowhere to put it, which is the same defect from the other side).
   */
  it('never renders a braced message without arguments, or an argument without a brace', () => {
    const ns = en.payroll.borang8a as Record<string, string>;
    const withArgs = new Set<string>();
    for (const m of PREVIEW.matchAll(/\bt\('([a-zA-Z0-9_]+)',\s*\{/g)) withArgs.add(m[1]);
    const bare = new Set<string>();
    for (const m of PREVIEW.matchAll(/\bt\('([a-zA-Z0-9_]+)'\s*\)/g)) bare.add(m[1]);

    const bracedButBare = [...bare].filter((k) => /[{}]/.test(ns[k] ?? ''));
    expect(bracedButBare, 'these are rendered with no arguments and must not contain {placeholders}').toEqual([]);
    const argsButUnbraced = [...withArgs].filter((k) => !/\{/.test(ns[k] ?? ''));
    expect(argsButUnbraced, 'these are given arguments the message has nowhere to put').toEqual([]);
    expect(withArgs.size, 'the interpolated keys must actually be found by this scan').toBeGreaterThan(3);

    // The two shelf keys the [formId] screen renders bare — outside this namespace, so scanned by hand.
    for (const k of ['borang8aReview', 'borang8aReviewTitle', 'desc_borang_8a', 'fidelity_agency_layout', 'fidelity_agency_layout_hint']) {
      expect(/[{}]/.test((en.payroll.statutoryForms as Record<string, string>)[k]), k).toBe(false);
    }
  });

  /**
   * The status chip must not claim more than the form is. `agency-layout` says the LAYOUT is the agency's;
   * it must never read as the agency's own page, nor as validated or accepted anywhere.
   */
  it('describes the new status honestly', () => {
    const hint = (en.payroll.statutoryForms as Record<string, string>).fidelity_agency_layout_hint;
    expect(hint).not.toMatch(/\bofficial\b|\bvalidated\b|ready to file|approved by|government/i);
    expect(hint).toMatch(/no blank/i);
    expect((en.payroll.borang8a as Record<string, string>).notArtwork).toMatch(/PERKESO publishes no blank/i);
  });
});

/**
 * 5dbce839 — THE MYCOID BOX GOES OUT EMPTY, AND THE SCREEN HAS TO SAY SO.
 *
 * `company_statutory_my.ssm_registration_no` is NULL for the reporter's company, so positions 13-32 of
 * every record in the PERKESO upload file carry twenty spaces, where the file they successfully filed
 * carries "34111U". The specification marks the field Mandatory = N, so this must NOT become a refusal —
 * `missingBorang8AHeader` excludes mycoid on purpose and that stays. The fix is to stop handing over a
 * quietly empty box.
 *
 * BOTH HALVES ARE A RENDER, NOT A SOURCE SCAN, and that is why the notice is its own module. A source
 * check can see that a conditional exists; it cannot see which way round the condition is, so it would
 * pass just as happily on a notice that appears when the number IS set. These two cases render the real
 * component with the real English words and read the markup.
 */
describe('5dbce839 — the MyCoID notice on the Borang 8A preview', () => {
  const ns = en.payroll.borang8a as Record<string, string>;
  const render = (mycoid: string | null | undefined) =>
    renderToStaticMarkup(
      createElement(Borang8AMycoidNotice, { mycoid, title: ns.mycoidNoticeTitle, body: ns.mycoidNoticeBody }),
    );

  it('APPEARS when the MyCoID / business registration number is blank', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const html = render(blank);
      expect(html, `mycoid ${JSON.stringify(blank)}`).toContain(ns.mycoidNoticeTitle);
      expect(html, `mycoid ${JSON.stringify(blank)}`).toContain(ns.mycoidNoticeBody);
    }
  });

  it('does NOT appear when the number is set', () => {
    // The reporter's own number, and an arbitrary one — neither produces any markup at all.
    for (const set of ['34111U', '202301001234']) {
      expect(render(set), `mycoid ${set}`).toBe('');
    }
  });

  /** A NOTICE, NEVER A GATE: the specification says the field is optional, so nothing may hide a button. */
  it('says the file is still produced, and names where to set the number', () => {
    expect(ns.mycoidNoticeBody).toMatch(/not mandatory/i);
    expect(ns.mycoidNoticeBody).toMatch(/Statutory identity/);
    // The download gate is unchanged — mycoid is still out of the blocking set.
    expect(missingBorang8AHeader({ employerCode: 'E1100007357Y', employerName: 'ISEDECOR BINA SDN BHD' })).not.toContain(
      'mycoid',
    );
    expect(PREVIEW).toContain('const ready = missing.length === 0 && headerMissing.length === 0');
  });

  /** The component is rendered by the screen, with the two keys, or it is a module nobody reaches. */
  it('is rendered on the preview screen beside the download buttons', () => {
    expect(PREVIEW).toContain("import { Borang8AMycoidNotice } from '../mycoid-notice'");
    expect(PREVIEW).toContain("<Borang8AMycoidNotice mycoid={form.mycoid}");
    expect(PREVIEW).toContain("title={t('mycoidNoticeTitle')}");
    expect(PREVIEW).toContain("body={t('mycoidNoticeBody')}");
  });
});

/**
 * 5dbce839 — THE TWO .TXT DOWNLOADS MUST NOT BE CONFUSABLE.
 *
 * The screen offers two files whose names both end in .txt: a readable transcription for keying by hand
 * (`borang-8a-<code>-<period>.txt`) and the fixed-width PERKESO file (`perkeso-socso-<code>-<period>.txt`).
 * The reporter's request describes a two-line record that does not exist in either file — the likeliest
 * explanation, given the labels were "Download as text" and "Download upload file", is that they uploaded
 * the readable one. Both labels now say which is which in the label itself, in every locale.
 */
describe('5dbce839 — one .txt is for reading, one is for uploading, in every locale', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const nsOf = (l: string) =>
    (JSON.parse(read(`messages/${l}.json`)) as { payroll: { borang8a: Record<string, string> } }).payroll.borang8a;

  /**
   * THE ONE TOKEN THAT SURVIVES TRANSLATION. "ASSIST" is the portal's name and is left untranslated in all
   * six locales, so it is the thing a reader in any language can look for. It belongs on the upload button
   * and nowhere near the readable one — which is the whole distinction, in one grep.
   */
  it.each(LOCALES)('%s names the ASSIST portal on the upload button and NOT on the readable one', (l) => {
    const ns = nsOf(l);
    expect(ns.downloadFile, `${l} downloadFile`).toContain('ASSIST');
    expect(ns.downloadFileTitle, `${l} downloadFileTitle`).toContain('ASSIST');
    expect(ns.downloadText, `${l} downloadText`).not.toContain('ASSIST');
    // …and the two labels are not merely different by a word neither of them explains.
    expect(ns.downloadText).not.toBe(ns.downloadFile);
    expect(ns.downloadTextTitle).not.toBe(ns.downloadFileTitle);
  });

  it('says in English which one is read and which one is uploaded', () => {
    const ns = en.payroll.borang8a as Record<string, string>;
    expect(ns.downloadText).toMatch(/readable/i);
    expect(ns.downloadText).toMatch(/not for upload/i);
    expect(ns.downloadTextTitle).toMatch(/READ/);
    expect(ns.downloadTextTitle).toMatch(/NOT the file the portal accepts/i);
    expect(ns.downloadFile).toMatch(/upload file/i);
    expect(ns.downloadFileTitle).toMatch(/THE FILE YOU UPLOAD/);
    expect(ns.downloadFileTitle).toContain('278 characters');
  });

  /**
   * ⚠️ THE BUTTON MECHANISM IS UNTOUCHED, AND MUST BE. This form is method="get", so the browser rebuilds
   * the query string from the fields and DISCARDS one written on the action URL: `formAction=".../file?
   * report=1"` would silently hand over the file. A hidden input is the opposite trap — every button in
   * the form submits it. Only a submit button's own name/value is sent by that button alone.
   * test/perkeso-socso-file.test.ts pins both halves; this repeats the half that lives on this screen,
   * beside the labels this round reworded, because rewording a button is exactly when somebody
   * "tidies up" the attribute soup underneath it.
   */
  it('rewords the labels without touching how the report button asks for the report', () => {
    expect(PREVIEW).toMatch(/name="report"\s*\n?\s*value="1"/);
    expect(PREVIEW).not.toContain('/payroll/borang-8a/file?report');
    expect(PREVIEW_CODE).not.toMatch(/<input[^>]*name="report"/);
    // Three download buttons and the report button, each still its own formAction on the same form.
    expect(PREVIEW).toContain('formAction="/payroll/borang-8a/text"');
    expect(PREVIEW).toContain('formAction="/payroll/borang-8a/file"');
    expect(PREVIEW).toContain("{t('downloadText')}");
    expect(PREVIEW).toContain("{t('downloadFile')}");
  });
});
