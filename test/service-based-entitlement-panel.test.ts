/**
 * Restructure Service-Based Leave Entitlements by Company and Grade — the UI contract.
 *
 * Static source guard (the DOM-runner-less convention for this component area, see
 * leave-entitlement-substeps.test.ts / benefit-scheme-scoped-step.test.ts). The interactive company-switch,
 * per-row edit + save and the seeding round-trip are covered by service-based-entitlement.test.ts and the
 * browser spot-check; here we pin the structural contract the plan requires:
 *   - the picker lists COMPANY names only (no benefit-scheme names, no grade list); an empty state until a
 *     company is chosen;
 *   - each grade row pre-fills by SAMPLING resolveGradePolicy (so flat / N-band / null-default rows read
 *     correctly), and posts under2 / mid / over with the leave-type + company + grade scope;
 *   - a row Save is disabled until the row is DIRTY (an untouched row is never written ⇒ no spurious
 *     reprojection);
 *   - a grade whose resolving policy has a non-conforming band shape is read-only (never flattened).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');
const adminSrc = readFileSync(resolve(here, '../core/admin.ts'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The whole Service-Based Entitlements section (its helpers + ServiceGradeRow + ServiceEntitlementTable),
 *  up to the next unrelated top-level function. */
function tableBody(): string {
  const start = schemeSrc.indexOf('export type ServicePolicyRow');
  expect(start, 'the Service-Based Entitlements section must exist').toBeGreaterThan(-1);
  expect(schemeSrc.indexOf('export function ServiceEntitlementTable'), 'ServiceEntitlementTable must be exported').toBeGreaterThan(start);
  const end = schemeSrc.indexOf('function EntitlementForm', start);
  expect(end, 'section body must be delimited').toBeGreaterThan(start);
  return schemeSrc.slice(start, end);
}

describe('Service Based Entitlements — company-only picker + auto grade rows', () => {
  it('the picker lists COMPANY names only, with an empty state and no scheme/grade list', () => {
    const body = tableBody();
    // Company picker options come from the companies prop, labelled by the new company key.
    expect(body).toContain("t('serviceCompanyLabel')");
    expect(body).toContain('companies.map((c) => (');
    expect(body).toContain('{c.name}');
    // Empty state until a company is chosen (no default-to-first-company).
    expect(body).toContain("t('serviceSelectCompanyEmpty')");
    expect(body).toMatch(/const \[companyId, setCompanyId\] = useState\(''\)/);
    // No benefit-scheme names and no grade PICKER leaked into this picker (grades are ROWS, not options).
    expect(body.includes('schemeName')).toBe(false);
    expect(body.includes('schemes.map')).toBe(false);
  });

  it('pre-fills each grade row by sampling resolveGradePolicy at ~1 / 3 / 6 years', () => {
    const body = tableBody();
    expect(schemeSrc).toContain("import { resolveGradePolicy, type GradePolicyRow, type ServiceBand } from '@/core/leave-compute'");
    expect(body).toContain('resolveGradePolicy(activeRows, g.id, companyId, years)');
    expect(body).toContain('sample(1)');
    expect(body).toContain('sample(3)');
    expect(body).toContain('sample(6)');
    // One row per active grade (org-wide list), with the Grade column + the three fixed tier headers.
    expect(body).toContain('grades.map((g) => {');
    expect(body).toContain("t('gradeLabel')");
    expect(body).toContain("tb('tierUnderFixed')");
    expect(body).toContain("tb('tierMidFixed')");
    expect(body).toContain("tb('tierOverFixed')");
  });

  it('each editable row posts the scope + the three tier figures, and Save is gated on DIRTY', () => {
    const body = tableBody();
    for (const field of ['name="leaveTypeId"', 'name="companyId"', 'name="gradeId"', 'name="under2"', 'name="mid"', 'name="over"']) {
      expect(body.includes(field), `${field} posted`).toBe(true);
    }
    // Per-row dirty tracking ⇒ an untouched row is never written (no spurious reproject).
    expect(body).toMatch(/const dirty =\s*Number\(u\) !== prefill\.under2/);
    expect(body).toContain('disabled={!dirty}');
  });

  it('a grade with a non-conforming band shape is read-only (never flattened)', () => {
    const body = tableBody();
    expect(body).toContain('isConformingServiceShape');
    expect(body).toContain('editable: isConformingServiceShape(winner?.serviceBands ?? null)');
    // The read-only branch surfaces the guidance note instead of editable inputs.
    expect(body).toContain('if (!prefill.editable)');
    expect(body).toContain("t('serviceNonConformingNote')");
  });
});

describe('Service Based Entitlements — wiring + the first-save-safe writer', () => {
  it('the panel feeds the company-driven table this type + companies + grades + policies + the save action', () => {
    expect(panelSrc).toContain('<ServiceEntitlementTable');
    expect(panelSrc).toContain('saveAction={saveServiceEntitlementAction}');
    expect(panelSrc).toMatch(/policies\.map\(\s*\(p\): ServicePolicyRow =>/);
    // The page wires the dedicated action into the panel.
    expect(pageSrc).toContain('saveServiceEntitlementAction={saveServiceEntitlementAction}');
  });

  it('the action + the orchestrating core function exist (no new writer primitive — it composes the existing ones)', () => {
    expect(actionsSrc).toContain('export async function saveServiceEntitlementAction');
    expect(actionsSrc).toContain('saveServiceEntitlement(s, {');
    expect(adminSrc).toContain('export async function saveServiceEntitlement');
    // It routes through the shipped writers, not a bespoke insert path.
    const start = adminSrc.indexOf('export async function saveServiceEntitlement');
    const fn = adminSrc.slice(start, adminSrc.indexOf('export async function deleteLeavePolicy', start));
    expect(fn).toContain('createLeavePolicy(ctx');
    expect(fn).toContain('return updateLeavePolicy(ctx');
  });
});

describe('2bba9e35 · Service Based Entitlements is the single place to manage company entitlement policies', () => {
  // The Entitlement card segment (its CardTitle to the Condition card's CardTitle).
  const entitlementSegment = () => {
    const start = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
    const end = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return panelSrc.slice(start, end);
  };
  const SHARED_POLICY_GATE = "{(entitlementSubStep === 'policies' || entitlementSubStep === 'service') && (";

  it('the service sub-step reaches the SAME create/update/delete policy wiring via one shared block', () => {
    const seg = entitlementSegment();
    // One shared JSX block, gated for BOTH sub-steps — add / edit / delete a policy from Service reaches the
    // identical actions the Company Entitlements tab uses, over one set of records (not a copy).
    expect(seg).toContain(SHARED_POLICY_GATE);
    const gate = seg.indexOf(SHARED_POLICY_GATE);
    const adjustments = seg.indexOf("{entitlementSubStep === 'adjustments' && (");
    expect(adjustments).toBeGreaterThan(gate);
    const shared = seg.slice(gate, adjustments);
    for (const action of ['action={createPolicyAction}', 'action={updatePolicyAction}', 'action={deletePolicyAction}']) {
      expect(shared.includes(action), `${action} reachable from the service sub-step`).toBe(true);
    }
    // …and the timeline heading + Add affordance the tab offers are in the same shared block.
    expect(shared).toContain("t('companyEntitlements')");
    expect(shared).toContain("t('addEntitlement')");
  });

  it('the service block mounts the earning-method front door with alwaysShowScope', () => {
    const seg = entitlementSegment();
    // The service-only block (its exclusive gate up to the shared gate) hosts the earning-method front door,
    // so how days are earned through the year is set here too — over the SAME policy row (posts the SAME
    // updatePolicyAction), one setting stored in one place.
    const serviceGate = seg.indexOf("{entitlementSubStep === 'service' && (");
    const sharedGate = seg.indexOf(SHARED_POLICY_GATE);
    expect(serviceGate).toBeGreaterThan(-1);
    expect(sharedGate).toBeGreaterThan(serviceGate);
    const serviceBlock = seg.slice(serviceGate, sharedGate);
    expect(serviceBlock).toContain('<PolicyFrontDoor');
    expect(serviceBlock).toContain('alwaysShowScope');
    expect(serviceBlock).toContain('<EarningMethodForm');
    expect(serviceBlock).toContain('action={updatePolicyAction}');
  });

  it('PolicyFrontDoor honours alwaysShowScope so a single active policy still shows the scope picker', () => {
    // Without it the front door defaults to active[0] and hides the picker at length 1 — a method change
    // could then silently rewrite a different company·grade row and reproject its ledger.
    expect(panelSrc).toContain('alwaysShowScope?: boolean');
    expect(panelSrc).toContain('{(alwaysShowScope || active.length > 1) && (');
  });

  it('the inline edit form shows the live covered-employee count (the "before you save it" number)', () => {
    const seg = entitlementSegment();
    // The Edit button seeds the shared count; the edit form's scope selects recompute it via recountEditScope;
    // the same entitledEmployeesCount paragraph renders. Reuses the add form's count state (one form open at a
    // time) — no second store, no new locale key.
    expect(panelSrc).toContain('const recountEditScope =');
    expect(seg).toContain('onChange={(e) => recountEditScope(e.currentTarget.form)}');
    expect(seg).toContain("t('entitledEmployeesCount', { count: entitledCount })");
  });
});

describe('Service Based Entitlements — i18n in all six locales', () => {
  it('carries the new company-picker + table strings (en pins the wording)', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8')).admin.leave;
    expect(en.serviceCompanyLabel).toBe('Company');
    const keys = [
      'serviceCompanyLabel',
      'serviceSelectCompanyPlaceholder',
      'serviceSelectCompanyEmpty',
      'serviceNoGrades',
      'serviceNonConformingNote',
      'serviceTableNote',
      'serviceUnder2Aria',
      'serviceMidAria',
      'serviceOverAria',
      'schemeEntitlementsTitle',
    ];
    for (const loc of LOCALES) {
      const leave = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'))?.admin?.leave ?? {};
      for (const key of keys) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
