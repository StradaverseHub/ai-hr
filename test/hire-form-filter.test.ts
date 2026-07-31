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
import { hireOptionVisible } from '../lib/hire-form-filter';

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

/**
 * 6d671f44 — the cascade moved from a pure-DOM inline script on the Personnel LIST page to the
 * dedicated Create New Employee wizard, which is a client component and can simply CALL the rule.
 *
 * The suites that used to live here pinned the serialised script and the hydration-parity stamps
 * that made it safe on a server-rendered page. Neither exists any more, and asserting on them would
 * have been asserting on plumbing. What still matters — and is asserted below — is that there is
 * exactly ONE visibility rule, that the wizard uses it rather than reimplementing it, and that the
 * two behaviours the script was written to guarantee (self-heal on company change; an explained
 * empty list) survived the move.
 */
describe('6d671f44 — the wizard uses the one rule, and keeps its two behaviours', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const WIZARD = fs.readFileSync(path.resolve(__dirname, '../app/admin/personnel/new/wizard.tsx'), 'utf8');
  const PAGE = fs.readFileSync(path.resolve(__dirname, '../app/admin/personnel/page.tsx'), 'utf8');
  const LIB = fs.readFileSync(path.resolve(__dirname, '../lib/hire-form-filter.ts'), 'utf8');

  it('the wizard calls hireOptionVisible instead of reimplementing the rule', () => {
    expect(WIZARD).toContain("import { hireOptionVisible } from '@/lib/hire-form-filter'");
    expect(WIZARD).toContain('hireOptionVisible({');
    // All four narrowed selects go through it.
    expect(WIZARD).toContain('businessUnits.filter((b) => visible(b, false))');
    expect(WIZARD).toContain('departments.filter((d) => visible(d, true))');
    expect(WIZARD).toContain('positions.filter((p) => visible(p, false))');
    expect(WIZARD).toContain('costCenters.filter((c) => visible(c, false))');
  });

  it('the serialised inline script is GONE, not merely unused', () => {
    // A dead export is still a live surface — the r80 lesson. It is removed, and the reason is
    // recorded where the next reader will look for it.
    expect(LIB).not.toContain('export const HIRE_ORG_FILTER_SCRIPT');
    expect(LIB).toContain('`HIRE_ORG_FILTER_SCRIPT` USED TO LIVE HERE');
    expect(PAGE).not.toContain('HIRE_ORG_FILTER_SCRIPT');
    expect(PAGE).not.toContain('dangerouslySetInnerHTML');
  });

  it('changing company CLEARS the dependent picks — never auto-picks the first visible option', () => {
    // Feedback 570e3311 scenario 2, carried over verbatim in behaviour.
    expect(WIZARD).toContain("e.departmentId = '';");
    expect(WIZARD).toContain("e.positionId = '';");
    expect(WIZARD).toContain("e.costCenterId = '';");
    expect(WIZARD).not.toContain('firstVisible');
  });

  it('a company that may use NONE of a select\'s options still says so (d61f0ff2)', () => {
    expect(WIZARD).toContain('const orgEmpty = (opts: Option[])');
    expect((WIZARD.match(/\{t\('orgLabelsEmptyForCompany'\)\}/g) ?? []).length).toBe(4);
  });

  it('the list page no longer carries a data-entry form at all', () => {
    // The reporter's requirement, asserted as an absence: "The current employee list screen shall not
    // be used for data entry."
    expect(PAGE).not.toContain('hireAction');
    expect(PAGE).not.toContain('<HireFormPanel>');
    expect(PAGE).not.toContain('id="hire-company"');
    expect(PAGE).toContain('href="/admin/personnel/new"');
  });
});
