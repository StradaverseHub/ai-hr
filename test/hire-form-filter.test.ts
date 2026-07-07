/**
 * Recruitment — company validation error during employee hiring (feedback c87bc26a).
 * The Hire form's org pickers (Business Unit / Department / Position / Cost Centre) must only offer
 * options belonging to the selected hiring Company, so a cross-company combination cannot be chosen
 * at the UI level. `hireOptionVisible` is the pure visibility rule the page's inline script embeds
 * verbatim (see lib/hire-form-filter.ts); the server-side CrossCompanyError guard covered by
 * test/hire-org-info.test.ts remains the regression backstop for non-JS / direct-POST paths.
 */
import { describe, expect, it } from 'vitest';
import { HIRE_ORG_FILTER_SCRIPT, hireOptionVisible } from '../lib/hire-form-filter';

const A = 'company-a';
const B = 'company-b';
const BU1 = 'bu-1';
const BU2 = 'bu-2';

/** BU / Position / Cost Centre options carry no BU dimension. */
const plain = (optCompany: string, selectedCompany: string) =>
  hireOptionVisible({ optCompany, optBusinessUnit: null, selectedCompany, selectedBusinessUnit: '' });

/** Department options carry both a company and a BU stamp ('' = unassigned BU). */
const dept = (
  optCompany: string,
  optBusinessUnit: string,
  selectedCompany: string,
  selectedBusinessUnit: string,
) => hireOptionVisible({ optCompany, optBusinessUnit, selectedCompany, selectedBusinessUnit });

describe('hireOptionVisible — company rule (BU / Position / Cost Centre selects)', () => {
  it('shows an option whose company matches the selected company', () => {
    expect(plain(A, A)).toBe(true);
  });

  it('hides an option from a different company', () => {
    expect(plain(B, A)).toBe(false);
  });

  it('always shows placeholder ("None") options — they carry no company stamp', () => {
    expect(plain('', A)).toBe(true);
    expect(plain('', B)).toBe(true);
    expect(dept('', '', A, BU1)).toBe(true);
  });

  it('applies no company filter when no company is selected (empty companies edge case)', () => {
    expect(plain(A, '')).toBe(true);
    expect(plain(B, '')).toBe(true);
  });

  it('re-filters when the selected company changes: previous company options become hidden', () => {
    // Selected company A: A visible, B hidden. Switch to B: flips.
    expect(plain(A, A)).toBe(true);
    expect(plain(B, A)).toBe(false);
    expect(plain(A, B)).toBe(false);
    expect(plain(B, B)).toBe(true);
  });
});

describe('hireOptionVisible — department rule (company AND business-unit)', () => {
  it('requires both company match and BU match', () => {
    expect(dept(A, BU1, A, BU1)).toBe(true); // right company + right BU
    expect(dept(A, BU2, A, BU1)).toBe(false); // right company + wrong BU
    expect(dept(B, BU1, A, BU1)).toBe(false); // wrong company + right BU
    expect(dept(B, BU2, A, BU1)).toBe(false); // wrong company + wrong BU
  });

  it('keeps unassigned-BU departments visible under every BU choice (within the company)', () => {
    expect(dept(A, '', A, BU1)).toBe(true); // unassigned BU, right company
    expect(dept(B, '', A, BU1)).toBe(false); // unassigned BU does not bypass the company rule
  });

  it('shows all of the company departments when no BU is chosen', () => {
    expect(dept(A, BU1, A, '')).toBe(true);
    expect(dept(A, BU2, A, '')).toBe(true);
    expect(dept(B, BU1, A, '')).toBe(false); // still company-filtered
  });

  it('skips the BU rule entirely for selects without a BU dimension (optBusinessUnit null)', () => {
    expect(
      hireOptionVisible({ optCompany: A, optBusinessUnit: null, selectedCompany: A, selectedBusinessUnit: BU2 }),
    ).toBe(true);
  });
});

describe('HIRE_ORG_FILTER_SCRIPT — inline script embeds the tested rule', () => {
  it('contains the serialised hireOptionVisible function (no drift between test and page)', () => {
    expect(HIRE_ORG_FILTER_SCRIPT).toContain(hireOptionVisible.toString());
  });

  it('is syntactically valid standalone JS (survives Function.prototype.toString embedding)', () => {
    // Compiles the script without executing it — catches a transform ever producing an inline
    // script the browser cannot parse.
    expect(() => new Function(HIRE_ORG_FILTER_SCRIPT)).not.toThrow();
  });

  it('wires all five hire-form selects', () => {
    for (const id of [
      'hire-company',
      'hire-business-unit',
      'hire-department',
      'hire-position',
      'hire-cost-center',
    ]) {
      expect(HIRE_ORG_FILTER_SCRIPT).toContain(`'${id}'`);
    }
  });
});
