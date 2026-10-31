/** c002b3c3 Personnel search scope with real PostgreSQL/RLS.
 * Pure matching/URL rules live in employee-search-shared.test.ts; source contracts live in
 * personnel-search-layout-contract.test.ts. All three original allow/refuse cases are retained here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { employeeDetail, listEmployees } from '../core/read';
import { matchEmployees } from '../app/(app)/admin/personnel/employee-search';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// ───────────────────────────── 1. the refusal (against the database) ─────────────────────────────

let b: Base;
let companyB: string;
let deptB: string;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyB = c2.id;
  const [d2] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: companyB, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  deptB = d2.id;
});
afterAll(closeAll);

/**
 * An hr_admin scoped to ONE company. RLS reads `ctx.grants` (db/client.ts serialises it into the
 * `app.grants` GUC); a context carrying only `roles` is widened to GROUP-WIDE, which is what the
 * harness's `adminCtx` is — so the grant has to be stated explicitly or every scope assertion below
 * would pass vacuously.
 */
async function scopedAdminCtx(companyId: string): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { ...adminCtx(b), userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

const hire = (companyId: string, departmentId: string, fullName: string, employeeCode: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `${employeeCode.toLowerCase()}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
    employeeCode,
  });

describe('c002b3c3 · the search is not a way around scope', () => {
  it('1a. the list the switcher searches EXCLUDES an out-of-scope employee', async () => {
    const mine = await hire(b.companyId, b.deptA, 'Aisha Rahman', 'EMP-9001');
    const theirs = await hire(companyB, deptB, 'Bala Krishnan', 'EMP-9002');
    const ctx = await scopedAdminCtx(b.companyId);

    const rows = await listEmployees(ctx);
    const seen = rows.map((r) => r.employmentId);
    expect(seen).toContain(mine.employmentId);
    expect(seen).not.toContain(theirs.employmentId);

    // …and the matcher cannot invent them: searching their exact Employee ID finds nobody.
    expect(matchEmployees(rows, 'EMP-9002')).toEqual([]);
    expect(matchEmployees(rows, 'Bala')).toEqual([]);
  });

  it('1b. the out-of-scope employmentId still resolves to NOTHING when reached directly', async () => {
    const theirs = await hire(companyB, deptB, 'Bala Krishnan', 'EMP-9002');
    const ctx = await scopedAdminCtx(b.companyId);

    // This is the exact call the profile route makes before it renders anything; null is what makes it
    // notFound(). Whether the id arrived via the switcher, a bookmark or the address bar is irrelevant.
    expect(await employeeDetail(ctx, theirs.employmentId)).toBeFalsy();

    // Control: the guard refuses the other company, not everything.
    const mine = await hire(b.companyId, b.deptA, 'Aisha Rahman', 'EMP-9001');
    expect((await employeeDetail(ctx, mine.employmentId))?.name).toBe('Aisha Rahman');
  });

  it('1c. a group-wide admin sees both — so 1a/1b are the scope, not an empty database', async () => {
    const mine = await hire(b.companyId, b.deptA, 'Aisha Rahman', 'EMP-9001');
    const theirs = await hire(companyB, deptB, 'Bala Krishnan', 'EMP-9002');
    const rows = await listEmployees(adminCtx(b));
    const seen = rows.map((r) => r.employmentId);
    expect(seen).toContain(mine.employmentId);
    expect(seen).toContain(theirs.employmentId);
    expect(matchEmployees(rows, 'EMP-9002').map((r) => r.employmentId)).toEqual([theirs.employmentId]);
  });
});
