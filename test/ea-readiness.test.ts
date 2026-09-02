/**
 * r242 (item b36a8a91) — THE EA READINESS PANEL, AND THE ONE CLAIM IT IS NOT ALLOWED TO MAKE.
 *
 * The panel tells a reviewer whether the form in front of them is ready to be filed and, when it is not,
 * names each empty box and where on the employee's record the detail belongs. Every case here is about the
 * DEFINITION of missing, because that is the whole correctness question:
 *
 *   ⚠️ A PAYROLL-DERIVED FIGURE OF ZERO IS A LEGITIMATE VALUE AND MUST NEVER BE REPORTED AS MISSING.
 *   A box reading 0.00 asserts the money does not exist; a box flagged "missing" asserts the RECORD is
 *   incomplete, and on a tax document both are claims we have to be able to stand behind (AGENTS 28).
 *   An employee paid a salary and no bonus, with a complete record, is READY — and the first case below is
 *   the one this round exists to make impossible to break.
 *
 * The counterpart matters too: a real gap has to be reported, or the panel is a green light nobody should
 * trust. So each check is pinned in both directions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EA_READINESS_CHECKS, eaReadiness, eaReadinessChecks, type EaReadinessInput } from '../lib/ea-readiness';
import { EA_REGISTER } from '../lib/ea-field-register';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A complete record, and a statement whose figures the individual cases then move. */
const complete = (over: Partial<EaReadinessInput['employee']> = {}, partE = { epf: 1200, socso: 240 }): EaReadinessInput => ({
  employee: {
    name: 'Nurul Aina binti Hamzah',
    ic: '880101-14-5678',
    passport: null,
    taxNo: 'SG 12345678090',
    epfNo: '12345678',
    socsoNo: 'A1234567',
    ...over,
  },
  partE,
});

/** The caption keys of the boxes the panel reported, for readable assertions. */
const named = (s: EaReadinessInput) => eaReadiness(s).missing.map((m) => m.captions.join('+'));

describe('b36a8a91 — a zero payroll figure is not a missing box', () => {
  it('reports NOTHING missing on a complete record whose every payroll figure is zero', () => {
    // Salary-only years, unpaid leave, a starter who joined in December: every one of these produces real
    // zeros, and none of them is a fault in anybody's record.
    const s = complete({}, { epf: 0, socso: 0 });
    const r = eaReadiness(s);
    expect(r.missing, `zero figures were reported as missing boxes: ${named(s).join(', ')}`).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('checks no money box at all — the register says which boxes come from the employee’s record', () => {
    const staffFed = new Set(EA_REGISTER.filter((r) => r.feed === 'staff').flatMap((r) => r.sources));
    const moneyFed = new Set(
      EA_REGISTER.filter((r) => r.feed !== 'staff').flatMap((r) => r.sources),
    );
    for (const c of EA_READINESS_CHECKS) {
      for (const src of c.sources) {
        expect(staffFed.has(src), `${src} is checked but the field register does not call it staff-fed`).toBe(true);
        expect(moneyFed.has(src), `${src} is also fed from somewhere that is not the employee’s record`).toBe(false);
      }
    }
    // …and nothing was silently dropped: every declared check is one the register still backs. A check the
    // register stops backing goes quiet rather than lying, and this is what says so out loud.
    expect(eaReadinessChecks().length).toBe(EA_READINESS_CHECKS.length);
  });

  it('derives no EA figure of its own — it imports nothing that could compute one', () => {
    const src = read('lib/ea-readiness.ts');
    const imports = [...src.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./ea-field-register']);
    // The panel counts and names boxes. Nothing here reads a payslip, a statement or a pack.
    expect(src).not.toContain('employeeEaStatement');
    expect(src).not.toContain('localization/');
  });
});

describe('b36a8a91 — a box the employee’s record should hold and does not', () => {
  it('names the income tax number, and says where on the record it belongs', () => {
    const r = eaReadiness(complete({ taxNo: null }));
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([{ captions: ['incomeTaxNo'], where: 'bankStatutory' }]);
  });

  it('treats a blank as blank, whitespace included', () => {
    expect(named(complete({ taxNo: '   ' }))).toEqual(['incomeTaxNo']);
  });

  it('does not report a passport for somebody who has an I.C., or an I.C. for somebody who has a passport', () => {
    // The C.P.8A takes either document. Flagging the other one would send an operator to fetch a passport
    // number that does not exist for a Malaysian citizen.
    expect(named(complete({ ic: '880101-14-5678', passport: null }))).toEqual([]);
    expect(named(complete({ ic: null, passport: 'A12345678' }))).toEqual([]);
    // Neither on file is a real gap, and it is ONE item over the form's two boxes.
    expect(named(complete({ ic: null, passport: null }))).toEqual(['icNo+passportNo']);
  });

  /**
   * ⚠️ THIS CASE PINNED THE OPPOSITE RULE ONE REVISION AGO, AND THE REVERSAL IS THE POINT OF KEEPING IT.
   *
   * The first build silenced these two boxes when the employee's own contribution for the year was zero,
   * on the reading that somebody who did not contribute has nothing for the box to hold. A verifier found
   * the hole: the EMPLOYEE's EPF share is zero for a member aged 60 and over under the Third Schedule
   * while the employer still contributes and the form still needs the number — so a contribution amount
   * is a proxy for AGE, not for fund registration, and the check switched itself off for exactly the
   * population most likely to be reviewed by hand.
   *
   * The `askedOf` MECHANISM is kept (it is how a conditional box would be expressed if one ever needs to
   * be); what changed is that neither fund number uses it. AGENTS 18 — the case is updated, not deleted.
   */
  it('asks for a fund number whatever the year’s contribution came to', () => {
    // Contributions were made and the number is absent: a real gap on a form that must carry it.
    expect(named(complete({ epfNo: null }, { epf: 1200, socso: 240 }))).toEqual(['epfNo']);
    expect(named(complete({ socsoNo: null }, { epf: 1200, socso: 240 }))).toEqual(['socsoNo']);
    // …AND STILL A GAP AT ZERO. This is the assertion the reversal exists for: an over-60 member whose own
    // share is nil is not an employee without an EPF number.
    expect(named(complete({ epfNo: null, socsoNo: null }, { epf: 0, socso: 0 }))).toEqual(['epfNo', 'socsoNo']);
    expect(named(complete({ epfNo: null, socsoNo: null }, { epf: 1200, socso: 0 }))).toEqual(['epfNo', 'socsoNo']);
  });

  it('lists what it checked, and lists only the boxes this form asks THIS employee for', () => {
    expect(eaReadiness(complete()).checked.map((c) => c.captions.join('+'))).toEqual([
      'name',
      'icNo+passportNo',
      'incomeTaxNo',
      'epfNo',
      'socsoNo',
    ]);
    // …and the SAME five whatever the contributions came to: nothing is conditionally dropped any more.
    expect(eaReadiness(complete({}, { epf: 0, socso: 240 })).checked.map((c) => c.captions.join('+'))).toEqual([
      'name',
      'icNo+passportNo',
      'incomeTaxNo',
      'epfNo',
      'socsoNo',
    ]);
  });
});

describe('b36a8a91 — the review screen says whether the form is ready', () => {
  const PAGE = read('app/payroll/reports/ea/[employmentId]/page.tsx');

  it('derives the panel from the statement it has ALREADY read, and prints both states', () => {
    expect(PAGE).toContain('eaReadiness(ea)');
    // Two literal keys on two branches, not one dynamic key: the static sweep in test/i18n-coverage.test.ts
    // can only see a literal, and a missing one renders MISSING_MESSAGE at request time (AGENTS 6).
    expect(PAGE).toContain("t('readiness.ready')");
    expect(PAGE).toContain("t('readiness.required')");
    expect(PAGE).toContain("t('readiness.requiredNote', { count: readiness.missing.length })");
    // Each empty box is NAMED, with where the detail belongs — the list, not just the count.
    expect(PAGE).toContain('readiness.missing.map');
    expect(PAGE).toContain("t('readiness.whereProfile')");
    expect(PAGE).toContain("t('readiness.whereStatutory')");
    // A note to the reviewer, not part of the statement the employee is handed.
    expect(PAGE).toMatch(/readiness\.ready[\s\S]{0,400}print:hidden|print:hidden[\s\S]{0,400}readiness\.ready/);
  });

  it('names each box with the form’s OWN caption, never a second wording for one box', () => {
    // `boxName` resolves the same `payroll.ea` captions Section A prints, so the panel and the row beneath
    // it cannot call one box two things.
    expect(PAGE).toContain('captions.map((k) => t(k as ');
    for (const caption of ['name', 'icNo', 'passportNo', 'incomeTaxNo', 'epfNo', 'socsoNo']) {
      expect(PAGE, `${caption} is no longer printed on the statement itself`).toContain(`t('${caption}')`);
    }
  });

  it('every string it renders is in all six locales', () => {
    const keys = ['ready', 'required', 'readyNote', 'requiredNote', 'whereProfile', 'whereStatutory', 'checkedNote'];
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const messages = JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { ea: { readiness?: Record<string, string> }; statutoryForms: Record<string, string> };
      };
      for (const k of keys) {
        expect(messages.payroll.ea.readiness?.[k], `payroll.ea.readiness.${k} missing from ${loc}`).toBeTruthy();
      }
      expect(messages.payroll.statutoryForms.link_ea_more, `link_ea_more missing from ${loc}`).toBeTruthy();
    }
  });
});
