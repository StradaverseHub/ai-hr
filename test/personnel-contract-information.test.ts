/**
 * Item 8590615a — Contract Employment Information on the Personnel (Admin) Employment tab.
 *
 * WHAT WAS ACTUALLY MISSING (measured before building): `employment.contract_end_date` already existed
 * (migration 0110) and was already editable — as a bare "End Date" row inside Employment Review on the
 * OTHERS tab, which is why the reporter could not find it. Migration 0388 adds only `contract_start_date`
 * and `contract_remark`; the end date is REUSED, not duplicated.
 *
 * Covers:
 *  - a valid contract period saves, and employeeDetail projects all three fields;
 *  - end ≤ start is rejected (both the equal and the earlier case), and start < hire date is rejected;
 *  - both dates are required FOR A CONTRACT EMPLOYEE (resolved through assignment.employment_type — the
 *    type is NOT on `employment`), but only when the submit carries the contract block;
 *  - a probation-only save on a contract employee with no contract dates recorded is NOT retro-blocked;
 *  - a non-contract employee is unaffected, including when the submit carries contract fields;
 *  - contractRemark is FREE TEXT: arbitrary prose saves and is never catalog-validated;
 *  - the `employment.info.updated` payload carries all three in fields/before/after (Change History);
 *  - the two-homes fix: a contract hire seeds contract_start_date/contract_end_date at hire, so its review
 *    window opens off the real column rather than the provisionalEndOn fallback — while a full_time hire
 *    still relies on that fallback (deliberately unchanged).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { employeeDetail } from '../core/read';
import { computeReviewWindow } from '../core/employment-review';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hire(
  name: string,
  employmentType: 'full_time' | 'part_time' | 'contract' | 'intern' = 'contract',
  opts: { hiredOn?: string; provisionalEndOn?: string | null } = {},
) {
  return hireEmployee(adminCtx(b), {
    person: {
      fullName: name,
      primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local`,
    },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType,
    hiredOn: opts.hiredOn ?? '2026-01-01',
    provisionalEndOn: opts.provisionalEndOn ?? null,
  });
}

const readEmployment = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1)
    .then((r) => r[0]);

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('8590615a — contract information on the Employment tab', () => {
  it('saves a valid contract period and projects all three fields through employeeDetail', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Alpha');
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      contractRemark: 'Initial 12-month employment contract. Renewable upon performance review.',
    });

    const d = await employeeDetail(a, e.employmentId);
    expect(d!.contractStartDate).toBe('2026-01-01');
    expect(d!.contractEndDate).toBe('2026-12-31');
    expect(d!.contractRemark).toBe('Initial 12-month employment contract. Renewable upon performance review.');
  });

  it('writes the SAME column the employment review reads (one date, not two homes)', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Shared');
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      contractStartDate: '2026-02-01',
      contractEndDate: '2026-08-31',
    });
    const row = await readEmployment(e.employmentId);
    // The physical column the Others-tab Employment Review row and sweepDueReviews both read.
    expect(row.contractEndDate).toBe('2026-08-31');
    expect(
      computeReviewWindow('contract', {
        probationEndDate: row.probationEndDate,
        contractEndDate: row.contractEndDate,
        internshipEndDate: row.internshipEndDate,
      }),
    ).toEqual({ reviewType: 'contract', endDate: '2026-08-31', dueDate: '2026-07-31' });
  });

  it('rejects an end date that is not strictly later than the start date', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Backwards');
    await expect(
      setEmploymentInfo(a, {
        employmentId: e.employmentId,
        contractStartDate: '2026-06-01',
        contractEndDate: '2026-05-31',
      }),
    ).rejects.toThrow('Contract end date must be later than the contract start date.');
    // Equal dates are a zero-length contract — also rejected ("later than", not "not earlier than").
    await expect(
      setEmploymentInfo(a, {
        employmentId: e.employmentId,
        contractStartDate: '2026-06-01',
        contractEndDate: '2026-06-01',
      }),
    ).rejects.toThrow('Contract end date must be later than the contract start date.');
    // Nothing was written by either refusal.
    const row = await readEmployment(e.employmentId);
    expect(row.contractStartDate).toBe('2026-01-01'); // the at-hire seed, untouched
  });

  it('rejects a contract start date earlier than the group join date', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Early', 'contract', { hiredOn: '2026-03-01' });
    await expect(
      setEmploymentInfo(a, {
        employmentId: e.employmentId,
        contractStartDate: '2026-02-01',
        contractEndDate: '2026-12-31',
      }),
    ).rejects.toThrow('Contract start date cannot be earlier than the hire date.');
  });

  it('requires BOTH dates for a contract employee when the submit carries the contract block', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Half');
    await expect(
      setEmploymentInfo(a, {
        employmentId: e.employmentId,
        contractStartDate: '2026-01-01',
        contractEndDate: '', // HR cleared the expiry date
      }),
    ).rejects.toThrow('Contract start date and contract end date are required for a contract employee.');
    await expect(
      setEmploymentInfo(a, {
        employmentId: e.employmentId,
        contractStartDate: null,
        contractEndDate: '2026-12-31',
      }),
    ).rejects.toThrow('Contract start date and contract end date are required for a contract employee.');
  });

  it('does NOT retro-block a probation/notice-only save on a contract employee with no dates recorded', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Legacy');
    // Simulate a contract employee who predates this feature: no contract dates at all.
    await owner.db
      .update(schema.employment)
      .set({ contractStartDate: null, contractEndDate: null })
      .where(eq(schema.employment.id, e.employmentId));

    // A save that does not carry the contract fields must go through untouched — the required-pair rule is
    // gated on the submit, not on the employee.
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      probationValue: 3,
      probationUnit: 'month',
    });
    const row = await readEmployment(e.employmentId);
    expect(row.probationValue).toBe(3);
    expect(row.contractEndDate).toBeNull();
  });

  it('leaves a non-contract employee unaffected, even when the submit carries contract fields', async () => {
    const a = adminCtx(b);
    const e = await hire('Permanent Person', 'full_time');
    // Only one date supplied: for a contract employee this would be refused. A full_time employee is not
    // subject to the pair rule at all (the block never renders for them; a forged submit still validates
    // ordering, but nothing is required).
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      contractStartDate: '2026-02-01',
    });
    const row = await readEmployment(e.employmentId);
    expect(row.contractStartDate).toBe('2026-02-01');
    expect(row.contractEndDate).toBeNull();
    // The at-hire contract seeding is contract-only — a full_time hire keeps provisional_end_on alone.
    expect(row.provisionalEndOn).toBeNull();
  });

  it('accepts arbitrary free text in the remark (never catalog-validated)', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Remark');
    const prose = 'Project-based employment — Government contract assignment #A/2026/17; renew on review.';
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      contractRemark: prose,
    });
    expect((await readEmployment(e.employmentId)).contractRemark).toBe(prose);
    // A blank remark clears it, exactly like every other optional text column.
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      contractRemark: '',
    });
    expect((await readEmployment(e.employmentId)).contractRemark).toBeNull();
  });

  it('records all three fields in the Change History diff', async () => {
    const a = adminCtx(b);
    const e = await hire('Contract Audit');
    await setEmploymentInfo(a, {
      employmentId: e.employmentId,
      contractStartDate: '2026-01-01',
      contractEndDate: '2027-01-31',
      contractRemark: 'Renewable upon performance review.',
    });
    const payload = await latestEventPayload(b.tenantId, e.employmentId, 'employment.info.updated');
    expect(payload).not.toBeNull();
    const fields = payload!.fields as string[];
    expect(fields).toContain('contractStartDate');
    expect(fields).toContain('contractEndDate');
    expect(fields).toContain('contractRemark');
    const before = payload!.before as Record<string, unknown>;
    const after = payload!.after as Record<string, unknown>;
    expect(before).toHaveProperty('contractEndDate');
    expect(before).toHaveProperty('contractRemark');
    expect(after.contractEndDate).toBe('2027-01-31');
    expect(after.contractRemark).toBe('Renewable upon performance review.');
  });
});

describe('8590615a — the two-homes fix at hire', () => {
  it('a contract hire seeds contract_start_date + contract_end_date, so the review needs no fallback', async () => {
    const e = await hire('Contract Hire', 'contract', { hiredOn: '2026-01-01', provisionalEndOn: '2026-12-31' });
    const row = await readEmployment(e.employmentId);
    expect(row.contractStartDate).toBe('2026-01-01'); // mirrors the joinDate = hiredOn seeding
    expect(row.contractEndDate).toBe('2026-12-31');
    expect(row.provisionalEndOn).toBe('2026-12-31'); // still written — nothing was taken away
    // No provisionalEndOn supplied to computeReviewWindow: the window must still open, off the real column.
    expect(
      computeReviewWindow('contract', {
        probationEndDate: row.probationEndDate,
        contractEndDate: row.contractEndDate,
        internshipEndDate: row.internshipEndDate,
      })?.endDate,
    ).toBe('2026-12-31');
  });

  it('a full_time hire still relies on the provisionalEndOn fallback (deliberately unchanged)', async () => {
    const e = await hire('Probation Hire', 'full_time', { hiredOn: '2026-01-01', provisionalEndOn: '2026-04-01' });
    const row = await readEmployment(e.employmentId);
    expect(row.probationEndDate).toBeNull(); // hireEmployee has never written this column
    expect(row.provisionalEndOn).toBe('2026-04-01');
    expect(row.contractStartDate).toBeNull();
    expect(row.contractEndDate).toBeNull();
    // Without the fallback there is no end date at all — this is the line the plan forbids removing.
    expect(
      computeReviewWindow('full_time', {
        probationEndDate: row.probationEndDate,
        contractEndDate: row.contractEndDate,
        internshipEndDate: row.internshipEndDate,
      })?.endDate,
    ).toBeNull();
    expect(
      computeReviewWindow('full_time', {
        probationEndDate: row.probationEndDate,
        contractEndDate: row.contractEndDate,
        internshipEndDate: row.internshipEndDate,
        provisionalEndOn: row.provisionalEndOn,
      })?.endDate,
    ).toBe('2026-04-01');
  });
});
