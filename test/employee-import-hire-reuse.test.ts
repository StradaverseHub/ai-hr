import {afterAll, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {and, eq, inArray, sql} from 'drizzle-orm';
import {createBusinessUnit, createDepartment} from '../core/admin';
import {commitEmployeeImport, validateEmployeeImport} from '../core/import';
import type {ImportRecord} from '../lib/import-schema';
import {hireEmployee} from '../core/org';
import * as organisation from '../core/company-organisation';
import * as schema from '../db/schema';
import {pgSqlState} from '../lib/db-error';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);

const earlier = '2024-01-02';
const later = '2024-06-03';
function record(code: string, date = earlier, company?: string): ImportRecord {
  const input: ImportRecord = {
    employee_code: code,
    full_name: `Fictional ${code}`,
    email: `${code.toLowerCase()}@fixture.test`,
    department: company ? 'Satellite Finance' : 'Finance',
    hired_on: date,
    employment_type: 'full_time',
    basic_salary: '2500',
  };
  if (company) input.company = company;
  return input;
}

it('reuses only identical company and date facts, retaining persisted placement, compensation and audit order', async () => {
  const ctx = adminCtx(base);
  const [satellite] = await owner.db.insert(schema.company).values({
    tenantId: base.tenantId, legalName: 'Fictional Satellite Company', country: 'MY',
  }).returning();
  // These canonical creators install the scoped Criteria through the native label creation triggers.
  const satelliteDept = await createDepartment(ctx, {companyId: satellite.id, name: 'Satellite Finance'});
  const firstUnit = await createBusinessUnit(ctx, {companyId: base.companyId, code: 'REUSE-U1', name: 'Fictional first unit'});
  const secondUnit = await createBusinessUnit(ctx, {companyId: base.companyId, code: 'REUSE-U2', name: 'Fictional second unit'});
  const records: ImportRecord[] = [{...record('REUSE-A'), business_unit: 'REUSE-U1'}, {...record('REUSE-B'), business_unit: 'REUSE-U2'},
    record('REUSE-C', later), record('REUSE-D', earlier, satellite.legalName), record('REUSE-E')];
  const preview = await validateEmployeeImport(ctx, {companyId: base.companyId, records});
  expect(preview.rows.map(row => row.errors)).toEqual(records.map(() => []));
  expect(preview.fileErrors).toEqual([]);
  const deriveCompanyOrganisationTx = organisation.deriveCompanyOrganisationTx;
  let lockVerified = false;
  const derive = vi.spyOn(organisation, 'deriveCompanyOrganisationTx').mockImplementation(async (...args) => {
    if (!lockVerified) {
      const conflict = await owner.db.execute(sql`select id from public.company where id=${base.companyId}::uuid for update nowait`)
        .then(() => null, pgSqlState);
      expect(conflict).toBe('55P03');
      lockVerified = true;
    }
    return deriveCompanyOrganisationTx(...args);
  });
  try {
    const result = await commitEmployeeImport(ctx, {companyId: base.companyId, records});
    expect(result).toMatchObject({imported: 5, skipped: 0, failed: [], fileErrors: []});
    expect(lockVerified).toBe(true);
    expect(derive.mock.calls.map(([, , ref]) => ref)).toEqual([
      {companyId: base.companyId, asOf: earlier},
      {companyId: base.companyId, asOf: later},
      {companyId: satellite.id, asOf: earlier},
    ]);

    const rows = await owner.db.select({
      id: schema.employment.id, code: schema.employment.employeeCode, company: schema.assignment.companyId,
      department: schema.assignment.departmentId, businessUnit: schema.assignment.businessUnitId, from: schema.assignment.validFrom,
      salary: schema.compensation.basicSalary,
    }).from(schema.employment)
      .innerJoin(schema.assignment, eq(schema.assignment.employmentId, schema.employment.id))
      .innerJoin(schema.compensation, eq(schema.compensation.employmentId, schema.employment.id))
      .where(and(eq(schema.employment.tenantId, base.tenantId),
        inArray(schema.employment.employeeCode, records.map(row => row.employee_code))));
    const byCode = new Map(rows.map(row => [row.code, row]));
    expect(byCode.size).toBe(records.length);
    for (const input of records) {
      const secondary = input.employee_code === 'REUSE-D';
      expect(byCode.get(input.employee_code)).toMatchObject({
        company: secondary ? satellite.id : base.companyId,
        department: secondary ? satelliteDept.id : base.deptA,
        from: input.hired_on, salary: '2500.00',
        businessUnit: input.employee_code === 'REUSE-A' ? firstUnit.id : input.employee_code === 'REUSE-B' ? secondUnit.id : null,
      });
    }
    const events = await owner.db.select({type: schema.domainEvent.eventType, subject: schema.domainEvent.subjectEmploymentId})
      .from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, base.tenantId),
        inArray(schema.domainEvent.subjectEmploymentId, rows.map(row => row.id)),
        inArray(schema.domainEvent.eventType, ['employment.hired', 'compensation.set'])))
      .orderBy(schema.domainEvent.sequence);
    expect(events).toEqual(records.flatMap(input => {
      const subject = byCode.get(input.employee_code)?.id;
      return [{type: 'employment.hired', subject}, {type: 'compensation.set', subject}];
    }));
  } finally { derive.mockRestore(); }
});

it('rolls back a late native refusal and resolves fresh facts for another file and for manual Hire', async () => {
  const ctx = adminCtx(base);
  const records = [record('REUSE-FIRST'), record('REUSE-REFUSE')];
  const preview = await validateEmployeeImport(ctx, {companyId: base.companyId, records});
  expect(preview.rows.map(row => row.errors)).toEqual([[], []]);
  expect(preview.fileErrors).toEqual([]);
  const derive = vi.spyOn(organisation, 'deriveCompanyOrganisationTx');
  try {
    await owner.db.execute(sql`create function public.fixture_import_hire_reuse_refusal() returns trigger language plpgsql as $$
      begin if new.employee_code='REUSE-REFUSE' then raise exception 'Fictional late Hire refusal'; end if;
      return new; end $$`);
    await owner.db.execute(sql`create trigger fixture_import_hire_reuse_refusal before insert on public.employment
      for each row execute function public.fixture_import_hire_reuse_refusal()`);
    try {
      const refused = await commitEmployeeImport(ctx, {companyId: base.companyId, records});
      expect(refused.imported).toBe(0);
      expect(refused.failed).toHaveLength(2);
      expect(refused.fileErrors).toEqual([expect.stringMatching(/rolled back after row 2 was refused/)]);
      expect(await owner.db.select({id: schema.person.id}).from(schema.person).where(and(
        eq(schema.person.tenantId, base.tenantId), inArray(schema.person.primaryEmail, records.map(row => row.email)),
      ))).toEqual([]);
      expect(derive).toHaveBeenCalledTimes(1);
    } finally {
      await owner.db.execute(sql`drop trigger fixture_import_hire_reuse_refusal on public.employment`);
      await owner.db.execute(sql`drop function public.fixture_import_hire_reuse_refusal()`);
    }

    expect((await commitEmployeeImport(ctx, {companyId: base.companyId, records})).imported).toBe(2);
    expect(derive).toHaveBeenCalledTimes(2);
    for (const employeeCode of ['REUSE-MANUAL-A', 'REUSE-MANUAL-B']) {
      await hireEmployee(ctx, {
        person: {fullName: `Fictional ${employeeCode}`, primaryEmail: `${employeeCode.toLowerCase()}@fixture.test`},
        companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: earlier, employeeCode,
      });
    }
    expect(derive).toHaveBeenCalledTimes(4);
  } finally { derive.mockRestore(); }
});
