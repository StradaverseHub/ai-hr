/**
 * f1bbc572 — "Criteria = Global" must mean visible to EVERY company, on the System Labels screen and in
 * every picker that offers a label per company.
 *
 * THE DEFECT. Settings → System Labels narrowed its four catalogues with
 * `rows.filter((r) => scopedIdSet.has(r.companyId))` — the row's ORIGIN company, the company the label
 * happened to be added from, and never `is_global`. A Global label therefore behaved like a company label
 * belonging to whichever company created it. Measured on the live tenant before the fix: 59 Global labels
 * (21 department / 27 position / 5 cost centre / 6 business unit) created under SIX different companies,
 * in a tenant with TWELVE — so no company saw the whole Global set, and the list changed shape depending
 * on which company the admin was scoped to.
 *
 * WHAT THIS SUITE PINS.
 *   1. The rule itself (lib/system-label-scope.ts) over REAL rows read back through the System Labels
 *      page's own reads, for all four kinds: a global row created under company A is in scope for a scope
 *      containing only company B; an A-specific row is not; and a single-company scope returns exactly
 *      (that company's rows ∪ all global rows).
 *   2. `globalUsable = false` still excludes globals — the Shared System Labels opt-out that
 *      `labelUsableByCompany` applies server-side, which the delegation coverage picker mirrors so it
 *      never offers an option its own save would refuse.
 *   3. Source pins on the four surfaces that narrow a loaded catalogue to a company, so a one-line revert
 *      to origin-only cannot pass this suite (the precedent is the page-source pins in
 *      test/org-label-filtering.test.ts).
 *
 * job_grade is deliberately absent: it is tenant-global master data with no company_id, no is_global and
 * no assignment row (components/system-labels-grid.tsx), so it never passes through this rule at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { type SessionContext } from '../db/client';
import {
  createBusinessUnit,
  createCostCenter,
  createDepartment,
  createPosition,
  listBusinessUnitsForLabels,
  listCostCentersForLabels,
  listDepartmentsForLabels,
  listPositionsForLabels,
} from '../core/admin';
import { setLabelGlobal } from '../core/system-labels';
import { labelInCompanyScope, labelsInCompanyScope } from '../lib/system-label-scope';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

/** A second company in the same tenant — the company that must see company A's Global labels. */
async function secondCompany(): Promise<string> {
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Global Scope Co B Sdn Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
  return co.id;
}

/** A company-scoped hr_admin, as the System Labels page sees one: reads are tenant-wide, and the page's
 *  own `inScope` is what narrows them to the admin's companies. */
async function adminFor(companyId: string): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

/** The two fields the rule reads, which is all these tests need off a row (each list returns a wider,
 *  kind-specific shape — narrowing here keeps the four kinds in one table). */
type LabelRow = { id: string; companyId: string; isGlobal: boolean };

/** Cost centres and business units carry a UNIQUE code, so the fixtures mint their own rather than
 *  deriving one from the name (two fixtures whose names share a prefix would otherwise collide). */
let codeSeq = 0;
const nextCode = () => `GS${++codeSeq}`;

/** The four kinds the System Labels screen maintains, each with its create + the page's own read. */
const KINDS: {
  kind: string;
  create: (a: SessionContext, companyId: string, n: string) => Promise<string>;
  list: (a: SessionContext) => Promise<LabelRow[]>;
}[] = [
  {
    kind: 'department',
    create: async (a, companyId, n) => (await createDepartment(a, { companyId, name: n })).id,
    list: (a) => listDepartmentsForLabels(a),
  },
  {
    kind: 'position',
    create: async (a, companyId, n) => (await createPosition(a, { companyId, title: n })).id,
    list: (a) => listPositionsForLabels(a),
  },
  {
    kind: 'cost_center',
    create: async (a, companyId, n) => (await createCostCenter(a, { companyId, code: nextCode(), name: n })).id,
    list: (a) => listCostCentersForLabels(a),
  },
  {
    kind: 'business_unit',
    create: async (a, companyId, n) => (await createBusinessUnit(a, { companyId, code: nextCode(), name: n })).id,
    list: (a) => listBusinessUnitsForLabels(a),
  },
];

describe('f1bbc572 — a Global System Label is in scope for every company', () => {
  for (const K of KINDS) {
    it(`${K.kind}: a Global row created under company A is returned for a scope of company B only; an A-specific row is not`, async () => {
      const a = adminCtx(b); // group admin — passes the is_global trigger gate
      const coB = await secondCompany();

      const globalId = await K.create(a, b.companyId, `GlobalOne${K.kind}`);
      await setLabelGlobal(a, { kind: K.kind, labelId: globalId, isGlobal: true });
      const aOnlyId = await K.create(a, b.companyId, `AOnly${K.kind}`);
      const bOwnId = await K.create(a, coB, `BOwn${K.kind}`);

      // Read exactly as the page does — tenant-wide, through a company-B-scoped admin — then apply the
      // page's own narrowing for a scope that contains company B and nothing else.
      const rows = await K.list(await adminFor(coB));
      const seen = labelsInCompanyScope(rows, new Set([coB])).map((r) => r.id);

      expect(seen).toContain(globalId); // Global: created under A, visible to B.
      expect(seen).toContain(bOwnId); // B's own row: unchanged.
      expect(seen).not.toContain(aOnlyId); // company-specific A row: still hidden from B.
    });

    it(`${K.kind}: a single-company scope returns that company's rows plus all Global rows`, async () => {
      const a = adminCtx(b);
      const coB = await secondCompany();

      await setLabelGlobal(a, {
        kind: K.kind,
        labelId: await K.create(a, b.companyId, `GlobalFromA${K.kind}`),
        isGlobal: true,
      });
      await setLabelGlobal(a, {
        kind: K.kind,
        labelId: await K.create(a, coB, `GlobalFromB${K.kind}`),
        isGlobal: true,
      });
      await K.create(a, b.companyId, `PrivateA${K.kind}`);
      await K.create(a, coB, `PrivateB${K.kind}`);

      const rows = await K.list(await adminFor(coB));
      // The expectation is built from two INDEPENDENT facts — the company's own rows, and every global
      // row of the kind — so it cannot restate the implementation's single-pass predicate.
      const expected = new Set([
        ...rows.filter((r) => r.companyId === coB).map((r) => r.id),
        ...rows.filter((r) => r.isGlobal).map((r) => r.id),
      ]);
      const got = new Set(labelsInCompanyScope(rows, new Set([coB])).map((r) => r.id));

      expect(got).toEqual(expected);
      // Non-trivial: the set really does span both companies, and really does leave A's private row out.
      expect(rows.some((r) => r.isGlobal && r.companyId === b.companyId)).toBe(true);
      expect(got.size).toBeGreaterThan(rows.filter((r) => r.companyId === coB).length);
      expect(got.size).toBeLessThan(rows.length);
    });
  }

  it('the Shared System Labels opt-out still wins where the server gates on it (globalUsable = false)', async () => {
    const globalRow = { companyId: 'company-a', isGlobal: true };
    const ownRow = { companyId: 'company-b', isGlobal: false };
    const scope = new Set(['company-b']);
    // Flag ON (the default for a plain list filter): the global row is in scope.
    expect(labelInCompanyScope(globalRow, scope)).toBe(true);
    // Flag OFF: origin-only, exactly as `labelUsableByCompany` resolves it for an opted-out company —
    // a picker whose save runs through that guard must not offer what the save would refuse.
    expect(labelInCompanyScope(globalRow, scope, false)).toBe(false);
    expect(labelInCompanyScope(ownRow, scope, false)).toBe(true);
  });
});

describe('f1bbc572 — every surface that narrows a label catalogue to a company reads the one rule', () => {
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it('the System Labels page narrows through labelsInCompanyScope, not through the origin company alone', () => {
    const s = src('app/admin/settings/system-labels/page.tsx');
    expect(s).toContain("from '@/lib/system-label-scope'");
    expect(s).toContain('labelsInCompanyScope(rows, scopedIdSet)');
    // The exact shape of the defect, which must never come back.
    expect(s).not.toContain('rows.filter((r) => scopedIdSet.has(r.companyId))');
  });

  it('the swept pickers narrow through the same rule', () => {
    // Payroll → Process, step 2 filter catalogs (all four kinds).
    const wizard = src('app/payroll/process/wizard.tsx');
    expect(wizard).toContain('labelsInCompanyScope(departments, companySet)');
    expect(wizard).toContain('labelsInCompanyScope(businessUnits, companySet)');
    expect(wizard).toContain('labelsInCompanyScope(positions, companySet)');
    expect(wizard).toContain('labelsInCompanyScope(costCenters, companySet)');
    expect(wizard).not.toContain('departments.filter((d) => companySet.has(d.companyId))');

    // Attendance → Recompute, the department filter for the chosen company.
    const recompute = src('app/attendance/recompute/recompute-client.tsx');
    expect(recompute).toContain('labelsInCompanyScope(departments, new Set([companyId]))');
    expect(recompute).not.toContain('departments.filter((d) => d.companyId === companyId)');

    // Delegations → coverage picker (flag-gated, because its save runs through labelUsableByCompany).
    const picker = src('components/delegation-org-scope-picker.tsx');
    expect(picker).toContain('labelsInCompanyScope(masters.businessUnits, scope, companyShared)');
    expect(picker).toContain('labelInCompanyScope(d, scope, companyShared)');
    expect(picker).not.toContain('masters.businessUnits.filter((b) => b.companyId === companyId)');
  });

  it('the four label reads carry is_global, so a client-side narrowing can see it', () => {
    expect(src('core/read.ts')).toContain('isGlobal: department.isGlobal,');
    const admin = src('core/admin.ts');
    expect(admin).toContain('isGlobal: position.isGlobal,');
    expect(admin).toContain('isGlobal: costCenter.isGlobal,');
    expect(admin).toContain('isGlobal: businessUnit.isGlobal,');
  });
});
