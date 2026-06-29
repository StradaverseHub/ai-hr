/**
 * Emergency Leave (0106) — AL→UPL cascade via decomposition into child requests.
 *
 * EL is an application type only: on submission requestLeave decomposes it into up to two ordinary child
 * requests over the same dates — an ANNUAL request for the AL-covered portion and an UNPAID request for the
 * remainder — linked by a shared parent_group_id. No EMERGENCY leave_request row is ever persisted.
 *
 * Covers: the pure resolver; decomposition (full-AL, partial, zero-AL); counting-mode correctness (the AL
 * child counts in working-days, the UPL child in calendar-days); approval reusing the existing ledger path;
 * the drained-AL safety (the ANNUAL child throws InsufficientLeaveBalanceError, no silent UPL fallback); the
 * irreversibility invariant; the missing-type guard; the payroll integration (UPL child flows through
 * unpaidDaysByEmployment untouched); and the migration round-trip (parent_group_id NULL for ordinary rows).
 */
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  decideLeave,
  InsufficientLeaveBalanceError,
  LeaveDurationNotAllowedError,
  requestLeave,
  resolveEmergencyCascade,
  resolveEmergencyIllnessCascade,
  UnpaidConsentRequiredError,
} from '../core/leave';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let employmentId: string;
let annualId: string; // seedBase's ANNUAL type, counting = working_days (default for ANNUAL)
let unpaidId: string;
let sickId: string;
let emergencyId: string;

async function hire() {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Emer', primaryEmail: `emer_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
}

async function insertType(opts: {
  code: string;
  paid: boolean;
  counting: 'calendar_days' | 'working_days';
}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: opts.code,
      name: opts.code,
      paid: opts.paid,
      counting: opts.counting,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Grant a positive balance for a leave type via an accrual ledger row. */
async function grantLedger(leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}
const grantAnnual = (days: string) => grantLedger(annualId, days);
// Unpaid leave goes through the SAME balance gate as any leave at approval (finalizeLeaveApproval), so a
// tenant grants an unpaid allowance before unpaid requests can be approved — exactly as a direct UNPAID
// request requires. EL inherits this unchanged; tests that approve the UPL child grant it first.
const grantUnpaid = (days: string) => grantLedger(unpaidId, days);
// Phase-B #12: a paid SICK balance, so the illness path can prefer it before annual/unpaid.
const grantSick = (days: string) => grantLedger(sickId, days);

/** The decomposed child rows for an EL submission, ordered by start date. */
async function childRows(parentGroupId: string) {
  const rows = await owner.db
    .select({
      id: schema.leaveRequest.id,
      leaveTypeId: schema.leaveRequest.leaveTypeId,
      startDate: schema.leaveRequest.startDate,
      endDate: schema.leaveRequest.endDate,
      days: schema.leaveRequest.days,
      status: schema.leaveRequest.status,
      parentGroupId: schema.leaveRequest.parentGroupId,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.parentGroupId, parentGroupId))
    .orderBy(schema.leaveRequest.startDate);
  return rows;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  employmentId = await hire();
  annualId = b.annualLeaveTypeId;
  // seedBase's ANNUAL type defaults counting to working_days only if the column default is working_days;
  // make it explicit so the counting-mode test is deterministic regardless of the seedBase default.
  await owner.db
    .update(schema.leaveType)
    .set({ counting: 'working_days' })
    .where(eq(schema.leaveType.id, annualId));
  unpaidId = await insertType({ code: 'UNPAID', paid: false, counting: 'calendar_days' });
  // Phase-B #12: SICK is paid (EA s.60F) and counted in calendar-days, like the seeded MY SICK type.
  sickId = await insertType({ code: 'SICK', paid: true, counting: 'calendar_days' });
  emergencyId = await insertType({ code: 'EMERGENCY', paid: true, counting: 'calendar_days' });
});
afterAll(async () => {
  await closeAll();
});

describe('Emergency Leave — pure resolver', () => {
  it('AL fully covers the span → all Annual, no shortfall', () => {
    expect(resolveEmergencyCascade(10, 3)).toEqual({ alCovered: 3, alShortfall: 0 });
  });
  it('AL partially covers → split at the balance', () => {
    expect(resolveEmergencyCascade(2, 5)).toEqual({ alCovered: 2, alShortfall: 3 });
  });
  it('AL zero → all Unpaid', () => {
    expect(resolveEmergencyCascade(0, 4)).toEqual({ alCovered: 0, alShortfall: 4 });
  });
  it('negative AL balance → all Unpaid (clamped to 0)', () => {
    expect(resolveEmergencyCascade(-2, 4)).toEqual({ alCovered: 0, alShortfall: 4 });
  });
  it('fractional remainder rounds to 2 dp', () => {
    expect(resolveEmergencyCascade(1.256, 3)).toEqual({ alCovered: 1.26, alShortfall: 1.74 });
  });
});

describe('Emergency Leave — illness pure resolver (SICK → ANNUAL → UNPAID)', () => {
  it('SICK fully covers the span → all Sick, no Annual, no shortfall', () => {
    expect(resolveEmergencyIllnessCascade(10, 5, 3)).toEqual({ sickCovered: 3, alCovered: 0, alShortfall: 0 });
  });
  it('SICK partial → Sick first, then Annual for the remainder', () => {
    // 2 sick days cover 2; the remaining 3 days draw from a 5-day Annual balance (fully covered).
    expect(resolveEmergencyIllnessCascade(2, 5, 5)).toEqual({ sickCovered: 2, alCovered: 3, alShortfall: 0 });
  });
  it('SICK + ANNUAL exhausted → remainder is the unpaid shortfall', () => {
    // 1 sick + 1 annual cover 2 of 5; 3 days fall to UNPAID.
    expect(resolveEmergencyIllnessCascade(1, 1, 5)).toEqual({ sickCovered: 1, alCovered: 1, alShortfall: 3 });
  });
  it('no SICK balance → behaves exactly like the AL→UPL cascade', () => {
    expect(resolveEmergencyIllnessCascade(0, 2, 5)).toEqual({ sickCovered: 0, alCovered: 2, alShortfall: 3 });
  });
  it('negative balances clamp to 0', () => {
    expect(resolveEmergencyIllnessCascade(-3, -1, 4)).toEqual({ sickCovered: 0, alCovered: 0, alShortfall: 4 });
  });
});

describe('Emergency Leave — decomposition on submit', () => {
  it('AL ≥ span → exactly one ANNUAL child, no UPL child, shared parentGroupId', async () => {
    await grantAnnual('10.00');
    // Mon–Wed 2026-07-06..08 (3 working days, no weekend).
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
    });
    expect(res.parentGroupId).toBeTruthy();
    expect(res.children).toHaveLength(1);
    expect(res.children[0]).toMatchObject({ code: 'ANNUAL', days: 3 });
    const rows = await childRows(res.parentGroupId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(annualId);
    expect(rows[0].days).toBe('3.00');
    expect(rows[0].parentGroupId).toBe(res.parentGroupId);
    // No EMERGENCY row is ever persisted.
    const emerRows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.leaveTypeId, emergencyId));
    expect(emerRows).toHaveLength(0);
  });

  it('AL < span → ANNUAL child for the covered prefix + UNPAID child for the remainder, linked', async () => {
    await grantAnnual('1.00');
    // Mon–Wed 2026-07-06..08 (3 working days). AL covers 1 working day → ANNUAL [Mon,Mon], UNPAID [Tue,Wed].
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      unpaidConsent: true, // the split creates an UNPAID child → consent is required
    });
    expect(res.children).toHaveLength(2);
    const al = res.children.find((c) => c.code === 'ANNUAL');
    const upl = res.children.find((c) => c.code === 'UNPAID');
    expect(al).toMatchObject({ days: 1 });
    expect(upl).toMatchObject({ days: 2 }); // Tue+Wed, calendar-days
    const rows = await childRows(res.parentGroupId!);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ leaveTypeId: annualId, startDate: '2026-07-06', endDate: '2026-07-06', days: '1.00' });
    expect(rows[1]).toMatchObject({ leaveTypeId: unpaidId, startDate: '2026-07-07', endDate: '2026-07-08', days: '2.00' });
    expect(rows[0].parentGroupId).toBe(rows[1].parentGroupId);
  });

  it('AL = 0 → exactly one UNPAID child, no ANNUAL child', async () => {
    // No grant → Annual balance 0.
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      unpaidConsent: true, // the whole span falls to UNPAID → consent is required
    });
    expect(res.children).toHaveLength(1);
    expect(res.children[0]).toMatchObject({ code: 'UNPAID', days: 3 }); // 3 calendar days
    const rows = await childRows(res.parentGroupId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(unpaidId);
    expect(rows[0].days).toBe('3.00');
  });
});

describe('Emergency Leave — counting-mode correctness', () => {
  it('a span over a weekend: ANNUAL child counts working-days, UNPAID child counts calendar-days', async () => {
    // No AL → entire span falls to UNPAID, counted in calendar-days.
    // Fri 2026-07-10 .. Mon 2026-07-13 = 4 calendar days (incl Sat+Sun), 2 working days (Fri, Mon).
    const uplRes = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-10',
      endDate: '2026-07-13',
      unpaidConsent: true, // no AL → whole span is UNPAID → consent required
    });
    expect(uplRes.children[0]).toMatchObject({ code: 'UNPAID', days: 4 }); // calendar-days

    // Now give plenty of AL so the whole span is ANNUAL — counted in WORKING-days (2), not calendar (4).
    await grantAnnual('30.00');
    const alRes = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-10',
      endDate: '2026-07-13',
    });
    expect(alRes.children).toHaveLength(1);
    expect(alRes.children[0]).toMatchObject({ code: 'ANNUAL', days: 2 }); // working-days, NOT 4

    // Equivalence: the AL child's days equals a direct ANNUAL request over the same span.
    const direct = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-10',
      endDate: '2026-07-13',
    });
    expect(direct.days).toBe(2);
    expect(alRes.children[0].days).toBe(direct.days);
  });
});

describe('Emergency Leave — approval reuses the existing ledger path', () => {
  it('approving the ANNUAL child debits ANNUAL; approving the UNPAID child debits UNPAID', async () => {
    await grantAnnual('1.00');
    await grantUnpaid('5.00'); // unpaid allowance so the UPL child clears the same balance gate
    const alBefore = await ledgerBalance(employmentId, annualId);
    const uplBefore = await ledgerBalance(employmentId, unpaidId);

    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      unpaidConsent: true, // AL covers 1, the rest is UNPAID → consent required
    });
    const rows = await childRows(res.parentGroupId!);
    const alChild = rows.find((r) => r.leaveTypeId === annualId)!;
    const uplChild = rows.find((r) => r.leaveTypeId === unpaidId)!;

    await decideLeave(adminCtx(b), { leaveRequestId: alChild.id, decision: 'approved' });
    expect(await ledgerBalance(employmentId, annualId)).toBeCloseTo(alBefore - 1, 2);

    await decideLeave(adminCtx(b), { leaveRequestId: uplChild.id, decision: 'approved' });
    // UNPAID has no accrual, so its ledger balance simply reflects the debit (−2).
    expect(await ledgerBalance(employmentId, unpaidId)).toBeCloseTo(uplBefore - 2, 2);
  });
});

describe('Emergency Leave — drained-AL safety (frozen-at-submit semantics)', () => {
  it('the ANNUAL child throws InsufficientLeaveBalanceError if AL was drained before its approval', async () => {
    await grantAnnual('2.00');
    // EL split shows 2 AL + remainder UPL.
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-09', // Mon..Thu = 4 working days; AL covers 2, UPL 2.
      unpaidConsent: true, // AL covers 2, the remaining 2 days are UNPAID → consent required
    });
    const rows = await childRows(res.parentGroupId!);
    const alChild = rows.find((r) => r.leaveTypeId === annualId)!;

    // Drain AL via a SEPARATE approved Annual request before approving the EL's ANNUAL child.
    const drain = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-13',
      endDate: '2026-07-14', // 2 working days → drains the 2-day balance
    });
    await decideLeave(adminCtx(b), { leaveRequestId: drain.leaveRequestId, decision: 'approved' });

    // The EL ANNUAL child now fails its own balance gate — no silent UPL fallback.
    await expect(
      decideLeave(adminCtx(b), { leaveRequestId: alChild.id, decision: 'approved' }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);
  });
});

describe('Emergency Leave — fractional AL balance (H4)', () => {
  it('a fractional AL balance floors the ANNUAL child to whole working-days; both children are approvable', async () => {
    // 1.5 AL days (e.g. from prorated accrual / a half-day debit) over Mon..Thu (4 working days).
    // resolveEmergencyCascade returns alCovered = 1.5 (fractional). The ANNUAL child must NOT be a 2-day
    // whole-working-day count (which would exceed the 1.5 balance and be permanently unapprovable);
    // it floors to 1 working day (<= 1.5 balance) and the fractional remainder falls to UNPAID.
    await grantAnnual('1.50');
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-09', // Mon..Thu = 4 working days, 4 calendar days
      unpaidConsent: true, // the fractional remainder + shortfall fall to an UNPAID child → consent required
    });
    expect(res.children).toHaveLength(2);
    const al = res.children.find((c) => c.code === 'ANNUAL')!;
    const upl = res.children.find((c) => c.code === 'UNPAID')!;
    // ANNUAL child = floor(1.5) = 1 working day (<= the 1.5 balance, so it is approvable).
    expect(al.days).toBe(1);
    // The UNPAID child carries the rest of the span: Tue..Thu = 3 calendar days.
    expect(upl.days).toBe(3);

    const rows = await childRows(res.parentGroupId!);
    const alChild = rows.find((r) => r.leaveTypeId === annualId)!;
    const uplChild = rows.find((r) => r.leaveTypeId === unpaidId)!;
    expect(alChild.days).toBe('1.00');
    expect(uplChild.days).toBe('3.00');

    // Both children clear their own balance gate at approval — neither is permanently unapprovable.
    await grantUnpaid('5.00'); // unpaid allowance so the UPL child clears the same balance gate
    const alBefore = await ledgerBalance(employmentId, annualId);
    await decideLeave(adminCtx(b), { leaveRequestId: alChild.id, decision: 'approved' });
    expect(await ledgerBalance(employmentId, annualId)).toBeCloseTo(alBefore - 1, 2);
    await decideLeave(adminCtx(b), { leaveRequestId: uplChild.id, decision: 'approved' });
    // Remaining AL balance after the AL child's 1-day debit is the leftover fraction (0.5), un-consumed.
    expect(await ledgerBalance(employmentId, annualId)).toBeCloseTo(0.5, 2);
  });
});

describe('Emergency Leave — invariants & guards', () => {
  it('irreversibility: no cancellation/reversal path exists for an approved child', async () => {
    await grantAnnual('5.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
    });
    const rows = await childRows(res.parentGroupId!);
    await decideLeave(adminCtx(b), { leaveRequestId: rows[0].id, decision: 'approved' });
    // Partial Leave Cancellation (ADR-0065) added a cancellation primitive, but it deliberately EXCLUDES
    // Emergency-Leave children (parentGroupId != null) — restoring an EL child via the ledger without
    // re-running its cascade is unsafe. So an approved EL child has no give-back path: requestLeaveCancellation
    // rejects it, and re-deciding it is terminal.
    const api = await import('../core/leave');
    await expect(
      api.requestLeaveCancellation(adminCtx(b), { leaveRequestId: rows[0].id, cancelDates: [rows[0].startDate] }),
    ).rejects.toBeInstanceOf(api.LeaveCancellationNotAllowedError);
    // Re-deciding an already-approved request is rejected (terminal). Pass a reason (0131) so the call
    // reaches the terminal-status guard rather than the mandatory-reason guard.
    await expect(
      decideLeave(adminCtx(b), { leaveRequestId: rows[0].id, decision: 'rejected', rejectReason: 'n/a' }),
    ).rejects.toThrow(/already approved/i);
  });

  it('missing-type guard: EL submission throws when UNPAID is absent', async () => {
    await owner.db.delete(schema.leaveType).where(eq(schema.leaveType.id, unpaidId));
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: emergencyId,
        startDate: '2026-07-06',
        endDate: '2026-07-08',
      }),
    ).rejects.toThrow(/Annual and Unpaid leave types/i);
  });

  it('EL is full-day-range only: a non-full-day duration is rejected', async () => {
    await grantAnnual('5.00');
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: emergencyId,
        startDate: '2026-07-06',
        endDate: '2026-07-06',
        durationType: 'half_day_am',
      }),
    ).rejects.toBeInstanceOf(LeaveDurationNotAllowedError);
  });
});

describe('Emergency Leave — payroll integration (no payroll code change)', () => {
  it('the approved UPL child contributes its remainder to unpaidDaysByEmployment like a direct UNPAID request', async () => {
    await grantAnnual('1.00');
    await grantUnpaid('5.00'); // unpaid allowance so the UPL child clears the balance gate
    // Mon..Wed: AL covers 1 working day, UPL covers Tue+Wed (2 calendar days).
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      unpaidConsent: true, // AL covers 1, Tue+Wed are UNPAID → consent required
    });
    const rows = await childRows(res.parentGroupId!);
    const uplChild = rows.find((r) => r.leaveTypeId === unpaidId)!;
    await decideLeave(adminCtx(b), { leaveRequestId: uplChild.id, decision: 'approved' });

    // Mirror core/payroll.ts unpaidDaysByEmployment exactly (private fn): sum approved paid=false
    // leave_request.days whose startDate falls in the period, grouped by employment.
    const periodStart = '2026-07-01';
    const periodEnd = '2026-07-31';
    const unpaidRows = await owner.db
      .select({ days: schema.leaveRequest.days })
      .from(schema.leaveRequest)
      .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveRequest.leaveTypeId))
      .where(
        and(
          eq(schema.leaveRequest.status, 'approved'),
          eq(schema.leaveType.paid, false),
          eq(schema.leaveRequest.employmentId, employmentId),
          gte(schema.leaveRequest.startDate, periodStart),
          lte(schema.leaveRequest.startDate, periodEnd),
        ),
      );
    const total = unpaidRows.reduce((s, x) => s + Number(x.days), 0);
    expect(total).toBeCloseTo(2, 2); // the UPL remainder flows through unchanged
    expect(unpaidRows).toHaveLength(1);
  });
});

describe('Emergency Leave — unpaid consent gate (Phase-B #12)', () => {
  it('AL exhausted + no consent → UnpaidConsentRequiredError, no child rows created', async () => {
    // No AL grant → the whole span would fall to UNPAID. Without consent this must throw and create nothing.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: emergencyId,
        startDate: '2026-07-06',
        endDate: '2026-07-08',
        // unpaidConsent omitted (false)
      }),
    ).rejects.toBeInstanceOf(UnpaidConsentRequiredError);

    // No leave_request rows were created (the throw happened before any insert).
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows).toHaveLength(0);
  });

  it('partial AL + no consent → UnpaidConsentRequiredError (the shortfall would be unpaid)', async () => {
    await grantAnnual('1.00'); // covers 1 of 3 working days; the remaining 2 would be UNPAID
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: emergencyId,
        startDate: '2026-07-06',
        endDate: '2026-07-08',
      }),
    ).rejects.toBeInstanceOf(UnpaidConsentRequiredError);
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows).toHaveLength(0);
  });

  it('AL fully covers the span → no consent needed (no UNPAID child)', async () => {
    await grantAnnual('10.00');
    // 3 working days fully covered by AL → a single ANNUAL child, no consent flag required.
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
    });
    expect(res.children).toHaveLength(1);
    expect(res.children[0]).toMatchObject({ code: 'ANNUAL' });
  });

  it('with consent → ANNUAL + UNPAID children created, unpaid_consent_at stamped on the UNPAID child + EL event', async () => {
    await grantAnnual('1.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      unpaidConsent: true,
    });
    expect(res.children).toHaveLength(2);
    const rows = await childRows(res.parentGroupId!);
    const alRow = rows.find((r) => r.leaveTypeId === annualId)!;
    const uplRow = rows.find((r) => r.leaveTypeId === unpaidId)!;

    // The consent stamp lands on the UNPAID child (the row whose unpaid status the employee consented to).
    const [uplFull] = await owner.db
      .select({ unpaidConsentAt: schema.leaveRequest.unpaidConsentAt })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, uplRow.id));
    expect(uplFull.unpaidConsentAt).not.toBeNull();
    // The ANNUAL child carries no consent stamp (it is paid).
    const [alFull] = await owner.db
      .select({ unpaidConsentAt: schema.leaveRequest.unpaidConsentAt })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, alRow.id));
    expect(alFull.unpaidConsentAt).toBeNull();

    // The EL command event records that consent was captured.
    const payload = await latestEventPayload(b.tenantId, res.parentGroupId!, 'leave-request.emergency.submitted');
    expect(payload?.unpaidConsent).toBe(true);
    expect(payload?.unpaidConsentAt).toBeTruthy();
  });
});

describe('Emergency Leave — illness routing prefers paid SICK (Phase-B #12)', () => {
  it('illness + SICK balance → a paid SICK child is created before any ANNUAL/UNPAID', async () => {
    await grantSick('10.00'); // ample paid sick balance
    await grantAnnual('5.00'); // annual exists but must NOT be used first for an illness
    // 3 working days, all covered by SICK → a single SICK child, no UNPAID, no consent needed.
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      reasonCategory: 'illness',
    });
    expect(res.children).toHaveLength(1);
    expect(res.children[0]).toMatchObject({ code: 'SICK' });
    const rows = await childRows(res.parentGroupId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(sickId);
    expect(rows[0].days).toBe('3.00');
    // Annual balance is untouched (no ANNUAL child).
    expect(await ledgerBalance(employmentId, annualId)).toBeCloseTo(5, 2);
  });

  it('illness + partial SICK → SICK then ANNUAL, no unpaid (no consent needed)', async () => {
    await grantSick('1.00'); // covers 1 working day
    await grantAnnual('5.00'); // covers the remaining 2 working days
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      reasonCategory: 'illness',
    });
    const codes = res.children.map((c) => c.code).sort();
    expect(codes).toEqual(['ANNUAL', 'SICK']);
    // No UNPAID child → consent was not required even though it was not passed.
    expect(res.children.some((c) => c.code === 'UNPAID')).toBe(false);
  });

  it('illness + SICK & ANNUAL exhausted + no consent → UnpaidConsentRequiredError', async () => {
    await grantSick('1.00');
    await grantAnnual('1.00');
    // 3 working days: SICK covers 1, ANNUAL covers 1, the last day would be UNPAID → consent required.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: emergencyId,
        startDate: '2026-07-06',
        endDate: '2026-07-08',
        reasonCategory: 'illness',
      }),
    ).rejects.toBeInstanceOf(UnpaidConsentRequiredError);
  });

  it('non-illness category keeps the ANNUAL→UNPAID path (SICK is ignored)', async () => {
    await grantSick('10.00'); // a sick balance exists but must NOT be used for a 'personal' emergency
    await grantAnnual('1.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
      reasonCategory: 'personal',
      unpaidConsent: true,
    });
    // ANNUAL covers 1, the rest UNPAID — no SICK child.
    expect(res.children.some((c) => c.code === 'SICK')).toBe(false);
    expect(res.children.map((c) => c.code).sort()).toEqual(['ANNUAL', 'UNPAID']);
  });
});

describe('Emergency Leave — migration round-trip', () => {
  it('parent_group_id is NULL for an ordinary (non-EL) request', async () => {
    await grantAnnual('5.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
    });
    const [row] = await owner.db
      .select({ parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, r.leaveRequestId));
    expect(row.parentGroupId).toBeNull();
    // The partial index tolerates NULLs: a plain query filtering on NULL returns the ordinary row.
    const nulls = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(isNull(schema.leaveRequest.parentGroupId));
    expect(nulls.some((n) => n.id === r.leaveRequestId)).toBe(true);
  });
});
