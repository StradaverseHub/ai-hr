/**
 * da4fc817 — THE SECTIONS THE OFFICIAL C.P.8A HAS AND THIS FORM DID NOT.
 *
 * Compared field by field against the blank Pin. 2024 form the reporter attached. Sections A, B and C were
 * already complete; what was missing was four of Section D's six lines, Section E's fund name, and Section
 * F entirely — the last of which was being printed as a muted informational row INSIDE Part B, under a
 * comment that already admitted "LHDN's EA reports exempt allowances in their own section".
 *
 * ⚠️ THE PAGE BUDGET IS PART OF THE CONTRACT. The published EA is one page and test/ea-pdf.test.ts refuses
 * a second one in all six locales. Adding these lines did not fit at the old 14pt row leading, which is why
 * `ROW_H` is now 12.5 — recorded here because the next person to add a box will meet the same wall and
 * should tighten the arithmetic rather than let the form spill.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EA_FIELDS } from '../localization/my/reports';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('da4fc817 — Section D carries all six of the official form lines', () => {
  it('the four missing boxes are amendable EA fields, so HR can enter what payroll cannot source', () => {
    for (const f of ['tp1Relief', 'donations', 'zakatOther', 'childRelief']) {
      expect(EA_FIELDS as readonly string[], `${f} must be amendable`).toContain(f);
    }
  });

  /**
   * AGENTS 28, and r209 shipped the opposite defect on THIS form: manual boxes drawn at their derived
   * value, always zero, so a director paid RM48,000 in commission got "Fees … RM 0.00" beside an
   * Allowances figure that carried it. An absent box asserts nothing; a box reading 0.00 asserts the money
   * does not exist, and on a tax document that is the more expensive failure.
   */
  it('prints these boxes ONLY when set — never as a derived 0.00', () => {
    const pdf = read('lib/ea-pdf.ts');
    // r219 — the SHAPE moved with the C.P.8A redraw and the RULE did not. `optionalRow` used to drop the
    // whole line; the form's caption and rule are now always printed (that is what the blank agency page
    // carries) and the conditional narrowed to the AMOUNT, which is `manual()`. What must stay true is
    // that none of these four can reach the page as a derived 0.00.
    //
    // ⚠️ r351 — THE TITLE USED TO SAY "the three UNSOURCED boxes" AND THAT IS NO LONGER WHY childRelief
    // IS HERE. D.6 now HAS a payroll source (see the next case). It keeps `manual()`'s zero-suppression
    // for a different reason: a year whose slips carry no `pcbMeta.reliefs` snapshot at all — written
    // before 169e3c24, or a flat-rate non-resident — has nothing to state, and a real RM0.00 relief and
    // an unknown one are indistinguishable at this point. The agency's empty rule is honest for both.
    for (const f of ['donations', 'zakatOther', 'childRelief', 'tp1Relief']) {
      expect(pdf, `${f} must go through manual()`).toContain(`manual(d.partD.${f})`);
      expect(pdf, `${f} must not be drawn as a derived figure`).not.toContain(`derived(d.partD.${f})`);
    }
  });

  it('r351 — D.6 carries the RINGGIT the payroll kernel allowed, not a hardcoded 0 and not a count', () => {
    // The reporter asked for the amount and was reading A.8's count, which is a different box. This pins
    // BOTH halves: D.6 is sourced from the kernel's own annual relief snapshot, and A.8 stays a count.
    const reports = read('localization/my/reports.ts');
    expect(reports, 'D.6 is still hardcoded to zero').not.toMatch(/\n\s*childRelief: 0,/);
    expect(reports, 'D.6 must read the kernel snapshot').toContain('childReliefFromPayroll');
    expect(reports, 'the snapshot member the kernel stamps').toContain('pcbMeta?.reliefs?.children');
    // The LAST month's figure, so the query it is read from must be ordered. CLAUDE.md §8 forbids
    // reading "the last" off an unordered result, and every other figure here is a sum that did not care.
    expect(reports, 'the slips query must ORDER BY the pay period').toContain('.orderBy(payrollBatch.payPeriod)');
    // ⚠️ REVERSED IN r359 (fda53352 rev 7), AND IT WOULD HAVE GONE ON PASSING WHILE SAYING THE OPPOSITE.
    // This line read:
    //     // A.8 is the COUNT and must stay one — the r343 head-count decision is not touched by this.
    //     expect(read('lib/ea-pdf.ts'), 'A.8 must still print the head count')
    //       .toContain('String(d.employee.children)');
    // The expression it greps for is still in the file — only its SOURCE changed — so the assertion
    // survived the reversal untouched and kept asserting a head count in its message. That is the
    // "prose outlives the kernel" trap in a test rather than a comment.
    //
    // The reporter was right and two of our rounds were wrong. LHDN's specification, printed p.10:
    // "Q  Deduction for qualifying children", "C  Number of qualifying children", formula term QC; and
    // printed p.27's table is headed "Relief to be given AS IF THE EMPLOYEE HAS THIS NUMBER OF
    // CHILDREN". So A.8 is C, the weighted figure. It is derived from the SAME stamped relief D.6
    // prints, which is what makes A.8 x RM2,000 === D.6 by construction rather than by agreement.
    const reportsSrc = read('localization/my/reports.ts');
    expect(reportsSrc, 'A.8 is derived from the relief, not from num_children').toMatch(
      /eaQualifyingChildren\s*=\s*\n?\s*childReliefFromPayroll == null \? null :/,
    );
    expect(reportsSrc, 'and it divides by the ruleset per-child figure, never a literal 2000').toContain(
      'DEFAULT_MY_STATUTORY.pcb.reliefs.perChild',
    );
    // Absent when D.6 is absent — the two boxes are one fact.
    expect(read('lib/ea-pdf.ts'), 'a null C prints an empty rule, not a zero').toContain(
      "blank || d.employee.children == null ? '' : String(d.employee.children)",
    );
  });

  it('the TP1 line is DERIVED through the one counting rule, not summed a second time', () => {
    const reports = read('localization/my/reports.ts');
    // THE rule — core/tax-relief's own header forbids a second spelling of this sum, at length, because a
    // second one already cost a held release.
    expect(reports).toContain('tp1CountForYear(tp1Rows');
    // …and the whole year, where the payroll feed asks month by month.
    expect(reports).toContain('throughMonth: null');
    // The deferred import is load-bearing: at module scope it cycles through the pack registry. Pin the
    // shape so a tidy-up does not "fix" it back into a top-level import and break two suites at load.
    // …through the payroll pack FACADE, and deferred to the call. Both halves are load-bearing: the
    // boundary path trips test/payroll-pack-drift.test.ts (ADR-0080 D9, and its allowlist only shrinks),
    // and a module-scope import cycles through the country registry at run time with a green typecheck.
    expect(reports).toContain("await import('../../packs/payroll/service')");
    expect(reports).not.toMatch(/^import .*from '\.\.\/\.\.\/core\/tax-relief'/m);
    expect(reports).not.toMatch(/^import .*from '\.\.\/\.\.\/packs\/payroll\/service'/m);
  });

  it('adding an EA box without deciding its derived baseline stays a COMPILE error', () => {
    // The switch in core/ea-override.ts is exhaustive over EaField with NO default clause, on purpose.
    // It is what caught these four when they were added; keep it defaultless.
    const ovr = read('core/ea-override.ts');
    for (const f of ['tp1Relief', 'donations', 'zakatOther', 'childRelief']) {
      expect(ovr).toContain(`case '${f}':`);
    }
    // Slice to the END of the switch, not to the first '\n}' — the function body contains nested blocks,
    // and the loose slice picked up a `default:` from a LATER function, which is a false alarm rather
    // than a finding. Bound it by the switch's own last case instead.
    const body = ovr.slice(ovr.indexOf('function derivedField'));
    const sw = body.slice(body.indexOf('switch (field)'), body.indexOf("case 'childRelief':"));
    expect(sw).not.toContain('default:');
  });
});

describe('da4fc817 — Sections E and F match the published form', () => {
  // ⚠️ THE SECTION MARKERS MOVED IN r349, AND THE GUARDS DID NOT CHANGE MEANING. Section titles are
  // drawn by `sectionHeading(t.sectionX, …)` rather than `putFit(t.sectionX, …)`, because the agency
  // sets its section letters in filled black squares with white lettering. These cases slice the source
  // BETWEEN section markers, so the marker text had to follow — everything they assert about what lives
  // inside each slice is untouched.
  it('Section E names the fund before its amount, and no longer carries EIS', () => {
    const pdf = read('lib/ea-pdf.ts');
    const e = pdf.slice(pdf.indexOf('sectionHeading(t.sectionEContributions'), pdf.indexOf('sectionHeading(t.sectionFExemptAllowances'));
    // The fund is NAMED before it is quantified, exactly as the form asks ("Nama Kumpulan Wang" first).
    expect(e).toContain('putFit(t.fundName');
    expect(e).toContain('d.partE.fundName');
    expect(e).toContain('derived(d.partE.epf)');
    expect(e).toContain('derived(d.partE.socso)');
    // The official Section E has exactly two amounts. EIS is not one of them, and it is not inside the
    // section — that half of this guard is unchanged since r219.
    expect(e).not.toContain('eisSip');
    // ⚠️ r351 — THE SECOND HALF IS INVERTED. It used to require the figure to be printed SOMEWHERE, in
    // our own strip below the officer box. The reporter has had that strip removed ("Remove this part
    // from the EA Form"), so the EIS figure is now on no printed EA at all. It remains on the HTML
    // statement, which is the surface that still shows it, and `test/ea-form-boxes-contract.test.ts`
    // pins that. Inverted rather than deleted, so the strip cannot return unnoticed.
    expect(pdf, 'the EIS figure is back on the printed form').not.toContain('t.eisSip');
    expect(pdf, 'the EIS amount is back on the printed form').not.toContain('rm(d.partE.eis)');
  });

  it('Section F exists as its own section, and the exempt figure left Part B', () => {
    const pdf = read('lib/ea-pdf.ts');
    // ONE LINE whose title IS the item, with its own RM before the rule — the form's own arrangement.
    expect(pdf).toContain('sectionHeading(t.sectionFExemptAllowances');
    expect(pdf).toContain('derived(d.partB.exemptAllowances ?? 0)');
    // It must not come back inside Part B, where it read as another component of that total, which it is
    // not: it is the tax-exempt PORTION of the allowances already printed on 1(c).
    const b = pdf.slice(pdf.indexOf('sectionHeading(t.sectionBEmploymentIncome'), pdf.indexOf('sectionHeading(t.sectionCPensionOther'));
    expect(b).not.toContain('exemptAllowances');
  });

  /**
   * r353 (item fda53352 point 3) — AND THE HTML STATEMENT DESCRIBES THE SAME FORM, WHICH IT DID NOT.
   *
   * The screen printed the exempt figure THREE ways at once: a muted row inside Section B labelled
   * "(included above)", the same figure again under Section E's heading carrying Section F's caption, and
   * then a real Section F block whose row read the words "not tracked". The comment defending that said
   * "we hold no copy of the official artwork to settle which it is" — stale: both official files are on
   * disk and `docs/forms/ea-cp8a-pin-2023-transcription.txt:153` settles it outright (Section F is one
   * line whose title IS the item, the total of tax-EXEMPT allowances; the TP1 total is D.5, which this
   * screen prints separately).
   *
   * lib/ea-pdf.ts's own header exists to stop two surfaces describing one form two ways, so this pins the
   * shape rather than the wording: the figure is read ONCE on the screen, in Section F, and Section B's
   * block does not mention it — exactly as the printed form is pinned above.
   */
  it('r353 — the HTML statement reports the exempt total once, in Section F', () => {
    const page = read('app/payroll/reports/ea/[employmentId]/page.tsx');
    const reads = [...page.matchAll(/ea\.partB\.exemptAllowances/g)];
    expect(reads.length, 'the exempt figure is read more than once on one screen').toBe(1);
    // It is the Section F block that reads it, and that block no longer says "not tracked".
    const f = page.slice(page.indexOf("t('sectionFTaxExempt')"));
    expect(f, "Section F is still printing the words 'not tracked'").not.toContain("value={t('notTracked')}");
    expect(f).toContain('rm(ea.partB.exemptAllowances ?? 0)');
    /**
     * Section B's rows must not carry it: 1(c) is EXCLUDING tax-exempt money by the form's own heading.
     *
     * ⚠️ MATCHED ON WHAT IS RENDERED, NOT ON THE WORD. Section B's block carries a comment naming the
     * retired `payroll.ea.exemptAllowances` key on purpose — its wording in all six catalogues still says
     * "(included above)", so anything reinstating it reinstates the defect, and the comment is what tells
     * the next reader that. A bare substring check reads that warning as the defect it warns about.
     */
    const bBlock = page.slice(page.indexOf("t('sectionBEmploymentIncome')"), page.indexOf("t('sectionCPensionOther')"));
    expect(bBlock, 'an exempt-allowances Row is back inside Section B').not.toMatch(/<Row[^>]*exemptAllowances/);
    expect(bBlock, "Section B renders the retired '(included above)' label again").not.toMatch(
      /\{t\('exemptAllowances'\)\}/,
    );
  });

  it('the fund name is a pack constant, not a per-employee column invented for one form', () => {
    expect(read('localization/my/reports.ts')).toContain("export const EA_FUND_NAME = 'KWSP'");
  });
});
