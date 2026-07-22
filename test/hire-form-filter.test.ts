/**
 * Recruitment — company validation error during employee hiring (feedback c87bc26a), extended by
 * feedback 570e3311 (auto-filter org label dropdowns via Shared System Labels).
 *
 * The Hire form's org pickers (Business Unit / Department / Position / Cost Centre) must only offer
 * options the selected hiring Company MAY use — including labels SHARED into it via the Criteria
 * assignments in System Settings → System Labels. Each option is stamped `data-companies`: the CSV
 * of every company id the resolver (core/system-labels.ts labelIdsForCompany — origin ∪ shared-in ∪
 * global, flag-gated) surfaces it for, so the pure rule here is CSV membership; the flag semantics
 * live in the tested SQL resolver, not in JS. `hireOptionVisible` is the pure visibility rule the
 * page's inline script embeds verbatim (see lib/hire-form-filter.ts); the server-side
 * CrossCompanyError guard covered by test/hire-org-info.test.ts and test/org-label-filtering.test.ts
 * remains the regression backstop for non-JS / direct-POST paths.
 */
import { describe, expect, it } from 'vitest';
import { HIRE_ORG_FILTER_SCRIPT, hireOptionVisible } from '../lib/hire-form-filter';

const A = 'company-a';
const B = 'company-b';
const C = 'company-c';
const BU1 = 'bu-1';
const BU2 = 'bu-2';

/** BU / Position / Cost Centre options carry no BU dimension. */
const plain = (optCompanies: string, selectedCompany: string) =>
  hireOptionVisible({
    optCompanies,
    optBusinessUnit: null,
    optBuCompanies: '',
    selectedCompany,
    selectedBusinessUnit: '',
  });

/** Department options carry a companies CSV, a BU stamp ('' = unassigned) and the BU's companies CSV. */
const dept = (
  optCompanies: string,
  optBusinessUnit: string,
  optBuCompanies: string,
  selectedCompany: string,
  selectedBusinessUnit: string,
) => hireOptionVisible({ optCompanies, optBusinessUnit, optBuCompanies, selectedCompany, selectedBusinessUnit });

describe('hireOptionVisible — company rule (data-companies CSV membership)', () => {
  it('shows an option whose CSV contains the selected company (origin)', () => {
    expect(plain(A, A)).toBe(true);
  });

  it('hides an option from a different company (flag OFF ⇒ origin-only CSV)', () => {
    // With the target company's shared_system_labels flag OFF the resolver emits origin-only, so
    // the CSV collapses to the origin id — invisible everywhere else, byte-identical to before.
    expect(plain(A, B)).toBe(false);
  });

  it('a label shared into another company (Criteria assignment) is visible under BOTH companies', () => {
    const shared = `${A},${B}`;
    expect(plain(shared, A)).toBe(true);
    expect(plain(shared, B)).toBe(true);
    expect(plain(shared, C)).toBe(false); // not shared into C
  });

  it('a GLOBAL label (CSV of every flag-ON company) is visible under each of them', () => {
    const global = `${A},${B},${C}`;
    expect(plain(global, A)).toBe(true);
    expect(plain(global, B)).toBe(true);
    expect(plain(global, C)).toBe(true);
  });

  it('always shows placeholder options — they carry no data-companies stamp', () => {
    expect(plain('', A)).toBe(true);
    expect(plain('', B)).toBe(true);
    expect(dept('', '', '', A, BU1)).toBe(true);
  });

  it('applies no company filter when no company is selected (empty companies edge case)', () => {
    expect(plain(A, '')).toBe(true);
    expect(plain(B, '')).toBe(true);
  });

  it('re-filters when the selected company changes: previous company options become hidden', () => {
    expect(plain(A, A)).toBe(true);
    expect(plain(B, A)).toBe(false);
    expect(plain(A, B)).toBe(false);
    expect(plain(B, B)).toBe(true);
  });
});

describe('hireOptionVisible — department rule (company AND business-unit)', () => {
  it('requires both company membership and BU match', () => {
    expect(dept(A, BU1, A, A, BU1)).toBe(true); // right company + right BU
    expect(dept(A, BU2, A, A, BU1)).toBe(false); // right company + wrong BU
    expect(dept(B, BU1, B, A, BU1)).toBe(false); // wrong company + right BU
    expect(dept(B, BU2, B, A, BU1)).toBe(false); // wrong company + wrong BU
  });

  it('keeps unassigned-BU departments visible under every BU choice (within the company)', () => {
    expect(dept(A, '', '', A, BU1)).toBe(true); // unassigned BU, right company
    expect(dept(B, '', '', A, BU1)).toBe(false); // unassigned BU does not bypass the company rule
  });

  it('shows all of the company departments when no BU is chosen', () => {
    expect(dept(A, BU1, A, A, '')).toBe(true);
    expect(dept(A, BU2, A, A, '')).toBe(true);
    expect(dept(B, BU1, B, A, '')).toBe(false); // still company-filtered
  });

  it('BU-degrade: a department shared into B whose BU is A-only stays visible under B with ANY BU chosen', () => {
    // Department shared A→B (CSV 'A,B'), its linked BU usable only under A (data-bu-companies 'A').
    const sharedDept = `${A},${B}`;
    // Under B the BU is not usable → the BU rule degrades to "unassigned": visible under any BU pick.
    expect(dept(sharedDept, BU1, A, B, BU2)).toBe(true);
    expect(dept(sharedDept, BU1, A, B, BU1)).toBe(true);
    // Under A (where the BU IS usable) the department is still BU-filtered as before.
    expect(dept(sharedDept, BU1, A, A, BU1)).toBe(true);
    expect(dept(sharedDept, BU1, A, A, BU2)).toBe(false);
  });

  it('skips the BU rule entirely for selects without a BU dimension (optBusinessUnit null)', () => {
    expect(
      hireOptionVisible({
        optCompanies: A,
        optBusinessUnit: null,
        optBuCompanies: '',
        selectedCompany: A,
        selectedBusinessUnit: BU2,
      }),
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

  it('reads the CSV stamps (data-companies / data-bu-companies)', () => {
    expect(HIRE_ORG_FILTER_SCRIPT).toContain(`getAttribute('data-companies')`);
    expect(HIRE_ORG_FILTER_SCRIPT).toContain(`getAttribute('data-bu-companies')`);
  });

  it("self-heals a hidden selection to the '' placeholder — never auto-picks the first visible option", () => {
    // Scenario 2 (feedback 570e3311): switching Company must CLEAR stale picks, so the one and only
    // self-heal target is the '' option (the Department select now has a disabled placeholder).
    expect(HIRE_ORG_FILTER_SCRIPT).toContain(`sel.value='';`);
    expect(HIRE_ORG_FILTER_SCRIPT).not.toContain('firstVisible');
  });

  it('never re-stamps placeholder options (the disabled Department prompt keeps its markup state)', () => {
    expect(HIRE_ORG_FILTER_SCRIPT).toContain(`if(!o.getAttribute('data-companies'))continue;`);
  });
});

/**
 * Hydration parity (spawned from the 2026-07-22 hydration-mismatch report): HIRE_ORG_FILTER_SCRIPT
 * runs at parse time — BEFORE React hydrates — and stamps hidden/disabled from the current company
 * selection. The company select has no placeholder, so the browser auto-selects companies[0]; the
 * page must therefore server-render that SAME initial state (via hireInitiallyHidden →
 * hireOptionVisible) on every filtered option, or each non-companies[0] option hydrates with a
 * mismatch warning. These assertions pin the parity wiring in the page source.
 */
describe('hire form — server-rendered initial visibility matches the inline script', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const PAGE = fs.readFileSync(path.resolve(__dirname, '../app/admin/personnel/page.tsx'), 'utf8');

  it('derives the initial state from the same pure rule the script embeds', () => {
    expect(PAGE).toContain('hireOptionVisible');
    expect(PAGE).toContain('const hireInitiallyHidden');
    // Must key off the SAME company the browser auto-selects (companies[0], no placeholder).
    expect(PAGE).toMatch(/selectedCompany:\s*defaultCompanyId \?\? ''/);
  });

  it('sources the data-companies CSVs from the SQL resolver (labelIdsForCompany), not a JS mirror', () => {
    expect(PAGE).toContain('labelIdsForCompany(session, kind, c.id)');
  });

  it('stamps data-companies + hidden AND disabled from the same CSV on every filtered option (4 selects)', () => {
    const csvStamps = PAGE.match(/data-companies=\{csv\}/g);
    expect(csvStamps).toHaveLength(4); // business unit, department, position, cost centre
    const stamps = PAGE.match(/hidden=\{hireInitiallyHidden\((\w+)\)\}\s*\n\s*disabled=\{hireInitiallyHidden\(\1\)\}/g);
    expect(stamps).toHaveLength(4);
  });

  it('department options carry the BU-companies CSV for the BU-degrade rule', () => {
    expect(PAGE).toMatch(/data-bu-companies=\{d\.businessUnitId \? \(buCompaniesCsv\.get\(d\.businessUnitId\) \?\? ''\) : ''\}/);
  });

  it("the Department select has a disabled '' placeholder (the clear-on-company-switch target)", () => {
    expect(PAGE).toMatch(/<select name="departmentId" id="hire-department" required defaultValue=""/);
    expect(PAGE).toMatch(/<option value="" disabled>\s*\n\s*\{t\('departmentSelectPrompt'\)\}/);
  });

  it('the company select still has no placeholder (companies[0] IS the initial selection)', () => {
    // If a placeholder option is ever added, the initial selectedCompany becomes '' and
    // hireInitiallyHidden must be re-derived — this assertion forces that reconsideration.
    expect(PAGE).toMatch(/<select name="companyId" id="hire-company" required/);
  });
});
