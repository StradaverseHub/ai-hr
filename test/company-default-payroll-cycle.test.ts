/**
 * Organization Module — Automatic Payroll Cycle Assignment for New Companies (361e3b15).
 *
 * Proves the approved plan:
 *   • createCompany (the admin Add-company path) now SEEDS the six standard cycles AND stores the chosen
 *     default (column default 'Monthly'), so a company is payroll-ready the moment it is created; the stored
 *     default resolves to a real active cycle name.
 *   • Every creation path is born with a default — a company inserted WITHOUT specifying the column still
 *     reads 'Monthly' (the DB column default), the regression guard for the provision/seed paths.
 *   • setCompanyDefaultPayrollCycle validates against the company's ACTIVE catalog (rejecting unknown /
 *     archived names) and audits the change as a before→after DomainEvent.
 *   • preferredCycleId (the wizard Step-1 pre-select) prefers the saved default by NAME, else first regular,
 *     else first — and falls back gracefully (never blank) when the saved name is no longer active.
 *   • companiesMissingCycle + the runMultiCompanyPayroll INVALID_CYCLE outcome flag/name a company with no
 *     active cycle of the intended run type.
 *   • Future-only: a change to the default never touches an already-created batch (batches store no cycle id).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createCompany, setCompanyDefaultPayrollCycle } from '../core/admin';
import { DEFAULT_PAYROLL_CYCLES, listPayrollCycles, setPayrollCycleActive } from '../core/payroll-cycle';
import { companiesMissingCycle, runMultiCompanyPayroll } from '../core/payroll-run-group';
import { createBatch } from '../core/payroll';
import { preferredCycleId } from '../app/payroll/process/selection-logic';
import type { SessionContext } from '../db/client';

let b: Base;

/** A GROUP admin carrying EXPLICIT grants (companyId null). allowedCompanies (used by companiesMissingCycle /
 *  runMultiCompanyPayroll) reads ctx.grants in JS, so a roles-only adminCtx would resolve to no companies. */
function groupAdmin(): SessionContext {
  return { tenantId: b.tenantId, userId: b.adminUserId, grants: [{ role: 'hr_admin', companyId: null }] };
}

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

async function companyDefault(companyId: string): Promise<string> {
  const [row] = await owner.db
    .select({ d: schema.company.defaultPayrollCycle })
    .from(schema.company)
    .where(eq(schema.company.id, companyId));
  return row.d;
}

describe('createCompany seeds cycles + stores the default (361e3b15)', () => {
  it('seeds all six standard cycles and stores the default (Monthly), and the name resolves', async () => {
    const a = adminCtx(b);
    const { id } = await createCompany(a, { legalName: 'Freshco Sdn Bhd' });

    const cycles = await listPayrollCycles(a, id, { activeOnly: true });
    expect(new Set(cycles.map((c) => c.name))).toEqual(new Set(DEFAULT_PAYROLL_CYCLES.map((c) => c.name)));
    expect(cycles).toHaveLength(DEFAULT_PAYROLL_CYCLES.length);

    // Default stored + it resolves to one of the freshly-seeded ACTIVE cycle names.
    const def = await companyDefault(id);
    expect(def).toBe('Monthly');
    expect(cycles.some((c) => c.name === def)).toBe(true);

    // The company.created event carries the chosen default in its payload.
    const payload = await latestEventPayload(b.tenantId, id, 'company.created');
    expect(payload?.defaultPayrollCycle).toBe('Monthly');
  });

  it('honours a chosen default and falls back to Monthly for an unknown name', async () => {
    const a = adminCtx(b);
    const chosen = await createCompany(a, { legalName: 'Bonusco Sdn Bhd', defaultPayrollCycle: 'Bonus' });
    expect(await companyDefault(chosen.id)).toBe('Bonus');

    const garbage = await createCompany(a, { legalName: 'Junkco Sdn Bhd', defaultPayrollCycle: 'Not A Cycle' });
    expect(await companyDefault(garbage.id)).toBe('Monthly');
  });

  it('every creation path is born with a default — a directly-inserted company reads Monthly', async () => {
    // seedBase inserts the base company via the OWNER connection WITHOUT specifying default_payroll_cycle,
    // so this exercises the DB column default that covers provisionTenant / db/seed / existing rows.
    expect(await companyDefault(b.companyId)).toBe('Monthly');
  });
});

describe('setCompanyDefaultPayrollCycle — validate + audit (361e3b15)', () => {
  it('changes the default to an active cycle and emits a before→after event', async () => {
    const a = adminCtx(b);
    const { id } = await createCompany(a, { legalName: 'Changeco Sdn Bhd' });

    await setCompanyDefaultPayrollCycle(a, { companyId: id, cycleName: 'Bonus' });
    expect(await companyDefault(id)).toBe('Bonus');

    const payload = await latestEventPayload(b.tenantId, id, 'company.default-payroll-cycle.set');
    expect(payload).toEqual({ before: 'Monthly', after: 'Bonus' });
  });

  it('rejects an unknown name', async () => {
    const a = adminCtx(b);
    const { id } = await createCompany(a, { legalName: 'Rejectco Sdn Bhd' });
    await expect(setCompanyDefaultPayrollCycle(a, { companyId: id, cycleName: 'Nonexistent' })).rejects.toThrow();
    expect(await companyDefault(id)).toBe('Monthly'); // unchanged
  });

  it('rejects an ARCHIVED cycle name (no silent invalid save)', async () => {
    const a = adminCtx(b);
    const { id } = await createCompany(a, { legalName: 'Archco Sdn Bhd' });
    const offCycle = (await listPayrollCycles(a, id, { activeOnly: true })).find((c) => c.name === 'Off-cycle')!;
    await setPayrollCycleActive(a, { id: offCycle.id, active: false });
    await expect(setCompanyDefaultPayrollCycle(a, { companyId: id, cycleName: 'Off-cycle' })).rejects.toThrow();
    expect(await companyDefault(id)).toBe('Monthly'); // unchanged
  });
});

describe('preferredCycleId — wizard Step-1 pre-select (361e3b15)', () => {
  const options = [
    { id: 'm', name: 'Monthly', runType: 'regular' },
    { id: 'b', name: 'Bonus', runType: 'bonus' },
    { id: 'o', name: 'Off-cycle', runType: 'off_cycle' },
  ];

  it('prefers the saved default matched BY NAME', () => {
    expect(preferredCycleId(options, 'Bonus')).toBe('b');
  });

  it('falls back to the first regular when the saved name is not among active options (archived/renamed) — never blank', () => {
    // 'Advance Salary' is not in the (active) options — simulating an archived/renamed saved default.
    expect(preferredCycleId(options, 'Advance Salary')).toBe('m');
    expect(preferredCycleId(options, undefined)).toBe('m');
  });

  it('returns empty string when there are no options', () => {
    expect(preferredCycleId([], 'Monthly')).toBe('');
  });
});

describe('missing-cycle validation (361e3b15)', () => {
  it('companiesMissingCycle flags a company with no active cycle of the intended run type', async () => {
    const a = groupAdmin();
    const withReg = await createCompany(a, { legalName: 'HasReg Sdn Bhd' });
    const noReg = await createCompany(a, { legalName: 'NoReg Sdn Bhd' });
    // Archive the regular ("Monthly") cycle on the second company.
    const reg = (await listPayrollCycles(a, noReg.id, { activeOnly: true })).find((c) => c.runType === 'regular')!;
    await setPayrollCycleActive(a, { id: reg.id, active: false });

    const missing = await companiesMissingCycle(a, [withReg.id, noReg.id], 'regular');
    expect(missing.map((m) => m.companyId)).toEqual([noReg.id]);
    expect(missing[0].companyName).toBe('NoReg Sdn Bhd');
  });

  it('runMultiCompanyPayroll returns an INVALID_CYCLE outcome carrying the missing run type', async () => {
    const a = groupAdmin();
    const noReg = await createCompany(a, { legalName: 'Skipco Sdn Bhd' });
    const reg = (await listPayrollCycles(a, noReg.id, { activeOnly: true })).find((c) => c.runType === 'regular')!;
    await setPayrollCycleActive(a, { id: reg.id, active: false });

    const result = await runMultiCompanyPayroll(a, {
      companyIds: [noReg.id],
      payPeriod: '2026-05',
      payrollCycleId: reg.id, // now archived → intended run type defaults to 'regular'
      employmentIds: [],
    });
    const outcome = result.perCompany.find((c) => c.companyId === noReg.id)!;
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('INVALID_CYCLE');
    expect(outcome.missingCycleRunType).toBe('regular');
  });
});

describe('future-only: changing the default never touches an existing batch (361e3b15)', () => {
  it('an already-created batch is unchanged after a default change', async () => {
    const a = adminCtx(b);
    const { id } = await createCompany(a, { legalName: 'Batchco Sdn Bhd' });
    const { batchId } = await createBatch(a, { companyId: id, payPeriod: '2026-04' });
    const [before] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));

    await setCompanyDefaultPayrollCycle(a, { companyId: id, cycleName: 'Bonus' });

    const [after] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(after.runType).toBe(before.runType);
    expect(after.remarks).toBe(before.remarks);
    expect(after.status).toBe(before.status);
    expect(after.payPeriod).toBe(before.payPeriod);
  });
});
