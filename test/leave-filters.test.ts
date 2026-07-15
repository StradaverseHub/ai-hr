/**
 * Advanced Search & Filter for Leave Management (feedback 0773bda9) — data-layer guard for the new
 * paginated/filterable/sortable read `listLeaveRequestsPage`. Mirrors test/people-filters.test.ts:
 * seeds requests across statuses / types / dates / employees / companies and asserts every filter,
 * the scope fence, paging totals, the sort whitelist fallback, and the non-admin RLS fence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { listLeaveRequestsPage } from '../core/read';
import type { SessionContext } from '../db/client';

let b: Base;
let company2: string;
let dept2: string;
let sickTypeId: string;

// Employees + their pre-seeded leave requests.
let empA: { employmentId: string; personId: string };
let empB: { employmentId: string; personId: string };
let empC: { employmentId: string; personId: string };
let empD: { employmentId: string; personId: string }; // in company2
let reqA: string; // Annual · pending · 2026-07-05→07 · deptA
let reqB: string; // Sick   · approved · 2026-06-28→07-01 · deptB (spans month boundary)
let reqC: string; // Annual · rejected · 2026-08-10→12 · deptA
let reqD: string; // Annual · pending · company2
const nameA = `Filter Alpha ${randomUUID().slice(0, 6)}`;

const hire = (name: string, companyId: string, departmentId: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `lf_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function insertReq(p: {
  employmentId: string;
  leaveTypeId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  start: string;
  end: string;
}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveRequest)
    .values({
      tenantId: b.tenantId,
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.start,
      endDate: p.end,
      days: '1',
      status: p.status,
    })
    .returning({ id: schema.leaveRequest.id });
  return row.id;
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();

  // A second company + department (scope-fence + company/dept narrowing).
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  company2 = c2.id;
  const [d2] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: company2, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  dept2 = d2.id;

  const [sick] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true })
    .returning({ id: schema.leaveType.id });
  sickTypeId = sick.id;

  empA = await hire(nameA, b.companyId, b.deptA);
  empB = await hire(`Filter Bravo ${randomUUID().slice(0, 6)}`, b.companyId, b.deptB);
  empC = await hire(`Filter Charlie ${randomUUID().slice(0, 6)}`, b.companyId, b.deptA);
  empD = await hire(`Filter Delta ${randomUUID().slice(0, 6)}`, company2, dept2);

  reqA = await insertReq({ employmentId: empA.employmentId, leaveTypeId: b.annualLeaveTypeId, status: 'pending', start: '2026-07-05', end: '2026-07-07' });
  reqB = await insertReq({ employmentId: empB.employmentId, leaveTypeId: sickTypeId, status: 'approved', start: '2026-06-28', end: '2026-07-01' });
  reqC = await insertReq({ employmentId: empC.employmentId, leaveTypeId: b.annualLeaveTypeId, status: 'rejected', start: '2026-08-10', end: '2026-08-12' });
  reqD = await insertReq({ employmentId: empD.employmentId, leaveTypeId: b.annualLeaveTypeId, status: 'pending', start: '2026-07-05', end: '2026-07-07' });

  // Approval Information (feedback 0773bda9 gap-close): stamp reqB's final decider (empC) so the
  // "Approved by" filter has a named person to match; leave reqA's decider unset (still pending).
  await owner.db
    .update(schema.leaveRequest)
    .set({ decidedByEmploymentId: empC.employmentId })
    .where(eq(schema.leaveRequest.id, reqB));
  // "Pending with" is by stage — reqA currently awaits the direct manager; reqD awaits HR.
  await owner.db.insert(schema.leaveApprovalStep).values([
    { tenantId: b.tenantId, leaveRequestId: reqA, subjectEmploymentId: empA.employmentId, stepIndex: 0, approverKind: 'direct_manager', status: 'pending' },
    { tenantId: b.tenantId, leaveRequestId: reqD, subjectEmploymentId: empD.employmentId, stepIndex: 0, approverKind: 'hr_admin', status: 'pending' },
  ]);
});
afterAll(async () => {
  await closeAll();
});

const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
const page = (p: Parameters<typeof listLeaveRequestsPage>[1]) => listLeaveRequestsPage(adminCtx(b), p);
const scoped = { companyIds: [] as string[] | undefined, limit: 200, offset: 0 };

describe('0773bda9 — leave advanced search & filter (data layer)', () => {
  it('searches by employee name', async () => {
    const r = await page({ q: 'Filter Alpha', limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqA)).toBe(true);
    expect(ids(r.rows).has(reqB)).toBe(false);
  });

  it('searches by employee code', async () => {
    const all = await page({ limit: 500, offset: 0 });
    const rowA = all.rows.find((x) => x.id === reqA)!;
    expect(rowA.employeeCode).toBeTruthy();
    const r = await page({ q: rowA.employeeCode!, limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqA)).toBe(true);
    expect(r.rows.every((x) => x.employeeCode === rowA.employeeCode)).toBe(true);
  });

  it('searches by uuid-prefix reference (with a leading #)', async () => {
    const r = await page({ q: `#${reqA.slice(0, 8)}`, limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqA)).toBe(true);
    // The prefix is specific enough that the unrelated requests do not leak in.
    expect(ids(r.rows).has(reqC)).toBe(false);
  });

  it('multi status (OR within field) — pending + approved excludes rejected', async () => {
    const r = await page({ statuses: ['pending', 'approved'], limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqA)).toBe(true);
    expect(ids(r.rows).has(reqB)).toBe(true);
    expect(ids(r.rows).has(reqC)).toBe(false);
  });

  it('multi leaveType — sick only returns the sick request', async () => {
    const r = await page({ leaveTypeIds: [sickTypeId], limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqB)).toBe(true);
    expect(ids(r.rows).has(reqA)).toBe(false);
  });

  it('date-window overlap catches a request spanning the month boundary and excludes out-of-window', async () => {
    const r = await page({ from: '2026-07-01', to: '2026-07-31', limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqA)).toBe(true); // fully in July
    expect(ids(r.rows).has(reqB)).toBe(true); // Jun 28 → Jul 1 overlaps
    expect(ids(r.rows).has(reqC)).toBe(false); // August
  });

  it('department narrows to that department', async () => {
    const r = await page({ departmentId: b.deptA, limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqA)).toBe(true);
    expect(ids(r.rows).has(reqB)).toBe(false); // deptB
  });

  it('companyId narrows; the scope fence wins over an out-of-scope companyId', async () => {
    const inCompany2 = await page({ companyId: company2, limit: 200, offset: 0 });
    expect(ids(inCompany2.rows).has(reqD)).toBe(true);
    expect(ids(inCompany2.rows).has(reqA)).toBe(false);
    // Fence = [company1], but companyId asks for company2 → AND yields the empty set.
    const fenced = await page({ companyIds: [b.companyId], companyId: company2, limit: 200, offset: 0 });
    expect(fenced.rows.length).toBe(0);
  });

  it('Approval Information — "Approved by" narrows to the request that named decider decided', async () => {
    const r = await page({ approvedBy: empC.employmentId, limit: 200, offset: 0 });
    expect(ids(r.rows).has(reqB)).toBe(true); // decided by empC
    expect(ids(r.rows).has(reqA)).toBe(false); // still pending, no decider
    expect(r.rows.every((x) => x.decidedByEmploymentId === empC.employmentId)).toBe(true);
    // The decider name is projected for display.
    expect(r.rows.find((x) => x.id === reqB)!.decidedByName).toBeTruthy();
  });

  it('Approval Information — "Pending with" narrows by the awaiting stage (role, not a named person)', async () => {
    const mgr = await page({ pendingWith: 'direct_manager', limit: 200, offset: 0 });
    expect(ids(mgr.rows).has(reqA)).toBe(true); // awaits manager
    expect(ids(mgr.rows).has(reqD)).toBe(false); // awaits HR
    const hr = await page({ pendingWith: 'hr_admin', limit: 200, offset: 0 });
    expect(ids(hr.rows).has(reqD)).toBe(true);
    expect(ids(hr.rows).has(reqA)).toBe(false);
    // An unknown stage is whitelisted away in the read layer → the filter is simply not applied (no
    // throw, no SQL injection); the result is the unfiltered set rather than a crash.
    const bogus = await page({ pendingWith: "x' or '1'='1", limit: 200, offset: 0 });
    expect(bogus.rows.length).toBeGreaterThan(0);
    expect(ids(bogus.rows).has(reqA)).toBe(true);
  });

  it('paginates with a stable total', async () => {
    const first = await page({ ...scoped, limit: 2, offset: 0 });
    expect(first.rows.length).toBe(2);
    expect(first.total).toBeGreaterThanOrEqual(4);
    const second = await page({ ...scoped, limit: 2, offset: 2 });
    expect(second.total).toBe(first.total);
    // No overlap between the two pages.
    for (const id of ids(first.rows)) expect(ids(second.rows).has(id)).toBe(false);
  });

  it('an unknown sort key falls back to applied-desc (no throw)', async () => {
    const r = await page({ sort: 'bogus; drop table', dir: 'weird', limit: 200, offset: 0 });
    expect(r.rows.length).toBeGreaterThan(0);
    const applied = r.rows.map((x) => (x.appliedOn ? new Date(x.appliedOn).getTime() : 0));
    for (let i = 1; i < applied.length; i++) expect(applied[i - 1]).toBeGreaterThanOrEqual(applied[i]);
  });

  it('non-admin RLS still fences rows to the viewer', async () => {
    const empUserId = await createAppUser(b.tenantId, empA.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: empUserId, roles: ['employee'] };
    const r = await listLeaveRequestsPage(empCtx, { limit: 200, offset: 0 });
    // The employee sees their OWN request but not a colleague's.
    expect(ids(r.rows).has(reqA)).toBe(true);
    expect(ids(r.rows).has(reqB)).toBe(false);
    expect(r.rows.every((x) => x.personId === empA.personId)).toBe(true);
    // sanity: the colleague's request still exists (RLS-free owner access) — it was fenced, not absent.
    const owned = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(and(eq(schema.leaveRequest.tenantId, b.tenantId), eq(schema.leaveRequest.id, reqB)));
    expect(owned.length).toBe(1);
  });
});
