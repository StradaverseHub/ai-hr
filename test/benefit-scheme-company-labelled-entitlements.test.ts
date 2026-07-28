/**
 * Feedback 0d1a0cfc — Leave Entitlements name the Benefit Scheme's COMPANY.
 *
 * The Leave Entitlements subsection of the Entitlement step already assigns entitlements against Benefit
 * Schemes (never a grade list — that older surface is the separate Eligibility-step leave_policy form and
 * is deliberately untouched here). What it did NOT do is say WHICH COMPANY a scheme belongs to: the Scheme
 * picker rendered a flat `schemes.map` of bare names, and the Service Based Entitlements table's "Benefit
 * scheme" column printed the bare scheme name too. Two companies with similarly named schemes were
 * indistinguishable. This item adds the company on both surfaces:
 *   - the Scheme <select> groups its options into per-company <optgroup>s (reusing the schemesByCompany
 *     memo the workbench already builds), and
 *   - the per-type table prints the company name beside the scheme name, fed by a new derived
 *     `companyName` field the page resolves from rows it already loads.
 * Presentation only: no schema, no migration, no service/action change, no leave_policy write, no resolver
 * change, and no new i18n key (optgroup labels and options are DATA — company and scheme names).
 *
 * Static source guard, the documented convention for this DOM-runner-less feature area (see
 * benefit-scheme-scoped-step.test.ts / benefit-scheme-collapsed-default.test.ts): vitest here runs
 * `test/**\/*.test.ts` with no jsdom and no React renderer, so the "two companies each owning one active
 * scheme render under their own optgroup" scenario is pinned structurally — the picker's option set is
 * proven to be exactly the schemesByCompany grouping (which itself is proven to key on companyId and
 * resolve names through the companies prop), and the table cell is proven to render e.companyName beside
 * e.schemeName from a row the page populates per scheme. The pixels are assigned to browser verification.
 *
 * The traps this guards: (a) someone restoring the flat `schemes.map` in the picker and silently dropping
 * the company grouping; (b) the picker quietly acquiring a grade list (the reporter's explicit "grade list
 * should no longer be displayed or selectable in this section"); (c) the table row type losing companyName
 * or the page forgetting to populate it, leaving the column bare again; (d) the company name arriving via a
 * NEW query instead of the already-loaded companies/benefitSchemes rows; (e) a stray new i18n key sneaking
 * in out of parity across the six locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The Scheme picker's <select> … </select> body inside the Leave Entitlements subsection. */
function schemePickerSelect(): string {
  const fieldAt = schemeSrc.indexOf("<Field label={t('selectScheme')}>");
  expect(fieldAt, "the Leave Entitlements Scheme picker Field must exist").toBeGreaterThan(-1);
  const openAt = schemeSrc.indexOf('<select', fieldAt);
  const closeAt = schemeSrc.indexOf('</select>', openAt);
  expect(openAt, 'Scheme picker <select> open tag').toBeGreaterThan(-1);
  expect(closeAt, 'Scheme picker </select> close tag').toBeGreaterThan(openAt);
  return schemeSrc.slice(openAt, closeAt + '</select>'.length);
}

/** The per-type entitlement section — the row type, the matrix row and LeaveTypeEntitlementTable itself.
 *  a03eff24 turned the flat table into a matrix whose row lives in its own component, so the window starts
 *  at the row TYPE and ends at the banner opening the sibling company × grade table. */
function perTypeTableBody(): string {
  const start = schemeSrc.indexOf('export type LeaveTypeSchemeEntitlement');
  expect(start, 'LeaveTypeSchemeEntitlement must exist').toBeGreaterThan(-1);
  expect(schemeSrc.indexOf('export function LeaveTypeEntitlementTable', start), 'the table must still be exported').toBeGreaterThan(start);
  const end = schemeSrc.indexOf('// ─────────────────── Service-Based Entitlements (company × grade) ───────────────────', start);
  expect(end, 'per-type section must be delimited by the company × grade banner').toBeGreaterThan(start);
  return schemeSrc.slice(start, end);
}

describe('0d1a0cfc · the Scheme picker lists Benefit Schemes grouped under their company', () => {
  it('renders per-company <optgroup>s from the schemesByCompany grouping, not a flat scheme list', () => {
    const sel = schemePickerSelect();
    // Grouped: one optgroup per company, labelled with the company name, options inside it.
    expect(sel).toMatch(/schemesByCompany\.map\(\(group\) => \(/);
    expect(sel).toMatch(/<optgroup[^>]*label=\{group\.name\}/);
    expect(sel).toMatch(/<optgroup[^>]*key=\{group\.companyId\}/);
    expect(sel).toMatch(/group\.schemes\.map\(\(s\) => \(/);
    expect(sel).toContain('<option key={s.id} value={s.id}>{s.name}</option>');
    // …and the flat pre-0d1a0cfc option list is gone (the trap: quietly restoring it).
    expect(sel).not.toMatch(/\{schemes\.map\(/);
  });

  it('the grouping it reuses keys on companyId and resolves the label from the companies prop', () => {
    // Anti-vacuity for the assertion above: if schemesByCompany stopped grouping by company (or stopped
    // resolving a company NAME), the optgroups would still "exist" while saying nothing about a company.
    const memoAt = schemeSrc.indexOf('const schemesByCompany = useMemo(');
    expect(memoAt, 'schemesByCompany memo must exist').toBeGreaterThan(-1);
    const memo = schemeSrc.slice(memoAt, schemeSrc.indexOf('}, [schemes, companyName]);', memoAt));
    expect(memo).toContain('map.get(s.companyId)');
    expect(memo).toContain('companyName.get(companyId)');
    // companyName itself is the companies prop, not a hardcoded/placeholder source.
    expect(schemeSrc).toContain('const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);');
  });

  it('leaves selection state, the change handler and the default selection untouched', () => {
    const sel = schemePickerSelect();
    expect(sel).toContain('value={selectedSchemeId}');
    expect(sel).toContain('onChange={(e) => setSelectedSchemeId(e.target.value)}');
    expect(schemeSrc).toContain("useState<string>(schemes[0]?.id ?? '')");
  });

  it('shows no grade list in this subsection — schemes only', () => {
    const sel = schemePickerSelect();
    expect(sel).not.toMatch(/grades?\./i);
    expect(sel).not.toMatch(/gradeGroup/i);
    // The zero-schemes empty state still reuses the existing key (no new one was invented).
    expect(schemeSrc).toContain("t('entNeedsScheme')");
  });
});

describe('0d1a0cfc · the Service Based Entitlements table names the company beside the scheme', () => {
  it('the row type carries a derived companyName', () => {
    const typeAt = schemeSrc.indexOf('export type LeaveTypeSchemeEntitlement');
    expect(typeAt).toBeGreaterThan(-1);
    const decl = schemeSrc.slice(typeAt, schemeSrc.indexOf('};', typeAt));
    expect(decl).toMatch(/companyName: string \| null;/);
    // The scheme name and pool note are still carried on the row (a03eff24 moved them to the second column,
    // under the grade group — it did not drop them).
    expect(decl).toContain('schemeName: string;');
    expect(decl).toContain('poolName: string | null;');
  });

  // a03eff24 SUPERSEDES the original assertion here. That version required the company name to be reprinted
  // beside the scheme name on EVERY row — which is precisely the repetition the reporter of a03eff24 asked
  // us to remove. The requirement 0d1a0cfc actually protects is "this surface says which company a scheme
  // belongs to", and the matrix still satisfies it, more strongly: the company is a merged block heading
  // rather than a muted suffix. So the check is re-pointed, not relaxed — it still fails if the company
  // stops being named, and it now also fails if the repetition comes back.
  it('names the company ONCE as a merged block heading, with the scheme still identified per row', () => {
    const body = perTypeTableBody();
    // The block a row belongs to is keyed on its companyName…
    expect(body).toContain('const companyBlocks = useMemo(');
    expect(body).toMatch(/const key = e\.companyName \?\? '';/);
    // …the name prints on the block's first row only, and the row renders that prop.
    expect(body).toContain('companyLabel={i === 0 ? block.companyName : null}');
    expect(body).toContain("{companyLabel ?? ''}");
    // The scheme is still named on its own row, and the shared-pool note survived the restructure.
    expect(body).toContain('{ent.schemeName}');
    expect(body).toContain("t('perTypeSharedPool'");
    // The pre-a03eff24 per-row company suffix must not come back.
    expect(body).not.toMatch(/e\.companyName != null &&/);
  });

  it('the page populates companyName from rows it already loads (no new query)', () => {
    expect(pageSrc).toContain('companyName: schemeCompanyNameById.get(e.benefitSchemeId) ?? null,');
    expect(pageSrc).toMatch(
      /const schemeCompanyNameById = new Map\(\s*benefitSchemes\.map\(\(sc\) => \[sc\.id, companyNameById\.get\(sc\.companyId\) \?\? null\] as const\),\s*\);/,
    );
    // Derived on the page from the SAME single load — not a second scheme/company fetch.
    expect(pageSrc.match(/listBenefitSchemes\(s\)/g)?.length, 'schemes loaded exactly once').toBe(1);
    expect(pageSrc).toContain('const companyNameById = new Map(companies.map((c) => [c.id, c.name]));');
  });
});

describe('0d1a0cfc · nothing else moved', () => {
  it('no leave_policy write path is touched — the older grade-based Eligibility surface still ships', () => {
    // The reporter asked only that the SCHEME picker stop looking like a bare label list. The separate
    // grade-scoped policy form (and its actions) is explicitly out of scope: removing it would corrupt
    // grade-scoped rows, and scheme days already SUPERSEDE policy days in entitledDays().
    expect(pageSrc).toContain('createLeavePoliciesMultiAction');
    expect(pageSrc).toContain('grades={gradeOptions}');
    // …and no expansion of a scheme back into companies × grades was introduced anywhere.
    expect(schemeSrc).not.toMatch(/gradeIdsForScheme|schemeToGrades|expandScheme/);
    expect(pageSrc).not.toMatch(/gradeIdsForScheme|schemeToGrades|expandScheme/);
  });

  it('adds no i18n key — the picker/column strings stay exactly the existing ones, in all six locales', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    const enKeys = Object.keys(en?.admin?.benefitScheme ?? {}).sort();
    expect(enKeys).toContain('selectScheme');
    expect(enKeys).toContain('perTypeColScheme');
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const bs = msgs?.admin?.benefitScheme ?? {};
      // Key-set parity: a new key added to en alone (or to five of six) fails here.
      expect(Object.keys(bs).sort(), `${loc}.admin.benefitScheme key set matches en`).toEqual(enKeys);
      for (const key of ['selectScheme', 'perTypeColScheme', 'entTitle', 'entNeedsScheme']) {
        expect(typeof bs[key], `${loc}.admin.benefitScheme.${key}`).toBe('string');
        expect((bs[key] as string).length, `${loc}.admin.benefitScheme.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
