/**
 * Board 74a7a074 — core/audit-labels.ts names the records an Audit Trail page points at, as the viewer,
 * under row-level security. Fictional fixtures only. Four promises:
 *   1. the statements are bounded by record KINDS, not rows: one row and the 2,000-row ceiling send the same
 *      statements, in one transaction, one per kind present, and none of them reads domain_event;
 *   2. a company-scoped hr_admin gets nothing (the screen's "Record not available") for another company's
 *      employee, for that employee's personId and for that person's user, while a group admin gets names;
 *   3. a deleted department and an id that never existed read exactly the same (absent);
 *   4. what does resolve carries the record's current name and code.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { observeStatements, isIdentityStatement } from './helpers/statement-observer';
import { company, department, roleAssignment } from '../db/schema';
import { hireEmployee } from '../core/org';
import { resolveAuditLabels } from '../core/audit-labels';
import { ALL_ROW_CEILING } from '../lib/pagination';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { SessionContext } from '../db/client';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const hire = (name: string, companyId = b.companyId, departmentId = b.deptA) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `audit-labels-${randomUUID()}@example.test` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: todayInKualaLumpur(),
  });

type Fixture = {
  scoped: SessionContext;
  local: { employmentId: string; personId: string; userId: string };
  foreign: { employmentId: string; personId: string; userId: string; companyId: string };
  deletedDepartmentId: string;
};

async function fixture(): Promise<Fixture> {
  const local = await hire('Fictional Local Employee');
  const [foreignCompany] = await owner.db
    .insert(company)
    .values({ tenantId: b.tenantId, legalName: 'Fictional Foreign Sdn Bhd', companyLabel: 'FFS', country: 'MY', currency: 'MYR' })
    .returning({ id: company.id });
  const [foreignDepartment] = await owner.db
    .insert(department)
    .values({ tenantId: b.tenantId, companyId: foreignCompany.id, name: 'Fictional Foreign Department' })
    .returning({ id: department.id });
  const foreign = await hire('Fictional Foreign Employee', foreignCompany.id, foreignDepartment.id);
  const [gone] = await owner.db
    .insert(department)
    .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Fictional Removed Department' })
    .returning({ id: department.id });
  await owner.db.delete(department).where(eq(department.id, gone.id));
  // The company-scoped administrator, built exactly as test/personnel-audit-subject.test.ts builds one.
  const admin = await hire('Fictional Scoped Administrator');
  const userId = await createAppUser(b.tenantId, admin.personId, 'hr_admin');
  await owner.db.update(roleAssignment).set({ companyId: b.companyId }).where(eq(roleAssignment.appUserId, userId));
  const scoped: SessionContext = {
    ...adminCtx(b),
    userId,
    personId: admin.personId,
    employmentIds: [admin.employmentId],
    grants: [{ role: 'hr_admin' as const, companyId: b.companyId }],
  };
  return {
    scoped,
    local: { ...local, userId: await createAppUser(b.tenantId, local.personId, 'employee') },
    foreign: { ...foreign, companyId: foreignCompany.id, userId: await createAppUser(b.tenantId, foreign.personId, 'employee') },
    deletedDepartmentId: gone.id,
  };
}

const row = (i: number, payload: Record<string, unknown>) => ({
  aggregateType: 'employment',
  aggregateId: String(payload.employmentId),
  eventType: 'employment.info.updated',
  payload,
  id: `fictional-${i}`,
});

describe('74a7a074 — audit record labels', () => {
  it('names what the viewer may see and nothing else; deleted and out-of-scope read the same', async () => {
    const f = await fixture();
    const rows = [
      row(1, { employmentId: f.local.employmentId, personId: f.local.personId, userId: f.local.userId, companyId: b.companyId, departmentId: b.deptA }),
      row(2, { employmentId: f.foreign.employmentId, personId: f.foreign.personId, userId: f.foreign.userId, companyId: f.foreign.companyId }),
      row(3, { employmentId: f.local.employmentId, before: { departmentId: f.deletedDepartmentId }, after: { departmentId: randomUUID() } }),
    ];

    const scoped = await resolveAuditLabels(f.scoped, rows);
    // Positive control: the scoped administrator does resolve their own company's employee.
    expect(scoped.employment?.[f.local.employmentId]?.label).toBe('Fictional Local Employee');
    expect(scoped.person?.[f.local.personId]?.label).toBe('Fictional Local Employee');
    expect(scoped.user?.[f.local.userId]?.label).toBe('Fictional Local Employee');
    // Another company's employee, by employment, person and user: absent ("Record not available").
    expect(scoped.employment?.[f.foreign.employmentId]).toBeUndefined();
    expect(scoped.person?.[f.foreign.personId]).toBeUndefined();
    expect(scoped.user?.[f.foreign.userId]).toBeUndefined();
    expect(JSON.stringify(scoped)).not.toContain('Fictional Foreign Employee');
    // Company and department are tenant-wide reference data; a deleted department is simply absent.
    expect(scoped.company?.[b.companyId]?.label).toBe('Acme Sdn Bhd');
    expect(scoped.department?.[b.deptA]?.label).toBeTruthy();
    expect(scoped.department?.[f.deletedDepartmentId]).toBeUndefined();
    expect(Object.keys(scoped.department ?? {})).toEqual([b.deptA]);

    // The group administrator sees both companies, so the absence above is scope, not a broken lookup.
    const group = await resolveAuditLabels(adminCtx(b), rows);
    expect(group.employment?.[f.foreign.employmentId]?.label).toBe('Fictional Foreign Employee');
    expect(group.person?.[f.foreign.personId]?.label).toBe('Fictional Foreign Employee');
    expect(group.company?.[f.foreign.companyId]).toEqual({ label: 'Fictional Foreign Sdn Bhd', code: 'FFS' });
    expect(group.department?.[f.deletedDepartmentId]).toBeUndefined();
  }, 60_000);

  it('sends the same statements for one row as for the 2,000-row ceiling, one per kind, and reads no domain_event', async () => {
    const f = await fixture();
    const kinds = { employmentId: f.local.employmentId, personId: f.local.personId, userId: f.local.userId, companyId: b.companyId };
    const people = [f.local, f.foreign];
    const many = Array.from({ length: ALL_ROW_CEILING }, (_, i) => {
      const who = people[i % 2];
      return row(i, { ...kinds, employmentId: who.employmentId, personId: who.personId, userId: who.userId, before: { departmentId: b.deptA }, after: { departmentId: i % 3 ? b.deptB : f.deletedDepartmentId } });
    });
    expect(many).toHaveLength(2000);
    const one = await observeStatements(() => resolveAuditLabels(f.scoped, [many[0]]));
    const all = await observeStatements(() => resolveAuditLabels(f.scoped, many));
    for (const run of [one, all]) {
      expect(run.transactions).toBe(1);
      const own = run.statements.filter((s) => /= any\(\$\d+::uuid\[\]\)/.test(s.sql));
      // Five kinds on the page (Record: employment, person, company; Other: user; Changes: department),
      // five lookups, each with ONE uuid[] parameter however many rows point at it.
      expect(own.map((s) => s.sql.match(/\bfrom\s+"?(\w+)"?/i)?.[1])).toEqual(['employment', 'person', 'company', 'app_user', 'department']);
      for (const s of own) expect(s.params).toHaveLength(1);
      expect(run.statements.filter((s) => isIdentityStatement(s.sql))).toHaveLength(1);
      expect(run.statements.some((s) => /domain_event/i.test(s.sql))).toBe(false);
    }
    expect(all.statements.length).toBe(one.statements.length);
    // The large page still resolves correctly under scope.
    expect(all.result.employment?.[f.local.employmentId]?.label).toBe('Fictional Local Employee');
    expect(all.result.employment?.[f.foreign.employmentId]).toBeUndefined();
    expect(Object.keys(all.result.department ?? {}).sort()).toEqual([b.deptA, b.deptB].sort());

    // No reference on the page: no transaction at all.
    const none = await observeStatements(() => resolveAuditLabels(f.scoped, [{ aggregateType: 'notice', aggregateId: 'x', eventType: 'notice.created', payload: { note: 'Fictional' } }]));
    expect(none.statements).toHaveLength(0);
  }, 120_000);
});
