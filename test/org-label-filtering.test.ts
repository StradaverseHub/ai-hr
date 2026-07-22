/**
 * Personnel (Admin) — auto-filter organisation label dropdowns by company (feedback 570e3311).
 *
 * Server-side halves of the change:
 *   - transferEmployee now guards department / position / cost-centre CHANGED-ONLY: a newly-supplied
 *     value must be usable by the employment's company under the Shared System Labels resolver
 *     (origin ∪ shared-in ∪ global, flag-gated — labelUsableByCompany) AND not archived; re-supplying
 *     the stored current value (even legacy cross-company data) keeps working.
 *   - setEmploymentAssignment applies the same resolver + archived check to a CHANGED department /
 *     position (the BU check is covered by test/personnel-org-assignment-standardization.test.ts),
 *     and carries an unchanged shared-in value forward even after the sharing flag is flipped OFF —
 *     no silent clear on an unrelated save.
 *   - Page-source pins: the employee detail page scopes its departments load to the employee's own
 *     company and renders pinned-current options for legacy/unshared stored values, so a one-line
 *     revert to the unscoped read cannot pass this suite (precedent: the hydration-parity suite in
 *     test/hire-form-filter.test.ts reads page source the same way).
 *
 * Conventions mirror test/shared-system-labels.test.ts (per-test seed via beforeEach).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { CrossCompanyError, hireEmployee, setEmploymentAssignment, transferEmployee } from '../core/org';
import {
  archiveDepartment,
  createDepartment,
  createPosition,
  setCompanySharedLabels,
} from '../core/admin';
import { assignLabelToCompanies } from '../core/system-labels';

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

const email = () => `olf_${randomUUID().slice(0, 8)}@t.local`;

/** A second company in the same tenant, to share labels out of. */
async function secondCompany(): Promise<string> {
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'OLF Co B Sdn Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
  return co.id;
}

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Org Filter Emp', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

describe('570e3311 — transferEmployee changed-only org-label guards', () => {
  it('rejects a changed cross-company department (flag OFF)', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Foreign Dept' });
    await expect(
      transferEmployee(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: foreign.id }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('accepts a shared-in department when the flag is ON', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Shared Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    const res = await transferEmployee(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: shared.id,
    });
    expect(res.assignmentId).toBeTruthy();
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(shared.id);
  });

  it('rejects an archived-but-shared department', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Archived Shared Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    await archiveDepartment(a, { id: shared.id, archived: true });
    await expect(
      transferEmployee(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: shared.id }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('accepts re-supplying the CURRENT value even when it is legacy cross-company (changed-only semantics)', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Legacy Foreign Dept' });
    // Simulate legacy/imported data: the stored current assignment points at a wrong-company label.
    await owner.db
      .update(schema.assignment)
      .set({ departmentId: foreign.id })
      .where(and(eq(schema.assignment.employmentId, hire.employmentId), isNull(schema.assignment.validTo)));
    // Re-supplying that same department (as a UI that pins the current value would) passes the guard,
    // while the transfer still applies the genuinely-changed field.
    const res = await transferEmployee(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: foreign.id,
      positionId: b.positionId,
    });
    expect(res.assignmentId).toBeTruthy();
    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(foreign.id); // carried, not blocked, not cleared
    expect(open.positionId).toBe(b.positionId);
  });
});

describe('570e3311 — setEmploymentAssignment changed-only department / position guards', () => {
  it('rejects a changed cross-company department with the standard message', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Foreign Assign Dept' });
    await expect(
      setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: foreign.id }),
    ).rejects.toThrow(/not a valid option/i);
  });

  it('rejects a changed shared-in position once the flag is OFF, but accepts it while ON', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createPosition(a, { companyId: coB, title: 'Shared Position' });
    await assignLabelToCompanies(a, { kind: 'position', labelId: shared.id, companyIds: [b.companyId] });
    // Flag OFF → the shared-in position is NOT yet a valid option (origin-only strictness preserved).
    await expect(
      setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', positionId: shared.id }),
    ).rejects.toThrow(/not a valid option/i);
    // Flag ON → accepted.
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    const res = await setEmploymentAssignment(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      positionId: shared.id,
    });
    expect(res.changed).toBe(true);
    expect((await openAssignment(hire.employmentId)).positionId).toBe(shared.id);
  });

  it('lifecycle: a held shared-in position survives the flag being flipped OFF — an unrelated save carries it, no silent clear', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createPosition(a, { companyId: coB, title: 'Held Shared Position' });
    await assignLabelToCompanies(a, { kind: 'position', labelId: shared.id, companyIds: [b.companyId] });
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    await setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-03-01', positionId: shared.id });
    // Sharing later switched off — the stored value is now outside the company's normal option set.
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: false });
    // An Organisation Assignment save that does NOT touch position (the pinned UI re-posts the current
    // value) still applies the department change and carries the position forward.
    const res = await setEmploymentAssignment(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      positionId: shared.id,
    });
    expect(res.changed).toBe(true);
    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.positionId).toBe(shared.id); // carried forward, not cleared, not blocked
  });
});

/**
 * Page-source pins (precedent: the hydration-parity suite in test/hire-form-filter.test.ts): the
 * employee detail page must scope its departments read to the employee's own company and render
 * pinned-current options for stored values outside the scoped lists — a one-line revert to the
 * unscoped read (or dropping a pin) fails here.
 */
describe('570e3311 — employee detail page wiring pins', () => {
  const PAGE = fs.readFileSync(
    path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
    'utf8',
  );

  it('scopes the departments load to the employee company (resolver-aware read)', () => {
    expect(PAGE).toMatch(/listDepartments\(s,\s*\{\s*companyIds:\s*\[emp\.companyId\]\s*\}\)/);
  });

  it('renders a pinned-current option when the stored BU / Department / Position left the scoped list', () => {
    expect(PAGE).toContain('!businessUnits.some((bu) => bu.id === current.businessUnitId)');
    expect(PAGE).toContain('!departments.some((d) => d.id === current.departmentId)');
    expect(PAGE).toContain('!positions.some((pos) => pos.id === current.positionId)');
  });
});
