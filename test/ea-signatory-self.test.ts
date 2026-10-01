import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { employeeEaStatement } from '../core/reporting';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import { company, companyStatutoryAuthority, person } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';

describe('450f443f — EA signatory display identity with unchanged person visibility', () => {
  let b: Base;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); b = await seedBase(); });
  afterAll(closeAll);
  async function fixture() {
    const a = adminCtx(b);
    const subject = await hireEmployee(a, { person: { fullName: 'EA owner', primaryEmail: 'owner@ea.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
    const signatory = await hireEmployee(a, { person: { fullName: 'Configured officer', primaryEmail: 'officer@ea.test' }, companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time', hiredOn: '2026-01-01' });
    await upsertCompanyStatutoryAuthority(a, { companyId: b.companyId, authority: 'lhdn', signatoryPersonId: signatory.personId });
    const ctx: SessionContext = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };
    return { a, subject, signatory, ctx };
  }
  it('self EA prints another person’s configured name/title without exposing their person row', async () => {
    const { subject, signatory, ctx } = await fixture();
    const ea = await employeeEaStatement(ctx, { employmentId: subject.employmentId, year: '2026' });
    expect(ea?.employer.officerName).toBe('Configured officer');
    expect(ea?.employer.officerPosition).toBe('Executive');
    expect(await withTenant(ctx, tx => tx.select().from(person).where(eq(person.id, signatory.personId)))).toEqual([]);
  });
  it('blanking/changing the authority is reflected immediately and missing titles stay blank', async () => {
    const { a, subject, ctx } = await fixture();
    await upsertCompanyStatutoryAuthority(a, { companyId: b.companyId, authority: 'lhdn', signatoryPersonId: null });
    const empty = await employeeEaStatement(ctx, { employmentId: subject.employmentId, year: '2026' });
    expect(empty?.employer.officerName).toBeNull();
    expect(empty?.employer.officerPosition).toBeNull();
    await upsertCompanyStatutoryAuthority(a, { companyId: b.companyId, authority: 'lhdn', signatoryPersonId: subject.personId });
    const changed = await employeeEaStatement(ctx, { employmentId: subject.employmentId, year: '2026' });
    expect(changed?.employer.officerName).toBe('EA owner');
    expect(changed?.employer.officerPosition).toBeNull();
  });
  it('a former officer keeps their configured name but no current designation', async () => {
    const { a, subject, signatory, ctx } = await fixture();
    await terminateEmployment(a, { employmentId: signatory.employmentId, terminationDate: todayInKualaLumpur(), terminationReason: 'test departure' });
    const ea = await employeeEaStatement(ctx, { employmentId: subject.employmentId, year: '2026' });
    expect(ea?.employer.officerName).toBe('Configured officer');
    expect(ea?.employer.officerPosition).toBeNull();
  });
  it('a configured external person prints their name with no invented designation', async () => {
    const { subject, ctx } = await fixture();
    const [external] = await owner.db.insert(person).values({ tenantId: b.tenantId, fullName: 'External officer', primaryEmail: 'external@ea.test' }).returning();
    // Persist the already-supported person FK directly: no employment is required by the schema.
    await owner.client`update company_statutory_authority set signatory_person_id = ${external.id} where company_id = ${b.companyId} and authority = 'lhdn'`;
    const ea = await employeeEaStatement(ctx, { employmentId: subject.employmentId, year: '2026' });
    expect(ea?.employer.officerName).toBe('External officer');
    expect(ea?.employer.officerPosition).toBeNull();
  });
  it('temporary app_user spoofing cannot turn a peer into the subject owner', async () => {
    const { subject, signatory, ctx } = await fixture();
    const rows = await withTenant(ctx, async tx => {
      await tx.execute(sql`CREATE TEMP TABLE app_user (id uuid, tenant_id uuid, person_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO pg_temp.app_user VALUES (${ctx.userId}::uuid, ${b.tenantId}::uuid, ${signatory.personId}::uuid)`);
      return tx.execute(sql`select * from app.ea_signatory(${signatory.employmentId}::uuid, ${b.companyId}::uuid, '2026')`);
    });
    expect(rows).toEqual([]);
    expect(await withTenant({ ...ctx, userId: undefined }, tx => tx.execute(sql`select * from app.ea_signatory(${subject.employmentId}::uuid, ${b.companyId}::uuid, '2026')`))).toEqual([]);
  });
  it('direct reader refuses a peer subject, unrelated company, malformed year and foreign tenant', async () => {
    const { subject, signatory, ctx } = await fixture();
    const [other] = await owner.db.insert(company).values({ tenantId: b.tenantId, legalName: 'Other', country: 'MY' }).returning();
    await owner.db.insert(companyStatutoryAuthority).values({ tenantId: b.tenantId, companyId: other.id, authority: 'lhdn', signatoryPersonId: signatory.personId });
    const direct = (subjectId: string, coId: string, year = '2026', caller = ctx) => withTenant(caller, tx => tx.execute(sql`select * from app.ea_signatory(${subjectId}::uuid, ${coId}::uuid, ${year})`));
    const scopedPayroll: SessionContext = { ...ctx, userId: undefined, personId: null, roles: ['payroll_partner'], grants: [{ role: 'payroll_partner', companyId: b.companyId }] };
    expect((await direct(subject.employmentId, b.companyId, '2026', scopedPayroll))[0]?.officer_name).toBe('Configured officer');
    expect(await direct(subject.employmentId, b.companyId, '2026', { ...scopedPayroll, grants: [{ role: 'payroll_partner', companyId: other.id }] })).toEqual([]);
    expect(await direct(signatory.employmentId, b.companyId)).toEqual([]);
    expect(await direct(subject.employmentId, other.id)).toEqual([]);
    expect(await direct(subject.employmentId, b.companyId, '2026%')).toEqual([]);
    expect(await direct(subject.employmentId, b.companyId, '2026', { ...ctx, tenantId: '22222222-2222-2222-2222-222222222222' })).toEqual([]);
  });
});
