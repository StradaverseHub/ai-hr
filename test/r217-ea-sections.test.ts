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
  it('prints the three unsourced boxes ONLY when set — never as a derived 0.00', () => {
    const pdf = read('lib/ea-pdf.ts');
    // r219 — the SHAPE moved with the C.P.8A redraw and the RULE did not. `optionalRow` used to drop the
    // whole line; the form's caption and rule are now always printed (that is what the blank agency page
    // carries) and the conditional narrowed to the AMOUNT, which is `manual()`. What must stay true is
    // that none of these four can reach the page as a derived 0.00.
    for (const f of ['donations', 'zakatOther', 'childRelief', 'tp1Relief']) {
      expect(pdf, `${f} must go through manual()`).toContain(`manual(d.partD.${f})`);
      expect(pdf, `${f} must not be drawn as a derived figure`).not.toContain(`derived(d.partD.${f})`);
    }
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
  it('Section E names the fund before its amount, and no longer carries EIS', () => {
    const pdf = read('lib/ea-pdf.ts');
    const e = pdf.slice(pdf.indexOf('putFit(t.sectionEContributions'), pdf.indexOf('putFit(t.sectionFExemptAllowances'));
    // The fund is NAMED before it is quantified, exactly as the form asks ("Nama Kumpulan Wang" first).
    expect(e).toContain('putFit(t.fundName');
    expect(e).toContain('d.partE.fundName');
    expect(e).toContain('derived(d.partE.epf)');
    expect(e).toContain('derived(d.partE.socso)');
    // The official Section E has exactly two amounts. EIS is kept as a figure but printed outside it —
    // r219 moved it the rest of the way out, below the officer box in our own strip, so that no line
    // inside the drawn form claims a box the C.P.8A does not have.
    expect(e).not.toContain('eisSip');
    const strip = pdf.slice(pdf.indexOf('let y: number = EA_FORM.footStripT'));
    expect(strip, 'the EIS figure must still be printed somewhere').toContain('t.eisSip');
    expect(strip).toContain('d.partE.eis');
  });

  it('Section F exists as its own section, and the exempt figure left Part B', () => {
    const pdf = read('lib/ea-pdf.ts');
    // ONE LINE whose title IS the item, with its own RM before the rule — the form's own arrangement.
    expect(pdf).toContain('putFit(t.sectionFExemptAllowances');
    expect(pdf).toContain('derived(d.partB.exemptAllowances ?? 0)');
    // It must not come back inside Part B, where it read as another component of that total, which it is
    // not: it is the tax-exempt PORTION of the allowances already printed on 1(c).
    const b = pdf.slice(pdf.indexOf('putFit(t.sectionBEmploymentIncome'), pdf.indexOf('putFit(t.sectionCPensionOther'));
    expect(b).not.toContain('exemptAllowances');
  });

  it('the fund name is a pack constant, not a per-employee column invented for one form', () => {
    expect(read('localization/my/reports.ts')).toContain("export const EA_FUND_NAME = 'KWSP'");
  });
});
