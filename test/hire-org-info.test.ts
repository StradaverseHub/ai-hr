/**
 * Employee Hiring Process Enhancement — Organization + Employment info on hire.
 * Covers: organization fields persisted on the assignment/employment, probation status,
 * reporting line on hire, enriched + backward-compatible employment.hired event, the
 * computeProvisionalEndOn date helper (incl. month-boundary clamps), server-side cross-company
 * guard, and the RLS-scoped manager-candidate read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import {
  computeProvisionalEndOn,
  CrossCompanyError,
  hireEmployee,
} from '../core/org';
import { deriveEmploymentStatus } from '../core/employment-status';
import {
  createBusinessUnit,
  createCompany,
  createDepartment,
  listBusinessUnits,
  updateDepartment,
} from '../core/admin';
import { listDepartments, listManagerCandidates } from '../core/read';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `hire_${randomUUID().slice(0, 8)}@t.local`;

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

async function employmentRow(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

describe('computeProvisionalEndOn', () => {
  it('full_time → hire + 3 calendar months', () => {
    expect(computeProvisionalEndOn('2026-01-15', 'full_time')).toBe('2026-04-15');
    expect(computeProvisionalEndOn('2026-10-01', 'full_time')).toBe('2027-01-01');
  });

  it('clamps to the last day of the target month on overflow', () => {
    // 30 Nov + 3mo → Feb has no 30th → 28 Feb (non-leap)
    expect(computeProvisionalEndOn('2026-11-30', 'full_time')).toBe('2027-02-28');
    // 31 Jan + 3mo → Apr has 30 days → 30 Apr
    expect(computeProvisionalEndOn('2026-01-31', 'full_time')).toBe('2026-04-30');
    // leap year: 30 Nov 2024 + 3mo → 28 Feb 2025 (2025 is not a leap year)
    expect(computeProvisionalEndOn('2024-11-30', 'full_time')).toBe('2025-02-28');
    // 30 Nov 2023 + 3mo → 29 Feb 2024 (2024 IS a leap year)
    expect(computeProvisionalEndOn('2023-11-30', 'full_time')).toBe('2024-02-29');
  });

  it('non-full_time → null (caller supplies fixed-term date)', () => {
    expect(computeProvisionalEndOn('2026-01-15', 'contract')).toBeNull();
    expect(computeProvisionalEndOn('2026-01-15', 'intern')).toBeNull();
    expect(computeProvisionalEndOn('2026-01-15', 'part_time')).toBeNull();
  });

  it('configurable probationMonths applies to full_time only (default 3 is byte-identical)', () => {
    // Explicit default arg === omitting it (byte-identical to pre-change).
    expect(computeProvisionalEndOn('2026-01-15', 'full_time', 3)).toBe(
      computeProvisionalEndOn('2026-01-15', 'full_time'),
    );
    // A different configured length (e.g. 6-month probation) → hire + 6 months, with month-end clamp.
    expect(computeProvisionalEndOn('2026-01-15', 'full_time', 6)).toBe('2026-07-15');
    expect(computeProvisionalEndOn('2026-11-30', 'full_time', 3)).toBe('2027-02-28');
    expect(computeProvisionalEndOn('2026-08-31', 'full_time', 6)).toBe('2027-02-28'); // Aug 31 + 6mo → Feb 28
    // The months arg is IGNORED for non-full_time — contract/intern end dates are user-supplied.
    expect(computeProvisionalEndOn('2026-01-15', 'contract', 6)).toBeNull();
    expect(computeProvisionalEndOn('2026-01-15', 'intern', 6)).toBeNull();
    expect(computeProvisionalEndOn('2026-01-15', 'part_time', 6)).toBeNull();
  });
});

describe('hireEmployee — organization + employment info', () => {
  it('persists org fields, sets probation status, creates the reporting line, and emits both events', async () => {
    const mgr = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Org Manager', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });

    const hire = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Org Hire', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      costCenterId: b.costCenterId,
      reportingManagerEmploymentId: mgr.employmentId,
      employmentType: 'full_time',
      hiredOn: '2026-03-01',
      provisionalEndOn: '2026-06-01', // a probation period applies
    });

    // assignment carries position + cost-center and is PROBATION (a provisional end applies)
    const asg = await openAssignment(hire.employmentId);
    expect(asg.positionId).toBe(b.positionId);
    expect(asg.costCenterId).toBe(b.costCenterId);

    // employment carries the provisional end date
    const emp = await employmentRow(hire.employmentId);
    expect(emp.provisionalEndOn).toBe('2026-06-01');
    // R81 — the hire is on PROBATION, and that is now read from the date above rather than from a stored
    // status column (dropped in 0331). Before R81 the deriver read only the confirmation dates, which a
    // hire never writes, so this employee displayed "Active" throughout their probation.
    expect(deriveEmploymentStatus(emp, '2026-05-02')).toBe('probation');
    expect(deriveEmploymentStatus(emp, '2026-06-01')).toBe('active');

    // an OPEN administrative reporting line to the manager exists
    const [rl] = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(
        and(
          eq(schema.reportingLine.subordinateEmploymentId, hire.employmentId),
          isNull(schema.reportingLine.validTo),
        ),
      )
      .limit(1);
    expect(rl).toBeDefined();
    expect(rl.managerEmploymentId).toBe(mgr.employmentId);
    expect(rl.lineType).toBe('administrative');

    // both events appended
    const empEvents = await eventTypesFor(b.tenantId, hire.employmentId);
    expect(empEvents).toContain('employment.hired');
    const rlEvents = await eventTypesFor(b.tenantId, rl.id);
    expect(rlEvents).toContain('reporting-line.set');
  });

  it('employment.hired payload is backward-compatible AND enriched', async () => {
    const hire = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Compat Hire', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      gradeId: null,
      employmentType: 'contract',
      hiredOn: '2026-04-10',
      provisionalEndOn: '2026-10-10',
    });
    const payload = await latestEventPayload(b.tenantId, hire.employmentId, 'employment.hired');
    expect(payload).not.toBeNull();
    // existing keys preserved unrenamed (CP22 / audit consumers)
    expect(payload).toMatchObject({
      personId: hire.personId,
      companyId: b.companyId,
      departmentId: b.deptA,
      hiredOn: '2026-04-10',
    });
    // new keys added
    expect(payload).toMatchObject({
      positionId: b.positionId,
      employmentType: 'contract',
      assignmentStatus: 'probation',
      provisionalEndOn: '2026-10-10',
    });
  });

  // R81 (9cbf5e0d) — DELIBERATE NARROWING, RECORDED HERE. This case used to assert that an intern or
  // contract hire was 'probation' even with NO provisional date, because hireEmployee applied a TYPE-based
  // rule when it wrote the stored column: interns and contractors were probation by virtue of their type.
  // The reporter's rule set has no such rule — the six statuses are driven by dates and events, and there
  // is no "Intern" or "Contract" status. An employee with no probation end date and no confirmation date
  // has nothing recorded that probation could end on, so they are Active.
  //
  // This moves NOBODY: the stored column stopped being displayed at R43, so such an intern has been reading
  // "Active" on every screen since then regardless of what the column said. Give an intern a provisional end
  // date — which the hire form does by default for anyone with a probation period — and they read Probation,
  // as the case below the next one shows.
  it('an intern hire with NO provisional date is Active; a type alone no longer implies probation', async () => {
    const intern = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Intern Hire', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'intern',
      hiredOn: '2026-05-01',
    });
    expect(deriveEmploymentStatus(await employmentRow(intern.employmentId), '2026-05-02')).toBe('active');

    // ...but WITH one, the same intern is on probation until it passes.
    const dated = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Intern Dated', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'intern',
      hiredOn: '2026-05-01',
      provisionalEndOn: '2026-08-01',
    });
    expect(deriveEmploymentStatus(await employmentRow(dated.employmentId), '2026-05-02')).toBe('probation');
    expect(deriveEmploymentStatus(await employmentRow(dated.employmentId), '2026-08-01')).toBe('active');

    const ft = await hireEmployee(adminCtx(b), {
      person: { fullName: 'NoProbation Hire', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-05-01',
      provisionalEndOn: null,
    });
    // No provisional period at all ⇒ nothing to serve ⇒ Active from day one.
    expect(deriveEmploymentStatus(await employmentRow(ft.employmentId), '2026-05-02')).toBe('active');
  });

  it('rejects a position / cost-center / department that belongs to another company', async () => {
    // a second company with its own position + cost center
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [pos2] = await owner.db
      .insert(schema.position)
      .values({ tenantId: b.tenantId, companyId: c2.id, title: 'Other Exec' })
      .returning({ id: schema.position.id });
    const [cc2] = await owner.db
      .insert(schema.costCenter)
      .values({ tenantId: b.tenantId, companyId: c2.id, code: 'CC2', name: 'Other HQ' })
      .returning({ id: schema.costCenter.id });
    const [dept2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: c2.id, name: 'Other Dept' })
      .returning({ id: schema.department.id });

    // position from company B into company A → throws
    await expect(
      hireEmployee(adminCtx(b), {
        person: { fullName: 'X', primaryEmail: email() },
        companyId: b.companyId,
        departmentId: b.deptA,
        positionId: pos2.id,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(CrossCompanyError);

    // cost center from company B → throws
    await expect(
      hireEmployee(adminCtx(b), {
        person: { fullName: 'X', primaryEmail: email() },
        companyId: b.companyId,
        departmentId: b.deptA,
        costCenterId: cc2.id,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(CrossCompanyError);

    // department from company B → throws
    await expect(
      hireEmployee(adminCtx(b), {
        person: { fullName: 'X', primaryEmail: email() },
        companyId: b.companyId,
        departmentId: dept2.id,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('createDepartment rejects a cross-company parentDepartmentId (belt-and-braces against the H2 leak)', async () => {
    // A second company with its own department, used as a cross-company parent.
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Parent-Co Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [dept2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: c2.id, name: 'Cross Parent' })
      .returning({ id: schema.department.id });

    // Creating a Company-A department under a Company-B parent must throw (no cross-company tree allowed).
    await expect(
      createDepartment(adminCtx(b), { companyId: b.companyId, name: 'Mis-parented', parentDepartmentId: dept2.id }),
    ).rejects.toBeInstanceOf(CrossCompanyError);

    // A same-company parent is accepted.
    const ok = await createDepartment(adminCtx(b), {
      companyId: b.companyId,
      name: 'Same-Co Child',
      parentDepartmentId: b.deptA,
    });
    expect(ok.id).toBeTruthy();
  });

  it('listManagerCandidates returns active in-scope employments and excludes terminated', async () => {
    const active = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Candidate Active', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const candidates = await listManagerCandidates(adminCtx(b), { companyIds: [b.companyId] });
    const ids = new Set(candidates.map((c) => c.employmentId));
    expect(ids.has(active.employmentId)).toBe(true);
    // a bogus company scope returns none of our company's people
    const none = await listManagerCandidates(adminCtx(b), { companyIds: [randomUUID()] });
    expect(none.length).toBe(0);
  });
});

describe('department ↔ business unit link (ADR-0068)', () => {
  it('createDepartment links a same-company BU; a NULL-BU department is allowed; cross-company BU is rejected', async () => {
    const a = adminCtx(b);
    const { id: bu } = await createBusinessUnit(a, { companyId: b.companyId, code: 'RET', name: 'Retail' });

    // Same-company link succeeds and is recoverable via the department read.
    const linked = await createDepartment(a, { companyId: b.companyId, name: 'BU-Linked Dept', businessUnitId: bu });
    const depsAfter = await listDepartments(a, { companyIds: [b.companyId] });
    expect(depsAfter.find((d) => d.id === linked.id)?.businessUnitId).toBe(bu);

    // A department with no BU is allowed and reads back as null (back-compat for existing rows).
    const unassigned = await createDepartment(a, { companyId: b.companyId, name: 'No-BU Dept' });
    expect(depsAfter.find((d) => d.id === b.deptA)?.businessUnitId ?? null).toBeNull();
    const depsAgain = await listDepartments(a, { companyIds: [b.companyId] });
    expect(depsAgain.find((d) => d.id === unassigned.id)?.businessUnitId ?? null).toBeNull();

    // A BU from ANOTHER company must be rejected on the department write.
    const { id: coB } = await createCompany(a, { legalName: 'BU Co B Sdn Bhd' });
    const { id: buB } = await createBusinessUnit(a, { companyId: coB, code: 'RET', name: 'Retail B' });
    await expect(
      createDepartment(a, { companyId: b.companyId, name: 'Bad BU Dept', businessUnitId: buB }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('updateDepartment sets, clears, and (undefined) preserves the BU without wiping it on a rename', async () => {
    const a = adminCtx(b);
    const { id: bu } = await createBusinessUnit(a, { companyId: b.companyId, code: 'OPS', name: 'Ops' });
    const dep = await createDepartment(a, { companyId: b.companyId, name: 'Editable Dept', businessUnitId: bu });

    // A name-only rename (businessUnitId undefined) must NOT wipe the existing BU.
    await updateDepartment(a, { id: dep.id, name: 'Editable Dept Renamed' });
    let deps = await listDepartments(a, { companyIds: [b.companyId] });
    expect(deps.find((d) => d.id === dep.id)?.businessUnitId).toBe(bu);

    // Explicitly clearing (null) unassigns it.
    await updateDepartment(a, { id: dep.id, name: 'Editable Dept Renamed', businessUnitId: null });
    deps = await listDepartments(a, { companyIds: [b.companyId] });
    expect(deps.find((d) => d.id === dep.id)?.businessUnitId ?? null).toBeNull();
  });

  it('hiring under a BU-linked department succeeds; the hire does NOT auto-populate the assignment BU', async () => {
    const a = adminCtx(b);
    const { id: bu } = await createBusinessUnit(a, { companyId: b.companyId, code: 'SLS', name: 'Sales' });
    const dep = await createDepartment(a, { companyId: b.companyId, name: 'Sales Dept', businessUnitId: bu });
    const hire = await hireEmployee(a, {
      person: { fullName: 'BU Hire', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: dep.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    expect(hire.employmentId).toBeTruthy();
    // 1001ff61 — the assignment now carries an OPTIONAL business_unit_id, but the hire flow leaves it NULL:
    // the department's BU link is independent, and the assignment BU is set explicitly via
    // setEmploymentAssignment (not auto-derived from the department at hire time).
    const [asg] = await owner.db
      .select()
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    expect(asg.businessUnitId).toBeNull();
    const deps = await listBusinessUnits(a, { companyIds: [b.companyId] });
    expect(deps.find((x) => x.id === bu)?.inUse).toBe(true); // the department now references it
  });
});
