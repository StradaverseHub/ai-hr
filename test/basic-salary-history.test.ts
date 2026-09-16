/**
 * Basic Salary history redesign (feedback 87c82b18; edit/delete redesign 7c7c2f80). Pins the
 * service-level contract the redesigned screen relies on:
 *   1. remarks persist and compensationHistoryDetailed returns rows newest-first with the creating actor.
 *   2. Allowance CARRY-FORWARD — a basic-salary-only revision must NOT wipe the monthly allowance
 *      (it feeds the OT ORP wage basis); an explicit 0 still zeroes it.
 *   3. Edit-in-place of the OPEN row (amount / remarks / EFFECTIVE DATE), historical rows immutable.
 *   4. Effective-date moves keep the temporal chain contiguous (adjacent row re-closed), reject
 *      overlaps, and refuse to cross a CLOSED payroll period.
 *   5. Soft delete (supersede): hidden from history AND from payroll resolution (the prior record
 *      reopens); blocked when the record's window overlaps a CLOSED payroll run (service + 0277 DB
 *      trigger); audited via a redacted compensation.superseded event.
 *   6. RLS: the employee themselves and a payroll partner can neither supersede nor hard-DELETE a
 *      salary record (0277 restrictive FOR DELETE policy + the FOR ALL policy's WITH CHECK).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { person as personTable } from '../db/schema';
import {
  compensationHistoryDetailed,
  currentCompensation,
  overlapsClosedPeriod,
  setCompensation,
  supersedeCompensation,
  updateCompensation,
} from '../core/comp';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
  harnessSnapshot,
} from './harness';

let icSeq = 0;
const nextIc = () => `9005050${String(10000 + icSeq++).slice(-5)}`;

describe('basic salary history (87c82b18 / 7c7c2f80)', () => {
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

  // An admin context whose app_user is linked to a person, so Created By resolves to a real name
  // (the seedBase admin has personId=null → the column is legitimately null).
  const adminWithName = async (fullName: string): Promise<SessionContext> => {
    const [p] = await owner.db
      .insert(personTable)
      .values({ tenantId: base.tenantId, fullName, primaryEmail: `${fullName.replace(/\s+/g, '.').toLowerCase()}@acme.test` })
      .returning({ id: personTable.id });
    const userId = await createAppUser(base.tenantId, p.id, 'hr_admin');
    return { tenantId: base.tenantId, userId, roles: ['hr_admin'] };
  };

  const hire = (name: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  /** Hire + statutory profile, ready for payroll generation. */
  const hireForPayroll = async (name: string) => {
    const e = await hire(name);
    await setStatutoryProfileMY(adminCtx(base), { personId: e.personId, icNumber: nextIc() });
    return e;
  };

  /** createBatch → generate → close for the seeded company, so `period` is a CLOSED payroll period. */
  const runClosedPayroll = async (period: string) => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
    return batchId;
  };

  it('persists remarks and returns detailed history newest-first with creator name', async () => {
    const a = await adminWithName('Ada Admin');
    const { employmentId } = await hire('Ada');
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      effectiveFrom: '2026-01-01',
      remarks: 'initial salary',
    });
    await setCompensation(a, {
      employmentId,
      basicSalary: 5500,
      effectiveFrom: '2026-06-01',
      remarks: 'annual increment',
    });

    const rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].validFrom).toBe('2026-06-01');
    expect(rows[0].remarks).toBe('annual increment');
    expect(rows[1].remarks).toBe('initial salary');
    // Created-by is resolved from the compensation.set event actor → person.
    expect(rows[0].createdByName).toBeTruthy();
  });

  it('carries the monthly allowance forward on a basic-only revision', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Ben');
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      monthlyAllowance: 500,
      effectiveFrom: '2026-01-01',
    });
    // Basic-only revision: monthlyAllowance omitted → must keep 500, not reset to 0.
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    const cur = await currentCompensation(a, employmentId);
    expect(Number(cur?.basicSalary)).toBe(6000);
    expect(Number(cur?.monthlyAllowance)).toBe(500);
  });

  it('an explicit allowance of 0 still zeroes it', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Cara');
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      monthlyAllowance: 500,
      effectiveFrom: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-06-01',
    });
    const cur = await currentCompensation(a, employmentId);
    expect(Number(cur?.monthlyAllowance)).toBe(0);
  });

  it('edits the latest (open) salary record in place and stamps updatedAt', async () => {
    const a = await adminWithName('Dora Admin');
    const { employmentId } = await hire('Dora');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    const before = await compensationHistoryDetailed(a, employmentId);
    expect(before[0].updatedAt).toBeNull();

    await updateCompensation(a, {
      compensationId: before[0].id,
      employmentId,
      basicSalary: 5200,
      remarks: 'correction',
    });

    const after = await compensationHistoryDetailed(a, employmentId);
    expect(after).toHaveLength(1); // edit-in-place, NOT a new revision
    expect(Number(after[0].basicSalary)).toBe(5200);
    expect(after[0].remarks).toBe('correction');
    expect(after[0].updatedAt).not.toBeNull();
    // The editing actor is audit-trail data (compensation.updated event), no longer a screen column.
    expect(await eventTypesFor(base.tenantId, after[0].id)).toContain('compensation.updated');
  });

  it('refuses to edit a historical (closed) salary record', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Evan');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 5500, effectiveFrom: '2026-06-01' });
    const rows = await compensationHistoryDetailed(a, employmentId);
    const historical = rows.find((r) => r.validTo != null)!; // the closed 5000 row
    await expect(
      updateCompensation(a, { compensationId: historical.id, employmentId, basicSalary: 9999 }),
    ).rejects.toThrow();
  });

  // ── Effective-date edit (7c7c2f80 #3) ──────────────────────────────────────────────────────────

  it('moves the open record’s effective date and re-closes the adjacent previous record', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Faye');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    const [open] = await compensationHistoryDetailed(a, employmentId);

    // Move LATER: the previous row extends into the vacated window.
    await updateCompensation(a, { compensationId: open.id, employmentId, validFrom: '2026-07-01' });
    let rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows[0].validFrom).toBe('2026-07-01');
    expect(rows[1].validTo).toBe('2026-07-01');

    // Move EARLIER: the previous row shrinks to the new boundary.
    await updateCompensation(a, { compensationId: open.id, employmentId, validFrom: '2026-03-01' });
    rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows[0].validFrom).toBe('2026-03-01');
    expect(rows[1].validTo).toBe('2026-03-01');

    // The audit event records the date change without any pay figures.
    const payload = await latestEventPayload(base.tenantId, open.id, 'compensation.updated');
    expect(payload?.fieldsChanged).toContain('validFrom');
    expect(payload?.basicSalary).toBeUndefined();
  });

  it('rejects an effective-date move that would swallow the previous record', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Gina');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    const [open] = await compensationHistoryDetailed(a, employmentId);
    await expect(
      updateCompensation(a, { compensationId: open.id, employmentId, validFrom: '2026-01-01' }),
    ).rejects.toThrow(/previous salary record/);
    await expect(
      updateCompensation(a, { compensationId: open.id, employmentId, validFrom: '2025-12-01' }),
    ).rejects.toThrow(/previous salary record/);
    // Nothing moved.
    const rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows[0].validFrom).toBe('2026-06-01');
    expect(rows[1].validTo).toBe('2026-06-01');
  });

  it('refuses to move an effective date across a CLOSED payroll period', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hireForPayroll('Hana');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    await runClosedPayroll('2026-05'); // May is now a closed, paid period

    const [open] = await compensationHistoryDetailed(a, employmentId);
    // Jun→Apr crosses the closed May period: blocked with a clear message.
    await expect(
      updateCompensation(a, { compensationId: open.id, employmentId, validFrom: '2026-04-01' }),
    ).rejects.toThrow(/closed payroll period/);
    // Jun→Jul does not touch May: allowed.
    await updateCompensation(a, { compensationId: open.id, employmentId, validFrom: '2026-07-01' });
    const rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows[0].validFrom).toBe('2026-07-01');
  });

  // ── Soft delete (7c7c2f80 #4) ──────────────────────────────────────────────────────────────────

  it('supersedes a record: hidden from history, prior record reopens for payroll resolution', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hireForPayroll('Ivan');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 8000, effectiveFrom: '2026-06-01' });
    const [open] = await compensationHistoryDetailed(a, employmentId);
    expect(Number(open.basicSalary)).toBe(8000);

    await supersedeCompensation(a, { compensationId: open.id, employmentId });

    // Gone from history; the prior record is OPEN again (validTo null) …
    const rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].basicSalary)).toBe(5000);
    expect(rows[0].validTo).toBeNull();
    // … and payroll resolution uses it: a fresh draft run pays the prior amount.
    expect(Number((await currentCompensation(a, employmentId))?.basicSalary)).toBe(5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    const [slip] = await owner.db
      .select({ basic: schema.payslip.basicSalary })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(Number(slip.basic)).toBe(5000);

    // Audited, redacted: who/what/when + reference — never the amount (PDPA redact-to-reference).
    expect(await eventTypesFor(base.tenantId, open.id)).toContain('compensation.superseded');
    const payload = await latestEventPayload(base.tenantId, open.id, 'compensation.superseded');
    expect(payload?.employmentId).toBe(employmentId);
    expect(payload?.effectiveFrom).toBe('2026-06-01');
    expect(payload?.basicSalary).toBeUndefined();
  });

  it('refuses to supersede a record whose window overlaps a CLOSED payroll period (service + trigger)', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hireForPayroll('Jude');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await runClosedPayroll('2026-05');

    const [open] = await compensationHistoryDetailed(a, employmentId);
    await expect(supersedeCompensation(a, { compensationId: open.id, employmentId })).rejects.toThrow(
      /closed payroll run/,
    );
    // DB backstop (0277 trigger): even a direct owner-role supersede or DELETE is refused. (drizzle
    // wraps the PG error as "Failed query: …", so the trigger's message is asserted via `cause`.)
    const pgMessage = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return '';
      } catch (e) {
        return `${(e as Error).message} ${(e as Error).cause ?? ''}`;
      }
    };
    expect(
      await pgMessage(
        owner.db
          .update(schema.compensation)
          .set({ supersededAt: new Date() })
          .where(eq(schema.compensation.id, open.id)),
      ),
    ).toMatch(/closed payroll period/);
    expect(
      await pgMessage(owner.db.delete(schema.compensation).where(eq(schema.compensation.id, open.id))),
    ).toMatch(/closed payroll period/);
    // Record intact.
    expect(await compensationHistoryDetailed(a, employmentId)).toHaveLength(1);
  });

  it('supersede is idempotent-hostile: a second delete of the same record is refused', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Kira');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    const [open] = await compensationHistoryDetailed(a, employmentId);
    await supersedeCompensation(a, { compensationId: open.id, employmentId });
    await expect(supersedeCompensation(a, { compensationId: open.id, employmentId })).rejects.toThrow(
      /already been deleted/,
    );
  });

  // ── RLS (7c7c2f80 security prerequisite) ───────────────────────────────────────────────────────

  it('RLS: the employee themselves and a payroll partner can neither supersede nor hard-DELETE', async () => {
    const a = adminCtx(base);
    const emp = await hire('Liam');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 7000, effectiveFrom: '2026-01-01' });
    const [row] = await compensationHistoryDetailed(a, emp.employmentId);

    // The employee themselves (RLS self-read branch lets them SEE the row).
    const uE = await createAppUser(base.tenantId, emp.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: emp.personId, entitlements: harnessSnapshot(base.tenantId) };
    // A payroll partner for the company (reads comp to generate payslips; must not mutate it).
    const [uP] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: uP.id, companyId: base.companyId, role: 'payroll_partner' });
    const pCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: uP.id,
      grants: [{ role: 'payroll_partner', companyId: base.companyId }],
    };

    // Soft delete is an UPDATE → the FOR ALL policy's WITH CHECK (admin / perf-comp only) refuses both.
    await expect(
      supersedeCompensation(eCtx, { compensationId: row.id, employmentId: emp.employmentId }),
    ).rejects.toThrow();
    await expect(
      supersedeCompensation(pCtx, { compensationId: row.id, employmentId: emp.employmentId }),
    ).rejects.toThrow();

    // Hard DELETE → the 0277 RESTRICTIVE FOR DELETE policy filters the row out: 0 rows affected, row survives.
    await withTenant(eCtx, (tx) => tx.delete(schema.compensation).where(eq(schema.compensation.id, row.id)));
    await withTenant(pCtx, (tx) => tx.delete(schema.compensation).where(eq(schema.compensation.id, row.id)));
    const survivors = await owner.db
      .select({ id: schema.compensation.id })
      .from(schema.compensation)
      .where(eq(schema.compensation.id, row.id));
    expect(survivors).toHaveLength(1);
  });

  // ── Pure helper ────────────────────────────────────────────────────────────────────────────────

  it('overlapsClosedPeriod: month windows, open-ended rows, and the December rollover', () => {
    // Open-ended row starting before/inside the period overlaps; starting after does not.
    expect(overlapsClosedPeriod(['2026-05'], '2026-01-01', null)).toBe(true);
    expect(overlapsClosedPeriod(['2026-05'], '2026-06-01', null)).toBe(false);
    // Closed row strictly before the period does not overlap ('[)' semantics).
    expect(overlapsClosedPeriod(['2026-05'], '2026-01-01', '2026-05-01')).toBe(false);
    expect(overlapsClosedPeriod(['2026-05'], '2026-01-01', '2026-05-02')).toBe(true);
    // December → January rollover.
    expect(overlapsClosedPeriod(['2026-12'], '2026-12-15', null)).toBe(true);
    expect(overlapsClosedPeriod(['2026-12'], '2027-01-01', null)).toBe(false);
    expect(overlapsClosedPeriod([], '2026-01-01', null)).toBe(false);
  });
});
