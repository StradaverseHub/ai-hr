/**
 * Feedback ef31d251 — "No employee has ever seen a payslip: the Close step is skipped every time."
 *
 * Pins the thing that had been silently broken for eighteen runs: a PROCESSED run's payslips are
 * invisible in ESS, a CLOSED one's are visible, and the two admin screens describe that through one
 * shared derivation so they cannot drift.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as schema from '../db/schema';
import { payrollPublicationState } from '@/lib/payroll-publication';
import { closeBatch, createBatch, generatePayslips, payslipDetail, unlockClosedBatch } from '../core/payroll';
import { myPayslips } from '../core/read';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setSetting,
  type Base,
} from './harness';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('payrollPublicationState (pure)', () => {
  it('maps every batch status to its publication state', () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const tomorrow = new Date(Date.now() + 86_400_000);
    // Exact strings on every arm: `not.toBe('published')` would pass on a typo'd return value and on
    // an accidental `undefined`, which is precisely the failure this helper exists to prevent.
    expect(payrollPublicationState({ status: 'draft' })).toBe('draft');
    expect(payrollPublicationState({ status: 'processed' })).toBe('unpublished');
    expect(payrollPublicationState({ status: 'closed', releasedAt: null })).toBe('published');
    expect(payrollPublicationState({ status: 'closed', releasedAt: yesterday })).toBe('published');
    expect(payrollPublicationState({ status: 'closed', releasedAt: tomorrow })).toBe('scheduled');
  });

  it('honours the injected `now` for the scheduled/published boundary', () => {
    const releasedAt = new Date('2026-03-01T00:00:00Z');
    expect(payrollPublicationState({ status: 'closed', releasedAt }, new Date('2026-02-28T23:59:59Z'))).toBe(
      'scheduled',
    );
    expect(payrollPublicationState({ status: 'closed', releasedAt }, new Date('2026-03-01T00:00:00Z'))).toBe(
      'published',
    );
  });

  it('reports an UNLOCKED run as unpublished even though its release timestamps survive', () => {
    // unlockClosedBatch (core/payroll.ts) sets ONLY `{ status: 'processed' }` — closed_at and released_at
    // are left populated. This row, where the status and the timestamp disagree, is the only shape that
    // catches a future refactor to `closedAt != null` / `releasedAt != null`; the plain processed case
    // (no timestamps) would pass under either implementation.
    expect(
      payrollPublicationState({ status: 'processed', releasedAt: new Date('2026-01-01T00:00:00Z') }),
    ).toBe('unpublished');
  });
});

// ─────────────────────────── the actual reported fault, against the DB ───────────────────────────

let base: Base;
let icSeq = 0;
const nextIc = () => `9204040${String(20000 + icSeq++).slice(-5)}`;

/** Hire + pay-structure + statutory profile, so the employee generates a real payslip. */
async function hire(name: string, basic = 5000) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: basic,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

/** An ESS session for a hired person — the context whose visibility this whole item is about. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(base.tenantId, personId, 'employee');
  return { tenantId: base.tenantId, userId, roles: ['employee'], personId };
}

const batchRow = async (batchId: string) => {
  const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return b;
};

describe('ef31d251 — a processed run is invisible in ESS, a closed one is visible', () => {
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

  it('processed ⇒ payslip exists but is NOT released; closing publishes it to the employee', async () => {
    const a = adminCtx(base);
    const emp = await hire('Publish Alice');
    const ess = await employeeCtx(emp.personId);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(a, { batchId }); // → processed

    // The slip id is captured BEFORE the close, so a null payslipDetail below cannot be blamed on a
    // missing id — the only thing left standing is the release gate this item is about.
    const [slip] = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(slip).toBeTruthy();

    // LENGTH 1 WITH released:false, not length 0. Asserting the row is absent would also pass if
    // myPayslips broke entirely, or if RLS silently excluded the row — a different bug wearing the
    // same green tick. The row must be THERE and marked not-released.
    const before = await myPayslips(ess, [emp.employmentId]);
    expect(before).toHaveLength(1);
    expect(before[0].released).toBe(false);
    expect(payrollPublicationState(await batchRow(batchId))).toBe('unpublished');
    // The second gate (ESS detail page + the PDF route) must agree with the list gate.
    expect(await payslipDetail(ess, slip.id)).toBeNull();

    await closeBatch(a, { batchId });

    const after = await myPayslips(ess, [emp.employmentId]);
    expect(after).toHaveLength(1);
    expect(after[0].released).toBe(true);
    expect(payrollPublicationState(await batchRow(batchId))).toBe('published');
    expect(await payslipDetail(ess, slip.id)).not.toBeNull();
  });

  it('an UNLOCKED run goes back to invisible, while closed_at survives on the row', async () => {
    await setSetting(base.tenantId, 'payroll.unlock_enabled', true);
    const a = adminCtx(base);
    const emp = await hire('Publish Bob');
    const ess = await employeeCtx(emp.personId);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
    expect(payrollPublicationState(await batchRow(batchId))).toBe('published');

    const su = await entitledCtx(base, ['hr_admin', 'super_admin']);
    await unlockClosedBatch(su, { batchId, reason: 'republish test' });

    const row = await batchRow(batchId);
    // LOAD-BEARING: unlockClosedBatch sets ONLY { status: 'processed' } and leaves closed_at populated.
    // Without this assertion the test would pass vacuously the day unlock starts clearing the column,
    // and would silently stop testing the thing it names — that publication is derived from `status`.
    expect(row.closedAt).not.toBeNull();
    expect(payrollPublicationState(row)).toBe('unpublished');
    const rows = await myPayslips(ess, [emp.employmentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].released).toBe(false);
  });

  it('a HISTORY-IMPORTED run reads as published although it was never closed here', async () => {
    // core/payroll-history-import.ts sets status='closed' directly, with closed_at and released_at left
    // NULL and NO payroll-batch.closed event appended. Built by hand in ONE insert because migration
    // 0011 refuses any UPDATE to an already-closed row.
    const emp = await hire('Publish Cara');
    const ess = await employeeCtx(emp.personId);

    const [period] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: base.tenantId, companyId: base.companyId, period: '2025-11', status: 'closed' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: base.tenantId,
        companyId: base.companyId,
        payPeriodId: period.id,
        payPeriod: '2025-11',
        batchDate: '2025-11-30',
        status: 'closed', // inserted closed in one shot — never updated into it
        employeeCount: 1,
      })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: base.tenantId,
      batchId: batch.id,
      employmentId: emp.employmentId,
      basicSalary: '5000.00',
      grossPay: '5000.00',
      statutory: {},
      totalDeductions: '0.00',
      netPay: '5000.00',
      employerCost: '5000.00',
    });

    const row = await batchRow(batch.id);
    expect(row.closedAt).toBeNull();
    expect(row.releasedAt).toBeNull();
    // A NULL releasedAt on a closed run means PUBLISHED — the ESS gate treats NULL as released.
    expect(payrollPublicationState(row)).toBe('published');
    const rows = await myPayslips(ess, [emp.employmentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].released).toBe(true);
    // …and this is what pins the run detail screen's no-record fallback: there is no close event to
    // read an actor or a timestamp from, so "Published by X on Y" has nothing to render. Without this
    // assertion the test would only restate the NULL-releasedAt rule.
    expect(await eventTypesFor(base.tenantId, batch.id)).not.toContain('payroll-batch.closed');
  });
});

describe('ef31d251 source guards', () => {
  it('both payroll screens derive publication from the shared helper', () => {
    // Deliberately a POSITIVE guard only. Asserting the ABSENCE of `=== 'closed'` in these files would
    // fire on constructs it is not about: the batch page legitimately tests `batch.status === 'closed'`
    // to gate the Unlock card, and the list page uses it in STATUS_STYLE.
    for (const f of ['app/payroll/page.tsx', 'app/payroll/[batchId]/page.tsx']) {
      const src = read(f);
      expect(src, f).toContain("from '@/lib/payroll-publication'");
      expect(src, f).toContain('payrollPublicationState(');
    }
  });

  it('closeAction revalidates the payroll LIST, not just the run', () => {
    // Scoped to closeAction's OWN body: a whole-file `includes()` passes vacuously because unlockAction
    // already contains this exact string. closeAction is currently last in the file, but slicing only
    // from its start would silently become whole-file-equivalent the day a function is appended below
    // it — so the slice is closed at the next top-level function too.
    const src = read('app/payroll/actions.ts');
    const start = src.indexOf('export async function closeAction');
    expect(start, 'closeAction not found — did it get renamed?').toBeGreaterThan(-1);
    const next = src.indexOf('\nexport async function', start + 1);
    const body = src.slice(start, next === -1 ? src.length : next);
    expect(body).toContain("revalidatePath('/payroll')");
  });

  it('the Close button is behind a confirmation dialog', () => {
    // Scoped to the close form's own block: ConfirmSubmit already appears three times on this page
    // (generate-with-warnings, reset, unlock), so a whole-file check passes vacuously.
    const page = read('app/payroll/[batchId]/page.tsx');
    const start = page.indexOf('<form action={closeAction}>');
    expect(start).toBeGreaterThan(-1);
    const form = page.slice(start, page.indexOf('</form>', start));
    expect(form).toContain('ConfirmSubmit');
  });
});
