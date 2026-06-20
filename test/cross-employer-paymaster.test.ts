/**
 * ADR-0029 (G2 Slice 2a) — scope-out substrate: the concurrent-employment detector + the validated
 * designated-paymaster setter. A person holding employments in two of the tenant's companies is the
 * population whose PCB needs coordination; the detector surfaces them and the setter routes their tax
 * through one paymaster (the safe go-live default; the gated coordinator is Slice 2b).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setDesignatedPaymaster } from '../core/org';
import { concurrentEmploymentPersons } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('cross-employer paymaster (ADR-0029)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hirePersonInTwoCompanies() {
    const a = adminCtx(base);
    const e1 = await hireEmployee(a, {
      person: { fullName: 'Shared Services', primaryEmail: 'ss@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [e2] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: base.tenantId, personId: e1.personId, companyId: c2.id, hiredOn: '2025-01-01' })
      .returning({ id: schema.employment.id });
    return { a, personId: e1.personId, e1: e1.employmentId, e2: e2.id, c2: c2.id };
  }

  it('detects a person with concurrent employments across two companies', async () => {
    const { a, personId, e1, e2 } = await hirePersonInTwoCompanies();
    const rows = await concurrentEmploymentPersons(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe(personId);
    expect(rows[0].employments.map((x) => x.employmentId).sort()).toEqual([e1, e2].sort());
    expect(rows[0].designatedPaymasterEmploymentId).toBeNull();
    expect(rows[0].employments.every((x) => !x.isPaymaster)).toBe(true);
  });

  it('single-employment people are not flagged', async () => {
    const a = adminCtx(base);
    await hireEmployee(a, {
      person: { fullName: 'Solo', primaryEmail: 'solo@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    expect(await concurrentEmploymentPersons(a)).toEqual([]);
  });

  it('designates a paymaster (one of the person\'s own employments) and the detector reflects it', async () => {
    const { a, personId, e1, e2 } = await hirePersonInTwoCompanies();
    await setDesignatedPaymaster(a, { personId, designatedPaymasterEmploymentId: e1 });
    const [row] = await concurrentEmploymentPersons(a);
    expect(row.designatedPaymasterEmploymentId).toBe(e1);
    expect(row.employments.find((x) => x.employmentId === e1)!.isPaymaster).toBe(true);
    expect(row.employments.find((x) => x.employmentId === e2)!.isPaymaster).toBe(false);
  });

  it('rejects a paymaster that is not one of the person\'s active employments', async () => {
    const { a, personId } = await hirePersonInTwoCompanies();
    await expect(
      setDesignatedPaymaster(a, { personId, designatedPaymasterEmploymentId: randomUUID() }),
    ).rejects.toThrow(/active employment/i);
  });
});
