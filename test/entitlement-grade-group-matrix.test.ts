/**
 * a03eff24 — Service-Based Entitlement configuration is a GRADE GROUP MATRIX.
 *
 * The per-leave-type benefit-scheme entitlement table used to be a flat list: one row per scheme, the
 * company name reprinted on every single row, and three columns hardcoded to the first row's thresholds.
 * The reporter's complaint was the repetition ("the system should automatically group the same
 * company/benefit scheme instead of repeating the company name for every row") and the row-per-combination
 * setup. It is now a matrix — company down the side (printed once per company block), the scheme's grade
 * group × employment type as the row, service tenure across the top, days typed straight into the cells.
 *
 * That reshaping is possible because the data ALREADY has this shape: a benefit_scheme is
 * (company, employment_type, grade_group) with a partial-unique index on exactly that triple, and its days
 * live in scheme_leave_entitlement.serviceBands. So the matrix is a second VIEW of the same rows, never a
 * second store — the constraint the plan is explicit about, because a parallel entitlement store would put
 * the r71/r72 balance-correctness work at risk.
 *
 * Two things this pins that are easy to regress:
 *
 *  1. TENURE COLUMNS ARE DERIVED. The reporter's example uses < 2 / 2–5 / > 5, and hardcoding those (the
 *     tierUnderFixed / tierMidFixed / tierOverFixed strings the sibling company × grade table uses) would
 *     silently mislabel — and, on save, silently REWRITE — a tenant that configured 3/7 or four brackets.
 *     deriveTenureColumns reads the brackets actually stored; a scheme whose brackets differ from the
 *     matrix's columns is edited through the dialog instead of being flattened into columns it does not
 *     have (the refusal isConformingServiceShape already makes for the company × grade table).
 *
 *  2. A CELL EDIT PRESERVES THE REST OF THE BAND. A ServiceBand may carry carryForwardDays, a carry-forward
 *     expiry month/day and maxBalanceDays alongside `days`. matrixBandsWithDays spreads the stored band and
 *     replaces only `days`, so typing in a cell cannot quietly clear carry-forward configuration.
 *
 * The pure helpers are unit-tested for real; the rendering contract (merged company cell, grade-group row
 * identity, the shared upsert FormData) is a static source guard — the documented convention for this
 * DOM-runner-less feature area (see benefit-scheme-company-labelled-entitlements.test.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bandShapeKey, deriveTenureColumns, matrixBandsWithDays } from '../components/benefit-scheme-config';
import type { ServiceBand } from '../core/leave-compute';

const here = dirname(fileURLToPath(import.meta.url));
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const STANDARD: ServiceBand[] = [
  { fromYears: 0, toYears: 2, days: 12 },
  { fromYears: 2, toYears: 5, days: 14 },
  { fromYears: 5, toYears: null, days: 16 },
];
const CUSTOM_3_7: ServiceBand[] = [
  { fromYears: 0, toYears: 3, days: 8 },
  { fromYears: 3, toYears: 7, days: 10 },
  { fromYears: 7, toYears: null, days: 12 },
];

/** The per-type matrix section ONLY: its row type, the derivation helpers, the row and the table — stopping
 *  at the banner that starts the sibling company × grade table, so nothing here can pass (or fail) on that
 *  table's code by accident. */
const SIBLING_BANNER = '// ─────────────────── Service-Based Entitlements (company × grade) ───────────────────';
function matrixSection(): string {
  const start = schemeSrc.indexOf('export type LeaveTypeSchemeEntitlement');
  expect(start, 'LeaveTypeSchemeEntitlement must exist').toBeGreaterThan(-1);
  const end = schemeSrc.indexOf(SIBLING_BANNER, start);
  expect(end, 'the company × grade banner must still delimit the matrix section').toBeGreaterThan(start);
  return schemeSrc.slice(start, end);
}

describe('a03eff24 · the tenure columns are derived from what is stored, never hardcoded', () => {
  it('a tenant on the standard 0/2/5 brackets gets three columns matching them', () => {
    const { columns, shapeKey } = deriveTenureColumns([{ serviceBands: STANDARD }]);
    expect(columns).toEqual([
      { fromYears: 0, toYears: 2 },
      { fromYears: 2, toYears: 5 },
      { fromYears: 5, toYears: null },
    ]);
    expect(shapeKey).toBe(bandShapeKey(STANDARD));
  });

  it('a tenant on non-standard 3/7 brackets gets ITS OWN columns — the example 2/5 is not imposed', () => {
    const { columns } = deriveTenureColumns([{ serviceBands: CUSTOM_3_7 }]);
    expect(columns).toEqual([
      { fromYears: 0, toYears: 3 },
      { fromYears: 3, toYears: 7 },
      { fromYears: 7, toYears: null },
    ]);
  });

  it('an arbitrary bracket count is honoured — the matrix is not fixed at three columns', () => {
    const four: ServiceBand[] = [
      { fromYears: 0, toYears: 1, days: 8 },
      { fromYears: 1, toYears: 3, days: 10 },
      { fromYears: 3, toYears: 10, days: 14 },
      { fromYears: 10, toYears: null, days: 20 },
    ];
    expect(deriveTenureColumns([{ serviceBands: four }]).columns).toHaveLength(4);
  });

  it('mixed brackets: the columns follow the MAJORITY shape and the odd row is left out of the grid', () => {
    // Two schemes on 3/7, one legacy scheme on 0/2/5 — the grid must not relabel the majority's days.
    const ents = [
      { serviceBands: CUSTOM_3_7 },
      { serviceBands: STANDARD },
      { serviceBands: CUSTOM_3_7 },
    ];
    const { columns, shapeKey } = deriveTenureColumns(ents);
    expect(columns[0]).toEqual({ fromYears: 0, toYears: 3 });
    expect(shapeKey).toBe(bandShapeKey(CUSTOM_3_7));
    // …and the shape key is what the row uses to decide inline-editable vs dialog-only, so the 0/2/5 row
    // is excluded from the grid rather than having its 2 and 5 rendered under "under 3" and "3 to 7".
    expect(bandShapeKey(STANDARD)).not.toBe(shapeKey);
  });

  it('ties are broken deterministically by first appearance (rows arrive in scheme-name order)', () => {
    expect(deriveTenureColumns([{ serviceBands: CUSTOM_3_7 }, { serviceBands: STANDARD }]).shapeKey).toBe(
      bandShapeKey(CUSTOM_3_7),
    );
    expect(deriveTenureColumns([{ serviceBands: STANDARD }, { serviceBands: CUSTOM_3_7 }]).shapeKey).toBe(
      bandShapeKey(STANDARD),
    );
  });

  it('rows with no usable bands fall back to the 0/2/5 template the add form writes — never zero columns', () => {
    const { columns } = deriveTenureColumns([{ serviceBands: [] }, { serviceBands: [] }]);
    expect(columns).toHaveLength(3);
    expect(columns[2]).toEqual({ fromYears: 5, toYears: null });
  });

  it('band shape keys ignore days — the same brackets granting different days share one column set', () => {
    const generous = STANDARD.map((b) => ({ ...b, days: b.days * 2 }));
    expect(bandShapeKey(generous)).toBe(bandShapeKey(STANDARD));
  });
});

describe('a03eff24 · a cell edit round-trips the stored band, it does not rebuild it', () => {
  it('unchanged cells submit exactly what was stored', () => {
    expect(matrixBandsWithDays(STANDARD, ['12', '14', '16'])).toEqual(STANDARD);
  });

  it('editing one cell changes only that band’s days, at the row’s OWN non-standard boundaries', () => {
    expect(matrixBandsWithDays(CUSTOM_3_7, ['8', '11', '12'])).toEqual([
      { fromYears: 0, toYears: 3, days: 8 },
      { fromYears: 3, toYears: 7, days: 11 },
      { fromYears: 7, toYears: null, days: 12 },
    ]);
  });

  it('carry-forward and max-balance settings on a band survive a cell edit', () => {
    const rich: ServiceBand[] = [
      { fromYears: 0, toYears: 2, days: 12, carryForwardDays: 3, maxBalanceDays: 20 },
      { fromYears: 2, toYears: null, days: 16, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 },
    ];
    const out = matrixBandsWithDays(rich, ['13', '16']);
    expect(out[0]).toEqual({ fromYears: 0, toYears: 2, days: 13, carryForwardDays: 3, maxBalanceDays: 20 });
    expect(out[1]).toEqual({
      fromYears: 2,
      toYears: null,
      days: 16,
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
    });
  });

  it('a blank cell reads as 0 rather than NaN, so a malformed band never reaches validateBands', () => {
    const out = matrixBandsWithDays(STANDARD, ['', '14', '16']);
    expect(out[0].days).toBe(0);
    expect(Number.isNaN(out[0].days)).toBe(false);
  });
});

describe('a03eff24 · the matrix renders company once, grade group per row', () => {
  it('rows are grouped into company blocks keyed on the row’s companyName', () => {
    const body = matrixSection();
    expect(body).toContain('const companyBlocks = useMemo(');
    expect(body).toMatch(/const key = e\.companyName \?\? '';/);
  });

  it('the company name prints on the FIRST row of its block only — that blank IS the merge', () => {
    const body = matrixSection();
    expect(body).toContain('companyLabel={i === 0 ? block.companyName : null}');
    // Anti-vacuity: the row must actually render the prop, and render nothing when it is null.
    expect(body).toContain('{companyLabel ?? \'\'}');
  });

  it('the row identity is the scheme’s grade group + employment type, with the scheme name kept beneath', () => {
    const body = matrixSection();
    expect(body).toMatch(/gradeGroupLabel=\{`\$\{e\.gradeGroupName \?\? t\('perTypeAllGrades'\)\} \(\$\{empTypeLabel\(e\.employmentType\)\}\)`\}/);
    expect(body).toContain('{ent.schemeName}');
    // The combined-limit note the flat table carried is not lost in the restructure.
    expect(body).toContain("t('perTypeSharedPool'");
  });

  it('the headers are the real Company / Grade group labels and the DERIVED tenure columns', () => {
    const body = matrixSection();
    expect(body).toContain("t('colCompany')");
    expect(body).toContain("t('colGradeGroup')");
    expect(body).toContain('{tenureColumnLabel(c, t)}');
    // The fixed "Under 2 Years / 2–5 Years / More Than 5 Years" strings belong to the sibling company ×
    // grade table and must NOT leak in here — they are the exact hardcoding this item removes.
    expect(body).not.toContain('tierUnderFixed');
    expect(body).not.toContain('tierMidFixed');
    expect(body).not.toContain('tierOverFixed');
  });

  it('a scheme whose brackets differ from the columns is dialog-edited, never flattened into the grid', () => {
    const body = matrixSection();
    expect(body).toMatch(/editableInline=\{[\s\S]*bandShapeKey\(e\.serviceBands\) === shapeKey[\s\S]*\}/);
    expect(body).toMatch(/if \(!editableInline\) \{/);
    expect(body).toContain("t('perTypeOtherTenure')");
    // That branch renders the row's OWN bracket labels beside its own days.
    expect(body).toContain('{stored.map((b, i) => (');
  });
});

describe('a03eff24 · same store, same writer — no parallel entitlement source', () => {
  it('inline cells post the SAME upsertSchemeEntitlement FormData contract as the dialog', () => {
    const body = matrixSection();
    expect(body).toContain('name="benefitSchemeId"');
    expect(body).toContain('name="leaveTypeId"');
    expect(body).toContain('name="serviceBands"');
    expect(body).toContain('value={JSON.stringify(bands)}');
    // The dialog is still mounted for the shapes the grid cannot lay out — one writer, two entry points.
    expect(body).toContain('<EntitlementEditDialog');
  });

  it('an untouched row cannot be written — Save stays disabled until a figure changes', () => {
    // Load-bearing: upsertSchemeEntitlementAction fires recalcSchemeCohort, so a spurious submit would
    // reproject every covered employee for nothing.
    const body = matrixSection();
    expect(body).toMatch(/const dirty = days\.some\(/);
    expect(body).toContain('disabled={!dirty}');
  });

  it('no new query: the page derives the grade group + employment type from rows it already loads', () => {
    expect(pageSrc).toContain('gradeGroupName: schemeAxesById.get(e.benefitSchemeId)?.gradeGroupName ?? null,');
    expect(pageSrc).toContain("employmentType: schemeAxesById.get(e.benefitSchemeId)?.employmentType ?? 'full_time',");
    expect(pageSrc).toMatch(/const schemeAxesById = new Map\(\s*benefitSchemes\.map\(/);
    expect(pageSrc.match(/listBenefitSchemes\(s\)/g)?.length, 'schemes still loaded exactly once').toBe(1);
  });

  it('no leave_policy write path was touched — the company × grade table keeps its own writer', () => {
    // ADR-0066 / r71: the accrual engines and the "did an administrator configure days for this type"
    // discriminator are untouched by a presentation restructure. The sibling table still owns
    // saveServiceEntitlement; the matrix must not have grown a second call into it.
    expect(matrixSection()).not.toContain('saveServiceEntitlement');
    expect(schemeSrc).toContain('export function ServiceEntitlementTable');
  });
});

describe('a03eff24 · i18n in all six locales', () => {
  const NEW_KEYS = ['tierAll', 'perTypeAllGrades', 'perTypeOtherTenure', 'perTypeDaysAria'] as const;

  it('every new string exists and is non-empty in all six locales', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const bs = msgs?.admin?.benefitScheme ?? {};
      for (const key of NEW_KEYS) {
        expect(typeof bs[key], `${loc}.admin.benefitScheme.${key}`).toBe('string');
        expect((bs[key] as string).trim().length, `${loc}.admin.benefitScheme.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('the parameterised strings keep their ICU placeholders in every locale', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const aria = msgs.admin.benefitScheme.perTypeDaysAria as string;
      expect(aria, `${loc} perTypeDaysAria {scheme}`).toContain('{scheme}');
      expect(aria, `${loc} perTypeDaysAria {band}`).toContain('{band}');
    }
  });
});
