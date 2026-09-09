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
  bulkSaveLabels,
  createBusinessUnit,
  createCostCenter,
  createDepartment,
  createPosition,
  isDatabaseError,
  labelFailureCode,
  LabelBulkError,
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
      const seen = labelsInCompanyScope(rows, new Set([coB]), true).map((r) => r.id);

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
      const got = new Set(labelsInCompanyScope(rows, new Set([coB]), true).map((r) => r.id));

      expect(got).toEqual(expected);
      // Non-trivial: the set really does span both companies, and really does leave A's private row out.
      expect(rows.some((r) => r.isGlobal && r.companyId === b.companyId)).toBe(true);
      expect(got.size).toBeGreaterThan(rows.filter((r) => r.companyId === coB).length);
      expect(got.size).toBeLessThan(rows.length);
    });
  }

  // `globalUsable` carries no default (round 2): a caller that forgets it does not compile, which is the
  // only reliable guard against a surface silently re-acquiring "true" and drifting from the resolver.
  it('the Shared System Labels opt-out still wins where the server gates on it (globalUsable = false)', async () => {
    const globalRow = { companyId: 'company-a', isGlobal: true };
    const ownRow = { companyId: 'company-b', isGlobal: false };
    const scope = new Set(['company-b']);
    // Flag ON — the company shares labels, so the global row is in scope.
    expect(labelInCompanyScope(globalRow, scope, true)).toBe(true);
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
    // Flag-gated, because the SERVER resolver's global branch is: an opted-out company must not be
    // shown a label its own pickers would refuse (the 'visible in the list, unavailable in the picker'
    // state the plan calls worse than the defect).
    expect(s).toContain('labelsInCompanyScope(rows, scopedIdSet, globalUsable)');
    expect(s).toContain('const globalUsable = scopedCompanies.some((c) => c.sharedSystemLabels);');
    // The exact shape of the defect, which must never come back.
    expect(s).not.toContain('rows.filter((r) => scopedIdSet.has(r.companyId))');
  });

  it('the swept pickers narrow through the same rule', () => {
    // Payroll → Process, step 2 filter catalogs (all four kinds).
    const wizard = src('app/payroll/process/wizard.tsx');
    expect(wizard).toContain('labelsInCompanyScope(departments, companySet, globalUsable)');
    expect(wizard).toContain('labelsInCompanyScope(businessUnits, companySet, globalUsable)');
    expect(wizard).toContain('labelsInCompanyScope(positions, companySet, globalUsable)');
    expect(wizard).toContain('labelsInCompanyScope(costCenters, companySet, globalUsable)');
    expect(wizard).toContain('c.sharedSystemLabels');
    expect(wizard).not.toContain('departments.filter((d) => companySet.has(d.companyId))');

    // Attendance → Recompute, the department filter for the chosen company.
    const recompute = src('app/attendance/recompute/recompute-client.tsx');
    expect(recompute).toContain('labelsInCompanyScope(departments, new Set([companyId]), companyShared)');
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

/**
 * f1bbc572 ROUND 2 — WHAT HAPPENS WHEN THE ADMIN EDITS A ROW THEY CAN SEE BUT NOT WRITE.
 *
 * Making a Global label visible to every company handed a COMPANY-SCOPED hr_admin rows whose origin
 * company they do not administer. RLS refuses that write —
 * `CREATE POLICY tenant_isolation ON department … WITH CHECK (… app.is_admin_for(company_id))`
 * (0016_company_scoped_authz.sql) — and the Save is atomic, so the refusal took every OTHER row edited
 * in the same Save down with it while the banner printed the driver's own text:
 *
 *   Failed query: update "department" set "name" = $1, "label" = $2, "description" = $3
 *   where "department"."id" = $4  params: RenamedByB,,edited by B,b22d7f28-…
 *
 * — because `isPrivilegeError` read `e.code`, which drizzle leaves undefined (the SQLSTATE is on
 * `.cause`), so every branch of the catch missed and the raw error escaped through `else throw e`.
 *
 * The grid now renders those rows READ-ONLY (test/system-labels-readonly.dom.test.tsx). These cases pin
 * the server half, which is what stands between a stale page — or a grant revoked mid-session — and SQL
 * on an admin's screen.
 */
describe('f1bbc572 — a refused label write is named, not dumped', () => {
  it('reads the SQLSTATE off .cause, where drizzle actually puts it', () => {
    // The exact shape captured from the probe: drizzle's own Error, the PostgresError on `.cause`.
    const wrapped = Object.assign(
      new Error('Failed query: update "department" set "name" = $1 …\nparams: RenamedByB,,edited by B'),
      { cause: Object.assign(new Error('new row violates row-level security policy for table "department"'), { code: '42501' }) },
    );
    expect((wrapped as { code?: string }).code).toBeUndefined(); // the reason the old test-by-e.code failed
    expect(labelFailureCode(wrapped)).toBe('notAdminForCompany');
    expect(isDatabaseError(wrapped)).toBe(true);

    // The is_global trigger raises the SAME SQLSTATE and must stay a DIFFERENT sentence.
    const trigger = Object.assign(new Error('Failed query: update "department" …'), {
      cause: Object.assign(new Error('Only a group admin may make a system label global (is_global)'), { code: '42501' }),
    });
    expect(labelFailureCode(trigger)).toBe('globalGroupAdminOnly');

    // An application error is not the database talking: its own message is the one written for a reader.
    expect(labelFailureCode(new Error('Cannot unassign: a company still uses this label.'))).toBeUndefined();
    expect(isDatabaseError(new Error('Cannot unassign: a company still uses this label.'))).toBe(false);
  });

  it('a company-B admin editing company A’s Global department gets a translatable refusal, not SQL — and B’s own edit is rolled back', async () => {
    const a = adminCtx(b); // group admin — creates the fixtures and passes the is_global trigger
    const coB = await secondCompany();
    const globalId = (await createDepartment(a, { companyId: b.companyId, name: 'GlobalFromA' })).id;
    await setLabelGlobal(a, { kind: 'department', labelId: globalId, isGlobal: true });
    const bOwnId = (await createDepartment(a, { companyId: coB, name: 'BOwnDept' })).id;

    const bAdmin = await adminFor(coB);
    // The row is VISIBLE to B — that is f1bbc572 — so B can reach it and try to rename it.
    const visible = labelsInCompanyScope(await listDepartmentsForLabels(bAdmin), new Set([coB]), true);
    expect(visible.map((r) => r.id)).toContain(globalId);

    const thrown = await bulkSaveLabels(bAdmin, 'department', {
      creates: [],
      updates: [
        { key: 'row-b', id: bOwnId, name: 'BRenamed' }, // B's own row, edited in the SAME Save
        { key: 'row-a', id: globalId, name: 'RenamedByB' },
      ],
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LabelBulkError);
    const rowErrors = (thrown as LabelBulkError).rowErrors;
    expect(rowErrors).toHaveLength(1);
    expect(rowErrors[0].key).toBe('row-a');
    expect(rowErrors[0].code).toBe('notAdminForCompany');

    // NOTHING the driver said may travel with it: not the statement, not the parameter values.
    const surfaced = [(thrown as Error).message, ...rowErrors.map((r) => r.message)].join(' | ');
    expect(surfaced).not.toMatch(/Failed query/i);
    expect(surfaced).not.toMatch(/update "department"/i);
    expect(surfaced).not.toMatch(/RenamedByB/);

    // Atomic: B's own rename went with it, and A's row is untouched.
    const after = await listDepartmentsForLabels(a);
    expect(after.find((r) => r.id === bOwnId)?.name).toBe('BOwnDept');
    expect(after.find((r) => r.id === globalId)?.name).toBe('GlobalFromA');
  });

  /**
   * THE SECOND ERROR THAT USED TO BURY THE FIRST. `withTenant` opens ONE transaction with no savepoints,
   * so the refused statement ABORTS it: with the refused row FIRST, the next row's UPDATE raised 25P02
   * ("current transaction is aborted"), which is neither a unique nor a privilege violation — it escaped
   * through `else throw e` as a raw driver string with nothing highlighted, hiding the refusal that
   * actually caused it. bulkSaveLabels now stops at the first DATABASE refusal, which the atomic save
   * makes free: everything rolls back either way.
   */
  it('a refusal on the FIRST row is reported as itself, not as the aborted-transaction error behind it', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const globalId = (await createDepartment(a, { companyId: b.companyId, name: 'GlobalFirst' })).id;
    await setLabelGlobal(a, { kind: 'department', labelId: globalId, isGlobal: true });
    const bOwnId = (await createDepartment(a, { companyId: coB, name: 'BOwnFirst' })).id;

    const thrown = await bulkSaveLabels(await adminFor(coB), 'department', {
      creates: [],
      updates: [
        { key: 'row-a', id: globalId, name: 'RenamedByB' }, // refused — and it aborts the transaction
        { key: 'row-b', id: bOwnId, name: 'BRenamed' }, // would raise 25P02 if the loop carried on
      ],
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LabelBulkError);
    const rowErrors = (thrown as LabelBulkError).rowErrors;
    expect(rowErrors).toEqual([expect.objectContaining({ key: 'row-a', code: 'notAdminForCompany' })]);
    const surfaced = [(thrown as Error).message, ...rowErrors.map((r) => r.message)].join(' | ');
    expect(surfaced).not.toMatch(/current transaction is aborted/i);
    expect(surfaced).not.toMatch(/Failed query/i);

    // Still atomic: neither row moved.
    const after = await listDepartmentsForLabels(a);
    expect(after.find((r) => r.id === bOwnId)?.name).toBe('BOwnFirst');
    expect(after.find((r) => r.id === globalId)?.name).toBe('GlobalFirst');
  });

  it('a company-B admin editing its OWN row still saves — the refusal is about the row, not the admin', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const bOwnId = (await createDepartment(a, { companyId: coB, name: 'BOwnDept2' })).id;

    const bAdmin = await adminFor(coB);
    const res = await bulkSaveLabels(bAdmin, 'department', {
      creates: [],
      updates: [{ key: 'row-b', id: bOwnId, name: 'BRenamed2' }],
    });

    expect(res.updated).toBe(1);
    expect((await listDepartmentsForLabels(a)).find((r) => r.id === bOwnId)?.name).toBe('BRenamed2');
  });
});
