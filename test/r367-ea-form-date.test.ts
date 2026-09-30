/**
 * r367 (item fda53352, round A) — THE TWO FIGURES THE C.P.8A's CONTENT ROUND CHANGED, PINNED BY VALUE.
 *
 * Round A of this item changed WHAT THE FORM STATES and no coordinate on it:
 *   1. Section E(2) states the employee's SOCSO + EIS + SKBBK, added, where it stated the SOCSO leg alone.
 *   2. The foot's "Tarikh" / "Date" is filled — `MIN(today in Kuala Lumpur, 28 February of the year after
 *      the EA year)` — where it was an unconditionally empty rule.
 *
 * ⚠️ WHY THE E(2) FIXTURE'S THREE LEGS ARE NON-ZERO AND MUTUALLY DISTINCT, ASSERTED BEFORE THEY ARE SUMMED.
 * A fixture whose SKBBK is 0 — which every payslip written before 1 Jun 2026 legitimately has — makes this
 * change INVISIBLE: the one-leg renderer and the three-leg renderer print the same number, and a green case
 * proves nothing. Two equal legs are the same trap one step along, because the sum then matches a wrong
 * pairing. So the legs are checked for distinctness first, and the printed total is compared against every
 * leg and every pair of them.
 *
 * ⚠️ WHOSE RULE THE DATE IS. The REPORTER's business rule, applied literally at their request. **No published
 * LHDN furnishing deadline for the EA is sourced in this repository or in the committed agency files**;
 * docs/forms/ea-cp8a-pin-2023-official-en.pdf carries the box and no date. Nothing here is a statutory
 * deadline, no statutory-deadline field was created, and test/statutory-forms-page.test.ts still leaves Form
 * E's deadline unset for the recorded reason that "an invented statutory deadline is worse than an absent
 * one". This file pins the ARITHMETIC of a business rule, nothing more.
 *
 * Read beside test/r219-ea-cp8a-form.test.ts (which pinned the empty rule and now pins the wiring),
 * test/r217-ea-sections.test.ts and test/ea-form-boxes-contract.test.ts (Section E still has two amounts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { renderEaPdf, blankEaPdfData, type EaPdfData, type EaPdfLabels } from '../lib/ea-pdf';
import { eaFormDate } from '../localization/my/reports';
import { todayInKualaLumpur } from '../lib/hr-date';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Every string the renderer drew. Same technique as test/r219-ea-cp8a-form.test.ts. */
async function drawn(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray ? contents.asArray().map((ref) => page.node.context.lookup(ref)) : [contents];
    let raw = '';
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    for (const m of raw.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)) {
      out.push(Buffer.from(m[3], 'hex').toString('latin1'));
    }
  }
  return out;
}

/** The label bundle as the routes build it, minus next-intl. */
function bundleFor(locale: 'en' | 'ms'): EaPdfLabels {
  const ea = JSON.parse(read(`messages/${locale}.json`)).payroll.ea as Record<string, string> & {
    override: Record<string, string>;
  };
  const keys = [
    'sectionAEmployeeParticulars', 'name', 'jobTitle', 'employeeNo', 'icNo', 'passportNo', 'epfNo', 'socsoNo',
    'childrenTaxRelief', 'partYearNote', 'startedOn', 'leftOn', 'sectionBEmploymentIncome', 'sectionBExcluding',
    'grossSalary', 'feesCommissionBonus', 'tipsPerquisitesOther', 'paymentDetail', 'stateWhat', 'addressCue',
    'taxBorneByEmployer', 'esos', 'gratuity', 'periodFrom', 'periodTo', 'incomeType', 'arrears', 'benefitsInKind',
    'livingAccommodation', 'unapprovedFundRefund', 'compensation', 'sectionCPensionOther', 'pension', 'annuity',
    'formTotal', 'sectionDTotalDeductions', 'monthlyTaxDeduction', 'cp38Deductions', 'zakatViaSalary', 'donations',
    'tp1ClaimHeading', 'tp1Relief', 'zakatOther', 'childRelief', 'sectionEContributions', 'fundName',
    'contributionAmount', 'sectionFExemptAllowances', 'title',
  ] as const;
  const bundle = Object.fromEntries(keys.map((k) => [k, ea[k]])) as unknown as EaPdfLabels;
  bundle.amendedNote = ea.override.amendedNote;
  return bundle;
}

// Three legs, all non-zero, all different, and no pair of them equal to the whole:
//   297.00 + 118.80 + 43.45 = 459.25
const SOCSO = 297;
const EIS = 118.8;
const SKBBK = 43.45;
const E2 = 459.25;

const FORM: EaPdfData = {
  ...blankEaPdfData(),
  year: '2026',
  employer: {
    name: 'Acme Sdn Bhd',
    eNumber: 'E1234567890',
    address: ['12 Jalan Raja Chulan', '50200 Kuala Lumpur'],
    phone: '03-2000 1234',
    lhdnState: 'Wilayah Persekutuan Kuala Lumpur',
    officerName: 'Nurul Aina binti Hamzah',
    officerPosition: 'HR Manager',
  },
  employee: {
    ...blankEaPdfData().employee,
    name: 'Aisyah Rahman',
    ic: '900101010001',
    taxNo: 'SG12345678',
    // Both in a DIFFERENT year from the statement, so item 9 draws nothing and the only dd/mm/yyyy on the
    // page is the one under test.
    hiredOn: '2019-05-06',
    terminatedOn: null,
  },
  partE: { epf: 7810, socso: SOCSO, eis: EIS, skbbk: SKBBK, fundName: 'KWSP' },
  formDate: '2027-02-15',
  statutoryVersion: '2026.3',
};

describe('r367 — Section E(2) states every compulsory PERKESO leg the employee paid', () => {
  it('the fixture cannot make the change invisible: three non-zero, mutually distinct legs', () => {
    // ⚠️ THE NON-VACUITY GATE, AND IT RUNS BEFORE ANY SUM IS ASSERTED. With SKBBK at 0 the old one-leg
    // renderer prints the same figure as the new three-leg one.
    for (const [name, v] of [['socso', SOCSO], ['eis', EIS], ['skbbk', SKBBK]] as const) {
      expect(v, `${name} is zero — this fixture cannot see the E(2) change`).not.toBe(0);
    }
    expect(new Set([SOCSO, EIS, SKBBK]).size, 'two legs are equal — a wrong pairing would still match').toBe(3);
    expect(SOCSO + EIS + SKBBK).toBeCloseTo(E2, 2);
    // The total equals no leg and no PAIR of legs, so a renderer that dropped one still fails below.
    for (const wrong of [SOCSO, EIS, SKBBK, SOCSO + EIS, SOCSO + SKBBK, EIS + SKBBK]) {
      expect(E2, `the total collides with a partial sum (${wrong})`).not.toBeCloseTo(wrong, 2);
    }
  });

  for (const locale of ['ms', 'en'] as const) {
    it(`${locale}: E(2) prints the three-leg sum, and no leg on its own`, async () => {
      const texts = await drawn(await renderEaPdf(FORM, bundleFor(locale), { locale }));
      const money = texts.filter((t) => /^\d{1,3}(,\d{3})*\.\d{2}$/.test(t));
      expect(money.length, 'sanity: the money column was drawn').toBeGreaterThan(3);
      expect(money, 'Section E(2) does not state the three-leg sum').toContain('459.25');
      // Each leg on a line of its own would be the strip r351 removed, or a third amount in a section the
      // agency gives two. None of the three may appear alone.
      expect(money, 'the SOCSO leg is printed alone — E(2) narrowed back to one leg').not.toContain('297.00');
      expect(money, 'the EIS leg is printed on a line of its own').not.toContain('118.80');
      expect(money, 'the SKBBK leg is printed on a line of its own').not.toContain('43.45');
      // E(1) is untouched by this round.
      expect(money, 'E(1) lost the approved-fund figure').toContain('7,810.00');
    });
  }

  it('a pre-June-2026 year is byte-identical: SKBBK 0 prints what it printed before', async () => {
    // Every payslip written before SKBBK became mandatory carries no `socsoSkbbk` key, so `num()` gives 0
    // and the sum collapses to the two remaining legs. This is the case that must NOT change, and it is
    // asserted as a VALUE rather than assumed.
    const older: EaPdfData = { ...FORM, partE: { ...FORM.partE, skbbk: 0 } };
    const money = (await drawn(await renderEaPdf(older, bundleFor('ms'), { locale: 'ms' }))).filter((t) =>
      /^\d{1,3}(,\d{3})*\.\d{2}$/.test(t),
    );
    expect(money).toContain('415.80'); // 297.00 + 118.80
    expect(money).not.toContain('459.25');
  });
});

describe('r367 — the EA form date: MIN(today in KL, 28 February of the following year)', () => {
  /**
   * The reporter's own three examples, each driven from an INJECTED clock rather than a hardcoded future
   * date (CLAUDE.md §8: no hardcoded future dates; derive from the clock).
   */
  it('before the cap: today', () => {
    // 15 Feb 2027, 09:00 MYT.
    expect(eaFormDate('2026', new Date('2027-02-15T01:00:00Z'))).toBe('2027-02-15');
  });

  it('on the cap: today, which is the cap', () => {
    expect(eaFormDate('2026', new Date('2027-02-28T01:00:00Z'))).toBe('2027-02-28');
  });

  it('after the cap: the cap, not today', () => {
    // ⚠️ THE CLAMP. Without it the box prints 10/03/2027, which is the whole point of the rule.
    expect(eaFormDate('2026', new Date('2027-03-10T01:00:00Z'))).toBe('2027-02-28');
    // …and it keeps clamping years later, not just in the month after.
    expect(eaFormDate('2026', new Date('2029-07-04T01:00:00Z'))).toBe('2027-02-28');
  });

  it('MALAYSIAN TIME, NOT UTC: 00:30 MYT is already the new day', () => {
    // ⚠️ THE BUG THAT HAS BEEN FIXED TWICE RECENTLY. 00:30 MYT on 15 Feb 2027 is 16:30 UTC on 14 Feb; a UTC
    // read names 14/02/2027 on a document dated by a Malaysian employer, for eight hours of every day.
    const at0030myt = new Date('2027-02-14T16:30:00Z');
    expect(todayInKualaLumpur(at0030myt), 'sanity: the clock helper reads MYT').toBe('2027-02-15');
    expect(at0030myt.toISOString().slice(0, 10), 'sanity: UTC really does disagree').toBe('2027-02-14');
    expect(eaFormDate('2026', at0030myt)).toBe('2027-02-15');
  });

  it('28 February is LITERAL — a leap year does not move it to the 29th', () => {
    // 2028 is a leap year. The cap for the 2027 EA year is still the 28th.
    expect(new Date('2028-02-29T00:00:00Z').getUTCDate(), 'sanity: 2028 really has a 29 February').toBe(29);
    expect(eaFormDate('2027', new Date('2028-06-01T01:00:00Z'))).toBe('2028-02-28');
    expect(eaFormDate('2027', new Date('2028-02-29T01:00:00Z'))).toBe('2028-02-28');
  });

  it('the year is the EA YEAR, so each year gets its own cap', () => {
    const late = new Date('2030-01-01T01:00:00Z');
    expect(eaFormDate('2024', late)).toBe('2025-02-28');
    expect(eaFormDate('2025', late)).toBe('2026-02-28');
    expect(eaFormDate('2026', late)).toBe('2027-02-28');
  });

  it('with no clock passed it reads the real one, in Kuala Lumpur, and never runs ahead of it', () => {
    // No hardcoded date: the expectation is derived from the same clock helper the function uses.
    const today = todayInKualaLumpur();
    const year = String(Number(today.slice(0, 4)) - 1);
    expect(eaFormDate(year)).toBe(today < `${Number(year) + 1}-02-28` ? today : `${Number(year) + 1}-02-28`);
    // The date on a form for the CURRENT year can never be in the future.
    expect(eaFormDate(today.slice(0, 4)) <= `${Number(today.slice(0, 4)) + 1}-02-28`).toBe(true);
    expect(eaFormDate(today.slice(0, 4))).toBe(today);
  });

  it('the form prints it as a Malaysian date, and the blank form still prints an empty rule', async () => {
    const dated = await drawn(await renderEaPdf(FORM, bundleFor('ms'), { locale: 'ms' }));
    expect(dated, 'the filled form did not print its date').toContain('15/02/2027');
    // blankEaPdfData() sets formDate: null — the agency's own empty rule, which is what r219 pinned and
    // what the blank C.P.8A must keep.
    const blank = await drawn(await renderEaPdf(blankEaPdfData(), bundleFor('ms'), { blank: true, locale: 'ms' }));
    expect(blank.filter((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t)), 'the BLANK form printed a date').toEqual([]);
  });

  it('nothing in this round created a statutory deadline', () => {
    // ⚠️ THE RULE IS THE REPORTER'S, NOT THE AGENCY'S, AND THAT DISTINCTION IS PINNED RATHER THAN NOTED.
    // test/statutory-forms-page.test.ts leaves Form E's deadline unset because "an invented statutory
    // deadline is worse than an absent one: somebody files against it". The EA's own 28 February cap must
    // not leak into any statutory-deadline surface.
    const reports = read('localization/my/reports.ts');
    expect(reports, 'eaFormDate must exist and own the rule').toContain('export function eaFormDate(');
    for (const rel of ['localization/my/reports.ts', 'lib/ea-pdf.ts', 'lib/ea-field-register.ts']) {
      expect(read(rel), `${rel} presents the 28 February cap as the agency's rule`).not.toMatch(
        /statutory\s+deadline\s+(?:of|is)\s+28/i,
      );
    }
    // No EA deadline was added to the statutory-forms catalogue in this round.
    const forms = read('localization/my/reports.ts');
    expect(forms).not.toMatch(/deadline:\s*['"`]?\s*(?:02-28|28 February|--02-28)/i);
  });
});
