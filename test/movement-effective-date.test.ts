/**
 * 941c9dac — "Syncing movement effective dates with employment data".
 *
 * THE FAULT. Every movement went straight to the existing writers, which CLOSE the open dated row and
 * INSERT a new one carrying the movement's effective date — leaving the NEW row open. The Employment tab
 * (and the ESS profile, the directory, the org chart and analytics) all resolve "current" as the OPEN row
 * rather than as-of today, so a promotion keyed today and effective next month became current the moment
 * it was saved. `writer still leaves a future row open` below pins that mechanism in place: it is the
 * reason the fix defers the WRITE instead of changing ~60 reads, and it is what would silently return if
 * a future movement ever went straight to the writers again.
 *
 * THE SHAPE OF THE FIX. A future-dated movement is recorded as an INTENT — one
 * `employment.movement.scheduled` event and nothing else — and the nightly sweep applies it on the morning
 * of its effective date. Pending / Applied / Superseded / Reversed are DERIVED from the ledger plus today,
 * never stored, so they cannot drift out of step with the events they summarise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setEmploymentAssignment } from '../core/org';
import { createJobGrade } from '../core/admin';
import {
  createMovementEvent,
  editMovementEvent,
  movementCurrentState,
  movementHistory,
  reverseMovementEvent,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `mvd_${randomUUID().slice(0, 8)}@t.local`;

/** ISO date + n days, pure UTC string maths (the codebase's dayBefore/addDaysIso convention). */
function plusDays(iso: string, n: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

const TODAY = todayInKualaLumpur();
const FUTURE = plusDays(TODAY, 30);
const PAST = plusDays(TODAY, -30);

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Effective Date Test', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

const assignmentsOf = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.assignment)
    .where(eq(schema.assignment.employmentId, employmentId));

const rowById = (rows: Awaited<ReturnType<typeof movementHistory>>, id: string) =>
  rows.find((r) => r.id === id)!;

/** The applications the sweep recorded against ONE employment — the isolation-proof form of "it ran". */
const appliedEventsFor = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, b.tenantId),
        eq(schema.domainEvent.subjectEmploymentId, employmentId),
        eq(schema.domainEvent.eventType, 'employment.movement.applied'),
      ),
    );

describe('the fault this item fixes', () => {
  /**
   * NOT a test of the new behaviour — a test of the MECHANISM. setEmploymentAssignment is unchanged and
   * still leaves a future-dated version as the OPEN row; that is precisely why a future movement must not
   * reach it. If someone "simplifies" the dispatcher back into calling the writer directly, this test
   * keeps passing and the ones below start failing, which is the correct division of labour.
   */
  it('writer still leaves a future row open, which is what the Employment tab reads', async () => {
    const { employmentId } = await hireOne();
    await setEmploymentAssignment(adminCtx(b), {
      employmentId,
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });
    const rows = await assignmentsOf(employmentId);
    const open = rows.find((r) => r.validTo === null)!;
    expect(open.validFrom).toBe(FUTURE);
    expect(open.departmentId).toBe(b.deptB); // the future department, open and therefore "current"
  });
});

describe('recording a movement', () => {
  it('dated in the FUTURE changes nothing today and reads as pending', async () => {
    const { employmentId } = await hireOne();
    const before = await movementCurrentState(adminCtx(b), employmentId);

    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
      remarks: 'Moves next month',
    });

    // The Employment tab's own baseline read is untouched...
    const after = await movementCurrentState(adminCtx(b), employmentId);
    expect(after.departmentId).toBe(before.departmentId);
    expect(after.departmentId).toBe(b.deptA);

    // ...and no dated row was written at all: the ONE assignment row is still the hire's.
    const rows = await assignmentsOf(employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].validTo).toBeNull();

    // Exactly one scheduled event, and no assignment-changed event.
    const types = await eventTypesFor(b.tenantId, employmentId);
    expect(types).toContain('employment.movement.scheduled');
    const asgTypes = await eventTypesFor(b.tenantId, rows[0].id);
    expect(asgTypes).not.toContain('employment.assignment.changed');

    // It is visible on the history as Pending, carrying BOTH dates.
    const hist = await movementHistory(adminCtx(b), employmentId);
    const mv = hist.find((r) => r.kind === 'transfer')!;
    expect(mv.status).toBe('pending');
    expect(mv.effectiveDate).toBe(FUTURE);
    expect(mv.entryDate).toBe(TODAY); // captured automatically, not chosen
    expect(mv.remarks).toBe('Moves next month');
  });

  it('dated TODAY applies immediately on save — it does not wait for the sweep', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: TODAY,
      departmentId: b.deptB,
    });
    const cur = await movementCurrentState(adminCtx(b), employmentId);
    expect(cur.departmentId).toBe(b.deptB);
    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(rowById(hist, hist.find((r) => r.kind === 'transfer')!.id).status).toBe('applied');
  });

  it('dated in the PAST applies immediately on save', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: PAST,
      departmentId: b.deptB,
    });
    const cur = await movementCurrentState(adminCtx(b), employmentId);
    expect(cur.departmentId).toBe(b.deptB);
    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.find((r) => r.kind === 'transfer')!.status).toBe('applied');
  });
});

describe('the scheduled-application sweep', () => {
  it('does nothing before the effective date, applies on it, and keeps ONE history row', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });

    // The day before: not due.
    const early = await sweepDueMovements(adminCtx(b), { today: plusDays(FUTURE, -1) });
    expect(early.applied).toBe(0);
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptA);

    // The morning of: applied, with no HR action. The sweep is TENANT-WIDE — it is the nightly job, not
    // a per-employee call — so its `applied` total also counts pending movements other tests in this
    // file left behind. Assert the property under test against THIS employment's ledger instead; a
    // global count here silently couples the test to file order.
    const due = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(due.failed).toBe(0);
    expect(await appliedEventsFor(employmentId)).toHaveLength(1);
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptB);

    // ONE line in the history, whose status moved — not a second row appearing on the effective date.
    const hist = await movementHistory(adminCtx(b), employmentId);
    const transfers = hist.filter((r) => r.kind === 'transfer');
    expect(transfers).toHaveLength(1);
    expect(transfers[0].status).toBe('applied');
    expect(transfers[0].effectiveDate).toBe(FUTURE);

    // The dated row carries the movement's effective date, not the day it was keyed.
    const rows = await assignmentsOf(employmentId);
    const open = rows.find((r) => r.validTo === null)!;
    expect(open.validFrom).toBe(FUTURE);
  });

  it('is safe to run twice on the same day — apply-once is a property of the data', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });

    const first = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    const second = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    const third = await sweepDueMovements(adminCtx(b), { today: plusDays(FUTURE, 3) });

    // Tenant-wide again, so only the lower bound is this test's to claim; the exactly-once proof is the
    // per-employment `applied` ledger query at the end.
    expect(first.applied).toBeGreaterThanOrEqual(1);
    expect(second.applied).toBe(0); // nothing due — the ledger already records the application
    expect(second.failed).toBe(0);
    expect(third.applied).toBe(0);

    // The proof that matters: the re-runs did not write a SECOND assignment version.
    const rows = await assignmentsOf(employmentId);
    expect(rows).toHaveLength(2); // the hire's, closed; plus the movement's, open
    const applied = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.subjectEmploymentId, employmentId),
          eq(schema.domainEvent.eventType, 'employment.movement.applied'),
        ),
      );
    expect(applied).toHaveLength(1);
  });

  /**
   * The database, not the scheduler, is what makes apply-once true. Asserted through the real Postgres
   * error surfaced on `.cause` — a bare rejects.toThrow() here would pass on any throw at all, including
   * an unrelated one, which is exactly the trap this repo has been bitten by.
   */
  it('refuses a second application at the DATABASE level (migration 0329)', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });
    await sweepDueMovements(adminCtx(b), { today: FUTURE });

    const [appliedEvent] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.subjectEmploymentId, employmentId),
          eq(schema.domainEvent.eventType, 'employment.movement.applied'),
        ),
      );
    const scheduledId = (appliedEvent.payload as Record<string, unknown>).scheduledId as string;

    let caught: unknown;
    try {
      await owner.db.insert(schema.domainEvent).values({
        tenantId: b.tenantId,
        aggregateType: 'employment',
        aggregateId: employmentId,
        eventType: 'employment.movement.applied',
        actorType: 'system',
        subjectEmploymentId: employmentId,
        payload: { scheduledId, kind: 'transfer', effectiveDate: FUTURE, appliedOn: FUTURE, changes: [] },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Drizzle wraps the driver error as "Failed query: …" — the real one is on the cause chain.
    const chain: string[] = [];
    for (let e: unknown = caught; e; e = (e as { cause?: unknown }).cause) {
      chain.push(String((e as Error).message ?? ''));
      if (!(e as { cause?: unknown }).cause) break;
    }
    const all = chain.join(' | ');
    expect(all).toContain('domain_event_movement_applied_once');
    expect(all).toMatch(/duplicate key value|unique constraint/i);
  });
});

describe('conflicting movements resolve at projection time', () => {
  it('same effective date, same field: the later entry wins and the earlier is Superseded', async () => {
    const { employmentId } = await hireOne();
    const gradeA = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 6)}`, name: `G_${randomUUID().slice(0, 6)}` });
    const gradeB = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 6)}`, name: `G_${randomUUID().slice(0, 6)}` });

    // HR keys a promotion for a future date, then re-keys it with the right grade for the SAME date.
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'promotion',
      effectiveDate: FUTURE,
      gradeId: gradeA.id,
    });
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'promotion',
      effectiveDate: FUTURE,
      gradeId: gradeB.id,
    });

    // Both are legitimately recorded and both are Pending while the date is still ahead.
    const beforeArrival = await movementHistory(adminCtx(b), employmentId);
    expect(beforeArrival.filter((r) => r.status === 'pending')).toHaveLength(2);

    const res = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(res.applied).toBe(1); // only the winner

    const hist = await movementHistory(adminCtx(b), employmentId);
    const promos = hist.filter((r) => r.kind === 'promotion');
    expect(promos).toHaveLength(2); // the loser KEEPS its line — never silently ignored
    const statuses = promos.map((r) => r.status).sort();
    expect(statuses).toEqual(['applied', 'superseded']);

    // The grade that actually landed is the one from the later entry.
    const cur = await movementCurrentState(adminCtx(b), employmentId);
    expect(cur.gradeId).toBe(gradeB.id);

    // A superseded movement is terminal: nothing to cancel, nothing to correct.
    const loser = promos.find((r) => r.status === 'superseded')!;
    expect(loser.canEdit).toBe(false);
    expect(loser.canReverse).toBe(false);
  });

  it('different fields do not conflict — both apply', async () => {
    const { employmentId } = await hireOne();
    const grade = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 6)}`, name: `G_${randomUUID().slice(0, 6)}` });
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'promotion',
      effectiveDate: FUTURE,
      gradeId: grade.id,
    });

    const res = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(res.applied).toBe(2);
    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.filter((r) => r.status === 'superseded')).toHaveLength(0);
    const cur = await movementCurrentState(adminCtx(b), employmentId);
    expect(cur.departmentId).toBe(b.deptB);
    expect(cur.gradeId).toBe(grade.id);
  });
});

describe('correcting and cancelling', () => {
  it('cancelling a PENDING movement stops it ever applying', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });
    let hist = await movementHistory(adminCtx(b), employmentId);
    const mv = hist.find((r) => r.kind === 'transfer')!;
    expect(mv.canReverse).toBe(true); // a pending movement is always cancellable — it holds no state

    await reverseMovementEvent(adminCtx(b), { employmentId, movementId: mv.id, reason: 'Called off' });

    hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.find((r) => r.id === mv.id)!.status).toBe('reversed');

    const res = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(res.applied).toBe(0);
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptA);
  });

  it('cancelling an APPLIED movement restores the previous values via the existing reversal path', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });
    await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptB);

    const hist = await movementHistory(adminCtx(b), employmentId);
    const mv = hist.find((r) => r.kind === 'transfer')!;
    expect(mv.status).toBe('applied');
    expect(mv.canReverse).toBe(true);

    await reverseMovementEvent(adminCtx(b), { employmentId, movementId: mv.id, reason: 'Wrong employee' });

    // Restored from the before-values stored on the movement — the department is the hire's again.
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptA);
    const after = await movementHistory(adminCtx(b), employmentId);
    expect(after.find((r) => r.id === mv.id)!.status).toBe('reversed');
  });

  it('editing a PENDING movement replaces the intent and leaves nothing applied', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: FUTURE,
      departmentId: b.deptB,
    });
    const first = (await movementHistory(adminCtx(b), employmentId)).find((r) => r.kind === 'transfer')!;
    expect(first.canEdit).toBe(true);

    const later = plusDays(FUTURE, 10);
    await editMovementEvent(adminCtx(b), {
      employmentId,
      movementId: first.id,
      kind: 'transfer',
      effectiveDate: later,
      departmentId: b.deptB,
      reason: 'Date moved',
    });

    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.find((r) => r.id === first.id)!.status).toBe('reversed');
    const live = hist.filter((r) => r.kind === 'transfer' && r.status === 'pending');
    expect(live).toHaveLength(1);
    expect(live[0].effectiveDate).toBe(later);

    // Still nothing applied, and the corrected date is honoured.
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptA);
    expect((await sweepDueMovements(adminCtx(b), { today: FUTURE })).applied).toBe(0);
    expect((await sweepDueMovements(adminCtx(b), { today: later })).applied).toBe(1);
    expect((await movementCurrentState(adminCtx(b), employmentId)).departmentId).toBe(b.deptB);
  });

  /**
   * The in-place-edit interaction, pinned. The rule is "only the most recent STATE-CHANGING movement may
   * be corrected in place", because a correction replays through writers that act on the OPEN dated row.
   * A pending movement has changed no state, so it must not count towards "most recent" — otherwise
   * keying a future-dated movement would silently freeze correction of the movement that is actually in
   * force today.
   */
  it('a pending movement does not freeze editing of the latest APPLIED movement', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: PAST,
      departmentId: b.deptB,
    });
    const appliedRow = (await movementHistory(adminCtx(b), employmentId)).find((r) => r.kind === 'transfer')!;
    expect(appliedRow.canEdit).toBe(true);

    // Now key an unrelated future-dated movement.
    const grade = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 6)}`, name: `G_${randomUUID().slice(0, 6)}` });
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'promotion',
      effectiveDate: FUTURE,
      gradeId: grade.id,
    });

    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.find((r) => r.kind === 'promotion')!.status).toBe('pending');
    // The applied transfer is STILL editable — the pending promotion changed no state.
    expect(hist.find((r) => r.id === appliedRow.id)!.canEdit).toBe(true);
  });
});
