/**
 * Service Based Entitlements — the UI contract.
 *
 * Static source guard (the DOM-runner-less convention for this component area, see
 * leave-entitlement-substeps.test.ts / benefit-scheme-scoped-step.test.ts). The pure helpers are unit-tested
 * below for real; here we pin the structural contract.
 *
 * 9816a5ad replaced the middle column: it was the JOB GRADE, writing grade-scoped leave_policy rows through
 * saveServiceEntitlement, and it is now the BENEFIT SCHEME, writing scheme_leave_entitlement through the
 * same upsert the Benefit Schemes surface posts. The assertions moved with it rather than being dropped —
 * the requirements they encode are unchanged and, if anything, stricter:
 *   - the picker lists COMPANY names only, with an empty state until one is chosen;
 *   - a row Save is disabled until the row is DIRTY (an untouched row is never written ⇒ no spurious
 *     cohort recalc);
 *   - a scheme whose service brackets differ from the table's columns is never flattened into them;
 *   - and the new one this item turns on: there is exactly ONE entitlement store behind the screen. The
 *     rows post the scheme upsert; nothing here writes leave_policy any more.
 *
 * The reconciliation the plan promised is asserted too: where the retained grade-level policies disagree
 * with a scheme's figures, the row REPORTS the disagreement. It must never silently pick a winner — that
 * would change real leave balances on the strength of a guess.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blankBandsForColumns,
  gradeLevelServiceDays,
  sampleYearsForColumn,
} from '../components/benefit-scheme-config';
import type { GradePolicyRow } from '../core/leave-compute';

const here = dirname(fileURLToPath(import.meta.url));
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The whole Service-Based Entitlements section (its helpers + ServiceEntitlementTable), up to the next
 *  unrelated top-level function. */
function tableBody(): string {
  const start = schemeSrc.indexOf('export type ServicePolicyRow');
  expect(start, 'the Service-Based Entitlements section must exist').toBeGreaterThan(-1);
  expect(
    schemeSrc.indexOf('export function ServiceEntitlementTable'),
    'ServiceEntitlementTable must be exported',
  ).toBeGreaterThan(start);
  const end = schemeSrc.indexOf('function EntitlementForm', start);
  expect(end, 'section body must be delimited').toBeGreaterThan(start);
  return schemeSrc.slice(start, end);
}

describe('Service Based Entitlements — company picker, benefit-scheme rows', () => {
  it('the picker still lists COMPANY names only, with an empty state before one is chosen', () => {
    const body = tableBody();
    expect(body).toContain("t('serviceCompanyLabel')");
    expect(body).toContain('companies.map((c) => (');
    expect(body).toContain('{c.name}');
    // Empty state until a company is chosen (no default-to-first-company).
    expect(body).toContain("t('serviceSelectCompanyEmpty')");
    expect(body).toMatch(/const \[companyId, setCompanyId\] = useState\(''\)/);
  });

  it('the ROWS are the picked company’s ACTIVE benefit schemes, not job grades', () => {
    const body = tableBody();
    expect(body).toMatch(/schemes\s*\n?\s*\.filter\(\(s\) => s\.companyId === companyId && s\.status === 'active'\)/);
    // The row identity is the scheme's grade group × employment type, the scheme name beneath it — the same
    // vocabulary the Benefit Schemes matrix uses, so the two surfaces name a scheme identically.
    // r76 48224d12 — that vocabulary is now ONE shared rule (lib/benefit-scheme-label) rather than an
    // inline template repeated per call site, which is what let the employment type be stated twice.
    expect(body).toMatch(
      /gradeGroupLabel=\{benefitSchemeDisplayName\(scheme, \{\s*employmentTypeLabel: empTypeLabel\(scheme\.employmentType\),\s*allGradesLabel: tb\('perTypeAllGrades'\),\s*\}\)\}/,
    );
    // No grade rows, and no grade-scoped write, survive anywhere in this file.
    expect(body.includes('grades.map((g) =>')).toBe(false);
    expect(schemeSrc.includes('saveServiceEntitlement')).toBe(false);
  });

  it('a scheme with no entitlement for this leave type is still listed, and says so', () => {
    const body = tableBody();
    expect(body).toContain('id: `unconfigured:${scheme.id}`');
    expect(body).toContain("t('serviceSchemeUnconfigured')");
    // It starts at zero days on the table's own columns, so listing it grants nothing by itself.
    expect(body).toContain('serviceBands: blankBandsForColumns(columns)');
  });

  it('rows post the SAME scheme-entitlement contract as the Benefit Schemes matrix — one store, one writer', () => {
    const body = tableBody();
    expect(body).toContain('action={upsertEntitlement}');
    // The row component is REUSED (it is the one that posts benefitSchemeId / leaveTypeId / serviceBands),
    // not re-implemented — a second form here would be a second place for the FormData contract to drift.
    expect(body).toContain('<SchemeEntitlementMatrixRow');
    expect(schemeSrc).toContain('name="benefitSchemeId"');
    expect(schemeSrc).toContain('name="serviceBands"');
  });

  it('Save is gated on DIRTY and the columns are derived, never the hardcoded 0/2/5', () => {
    const body = tableBody();
    // The shared row owns the dirty gate; this table must not opt out of it by forking a row.
    expect(schemeSrc).toMatch(/const dirty = days\.some\(/);
    expect(schemeSrc).toContain('disabled={!dirty}');
    expect(body).toContain('deriveTenureColumns(');
    expect(body.includes('tierUnderFixed')).toBe(false);
    expect(body.includes('tierMidFixed')).toBe(false);
    expect(body.includes('tierOverFixed')).toBe(false);
  });

  it('a scheme on its own brackets is dialog-edited, never flattened into the table’s columns', () => {
    const body = tableBody();
    expect(body).toContain("const conforming = ent.serviceBands.length > 0 && bandShapeKey(ent.serviceBands) === shapeKey;");
    expect(body).toContain('editableInline={conforming}');
  });
});

describe('9816a5ad → r76 48224d12 — the disagreement note is WITHDRAWN, the reconciliation is not', () => {
  /**
   * ⚠ Read this before restoring or re-deleting anything here.
   *
   * 48224d12's reporter asked for the amber grade-level line to go, and it is gone. This was the ONLY
   * place in the product that told an administrator that the grade-level entitlement and the scheme
   * entitlement give different numbers — and investigation 9816a5ad is separately asking which of those
   * two actually drives an employee's balance. So the removal is deliberately partial: the SURFACE is
   * withdrawn, the RECONCILIATION is kept whole.
   *
   * What this test now pins is the shape of that compromise, so neither half drifts:
   *   - no screen renders the note, and the string is retired from every locale (the i18n block below);
   *   - the pure helpers that computed it still exist and still behave (the unit tests underneath);
   *   - the table still receives the inputs they need, so putting the note back is an edit to ONE
   *     component, not a re-wiring.
   */
  it('no screen renders the grade-level disagreement any more', () => {
    expect(schemeSrc.includes('serviceGradeDisagreement')).toBe(false);
    // …and it did not simply move: the TABLE no longer calls the sampler (its definition, above the table,
    // is deliberately kept — see the next test).
    const table = schemeSrc.slice(schemeSrc.indexOf('export function ServiceEntitlementTable'));
    expect(table.slice(0, table.indexOf('function EntitlementForm')).includes('gradeLevelServiceDays(')).toBe(false);
  });

  it('the reconciliation survives intact — helpers exported, inputs still delivered', () => {
    const body = tableBody();
    // The pure helpers are the restoration path; deleting them makes the note expensive to reinstate.
    expect(schemeSrc).toContain('export function gradeLevelServiceDays(');
    expect(schemeSrc).toContain('export function sampleYearsForColumn(');
    // The table still takes the two props the note consumed, so restoring it touches one file.
    expect(body).toMatch(/gradeGroups: \{ id: string; gradeIds: string\[\] \}\[\];/);
    expect(body).toMatch(/policies: ServicePolicyRow\[\];/);
    expect(panelSrc).toContain('gradeGroups={gradeGroups}');
    // Reporting only, and still never a write: no path from the grade-level sample into the row's bands.
    const rowStart = schemeSrc.indexOf('function SchemeEntitlementMatrixRow');
    const rowEnd = schemeSrc.indexOf('export function LeaveTypeEntitlementTable');
    expect(schemeSrc.slice(rowStart, rowEnd).includes('gradeLevelServiceDays')).toBe(false);
  });

  it('sampleYearsForColumn lands INSIDE each bracket, including the open-ended one', () => {
    expect(sampleYearsForColumn({ fromYears: 0, toYears: 2 })).toBe(1);
    expect(sampleYearsForColumn({ fromYears: 2, toYears: 5 })).toBe(3.5);
    expect(sampleYearsForColumn({ fromYears: 5, toYears: null })).toBe(6);
    // A tenant on its own brackets is sampled inside ITS brackets, not the example's 1 / 3 / 6.
    expect(sampleYearsForColumn({ fromYears: 3, toYears: 7 })).toBe(5);
  });

  it('gradeLevelServiceDays reads what each grade resolves to today, de-duplicated', () => {
    const columns = [
      { fromYears: 0, toYears: 2 },
      { fromYears: 2, toYears: 5 },
      { fromYears: 5, toYears: null },
    ];
    const rows: GradePolicyRow[] = [
      {
        gradeId: 'g1',
        companyId: 'c1',
        accrual: {
          annualDays: 12,
          serviceBands: [
            { fromYears: 0, toYears: 2, days: 12 },
            { fromYears: 2, toYears: 5, days: 14 },
            { fromYears: 5, toYears: null, days: 16 },
          ],
        },
      },
      { gradeId: 'g2', companyId: 'c1', accrual: { annualDays: 8 } },
    ];
    // Two grades that resolve differently ⇒ two tuples; the flat policy reads the same in every column.
    expect(gradeLevelServiceDays(rows, ['g1', 'g2'], 'c1', columns)).toEqual([
      [12, 14, 16],
      [8, 8, 8],
    ]);
    // Grades that agree collapse to ONE line rather than repeating the same figures per grade.
    expect(gradeLevelServiceDays(rows, ['g2', 'g2'], 'c1', columns)).toEqual([[8, 8, 8]]);
    // A scheme covering no grades has nothing to disagree with.
    expect(gradeLevelServiceDays(rows, [], 'c1', columns)).toEqual([]);
  });

  it('blankBandsForColumns mirrors the columns exactly, at zero days', () => {
    expect(blankBandsForColumns([{ fromYears: 0, toYears: 3 }, { fromYears: 3, toYears: null }])).toEqual([
      { fromYears: 0, toYears: 3, days: 0 },
      { fromYears: 3, toYears: null, days: 0 },
    ]);
  });
});

describe('Service Based Entitlements — wiring', () => {
  it('the panel feeds the table this type, companies, the schemes, grade groups and the shared upsert', () => {
    expect(panelSrc).toContain('<ServiceEntitlementTable');
    expect(panelSrc).toContain('upsertEntitlement={upsertSchemeEntitlementAction}');
    expect(panelSrc).toMatch(/policies\.map\(\s*\(p\): ServicePolicyRow =>/);
    // The page passes arrays it ALREADY prepared for the Benefit Schemes surface — one read, one scheme
    // list, so the two sub-steps cannot show different schemes.
    expect(pageSrc).toContain('benefitSchemes={schemeConfigProps.schemes}');
    expect(pageSrc).toContain('gradeGroups={schemeConfigProps.gradeGroups}');
    expect(pageSrc.match(/listBenefitSchemes\(s\)/g)?.length, 'schemes still loaded exactly once').toBe(1);
  });

  it('the grade-level writer is unmounted but kept — grade policies still resolve for uncovered employees', () => {
    // A grade in no grade group matches no scheme (resolveEffectiveSchemeId is an exact triple match), so
    // the grade-scoped leave_policy rows must keep working. They stay editable on the per-company
    // entitlement timeline in the same sub-step.
    expect(pageSrc.includes('saveServiceEntitlementAction')).toBe(false);
    expect(panelSrc.includes('saveServiceEntitlementAction')).toBe(false);
    const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');
    const adminSrc = readFileSync(resolve(here, '../core/admin.ts'), 'utf8');
    expect(actionsSrc).toContain('export async function saveServiceEntitlementAction');
    expect(adminSrc).toContain('export async function saveServiceEntitlement');
    // bc36c768 — the writer KEEPS its export and its ADR-0066 first-save scope materialisation, and loses
    // ONLY its method write. That is the whole change here, and it is worth pinning both halves: deleting
    // the function would strand core/saveServiceEntitlement and break the short-circuit guard above, while
    // leaving the method write in would make "setLeaveTypeRulesAction is the only path that can write an
    // earning method" false. The write was already a no-op (updateLeavePolicy PRESERVES a stored method
    // when the caller sends none), so removing it changes no behaviour and closes one more door.
    const saveFn = adminSrc.slice(
      adminSrc.indexOf('export async function saveServiceEntitlement'),
      adminSrc.indexOf('export async function deleteLeavePolicy'),
    );
    expect(saveFn).not.toContain('method: currentAcc.method');
  });
});

describe('Service Based Entitlements — i18n in all six locales', () => {
  it('carries the company-picker + scheme-table strings (en pins the wording)', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8')).admin.leave;
    expect(en.serviceCompanyLabel).toBe('Company');
    const keys = [
      'serviceCompanyLabel',
      'serviceSelectCompanyPlaceholder',
      'serviceSelectCompanyEmpty',
      'serviceNoSchemes',
      'serviceSchemeUnconfigured',
      'serviceTableNote',
      'schemeEntitlementsTitle',
    ];
    // The by-grade strings are retired with the by-grade rows — a leftover would be a promise no screen keeps.
    // r76 48224d12 retires `serviceGradeDisagreement` with the note itself, in all six locales.
    const retired = [
      'serviceNoGrades',
      'serviceNonConformingNote',
      'serviceUnder2Aria',
      'serviceMidAria',
      'serviceOverAria',
      'serviceGradeDisagreement',
    ];
    for (const loc of LOCALES) {
      const leave = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'))?.admin?.leave ?? {};
      for (const key of keys) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
      for (const key of retired) {
        expect(leave[key], `${loc}.admin.leave.${key} retired`).toBeUndefined();
      }
    }
  });
});
