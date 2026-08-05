/**
 * 10fcf6df — "Replace Delete with Rollback for movement records".
 *
 * WHAT WAS ACTUALLY WRONG. The reporter described Delete as removing the record without undoing what it
 * did, leaving the employee holding a promotion's position, grade and salary with no movement behind them.
 * The SERVICE has not behaved that way since 66a63bd6: `reverseMovementEvent` replays every leg of the
 * movement backwards through the same writers, keeps the row on the history marked reversed, and refuses
 * outright when a closed payroll relied on the window. What still said "Delete" was the WORD on the row —
 * the affordance promised a deletion the system never performed, which is exactly the expectation the
 * reporter was working from.
 *
 * So this item is a rename plus the two gaps that rename exposed:
 *   • the plan promises the movement stays "together with who did it and when". `when` was projected;
 *     `who` was not. MovementReversal.by now carries it, resolved from the reversal event's own actor.
 *   • the plan enumerates the fields that come back: position, grade, department, company assignment and
 *     basic salary. test/movement-corrections.test.ts pins department, grade, a flat org column, pay and
 *     the reporting line; POSITION, BUSINESS UNIT and the Basic Salary card's OWN fields (currency, pay
 *     mode, payment term) were not covered, and the build note for this item names precisely those as the
 *     ones a reversal that assumes the comparison writer's field set would silently drop.
 *
 * Nothing here rolls back by deleting events: the ledger only ever grows, which is asserted directly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBusinessUnit, createJobGrade, createPosition } from '../core/admin';
import {
  createMovementEvent,
  editMovementEvent,
  movementDetail,
  movementHistory,
  MovementReasonRequiredError,
  reverseMovementEvent,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `mrb_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Rollback Subject', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

async function openCompensation(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.compensation)
    .where(
      and(
        eq(schema.compensation.employmentId, employmentId),
        isNull(schema.compensation.validTo),
        isNull(schema.compensation.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

const eventCount = async (employmentId: string) => {
  const rows = await owner.db
    .select({ id: schema.domainEvent.id })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.subjectEmploymentId, employmentId));
  return rows.length;
};

describe('10fcf6df — Rollback restores the employee, it does not erase the record', () => {
  it('restores POSITION, BUSINESS UNIT, department, grade and basic salary in one rollback', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), {
      companyId: b.companyId,
      code: `BU${randomUUID().slice(0, 4).toUpperCase()}`,
      name: `Unit ${randomUUID().slice(0, 6)}`,
    });
    const bu2 = await createBusinessUnit(adminCtx(b), {
      companyId: b.companyId,
      code: `BV${randomUUID().slice(0, 4).toUpperCase()}`,
      name: `Unit ${randomUUID().slice(0, 6)}`,
    });
    // Give the employee a starting business unit and salary to come BACK to.
    await owner.db
      .update(schema.assignment)
      .set({ businessUnitId: bu.id })
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Senior',
      rank: 6,
    });
    const newPos = await createPosition(adminCtx(b), {
      companyId: b.companyId,
      title: `Head ${randomUUID().slice(0, 5)}`,
    });

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      positionId: newPos.id,
      businessUnitId: bu2.id,
      gradeId: grade.id,
      basicSalary: 9000,
    });

    const moved = await openAssignment(hire.employmentId);
    expect(moved.positionId, 'the movement really applied').toBe(newPos.id);
    expect(moved.businessUnitId).toBe(bu2.id);

    const promotion = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'promotion')!;
    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: promotion.id, reason: 'Keyed in error' });

    const back = await openAssignment(hire.employmentId);
    expect(back.positionId, 'position').toBe(b.positionId);
    expect(back.businessUnitId, 'business unit').toBe(bu.id);
    expect(back.departmentId, 'department').toBe(b.deptA);
    expect(back.validTo, 'the restored assignment is OPEN again — no gap in the timeline').toBeNull();

    const [emp] = await owner.db
      .select({ gradeId: schema.employment.gradeId })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId));
    expect(emp.gradeId, 'job grade').toBeNull();

    const comp = await openCompensation(hire.employmentId);
    expect(comp.basicSalary, 'basic salary').toBe('4000.00');
    expect(comp.validTo).toBeNull();
  });

  it("restores the Basic Salary card's OWN fields — pay mode, rate and payment term", async () => {
    // The build note's warning, pinned: the Basic Salary card is the only writer that can set a pay mode
    // or a RATE AMOUNT, and `rateAmount` is not a field the movement form carries at all. A reversal built
    // around the comparison writer's field set would restore the salary and leave the rate behind. It does
    // not, because the rollback supersedes the compensation ROW — every column on it comes back together.
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      currency: 'MYR',
      payMode: 'daily',
      rateAmount: 150,
      paymentTerm: 'monthly',
      effectiveFrom: '2026-01-01',
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'salaryAdjustment',
      effectiveDate: '2026-06-01',
      basicSalary: 6000,
      paymentTerm: 'weekly',
    });
    const changed = await openCompensation(hire.employmentId);
    expect(changed.basicSalary).toBe('6000.00');
    expect(changed.paymentTerm).toBe('weekly');

    const adj = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'salaryAdjustment')!;
    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: adj.id, reason: 'Keyed in error' });

    const restored = await openCompensation(hire.employmentId);
    expect(restored.basicSalary, 'basic salary').toBe('4000.00');
    expect(restored.paymentTerm, 'payment term').toBe('monthly');
    expect(restored.payMode, 'pay mode').toBe('daily');
    expect(restored.rateAmount, 'the rate the movement never mentioned').toBe('150.00');
    expect(restored.currency, 'currency').toBe('MYR');
  });

  it('the movement STAYS, marked rolled back, with WHO did it and WHEN', async () => {
    // The seeded admin app_user carries no person row (harness), and a name can only come from one — so
    // link it, exactly as a real WorkOS-provisioned admin is linked. Without this the assertion below
    // would pass on `null` and prove nothing.
    const [admin] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Priya Nair', primaryEmail: email() })
      .returning({ id: schema.person.id });
    await owner.db
      .update(schema.appUser)
      .set({ personId: admin.id })
      .where(eq(schema.appUser.id, b.adminUserId));

    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const transfer = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;

    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: transfer.id,
      reason: 'Keyed in error',
    });

    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === transfer.id);
    expect(row, 'the row is not removed').toBeTruthy();
    expect(row!.reversed).toBeTruthy();
    expect(row!.reversed!.corrected, 'a plain rollback, not the first half of an Edit').toBe(false);
    expect(row!.reversed!.reason).toBe('Keyed in error');
    expect(row!.reversed!.at).toBeInstanceOf(Date);
    // WHO — resolved from the reversal event's own actor, so it cannot be posted by the caller.
    expect(row!.reversed!.by, 'the admin who rolled it back is named').toBe('Priya Nair');

    // The detail view carries the same trace (that is where the page renders it).
    const detail = await movementDetail(adminCtx(b), hire.employmentId, transfer.id);
    expect(detail!.row.reversed!.by).toBe('Priya Nair');
  });

  it('THE LEDGER ONLY GROWS: a rollback deletes no domain event', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const beforeCount = await eventCount(hire.employmentId);
    const transfer = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: transfer.id, reason: 'Keyed in error' });

    // Strictly greater: the compensating writes and the reversal marker are all APPENDS. "Delete" could
    // only ever have meant removing or suppressing the source events, which is why the flat employment
    // columns kept their values — a rollback must WRITE the compensating change instead.
    expect(await eventCount(hire.employmentId)).toBeGreaterThan(beforeCount);
    const original = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.id, transfer.id));
    expect(original, 'the original event is still in the ledger').toHaveLength(1);
  });

  it('a movement rolled back once cannot be rolled back again', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const transfer = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: transfer.id, reason: 'Keyed in error' });
    await expect(
      reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: transfer.id, reason: 'Keyed in error' }),
    ).rejects.toThrow(/already been rolled back/i);
    expect(
      (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === transfer.id)!.canReverse,
    ).toBe(false);
  });

  it('SOURCE GUARD: the affordance is Rollback, and every locale has the labels', () => {
    const page = fs.readFileSync(
      path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
      'utf8',
    );
    // The Employment History row offers Rollback and no longer offers Delete. Scoped to the `movement.`
    // namespace: other cards on the same page (emergency contacts, qualifications, documents) genuinely
    // delete rows and keep their own delete labels.
    expect(page.includes("t('movement.rollback')"), 'the row offers Rollback').toBe(true);
    expect(page.includes("t('movement.delete')"), 'the row no longer offers Delete').toBe(false);
    // It posts to the reversal service — the rename must not have become a second, weaker writer.
    expect(page.includes('reverseMovementEventAction')).toBe(true);
    // And the "who" the plan promises actually reaches the screen.
    expect(page.includes("t('movement.reversedBy')")).toBe(true);

    // bd89ccd8 — a PENDING row wears the Cancel wording instead. Same form, same action, same service:
    // the guard asserts the LABELS branch exists and that no second writer appeared beside it.
    expect(page.includes("t('movement.cancel')"), 'a pending row offers Cancel').toBe(true);
    expect(page.includes("t('movement.cancelConfirmTitle')")).toBe(true);
    expect(page.includes("t('movement.cancelConfirmDescription')")).toBe(true);
    expect(
      page.match(/<form action=\{reverseMovementEventAction\}/g)?.length,
      'exactly ONE reversal form — Cancel is a relabel of Rollback, never a second path',
    ).toBe(1);
    // …and no delete action grew beside it.
    expect(page.includes('deleteMovementEventAction'), 'no second, erasing writer').toBe(false);
    // bd89ccd8 — the reason is mandatory in the dialog too (the service refuses a blank one regardless).
    expect(page.includes("reasonField={{ name: 'reason'")).toBe(true);
    expect(page.includes('required: true'), 'the rollback reason field is mandatory').toBe(true);

    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const mv = msg?.people?.detail?.movement ?? {};
      for (const k of [
        'rollback',
        'reversedBy',
        'rollbackConfirmTitle',
        'rollbackConfirmDescription',
        'rollbackConfirmPayroll',
        // bd89ccd8 — the Cancel vocabulary, in every locale (a MISSING_MESSAGE here throws at render).
        'cancel',
        'cancelConfirmTitle',
        'cancelConfirmDescription',
        'cancelledBadge',
      ]) {
        expect(typeof mv[k], `messages/${loc}.json missing movement.${k}`).toBe('string');
      }
      expect(mv.delete, `messages/${loc}.json still carries the old movement.delete label`).toBeUndefined();
    }
  });
});

/**
 * bd89ccd8 — "Configure Remove/Delete Function for Movement Event".
 *
 * The request asks for a hard delete. It is NOT built, and deliberately: 9064cffb settled that the row
 * stays in Employment History marked reversed, and 10fcf6df removed the Delete label because it had never
 * deleted anything. What was genuinely missing is asserted here — the reason was optional at both ends,
 * and of the eleven rollbacks on production TEN carried no reason at all.
 */
describe('bd89ccd8 — the rollback reason is an audit control, enforced by the SERVICE', () => {
  it('refuses a rollback with a blank reason, and leaves the movement applied', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;

    // Absent, empty and whitespace-only are all the same absence of a reason.
    for (const reason of [undefined, '', '   ']) {
      await expect(
        reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: move.id, reason }),
        `a reason of ${JSON.stringify(reason)} must be refused`,
      ).rejects.toBeInstanceOf(MovementReasonRequiredError);
    }
    // Refused by the SERVICE means nothing moved — not merely that a dialog stayed open.
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptB);
    expect((await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === move.id)!.reversed).toBeNull();
  });

  it('carries the reason into the employment.movement.reversed payload', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      reason: '  Wrong employee — keyed on the wrong row  ',
    });

    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'employment.movement.reversed'),
        ),
      );
    expect((ev.payload as { reason: string }).reason, 'stored trimmed, exactly as typed').toBe(
      'Wrong employee — keyed on the wrong row',
    );
    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === move.id)!;
    expect(row.reversed!.reason).toBe('Wrong employee — keyed on the wrong row');
  });

  it('holds a CORRECTION to the same rule — an edit is a rollback wearing another name', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: move.id,
        kind: 'promotion',
        effectiveDate: '2026-06-01',
        departmentId: b.deptB,
      }),
    ).rejects.toBeInstanceOf(MovementReasonRequiredError);
    // And the half it would have done first — the rollback — did not commit either.
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptB);
  });

  it('CANCELS a pending movement: nothing was written, nothing is written, the sweep skips it', async () => {
    const hire = await hireOne();
    // Dated in the future, so it is recorded as an intent and applies nothing today (941c9dac).
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2099-01-01',
      departmentId: b.deptB,
    });
    const pending = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    expect(pending.status).toBe('pending');
    expect((await openAssignment(hire.employmentId)).departmentId, 'nothing applied yet').toBe(b.deptA);

    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: pending.id,
      reason: 'Keyed against the wrong employee',
    });

    // No employment column moved — a cancel of something that never applied changes no data at all.
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptA);
    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === pending.id)!;
    expect(row, 'the entry REMAINS on the history — it is not deleted').toBeTruthy();
    expect(row.status).toBe('reversed');
    // bd89ccd8 — and it is flagged as a CANCEL, not a rollback, so the badge can say so.
    expect(row.reversed!.cancelled).toBe(true);
    expect(row.reversed!.corrected).toBe(false);

    // The sweep must never resurrect it on the effective date.
    expect((await sweepDueMovements(adminCtx(b), { today: '2099-01-02' })).applied).toBe(0);
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptA);
  });

  it('an APPLIED movement rolled back is NOT flagged as cancelled — the two badges mean different things', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      reason: 'Wrong department',
    });
    expect((await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === move.id)!.reversed!.cancelled)
      .toBe(false);
  });
});
