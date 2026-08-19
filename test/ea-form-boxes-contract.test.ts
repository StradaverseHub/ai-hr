/**
 * 6036dab7 — THE EA BOX CONTRACT, PINNED ACROSS ALL FOUR HALVES THAT HAVE TO AGREE.
 *
 * An EA box is not one thing in one file. It is a name in the amendment vocabulary (EA_FIELDS,
 * localization/my/reports.ts), a figure the read returns, a row on the HTML statement, a row in the
 * "Amend EA figures" panel beneath it, and a line the PDF renderer draws from a label in `EaPdfLabels`.
 * TypeScript enforces exactly two of those joins and no more:
 *   • the route must supply every `EaPdfLabels` key (they are required properties), and
 *   • `derivedField`'s switch in core/ea-override.ts is exhaustive over `EaField` with NO `default:`,
 *     so a new field without a derived baseline will not compile.
 * Everything else is silent. A field can join EA_FIELDS, be storable, be amendable through the server
 * action, and never appear on either surface — HR types a gratuity into an API that accepts it and the
 * printed C.P.8A does not have the box. A label can sit in `EaPdfLabels`, be translated into all six
 * locales, be handed to the renderer, and never be drawn. Neither shows up in a unit test of either side.
 *
 * So this is a SOURCE-SHAPE test over both sides of each unenforced join. It reads the files rather than
 * the runtime because the defect is the absence of a line of code, which no runtime value exposes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EA_FIELDS, EA_PART_B_COMPONENTS } from '../localization/my/reports';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const PAGE = read('app/payroll/reports/ea/[employmentId]/page.tsx');
const RENDERER = read('lib/ea-pdf.ts');
const ROUTE = read('app/me/ea/[employmentId]/pdf/route.ts');

/** The keys declared on `EaPdfLabels` — read off the type declaration, since types are erased at runtime. */
function eaPdfLabelKeys(): string[] {
  const block = RENDERER.match(/export type EaPdfLabels = \{([\s\S]*?)\n\};/);
  expect(block, 'EaPdfLabels declaration not found in lib/ea-pdf.ts').toBeTruthy();
  return [...block![1].matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

/** The field ids listed in the page's `amendFields` array literal — the panel HR actually sees. */
function amendPanelFields(): string[] {
  const block = PAGE.match(/const amendFields: AmendField\[\] = \(\s*\[([\s\S]*?)\]\s*as const/);
  expect(block, 'amendFields array literal not found in the EA page').toBeTruthy();
  return [...block![1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]);
}

describe('6036dab7 — every EA box reaches every surface', () => {
  it('every field in the EA vocabulary is PRINTED on the HTML statement', () => {
    // `rm(ea.partX.field)` is the render, and only the render: the amend panel's `derivedFor` map reads the
    // same fields WITHOUT `rm(`, so a field that is amendable-but-invisible still fails here.
    const printedOnScreen = (f: string) => ['B', 'C', 'D', 'E'].some((s) => PAGE.includes(`rm(ea.part${s}.${f})`));
    const missing = EA_FIELDS.filter((f) => !printedOnScreen(f));
    expect(missing, `EA fields with no printed row on the EA screen: ${missing.join(', ')}`).toEqual([]);
  });

  it('every field in the EA vocabulary is OFFERED in the amend panel', () => {
    const offered = amendPanelFields();
    const missing = EA_FIELDS.filter((f) => !offered.includes(f));
    expect(missing, `EA fields HR cannot enter: ${missing.join(', ')}`).toEqual([]);
    // …and nothing is offered that the vocabulary does not contain (the service would reject it with
    // `invalidField`, so the row would be a control that always errors).
    const unknown = offered.filter((f) => !(EA_FIELDS as readonly string[]).includes(f));
    expect(unknown, `amend panel offers fields the service rejects: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every field in the EA vocabulary is DRAWN by the PDF renderer', () => {
    const missing = EA_FIELDS.filter((f) => !/^(gross)$/.test(f) && !new RegExp(`\\bd\\.part[BCDE]\\.${f}\\b`).test(RENDERER));
    expect(missing, `EA fields the PDF never draws: ${missing.join(', ')}`).toEqual([]);
    expect(RENDERER).toContain('d.partB.gross'); // the total, drawn by its own row
  });

  it('every label the PDF renderer declares is actually drawn, and is supplied by the route', () => {
    const keys = eaPdfLabelKeys();
    expect(keys.length).toBeGreaterThan(30); // sanity: the declaration parsed
    const undrawn = keys.filter((k) => !new RegExp(`\\bt\\.${k}\\b`).test(RENDERER));
    expect(undrawn, `EaPdfLabels keys nothing prints: ${undrawn.join(', ')}`).toEqual([]);
    // tsc already refuses a route that omits a required key; this catches the other direction — a key
    // wired through `t('…')` under a name the `payroll.ea` namespace does not have would fail
    // test/ea-pdf-i18n-keys.test.ts, and one supplied from a literal would fail here.
    const notFromNamespace = keys.filter((k) => !ROUTE.includes(`${k}: t('`));
    expect(notFromNamespace, `EaPdfLabels keys the route does not resolve from payroll.ea: ${notFromNamespace.join(', ')}`).toEqual([]);
  });

  it('every Part B component that sums into the total is itself a printed line', () => {
    // The invariant the §0 fix bought: the printed lines sum to the printed total. A component that feeds
    // `partB.gross` without appearing on the form makes the total larger than the lines above it.
    const missing = EA_PART_B_COMPONENTS.filter((f) => !RENDERER.includes(`d.partB.${f}`));
    expect(missing, `Part B components that reach the total but are never printed: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * ⚠️ A BOX THAT PRINTS 0.00 MAKES A CLAIM. AN ABSENT BOX MAKES NONE.
   *
   * None of the manual Part B boxes can be derived from payroll: `payslip` persists only aggregate
   * scalars (basic_salary / allowance / overtime_pay / bonus / gross_pay + a statutory jsonb), there is
   * no payslip-line table, and every earning component is folded into `payslip.allowance` before the
   * row is written. Their only source is an `ea_override` HR has keyed.
   *
   * Printing them unconditionally therefore asserted "this money does not exist" while the same money
   * was printed two lines up under Allowances — a tenant paying a director RM 4,000/month of commission
   * got "Fees (incl. director's fees) RM 0.00" beside an Allowances figure carrying the RM 48,000. That
   * is an affirmative false statement on a C.P.8A, and it is worse than the box being absent, which is
   * what the form did before this round.
   *
   * Source-shape, deliberately, for the same reason as every other case in this file: the defect is
   * which renderer call a line uses, and no runtime value distinguishes "0.00 printed" from "omitted"
   * without rasterising a PDF.
   */
  it('the manual Part B boxes are drawn only when HR has entered a figure', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/ea-pdf.ts'), 'utf8');

    // The guard exists and is a real zero test, not a truthiness check (0 and '' differ here).
    expect(src).toMatch(/const optionalRow = \(label: string, v: number\) => \{/);
    expect(src).toMatch(/if \(Math\.round\(\(Number\(v\) \|\| 0\) \* 100\) !== 0\) row\(label, rm\(v\)\);/);

    // Every box whose ONLY source is an override goes through it…
    for (const box of [
      'directorFee', 'tipsPerquisites', 'taxBorneByEmployer', 'esos', 'gratuity', 'arrears',
      'benefitsInKind', 'livingAccommodation', 'unapprovedFundRefund', 'compensation',
    ]) {
      expect(src, `${box} still prints unconditionally`).toContain(`optionalRow(t.${box}, d.partB.${box});`);
      expect(src, `${box} is also drawn unconditionally somewhere`).not.toContain(
        `row(t.${box}, rm(d.partB.${box}));`,
      );
    }

    // …and the boxes that ARE payroll-derived keep printing even at zero, because there a zero is a
    // fact we can stand behind. Suppressing these would hide a real "you were paid no bonus".
    for (const [label, field] of [
      ['grossSalary', 'grossSalary'],
      ['bonus', 'bonus'],
      ['allowancesPerquisites', 'allowances'],
    ]) {
      expect(src, `${field} must still print unconditionally`).toContain(
        `row(t.${label}, rm(d.partB.${field}));`,
      );
    }
  });

});
